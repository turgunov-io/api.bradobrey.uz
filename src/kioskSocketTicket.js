const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 15 * 60;

function getSecret(secret = process.env.KIOSK_SOCKET_SECRET) {
  if (!secret || String(secret).length < 32) {
    const error = new Error('KIOSK_SOCKET_SECRET is not configured');
    error.code = 'KIOSK_SOCKET_SECRET_MISSING';
    throw error;
  }
  return String(secret);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', getSecret(secret)).update(value).digest('base64url');
}

function issueKioskSocketTicket({ kioskId, branchId, deviceName, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS, secret }) {
  if (!kioskId || !branchId || !deviceName) throw new Error('Kiosk ticket fields are required');
  const issuedAt = Math.floor(now / 1000);
  const payload = { kind: 'kiosk', kioskId: String(kioskId), branchId: String(branchId), deviceName: String(deviceName), iat: issuedAt, exp: issuedAt + Number(ttlSeconds) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifyKioskSocketTicket(ticket, secret = process.env.KIOSK_SOCKET_SECRET, now = Date.now()) {
  const [encoded, providedSignature] = String(ticket || '').split('.');
  if (!encoded || !providedSignature) throw new Error('Invalid kiosk socket ticket');
  const expectedSignature = sign(encoded, secret);
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) throw new Error('Invalid kiosk socket ticket');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.kind !== 'kiosk' || !payload.kioskId || !payload.branchId || !payload.deviceName || Number(payload.exp) * 1000 <= now) throw new Error('Expired or invalid kiosk socket ticket');
  return payload;
}

module.exports = { DEFAULT_TTL_SECONDS, issueKioskSocketTicket, verifyKioskSocketTicket };
