import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.js";
import { getSettings } from "./site_settings.js";

let cached: { transport: Transporter; key: string } | null = null;

function settingsKey(s: { smtpHost: string | null; smtpPort: number; smtpSecure: boolean; smtpUser: string | null; smtpPass: string | null }): string {
  return [s.smtpHost, s.smtpPort, s.smtpSecure, s.smtpUser, s.smtpPass].join("|");
}

async function getTransport(): Promise<Transporter | null> {
  const s = await getSettings();
  if (!s.smtpHost || !s.smtpUser || !s.smtpPass || !s.mailFromAddress) return null;
  const key = settingsKey(s);
  if (cached && cached.key === key) return cached.transport;
  // Settings changed — rebuild
  if (cached) cached.transport.close();
  const transport = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    auth: { user: s.smtpUser, pass: s.smtpPass },
    tls: { minVersion: "TLSv1.2" },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  cached = { transport, key };
  return transport;
}

export async function isMailerEnabled(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.smtpHost && s.smtpUser && s.smtpPass && s.mailFromAddress);
}

export type MailAttachment = {
  filename: string;
  content: string | Buffer;
  contentType?: string;
};

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
  // For iCalendar invitation emails: nodemailer's `icalEvent` produces both an
  // attachment and a text/calendar alternate body so Gmail/Outlook show the
  // "Add to calendar" prompt natively.
  icalEvent?: { method: "REQUEST" | "CANCEL" | "PUBLISH"; content: string };
};

export async function sendMail(args: SendArgs): Promise<{ ok: boolean; reason?: string }> {
  const transport = await getTransport();
  const s = await getSettings();
  if (!transport || !s.mailFromAddress) {
    if (env.NODE_ENV === "development") {
      console.warn(`[mailer] disabled (no SMTP in DB/env). Would have sent to ${args.to}: ${args.subject}\n${args.text}`);
    }
    return { ok: false, reason: "mailer_disabled" };
  }
  try {
    await transport.sendMail({
      from: { address: s.mailFromAddress, name: s.mailFromName },
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      ...(args.icalEvent ? {
        icalEvent: {
          method: args.icalEvent.method,
          filename: "invite.ics",
          content: args.icalEvent.content,
        },
      } : {}),
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
