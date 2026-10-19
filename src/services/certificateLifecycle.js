const CERTIFICATE_LIFECYCLE_MESSAGES = Object.freeze({
  unavailable: 'CERTIFICATE_UNAVAILABLE',
  reservationMissing: 'CERTIFICATE_RESERVATION_MISSING',
});

const isCertificateLifecycleError = (error) => {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || error?.details || '').trim().toUpperCase();
  return code === 'P0001' && Object.values(CERTIFICATE_LIFECYCLE_MESSAGES)
    .some((value) => message.includes(value));
};

const certificateLifecycleResponse = (error) => {
  const message = String(error?.message || error?.details || '').toUpperCase();
  const code = message.includes(CERTIFICATE_LIFECYCLE_MESSAGES.reservationMissing)
    ? CERTIFICATE_LIFECYCLE_MESSAGES.reservationMissing
    : CERTIFICATE_LIFECYCLE_MESSAGES.unavailable;
  return { status: 409, body: { error: code, code } };
};

const getCertificateStatus = (certificate, now = new Date()) => {
  if (certificate?.is_used) return 'used';
  if (certificate?.reserved_queue_entry_id) return 'reserved';

  if (certificate?.expires_at) {
    const expiresAt = new Date(certificate.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return 'expired';
  }

  return 'active';
};

const withCertificateStatus = (certificate, now = new Date()) => {
  if (!certificate) return certificate;
  return { ...certificate, status: getCertificateStatus(certificate, now) };
};

module.exports = {
  CERTIFICATE_LIFECYCLE_MESSAGES,
  certificateLifecycleResponse,
  getCertificateStatus,
  isCertificateLifecycleError,
  withCertificateStatus,
};
