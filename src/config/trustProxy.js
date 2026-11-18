// Parses TRUST_PROXY into an Express "trust proxy" setting.
//   unset / "false" / "0"   -> null (do not trust forwarded headers)
//   "true"                  -> 1 (one hop: nginx)
//   "2"                     -> hop count
//   "loopback,95.46.96.213" -> trusted proxy addresses/subnets
// The address list form is for chained proxies such as the dashboard BFF:
// its forwarded client IP is honoured only when the request comes from a
// listed address, so direct clients cannot spoof X-Forwarded-For.
// Never returns `true` (trust every hop): the leftmost entry is client-controlled.
const parseTrustProxy = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'false') return null;
  if (raw === 'true') return 1;

  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops > 0 ? hops : null;
  }

  const addresses = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return addresses.length ? addresses : null;
};

module.exports = { parseTrustProxy };
