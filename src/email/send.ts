import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || undefined);
const FROM = process.env.EMAIL_FROM || "Segmentor <onboarding@resend.dev>";

export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email-skip] No RESEND_API_KEY — would send "${subject}" to ${to}`);
    return;
  }

  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(`[email-error] Failed to send "${subject}" to ${to}:`, err);
  }
}

/**
 * Fire-and-forget email — call without await so it doesn't block the response.
 * Errors are silently logged.
 */
export function fireEmail(to: string, subject: string, html: string): void {
  sendEmail(to, subject, html).catch(() => {});
}
