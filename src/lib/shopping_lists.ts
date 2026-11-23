// 购买清单的全部数据操作（迁移 0071 的两张表）。
//
// 权限模型只有一条：owner_id 是唯一边界。每个函数都把 ownerId 当必填
// 参数、每条查询都带上它 —— 调用方（JSON 路由 / 网页表单）不可能写出
// 「先按 id 查出来再比对 owner」的两段式代码，也就没有忘了比对的可能。
// 查不到与不是你的，在这一层返回同一个 null，路由一律回 404。
//
// 事件关联：event_id 指向 events 行。校验关联时要求事件属于 owner 的
// 日历且未软删 —— 关联一个已经删掉的事件，UI 上就是个点不开的死链。
// 事件行被物理清除时外键 SET NULL，清单保留、关联自动解除（见迁移）。
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export const SHOPPING_LIST_TITLE_MAX = 120;
export const SHOPPING_ITEM_NAME_MAX = 200;
export const SHOPPING_ITEM_UNIT_MAX = 20;
export const SHOPPING_ITEM_NOTE_MAX = 500;
/** 防滥用上限：个人清单功能，200 张 / 每张 1000 条远超日常用量，
 *  挡住的是失控脚本和误把接口当存储用的调用。 */
export const SHOPPING_LIST_MAX_PER_USER = 200;
export const SHOPPING_ITEM_MAX_PER_LIST = 1000;

const POSITION_STEP = 1024;

export type ShoppingListWithCounts = schema.ShoppingList & {
  totalCount: number;
  doneCount: number;
  /** 关联事件的标题；未关联、或事件已软删/已清除时为 null。 */
  eventSummary: string | null;
};

export type ShoppingListError = "event_not_found" | "list_limit_reached" | "item_limit_reached";
export type Result<T> = { ok: true; value: T } | { ok: false; error: ShoppingListError };

/** 事件必须属于 owner 的日历且未软删，才允许被关联。 */
async function findOwnEvent(ownerId: string, eventId: string) {
  const [row] = await db
    .select({ id: schema.events.id, summary: schema.events.summary })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.events.calendarId, schema.calendars.id))
    .where(and(
      eq(schema.events.id, eventId),
      eq(schema.calendars.ownerId, ownerId),
      isNull(schema.events.deletedAt),
    ))
    .limit(1);
  return row ?? null;
}

/** 关联事件的展示标题。软删后事件页已不存在，按未关联渲染（行还在，
 *  event_id 要等物理清除才置空，展示层不能跟着它一起装作还点得开）。 */
async function eventSummaryFor(eventId: string | null): Promise<string | null> {
  if (!eventId) return null;
  const [row] = await db
    .select({ summary: schema.events.summary })
    .from(schema.events)
    .where(and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)))
    .limit(1);
  return row?.summary ?? null;
}

async function countsForLists(listIds: string[]): Promise<Map<string, { total: number; done: number }>> {
  const out = new Map<string, { total: number; done: number }>();
  if (listIds.length === 0) return out;
  const rows = await db
    .select({
      listId: schema.shoppingListItems.listId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`coalesce(sum(case when ${schema.shoppingListItems.done} then 1 else 0 end), 0)::int`,
    })
    .from(schema.shoppingListItems)
    .where(inArray(schema.shoppingListItems.listId, listIds))
    .groupBy(schema.shoppingListItems.listId);
  for (const r of rows) out.set(r.listId, { total: r.total, done: r.done });
  return out;
}

export async function listShoppingLists(
  ownerId: string,
  opts: { eventId?: string } = {},
): Promise<ShoppingListWithCounts[]> {
  const where = opts.eventId
    ? and(eq(schema.shoppingLists.ownerId, ownerId), eq(schema.shoppingLists.eventId, opts.eventId))
    : eq(schema.shoppingLists.ownerId, ownerId);
  const rows = await db
    .select()
    .from(schema.shoppingLists)
    .where(where)
    .orderBy(sql`${schema.shoppingLists.updatedAt} desc`);
  const counts = await countsForLists(rows.map((r) => r.id));
  const out: ShoppingListWithCounts[] = [];
  for (const r of rows) {
    const c = counts.get(r.id) ?? { total: 0, done: 0 };
    out.push({ ...r, totalCount: c.total, doneCount: c.done, eventSummary: await eventSummaryFor(r.eventId) });
  }
  return out;
}

export async function getShoppingList(ownerId: string, id: string): Promise<schema.ShoppingList | null> {
  const [row] = await db
    .select()
    .from(schema.shoppingLists)
    .where(and(eq(schema.shoppingLists.id, id), eq(schema.shoppingLists.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function getShoppingListDetail(
  ownerId: string,
  id: string,
): Promise<{ list: schema.ShoppingList; items: schema.ShoppingListItem[]; eventSummary: string | null } | null> {
  const list = await getShoppingList(ownerId, id);
  if (!list) return null;
  const items = await db
    .select()
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.listId, id))
    .orderBy(asc(schema.shoppingListItems.position), asc(schema.shoppingListItems.createdAt));
  return { list, items, eventSummary: await eventSummaryFor(list.eventId) };
}

export async function createShoppingList(
  ownerId: string,
  input: { title: string; eventId?: string | null },
): Promise<Result<schema.ShoppingList>> {
  if (input.eventId) {
    const ev = await findOwnEvent(ownerId, input.eventId);
    if (!ev) return { ok: false, error: "event_not_found" };
  }
  const [cnt] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.shoppingLists)
    .where(eq(schema.shoppingLists.ownerId, ownerId));
  if ((cnt?.c ?? 0) >= SHOPPING_LIST_MAX_PER_USER) return { ok: false, error: "list_limit_reached" };
  const [row] = await db
    .insert(schema.shoppingLists)
    .values({ ownerId, title: input.title, eventId: input.eventId ?? null })
    .returning();
  return { ok: true, value: row! };
}

/** title / eventId 任一缺省 = 不动那一列；eventId 显式传 null = 解除关联。 */
export async function updateShoppingList(
  ownerId: string,
  id: string,
  patch: { title?: string; eventId?: string | null },
): Promise<Result<schema.ShoppingList | null>> {
  const existing = await getShoppingList(ownerId, id);
  if (!existing) return { ok: true, value: null };
  if (patch.eventId) {
    const ev = await findOwnEvent(ownerId, patch.eventId);
    if (!ev) return { ok: false, error: "event_not_found" };
  }
  const set: Partial<schema.NewShoppingList> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.eventId !== undefined) set.eventId = patch.eventId;
  const [row] = await db
    .update(schema.shoppingLists)
    .set(set)
    .where(and(eq(schema.shoppingLists.id, id), eq(schema.shoppingLists.ownerId, ownerId)))
    .returning();
  return { ok: true, value: row ?? null };
}

export async function deleteShoppingList(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.shoppingLists)
    .where(and(eq(schema.shoppingLists.id, id), eq(schema.shoppingLists.ownerId, ownerId)))
    .returning({ id: schema.shoppingLists.id });
  return rows.length > 0;
}

// ---------------- items ----------------

async function touchList(ownerId: string, listId: string): Promise<void> {
  await db
    .update(schema.shoppingLists)
    .set({ updatedAt: new Date() })
    .where(and(eq(schema.shoppingLists.id, listId), eq(schema.shoppingLists.ownerId, ownerId)));
}

export async function createShoppingListItem(
  ownerId: string,
  listId: string,
  input: { name: string; quantity?: string | null; unit?: string | null; note?: string | null },
): Promise<Result<schema.ShoppingListItem | null>> {
  const list = await getShoppingList(ownerId, listId);
  if (!list) return { ok: true, value: null };
  const [cnt] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.listId, listId));
  if ((cnt?.c ?? 0) >= SHOPPING_ITEM_MAX_PER_LIST) return { ok: false, error: "item_limit_reached" };
  const [mx] = await db
    .select({ m: sql<number>`coalesce(max(${schema.shoppingListItems.position}), 0)::int` })
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.listId, listId));
  const [row] = await db
    .insert(schema.shoppingListItems)
    .values({
      listId,
      name: input.name,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      note: input.note ?? null,
      position: (mx?.m ?? 0) + POSITION_STEP,
    })
    .returning();
  await touchList(ownerId, listId);
  return { ok: true, value: row! };
}

export async function updateShoppingListItem(
  ownerId: string,
  listId: string,
  itemId: string,
  patch: { name?: string; quantity?: string | null; unit?: string | null; note?: string | null; done?: boolean },
): Promise<schema.ShoppingListItem | null> {
  const list = await getShoppingList(ownerId, listId);
  if (!list) return null;
  const set: Partial<schema.NewShoppingListItem> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.quantity !== undefined) set.quantity = patch.quantity;
  if (patch.unit !== undefined) set.unit = patch.unit;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.done !== undefined) set.done = patch.done;
  const [row] = await db
    .update(schema.shoppingListItems)
    .set(set)
    .where(and(eq(schema.shoppingListItems.id, itemId), eq(schema.shoppingListItems.listId, listId)))
    .returning();
  if (row) await touchList(ownerId, listId);
  return row ?? null;
}

export async function deleteShoppingListItem(
  ownerId: string,
  listId: string,
  itemId: string,
): Promise<boolean> {
  const list = await getShoppingList(ownerId, listId);
  if (!list) return false;
  const rows = await db
    .delete(schema.shoppingListItems)
    .where(and(eq(schema.shoppingListItems.id, itemId), eq(schema.shoppingListItems.listId, listId)))
    .returning({ id: schema.shoppingListItems.id });
  if (rows.length > 0) await touchList(ownerId, listId);
  return rows.length > 0;
}

/** 把条目与相邻条目交换位置。只改这两行的 position；两者撞位（历史脏数据）
 *  时先把整张清单按 1024 步长重排再交换。已在端点上时返回原行（无操作）。 */
export async function moveShoppingListItem(
  ownerId: string,
  listId: string,
  itemId: string,
  direction: "up" | "down",
): Promise<schema.ShoppingListItem | null> {
  const detail = await getShoppingListDetail(ownerId, listId);
  if (!detail) return null;
  const items = detail.items;
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx < 0) return null;
  const item = items[idx]!;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= items.length) return item;
  let neighbor = items[swapIdx]!;
  if (neighbor.position === item.position) {
    // 撞位：整体重排后重新取邻居。
    await db.transaction(async (tx) => {
      for (let i = 0; i < items.length; i++) {
        await tx
          .update(schema.shoppingListItems)
          .set({ position: (i + 1) * POSITION_STEP })
          .where(eq(schema.shoppingListItems.id, items[i]!.id));
      }
    });
    const fresh = await getShoppingListDetail(ownerId, listId);
    if (!fresh) return null;
    const fIdx = fresh.items.findIndex((i) => i.id === itemId);
    const fSwap = direction === "up" ? fIdx - 1 : fIdx + 1;
    if (fIdx < 0 || fSwap < 0 || fSwap >= fresh.items.length) return fresh.items[fIdx] ?? null;
    return swapPositions(ownerId, listId, fresh.items[fIdx]!, fresh.items[fSwap]!);
  }
  return swapPositions(ownerId, listId, item, neighbor);
}

async function swapPositions(
  ownerId: string,
  listId: string,
  item: schema.ShoppingListItem,
  neighbor: schema.ShoppingListItem,
): Promise<schema.ShoppingListItem> {
  let updated = item;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.shoppingListItems)
      .set({ position: neighbor.position, updatedAt: new Date() })
      .where(eq(schema.shoppingListItems.id, item.id))
      .returning();
    await tx
      .update(schema.shoppingListItems)
      .set({ position: item.position, updatedAt: new Date() })
      .where(eq(schema.shoppingListItems.id, neighbor.id));
    if (row) updated = row;
  });
  await touchList(ownerId, listId);
  return updated;
}
