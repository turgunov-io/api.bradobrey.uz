import * as nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function buildTransporter(): nodemailer.Transporter {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !portRaw || !user || !pass) {
    throw new Error(
      'SMTP env vars missing: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS'
    );
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    throw new Error('SMTP_PORT must be a valid number');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export function getMailerTransporter(): nodemailer.Transporter {
  if (!transporter) transporter = buildTransporter();
  return transporter;
}

function buildOtpEmailHtml(code: string): string {
  const safeCode = code
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verification Code</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#111;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 2px 14px rgba(0,0,0,0.06);">
            <tr>
              <td style="padding:28px 28px 8px;">
                <h1 style="margin:0;font-size:18px;line-height:24px;">Your verification code</h1>
                <p style="margin:10px 0 0;font-size:14px;line-height:20px;color:#444;">
                  Use the code below to finish signing in. This code expires in 10 minutes.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 28px 6px;">
                <div style="display:inline-block;padding:14px 22px;border-radius:10px;background:#111;color:#fff;font-size:30px;letter-spacing:6px;font-weight:700;">
                  ${safeCode}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 28px 26px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;">
                  If you didn't request this code, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendOtpEmail(params: {
  to: string;
  code: string;
}): Promise<void> {
  const from = process.env.SMTP_FROM;
  if (!from) throw new Error('SMTP env vars missing: set SMTP_FROM');

  const { to, code } = params;

  await getMailerTransporter().sendMail({
    from,
    to,
    subject: 'Your verification code',
    html: buildOtpEmailHtml(code),
  });
}
