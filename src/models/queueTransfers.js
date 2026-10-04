const jwt = require('jsonwebtoken');
const { pool } = require('../config/postgres');
const { canInitiateTransfer, matchingTerminalDecision, resolveTransferOutcome } = require('../utils/queueTransferState');

const BARBER_ROLES = new Set(['barber', 'super-barber', 'manager', 'super-manager']);
const timeoutMinutes = Math.max(1, Number(process.env.QUEUE_TRANSFER_TIMEOUT_MINUTES || 10));
let expiryTimer = null;

function identity(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Authorization token is required' }); return null; }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const id = payload.sub || payload.id;
    if (!BARBER_ROLES.has(payload.role) || !id) { res.status(403).json({ error: 'Only barbers and managers can transfer orders' }); return null; }
    const branchId = payload.branchId || payload.branch_id || null;
    return { id: String(id), branchId: branchId ? String(branchId) : null, role: payload.role };
  } catch (_) { res.status(401).json({ error: 'Invalid or expired token' }); return null; }
}

async function expirePending(client, barberId) {
  const { rows } = await client.query(`
    select id, queue_entry_id, from_barber_id, original_status
      from queue_transfer_events
     where status = 'pending' and expires_at <= now()
       and ($1::uuid is null or to_barber_id = $1::uuid)
     for update skip locked`, [barberId || null]);
  for (const event of rows) {
    await client.query(`update queue_entries set barber_id=$2, status=$3, started_at=null, swapped_flag=true, updated_at=now()
      where id=$1 and status='transfer_pending'`, [event.queue_entry_id, event.from_barber_id, event.original_status]);
    await client.query(`update queue_transfer_events set status='expired', responded_at=now()
      where id=$1 and status='pending'`, [event.id]);
  }
}

async function expireOverdueTransfers() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await expirePending(client, null);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // The additive schema migration may not have been applied yet.
    if (!String(error.message || '').includes('queue_transfer_events')) console.error('[queue-transfers] expiry sweep failed:', error.message);
  } finally { client.release(); }
}

function startExpiryScheduler() {
  if (expiryTimer) return stopExpiryScheduler;
  void expireOverdueTransfers();
  expiryTimer = setInterval(expireOverdueTransfers, 60_000);
  if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
  return stopExpiryScheduler;
}

function stopExpiryScheduler() {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
}

async function request(req, res) {
  const actor = identity(req, res);
  if (!actor) return;
  const orderId = req.params.id;
  const targetId = String(req.body?.barber_id || '').trim();
  if (!orderId || !targetId) return res.status(400).json({ error: 'Queue entry id and barber_id are required' });
  const key = String(req.get('Idempotency-Key') || req.body?.idempotency_key || '').slice(0, 200) || null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (key) {
      const prior = await client.query('select * from queue_transfer_events where idempotency_key=$1', [key]);
      if (prior.rows[0]) {
        if (String(prior.rows[0].queue_entry_id) !== String(orderId) || String(prior.rows[0].from_barber_id) !== actor.id || String(prior.rows[0].to_barber_id) !== targetId) {
          await client.query('rollback');
          return res.status(409).json({ error: 'Idempotency key was already used for another transfer' });
        }
        await client.query('commit'); return res.json({ transfer: prior.rows[0], idempotent: true });
      }
    }
    const result = await client.query(`select id, client_id, barber_id, branch_id, status from queue_entries where id=$1 for update`, [orderId]);
    const entry = result.rows[0];
    if (!entry || (actor.branchId && String(entry.branch_id) !== actor.branchId)) { await client.query('rollback'); return res.status(404).json({ error: 'Queue entry not found' }); }
    if (String(entry.barber_id) !== actor.id) { await client.query('rollback'); return res.status(403).json({ error: 'Only the assigned barber can transfer this order' }); }
    if (entry.status === 'transfer_pending') {
      const pendingTransfer = await client.query(`select * from queue_transfer_events where queue_entry_id=$1
        and from_barber_id=$2 and to_barber_id=$3 and status='pending' order by requested_at desc limit 1`, [orderId, actor.id, targetId]);
      if (pendingTransfer.rows[0]) {
        await client.query('commit');
        return res.status(202).json({ transfer: pendingTransfer.rows[0], idempotent: true });
      }
      await client.query('rollback');
      return res.status(409).json({ error: 'Queue entry is already awaiting another transfer decision' });
    }
    if (!canInitiateTransfer(entry, actor.id, targetId)) { await client.query('rollback'); return res.status(409).json({ error: 'Queue entry cannot be transferred in its current state' }); }
    const candidate = await client.query(`select id from barbers where id=$1 and branch_id=$2
      and is_active is true and is_archived is false and is_on_shift is true`, [targetId, entry.branch_id]);
    if (!candidate.rows[0]) { await client.query('rollback'); return res.status(400).json({ error: 'Selected barber is not available in this branch' }); }
    const transfer = await client.query(`insert into queue_transfer_events
      (queue_entry_id, from_barber_id, to_barber_id, client_id, status, original_status, requested_by, expires_at, idempotency_key)
      values ($1,$2,$3,$4,'pending',$5,$2,now()+($6::text||' minutes')::interval,$7) returning *`,
    [orderId, actor.id, targetId, entry.client_id, entry.status, timeoutMinutes, key]);
    await client.query(`update queue_entries set status='transfer_pending', updated_at=now() where id=$1`, [orderId]);
    await client.query('commit');
    const io = req.app.get('io');
    if (io) io.to(`branch:${entry.branch_id}`).emit('queue:update', { type: 'transfer_pending', entryId: orderId, fromBarberId: actor.id, toBarberId: targetId });
    return res.status(202).json({ transfer: transfer.rows[0], entry: { id: orderId, status: 'transfer_pending', barber_id: actor.id } });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error.code === '23505' && key) {
      const prior = await pool.query('select * from queue_transfer_events where idempotency_key=$1', [key]);
      const existing = prior.rows[0];
      if (existing && String(existing.queue_entry_id) === String(orderId) && String(existing.from_barber_id) === actor.id && String(existing.to_barber_id) === targetId) {
        return res.json({ transfer: existing, idempotent: true });
      }
      return res.status(409).json({ error: 'Idempotency key was already used for another transfer' });
    }
    return res.status(500).json({ error: error.message });
  } finally { client.release(); }
}

async function pending(req, res) {
  const actor = identity(req, res);
  if (!actor) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await expirePending(client, actor.id);
    const { rows } = await client.query(`select t.*, q.status as order_status, q.created_at, q.service_id, q.service_ids,
      c.name as client_name, c.phone as client_phone, b.name as from_barber_name
      from queue_transfer_events t join queue_entries q on q.id=t.queue_entry_id
      left join clients c on c.id=t.client_id left join barbers b on b.id=t.from_barber_id
      where t.to_barber_id=$1 and t.status='pending' order by t.requested_at`, [actor.id]);
    await client.query('commit');
    res.json({ items: rows });
  } catch (error) { await client.query('rollback').catch(() => {}); res.status(500).json({ error: error.message }); }
  finally { client.release(); }
}

async function history(req, res) {
  const actor = identity(req, res);
  if (!actor) return;
  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Queue entry id is required' });

  try {
    const entryResult = await pool.query(`select q.id, q.status, q.branch_id, q.barber_id,
      b.name as current_barber_name
      from queue_entries q left join barbers b on b.id=q.barber_id where q.id=$1`, [orderId]);
    const entry = entryResult.rows[0];
    if (!entry) return res.status(404).json({ error: 'Queue entry not found' });

    const [transferResult, statusResult] = await Promise.all([
      pool.query(`select t.id, t.from_barber_id, fb.name as from_barber_name,
        t.to_barber_id, tb.name as to_barber_name, t.status, t.original_status,
        t.requested_at, t.responded_at, t.expires_at
        from queue_transfer_events t
        left join barbers fb on fb.id=t.from_barber_id
        left join barbers tb on tb.id=t.to_barber_id
        where t.queue_entry_id=$1 order by t.requested_at, t.id`, [orderId]),
      pool.query(`select e.id, e.from_status, e.to_status, e.barber_id,
        b.name as barber_name, e.occurred_at
        from queue_status_events e left join barbers b on b.id=e.barber_id
        where e.queue_entry_id=$1 order by e.occurred_at, e.id`, [orderId]),
    ]);

    const transfers = transferResult.rows || [];
    const statusHistory = statusResult.rows || [];
    const participantIds = new Set([
      String(entry.barber_id || ''),
      ...transfers.flatMap((transfer) => [
        String(transfer.from_barber_id || ''),
        String(transfer.to_barber_id || ''),
      ]),
    ].filter(Boolean));
    const isBranchManager = ['manager', 'super-manager'].includes(actor.role)
      && actor.branchId
      && actor.branchId === String(entry.branch_id);

    if (!participantIds.has(actor.id) && !isBranchManager) {
      return res.status(404).json({ error: 'Queue entry not found' });
    }

    const earliestAssignment = statusHistory.find((event) => event.barber_id);
    const firstTransfer = transfers.find((transfer) => transfer.from_barber_id);
    const originalBarber = earliestAssignment
      ? { id: String(earliestAssignment.barber_id), name: earliestAssignment.barber_name || null }
      : firstTransfer
        ? { id: String(firstTransfer.from_barber_id), name: firstTransfer.from_barber_name || null }
        : { id: String(entry.barber_id), name: entry.current_barber_name || null };
    const barberPath = [originalBarber];

    for (const transfer of transfers) {
      if (transfer.status !== 'accepted' || !transfer.to_barber_id) continue;
      const next = { id: String(transfer.to_barber_id), name: transfer.to_barber_name || null };
      if (barberPath.at(-1)?.id !== next.id) barberPath.push(next);
    }

    const currentBarber = { id: String(entry.barber_id), name: entry.current_barber_name || null };
    if (barberPath.at(-1)?.id !== currentBarber.id) barberPath.push(currentBarber);

    return res.json({
      entry: {
        id: String(entry.id),
        status: entry.status,
        original_barber: originalBarber,
        current_barber: currentBarber,
        barber_path: barberPath,
      },
      transfers: transfers.map((transfer) => ({
        id: String(transfer.id),
        from_barber: transfer.from_barber_id
          ? { id: String(transfer.from_barber_id), name: transfer.from_barber_name || null }
          : null,
        to_barber: transfer.to_barber_id
          ? { id: String(transfer.to_barber_id), name: transfer.to_barber_name || null }
          : null,
        status: transfer.status,
        original_status: transfer.original_status,
        requested_at: transfer.requested_at,
        responded_at: transfer.responded_at,
        expires_at: transfer.expires_at,
      })),
      status_history: statusHistory.map((event) => ({
        id: String(event.id),
        from_status: event.from_status,
        to_status: event.to_status,
        barber: event.barber_id
          ? { id: String(event.barber_id), name: event.barber_name || null }
          : null,
        occurred_at: event.occurred_at,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function respond(req, res, decision) {
  const actor = identity(req, res);
  if (!actor) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`select t.*, q.branch_id from queue_transfer_events t
      join queue_entries q on q.id=t.queue_entry_id where t.id=$1 for update of t`, [req.params.transferId]);
    const transfer = rows[0];
    if (!transfer || String(transfer.to_barber_id) !== actor.id) { await client.query('rollback'); return res.status(404).json({ error: 'Pending transfer not found' }); }
    if (transfer.status !== 'pending') {
      if (matchingTerminalDecision(transfer.status, decision)) { await client.query('commit'); return res.json({ transfer, idempotent: true }); }
      await client.query('rollback');
      return res.status(409).json({ error: `Transfer already resolved as ${transfer.status}` });
    }
    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
      await client.query(`update queue_entries set barber_id=$2, status=$3, started_at=null, swapped_flag=true, updated_at=now() where id=$1 and status='transfer_pending'`, [transfer.queue_entry_id, transfer.from_barber_id, transfer.original_status]);
      const { rows: expired } = await client.query(`update queue_transfer_events set status='expired', responded_by=$2, responded_at=now() where id=$1 returning *`, [transfer.id, actor.id]);
      await client.query('commit');
      return res.status(409).json({ error: 'Transfer expired and order returned to original barber', transfer: expired[0] });
    }
    const outcome = resolveTransferOutcome(decision, transfer);
    const nextBarber = outcome.barberId;
    let assignedAt = null;
    if (decision === 'accept') {
      const tail = await client.query(`select greatest(now(), coalesce(max(created_at), now())) + interval '1 millisecond' as created_at
        from queue_entries where branch_id=$1 and barber_id=$2 and id<>$3
          and status in ('waiting','called','swapped','in_progress')`, [transfer.branch_id, nextBarber, transfer.queue_entry_id]);
      assignedAt = tail.rows[0]?.created_at;
    }
    const updatedOrder = await client.query(`update queue_entries set barber_id=$2, status=$3, started_at=null, swapped_flag=true, updated_at=now()
      , created_at=coalesce($4, created_at) where id=$1 and status='transfer_pending' returning id, status, barber_id, branch_id`, [transfer.queue_entry_id, nextBarber, outcome.orderStatus, assignedAt]);
    if (!updatedOrder.rows[0]) { await client.query('rollback'); return res.status(409).json({ error: 'Order is no longer awaiting transfer confirmation' }); }
    const { rows: updated } = await client.query(`update queue_transfer_events set status=$2, responded_by=$3, responded_at=now(), reason=$4 where id=$1 returning *`, [transfer.id, outcome.transferStatus, actor.id, req.body?.reason || null]);
    await client.query('commit');
    const io = req.app.get('io');
    if (io) io.to(`branch:${updatedOrder.rows[0].branch_id}`).emit('queue:update', { type: `transfer_${outcome.transferStatus}`, entryId: transfer.queue_entry_id, barberId: nextBarber });
    return res.json({ transfer: updated[0], entry: updatedOrder.rows[0] });
  } catch (error) { await client.query('rollback').catch(() => {}); res.status(500).json({ error: error.message }); }
  finally { client.release(); }
}

module.exports = { request, pending, history, startExpiryScheduler, stopExpiryScheduler, accept: (req, res) => respond(req, res, 'accept'), reject: (req, res) => respond(req, res, 'reject') };
