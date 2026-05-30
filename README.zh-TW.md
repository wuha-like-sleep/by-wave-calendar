<p align="center"><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <b>繁體中文</b></p>

<div align="center">

<img src="src/public/icons/icon-512.png" alt="ByWave Calendar" width="96" height="96" />

# ByWave Calendar

**自架的行事曆共享平台 · 一個網域同時搞定 網頁 / PWA / iOS / Android / 桌面端 / ICS 訂閱 / CalDAV / SSO / 第三方 API**

<br/>

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/server-v1.5.4-2563eb.svg)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20iOS%20·%20Android%20·%20macOS%20·%20Windows%20·%20Linux-6366f1.svg)](#-下載用戶端)
[![Node](https://img.shields.io/badge/Node-≥20-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[線上 Demo](https://rl.lz-ss.com) · [下載用戶端](#-下載用戶端) · [功能](#-功能) · [一鍵部署](#-一鍵部署到寶塔) · [架構](#-技術棧)

</div>

---

## 這是什麼

ByWave Calendar 是一個**跑在自己伺服器上的行事曆共享平台**。一個網域同時提供：

- 一個現代的**網頁行事曆**（可裝成 PWA）
- 原生 **iOS / Android / macOS / Windows** 用戶端
- 標準協定出口：**CalDAV** 雙向同步、**ICS** 訂閱發佈、**REST API**

適合個人、團隊、小型組織自建一套「不依賴任何外部 SaaS、可控、可備份」的行事曆。所有第三方前端資源都已在地化打包，**中國大陸伺服器可直接安裝、無國外 CDN 依賴**。MIT 開源。

<br/>

## 📸 截圖

> _截圖待補充 —— 還沒有圖片提交到儲存庫。_
>
> _可以先看 [線上 Demo](https://rl.lz-ss.com)。_

<br/>

## 📥 下載用戶端

目前各端版本：

| 平台 | 版本 | 下載 |
|---|---|---|
| 🌐 Web / PWA | — | 用瀏覽器開啟你的 ByWave 伺服器即可，支援裝到桌面 / 主畫面 |
| 📱 iOS | v1.5.1 | [App Store](https://apps.apple.com/us/app/bywavecalendar/id6772655143) · [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX) |
| 🤖 Android | v0.9.3 | [APK 直連](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.9.3/bywave-calendar-0.9.3.apk) · [歷次版本](https://github.com/wuha-like-sleep/by-wave-calendar/releases) |
| 🍎 macOS | v0.8.3 | [DMG (Apple Silicon)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.8.3/ByWaveCalendar-0.8.3-arm64.dmg) — 已 Apple 公證 |
| 🪟 Windows | v0.8.3 | [MSI (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.8.3/ByWaveCalendar-0.8.3-x64.msi) |
| 🐧 Linux | v0.8.3 | [DEB (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.8.3/bywave-calendar_0.8.3_amd64.deb) |

<div align="center">

[![App Store](https://img.shields.io/badge/iOS-App%20Store-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)
[![Download APK](https://img.shields.io/badge/Android-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.9.3/bywave-calendar-0.9.3.apk)
[![Download DMG](https://img.shields.io/badge/macOS-DMG-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.8.3/ByWaveCalendar-0.8.3-arm64.dmg)
[![Download MSI](https://img.shields.io/badge/Windows-MSI-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.8.3/ByWaveCalendar-0.8.3-x64.msi)

</div>

**Android 首次安裝提示**：首次安裝需在系統設定裡允許「來自此應用程式的未知應用程式」，開一次終身有效；之後升級走 App 內自動更新，無需重新下載。

**桌面端**：用 [Compose Multiplatform](apps/desktop/README.md) 實作，**不是瀏覽器套殼** —— Skia 原生算繪，Mac / Win / Linux 一份 Kotlin 程式碼出三平台，自帶 Sparkle 風格 in-place 自動更新。詳見 [apps/desktop/README.md](apps/desktop/README.md)。

<br/>

## ✨ 功能

**行事曆與事件**
- 📅 網頁行事曆（Toast UI Calendar）月 / 週 / 日檢視，拖曳建事件、點格快速新增，行動裝置自適應
- 🔁 週期事件（RRULE / RFC 5545 展開），事件提醒（reminders）
- 🔍 全站搜尋 + `Cmd+K` 命令面板，跨自有 + 共享行事曆查事件
- 📲 PWA：一鍵裝到桌面 / 主畫面，離線殼快取，新版本自動彈窗提示

**同步與互通**
- 🔄 **CalDAV 雙向同步**（RFC 4791）：iOS 系統行事曆、Apple Calendar.app、Synology 直接登入 `https://你的網域/caldav/` 加帳號
- 📤 **ICS 訂閱發佈**（RFC 5545）：每個行事曆產生不變的唯讀連結，丟給 Google / Apple / Outlook 當「訂閱行事曆」
- 📥 **ICS 匯入**：檔案 / URL 一次性 / URL 週期訂閱 / 貼上文字，四種方式

**協作**
- 👥 **行事曆邀請**：以電子郵件邀請協作者，接受後行事曆進入對方帳號
- 🙋 **事件 RSVP**：邀請帶「參加 / 不參加 / 可能」+ 一鍵加到 Google / Apple / ByWave
- 🗓 **預約連結 (booking)**：發佈每週可預約時段，對方在公開頁選時間約你，自動建立帶參與者的事件

**認證與安全**
- 🔐 電子郵件+密碼 + **Passkey (WebAuthn)** + **TOTP MFA** + 多 **SSO** 供應商（OIDC / Keycloak / Okta / Google Workspace）
- 🛡 失敗鎖定 + 陌生裝置電子郵件驗證碼 + Passkey/MFA/密碼變更電子郵件提醒 + 登入紀錄 + 稽核日誌
- 🔑 **應用程式密碼**：CalDAV / 用戶端登入不暴露主密碼

**整合與擴充**
- 🔌 **第三方 REST API**：admin 簽發 Bearer Token，Zoom / Notion / n8n / 內部系統直接讀寫行事曆
- 🔓 **OAuth 2.0 授權伺服器**（授權碼 + PKCE）：讓外部 app 經使用者授權代呼叫 API
- 🪝 **Webhooks**：事件變更推送到外部端點，帶投遞紀錄
- 🔔 **Web Push**（VAPID / RFC 8030）+ iOS APNs 推播通知

**維運與客製**
- ⚙️ **管理後台**：站台名稱 / Logo / SMTP / SSO / 安全政策 / 主題 / API / Webhook / 稽核
- ♻️ **一鍵自我更新**：後台點一下檢查 + 立即更新，帶即時進度條 + 自動重啟重新整理
- 💾 **資料備份 / 還原**：後台全表匯出 / 匯入，附帶 round-trip 自我檢查指令碼
- 🎨 **多套主題**：7 套品牌色 + 2 種密度，**每位使用者**單獨設定偏好
- 🌐 **多語言 (i18n)**：伺服端 + iOS + Android + 桌面端均支援 **8 種語言** 執行時切換 —— 簡體中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch
- 🇨🇳 **中國友善**：第三方前端資源（HTMX / Toast UI / SimpleWebAuthn / Tailwind）全在地化，無國外 CDN

<br/>

## 🚀 一鍵部署到寶塔

> 中國大陸伺服器建議用 Gitee 作為程式碼來源（GitHub 在當地不穩定）。本儲存庫每次 push 同時同步到 GitHub 和 Gitee。

```bash
# 1. SSH 進伺服器
cd /www/wwwroot
git clone https://gitee.com/zhaorunsen/by-wave-calendar.git rl.lz-ss.com
cd rl.lz-ss.com

# 2. 複製 .env.example → .env，填好 DATABASE_URL + PUBLIC_BASE_URL
cp .env.example .env && vim .env

# 3. 一鍵安裝（首次會建立 .env 後退出讓你編輯，再跑一次完成安裝）
bash deploy/bt-panel/install.sh
```

`install.sh` 會自動：裝相依套件（`npm ci --omit=dev`）→ 資料庫遷移 → `setcap` 讓 Node 綁 80/443 → 互動式建立管理員 → PM2 啟動。

完成後所有後續更新都在網頁裡點：**管理後台 → 更新 → 檢查更新 → 立即更新**（即時進度條 + 自動重啟 + 自動重新整理）。

📖 完整寶塔部署指南（含 SSL、憑證熱重載、備份還原驗證、CI 部署）見 **[deploy/bt-panel/README.md](deploy/bt-panel/README.md)**。

**首次設定順序**（部署後在網頁裡設定，不進程式碼儲存庫）：

1. 資料庫連線 —— `.env` 裡填一次
2. 電子郵件 SMTP —— `/admin/smtp`
3. 站台名稱 / Logo / ICP / 註冊政策 —— `/admin/site`、`/admin/logo`
4. SSO 供應商 —— `/admin/sso`（可加多個 OIDC，登入頁同時顯示多個按鈕）
5. 安全政策 —— `/admin/security`
6. 第三方 API / OAuth —— `/admin/api`、`/admin/oauth-apps`

<br/>

## 🔌 第三方 API 範例

```bash
# 列出目前 token 綁定使用者的所有行事曆
curl -H "Authorization: Bearer bwc_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx" \
  https://rl.lz-ss.com/api/calendars

# 新建事件（含參與者自動寄信）
curl -X POST -H "Authorization: Bearer bwc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "calendarId":"<uuid>",
    "summary":"團隊週會",
    "startsAt":"2026-05-25T10:00:00Z",
    "endsAt":"2026-05-25T11:00:00Z",
    "allDay":false,
    "extra":{"attendees":["alice@example.com","bob@example.com"]}
  }' \
  https://rl.lz-ss.com/api/events
```

完整端點 + curl 範例在 `/admin/api` 頁面底部。OAuth 授權碼流程見 `/admin/oauth-apps`。

<br/>

## 🧱 技術棧

```
┌──────────────────────────────────────────────────────────────────────┐
│  Nginx/直接 443 (TLS) ───► PM2 Node 127.0.0.1:3000                   │
│         ┌────────────────────────┴────────────────────────┐          │
│         │              Fastify 5 + TypeScript              │          │
│  /            ┌─ EJS 範本（HTMX 增量）+ Tailwind UI        │          │
│  /app         ├─ Toast UI Calendar 月/週/日                │          │
│  /caldav/*    ├─ RFC 4791 PROPFIND / REPORT / PUT          │          │
│  /ics/:tok    ├─ RFC 5545 ICS feed                         │          │
│  /api/*       ├─ REST (cookie / Bearer Token)              │          │
│  /oauth/*     ├─ OAuth 2.0 授權伺服器 (PKCE)               │          │
│  /admin/*     └─ 管理後台（含 /admin/update 自我更新）     │          │
│                                  ▼                                    │
│              PostgreSQL 16 + Drizzle ORM (~20 張表)                  │
└──────────────────────────────────────────────────────────────────────┘
```

| 端 | 技術 |
|---|---|
| 伺服端 | TypeScript + Fastify 5 + EJS + HTMX + Tailwind CSS · Drizzle ORM + PostgreSQL 16 |
| 行事曆 UI | Toast UI Calendar 2.x |
| 身分 | bcrypt + @simplewebauthn/server + otplib + 自建 OIDC client + OAuth 2.0 server |
| 推播 | web-push (VAPID) + @parse/node-apn (APNs) |
| 桌面端 | Kotlin + Compose Multiplatform（Skia 原生算繪） |
| iOS | Swift / SwiftUI |
| Android | Kotlin / Jetpack Compose |

所有第三方前端相依（HTMX / Toast UI / SimpleWebAuthn / Tailwind）已在地化打包，中國大陸伺服器直裝無 CDN 依賴。

<br/>

## 📂 儲存庫結構

```
by-wave-calendar/
├── src/                  伺服端（TypeScript + Fastify）
│   ├── server.ts         應用程式進入點
│   ├── routes/           REST API（events / calendars / ics / push / search …）
│   ├── web/              網頁 + 後台路由（admin / caldav / sso / oauth / webauthn …）
│   ├── lib/              業務邏輯（caldav / ical / sso / mfa / booking / webhooks / i18n …）
│   ├── db/               Drizzle schema + client
│   ├── views/            EJS 範本（app / admin / auth / booking / invite …）
│   ├── public/           前端靜態資源（含在地化的第三方程式庫）
│   └── styles/           Tailwind 輸入
├── apps/
│   ├── ios/              Swift / SwiftUI 用戶端
│   ├── android/          Kotlin / Compose 用戶端（+ releases/ 版本清單）
│   └── desktop/          Compose Multiplatform 桌面端（+ releases/ 版本清單）
├── deploy/
│   ├── bt-panel/         寶塔部署：install.sh / nginx 範例 / ecosystem.config.cjs / README
│   └── android-release.md
├── docs/design/          設計文件（如 passkey 架構）
├── scripts/              建置 / 遷移 / 發佈 / i18n 檢查指令碼
├── drizzle/              資料庫遷移
└── test/                 vitest 測試
```

<br/>

## 🗺 Roadmap

- [x] 基礎行事曆 + 週期事件 + ICS + CalDAV
- [x] Passkey / MFA / 多 SSO / 應用程式密碼 / 登入紀錄 / 稽核
- [x] PWA + 多主題 + 使用者層級外觀
- [x] 邀請協作 + 事件 RSVP + 預約連結 (booking) + 多平台加入
- [x] 管理員後台 + 一鍵自我更新 + 資料備份還原
- [x] 第三方 Bearer API + Webhooks
- [x] OAuth 2.0 授權伺服器（授權碼 + PKCE）
- [x] i18n（8 種語言）伺服端 + iOS + Android + 桌面端
- [x] Web Push + iOS APNs 通知
- [x] 原生 iOS / Android / 桌面端用戶端（macOS DMG / Windows MSI / Linux DEB）
- [ ] 複雜 RRULE / VTIMEZONE 完整支援
- [ ] OAuth refresh token

<br/>

## 🤝 貢獻

PRs welcome。本機開發：

```bash
npm install
npm run dev          # 建置資產 + tsx watch
npm run typecheck    # tsc --noEmit
npm run db:generate  # 改 schema 後產生 SQL 遷移
npm run db:migrate   # 套用遷移到資料庫
npm run i18n:check   # 檢查各語言翻譯涵蓋率
npm run test         # vitest
npm run build        # 生產建置（terser 壓縮到 src/public/_built/）
```

程式碼風格：TypeScript strict + ESM-only + 用 Drizzle 寫 SQL。各用戶端建置說明見對應 `apps/*/README.md`。

<br/>

## 📄 License

[MIT](LICENSE) — 想怎麼用就怎麼用，記得保留版權聲明。

<br/>

<div align="center">

<sub>這是<strong>我們自己的開源專案</strong>，不是 fork。覺得好用給個 ⭐ 支持。<br/>
GitHub: <a href="https://github.com/wuha-like-sleep/by-wave-calendar">wuha-like-sleep/by-wave-calendar</a>
 · Gitee 鏡像: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a></sub>

</div>
