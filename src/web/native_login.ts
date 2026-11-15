import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { initBrowserPairing, PKCE_CHALLENGE } from "../lib/devices.js";
import { tForRequest } from "../lib/i18n.js";
import { rememberReturnTo } from "../lib/return_to.js";
import { destroySession, loadFullSession } from "../lib/session.js";
import { getSettings } from "../lib/site_settings.js";
import { clearThemeCookies } from "../lib/user_theme.js";

const tr = (req: FastifyRequest, key: string) => tForRequest(req)(key);

const requestSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
  scheme: z.enum(["bywave", "bywave-staging"]).default("bywave"),
  code_challenge: z.string().regex(PKCE_CHALLENGE),
  code_challenge_method: z.literal("S256"),
});
type NativeRequest = z.infer<typeof requestSchema>;
type LoginUser = { id: string; email: string; displayName: string | null };

function returnPath(request: NativeRequest): string {
  return `/app/auth/native?${new URLSearchParams(request).toString()}`;
}
function callback(request: NativeRequest, result: Record<string, string>): string {
  return `${request.scheme}://auth/complete?${new URLSearchParams({ ...result, state: request.state })}`;
}
function noCache(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
}
function errorPage(req: FastifyRequest, reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).view("error", {
    title: tr(req, "nativeLogin.title"), user: null, bareLayout: true,
    csrfToken: csrfTokenFor(req), flash: {}, statusCode,
    heading: tr(req, "nativeLogin.title"), message,
  });
}

export function registerNativeLoginRoutes(app: FastifyInstance,
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<LoginUser | null>) {
  app.get("/app/auth/native", async (req, reply) => {
    noCache(reply);
    const parsed = requestSchema.safeParse(req.query);
    if (!parsed.success) return errorPage(req, reply, 400, tr(req, "nativeLogin.upgrade"));
    if (!(await getSettings()).appsEnabled) return errorPage(req, reply, 403, tr(req, "errorPage.appsDisabled.message"));
    const user = await requireUser(req, reply);
    if (!user) return reply;
    return reply.view("auth/native-login", {
      title: tr(req, "nativeLogin.title"), user, bareLayout: true,
      csrfToken: csrfTokenFor(req), flash: {}, request: parsed.data,
      cancelUrl: callback(parsed.data, { error: "access_denied" }),
    });
  });

  async function finishLogin(req: FastifyRequest, reply: FastifyReply, action: "complete" | "switch-account") {
    noCache(reply);
    const parsed = requestSchema.extend({ accountId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return errorPage(req, reply, 400, tr(req, "nativeLogin.upgrade"));
    const request = requestSchema.parse(parsed.data);
    const back = returnPath(request);
    const session = await loadFullSession(req);
    // Re-open the GET entry so every login method retains the exact request,
    // including after expiry, an MFA prompt, or a change of browser account.
    if (!session || session.user.id !== parsed.data.accountId) {
      return reply.code(303).redirect(back);
    }
    if (!(await getSettings()).appsEnabled) return errorPage(req, reply, 403, tr(req, "errorPage.appsDisabled.message"));
    if (action === "switch-account") {
      await destroySession(req, reply);
      clearThemeCookies(reply);
      rememberReturnTo(reply, back);
      return reply.code(303).redirect("/login");
    }
    const { code } = await initBrowserPairing(session.user.id, request.code_challenge);
    return reply.code(303).redirect(callback(request, { code }));
  }
  app.post("/app/auth/native/complete", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    noCache(reply);
    if (!verifyCsrf(req, reply)) return reply;
    return finishLogin(req, reply, "complete");
  });
  app.post("/app/auth/native/switch-account", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    noCache(reply);
    if (!verifyCsrf(req, reply)) return reply;
    return finishLogin(req, reply, "switch-account");
  });
}
