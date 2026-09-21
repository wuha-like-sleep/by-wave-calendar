import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// 守「calendar-query 按客户端要的字段返回，别无条件塞整条正文」。
//
// CalDAV 客户端省流量的标准做法是两步：先发一个只要 <getetag/> 的 REPORT
// 列一遍清单，比对出哪几条变了，再用 calendar-multiget 只取那几条正文。
// 以前这里不看客户端要什么，一律把整条 VCALENDAR 塞进每一条 response，
// 于是第一步就把第二步的收益全吃掉了。
//
// 实测（3000 条带描述和地点的事件）：一次只要 etag 的 REPORT 要回 3.1 MB、
// 服务端单线程序列化 260 ms。这笔钱平时每轮轮询都在付，而升级当天所有设备
// 同时来这一下，就是几十秒的事件循环阻塞。
//
// 这一档是纯逻辑的：只打 wantsCalendarData 这个判据本身。
// 「组装 response 时真的用了它」由下面那条源码断言守着 —— 两条缺一不可，
// 只有前者的话，把调用点删掉它照样全绿。

// wantsCalendarData 没有导出（它是这个模块的内部判据），所以从源码里把它取出来
// 在本进程里求值。比手抄一份强：手抄的那份改了源码不会红。
function loadPredicate(): (body: string) => boolean {
  const src = readFileSync(path.resolve("src/web/caldav.ts"), "utf8");
  const m = src.match(/function wantsCalendarData\(body: string\): boolean \{[\s\S]*?\n\}/);
  if (!m) throw new Error("在 caldav.ts 里找不到 wantsCalendarData —— 改名了？这条断言要跟着改");
  const js = m[0].replace(/: string/g, "").replace(/: boolean/g, "");
  // eslint-disable-next-line no-new-func
  return new Function(`${js}; return wantsCalendarData;`)() as (body: string) => boolean;
}

const wantsCalendarData = loadPredicate();

const ONLY_ETAG = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>
</C:calendar-query>`;

const ETAG_AND_DATA = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>
</C:calendar-query>`;

/** prop-filter 出现在 filter 里，不能被当成 <prop>。 */
const ONLY_ETAG_WITH_PROP_FILTER = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:prop-filter name="UID"><C:text-match>abc</C:text-match></C:prop-filter>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;

describe("calendar-query 只给客户端要的字段", () => {
  it("只要 getetag 时不给正文", () => {
    expect(
      wantsCalendarData(ONLY_ETAG),
      "客户端只要 etag，却仍然要返回整条正文 —— 它「先列清单再取变更」的省流量路径就白走了",
    ).toBe(false);
  });

  it("要了 calendar-data 就给正文", () => {
    // presence 侧：少了它，把判据写成「永远 false」也能让上一条绿，
    // 而那样所有客户端都再也拿不到事件正文。
    expect(
      wantsCalendarData(ETAG_AND_DATA),
      "客户端明确要了 calendar-data 却不给 —— 日历会是空的",
    ).toBe(true);
  });

  it("filter 里的 prop-filter 不算 prop", () => {
    expect(
      wantsCalendarData(ONLY_ETAG_WITH_PROP_FILTER),
      "把 <C:prop-filter> 当成了 <prop>，判据被带偏",
    ).toBe(false);
  });

  it("解析不出 prop 时保守给正文（多返回安全，少返回是 bug）", () => {
    expect(wantsCalendarData("<C:calendar-query/>")).toBe(true);
    expect(wantsCalendarData("")).toBe(true);
  });

  it("组装 response 的地方真的用了这个判据", () => {
    // absence 类断言的配对 presence：上面几条只验判据本身，
    // 调用点被删掉它们照样全绿，而那正是这次要修的 bug 的形状。
    const src = readFileSync(path.resolve("src/web/caldav.ts"), "utf8");
    const calls = src.match(/wantsCalendarData\(/g) ?? [];
    expect(
      calls.length,
      "caldav.ts 里除了定义之外没人调用 wantsCalendarData —— 判据写了但没接上",
    ).toBeGreaterThanOrEqual(2);
    expect(
      /includeData\s*$|\.\.\.\(includeData/m.test(src),
      "calendar-query 组装 response 时没有按 includeData 取舍正文",
    ).toBe(true);
  });
});
