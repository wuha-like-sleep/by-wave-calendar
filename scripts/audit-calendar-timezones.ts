// 存量日历时区的只读审计：calendars.timezone 在 2026-11 之前只有长度
// 校验（≤100），乱填的字符串能存进去，展开重复事件时静默回退 UTC。
// 写入侧现已加关口（合法 IANA 名 + 归一化，见 lib/timezones.ts 的
// normalizeCalendarTimeZone 与 routes/calendars.ts），但**存量数据没有
// 擅自改** —— 先跑这个脚本看清形状，再由站长定迁移策略。
//
// 本脚本严格只读：只有一条 GROUP BY 查询，没有任何写路径，也没有
// --apply 之类的开关。输出三类：
//   canonical     存的值就是规范名，无需处理；
//   normalizable  合法但不规范（大小写 / 别名 / 前后空白），归一化后的
//                 目标名一并列出 —— 这类改名不改变展开结果（展开前本来
//                 就先 canonical 化），迁移风险最低；
//   invalid       不是合法 IANA 名，这批日历的定时重复事件现在正按
//                 UTC 展开（用户多半不知情），迁移前要逐个定目标时区。
//
// Usage:
//   DATABASE_URL=<redacted> npm run audit:calendar-timezones

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { canonicalTimeZone } from "../src/lib/zoned_time.js";

type Row = { timezone: string; n: number };

const rows = (await db.execute(sql`
  SELECT timezone, COUNT(*)::int AS n FROM calendars GROUP BY timezone ORDER BY n DESC
`)) as unknown as Row[];

let total = 0;
let canonicalCount = 0;
const normalizable: { from: string; to: string; n: number }[] = [];
const invalid: { value: string; n: number }[] = [];

for (const row of rows) {
  total += row.n;
  const exact = canonicalTimeZone(row.timezone);
  if (exact !== null && exact === row.timezone) {
    canonicalCount += row.n;
    continue;
  }
  const normalized = canonicalTimeZone(row.timezone.trim());
  if (normalized !== null) {
    normalizable.push({ from: row.timezone, to: normalized, n: row.n });
  } else {
    invalid.push({ value: row.timezone, n: row.n });
  }
}

console.log(`日历总数 ${total}，不同 timezone 取值 ${rows.length} 个`);
console.log(`  canonical（规范名，无需处理）：${canonicalCount}`);
console.log(`  normalizable（合法但不规范）：${normalizable.reduce((s, r) => s + r.n, 0)}`);
for (const r of normalizable) {
  console.log(`    ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}（${r.n} 个日历）`);
}
console.log(`  invalid（非法，展开时静默回退 UTC）：${invalid.reduce((s, r) => s + r.n, 0)}`);
for (const r of invalid) {
  console.log(`    ${JSON.stringify(r.value)}（${r.n} 个日历）`);
}
console.log("");
console.log("迁移策略建议（仅建议，本脚本不写库）：");
console.log("  1. normalizable 一类可批量归一化：展开口径本来就先 canonical 化，改名不改变任何事件的展开结果。");
console.log("  2. invalid 一类不要批量猜：逐个看日历所有者的常用时区 / 事件分布再定目标值，或先联系用户确认；");
console.log("     在定下来之前，这批日历维持现状（按 UTC 展开）与今天一致，不会因为迁移动作本身再变一次。");
console.log("  3. invalid 一类定下目标时区后不要裸 UPDATE：展开口径会从 UTC 变成目标时区，");
console.log("     已删 occurrence 的 exdates / UNTIL 要按（UTC → 目标时区）这对展开时区重映射，");
console.log("     应复用 PATCH 换时区那条路（resyncRecurringForZoneChange）逐个日历走，不要绕过它。");

process.exit(0);
