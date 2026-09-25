const jwt = require('jsonwebtoken');
const bcrypto = require('bcryptjs');
const crypto = require('crypto');

const { db, pool } = require('../../config/postgres');

const MARKETPLACE_ROLE = 'marketplace';
const OTP_TTL_MS = 10 * 60 * 1000;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const normalizePhone = (phoneInput) => {
  const cleaned = String(phoneInput || '').trim().replace(/[\s()-]/g, '');
  return cleaned || null;
};

const isValidE164 = (phone) => /^\+\d{7,15}$/.test(phone || '');

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const generateOtpCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const fixedOtpCode = () => {
  const configured = String(process.env.MARKETPLACE_FIXED_OTP || '').trim();
  if (/^\d{4,6}$/.test(configured)) return configured;
  // Temporary fallback until an SMS provider is configured.
  return '0000';
};

const generateMarketplaceOtpCode = () => fixedOtpCode() || generateOtpCode();

const normalizeOtpCode = (codeInput) => {
  if (typeof codeInput === 'number' && Number.isInteger(codeInput)) {
    return String(codeInput).padStart(fixedOtpCode()?.length || 6, '0');
  }

  // Gmail clients can copy a code with spaces or a hyphen (for example
  // `123-456`). Keep verification tolerant while still validating exactly
  // the configured OTP length below.
  const normalized = String(codeInput || '')
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  return normalized;
};

const shouldReturnOtpInResponse = () => process.env.OTP_DEBUG_RETURN_CODE === 'true';

const writeAuthAudit = async ({ clientId = null, action, req, metadata = {} }) => {
  try {
    await db.from('marketplace_audit_logs').insert({
      marketplace_client_id: clientId,
      action,
      entity_type: 'marketplace_auth',
      request_id: String(req.get('Idempotency-Key') || '').trim() || null,
      metadata: {
        ...metadata,
        ip: req.ip || null,
        user_agent: String(req.get('user-agent') || '').slice(0, 512) || null,
      },
    });
  } catch (auditError) {
    console.error('[marketplace-auth] audit write failed', auditError.message);
  }
};

const signMarketplaceToken = ({ id, email = null, phone = null }) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is not configured');

  const expiresIn = process.env.JWT_EXPIRES_IN || '12h';
  return jwt.sign({ sub: id, email, phone, role: MARKETPLACE_ROLE }, jwtSecret, { expiresIn });
};

const sendPhoneOtp = async ({ phone, code }) => {
  const url = String(process.env.SMS_WEBHOOK_URL || '').trim();
  if (!url) return { sent: false, reason: 'sms_provider_not_configured' };

  const headers = { 'content-type': 'application/json' };
  if (process.env.SMS_WEBHOOK_TOKEN) {
    headers.authorization = `Bearer ${process.env.SMS_WEBHOOK_TOKEN}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone, message: `BRADOBREY verification code: ${code}` }),
  });
  if (!response.ok) return { sent: false, reason: `sms_provider_http_${response.status}` };
  return { sent: true };
};

const canSendOtpEmail = () =>
  Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
  );

const buildSmtpFrom = ({ user, fromRaw }) => {
  const fromValue = String(fromRaw || '').trim();
  const userValue = String(user || '').trim();

  if (fromValue) {
    // Already a well-formed address: bare `name@host` or `"Name" <name@host>`.
    if (/^[^\s<>]+@[^\s<>]+$/.test(fromValue) || /<[^\s<>]+@[^\s<>]+>/.test(fromValue)) {
      return fromValue;
    }

    // Display name + bare email with no angle brackets (e.g. `Bradobrey API name@host`).
    // Split the address out and treat the leading text as the display name so we
    // never hand nodemailer a malformed `From` header.
    const emailMatch = fromValue.match(/[^\s<>]+@[^\s<>]+/);
    if (emailMatch) {
      const address = emailMatch[0];
      const name = fromValue.replace(address, '').replace(/["<>]/g, '').trim();
      return name ? { name, address } : address;
    }

    // Display name only; best-effort fallback to authenticated SMTP user when it's an email.
    if (userValue && /@/.test(userValue)) {
      return { name: fromValue, address: userValue };
    }

    return null;
  }

  if (userValue && /@/.test(userValue)) return userValue;
  return null;
};

const trySendOtpEmail = async ({ to, code }) => {
  if (!canSendOtpEmail()) return { sent: false, reason: 'smtp_not_configured' };

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return { sent: false, reason: 'nodemailer_not_installed' };
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = buildSmtpFrom({ user, fromRaw: process.env.SMTP_FROM });

  if (!Number.isFinite(port)) {
    return { sent: false, reason: 'invalid_smtp_port' };
  }

  if (!from) {
    return { sent: false, reason: 'invalid_smtp_from' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to,
    subject: 'Your verification code',
    text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`,
  });

  return { sent: true };
};

class MarketplaceAuth {
  async requestPhoneOtp(req, res) {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!isValidE164(phone)) {
        return res.status(400).json({ error: 'phone must be in E.164 format' });
      }

      const code = generateOtpCode();
      const referralCode = String(req.body?.referral_code || '').trim().toUpperCase() || null;
      const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
      const { error: invalidateError } = await db.from('otp_codes')
        .update({ used: true })
        .eq('phone', phone)
        .eq('used', false);
      if (invalidateError) return res.status(500).json({ error: invalidateError.message });

      const { error: insertError } = await db.from('otp_codes').insert({
        phone,
        referral_code: referralCode,
        request_ip: req.ip || null,
        device_id: String(req.get('x-device-id') || '').trim() || null,
        code,
        expires_at: expiresAt,
        used: false,
      });
      if (insertError) return res.status(500).json({ error: insertError.message });

      const result = await sendPhoneOtp({ phone, code });
      if (result.sent) return res.json({ message: 'OTP sent' });
      if (!process.env.SMS_WEBHOOK_URL) {
        console.warn(`SMS provider is not configured; use fallback OTP ${code}`);
        return res.json({ message: 'OTP sent' });
      }
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'SMS delivery is not configured' });
      }
      console.log(`Marketplace OTP for ${phone}: ${code}`);
      return res.json({ message: 'OTP sent', ...(shouldReturnOtpInResponse() ? { code } : {}) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async verifyPhone(req, res) {
    const phone = normalizePhone(req.body?.phone);
    const code = normalizeOtpCode(req.body?.code);
    const expectedOtpLength = fixedOtpCode()?.length || 6;
    const displayName = String(req.body?.display_name || '').trim().slice(0, 120);
    const language = String(req.body?.language || 'ru').trim().toLowerCase();
    if (!isValidE164(phone) || !new RegExp(`^\\d{${expectedOtpLength}}$`).test(code)) {
      return res.status(400).json({ error: `Valid phone and ${expectedOtpLength}-digit code are required` });
    }
    if (!['uz', 'ru', 'en'].includes(language)) {
      return res.status(400).json({ error: 'language must be uz, ru, or en' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const otpResult = await client.query(
        `select id, referral_code, request_ip, device_id from otp_codes where phone = $1 and code = $2 and used = false and expires_at > now()
         order by created_at desc limit 1 for update`,
        [phone, code]
      );
      if (!otpResult.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      const existingAccount = await client.query(
        'select id, display_name from marketplace_clients where phone = $1 for update',
        [phone],
      );
      if (!existingAccount.rows[0] && displayName.length < 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Name is required for registration' });
      }
      const storedDisplayName = displayName || existingAccount.rows[0]?.display_name || 'Client';

      const accountResult = await client.query(
        `insert into marketplace_clients (phone, display_name, language, is_active)
         values ($1, $2, $3, true)
         on conflict (phone) where phone is not null do update
           set display_name = case when marketplace_clients.display_name is null or marketplace_clients.display_name = '' then excluded.display_name else marketplace_clients.display_name end,
               language = excluded.language,
               last_login_at = now()
         returning id, phone, display_name, language, is_active, (xmax = 0) as created_new`,
        [phone, storedDisplayName, language]
      );
      const account = accountResult.rows[0];
      if (!account || account.is_active === false) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Account is disabled' });
      }
      if (otpResult.rows[0].referral_code && account.created_new === true) {
        const referral = await client.query(
          `select marketplace_client_id, referral_code from referral_accounts where referral_code = $1 for update`,
          [String(otpResult.rows[0].referral_code).trim().toUpperCase()]
        );
        if (!referral.rows[0] || referral.rows[0].marketplace_client_id === account.id) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Invalid referral code' });
        }
        const referralSettings = await client.query(
          `select value from platform_settings where key = 'referral'`
        );
        const dailyLimit = Number(referralSettings.rows[0]?.value?.daily_limit || 10);
        const expiryDays = Math.max(1, Number(referralSettings.rows[0]?.value?.expiry_days || 365));
        const dailyCount = await client.query(
          `select count(*)::int as count from referrals
            where referrer_client_id = $1
              and (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date`,
          [referral.rows[0].marketplace_client_id]
        );
        if (Number(dailyCount.rows[0]?.count || 0) >= dailyLimit) {
          await client.query('ROLLBACK');
          return res.status(429).json({ error: 'REFERRAL_DAILY_LIMIT_REACHED' });
        }
        const sourceIp = otpResult.rows[0].request_ip || null;
        const deviceId = otpResult.rows[0].device_id || null;
        const sourceCount = await client.query(
          `select count(*)::int as count from referrals
            where (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date
              and (($1::inet is not null and source_ip = $1::inet)
                or ($2::text is not null and device_id = $2::text))`,
          [sourceIp, deviceId]
        );
        if (Number(sourceCount.rows[0]?.count || 0) >= dailyLimit) {
          await client.query(
            `insert into marketplace_fraud_alerts (marketplace_client_id, kind, source_ip, device_id, metadata)
             values ($1, 'REFERRAL_VELOCITY', $2::inet, $3, $4::jsonb)`,
            [referral.rows[0].marketplace_client_id, sourceIp, deviceId, JSON.stringify({ daily_limit: dailyLimit })]
          );
        }
        await client.query(
          `insert into referrals (referrer_client_id, referred_client_id, referral_code, expires_at, source_ip, device_id)
           values ($1, $2, $3, now() + ($4::text || ' days')::interval, $5::inet, $6)
           on conflict (referred_client_id) do nothing`,
          [referral.rows[0].marketplace_client_id, account.id, referral.rows[0].referral_code, expiryDays, sourceIp, deviceId]
        );
      }
      await client.query('update otp_codes set used = true where id = $1', [otpResult.rows[0].id]);
      await client.query('COMMIT');

      return res.json({
        token: signMarketplaceToken({ id: account.id, phone: account.phone }),
        client: {
          id: account.id,
          phone: account.phone,
          display_name: account.display_name,
          language: account.language,
          is_active: account.is_active,
        },
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    } finally {
      client.release();
    }
  }

  async register(req, res) {
    try {
      const { email: emailInput } = req.body || {};
      const referralCode = String(req.body?.referral_code || '').trim().toUpperCase() || null;

      if (typeof emailInput !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      const email = normalizeEmail(emailInput);
      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      const code = generateMarketplaceOtpCode();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);

      const otpPayload = {
        email,
        code,
        expires_at: expiresAt.toISOString(),
        used: false,
        ...(referralCode ? { referral_code: referralCode } : {}),
      };
      const { data: insertedOtp, error: insertError } = await db
        .from('otp_codes')
        .insert(otpPayload)
        .select('id,referral_code')
        .single();

      if (insertError || !insertedOtp) {
        return res.status(500).json({ error: insertError?.message || 'Failed to create OTP' });
      }

      try {
        const smtpConfigured = canSendOtpEmail();
        const { sent, reason } = await trySendOtpEmail({ to: email, code });

        if (sent) return res.status(200).json({ message: 'OTP sent' });

        if (smtpConfigured) {
          console.error('OTP email send failed:', reason);
          return res.status(500).json({ error: 'Failed to send OTP email' });
        }
      } catch (mailErr) {
        console.error('OTP email send failed:', mailErr?.message || mailErr);
        if (canSendOtpEmail()) {
          return res.status(500).json({ error: 'Failed to send OTP email' });
        }
      }

      if (shouldReturnOtpInResponse()) {
        return res.status(200).json({ message: 'OTP sent', code });
      }

      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ error: 'OTP delivery is not configured' });
      }

      console.log(`Marketplace OTP for ${email}: ${code}`);
      return res.status(200).json({ message: 'OTP sent' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async verify(req, res) {
    try {
      const { email: emailInput, code: codeInput, password } = req.body || {};

      if (typeof emailInput !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Email, code, and password are required' });
      }

      const email = normalizeEmail(emailInput);
      const code = normalizeOtpCode(codeInput);

      const expectedLength = fixedOtpCode()?.length || 6;
      if (!email || !isValidEmail(email) || !new RegExp(`^\\d{${expectedLength}}$`).test(code)) {
        return res.status(400).json({ error: 'Invalid email or code' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const nowIso = new Date().toISOString();

      const { data: otp, error: otpError } = await db
        .from('otp_codes')
        .select('id,referral_code')
        .eq('email', email)
        .eq('code', code)
        .eq('used', false)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (otpError) {
        return res.status(500).json({ error: otpError.message });
      }

      if (!otp) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      const { data: existingClient, error: existingError } = await db
        .from('marketplace_clients')
        .select('id,is_active')
        .eq('email', email)
        .maybeSingle();

      if (existingError) {
        return res.status(500).json({ error: existingError.message });
      }

      if (existingClient?.is_active === false) {
        return res.status(403).json({ error: 'Account is disabled' });
      }

      const password_hash = bcrypto.hashSync(password, 10);

      let client;
      if (existingClient?.id) {
        const { data: updated, error: updateError } = await db
          .from('marketplace_clients')
          .update({ password_hash, last_login_at: nowIso })
          .eq('id', existingClient.id)
          .select('id,email,is_active')
          .maybeSingle();

        if (updateError) {
          return res.status(500).json({ error: updateError.message });
        }

        client = updated;
      } else {
        const { data: created, error: createError } = await db
          .from('marketplace_clients')
          .insert({ email, password_hash, is_active: true, last_login_at: nowIso })
          .select('id,email,is_active')
          .maybeSingle();

        if (createError) {
          return res.status(500).json({ error: createError.message });
        }

        client = created;
      }

      if (!client) {
        return res.status(500).json({ error: 'Failed to save client' });
      }

      if (otp.referral_code) {
        try {
          const referral = await pool.query(
            `select marketplace_client_id from referral_accounts
              where referral_code = $1 and marketplace_client_id <> $2
              limit 1`,
            [String(otp.referral_code).trim().toUpperCase(), client.id],
          );
          if (referral.rows[0]?.marketplace_client_id) {
            await pool.query(
              `insert into referrals
                (referrer_client_id, referred_client_id, referral_code, expires_at)
               values ($1, $2, $3, now() + interval '365 days')
               on conflict (referred_client_id) do nothing`,
              [
                referral.rows[0].marketplace_client_id,
                client.id,
                String(otp.referral_code).trim().toUpperCase(),
              ],
            );
          }
        } catch (referralError) {
          if (!['42P01', '42703'].includes(String(referralError?.code || ''))) {
            console.error('[marketplace-auth] referral binding failed:', referralError.message);
          }
        }
      }

      const useNowIso = new Date().toISOString();
      const { data: usedRows, error: useError } = await db
        .from('otp_codes')
        .update({ used: true })
        .eq('id', otp.id)
        .eq('used', false)
        .gt('expires_at', useNowIso)
        .select('id');

      if (useError) {
        return res.status(500).json({ error: useError.message });
      }

      if (!usedRows || usedRows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      let token;
      try {
        token = signMarketplaceToken({ id: client.id, email: client.email });
      } catch (jwtErr) {
        console.error(jwtErr);
        return res.status(500).json({ error: jwtErr.message || 'JWT error' });
      }

      return res.json({
        token,
        client: {
          id: client.id,
          email: client.email,
        },
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async login(req, res) {
    try {
      const { email: emailInput, password } = req.body || {};

      if (typeof emailInput !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const email = normalizeEmail(emailInput);
      if (!email || !isValidEmail(email) || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const { data: client, error: clientError } = await db
        .from('marketplace_clients')
        .select('id, email, password_hash, is_active')
        .eq('email', email)
        .maybeSingle();

      if (clientError) {
        return res.status(500).json({ error: clientError.message });
      }

      if (!client || !client.password_hash) {
        await writeAuthAudit({ action: 'LOGIN_FAILED', req, metadata: { reason: 'INVALID_CREDENTIALS', email } });
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      if (client.is_active === false) {
        await writeAuthAudit({ clientId: client.id, action: 'LOGIN_FAILED', req, metadata: { reason: 'ACCOUNT_DISABLED' } });
        return res.status(403).json({ error: 'Account is disabled' });
      }

      const passwordCheck = bcrypto.compareSync(password, client.password_hash);
      if (!passwordCheck) {
        await writeAuthAudit({ clientId: client.id, action: 'LOGIN_FAILED', req, metadata: { reason: 'INVALID_CREDENTIALS' } });
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      const expiresIn = process.env.JWT_EXPIRES_IN || '12h';

      let token;
      try {
        token = jwt.sign(
          { sub: client.id, email: client.email, role: MARKETPLACE_ROLE },
          process.env.JWT_SECRET,
          { expiresIn }
        );
      } catch (jwtErr) {
        console.error(jwtErr);
        return res.status(500).json({ error: jwtErr.message || 'JWT error' });
      }

      try {
        await db
          .from('marketplace_clients')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', client.id);
      } catch (_) {
        // best-effort
      }

      return res.json({
        token,
        client: {
          id: client.id,
          email: client.email,
        },
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
}

module.exports = new MarketplaceAuth();
