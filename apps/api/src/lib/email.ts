import { Resend } from 'resend';

// Resend client — initialized lazily to avoid crashes when RESEND_API_KEY is not set
let resend: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = process.env.EMAIL_FROM || 'Messengly <noreply@yourdomain.com>';

// ─── Invite Email ───

export async function sendInviteEmail(params: {
  to: string;
  name: string;
  tempPassword: string;
  organizationName?: string;
  loginUrl: string;
}): Promise<boolean> {
  const client = getResend();
  if (!client) {
    console.log(`[DEV] Invite email for ${params.to} — temp password: ${params.tempPassword}`);
    return false;
  }

  const orgLine = params.organizationName
    ? `You have been invited to join <strong>${params.organizationName}</strong> on Messengly.`
    : 'You have been invited to join Messengly.';

  const { error } = await client.emails.send({
    from: FROM,
    to: params.to,
    subject: params.organizationName
      ? `You're invited to ${params.organizationName}`
      : "You're invited to Messengly",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Welcome, ${params.name}!</h2>
        <p style="color: #475569; line-height: 1.6;">${orgLine}</p>
        <p style="color: #475569; line-height: 1.6;">Here are your login credentials:</p>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Email</p>
          <p style="margin: 0 0 16px; color: #1e293b; font-weight: 600;">${params.to}</p>
          <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Temporary Password</p>
          <p style="margin: 0; color: #1e293b; font-family: monospace; font-size: 15px; letter-spacing: 0.5px;">${params.tempPassword}</p>
        </div>
        <a href="${params.loginUrl}" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; margin: 8px 0;">
          Sign In
        </a>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 24px;">
          We recommend changing your password after your first login.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error('[Email] Failed to send invite email:', error);
    return false;
  }

  return true;
}

// ─── Password Reset Email ───

export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  resetUrl: string;
}): Promise<boolean> {
  const client = getResend();
  if (!client) {
    console.log(`[DEV] Password reset link for ${params.to}: ${params.resetUrl}`);
    return false;
  }

  const { error } = await client.emails.send({
    from: FROM,
    to: params.to,
    subject: 'Reset your password — Messengly',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Password Reset</h2>
        <p style="color: #475569; line-height: 1.6;">
          Hi ${params.name}, we received a request to reset your password.
        </p>
        <p style="color: #475569; line-height: 1.6;">
          Click the button below to set a new password. This link is valid for <strong>1 hour</strong>.
        </p>
        <a href="${params.resetUrl}" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; margin: 16px 0;">
          Reset Password
        </a>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 24px;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error('[Email] Failed to send password reset email:', error);
    return false;
  }

  return true;
}
