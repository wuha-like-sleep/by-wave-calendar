// 购买清单 JSON API（/api 与 /api/v1 双挂，与其它路由同口径）。
//
// 鉴权走 requireUserOrSend：网页会话、设备 Token、个人 API Token 都可用。
// 两道既有闸门在这里自动生效，不用本文件再写一遍：
//   - 只读个人 Token 的写请求在 session.ts 里就被 403 token_is_read_only
//     拒掉（判断放在认出 scope 的那一行旁，见那边的注释）；
//   - 按 Token 限流也在同一处。IP 维度的全局限流在 server.ts。
// OAuth 第三方 Token 一律 deny：现有 scope 只有 read/write:events 与
// read:profile，没有一个是给购买清单的 —— 授了「读日历」的第三方不该
// 顺带把用户的购物清单也读走。等真有需求再单开 scope，不先放行。
//
// 权限：lib/shopping_lists.ts 的每个函数都按 owner 隔离，查不到与不是
// 你的都返回 null，这里统一 404，不泄露清单是否存在。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { err, ok, okList } from "../lib/api_response.js";
import { requireUserOrSend } from "../lib/session.js";
import {
  SHOPPING_ITEM_NAME_MAX,
  SHOPPING_ITEM_NOTE_MAX,
  SHOPPING_ITEM_UNIT_MAX,
  SHOPPING_LIST_TITLE_MAX,
  createShoppingList,
  createShoppingListItem,
  deleteShoppingList,
  deleteShoppingListItem,
  getShoppingList,
  getShoppingListDetail,
  listShoppingLists,
  moveShoppingListItem,
  updateShoppingList,
  updateShoppingListItem,
  type ShoppingListWithCounts,
} from "../lib/shopping_lists.js";
import type { ShoppingList, ShoppingListItem } from "../db/schema.js";

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

const idParam = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

const titleField = z.string().trim().min(1).max(SHOPPING_LIST_TITLE_MAX);
const eventIdField = z.string().uuid().nullable().optional();

const createListSchema = z.object({ title: titleField, eventId: eventIdField });
const updateListSchema = z.object({ title: titleField.optional(), eventId: eventIdField });

// quantity：JSON 客户端发数字、表单型客户端可能发字符串，coerce 统一。
// 上限与 numeric(12,3) 对齐；落库前四舍五入到 3 位小数再转字符串 ——
// numeric 列回读本来就是字符串，API 输出时再转回 number 给客户端。
const quantityField = z.coerce
  .number()
  .positive()
  .max(999_999_999.999)
  .nullable()
  .optional();
const blankToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v));

const createItemSchema = z.object({
  name: z.string().trim().min(1).max(SHOPPING_ITEM_NAME_MAX),
  quantity: quantityField,
  unit: blankToNull(SHOPPING_ITEM_UNIT_MAX),
  note: blankToNull(SHOPPING_ITEM_NOTE_MAX),
});
const updateItemSchema = z.object({
  name: z.string().trim().min(1).max(SHOPPING_ITEM_NAME_MAX).optional(),
  quantity: quantityField,
  unit: blankToNull(SHOPPING_ITEM_UNIT_MAX),
  note: blankToNull(SHOPPING_ITEM_NOTE_MAX),
  done: z.boolean().optional(),
});
const moveSchema = z.object({ direction: z.enum(["up", "down"]) });

function quantityOut(q: string | null): number | null {
  if (q === null) return null;
  const n = Number(q);
  return Number.isFinite(n) ? n : null;
}
function quantityIn(q: number | null | undefined): string | null | undefined {
  if (q === undefined) return undefined;
  if (q === null) return null;
  return String(Math.round(q * 1000) / 1000);
}

function listView(l: ShoppingListWithCounts) {
  return {
    id: l.id,
    title: l.title,
    eventId: l.eventId,
    eventSummary: l.eventSummary,
    totalCount: l.totalCount,
    doneCount: l.doneCount,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

function itemView(i: ShoppingListItem) {
  return {
    id: i.id,
    listId: i.listId,
    name: i.name,
    quantity: quantityOut(i.quantity),
    unit: i.unit,
    note: i.note,
    done: i.done,
    position: i.position,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

/** 详情页里 list 字段与列表页同形状（带计数），不让客户端拼两次。 */
async function detailView(ownerId: string, list: ShoppingList) {
  const all = await listShoppingLists(ownerId);
  const withCounts = all.find((l) => l.id === list.id);
  return withCounts ? listView(withCounts) : { ...list, eventSummary: null, totalCount: 0, doneCount: 0 };
}

const DENY = { config: { oauthScope: "deny" as const } };

export async function shoppingListRoutes(app: FastifyInstance) {
  app.get("/shopping-lists", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const query = z.object({ eventId: z.string().uuid().optional() }).safeParse(req.query);
    if (!query.success) return err(req, reply, 400, "invalid_query", zodMessage(query.error));
    const rows = await listShoppingLists(user.id, { eventId: query.data.eventId });
    return okList(req, reply, rows.map(listView));
  });

  app.post("/shopping-lists", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = createListSchema.safeParse(req.body);
    if (!body.success) return err(req, reply, 400, "invalid_body", zodMessage(body.error));
    const result = await createShoppingList(user.id, { title: body.data.title, eventId: body.data.eventId ?? null });
    if (!result.ok) {
      if (result.error === "event_not_found") return err(req, reply, 400, "event_not_found", "关联的事件不存在");
      return err(req, reply, 409, "list_limit_reached", "清单数量已达上限");
    }
    reply.code(201);
    return ok(req, reply, await detailView(user.id, result.value));
  });

  app.get<{ Params: { id: string } }>("/shopping-lists/:id", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = idParam.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const detail = await getShoppingListDetail(user.id, params.data.id);
    if (!detail) return err(req, reply, 404, "not_found", "清单不存在");
    return ok(req, reply, {
      list: await detailView(user.id, detail.list),
      items: detail.items.map(itemView),
    });
  });

  app.patch<{ Params: { id: string } }>("/shopping-lists/:id", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = idParam.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const body = updateListSchema.safeParse(req.body);
    if (!body.success) return err(req, reply, 400, "invalid_body", zodMessage(body.error));
    const result = await updateShoppingList(user.id, params.data.id, {
      title: body.data.title,
      eventId: body.data.eventId,
    });
    if (!result.ok) return err(req, reply, 400, "event_not_found", "关联的事件不存在");
    if (!result.value) return err(req, reply, 404, "not_found", "清单不存在");
    return ok(req, reply, await detailView(user.id, result.value));
  });

  app.delete<{ Params: { id: string } }>("/shopping-lists/:id", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = idParam.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const removed = await deleteShoppingList(user.id, params.data.id);
    if (!removed) return err(req, reply, 404, "not_found", "清单不存在");
    return ok(req, reply, { ok: true });
  });

  app.post<{ Params: { id: string } }>("/shopping-lists/:id/items", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = idParam.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const body = createItemSchema.safeParse(req.body);
    if (!body.success) return err(req, reply, 400, "invalid_body", zodMessage(body.error));
    const result = await createShoppingListItem(user.id, params.data.id, {
      name: body.data.name,
      quantity: quantityIn(body.data.quantity),
      unit: body.data.unit,
      note: body.data.note,
    });
    if (!result.ok) return err(req, reply, 409, "item_limit_reached", "清单条目已达上限");
    if (!result.value) return err(req, reply, 404, "not_found", "清单不存在");
    reply.code(201);
    return ok(req, reply, itemView(result.value));
  });

  app.patch<{ Params: { id: string; itemId: string } }>("/shopping-lists/:id/items/:itemId", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = itemParams.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const body = updateItemSchema.safeParse(req.body);
    if (!body.success) return err(req, reply, 400, "invalid_body", zodMessage(body.error));
    const row = await updateShoppingListItem(user.id, params.data.id, params.data.itemId, {
      name: body.data.name,
      quantity: quantityIn(body.data.quantity),
      unit: body.data.unit,
      note: body.data.note,
      done: body.data.done,
    });
    if (!row) return err(req, reply, 404, "not_found", "条目不存在");
    return ok(req, reply, itemView(row));
  });

  app.delete<{ Params: { id: string; itemId: string } }>("/shopping-lists/:id/items/:itemId", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = itemParams.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    // 先分清「清单不是你的」与「条目不存在」没有意义 —— 都是 404，
    // 但清单不存在时 lib 返回 false，这里同样落到条目 404，形状一致。
    const list = await getShoppingList(user.id, params.data.id);
    if (!list) return err(req, reply, 404, "not_found", "清单不存在");
    const removed = await deleteShoppingListItem(user.id, params.data.id, params.data.itemId);
    if (!removed) return err(req, reply, 404, "not_found", "条目不存在");
    return ok(req, reply, { ok: true });
  });

  app.post<{ Params: { id: string; itemId: string } }>("/shopping-lists/:id/items/:itemId/move", DENY, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const params = itemParams.safeParse(req.params);
    if (!params.success) return err(req, reply, 404, "not_found", "清单不存在");
    const body = moveSchema.safeParse(req.body);
    if (!body.success) return err(req, reply, 400, "invalid_body", zodMessage(body.error));
    const row = await moveShoppingListItem(user.id, params.data.id, params.data.itemId, body.data.direction);
    if (!row) return err(req, reply, 404, "not_found", "条目不存在");
    return ok(req, reply, itemView(row));
  });
}
