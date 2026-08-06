<p align="center"><b>简体中文</b> | <a href="README.en.md">English</a> | <a href="README.zh-TW.md">繁體中文</a></p>

<div align="center">

<img src="src/public/icons/icon-512.png" alt="ByWave Calendar" width="96" height="96" />

# ByWave Calendar

**自托管的日历共享平台 · 一个域名同时搞定 网页 / PWA / iOS / Android / 桌面端 / ICS 订阅 / CalDAV / SSO / 第三方 API**

<br/>

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/wuha-like-sleep/by-wave-calendar?label=server&color=2563eb)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20iOS%20·%20Android%20·%20macOS%20·%20Windows%20·%20Linux-6366f1.svg)](#-下载客户端)
[![Node](https://img.shields.io/badge/Node-≥20-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[在线 Demo](https://rl.lz-ss.com) · [下载客户端](#-下载客户端) · [功能](#-功能) · [一键部署](#-一键部署到宝塔) · [架构](#-技术栈)

</div>

---

## 这是什么

ByWave Calendar 是一个**自己服务器上跑的日历共享平台**。一个域名同时提供：

- 一个现代的**网页日历**（可装成 PWA）
- 原生 **iOS / Android / macOS / Windows** 客户端
- 标准协议出口：**CalDAV** 双向同步、**ICS** 订阅发布、**REST API**

适合个人、团队、小组织自建一套「不依赖任何外部 SaaS、可控、可备份」的日历。所有第三方前端资源都已本地化打包，**国内服务器直接装、无国外 CDN 依赖**。MIT 开源。

<br/>

## 📸 截图

<table>
<tr>
<td width="62%"><img src="docs/screenshots/landing.png" alt="Web" /><br/><sub>网页端 · 落地页</sub></td>
<td width="38%"><img src="docs/screenshots/ios-day.png" alt="iOS" /><br/><sub>iOS 原生客户端</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/screenshots/embed-widget.png" alt="Embed" /><br/><sub>可嵌入的只读日历组件（<code>/embed/&lt;token&gt;</code>，放进任意网页的 iframe）</sub></td>
</tr>
</table>

> 想直接上手可以看 [在线 Demo](https://rl.lz-ss.com)。

<br/>

## 📥 下载客户端

当前各端版本：

| 平台 | 版本 | 下载 |
|---|---|---|
| 🌐 Web / PWA | — | 浏览器打开你的 ByWave 服务器即可，支持装到桌面 / 主屏 |
| 📱 iOS | v1.6.2 | [App Store](https://apps.apple.com/us/app/bywavecalendar/id6772655143) · [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX) |
| 🤖 Android | v0.11.1 | [APK 直链](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.11.1/bywave-calendar-0.11.1.apk) · [历次版本](https://github.com/wuha-like-sleep/by-wave-calendar/releases) |
| 🍎 macOS | v1.0.17 | [DMG (Apple Silicon)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-arm64.dmg) — 已 Apple 公证 |
| 🪟 Windows | v1.0.17 | [MSI (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-x64.msi) |
| 🐧 Linux | v1.0.17 | [DEB (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/bywave-calendar_1.0.17_amd64.deb) |

<div align="center">

[![App Store](https://img.shields.io/badge/iOS-App%20Store-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)
[![Download APK](https://img.shields.io/badge/Android-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.11.1/bywave-calendar-0.11.1.apk)
[![Download DMG](https://img.shields.io/badge/macOS-DMG-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-arm64.dmg)
[![Download MSI](https://img.shields.io/badge/Windows-MSI-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-x64.msi)

</div>

**Android 首装提示**：首次安装需在系统设置里允许「来自此应用的未知应用」，开一次终身有效；后续升级走 APP 内自动更新，无需重新下载。

**桌面端**：用 [Compose Multiplatform](apps/desktop/README.md) 实现，**不是浏览器套壳** —— Skia 原生渲染，Mac / Win / Linux 一份 Kotlin 代码出三平台，自带 Sparkle 风格 in-place 自动更新。详见 [apps/desktop/README.md](apps/desktop/README.md)。

<br/>

## ✨ 功能

**日历与事件**
- 📅 网页日历（Toast UI Calendar）月 / 周 / 日视图，拖拽建事件、点格快速加，移动端响应式
- 🔁 周期事件（RRULE / RFC 5545 展开），事件提醒（reminders）
- 🔍 全站搜索 + `Cmd+K` 命令面板，跨自有 + 共享日历查事件
- 📲 PWA：一键装到桌面 / 主屏，离线壳缓存，新版本自动弹窗提示

**同步与互通**
- 🔄 **CalDAV 双向同步**（RFC 4791）：iOS 系统日历、Apple Calendar.app、Synology 直接登 `https://你的域名/caldav/` 加账号
- 📤 **ICS 订阅发布**（RFC 5545）：每个日历生成不变的只读链接，丢给 Google / Apple / Outlook 当「订阅日历」
- 📥 **ICS 导入**：文件 / URL 一次性 / URL 周期订阅 / 粘贴文本，四种方式

**协作**
- 👥 **日历邀请**：邮件邀请协作者，接受后日历进入对方账号
- 🙋 **事件 RSVP**：邀请带「参加 / 不参加 / 可能」+ 一键加到 Google / Apple / ByWave
- 🗓 **预约链接 (booking)**：发布每周可约时段，对方在公开页选时间约你，自动建带参与者的事件

**认证与安全**
- 🔐 邮箱+密码 + **Passkey (WebAuthn)** + **TOTP MFA** + 多 **SSO** 提供方（OIDC / Keycloak / Okta / Google Workspace）
- 🛡 失败锁定 + 陌生设备邮件验证码 + Passkey/MFA/密码变更邮件提醒 + 登录历史 + 审计日志
- 🔑 **应用密码**：CalDAV / 客户端登录不暴露主密码

**集成与扩展**
- 🔌 **第三方 REST API**：admin 签发 Bearer Token，Zoom / Notion / n8n / 内部系统直接读写日历
- 🔓 **OAuth 2.0 授权服务器**（授权码 + PKCE）：让外部 app 经用户授权代调 API
- 🪝 **Webhooks**：事件变更推送到外部端点，带投递记录
- 🔔 **Web Push**（VAPID / RFC 8030）+ iOS APNs 推送通知

**运维与定制**
- ⚙️ **管理后台**：站点名 / Logo / SMTP / SSO / 安全策略 / 主题 / API / Webhook / 审计
- ♻️ **一键自更新**：后台点一下检查 + 立即更新，带实时进度条 + 自动重启刷新
- 💾 **数据备份 / 恢复**：后台全表导出 / 导入，附带 round-trip 自检脚本
- 🎨 **多套主题**：7 套品牌色 + 2 种密度，**每个用户**单独设偏好
- 🌐 **多语言 (i18n)**：服务端 + iOS + Android + 桌面端均支持 **8 种语言** 运行时切换 —— 简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch
- 🇨🇳 **中国友好**：第三方前端资源（HTMX / Toast UI / SimpleWebAuthn / Tailwind）全本地化，无国外 CDN

<br/>

## 🚀 一键部署到宝塔

> 国内服务器推荐用 Gitee 作为代码源（GitHub 在国内不稳定）。本仓库每次 push 同时同步到 GitHub 和 Gitee。

```bash
# 1. SSH 进服务器
cd /www/wwwroot
git clone https://gitee.com/zhaorunsen/by-wave-calendar.git rl.lz-ss.com
cd rl.lz-ss.com

# 2. 复制 .env.example → .env，填好 DATABASE_URL + PUBLIC_BASE_URL
cp .env.example .env && vim .env

# 3. 一键装（首次会创建 .env 后退出让你编辑，再跑一次完成安装）
bash deploy/bt-panel/install.sh
```

`install.sh` 会自动：装依赖（`npm ci --omit=dev`）→ 数据库迁移 → `setcap` 让 Node 绑 80/443 → 交互式创建管理员 → PM2 启动。

完成后所有后续更新都在网页里点：**管理后台 → 更新 → 检查更新 → 立即更新**（实时进度条 + 自动重启 + 自动刷新）。

📖 完整宝塔部署指南（含 SSL、证书热重载、备份恢复验证、CI 部署）见 **[deploy/bt-panel/README.md](deploy/bt-panel/README.md)**。

**首次配置顺序**（部署后在网页里配，不进代码仓库）：

1. 数据库连接 —— `.env` 里填一次
2. 邮件 SMTP —— `/admin/smtp`
3. 站点名 / Logo / ICP / 注册策略 —— `/admin/site`、`/admin/logo`
4. SSO 提供方 —— `/admin/sso`（可加多个 OIDC，登录页同时显示多个按钮）
5. 安全策略 —— `/admin/security`
6. 第三方 API / OAuth —— `/admin/api`、`/admin/oauth-apps`

<br/>

## 🔌 第三方 API 示例

```bash
# 列出当前 token 绑定用户的所有日历
curl -H "Authorization: Bearer bwc_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx" \
  https://rl.lz-ss.com/api/calendars

# 新建事件（含参与者自动发邮件）
curl -X POST -H "Authorization: Bearer bwc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "calendarId":"<uuid>",
    "summary":"团队周会",
    "startsAt":"2026-05-25T10:00:00Z",
    "endsAt":"2026-05-25T11:00:00Z",
    "allDay":false,
    "extra":{"attendees":["alice@example.com","bob@example.com"]}
  }' \
  https://rl.lz-ss.com/api/events
```

完整端点 + curl 示例在 `/admin/api` 页面底部。OAuth 授权码流程见 `/admin/oauth-apps`。

<br/>

## 🧱 技术栈

```
┌──────────────────────────────────────────────────────────────────────┐
│  Nginx/直接 443 (TLS) ───► PM2 Node 127.0.0.1:3000                   │
│         ┌────────────────────────┴────────────────────────┐          │
│         │              Fastify 5 + TypeScript              │          │
│  /            ┌─ EJS 模板（HTMX 增量）+ Tailwind UI        │          │
│  /app         ├─ Toast UI Calendar 月/周/日                │          │
│  /caldav/*    ├─ RFC 4791 PROPFIND / REPORT / PUT          │          │
│  /ics/:tok    ├─ RFC 5545 ICS feed                         │          │
│  /api/*       ├─ REST (cookie / Bearer Token)              │          │
│  /oauth/*     ├─ OAuth 2.0 授权服务器 (PKCE)               │          │
│  /admin/*     └─ 管理后台（含 /admin/update 自更新）       │          │
│                                  ▼                                    │
│              PostgreSQL 16 + Drizzle ORM (~20 张表)                  │
└──────────────────────────────────────────────────────────────────────┘
```

| 端 | 技术 |
|---|---|
| 服务端 | TypeScript + Fastify 5 + EJS + HTMX + Tailwind CSS · Drizzle ORM + PostgreSQL 16 |
| 日历 UI | Toast UI Calendar 2.x |
| 身份 | bcrypt + @simplewebauthn/server + otplib + 自建 OIDC client + OAuth 2.0 server |
| 推送 | web-push (VAPID) + @parse/node-apn (APNs) |
| 桌面端 | Kotlin + Compose Multiplatform（Skia 原生渲染） |
| iOS | Swift / SwiftUI |
| Android | Kotlin / Jetpack Compose |

所有第三方前端依赖（HTMX / Toast UI / SimpleWebAuthn / Tailwind）已本地化打包，国内服务器直装无 CDN 依赖。

<br/>

## 📂 仓库结构

```
by-wave-calendar/
├── src/                  服务端（TypeScript + Fastify）
│   ├── server.ts         应用入口
│   ├── routes/           REST API（events / calendars / ics / push / search …）
│   ├── web/              网页 + 后台路由（admin / caldav / sso / oauth / webauthn …）
│   ├── lib/              业务逻辑（caldav / ical / sso / mfa / booking / webhooks / i18n …）
│   ├── db/               Drizzle schema + client
│   ├── views/            EJS 模板（app / admin / auth / booking / invite …）
│   ├── public/           前端静态资源（含本地化的第三方库）
│   └── styles/           Tailwind 输入
├── apps/
│   ├── ios/              Swift / SwiftUI 客户端
│   ├── android/          Kotlin / Compose 客户端（+ releases/ 版本清单）
│   └── desktop/          Compose Multiplatform 桌面端（+ releases/ 版本清单）
├── deploy/
│   ├── bt-panel/         宝塔部署：install.sh / nginx 示例 / ecosystem.config.cjs / README
│   └── android-release.md
├── docs/design/          设计文档（如 passkey 架构）
├── scripts/              构建 / 迁移 / 发布 / i18n 检查脚本
├── drizzle/              数据库迁移
└── test/                 vitest 测试
```

<br/>

## 🗺 Roadmap

- [x] 基础日历 + 周期事件 + ICS + CalDAV
- [x] Passkey / MFA / 多 SSO / 应用密码 / 登录历史 / 审计
- [x] PWA + 多主题 + 用户级外观
- [x] 邀请协作 + 事件 RSVP + 预约链接 (booking) + 多平台添加
- [x] 管理员后台 + 一键自更新 + 数据备份恢复
- [x] 第三方 Bearer API + Webhooks
- [x] OAuth 2.0 授权服务器（授权码 + PKCE）
- [x] i18n（8 种语言）服务端 + iOS + Android + 桌面端
- [x] Web Push + iOS APNs 通知
- [x] 原生 iOS / Android / 桌面端客户端（macOS DMG / Windows MSI / Linux DEB）
- [ ] 复杂 RRULE / VTIMEZONE 全支持
- [ ] OAuth refresh token

<br/>

## 🤝 贡献

PRs welcome。本地开发：

```bash
npm install
npm run dev          # 构建资产 + tsx watch
npm run typecheck    # tsc --noEmit
npm run db:generate  # 改 schema 后生成 SQL 迁移
npm run db:migrate   # 应用迁移到数据库
npm run i18n:check   # 检查各语言翻译覆盖率
npm run test         # vitest
npm run build        # 生产构建（terser 压缩到 src/public/_built/）
```

代码风格：TypeScript strict + ESM-only + 用 Drizzle 写 SQL。各客户端构建说明见对应 `apps/*/README.md`。

<br/>

## 📄 License

[MIT](LICENSE) — 想咋用咋用，记得保留版权声明。

<br/>

<div align="center">

<sub>这是<strong>我们的开源项目</strong>，不是 fork。觉得好用给个 ⭐ 支持。<br/>
GitHub: <a href="https://github.com/wuha-like-sleep/by-wave-calendar">wuha-like-sleep/by-wave-calendar</a>
 · Gitee 镜像: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a></sub>

</div>
