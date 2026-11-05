import { closeDatabase, connectToDatabase } from '../repositories/mongo.js';
import { resetDemoData } from '../services/catalog.js';
import { customerRepo, organizationRepo } from '../repositories/index.js';
import { DATA_DIR } from '../services/seedData.js';

/**
 * Loads the supplied data files into MongoDB.
 *
 * Running it again is safe: it replaces what is there rather than adding to it,
 * which is the same path the "Reset demo data" button takes. Pass --keep-emails
 * to leave the contact addresses as they are, which is useful once the test
 * inboxes have been set up and you only want the invoices back.
 */
async function main(): Promise<void> {
  const keepEmails = process.argv.includes('--keep-emails');

  await connectToDatabase();
  const result = await resetDemoData({ keepEmails });

  const customers = await customerRepo.list();
  const organization = await organizationRepo.get();

  console.log(`Loaded from ${DATA_DIR}`);
  console.log(`  organization: ${result.organization.name}`);
  console.log(`  customers:    ${result.customers}`);
  console.log(`  invoices:     ${result.invoices}`);
  console.log('');

  const placeholders = customers.filter((c) => c.contactEmail.endsWith('@example.com'));
  if (placeholders.length > 0) {
    console.log(
      `${placeholders.length} customer address(es) still use example.com and cannot receive mail.`,
    );
    console.log('Change them on the Customers page, or with:');
    console.log(
      `  curl -X PATCH http://localhost:4000/api/customers/${placeholders[0]!.customerId}/email \\`,
    );
    console.log(`       -H "content-type: application/json" \\`);
    console.log(`       -d '{"contactEmail":"your-test-inbox@gmail.com"}'`);
  }
  if (organization?.accountsEmail.endsWith('@example.com')) {
    console.log('');
    console.log("The organization's accounts email is still a placeholder. Set it on the");
    console.log('Organization page so replies are addressed to your own inbox.');
  }

  await closeDatabase();
}

main().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
