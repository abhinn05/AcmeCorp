import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCustomerContext, renderContextForPrompt } from '../src/services/collections/context.js';
import { renderReminder } from '../src/services/collections/templates.js';
import { validateDraft } from '../src/services/collections/validator.js';
import {
  classifyByRules,
  detectAutomaticMail,
  extractReference,
} from '../src/services/collections/classifier.js';
import { stripQuotedText } from '../src/integrations/imap.js';
import { loadCustomers, loadInvoices, loadOrganization } from '../src/services/seedData.js';
import type { InboundEmail } from '../src/integrations/imap.js';

const organization = loadOrganization();
const customers = loadCustomers();
const invoices = loadInvoices();

const kestrel = customers.find((c) => c.customerId === 'C002')!;
const context = buildCustomerContext(organization, kestrel, invoices, '2026-11-04');

function email(partial: Partial<InboundEmail>): InboundEmail {
  return {
    key: 'k',
    uid: 1,
    rfcMessageId: '<x@test>',
    inReplyTo: null,
    references: [],
    fromAddress: kestrel.contactEmail,
    fromName: kestrel.contactName,
    toAddresses: [organization.accountsEmail],
    subject: 'Re: payment reminder',
    text: '',
    date: new Date('2026-11-04T10:00:00Z'),
    headers: {},
    ...partial,
  };
}

describe('the context given to the model', () => {
  it('includes only sent, unpaid invoices for that one customer', () => {
    const numbers = context.outstanding.map((i) => i.invoiceNumber);
    assert.deepEqual(numbers, ['INV-1004', 'INV-1005']);
    // INV-1006 is a draft and INV-1020 is paid, so neither may be mentioned.
    assert.ok(!numbers.includes('INV-1006'));
    assert.ok(!numbers.includes('INV-1020'));
  });

  it('never contains another customer', () => {
    const rendered = renderContextForPrompt(context);
    for (const other of customers.filter((c) => c.customerId !== kestrel.customerId)) {
      assert.ok(!rendered.includes(other.name), `leaked ${other.name}`);
      assert.ok(!rendered.includes(other.contactEmail), `leaked ${other.contactEmail}`);
    }
  });
});

describe('reminder emails', () => {
  it('quotes the invoice number, amount and due date from the record', () => {
    const overdue = invoices.filter((i) => ['INV-1004', 'INV-1005'].includes(i.invoiceNumber));
    const { subject, body } = renderReminder(organization, kestrel, overdue, '2026-11-04');

    assert.match(subject, /2 overdue invoices/);
    assert.match(body, /INV-1004: ₹59,000\.00, due 19 September 2026/);
    assert.match(body, /INV-1005: ₹59,000\.00, due 20 October 2026/);
    assert.match(body, /total outstanding is ₹1,18,000\.00/);
    assert.match(body, /000111222333/);
    assert.match(body, /EXMP0000142/);
    assert.ok(!body.includes('SWIFT'), 'an Indian customer should not be given SWIFT details');
  });

  it('gives an international customer SWIFT details instead of IFSC', () => {
    const harbour = customers.find((c) => c.customerId === 'C007')!;
    const theirs = invoices.filter((i) => i.invoiceNumber === 'INV-1021');
    const { body } = renderReminder(organization, harbour, theirs, '2026-11-04');
    assert.match(body, /SWIFT: EXMPINBBXXX/);
    assert.match(body, /\$12,500\.00/);
    assert.ok(!body.includes('IFSC'));
  });
});

describe('the draft validator', () => {
  const options = { allCustomers: customers };

  it('passes a reply built from this customer\'s own figures', () => {
    const draft = [
      'Dear Arjun,',
      '',
      'Two invoices are outstanding: INV-1004 for ₹59,000.00, due 19 September 2026,',
      'and INV-1005 for ₹59,000.00, due 20 October 2026. The total is ₹1,18,000.00.',
      '',
      'You can pay by NEFT, RTGS or IMPS to AcmeCorp, account 000111222333,',
      'Example Bank, IFSC EXMP0000142.',
      '',
      'Kind regards,',
      'Accounts Team',
    ].join('\n');
    const result = validateDraft(draft, context, options);
    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
  });

  it('rejects an amount that is not on any of their invoices', () => {
    const result = validateDraft('Your balance is ₹1,19,000.00.', context, options);
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' '), /1,19,000\.00/);
  });

  it('rejects an invoice the customer does not have', () => {
    const result = validateDraft('Please settle INV-1013 for ₹59,000.00.', context, options);
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' '), /INV-1013/);
  });

  it('rejects a draft that confirms a payment', () => {
    const result = validateDraft(
      'Thank you, your payment has been received and the invoice is now settled.',
      context,
      options,
    );
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' '), /confirms a payment/);
  });

  it('rejects a draft that agrees to more time', () => {
    const result = validateDraft(
      'We can agree to an extension until the end of next month.',
      context,
      options,
    );
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' '), /later payment date/);
  });

  it('rejects a draft naming another customer', () => {
    const result = validateDraft(
      'Brightline have already settled theirs, so please do the same.',
      context,
      options,
    );
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' '), /another customer/);
  });
});

describe('recognising machine mail', () => {
  it('spots an out-of-office from the headers', () => {
    assert.equal(
      detectAutomaticMail(email({ headers: { 'auto-submitted': 'auto-replied' } })),
      'out_of_office',
    );
  });

  it('spots an out-of-office from the subject', () => {
    assert.equal(
      detectAutomaticMail(email({ subject: 'Automatic reply: payment reminder' })),
      'out_of_office',
    );
  });

  it('spots a delivery failure', () => {
    assert.equal(
      detectAutomaticMail(
        email({
          fromAddress: 'mailer-daemon@googlemail.com',
          subject: 'Delivery Status Notification (Failure)',
        }),
      ),
      'bounce',
    );
  });

  it('leaves a real customer reply alone', () => {
    assert.equal(detectAutomaticMail(email({ text: 'Hi, what do we owe you?' })), null);
  });
});

describe('reading a reply', () => {
  it('drops the quoted history below the reply', () => {
    const body = stripQuotedText(
      ['We paid this yesterday.', '', 'On 1 November 2026 Accounts Team wrote:', '> Dear Arjun,', '> Invoice INV-1004...'].join('\n'),
    );
    assert.equal(body, 'We paid this yesterday.');
  });

  it('picks up a quoted payment reference', () => {
    assert.equal(extractReference('We paid INV-1004 yesterday, reference N123456789'), 'N123456789');
    assert.equal(extractReference('UTR: 624811204417 sent this morning'), '624811204417');
  });

  it('routes a dispute away from an automatic answer', () => {
    const classified = classifyByRules(email({ text: 'This invoice is wrong, we never ordered it.' }));
    assert.equal(classified.intent, 'extension_dispute_or_legal');
  });

  it('treats an unclear message as needing a person', () => {
    const classified = classifyByRules(email({ text: 'Thanks, noted.' }));
    assert.equal(classified.intent, 'unclear');
  });
});
