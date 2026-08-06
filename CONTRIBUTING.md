<p align="center"><b>简体中文</b> | <a href="#english">English</a></p>

# 参与贡献

感谢你愿意花时间改进 ByWave Calendar。这个项目是自托管日历平台,**服务端 + 网页 + iOS + Android + 桌面端**都在同一个仓库里。

## 本地跑起来

需要 **Node ≥ 20** 和 **PostgreSQL 16**。

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

这三条在 CI 里会跑,本地先过一遍能省一轮来回:

```bash
npx tsc -p tsconfig.json --noEmit   # 类型检查
npx vitest run                      # 单元测试
npm run i18n:check                  # 语言包完整性
```

`npm run release` 打包时也会强制跑这些,任何一条红都不会出包。

## 改动约定

**改用户可见文案 → 必须补 8 种语言。** 词典在 `src/lib/i18n/locales/*.ts`(zh-CN 是源语言)。模板里用 `t("key")`,客户端 JS 用注入的 `window.BWC_T`。**不要在模板或 JS 里硬编码中文** —— 切到英文后会露出来。

**自然语言解析词库**同时存在两份:服务端 `src/lib/nl_parse.ts`(所有客户端共用)和 `src/public/calendar-app.js` 里的一份副本(网页端实时预览用)。**改一处必须同步另一处**,否则预览和实际创建结果会不一致。

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

Requires **Node ≥ 20** and **PostgreSQL 16**.

```bash
npm ci
cp .env.example .env    # at minimum DATABASE_URL, SESSION_SECRET, PUBLIC_BASE_URL
npm run db:migrate
npm run dev             # http://127.0.0.1:3000
```

## Before you push

CI runs these; running them locally saves a round trip:

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run
npm run i18n:check
```

## House rules

- **Any user-facing string must land in all 8 locales** (`src/lib/i18n/locales/*.ts`, zh-CN is the source). Never hardcode text in templates or client JS — it shows up the moment someone switches language.
- The **natural-language parser exists twice** — `src/lib/nl_parse.ts` (server, shared by every client) and a copy inside `src/public/calendar-app.js` (live preview on web). Change one, change the other.
- **Native version numbers live in two places per platform** and must stay in sync with the matching `releases/latest.json`, or the in-app updater will report "already up to date" forever.
- Write commit messages that explain **why**, not just what.

Security issues: please don't open a public issue — see [SECURITY.md](SECURITY.md).
