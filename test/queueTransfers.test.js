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

test('active transfer request keeps stale and recipient eligibility checks in the durable path', () => {
<<<<<<< HEAD
  const transferSource = fs.readFileSync(
    path.join(root, 'src/models/queueTransfers.js'),
    'utf8',
  );
  const barberSource = fs.readFileSync(
    path.join(root, 'src/models/barbers.js'),
    'utf8',
  );
=======
  const transferSource = fs.readFileSync(path.join(root, 'src/models/queueTransfers.js'), 'utf8');
  const barberSource = fs.readFileSync(path.join(root, 'src/models/barbers.js'), 'utf8');
>>>>>>> b093cab68f0e8daf54d01b9bb065964f55c5b2b5
  const optionsStart = barberSource.indexOf('async queueReassignOptions');
  const requestStart = barberSource.indexOf('async reassignQueue');
  const optionsHandler = barberSource.slice(optionsStart, requestStart);
  const requestHandler = barberSource.slice(requestStart, barberSource.indexOf('async callNext', requestStart));

  assert.match(transferSource, /created_at/);
  assert.match(transferSource, /STALE_QUEUE_HOURS/);
  assert.match(transferSource, /join users u on u\.id = b\.id/);
<<<<<<< HEAD
  assert.match(transferSource, /u\.role = any\(\$3::text\[\]\)/);
  assert.doesNotMatch(optionsHandler, /markEntriesNoShow/);
  assert.match(requestHandler, /return queueTransfers\.request\(req, res\)/);
  assert.doesNotMatch(requestHandler, /Selected barber is not available for reassignment/);
=======
  assert.match(transferSource, /u\.role in \('barber'/);
  assert.doesNotMatch(optionsHandler, /markEntriesNoShow/);
  assert.match(requestHandler, /return queueTransfers\.request\(req, res\)/);
});

test('reassignment availability merges active temporary-branch employees', () => {
  const source = fs.readFileSync(path.join(root, 'src/models/barbers.js'), 'utf8');
  const availabilityStart = source.indexOf('const getBranchBarberAvailability = async');
  const availabilityEnd = source.indexOf('\nconst getQueueTailCreatedAt', availabilityStart);
  const availability = source.slice(availabilityStart, availabilityEnd);

  assert.match(availability, /from\('employee_active_branches'\)/);
  assert.match(availability, /activeByEmployeeId/);
  assert.match(availability, /activeBarbers/);
  assert.match(availability, /hasActiveBranchTable/);
  assert.match(availability, /branch_id: branchId/);
});

test('PATCH transfer eligibility uses the same fresh active-branch presence contract', () => {
  const source = fs.readFileSync(path.join(root, 'src/models/queueTransfers.js'), 'utf8');

  assert.match(source, /targetBarberIsEligible/);
  assert.match(source, /to_regclass\('public\.employee_active_branches'\)/);
  assert.match(source, /join employee_active_branches eab on eab\.employee_id = b\.id/);
  assert.match(source, /eab\.branch_id=\$2/);
  assert.match(source, /eab\.is_on_shift is true/);
  assert.match(source, /eab\.updated_at >= now\(\) - interval '90 seconds'/);
  assert.match(source, /const candidateIsEligible = await targetBarberIsEligible/);
  assert.match(source, /b\.branch_id=\$2/);
>>>>>>> b093cab68f0e8daf54d01b9bb065964f55c5b2b5
});
