<div align="center">

# 📅 ByWave Calendar

**自托管的日历共享平台 · 一个域名搞定 ICS 订阅 / CalDAV / 网页 / PWA / SSO / 第三方 API**

<br/>

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-≥20-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[在线 Demo](https://rl.lz-ss.com) · [一键部署](#-一键部署到宝塔) · [架构](#-架构) · [Roadmap](#-roadmap)

<br/>

## 📥 下载客户端

<table>
<tr>
<th width="33%">📱 iOS</th>
<th width="33%">🤖 Android</th>
<th width="33%">🌐 Web / PWA</th>
</tr>
<tr>
<td align="center">

[![App Store](https://img.shields.io/badge/App%20Store-下载-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)

或 [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX)

</td>
<td align="center">

[![Download APK](https://img.shields.io/badge/Download-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/latest/download/bywave-calendar.apk)

[历次版本](https://github.com/wuha-like-sleep/by-wave-calendar/releases) · APP 内自动更新

</td>
<td align="center">

![Web PWA](https://img.shields.io/badge/Web-PWA_支持-7c3aed?logo=safari&logoColor=white&style=for-the-badge)

直接在浏览器打开你的 ByWave 服务器即可 · 支持 PWA 装到桌面 / 主屏

</td>
</tr>
</table>

> Android 用户首次安装需要在系统设置中允许「来自此应用的未知应用」，开一次终身有效。后续升级走 APP 内通道，无需重新下载。

<br/>

### 桌面端（开发中）

<table>
<tr>
<th width="33%">🍎 macOS</th>
<th width="33%">🪟 Windows</th>
<th width="33%">🐧 Linux</th>
</tr>
<tr>
<td align="center">

[![Download DMG](https://img.shields.io/badge/macOS-DMG_下载-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.7.7/ByWaveCalendar-0.7.7-arm64.dmg)

Apple Silicon · 已 Apple 公证

</td>
<td align="center">

[![Download MSI](https://img.shields.io/badge/Windows-MSI_下载-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.7.7/ByWaveCalendar-0.7.7-x64.msi)

x64 · 跟 macOS 同一份 Kotlin 代码

</td>
<td align="center">

![Coming soon](https://img.shields.io/badge/Linux-DEB_即将发布-94a3b8?logo=linux&logoColor=white&style=for-the-badge)

桌面端三平台同步发布

</td>
</tr>
</table>

> 桌面端用 Compose Multiplatform 实现，**不是浏览器套壳**。Skia 原生渲染，Mac/Win/Linux 一份代码出三平台。详见 [apps/desktop/README.md](apps/desktop/README.md)。

</div>

---

## ✨ 它能干什么

- 📅 **网页日历** — Toast UI Calendar 月 / 周 / 日视图，拖拽建事件、点格快速加，移动端响应式
- 📲 **PWA** — 一键安装到桌面 / 主屏，离线壳缓存，新版本自动弹窗提示
- 🔁 **CalDAV 双向同步** — iOS 系统日历、Apple Calendar.app、Synology 都能直接登 `https://你的域名/caldav/` 加账号
- 📤 **ICS 订阅发布** — 给每个日历生成不会改的只读链接，丢给 Google / Apple / Outlook 加成「订阅日历」
- 📥 **ICS 导入** — 文件 / URL 一次性 / URL 周期订阅 / 粘贴文本，四种方式都行
- 👥 **协作邀请** — 邮件发邀请，对方接受后日历出现在他们账号里；事件邀请带 RSVP（参加 / 不参加 / 可能）+ 一键加到 Google / Apple / ByWave
- 🔐 **认证全家桶** — 邮箱+密码 + Passkey (WebAuthn) + TOTP MFA + 多 SSO 提供方 (OIDC / Keycloak / Okta / Google Workspace)
- 🛡 **安全管控** — 失败次数锁定 + 陌生设备邮件验证码 + Passkey/MFA/密码变更邮件提醒 + 应用密码（CalDAV 不暴露主密码）+ 登录历史
- 🎨 **多套主题** — 7 套品牌色 + 2 种密度，**每个用户**可以单独设自己的偏好
- ⚙️ **管理后台** — 站点名 / Logo / SMTP / SSO / 安全策略 / 主题 / 第三方 API / **一键自更新（带进度条 + 自动重启刷新）**
- 🔌 **第三方 API** — admin 签发 Bearer Token，Zoom / Notion / n8n / 内部系统直接 REST 读写日历
- 🌐 **中国友好** — 所有第三方资源（HTMX / Toast UI / SimpleWebAuthn / Tailwind）打包本地化，无国外 CDN 依赖

<br/>

## 🧱 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Nginx 443 (TLS) ───► PM2 Node 127.0.0.1:3000                        │
│                                  │                                   │
│         ┌────────────────────────┴────────────────────────┐          │
│         │              Fastify 5 + TypeScript             │          │
│         │                                                  │          │
│  /            ┌─ EJS 模板（HTMX 增量）+ Tailwind UI       │          │
│  /app         ├─ Toast UI Calendar 月/周/日                │          │
│  /caldav/*    ├─ RFC 4791 PROPFIND / REPORT / PUT          │          │
│  /ics/:tok    ├─ RFC 5545 ICS feed                          │          │
│  /api/*       ├─ REST (cookie 或 Bearer Token)             │          │
│  /admin/*     └─ 管理后台（含 /admin/update 自更新）        │          │
│         │                                                  │          │
│         └────────────────────────┬─────────────────────────┘          │
│                                  ▼                                    │
│              PostgreSQL 16 + Drizzle ORM (~20 张表)                  │
└──────────────────────────────────────────────────────────────────────┘
```

**关键依赖（都已本地化打包，国内服务器直装无 CDN 依赖）：**

| 类别 | 技术 |
|------|------|
| Web 框架 | Fastify 5 |
| ORM | Drizzle ORM + drizzle-kit |
| 模板 | EJS + HTMX + Tailwind CSS |
| 日历 UI | Toast UI Calendar 2.x |
| 身份 | bcrypt + @simplewebauthn/server + otplib + 自建 OIDC client |
| 邮件 | nodemailer + 自建 baseLayout 模板 |
| PWA | Manifest + Service Worker（带版本号 cache 自动失效） |

<br/>

## 🚀 一键部署到宝塔

> 国内服务器推荐用 Gitee 作为代码源（GitHub 在国内不稳定）。镜像同步双向走，本仓库每次 push 同时去 GitHub 和 Gitee。

```bash
# 1. SSH 进服务器
cd /www/wwwroot
git clone https://gitee.com/zhaorunsen/by-wave-calendar.git rl.lz-ss.com
cd rl.lz-ss.com

# 2. 复制 .env.example → .env，填好数据库 + PUBLIC_BASE_URL
cp .env.example .env && vim .env

# 3. 一键装
bash install.sh

# 4. PM2 起服务
pm2 start ecosystem.config.cjs
pm2 save

# 5. 宝塔创建站点 → 反向代理到 127.0.0.1:3000 + 申请 SSL
```

完成后所有后续更新都在网页里点：**管理后台 → 更新 → 检查更新 → 立即更新**（带实时进度条 + 自动重启 + 自动刷新页面）。

<br/>

## ⚙️ 配置项

按部署顺序：

1. **数据库连接**：在 `.env` 里填一次
2. **邮件 SMTP**：网页 `/admin/smtp` 配（**不进代码仓库**，开源版本里只有空模板）
3. **站点名 / Logo / ICP / 注册策略**：`/admin/site` 和 `/admin/logo`
4. **SSO 提供方**：`/admin/sso` 添加多个 OIDC 提供方（登录页同时显示多个按钮）
5. **安全策略**：`/admin/security` 选锁定次数 / 时长 / 陌生设备验证码
6. **API 第三方集成**：`/admin/api` 开关 + 签发 Bearer Token

<br/>

## 🔌 第三方 API 示例

```bash
# 列出当前 token 绑定用户的所有日历
curl -H "Authorization: Bearer bwc_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx" \
  https://rl.lz-ss.com/api/calendars

# 查询某段时间的事件
curl -H "Authorization: Bearer bwc_..." \
  "https://rl.lz-ss.com/api/events?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z"

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

完整端点 + curl 示例在 `/admin/api` 页面底部。

<br/>

## 🗺 Roadmap

- [x] 基础日历 + ICS + CalDAV
- [x] Passkey / MFA / SSO / 应用密码 / 登录历史
- [x] PWA + 多主题 + 用户级外观
- [x] 邀请协作 + 事件 RSVP + 多平台添加（Google / Apple / ByWave）
- [x] 管理员后台 + 一键自更新 + 邮件样式预览
- [x] 多 SSO 提供方
- [x] 第三方 Bearer API
- [ ] 用户自助 OAuth 授权（让外部 app 替用户调 API）
- [ ] i18n（中 / 英）
- [ ] 复杂 RRULE / VTIMEZONE 全支持

<br/>

## 🤝 贡献

PRs welcome。开发：

```bash
npm install
npm run dev          # tsx watch + tailwind --watch
npm run typecheck    # tsc --noEmit
npm run db:generate  # 改 schema 后生成 SQL 迁移
npm run db:migrate   # 应用到数据库
npm run build        # 生产构建（NODE_ENV=production 时 JS terser 压缩 + 混淆到 src/public/_built/）
```

代码风格：TypeScript strict + ESM-only + Drizzle 写 SQL。提交规范看 [git log](https://github.com/wuha-like-sleep/by-wave-calendar/commits/main)。

<br/>

## 📄 License

[MIT](LICENSE) — 想咋用咋用，记得保留版权声明。

<br/>

<div align="center">

<sub>这是<strong>我们的开源项目</strong>，不是 fork。觉得好用给个 ⭐ 支持。<br/>
GitHub: <a href="https://github.com/wuha-like-sleep/by-wave-calendar">wuha-like-sleep/by-wave-calendar</a>
 · Gitee 镜像: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a></sub>

</div>
