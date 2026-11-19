import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { ok, err } from "../lib/api_response.js";
import { importIcsText, previewIcsText } from "../lib/ics_import.js";
import { MAX_ICS_IMPORT_BYTES, MAX_ICS_IMPORT_JSON_BODY_BYTES } from "../lib/ics_limits.js";

// ICS 导入的 API 入口（客户端专用；网页端的四条导入路在 web/index.ts）。
//
// 以前导入只有网页端有：三个 App 的用户在手机上收到一个 .ics 文件，
// 只能转手到电脑上开网页导。这里把同一套导入核心（ics_import.ts 的
// planImport 判定 + 批量 upsert）接到 /api/v1 下，语义和网页导入逐项
// 一致：去重、短 uid 合成、软删不复活、extra 浅合并、计数口径都不变。
//
// 几个口径决定：
//   · sourceTag 和网页文件上传完全同构：`file:<文件名>`，没给文件名时
//     用网页的兜底 `file:upload`。sourceTag 参与 extra 合并、影响
//     「内容有没有变」的判定 —— 同一个文件先在网页导、再在 App 里导
//     （或反过来），第二次必须算重复跳过而不是「更新」，所以这里不能
//     另起一个 `api:` 前缀。
//   · 大小上限和网页文件上传同一个数（MAX_ICS_IMPORT_BYTES），量的是
//     解码后文本的 UTF-8 字节数；路由的 bodyLimit 只是传输护栏，按
//     JSON 转义的最坏情况放宽（见 ics_limits.ts）。
//   · 预览也是写作用域：它读的是导入判定（要看库里已有内容），且没有
//     「只预览不导入」的独立使用场景；只读 Token 的 POST 本来就会被
//     session 层以 token_is_read_only 拒掉，OAuth 则要求 write:events。
//   · URL 导入没有跟进来：客户端的场景是本地文件；服务端代抓 URL 的
//     滥用面（SSRF、防放大）在网页端靠会话 + CSRF + 10/分钟限流压着，
//     API 侧要做得另行设计，fetchIcsUrl 本身是现成的。

const idParam = z.object({ id: z.string().uuid() });

const importBody = z.object({
  text: z.string().min(1),
  filename: z.string().trim().min(1).max(255).optional(),
});

async function ownsCalendar(calendarId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

type PreparedImport = {
  calendarId: string;
  text: string;
  sourceTag: string;
};

/** 两个端点共用的前半段：认证、参数、日历归属、大小与格式校验。
 *  返回 null 表示响应已经发出（沿 requireUserOrSend 的约定）。 */
async function prepareImport(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<PreparedImport | null> {
  const user = await requireUserOrSend(req, reply);
  if (!user) return null;

  const params = idParam.safeParse(req.params);
  if (!params.success) {
    err(req, reply, 404, "calendar_not_found", "日历不存在");
    return null;
  }
  const body = importBody.safeParse(req.body);
  if (!body.success) {
    err(req, reply, 400, "invalid_body", "请求体需要包含 .ics 文本");
    return null;
  }
  if (!(await ownsCalendar(params.data.id, user.id))) {
    err(req, reply, 404, "calendar_not_found", "日历不存在");
    return null;
  }
  const { text, filename } = body.data;
  if (Buffer.byteLength(text, "utf8") > MAX_ICS_IMPORT_BYTES) {
    err(req, reply, 413, "file_too_large", `文件过大（>${MAX_ICS_IMPORT_BYTES / 1024 / 1024} MB）`);
    return null;
  }
  if (!text.toUpperCase().includes("BEGIN:VCALENDAR")) {
    err(req, reply, 400, "not_ics", "内容不是 iCalendar 格式（缺少 BEGIN:VCALENDAR）");
    return null;
  }
  return {
    calendarId: params.data.id,
    text,
    sourceTag: `file:${filename ?? "upload"}`,
  };
}

export async function importRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/calendars/:id/import/preview",
    { config: { oauthScope: "write:events" }, bodyLimit: MAX_ICS_IMPORT_JSON_BODY_BYTES },
    async (req, reply) => {
      const prepared = await prepareImport(req, reply);
      if (!prepared) return reply;
      try {
        const preview = await previewIcsText(prepared.calendarId, prepared.text, {
          sourceTag: prepared.sourceTag,
        });
        return ok(req, reply, preview);
      } catch (e) {
        req.log.warn({ err: e }, "ics_api_preview_failed");
        return err(req, reply, 422, "import_failed", e instanceof Error ? e.message : "导入预览失败");
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/calendars/:id/import",
    { config: { oauthScope: "write:events" }, bodyLimit: MAX_ICS_IMPORT_JSON_BODY_BYTES },
    async (req, reply) => {
      const prepared = await prepareImport(req, reply);
      if (!prepared) return reply;
      try {
        const result = await importIcsText(prepared.calendarId, prepared.text, {
          sourceTag: prepared.sourceTag,
        });
        return ok(req, reply, result);
      } catch (e) {
        req.log.warn({ err: e }, "ics_api_import_failed");
        return err(req, reply, 422, "import_failed", e instanceof Error ? e.message : "导入失败");
      }
    },
  );
}
