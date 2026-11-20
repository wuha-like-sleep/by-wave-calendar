<p align="center"><a href="README.md">简体中文</a> | <b>English</b> | <a href="README.zh-TW.md">繁體中文</a></p>

<div align="center">

<img src="src/public/icons/icon-512.png" alt="ByWave Calendar" width="104" height="104" />

# ByWave Calendar

**A self-hosted calendar-sharing platform**

One domain serves **Web / PWA / iOS / Android / Desktop**,
plus standard **CalDAV · ICS feeds · SSO · third-party API** endpoints — your data stays on your own server, locked into no SaaS.

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/wuha-like-sleep/by-wave-calendar?label=server&color=2563eb)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20iOS%20·%20Android%20·%20macOS%20·%20Windows%20·%20Linux-6366f1.svg)](#-download)
[![Node](https://img.shields.io/badge/Node-≥22.12.0-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[Live Demo](https://rl.lz-ss.com) · [Download](#-download) · [Features](#-features) · [Self-host](#-self-host-on-aapanel) · [Architecture](#-tech-stack) · [Gitee mirror](https://gitee.com/zhaorunsen/by-wave-calendar)

</div>

---

## What is this

ByWave Calendar is a **calendar-sharing platform that runs on your own server**. A single domain serves all of:

- A modern **web calendar** (installable as a PWA), with an in-app notification inbox, one-sentence event creation, and dark mode
- Native **iOS / Android / macOS / Windows / Linux** clients, with offline editing
- Standard protocol endpoints: two-way **CalDAV** sync, **ICS** feed publishing, and a **REST API**

It is built for individuals, teams, and small organisations who want a calendar that **depends on no external SaaS, stays under their control, and is easy to back up**. All third-party front-end assets are bundled locally, so it **installs directly on servers in mainland China with no foreign CDN dependency**. MIT-licensed.

<br/>

## 📸 Screenshots

<table>
<tr>
<td colspan="2"><img src="docs/screenshots/calendar-week.png" alt="Web calendar, week view" /><br/><sub><b>Web calendar · week view</b> — one-sentence quick add at the top (just say the time and place), notification bell with an unread count</sub></td>
</tr>
<tr>
<td width="55%"><img src="docs/screenshots/landing.png" alt="Landing page" /><br/><sub><b>Landing page</b> — features and downloads on one screen</sub></td>
<td width="45%" align="center"><img src="docs/screenshots/ios-day.png" alt="iOS app" width="270" /><br/><sub><b>Native iOS app</b> — day view; the system calendar syncs two-way over CalDAV</sub></td>
</tr>
<tr>
<td width="55%"><img src="docs/screenshots/notifications.png" alt="Notification inbox" /><br/><sub><b>Notification inbox (dark mode)</b> — bookings, invitations, event changes, and security events in one place, each click opening the relevant page</sub></td>
<td width="45%"><img src="docs/screenshots/embed-widget.png" alt="Embed widget" /><br/><sub><b>Embeddable read-only widget</b> (<code>/embed/&lt;token&gt;</code>), drop into any page via iframe</sub></td>
</tr>
</table>

> Prefer clicking around? Try the [live demo](https://rl.lz-ss.com).

<br/>

## 📥 Download

Current client versions:

| Platform | Version | Download |
|---|---|---|
| 🌐 Web / PWA | — | Just open your ByWave server in a browser; can be installed to the desktop / home screen |
| 📱 iOS | v1.8.0 | [App Store](https://apps.apple.com/us/app/bywavecalendar/id6772655143) · [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX) |
| 🤖 Android | v0.13.2 | [Direct APK](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.13.2/bywave-calendar-0.13.2.apk) · [All releases](https://github.com/wuha-like-sleep/by-wave-calendar/releases) |
| 🍎 macOS | v1.3.3 | [DMG (Apple Silicon)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-arm64-signed.dmg) / [DMG (Intel)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64-signed.dmg) |
| 🪟 Windows | v1.3.3 | [MSI (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64.msi) |
| 🐧 Linux | v1.2.0 | [DEB (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.2.0/bywave-calendar_1.2.0_amd64.deb) |

Downloads and SHA-256 checklists for desktop 1.3.3 are on the [GitHub release page](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.3.3). Both macOS builds are signed and notarised; the Windows installer is not yet signed.

Gitee mirror: [Desktop 1.3.3](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.3.3) · [Android 0.13.2](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-android-v0.13.2) · [Server 1.9.2](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-v1.9.2). Every release ships a SHA-256 checklist. Linux stays at 1.2.0 this round.
Two-way sync with the Windows / macOS system calendars is covered in [System calendar setup](docs/system-calendar-sync.md).

<div align="center">

[![App Store](https://img.shields.io/badge/iOS-App%20Store-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)
[![Download APK](https://img.shields.io/badge/Android-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.13.2/bywave-calendar-0.13.2.apk)
[![Download DMG](https://img.shields.io/badge/macOS-DMG-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-arm64-signed.dmg)
[![Download MSI](https://img.shields.io/badge/Windows-MSI-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.3.3/ByWaveCalendar-1.3.3-x64.msi)

</div>

**Android first-install note**: on first install you must allow installs from the corresponding source in system settings; afterwards the app can check for and download updates in-app, with the system still confirming each install.

**Desktop**: built with [Compose Multiplatform](apps/desktop/README.md), **not a browser wrapper** — native Skia rendering, one Kotlin codebase producing Mac / Windows / Linux builds, with Sparkle-style in-place auto-update. See [apps/desktop/README.md](apps/desktop/README.md) for details.

<br/>

## ✨ Features

### Calendars & events

- 📅 Web calendar (Toast UI Calendar) with month / week / day views, drag-to-create events, click-a-cell quick add, a compact editor, and a responsive mobile layout
- 🗣 **One-sentence event creation**: type "meeting tomorrow at 3pm for two hours" and the time, duration, and recurrence are parsed for you — in Chinese, English, Japanese, and Korean
- 🔁 Recurring events (RRULE / RFC 5545 expansion) and event reminders
- 🔍 Global search + a `Cmd+K` command palette that finds events across your own and shared calendars
- 📍 **Address suggestions**: the location field autocompletes — a local address book remembers places you have used and ranks them by your habits, with online suggestions (based on OpenStreetMap data) as a fallback when local matches run out
- 📴 **Offline editing**: the iOS / Android / desktop clients keep working offline — creates, edits, and deletes land locally first and replay in order on reconnect, with conflicts resolved item by item
- 📲 PWA: install to desktop / home screen in one click, offline shell caching, automatic prompt when a new version is available

### Sync & interop

- 🔄 **Two-way CalDAV sync** (RFC 4791 + RFC 6578 incremental sync): add an account directly at `https://your-domain/caldav/` from the iOS system calendar, Apple Calendar.app, or Synology
- 📤 **ICS feed publishing** (RFC 5545): every calendar gets a stable read-only link you can drop into Google / Apple / Outlook as a "subscribed calendar"
- 📥 **ICS import**: four ways — file, one-off URL, recurring URL subscription, or pasted text
- 🧩 **Embed widget**: a read-only calendar widget (`/embed/<token>`) you can iframe into any web page

### Collaboration & notifications

- 👥 **Calendar invites**: invite collaborators by email; once accepted, the calendar appears in their account
- 🙋 **Event invitations & RSVP**: invitees reply Yes / Maybe / No from email or the invitations inbox in every client, and can **propose a new time** that the organiser accepts in one click; one-click add to Google / Apple / ByWave
- 🗓 **Booking links**: publish weekly available slots (edited visually on the web); others pick a time on a public page to book you, automatically creating an event with attendees; bookings can be viewed and cancelled
- 🔔 **In-app notifications**: a nav bell + inbox collects bookings, invitations, event changes, and security events, each click going to the relevant page; important ones are also delivered as browser push (Web Push / iOS APNs)

### Auth & security

- 🔐 Email + password, plus **Passkey (WebAuthn)**, **TOTP MFA**, and multiple **SSO** providers (OIDC / Keycloak / Okta / Google Workspace)
- 🛡 Lockout on failed attempts, email verification codes for unrecognised devices, email alerts on Passkey/MFA/password changes, login history, and audit logs
- 🔑 **App passwords**: CalDAV / client logins never expose your main password

### Integrations & API

- 🔌 **Third-party REST API + self-service tokens**: any user can create their own token under Settings → API Token (password + MFA step-up, read-only by default, with usage statistics, per-token rate limiting, and secure rotation) — no admin round-trip; Zoom / Notion / n8n / internal systems can then read and write calendars directly
- 🔓 **OAuth 2.0 authorization server** (authorization code + PKCE): let external apps call the API on a user's behalf with their consent
- 🪝 **Webhooks**: push event changes to external endpoints, with delivery records

### Ops & customization

- ⚙️ **Admin console**: site name / logo / SMTP / SSO / security policy / themes / API / webhooks / audit
- ♻️ **One-click self-update**: check + update right from the console, with a live progress bar plus automatic restart and refresh; supports staged rollout and a minimum supported version
- 💾 **Data backup / restore**: full-table export / import from the console, with a round-trip self-check script
- 🎨 **Themes & dark mode**: 7 brand colours + 2 densities + dark mode (follow system / light / dark, no white flash on switch), configurable **per user**
- 🌐 **i18n**: the server, iOS, Android, and desktop clients all support **8 languages** with runtime switching — Simplified Chinese / Traditional Chinese / English / Japanese / Korean / Spanish / French / German
- 🇨🇳 **China-friendly**: third-party front-end assets (HTMX / Toast UI / SimpleWebAuthn / Tailwind) are fully bundled locally, with no foreign CDN

<br/>

## 🚀 Self-host (on aaPanel)

> For servers in mainland China, using Gitee as the code source is recommended (GitHub is unreliable there). Every push to this repo is mirrored to both GitHub and Gitee.

```bash
# 1. SSH into the server
cd /www/wwwroot
git clone https://gitee.com/zhaorunsen/by-wave-calendar.git rl.lz-ss.com
cd rl.lz-ss.com

# 2. Copy .env.example -> .env, fill in DATABASE_URL + PUBLIC_BASE_URL
cp .env.example .env && vim .env

# 3. One-shot install (the first run creates .env and exits so you can edit it; run again to finish)
bash deploy/bt-panel/install.sh
```

`install.sh` automatically: installs dependencies (`npm ci --omit=dev`) -> runs database migrations -> uses `setcap` so Node can bind 80/443 -> interactively creates an admin -> starts via PM2.

After that, all future updates are done from the web UI: **Admin console -> Update -> Check for updates -> Update now** (live progress bar + automatic restart + automatic refresh).

📖 The full aaPanel deployment guide (SSL, hot certificate reload, backup/restore verification, CI deploy) is in **[deploy/bt-panel/README.md](deploy/bt-panel/README.md)**.

<details>
<summary><b>First-time configuration order</b> (configured in the web UI after deploy, not in the code repo)</summary>

1. Database connection — set once in `.env`
2. Email SMTP — `/admin/smtp`
3. Site name / logo / ICP / registration policy — `/admin/site`, `/admin/logo`
4. SSO providers — `/admin/sso` (you can add multiple OIDC providers; the login page shows a button for each)
5. Security policy — `/admin/security`
6. Third-party API / OAuth — `/admin/api`, `/admin/oauth-apps`

</details>

<br/>

## 🔌 API example

Create a token yourself under Settings → API Token (admins can also issue them from `/admin/api`):

```bash
# List all calendars for the user bound to the current token
curl -H "Authorization: Bearer bwc_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx" \
  https://rl.lz-ss.com/api/calendars

# Create an event (attendees are emailed automatically)
curl -X POST -H "Authorization: Bearer bwc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "calendarId":"<uuid>",
    "summary":"Team weekly sync",
    "startsAt":"2026-05-25T10:00:00Z",
    "endsAt":"2026-05-25T11:00:00Z",
    "allDay":false,
    "extra":{"attendees":["alice@example.com","bob@example.com"]}
  }' \
  https://rl.lz-ss.com/api/events
```

The full list of endpoints + curl examples is at the bottom of the `/admin/api` page. The OAuth authorization-code flow is documented under `/admin/oauth-apps`.

<br/>

## 🧱 Tech stack

```
┌──────────────────────────────────────────────────────────────────────┐
│  Nginx / direct 443 (TLS) ───► PM2 Node 127.0.0.1:3000              │
│         ┌────────────────────────┴────────────────────────┐          │
│         │              Fastify 5 + TypeScript              │          │
│  /            ┌─ EJS templates (HTMX partials) + Tailwind  │          │
│  /app         ├─ Toast UI Calendar month/week/day          │          │
│  /caldav/*    ├─ RFC 4791 PROPFIND / REPORT / PUT          │          │
│  /ics/:tok    ├─ RFC 5545 ICS feed                         │          │
│  /api/*       ├─ REST (cookie / Bearer token)              │          │
│  /oauth/*     ├─ OAuth 2.0 authorization server (PKCE)     │          │
│  /admin/*     └─ Admin console (incl. /admin/update)       │          │
│                                  ▼                                    │
│              PostgreSQL 16 + Drizzle ORM (39 tables)                 │
└──────────────────────────────────────────────────────────────────────┘
```

| Client | Stack |
|---|---|
| Server | TypeScript + Fastify 5 + EJS + HTMX + Tailwind CSS · Drizzle ORM + PostgreSQL 16 |
| Calendar UI | Toast UI Calendar 2.x |
| Auth | bcrypt + @simplewebauthn/server + otplib + custom OIDC client + OAuth 2.0 server |
| Push | web-push (VAPID) + @parse/node-apn (APNs) |
| Desktop | Kotlin + Compose Multiplatform (native Skia rendering) |
| iOS | Swift / SwiftUI |
| Android | Kotlin / Jetpack Compose |

All third-party front-end dependencies (HTMX / Toast UI / SimpleWebAuthn / Tailwind) are bundled locally, so servers in mainland China install with no CDN dependency.

<br/>

## 📂 Repo structure

```
by-wave-calendar/
├── src/                  Server (TypeScript + Fastify)
│   ├── server.ts         App entry point
│   ├── routes/           REST API (events / calendars / ics / push / search …)
│   ├── web/              Web + admin routes (admin / caldav / sso / oauth / webauthn …)
│   ├── lib/              Business logic (caldav / ical / sso / mfa / booking / webhooks / i18n …)
│   ├── db/               Drizzle schema + client
│   ├── views/            EJS templates (app / admin / auth / booking / invite …)
│   ├── public/           Front-end static assets (incl. locally bundled third-party libs)
│   └── styles/           Tailwind input
├── apps/
│   ├── ios/              Swift / SwiftUI client
│   ├── android/          Kotlin / Compose client (+ releases/ manifest)
│   └── desktop/          Compose Multiplatform desktop client (+ releases/ manifest)
├── deploy/
│   ├── bt-panel/         aaPanel deploy: install.sh / nginx sample / ecosystem.config.cjs / README
│   └── android-release.md
├── docs/                 Development, deployment, design and release docs
├── scripts/              Build / migrate / release / i18n-check scripts
├── drizzle/              Database migrations
└── test/                 vitest tests
```

<br/>

## 🗺 Roadmap

- [x] Core calendar + recurring events + ICS + CalDAV
- [x] Passkey / MFA / multi-SSO / app passwords / login history / audit
- [x] PWA + multiple themes + per-user appearance
- [x] Invite collaboration + event RSVP + booking links + multi-platform add
- [x] Admin console + one-click self-update + data backup/restore
- [x] Third-party Bearer API + Webhooks
- [x] OAuth 2.0 authorization server (authorization code + PKCE)
- [x] i18n (8 languages) across server + iOS + Android + desktop
- [x] Web Push + iOS APNs notifications
- [x] Native iOS / Android / desktop clients (macOS DMG / Windows MSI / Linux DEB)
- [x] In-app notification inbox + browser push
- [x] Self-service API tokens (usage statistics / per-token rate limiting / rotation)
- [x] Event-invitation time proposals + invitation inbox in the clients
- [x] Offline editing queue in the clients
- [x] Address suggestions (local address book + online fallback)
- [x] Dark mode (follow system / light / dark)
- [ ] Full complex RRULE / VTIMEZONE support
- [ ] OAuth refresh tokens

<br/>

## 🤝 Contributing

[Development, deployment and release docs](docs/README.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

Follow the manual migration workflow; do not run `db:generate` with the incomplete snapshot chain. [drizzle/README.md](drizzle/README.md)

PRs welcome. Local development:

```bash
npm ci
npm run dev          # build assets + tsx watch
npm run check        # types, unit/integration tests, translations
npm run db:migrate   # apply migrations to the database
npm run i18n:check   # check translation coverage per language
npm run test         # vitest
npm run build        # production build (terser-minified into src/public/_built/)
```

Code style: TypeScript strict + ESM-only + Drizzle for SQL. Per-client build instructions are in each `apps/*/README.md`.

<br/>

## 📄 License

[MIT](LICENSE) — use it however you like, just keep the copyright notice.

<br/>

<div align="center">

<sub>This is <strong>our own open-source project</strong>, not a fork. If you find it useful, a ⭐ is appreciated.<br/>
GitHub: <a href="https://github.com/wuha-like-sleep/by-wave-calendar">wuha-like-sleep/by-wave-calendar</a>
 · Gitee mirror: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a>
 · Live demo: <a href="https://rl.lz-ss.com">rl.lz-ss.com</a></sub>

</div>
