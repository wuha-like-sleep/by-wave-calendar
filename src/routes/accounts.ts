import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { ok, err } from "../lib/api_response.js";
import { verifyServiceClient, provisionAccountByEmail, type ServiceClientAuth } from "../lib/external_idp.js";
import { likeNeedle } from "../lib/search_query.js";
import { getSettings } from "../lib/site_settings.js";
import { audit } from "../lib/audit.js";

// Platform account-management endpoints for a TRUSTED integration (e.g. a
// meeting platform) to sync its user roster + bulk-provision ByWave accounts,
// instead of relying on lazy per-request auto-provisioning.
//
// Auth: a Keycloak SERVICE-client token only (no X-Account, no user). Ordinary
// user tokens are rejected by verifyServiceClient — a regular user must never
// be able to list or create accounts.
async function requireServiceClient(req: FastifyRequest, reply: FastifyReply): Promise<ServiceClientAuth | null> {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) {
    err(req, reply, 401, "missing_bearer", "需要 Bearer 令牌");
    return null;
  }
  const r = await verifyServiceClient(header.slice(7).trim());
  if (!r.ok) {
    err(req, reply, r.code, r.error, "服务端令牌校验失败");
    return null;
  }
  return r.auth;
}

export async function accountRoutes(app: FastifyInstance) {
  // List accounts (paginated, optional ?q= email/name filter).
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>("/accounts", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const auth = await requireServiceClient(req, reply);
    if (!auth) return;
    const qp = z.object({
      q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const where = qp.q
      ? or(ilike(schema.users.email, likeNeedle(qp.q)), ilike(schema.users.displayName, likeNeedle(qp.q)))
      : undefined;
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        disabledAt: schema.users.disabledAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(where)
      .orderBy(asc(schema.users.email))
      .limit(qp.limit)
      .offset(qp.offset);
    const [cnt] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.users).where(where);
    req.log.info({ idpServiceClient: auth.client, count: rows.length }, "idp_service_accounts_list");
    return ok(
      req, reply,
      {
        accounts: rows.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          disabled: Boolean(u.disabledAt),
          createdAt: u.createdAt.toISOString(),
        })),
      },
      { total: cnt?.c ?? 0, limit: qp.limit, offset: qp.offset },
    );
  });

  // Provision (idempotent) an account by email. Gated by the same
  // 「自动开通账号」toggle as lazy provisioning. Re-requesting an existing email
  // returns it with created:false.
  app.post("/accounts", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const auth = await requireServiceClient(req, reply);
    if (!auth) return;
    const settings = await getSettings();
    if (!settings.idpApiAutoProvision) {
      return err(req, reply, 403, "provisioning_disabled", "后台未开启「自动开通账号」");
    }
    const body = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
      displayName: z.string().max(100).optional(),
    }).parse(req.body);
    const r = await provisionAccountByEmail(body.email, body.displayName ?? null);
    if (!r.user) return err(req, reply, 500, "provision_failed", "开通失败");
    if (r.created) {
      void audit(req, r.user.id, "idp.account_provisioned", {
        targetType: "user", targetId: r.user.id,
        details: { client: auth.client, email: r.user.email, via: "api" },
      }).catch(() => undefined);
    }
    return ok(req, reply, { id: r.user.id, email: r.user.email, displayName: r.user.displayName, created: r.created });
  });
}
