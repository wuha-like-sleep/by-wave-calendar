import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.js";

let cached: Transporter | null = null;

export function isMailerEnabled(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM_ADDRESS);
}

function getTransport(): Transporter | null {
  if (!isMailerEnabled()) return null;
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
    tls: { minVersion: "TLSv1.2" },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  return cached;
}

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendMail(args: SendArgs): Promise<{ ok: boolean; reason?: string }> {
  const transport = getTransport();
  if (!transport) {
    // Mailer disabled — fall through silently in prod, log loudly in dev.
    if (env.NODE_ENV === "development") {
      console.warn(`[mailer] disabled (no SMTP_HOST/USER/PASS). Would have sent to ${args.to}: ${args.subject}\n${args.text}`);
    }
    return { ok: false, reason: "mailer_disabled" };
  }
  try {
    await transport.sendMail({
      from: { address: env.MAIL_FROM_ADDRESS!, name: env.MAIL_FROM_NAME },
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
