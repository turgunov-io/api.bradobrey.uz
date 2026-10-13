const jwt = require('jsonwebtoken');

const SOCKET_EMPLOYEE_ROLES = new Set([
  'admin_network',
  'admin_branch',
  'admin',
  'manager',
  'barber',
  'super-barber',
  'super-manager',
]);

const isSafeBranchId = (value) => /^[0-9a-f-]{20,64}$/i.test(String(value || ''));

function extractSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token || socket.handshake?.auth?.accessToken;
  if (authToken) return String(authToken);

  const authorization = socket.handshake?.headers?.authorization || '';
  return String(authorization).startsWith('Bearer ')
    ? String(authorization).slice(7)
    : null;
}

function verifySocketToken(socket, secret) {
  const token = extractSocketToken(socket);
  if (!token) {
    const error = new Error('Socket authentication is required');
    error.data = { code: 'SOCKET_AUTH_REQUIRED' };
    throw error;
  }

  const payload = jwt.verify(token, secret);
  const role = String(payload?.role || '').trim();
  const userId = payload?.sub || payload?.id;
  if (!SOCKET_EMPLOYEE_ROLES.has(role) || !userId) {
    const error = new Error('Socket role is not allowed');
    error.data = { code: 'SOCKET_ROLE_FORBIDDEN' };
    throw error;
  }

  return { payload, token };
}

function canAccessSocketBranch({ payload, state, branchId }) {
  if (!isSafeBranchId(branchId)) return false;

  const role = String(payload?.role || '').trim();
  if (role === 'admin_network' || role === 'admin') return true;

  const allowedBranchIds = new Set([
    payload?.branchId,
    payload?.branch_id,
    state?.user?.branch_id,
    state?.barber?.branch_id,
    ...(state?.activeBranches || []),
  ].filter(Boolean).map(String));

  return allowedBranchIds.has(String(branchId));
}

module.exports = {
  SOCKET_EMPLOYEE_ROLES,
  canAccessSocketBranch,
  extractSocketToken,
  isSafeBranchId,
  verifySocketToken,
};
