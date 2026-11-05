import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env, llmConfigured } from '../config/env.js';
import { today } from '../domain/dates.js';
import { toMinor } from '../domain/money.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import {
  attentionRepo,
  conversationRepo,
  customerRepo,
  invoiceRepo,
  organizationRepo,
  paymentRepo,
  reconciliationRepo,
} from '../repositories/index.js';
import {
  getDashboard,
  getOrganization,
  listCustomerSummaries,
  listInvoices,
  resetDemoData,
} from '../services/catalog.js';
import { runInboxCheck, runReminderSweep, sendReviewedReply } from '../services/collections/agent.js';
import {
  approveLine,
  invoiceChoicesFor,
  rejectLine,
  uploadStatement,
} from '../services/reconciliation.js';
import { getMailer } from '../integrations/mailer.js';
import { getInboxReader } from '../integrations/imap.js';
import { toInvoiceView } from '../domain/invoice.js';
import {
  attentionDto,
  conversationDto,
  customerDto,
  invoiceDto,
  paymentDto,
  statementLineDto,
} from './presenters.js';

/**
 * The HTTP surface.
 *
 * Routes stay thin on purpose: validate the request, call a service, present
 * the result. No business rule lives in this file, which is what makes the
 * rules testable without an HTTP server and reusable from the schedulers.
 */

export const api = Router();

// Uploads are held in memory and capped. A bank statement is a small text file;
// anything larger is either a mistake or an attempt to exhaust the process.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const looksLikeCsv =
      file.mimetype.includes('csv') ||
      file.mimetype === 'text/plain' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    callback(null, looksLikeCsv);
  },
});

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('That does not look like an email address.');

// --- Health and settings ----------------------------------------------------

api.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const [mail, inbox] = await Promise.all([getMailer().verify(), getInboxReader().verify()]);
    res.json({
      status: 'ok',
      today: today(),
      timezone: env.APP_TIMEZONE,
      mail: { transport: getMailer().kind, ...mail },
      inbox: { available: getInboxReader().available, ...inbox },
      llm: { configured: llmConfigured, model: llmConfigured ? env.LLM_MODEL : null },
      reconciliationRerank: env.RECON_LLM_RERANK,
    });
  }),
);

// --- Part A: organization, customers, invoices ------------------------------

api.get(
  '/organization',
  asyncHandler(async (_req, res) => {
    const organization = await getOrganization();
    if (!organization) throw new HttpError(404, 'No organization yet. Run the seed script.');
    res.json(organization);
  }),
);

api.patch(
  '/organization/accounts-email',
  asyncHandler(async (req, res) => {
    const { accountsEmail } = z.object({ accountsEmail: emailSchema }).parse(req.body);
    const updated = await organizationRepo.updateAccountsEmail(accountsEmail);
    res.json(updated);
  }),
);

api.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json(await getDashboard());
  }),
);

api.get(
  '/customers',
  asyncHandler(async (_req, res) => {
    const customers = await listCustomerSummaries();
    res.json(customers.map(customerDto));
  }),
);

api.get(
  '/customers/:customerId',
  asyncHandler(async (req, res) => {
    const customerId = z.string().regex(/^C\d{3}$/).parse(req.params.customerId);
    const customer = await customerRepo.findById(customerId);
    if (!customer) throw new HttpError(404, 'No such customer.');

    const invoices = await invoiceRepo.listForCustomer(customerId);
    const conversations = await conversationRepo.listForCustomer(customerId);
    const asOf = today();
    res.json({
      ...customer,
      invoices: invoices.map((invoice) => invoiceDto(toInvoiceView(invoice, asOf))),
      conversations: conversations.map(conversationDto),
    });
  }),
);

/** The reviewer points a customer at their own inbox and replies as them. */
api.patch(
  '/customers/:customerId/email',
  asyncHandler(async (req, res) => {
    const customerId = z.string().regex(/^C\d{3}$/).parse(req.params.customerId);
    const { contactEmail } = z.object({ contactEmail: emailSchema }).parse(req.body);

    const existing = await customerRepo.findById(customerId);
    if (!existing) throw new HttpError(404, 'No such customer.');

    // Two customers sharing an inbox would make inbound replies ambiguous, so
    // the address has to be unique across the book.
    const clash = await customerRepo.findByEmail(contactEmail);
    if (clash && clash.customerId !== customerId) {
      throw new HttpError(409, `That address is already used by ${clash.name}.`);
    }
    res.json(await customerRepo.updateEmail(customerId, contactEmail));
  }),
);

api.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        customerId: z.string().regex(/^C\d{3}$/).optional(),
        status: z.enum(['draft', 'sent', 'paid']).optional(),
        overdue: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);

    const invoices = await listInvoices({
      customerId: query.customerId,
      status: query.status,
      overdueOnly: query.overdue === 'true',
    });
    res.json(invoices.map(invoiceDto));
  }),
);

api.get(
  '/invoices/:invoiceNumber',
  asyncHandler(async (req, res) => {
    const invoiceNumber = z.string().regex(/^INV-\d{3,6}$/).parse(req.params.invoiceNumber);
    const invoice = await invoiceRepo.findByNumber(invoiceNumber);
    if (!invoice) throw new HttpError(404, 'No such invoice.');
    const payments = await paymentRepo.listForInvoice(invoiceNumber);
    res.json({ ...invoiceDto(toInvoiceView(invoice)), payments: payments.map(paymentDto) });
  }),
);

api.post(
  '/demo/reset',
  asyncHandler(async (req, res) => {
    const { keepEmails } = z
      .object({ keepEmails: z.boolean().optional() })
      .parse(req.body ?? {});
    const result = await resetDemoData({ keepEmails: keepEmails ?? false });
    res.json({
      message: 'Demo data restored from the supplied files. Conversations and payments cleared.',
      ...result,
    });
  }),
);

// --- Part B: collections ----------------------------------------------------

api.post(
  '/collections/reminders/run',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().regex(/^C\d{3}$/).optional(),
        invoiceNumbers: z.array(z.string().regex(/^INV-\d{3,6}$/)).max(50).optional(),
        force: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    res.json(await runReminderSweep(body));
  }),
);

api.post(
  '/collections/inbox/check',
  asyncHandler(async (_req, res) => {
    const reader = getInboxReader();
    if (!reader.available) {
      throw new HttpError(
        400,
        'IMAP is not configured, so there is no inbox to check. Set IMAP_HOST and IMAP_USER in .env.',
      );
    }
    res.json(await runInboxCheck());
  }),
);

api.get(
  '/collections/conversations',
  asyncHandler(async (_req, res) => {
    const conversations = await conversationRepo.list();
    res.json(conversations.map(conversationDto));
  }),
);

api.get(
  '/collections/conversations/:conversationId',
  asyncHandler(async (req, res) => {
    const conversationId = z.string().uuid().parse(req.params.conversationId);
    const conversation = await conversationRepo.findById(conversationId);
    if (!conversation) throw new HttpError(404, 'No such conversation.');
    res.json(conversationDto(conversation));
  }),
);

api.get(
  '/collections/attention',
  asyncHandler(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(['open', 'resolved', 'dismissed']).optional() })
      .parse(req.query);
    const items = await attentionRepo.list(status ?? 'open');
    res.json(items.map(attentionDto));
  }),
);

api.patch(
  '/collections/attention/:itemId/draft',
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().parse(req.params.itemId);
    const { draftBody } = z.object({ draftBody: z.string().max(8000) }).parse(req.body);
    await attentionRepo.updateDraft(itemId, draftBody);
    res.json(await attentionRepo.findById(itemId));
  }),
);

api.post(
  '/collections/attention/:itemId/send',
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().parse(req.params.itemId);
    const { body, subject } = z
      .object({ body: z.string().min(1).max(8000), subject: z.string().max(200).optional() })
      .parse(req.body);
    res.json(await sendReviewedReply(itemId, body, subject));
  }),
);

api.post(
  '/collections/attention/:itemId/dismiss',
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().parse(req.params.itemId);
    const item = await attentionRepo.findById(itemId);
    if (!item) throw new HttpError(404, 'No such item.');
    await attentionRepo.close(itemId, 'dismissed');
    if (item.conversationId) await conversationRepo.setNeedsAttention(item.conversationId, false);
    res.json({ dismissed: true });
  }),
);

// --- Part C: bank reconciliation -------------------------------------------

api.post(
  '/reconciliation/upload',
  upload.single('statement'),
  asyncHandler(async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw new HttpError(400, 'Attach a CSV file in a field named "statement".');
    const csv = file.buffer.toString('utf8');
    const result = await uploadStatement(file.originalname, csv);
    res.status(201).json({
      batch: result.batch,
      parseErrors: result.parseErrors,
      lines: result.lines.map(statementLineDto),
    });
  }),
);

api.get(
  '/reconciliation/batches',
  asyncHandler(async (_req, res) => {
    res.json(await reconciliationRepo.listBatches());
  }),
);

api.get(
  '/reconciliation/batches/:batchId',
  asyncHandler(async (req, res) => {
    const batchId = z.string().uuid().parse(req.params.batchId);
    const batch = await reconciliationRepo.findBatch(batchId);
    if (!batch) throw new HttpError(404, 'No such upload.');
    const lines = await reconciliationRepo.listLines(batchId);
    res.json({ batch, lines: lines.map(statementLineDto) });
  }),
);

api.get(
  '/reconciliation/lines/:lineId/choices',
  asyncHandler(async (req, res) => {
    const lineId = z.string().uuid().parse(req.params.lineId);
    const invoices = await invoiceChoicesFor(lineId);
    res.json(invoices.map((invoice) => invoiceDto(toInvoiceView(invoice))));
  }),
);

const allocationSchema = z.object({
  invoiceNumber: z.string().regex(/^INV-\d{3,6}$/),
  // Amounts arrive in major units from the browser and become minor units here,
  // at the edge, so no fractional value ever reaches the business rules.
  amount: z.number().positive().max(1_000_000_000),
});

api.post(
  '/reconciliation/lines/:lineId/approve',
  asyncHandler(async (req, res) => {
    const lineId = z.string().uuid().parse(req.params.lineId);
    const body = z
      .object({
        allocations: z.array(allocationSchema).min(1).max(20).optional(),
        choice: z.enum(['close_tds', 'leave_open']).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      })
      .parse(req.body ?? {});

    const result = await approveLine({
      lineId,
      allocations: body.allocations?.map((allocation) => ({
        invoiceNumber: allocation.invoiceNumber,
        amountMinor: toMinor(allocation.amount),
      })),
      choice: body.choice ?? null,
      note: body.note ?? null,
    });

    res.json({
      line: statementLineDto(result.line),
      payments: result.payments.map(paymentDto),
      invoices: result.invoices.map((invoice) => invoiceDto(toInvoiceView(invoice))),
    });
  }),
);

api.post(
  '/reconciliation/lines/:lineId/reject',
  asyncHandler(async (req, res) => {
    const lineId = z.string().uuid().parse(req.params.lineId);
    const { note } = z.object({ note: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    const line = await rejectLine(lineId, note ?? null);
    res.json(statementLineDto(line));
  }),
);

api.get(
  '/payments',
  asyncHandler(async (_req, res) => {
    const payments = await paymentRepo.list();
    res.json(payments.map(paymentDto));
  }),
);
