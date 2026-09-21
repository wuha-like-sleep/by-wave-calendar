import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 守「Depth:0 的例行轮询不许把整个日历的事件捞出来」。
//
// CalDAV 客户端平时干的事就是不停地发 PROPFIND Depth:0，只问一个 ctag：
// 「这个日历变了吗」。真正要列事件清单的 Depth:1 很少发。
//
// 以前 propfindCalendar 在函数开头就 `await loadAllEventsOf(cal.id)`，
// 而那批行只在 `depth !== "0"` 的分支里用得到 —— 于是每台设备、每一轮轮询，
// 都会把整个日历的全部事件行（`select()` 全列，含 raw_ics）捞进内存再扔掉。
// 3000 条事件的日历实测 25 ms/次。设备多、日历大的站点，这是常态开销的大头，
// 而且它不报错、不超时，只是服务器一直比应该的慢。
//
// ctag 本身不需要这些行：calendarCtags 走的是 max(updated_at) + count 的聚合查询。
//
// 判据是位置关系，不是「有没有调用」—— 调用当然还在，问题是它在哪一层。

const SRC = readFileSync(path.resolve("src/web/caldav.ts"), "utf8");

/** 截出 propfindCalendar 的函数体（从签名到下一个顶格 `async function` / `function`）。 */
function propfindCalendarBody(): string {
  const start = SRC.indexOf("async function propfindCalendar(");
  expect(start, "找不到 propfindCalendar —— 改名了？这条断言要跟着改").toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("CalDAV 例行轮询的开销", () => {
  const body = propfindCalendarBody();

  it("propfindCalendar 里确实有一次 loadAllEventsOf（presence）", () => {
    // 少了这条，下面那条在「调用被整个删掉」时会因为找不到而恒成立 ——
    // 而那种情况下 Depth:1 会返回一个空清单，客户端会把事件全删了。
    expect(
      (body.match(/loadAllEventsOf\(/g) ?? []).length,
      "propfindCalendar 里没有 loadAllEventsOf 了 —— Depth:1 会列出一个空日历",
    ).toBe(1);
  });

  it("它排在 depth !== \"0\" 的判断之后", () => {
    const loadAt = body.indexOf("loadAllEventsOf(");
    const branchAt = body.indexOf('if (depth !== "0")');
    expect(branchAt, '找不到 depth !== "0" 这个分支 —— 结构变了，这条断言要跟着改').toBeGreaterThan(-1);
    expect(
      loadAt,
      "事件加载排在 depth 判断之前 —— 每台设备每一轮 Depth:0 轮询都会把整个日历" +
        "的全部行（含 raw_ics）捞进内存再扔掉。ctag 走的是聚合查询，用不着它们。",
    ).toBeGreaterThan(branchAt);
  });

  it("ctag 仍然走聚合查询，没有改成从加载出来的行里现算", () => {
    // 如果哪天有人把 ctag 改成「从 events 数组里算 max」，上面那条会被迫失效
    // （加载又得提到前面去），而这条会先红，把人拦在那一步。
    const ctagFn = SRC.slice(SRC.indexOf("async function calendarCtags("));
    const head = ctagFn.slice(0, ctagFn.indexOf("\n}"));
    expect(
      /max\(/.test(head) && /count\(/.test(head),
      "calendarCtags 不再是聚合查询了 —— 它一旦改成遍历行，Depth:0 的开销会回来",
    ).toBe(true);
  });
});
