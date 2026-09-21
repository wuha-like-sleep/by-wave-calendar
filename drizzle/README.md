# 迁移怎么加

**不要跑 `npm run db:generate`。**

这个目录下有 50+ 个 `.sql`，而 `meta/` 里的快照链**停在 0046**——0047 之后
全是手写 SQL + 手加 `meta/_journal.json` 条目，没有留快照。

于是 `drizzle-kit generate` 会拿 0046 的快照去 diff 当前的 `src/db/schema.ts`，
把 0047 以后已经加过的列**再生成一遍**，产出一个跑不起来的新迁移。
它不会报错，你要等部署到有存量数据的库上才发现。

## 正确做法

1. 改 `src/db/schema.ts`
2. 手写 `drizzle/migrations/00NN_名字.sql`，语句之间用 `--> statement-breakpoint` 分隔
3. 手动往 `drizzle/migrations/meta/_journal.json` 的 `entries` 末尾加一条
   （`idx` 递增、`tag` 和文件名一致、`when` 用毫秒时间戳）

## 每条语句都要可重入

`src/lib/auto_migrate.ts` 在**每次启动**时跑 migrator，而历史上出现过
「迁移器的记账和真实 schema 对不上」（有人 db:push 或手工 ALTER 过）。
所以一律写 `IF NOT EXISTS` / `IF EXISTS`，重放必须是 no-op。

## 改了列就要想一下自动修补

`auto_migrate.ts` 底部有一段 defensive patches：给那些「记账脱节、migrator 补不上」
的库兜底。新增的列如果**上线后马上就会被读**（读不到就是 500），把它加进去。
