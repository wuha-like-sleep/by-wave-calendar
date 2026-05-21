import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type GenerateAuthenticationOptionsOpts,
} from "@simplewebauthn/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { env } from "../env.js";

const url = new URL(env.PUBLIC_BASE_URL);
export const rpID = url.hostname;
export const rpOrigin = `${url.protocol}//${url.host}`;
export const rpName = "by-wave 日历";

const CHALLENGE_COOKIE = "bwc_wa_chal";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type ChallengePayload = {
  challenge: string;
  intent: "register" | "authenticate";
  userId?: string;
  exp: number;
};

function sign(value: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(value).digest("base64url");
}

function pack(payload: ChallengePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function unpack(raw: string | undefined): ChallengePayload | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (sign(body) !== mac) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChallengePayload;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeChallenge(reply: FastifyReply, payload: Omit<ChallengePayload, "exp">) {
  const value = pack({ ...payload, exp: Date.now() + CHALLENGE_TTL_MS });
  reply.setCookie(CHALLENGE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

export function consumeChallenge(req: FastifyRequest, reply: FastifyReply): ChallengePayload | null {
  const cookie = req.cookies[CHALLENGE_COOKIE];
  reply.clearCookie(CHALLENGE_COOKIE, { path: "/" });
  return unpack(cookie);
}

export async function buildRegistrationOptions(
  user: { id: string; email: string; displayName?: string | null },
  existingCredentialIds: string[],
): Promise<{ options: Awaited<ReturnType<typeof generateRegistrationOptions>>; challenge: string }> {
  const opts: GenerateRegistrationOptionsOpts = {
    rpName,
    rpID,
    userID: Buffer.from(user.id, "utf8"),
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    timeout: 60_000,
    attestationType: "none",
    excludeCredentials: existingCredentialIds.map((id) => ({ id, type: "public-key" as const })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257],
  };
  const options = await generateRegistrationOptions(opts);
  return { options, challenge: options.challenge };
}

export async function verifyRegistration(
  attestationResponse: Parameters<typeof verifyRegistrationResponse>[0]["response"],
  expectedChallenge: string,
) {
  return verifyRegistrationResponse({
    response: attestationResponse,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(
  allowCredentialIds: string[],
): Promise<{ options: Awaited<ReturnType<typeof generateAuthenticationOptions>>; challenge: string }> {
  const opts: GenerateAuthenticationOptionsOpts = {
    rpID,
    timeout: 60_000,
    userVerification: "preferred",
    allowCredentials:
      allowCredentialIds.length > 0
        ? allowCredentialIds.map((id) => ({ id, type: "public-key" as const }))
        : [],
  };
  const options = await generateAuthenticationOptions(opts);
  return { options, challenge: options.challenge };
}

export async function verifyAuthentication(
  authResponse: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
  expectedChallenge: string,
  credential: { id: string; publicKey: Uint8Array; counter: number; transports?: AuthenticatorTransportFuture[] },
) {
  return verifyAuthenticationResponse({
    response: authResponse,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpID,
    credential: credential as Parameters<typeof verifyAuthenticationResponse>[0]["credential"],
    requireUserVerification: false,
  });
}

export type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export function newDeviceName(): string {
  return `Passkey ${randomBytes(2).toString("hex")}`;
}
