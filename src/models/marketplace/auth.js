const jwt = require('jsonwebtoken');
const bcrypto = require('bcryptjs');
const crypto = require('crypto');

const { supabase } = require('../../config/supabase');

const MARKETPLACE_ROLE = 'marketplace';
const OTP_TTL_MS = 10 * 60 * 1000;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const generateOtpCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const normalizeOtpCode = (codeInput) => {
  if (typeof codeInput === 'number' && Number.isInteger(codeInput)) {
    return String(codeInput).padStart(6, '0');
  }
  return String(codeInput || '').trim();
};

const shouldReturnOtpInResponse = () => process.env.OTP_DEBUG_RETURN_CODE === 'true';

const signMarketplaceToken = ({ id, email }) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is not configured');

  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign({ sub: id, email, role: MARKETPLACE_ROLE }, jwtSecret, { expiresIn });
};

const canSendOtpEmail = () =>
  Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM
  );

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
  const from = process.env.SMTP_FROM;

  if (!Number.isFinite(port)) {
    return { sent: false, reason: 'invalid_smtp_port' };
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
  async register(req, res) {
    try {
      const { email: emailInput } = req.body || {};

      if (typeof emailInput !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      const email = normalizeEmail(emailInput);
      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      const code = generateOtpCode();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);

      const { error: invalidateError } = await supabase
        .from('otp_codes')
        .update({ used: true })
        .eq('email', email)
        .eq('used', false);

      if (invalidateError) {
        return res.status(500).json({ error: invalidateError.message });
      }

      const { data: insertedOtp, error: insertError } = await supabase
        .from('otp_codes')
        .insert({
          email,
          code,
          expires_at: expiresAt.toISOString(),
          used: false,
        })
        .select('id')
        .single();

      if (insertError || !insertedOtp) {
        return res.status(500).json({ error: insertError?.message || 'Failed to create OTP' });
      }

      try {
        const { sent } = await trySendOtpEmail({ to: email, code });
        if (sent) {
          return res.status(200).json({ message: 'OTP sent' });
        }
      } catch (mailErr) {
        console.error('OTP email send failed:', mailErr?.message || mailErr);
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

      if (!email || !isValidEmail(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid email or code' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const nowIso = new Date().toISOString();

      const { data: otp, error: otpError } = await supabase
        .from('otp_codes')
        .select('id')
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

      const { data: existingClient, error: existingError } = await supabase
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
        const { data: updated, error: updateError } = await supabase
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
        const { data: created, error: createError } = await supabase
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

      const useNowIso = new Date().toISOString();
      const { data: usedRows, error: useError } = await supabase
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

      const { data: client, error: clientError } = await supabase
        .from('marketplace_clients')
        .select('id, email, password_hash, is_active')
        .eq('email', email)
        .maybeSingle();

      if (clientError) {
        return res.status(500).json({ error: clientError.message });
      }

      if (!client || !client.password_hash) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      if (client.is_active === false) {
        return res.status(403).json({ error: 'Account is disabled' });
      }

      const passwordCheck = bcrypto.compareSync(password, client.password_hash);
      if (!passwordCheck) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      const expiresIn = process.env.JWT_EXPIRES_IN || '7d';

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
        await supabase
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
