<p align="center"><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <b>繁體中文</b></p>

<div align="center">

<img src="src/public/icons/icon-512.png" alt="ByWave Calendar" width="104" height="104" />

# ByWave Calendar

**自架的行事曆共享平台**

一個網域同時搞定 **網頁 / PWA / iOS / Android / 桌面端**，
以及 **CalDAV · ICS 訂閱 · SSO · 第三方 API** 標準出口 —— 資料在自己伺服器上，不鎖定任何 SaaS。

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/wuha-like-sleep/by-wave-calendar?label=server&color=2563eb)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20iOS%20·%20Android%20·%20macOS%20·%20Windows%20·%20Linux-6366f1.svg)](#-下載用戶端)
[![Node](https://img.shields.io/badge/Node-≥22.12.0-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[線上 Demo](https://rl.lz-ss.com) · [下載用戶端](#-下載用戶端) · [功能](#-功能) · [一鍵部署](#-一鍵部署到寶塔) · [架構](#-技術棧) · [Gitee 鏡像](https://gitee.com/zhaorunsen/by-wave-calendar)

</div>

---

## 這是什麼

ByWave Calendar 是一個**跑在自己伺服器上的行事曆共享平台**。一個網域同時提供：

- 一個現代的**網頁行事曆**（可裝成 PWA），帶站內通知、一句話建日程、深色模式
- 原生 **iOS / Android / macOS / Windows / Linux** 用戶端，支援離線編輯
- 標準協定出口：**CalDAV** 雙向同步、**ICS** 訂閱發佈、**REST API**

適合個人、團隊、小型組織自建一套「不依賴任何外部 SaaS、可控、可備份」的行事曆。所有第三方前端資源都已在地化打包，**中國大陸伺服器可直接安裝、無國外 CDN 依賴**。MIT 開源。

<br/>

## 📸 截图

<table>
<tr>
<td colspan="2"><img src="docs/screenshots/calendar-week.png" alt="網頁行事曆週檢視" /><br/><sub><b>網頁行事曆 · 週檢視</b> —— 頂部一句話快速新增（說清時間地點即可成會），右上角通知鈴鐺帶未讀數</sub></td>
</tr>
<tr>
<td width="55%"><img src="docs/screenshots/landing.png" alt="首頁" /><br/><sub><b>首頁</b> —— 公開首頁，功能與下載入口一屏看清</sub></td>
<td width="45%" align="center"><img src="docs/screenshots/ios-day.png" alt="iOS 用戶端" width="270" /><br/><sub><b>iOS 原生用戶端</b> —— 日檢視，系統行事曆經 CalDAV 雙向同步</sub></td>
</tr>
<tr>
<td width="55%"><img src="docs/screenshots/notifications.png" alt="站內通知收件匣" /><br/><sub><b>站內通知收件匣（深色模式）</b> —— 預約、邀請、事件變更與安全動態集中一處，點擊直達對應頁面</sub></td>
<td width="45%"><img src="docs/screenshots/embed-widget.png" alt="可嵌入元件" /><br/><sub><b>可嵌入的唯讀行事曆元件</b>（<code>/embed/&lt;token&gt;</code>），放進任意網頁的 iframe</sub></td>
</tr>
</table>

> 想直接上手可以看 [線上 Demo](https://rl.lz-ss.com)。

<br/>

## 📥 下載用戶端

目前各端版本：

| 平台 | 版本 | 下載 |
|---|---|---|
| 🌐 Web / PWA | — | 用瀏覽器開啟你的 ByWave 伺服器即可，支援裝到桌面 / 主畫面 |
| 📱 iOS | v1.8.0 | [App Store](https://apps.apple.com/us/app/bywavecalendar/id6772655143) · [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX) |
| 🤖 Android | v0.13.2 | [APK 直連](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.13.2/bywave-calendar-0.13.2.apk) · [歷次版本](https://github.com/wuha-like-sleep/by-wave-calendar/releases) |
| 🍎 macOS | v1.3.3 | [DMG (Apple Silicon)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-arm64-signed.dmg) / [DMG (Intel)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64-signed.dmg) |
| 🪟 Windows | v1.3.3 | [MSI (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64.msi) |
| 🐧 Linux | v1.2.0 | [DEB (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.2.0/bywave-calendar_1.2.0_amd64.deb) |

桌面端 1.3.3 的下載與校驗清單見 [GitHub 發行頁](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.3.3)。Mac 兩種架構均已簽名並公證；Windows 安裝程式尚未簽名。

Gitee 鏡像：[桌面端 1.3.3](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.3.3) · [Android 0.13.2](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-android-v0.13.2) · [服務端 1.9.2](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-v1.9.2)。每個發行版均提供 SHA-256 校驗清單。Linux 本次保持 1.2.0。
Windows / macOS 雙向行事曆接入見 [系統行事曆設定](docs/system-calendar-sync.md)。

<div align="center">

[![App Store](https://img.shields.io/badge/iOS-App%20Store-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)
[![Download APK](https://img.shields.io/badge/Android-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.13.2/bywave-calendar-0.13.2.apk)
[![Download DMG](https://img.shields.io/badge/macOS-DMG-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-arm64-signed.dmg)
[![Download MSI](https://img.shields.io/badge/Windows-MSI-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64.msi)

</div>

**Android 首次安裝提示**：首次安裝需在系統設定裡允許對應來源安裝應用程式；後續可在 App 內檢查和下載更新，安裝時仍需系統確認。

**桌面端**：用 [Compose Multiplatform](apps/desktop/README.md) 實作，**不是瀏覽器套殼** —— Skia 原生算繪，Mac / Win / Linux 一份 Kotlin 程式碼出三平台，自帶 Sparkle 風格 in-place 自動更新。詳見 [apps/desktop/README.md](apps/desktop/README.md)。

<br/>

## ✨ 功能

### 行事曆與事件

- 📅 網頁行事曆（Toast UI Calendar）月 / 週 / 日檢視，拖曳建事件、點格快速新增，精簡編輯器，行動裝置自適應
- 🗣 **一句話建日程**：輸入「明天下午三點開會，兩小時」即可自動解析時間、時長與重複，中 / 英 / 日 / 韓四種語言都懂
- 🔁 週期事件（RRULE / RFC 5545 展開），事件提醒（reminders）
- 🔍 全站搜尋 + `Cmd+K` 命令面板，跨自有 + 共享行事曆查事件
- 📍 **地址聯想**：地點輸入自動補全 —— 本地地址簿記住用過的地址並依習慣排序，本地比對不夠時有線上建議兜底（基於 OpenStreetMap 資料）
- 📴 **離線編輯**：iOS / Android / 桌面端斷網也能建 / 改 / 刪，先落本地、連網後依序同步，衝突逐條人工裁決
- 📲 PWA：一鍵裝到桌面 / 主畫面，離線殼快取，新版本自動彈窗提示

### 同步與互通

- 🔄 **CalDAV 雙向同步**（RFC 4791 + RFC 6578 增量同步）：iOS 系統行事曆、Apple Calendar.app、Synology 直接登入 `https://你的網域/caldav/` 加帳號
- 📤 **ICS 訂閱發佈**（RFC 5545）：每個行事曆產生不變的唯讀連結，丟給 Google / Apple / Outlook 當「訂閱行事曆」
- 📥 **ICS 匯入**：檔案 / URL 一次性 / URL 週期訂閱 / 貼上文字，四種方式
- 🧩 **可嵌入元件**：唯讀行事曆 widget（`/embed/<token>`），iframe 嵌到任意網頁

### 協作與通知

- 👥 **行事曆邀請**：以電子郵件邀請協作者，接受後行事曆進入對方帳號
- 🙋 **事件邀請與 RSVP**：受邀者在電子郵件或各用戶端的邀請收件匣裡回覆「參加 / 可能 / 不參加」，還能**建議改期**（提出新時間、主辦人一鍵接受）；一鍵加到 Google / Apple / ByWave
- 🗓 **預約連結 (booking)**：發佈每週可預約時段（網頁端視覺化編輯），對方在公開頁選時間約你，自動建立帶參與者的事件；預約可查看、可取消
- 🔔 **站內通知**：導覽列鈴鐺 + 收件匣，預約、邀請、事件變更、安全動態都進 inbox，點擊直達對應頁面；重要通知再經瀏覽器推播（Web Push / iOS APNs）

### 認證與安全

- 🔐 電子郵件+密碼 + **Passkey (WebAuthn)** + **TOTP MFA** + 多 **SSO** 供應商（OIDC / Keycloak / Okta / Google Workspace）
- 🛡 失敗鎖定 + 陌生裝置電子郵件驗證碼 + Passkey/MFA/密碼變更電子郵件提醒 + 登入紀錄 + 稽核日誌
- 🔑 **應用程式密碼**：CalDAV / 用戶端登入不暴露主密碼

### 整合與擴充

- 🔌 **第三方 REST API + 自助 Token**：一般使用者在「設定 → API Token」自助建立（密碼 + MFA 二次驗證、預設唯讀、帶用量統計 / 依令牌限流 / 安全輪換），不用再找管理員；Zoom / Notion / n8n / 內部系統直接讀寫行事曆
- 🔓 **OAuth 2.0 授權伺服器**（授權碼 + PKCE）：讓外部 app 經使用者授權代呼叫 API
- 🪝 **Webhooks**：事件變更推送到外部端點，帶投遞紀錄

### 維運與客製

- ⚙️ **管理後台**：站台名稱 / Logo / SMTP / SSO / 安全政策 / 主題 / API / Webhook / 稽核
- ♻️ **一鍵自我更新**：後台點一下檢查 + 立即更新，帶即時進度條 + 自動重啟重新整理，支援分階段推送與最低支援版本
- 💾 **資料備份 / 還原**：後台全表匯出 / 匯入，附帶 round-trip 自我檢查指令碼
- 🎨 **主題與深色模式**：7 套品牌色 + 2 種密度 + 深色模式（跟隨系統 / 淺色 / 深色三檔，切換無白閃），**每位使用者**單獨設定偏好
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

<details>
<summary><b>首次設定順序</b>（部署後在網頁裡設定，不進程式碼儲存庫）</summary>

1. 資料庫連線 —— `.env` 裡填一次
2. 電子郵件 SMTP —— `/admin/smtp`
3. 站台名稱 / Logo / ICP / 註冊政策 —— `/admin/site`、`/admin/logo`
4. SSO 供應商 —— `/admin/sso`（可加多個 OIDC，登入頁同時顯示多個按鈕）
5. 安全政策 —— `/admin/security`
6. 第三方 API / OAuth —— `/admin/api`、`/admin/oauth-apps`

</details>

<br/>

## 🔌 第三方 API 範例

Token 在「設定 → API Token」自助建立（管理員也可在 `/admin/api` 簽發）：

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
│              PostgreSQL 16 + Drizzle ORM (39 張表)                   │
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
├── docs/                 開發、部署、設計與發佈文件
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
- [x] 站內通知收件匣 + 瀏覽器推播
- [x] 自助 API Token（用量統計 / 依令牌限流 / 安全輪換）
- [x] 事件邀請改期建議 + 用戶端邀請收件匣
- [x] 用戶端離線編輯佇列
- [x] 地址聯想（本地地址簿 + 線上建議）
- [x] 深色模式（跟隨系統 / 淺色 / 深色三檔）
- [ ] 複雜 RRULE / VTIMEZONE 完整支援
- [ ] OAuth refresh token

<br/>

## 🤝 貢獻

[開發、部署和發佈文件](docs/README.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

資料庫遷移須依手寫遷移流程操作，不能直接執行 `db:generate`。 [drizzle/README.md](drizzle/README.md)

PRs welcome。本機開發：

```bash
npm ci
npm run dev          # 建置資產 + tsx watch
npm run check        # 型別、單元/整合測試、翻譯完整性
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
 · Gitee 鏡像: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a>
 · 線上 Demo: <a href="https://rl.lz-ss.com">rl.lz-ss.com</a></sub>

</div>
