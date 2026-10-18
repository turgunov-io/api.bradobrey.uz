const http = require('http');
const { Server } = require('socket.io');

require('dotenv').config();
const app = require('./app');
const { startQueueAutoCloseScheduler, stopQueueAutoCloseScheduler } = require('./jobs/autoCloseQueue');
const { startExpiryScheduler, stopExpiryScheduler } = require('./models/queueTransfers');
const { startEmployeeSessionCleanup } = require('./jobs/employeeSessionCleanup');
const { startMarketplaceNotificationDispatcher } = require('./services/marketplacePush');
const { startCashbackReconciliationScheduler } = require('./services/cashbackReconciliation');
const { startReferralBonusScheduler } = require('./services/referralBonus');
const { db } = require('./config/postgres');
const {
  canAccessSocketBranch,
  isSafeBranchId,
  verifySocketToken,
} = require('./socketAuth');
const { verifyKioskSocketTicket } = require('./kioskSocketTicket');
const { validatePersistedEmployeeSession } = require('./utils/employeeSession');
const server = http.createServer(app);

const corsOrigin = app.get('corsOrigin') || '*';

const io = new Server(server, {
  cors: { origin: corsOrigin },
});

app.set('io', io);
startQueueAutoCloseScheduler({ io });
startExpiryScheduler();
const stopMarketplaceNotificationDispatcher = startMarketplaceNotificationDispatcher();
const stopCashbackReconciliationScheduler = startCashbackReconciliationScheduler();
const stopReferralBonusScheduler = startReferralBonusScheduler();
const stopEmployeeSessionCleanup = startEmployeeSessionCleanup({ io });

async function loadSocketAccessState(userId) {
  const [{ data: user, error: userError }, { data: barber, error: barberError }, activeResult] = await Promise.all([
    db.from('users').select('id, role, branch_id').eq('id', userId).maybeSingle(),
    db.from('barbers').select('id, branch_id, is_archived').eq('id', userId).maybeSingle(),
    db.from('employee_active_branches').select('branch_id').eq('employee_id', userId),
  ]);

  if (userError) throw userError;
  if (barberError) throw barberError;
  if (activeResult.error && !String(activeResult.error.message || '').includes('employee_active_branches')) {
    throw activeResult.error;
  }

  return {
    user: user || null,
    barber: barber || null,
    activeBranches: (activeResult.data || []).map((row) => row.branch_id).filter(Boolean),
  };
}

io.use(async (socket, next) => {
  try {
    const kioskTicket = socket.handshake?.auth?.kioskTicket;
    if (kioskTicket) {
      const payload = verifyKioskSocketTicket(kioskTicket);
      socket.data.auth = { kind: 'kiosk', payload, state: {} };
      return next();
    }
    const { payload } = verifySocketToken(socket, process.env.JWT_SECRET);
    if (payload.role === 'marketplace') {
      const { data: client, error } = await db.from('marketplace_clients')
        .select('id, is_active').eq('id', payload.sub || payload.id).maybeSingle();
      if (error) throw error;
      if (!client || client.is_active === false) {
        const error = new Error('Socket session is no longer valid');
        error.data = { code: 'SOCKET_SESSION_REVOKED' };
        return next(error);
      }
      socket.data.auth = { kind: 'marketplace', payload, state: { client } };
      return next();
    }
    const state = await loadSocketAccessState(payload.sub || payload.id);
    if (!state.user || state.barber?.is_archived === true) {
      const error = new Error('Socket session is no longer valid');
      error.data = { code: 'SOCKET_SESSION_REVOKED' };
      return next(error);
    }

    if (['barber', 'super-barber', 'manager', 'super-manager'].includes(payload.role)) {
      const session = await validatePersistedEmployeeSession({
        employeeId: payload.sub || payload.id,
        branchId: payload.branchId,
        sessionId: payload.jti,
        role: payload.role,
      });
      if (!session.valid) {
        const error = new Error('Socket session is no longer valid');
        error.data = { code: session.reason === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_REVOKED' };
        return next(error);
      }
    }

    socket.data.auth = { payload, state };
    return next();
  } catch (error) {
    return next(error);
  }
});

io.on('connection', (socket) => {
  const joinedBranches = new Set();
  if (socket.data.auth?.kind === 'kiosk') {
    const branchId = String(socket.data.auth.payload.branchId);
    socket.join(`branch:${branchId}`);
    joinedBranches.add(branchId);
  }
  if (socket.data.auth?.kind === 'marketplace') {
    const clientId = socket.data.auth.payload.sub || socket.data.auth.payload.id;
    socket.join(`client:${clientId}`);
  }
  if (!['kiosk', 'marketplace'].includes(socket.data.auth?.kind)) {
    const employeeId = socket.data.auth?.payload?.sub || socket.data.auth?.payload?.id;
    if (employeeId) socket.join(`employee:${employeeId}`);
  }
  const disconnectAt = Number(socket.data.auth?.payload?.exp || 0) * 1000 - Date.now();
  if (disconnectAt > 0) {
    const expiryTimer = setTimeout(() => socket.disconnect(true), disconnectAt);
    expiryTimer.unref?.();
    socket.once('disconnect', () => clearTimeout(expiryTimer));
  }

  const resolveRequestedBranch = (value) => String(value?.branchId || value || '').trim();
  const reply = (ack, result) => {
    if (typeof ack === 'function') ack(result);
  };

  const joinBranch = async (value, ack) => {
    const branchId = resolveRequestedBranch(value);
    if (socket.data.auth?.kind === 'kiosk') {
      const allowedBranchId = String(socket.data.auth.payload.branchId);
      if (branchId !== allowedBranchId) {
        reply(ack, { ok: false, code: 'BRANCH_ACCESS_DENIED' });
        socket.emit('branch_access_denied', { branchId });
        return;
      }
      reply(ack, { ok: true, branchId });
      return;
    }
    try {
      const userId = socket.data.auth?.payload?.sub || socket.data.auth?.payload?.id;
      const state = await loadSocketAccessState(userId);
      socket.data.auth.state = state;
    } catch (_error) {
      reply(ack, { ok: false, code: 'BRANCH_ACCESS_UNAVAILABLE' });
      socket.emit('branch_access_denied', { branchId });
      return;
    }

    if (!canAccessSocketBranch({ ...socket.data.auth, branchId })) {
      reply(ack, { ok: false, code: 'BRANCH_ACCESS_DENIED' });
      socket.emit('branch_access_denied', { branchId });
      return;
    }

    for (const previousBranchId of joinedBranches) {
      if (previousBranchId !== branchId) socket.leave(`branch:${previousBranchId}`);
      joinedBranches.delete(previousBranchId);
    }
    socket.join(`branch:${branchId}`);
    joinedBranches.add(branchId);
    reply(ack, { ok: true, branchId });
  };

  const leaveBranch = (value, ack) => {
    const branchId = resolveRequestedBranch(value);
    if (!isSafeBranchId(branchId)) return reply(ack, { ok: false, code: 'INVALID_BRANCH' });
    socket.leave(`branch:${branchId}`);
    joinedBranches.delete(branchId);
    reply(ack, { ok: true, branchId });
  };

  // Keep the protocol used by the kiosk and marketplace clients identical,
  // but never trust a client-provided branch without server-side authorization.
  socket.on('join', joinBranch);
  socket.on('join_branch', joinBranch);
  socket.on('leave', leaveBranch);
  socket.on('leave_branch', leaveBranch);
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  stopQueueAutoCloseScheduler();
  stopExpiryScheduler();
  stopMarketplaceNotificationDispatcher();
  stopCashbackReconciliationScheduler();
  stopReferralBonusScheduler();
  stopEmployeeSessionCleanup();
});
process.on('SIGINT', () => {
  stopQueueAutoCloseScheduler();
  stopExpiryScheduler();
  stopMarketplaceNotificationDispatcher();
  stopCashbackReconciliationScheduler();
  stopReferralBonusScheduler();
  stopEmployeeSessionCleanup();
});
