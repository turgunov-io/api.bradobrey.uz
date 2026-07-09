#!/usr/bin/env node

require('dotenv').config();

const { pool } = require('../src/config/postgres');
const { syncCashbackWalletsFromTransactions } = require('../src/composable/cashback');

const getArgValue = (name) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
};

const hasFlag = (name) => process.argv.includes(name);

const clientId = getArgValue('--client-id');
const dryRun = hasFlag('--dry-run') || hasFlag('--check');

async function main() {
  const result = await syncCashbackWalletsFromTransactions({ clientId, dryRun });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
