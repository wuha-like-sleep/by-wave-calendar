<p align="center"><a href="README.md">简体中文</a> | <b>English</b> | <a href="README.zh-TW.md">繁體中文</a></p>

<div align="center">

<img src="src/public/icons/icon-512.png" alt="ByWave Calendar" width="96" height="96" />

# ByWave Calendar

**A self-hosted calendar-sharing platform · one domain serves Web / PWA / iOS / Android / Desktop / ICS feeds / CalDAV / SSO / third-party API**

<br/>

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/wuha-like-sleep/by-wave-calendar?label=server&color=2563eb)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20iOS%20·%20Android%20·%20macOS%20·%20Windows%20·%20Linux-6366f1.svg)](#-download)
[![Node](https://img.shields.io/badge/Node-≥20-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/wuha-like-sleep/by-wave-calendar/pulls)

[Live Demo](https://rl.lz-ss.com) · [Download](#-download) · [Features](#-features) · [Self-host](#-self-host-on-aapanel) · [Architecture](#-tech-stack)

</div>

---

## What is this

ByWave Calendar is a **calendar-sharing platform that runs on your own server**. A single domain serves all of:

- A modern **web calendar** (installable as a PWA)
- Native **iOS / Android / macOS / Windows** clients
- Standard protocol endpoints: two-way **CalDAV** sync, **ICS** feed publishing, and a **REST API**

It is built for individuals, teams, and small organisations who want a calendar that **depends on no external SaaS, stays under their control, and is easy to back up**. All third-party front-end assets are bundled locally, so it **installs directly on servers in mainland China with no foreign CDN dependency**. MIT-licensed.

<br/>

## 📸 Screenshots

<table>
<tr>
<td width="62%"><img src="docs/screenshots/landing.png" alt="Web" /><br/><sub>Web · landing</sub></td>
<td width="38%"><img src="docs/screenshots/ios-day.png" alt="iOS" /><br/><sub>Native iOS app</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/screenshots/embed-widget.png" alt="Embed" /><br/><sub>Embeddable read-only widget (<code>/embed/&lt;token&gt;</code>, drop into any page via iframe)</sub></td>
</tr>
</table>

> Prefer clicking around? Try the [live demo](https://rl.lz-ss.com).

<br/>

## 📥 Download

Current client versions:

| Platform | Version | Download |
|---|---|---|
| 🌐 Web / PWA | — | Just open your ByWave server in a browser; can be installed to the desktop / home screen |
| 📱 iOS | v1.6.2 | [App Store](https://apps.apple.com/us/app/bywavecalendar/id6772655143) · [TestFlight Beta](https://testflight.apple.com/join/rkM3hkpX) |
| 🤖 Android | v0.11.1 | [Direct APK](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.11.1/bywave-calendar-0.11.1.apk) · [All releases](https://github.com/wuha-like-sleep/by-wave-calendar/releases) |
| 🍎 macOS | v1.0.17 | [DMG (Apple Silicon)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-arm64.dmg) — Apple-notarised |
| 🪟 Windows | v1.0.17 | [MSI (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-x64.msi) |
| 🐧 Linux | v1.0.17 | [DEB (x64)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/bywave-calendar_1.0.17_amd64.deb) |

<div align="center">

[![App Store](https://img.shields.io/badge/iOS-App%20Store-000000?logo=apple&logoColor=white&style=for-the-badge)](https://apps.apple.com/us/app/bywavecalendar/id6772655143)
[![Download APK](https://img.shields.io/badge/Android-APK-22c55e?logo=android&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/android-v0.11.1/bywave-calendar-0.11.1.apk)
[![Download DMG](https://img.shields.io/badge/macOS-DMG-000000?logo=apple&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-arm64.dmg)
[![Download MSI](https://img.shields.io/badge/Windows-MSI-0078d4?logo=windows&logoColor=white&style=for-the-badge)](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.0.17/ByWaveCalendar-1.0.17-x64.msi)

</div>

**Android first-install note**: on first install you must allow "install unknown apps from this source" once in system settings — a one-time grant. After that, the app updates itself in-app, with no re-download needed.

**Desktop**: built with [Compose Multiplatform](apps/desktop/README.md), **not a browser wrapper** — native Skia rendering, one Kotlin codebase producing Mac / Windows / Linux builds, with Sparkle-style in-place auto-update. See [apps/desktop/README.md](apps/desktop/README.md) for details.

<br/>

## ✨ Features

**Calendars & events**
- 📅 Web calendar (Toast UI Calendar) with month / week / day views, drag-to-create events, click-a-cell quick add, and a responsive mobile layout
- 🔁 Recurring events (RRULE / RFC 5545 expansion) and event reminders
- 🔍 Global search + a `Cmd+K` command palette that finds events across your own and shared calendars
- 📲 PWA: install to desktop / home screen in one click, offline shell caching, automatic prompt when a new version is available

**Sync & interop**
- 🔄 **Two-way CalDAV sync** (RFC 4791): add an account directly at `https://your-domain/caldav/` from the iOS system calendar, Apple Calendar.app, or Synology
- 📤 **ICS feed publishing** (RFC 5545): every calendar gets a stable read-only link you can drop into Google / Apple / Outlook as a "subscribed calendar"
- 📥 **ICS import**: four ways — file, one-off URL, recurring URL subscription, or pasted text

**Collaboration**
- 👥 **Calendar invites**: invite collaborators by email; once accepted, the calendar appears in their account
- 🙋 **Event RSVP**: invites carry "Yes / No / Maybe" plus one-click add to Google / Apple / ByWave
- 🗓 **Booking links**: publish weekly available slots; others pick a time on a public page to book you, automatically creating an event with attendees

**Auth & security**
- 🔐 Email + password, plus **Passkey (WebAuthn)**, **TOTP MFA**, and multiple **SSO** providers (OIDC / Keycloak / Okta / Google Workspace)
- 🛡 Lockout on failed attempts, email verification codes for unrecognised devices, email alerts on Passkey/MFA/password changes, login history, and audit logs
- 🔑 **App passwords**: CalDAV / client logins never expose your main password

**Integrations & API**
- 🔌 **Third-party REST API**: admin issues Bearer tokens so Zoom / Notion / n8n / internal systems can read and write calendars directly
- 🔓 **OAuth 2.0 authorization server** (authorization code + PKCE): let external apps call the API on a user's behalf with their consent
- 🪝 **Webhooks**: push event changes to external endpoints, with delivery records
- 🔔 **Web Push** (VAPID / RFC 8030) + iOS APNs push notifications

**Ops & customization**
- ⚙️ **Admin console**: site name / logo / SMTP / SSO / security policy / themes / API / webhooks / audit
- ♻️ **One-click self-update**: check + update right from the console, with a live progress bar plus automatic restart and refresh
- 💾 **Data backup / restore**: full-table export / import from the console, with a round-trip self-check script
- 🎨 **Multiple themes**: 7 brand colours + 2 densities, configurable **per user**
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

**First-time configuration order** (configured in the web UI after deploy, not in the code repo):

1. Database connection — set once in `.env`
2. Email SMTP — `/admin/smtp`
3. Site name / logo / ICP / registration policy — `/admin/site`, `/admin/logo`
4. SSO providers — `/admin/sso` (you can add multiple OIDC providers; the login page shows a button for each)
5. Security policy — `/admin/security`
6. Third-party API / OAuth — `/admin/api`, `/admin/oauth-apps`

<br/>

## 🔌 API example

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
│              PostgreSQL 16 + Drizzle ORM (~20 tables)               │
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
├── docs/design/          Design docs (e.g. passkey architecture)
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
- [ ] Full complex RRULE / VTIMEZONE support
- [ ] OAuth refresh tokens

<br/>

## 🤝 Contributing

PRs welcome. Local development:

```bash
npm install
npm run dev          # build assets + tsx watch
npm run typecheck    # tsc --noEmit
npm run db:generate  # generate SQL migrations after a schema change
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
 · Gitee mirror: <a href="https://gitee.com/zhaorunsen/by-wave-calendar">zhaorunsen/by-wave-calendar</a></sub>

</div>
