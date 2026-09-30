const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canInitiateTransfer, matchingTerminalDecision, resolveTransferOutcome } = require('../src/utils/queueTransferState');

const root = path.join(__dirname, '..');

test('transfer decisions are idempotent only for the same terminal decision', () => {
  assert.equal(matchingTerminalDecision('accepted', 'accept'), true);
  assert.equal(matchingTerminalDecision('rejected', 'reject'), true);
  assert.equal(matchingTerminalDecision('accepted', 'reject'), false);
  assert.equal(matchingTerminalDecision('pending', 'accept'), false);
});

test('transfer request, acceptance, rejection and expiry resolve to one responsible barber', () => {
  const entry = { barber_id: 'barber-a', status: 'called' };
  assert.equal(canInitiateTransfer(entry, 'barber-a', 'barber-b'), true);
  assert.equal(canInitiateTransfer(entry, 'barber-c', 'barber-b'), false);
  assert.equal(canInitiateTransfer({ ...entry, status: 'transfer_pending' }, 'barber-a', 'barber-b'), false);
  const transfer = { from_barber_id: 'barber-a', to_barber_id: 'barber-b', original_status: 'called' };
  assert.deepEqual(resolveTransferOutcome('accept', transfer), { transferStatus: 'accepted', barberId: 'barber-b', orderStatus: 'waiting' });
  assert.deepEqual(resolveTransferOutcome('reject', transfer), { transferStatus: 'rejected', barberId: 'barber-a', orderStatus: 'called' });
  assert.deepEqual(resolveTransferOutcome('expired', transfer), { transferStatus: 'expired', barberId: 'barber-a', orderStatus: 'called' });
});

test('migration persists transfer chain, status timeline, timeout and unique idempotency keys', () => {
  const sql = fs.readFileSync(path.join(root, 'db/postgres/queue_transfer_history.sql'), 'utf8');
  assert.match(sql, /create table if not exists queue_transfer_events/i);
  assert.match(sql, /from_barber_id[\s\S]*to_barber_id[\s\S]*client_id/i);
  assert.match(sql, /expires_at timestamptz not null/i);
  assert.match(sql, /unique index if not exists queue_transfer_events_idempotency_uq/i);
  assert.match(sql, /create table if not exists queue_status_events/i);
  assert.match(sql, /after insert or update of status, barber_id/i);
});

test('transfer workflow locks the order and transfer before applying state transitions', () => {
  const source = fs.readFileSync(path.join(root, 'src/models/queueTransfers.js'), 'utf8');
  assert.match(source, /from queue_entries where id=\$1 for update/i);
  assert.match(source, /from queue_transfer_events t[\s\S]*for update of t/i);
  assert.match(source, /Only the assigned barber can transfer this order/);
  assert.match(source, /String\(transfer\.to_barber_id\) !== actor\.id/);
  assert.match(source, /expires_at\)\.getTime\(\) <= Date\.now\(\)/);
});
