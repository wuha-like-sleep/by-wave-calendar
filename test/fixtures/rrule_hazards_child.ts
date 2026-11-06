// 在子进程里跑：这些规则一旦漏过 neverFinishes 就是死循环，同进程跑测试器会跟着卡死、红都红不了。
// 每算完一条打一行，父进程超时后能看出卡在哪一条。
import { expandEvent, seriesStartsBetween } from "../../src/lib/rrule_expand.js";

const cases = JSON.parse(process.argv[2]!) as Array<{ start: string; rule: string; tz: string | null }>;
const from = new Date("2026-11-02T00:00:00Z");
const to = new Date("2026-11-09T00:00:00Z");
for (const c of cases) {
  const startsAt = new Date(c.start);
  const t0 = performance.now();
  const occ = expandEvent(
    { id: "e", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), rrule: c.rule, allDay: false, timeZone: c.tz },
    from, to,
  );
  const ms = Math.round(performance.now() - t0);
  const series = seriesStartsBetween({ startsAt, rrule: c.rule, allDay: false, timeZone: c.tz }, from, to);
  console.log(JSON.stringify({ rule: c.rule, tz: c.tz, n: occ.length, ms, series: series ? series.length : null }));
}
process.exit(0);
