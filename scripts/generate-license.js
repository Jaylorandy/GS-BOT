const fs = require('fs');
const path = require('path');
const { DEFAULT_DAYS, generateLicense } = require('../license-generator-core');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function printUsage() {
  console.log(`
GS Bot License Generator

Usage:
  node scripts/generate-license.js --customer "Client Name" [options]

Options:
  --customer "Name"           Customer or company name
  --email "mail@example.com"  Optional email
  --days 365                  License duration in days (default: 365)
  --installation-id "UUID"    Optional device binding
  --note "Internal note"      Optional note
  --out ./license.txt         Save the generated code to a file
  --json                      Print machine-readable JSON
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.customer) {
    printUsage();
    process.exit(args.customer ? 0 : 1);
  }

  const days = Number(args.days || DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('The --days value must be a positive number.');
  }

  const response = generateLicense({
    customerName: String(args.customer).trim(),
    email: String(args.email || '').trim(),
    note: String(args.note || '').trim(),
    installationId: String(args['installation-id'] || '').trim(),
    days,
  });

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), response.licenseKey, 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log('\nGS Bot License Generated\n');
  console.log(`Customer: ${response.customerName}`);
  if (response.email) console.log(`Email: ${response.email}`);
  if (response.installationId) console.log(`Installation ID: ${response.installationId}`);
  console.log(`Issued At: ${response.issuedAt}`);
  console.log(`Expires At: ${response.expiresAt}`);
  console.log('\nLicense Code:\n');
  console.log(response.licenseKey);
  if (args.out) {
    console.log(`\nSaved to: ${path.resolve(args.out)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`License generation failed: ${error.message}`);
  process.exit(1);
}
