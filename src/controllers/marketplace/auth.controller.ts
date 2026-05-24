import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

import { sendOtpEmail } from '../../utils/mailer';
import { supabase } from '../../utils/supabase';

const OTP_TTL_MS = 10 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function badRequest(res: Response, message: string) {
  return res.status(400).json({ message });
}

function serverError(res: Response, message: string) {
  return res.status(500).json({ message });
}

export async function registerMarketplaceClient(req: Request, res: Response) {
  try {
    const emailInput = req.body?.email;
    if (typeof emailInput !== 'string') {
      return badRequest(res, 'Invalid input');
    }

    const email = normalizeEmail(emailInput);
    if (!isValidEmail(email)) {
      return badRequest(res, 'Invalid input');
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const { error: invalidateError } = await supabase
      .from('otp_codes')
      .update({ used: true })
      .eq('email', email)
      .eq('used', false);

    if (invalidateError) {
      console.error(invalidateError);
      return serverError(res, 'Supabase error');
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
      console.error(insertError);
      return serverError(res, 'Supabase error');
    }

    try {
      await sendOtpEmail({ to: email, code });
    } catch (smtpErr) {
      console.error(smtpErr);
      await supabase.from('otp_codes').update({ used: true }).eq('id', insertedOtp.id);
      return serverError(res, 'SMTP error');
    }

    return res.status(200).json({ message: 'OTP sent' });
  } catch (err) {
    console.error(err);
    return serverError(res, 'Internal server error');
  }
}

export async function verifyMarketplaceClient(req: Request, res: Response) {
  try {
    const emailInput = req.body?.email;
    const codeInput = req.body?.code;

    if (
      typeof emailInput !== 'string' ||
      (typeof codeInput !== 'string' && typeof codeInput !== 'number')
    ) {
      return badRequest(res, 'Invalid input');
    }

    const email = normalizeEmail(emailInput);
    const code =
      typeof codeInput === 'number' && Number.isInteger(codeInput)
        ? String(codeInput).padStart(6, '0')
        : String(codeInput).trim();

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return badRequest(res, 'Invalid input');
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return serverError(res, 'JWT secret not configured');
    }

    const expiresIn = process.env.JWT_EXPIRES_IN || '12h';

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
      console.error(otpError);
      return serverError(res, 'Supabase error');
    }

    if (!otp) {
      return badRequest(res, 'Invalid or expired OTP');
    }

    const { data: client, error: clientError } = await supabase
      .from('marketplace_clients')
      .upsert({ email, last_login_at: nowIso }, { onConflict: 'email' })
      .select('id,email,is_active')
      .single();

    if (clientError || !client) {
      console.error(clientError);
      return serverError(res, 'Supabase error');
    }

    let token: string;
    try {
      token = jwt.sign({ sub: client.id, email: client.email }, jwtSecret, {
        expiresIn,
      });
    } catch (jwtErr) {
      console.error(jwtErr);
      return serverError(res, 'JWT error');
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
      console.error(useError);
      return serverError(res, 'Supabase error');
    }

    if (!usedRows || usedRows.length === 0) {
      return badRequest(res, 'Invalid or expired OTP');
    }

    return res.status(200).json({ token });
  } catch (err) {
    console.error(err);
    return serverError(res, 'Internal server error');
  }
}
