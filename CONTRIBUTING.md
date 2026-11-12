<p align="center"><b>简体中文</b> | <a href="#english">English</a></p>

# 参与贡献

感谢你愿意花时间改进 ByWave Calendar。这个项目是自托管日历平台,**服务端 + 网页 + iOS + Android + 桌面端**都在同一个仓库里。

## 本地跑起来

需要 **Node ≥ 22.12.0** 和 **PostgreSQL 16**。

```bash
git clone https://github.com/wuha-like-sleep/by-wave-calendar.git
cd by-wave-calendar
npm ci
cp .env.example .env          # 至少填 DATABASE_URL、SESSION_SECRET、PUBLIC_BASE_URL
npm run db:migrate
npm run dev                   # http://127.0.0.1:3000
```

`SESSION_SECRET` 随便一串 ≥32 字符即可:`openssl rand -hex 32`。

## 提交之前

统一检查入口与 CI 保持一致，包含源码和测试类型、单元测试、集成测试及八种语言的完整性：

```bash
npm run check
npm run build        # 验证生产构建
npm run audit:prod   # 查询生产依赖的已知漏洞（需要联网）
```

`npm run release` 打包前强制执行 `npm run check`，再构建生产资源。集成测试使用进程内 PGlite，不需要额外数据库；导入配置仍需要 `.env` 中的必填值。

单独运行：`npm run typecheck`、`npm test`、`npm run test:int`、`npm run i18n:check`。测试类型检查保留了六个历史欠账文件的独立清单，新增测试须通过正常类型检查。

数据库迁移请先读 [drizzle/README.md](drizzle/README.md)，当前快照链不完整，不能直接运行 `db:generate`。文档入口见 [docs/README.md](docs/README.md)。

## 改动约定

**改用户可见文案 → 必须补 8 种语言。** 词典在 `src/lib/i18n/locales/*.ts`(en 是源语言)。模板里用 `t("key")`,客户端 JS 用注入的 `window.BWC_T`。**不要在模板或 JS 里硬编码中文** —— 切到英文后会露出来。

**自然语言解析只有一份源码**：`src/lib/nl_parse.ts`。网页实时预览通过 `npm run build:nl` 从它生成 `src/public/lib/nl-parse.js`；`dev` 和 `build` 会自动运行此步骤，不要手改生成文件。

**原生端版本号**各有两处,必须同步:

| 端 | 位置 |
|---|---|
| iOS | `project.pbxproj` 的 `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` |
| Android | `app/build.gradle.kts` 的 `versionName` + `versionCode` |
| 桌面 | `build.gradle.kts` 的 `version` + `BuildInfo.kt` 的 `VERSION_NAME`/`VERSION_CODE` |

桌面端和安卓的 `versionCode` 还必须和 `releases/latest.json` 里的一致,否则应用内更新会误判「已是最新」。

**提交信息**用中文或英文都行,写清「改了什么 + 为什么」,尤其是为什么。

## 报 Bug / 提需求

开 [Issue](https://github.com/wuha-like-sleep/by-wave-calendar/issues) 时请带上:服务端版本(`/health` 能看到)、客户端版本、复现步骤。安全问题请**不要**开公开 Issue,见 [SECURITY.md](SECURITY.md)。

---

<a name="english"></a>

# Contributing

Thanks for taking the time. This repo holds the **server, web app, iOS, Android and desktop clients** together.

## Running locally

Requires **Node ≥ 22.12.0** and **PostgreSQL 16**.

```bash
npm ci
cp .env.example .env    # at minimum DATABASE_URL, SESSION_SECRET, PUBLIC_BASE_URL
npm run db:migrate
npm run dev             # http://127.0.0.1:3000
```

## Before you push

Run the shared checks, then verify the production build and dependency audit:

```bash
npm run check
npm run build
npm run audit:prod   # requires registry access
```

`check` includes source/test types, unit tests, PGlite integration tests and translation completeness. Integration tests need no external database; required environment values must still be configured. The release script runs `check` before building. Six historical test files remain in an explicit typecheck backlog; new tests must pass the normal test typecheck.

Read [the migration guide](drizzle/README.md) before changing the schema: the snapshot chain is incomplete, so do not run `db:generate`. See [the documentation index](docs/README.md) for other entry points.

## House rules

- **Any user-facing string must land in all 8 locales** (`src/lib/i18n/locales/*.ts`, en is the source). Never hardcode text in templates or client JS — it shows up the moment someone switches language.
- The **natural-language parser has one source**, `src/lib/nl_parse.ts`. `npm run build:nl` generates the browser preview bundle; `dev` and `build` already run it. Do not edit generated bundles.
- **Native version numbers live in two places per platform** and must stay in sync with the matching `releases/latest.json`, or the in-app updater will report "already up to date" forever.
- Write commit messages that explain **why**, not just what.

Security issues: please don't open a public issue — see [SECURITY.md](SECURITY.md).
