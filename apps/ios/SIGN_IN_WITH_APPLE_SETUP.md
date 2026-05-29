# Sign in with Apple — setup checklist

The Swift client code for "Sign in with Apple" is committed (see
`ByWaveCalendar/Auth/AppleSignIn.swift` + the button in
`ByWaveCalendar/Views/SetupView.swift`). The button will not function
until the three steps below are done — they require the Apple Developer
console, Xcode, and the server, none of which can be edited from the
code repo.

**App bundle id:** `cn.bywave.calendar`
**App version with this feature:** `1.5.0`

---

## 1. Apple Developer console — enable the capability on the App ID

1. Sign in at <https://developer.apple.com/account/resources/identifiers/list>.
2. Open the identifier for **`cn.bywave.calendar`** (Certificates,
   Identifiers & Profiles → Identifiers).
3. Under **Capabilities**, tick **Sign in with Apple**.
   - Leave it as the default "Enable as a primary App ID" (we are not
     grouping it under a parent App ID).
4. Click **Save** and confirm the capability change.
5. If you use manually-managed provisioning profiles, regenerate the
   profile so it picks up the new entitlement. (Xcode's automatic
   signing does this for you — see step 2.)

> Note: the **Primary App ID** is what the server's
> `SIWA_CLIENT_IDS` must match (step 3). For a native iOS app that is
> the bundle id, `cn.bywave.calendar`.

---

## 2. Xcode — add the capability to the target

1. Open `apps/ios/ByWaveCalendar.xcodeproj` in Xcode.
2. Select the **ByWaveCalendar** target → **Signing & Capabilities** tab.
3. Make sure the **Team** is set and **Automatically manage signing**
   is on (so Xcode regenerates the profile with the new entitlement).
4. Click **+ Capability** (top-left of the tab) and add
   **Sign in with Apple**.
   - This adds `com.apple.developer.applesignin = [Default]` to
     `ByWaveCalendar.entitlements`. Do **not** hand-edit the
     entitlements file — let Xcode write it so the signing stays valid.
5. Build to a real device or simulator and confirm the entitlement
   resolves without a signing error.

> If `AppleSignIn.swift` shows as not part of the target (it was added
> to `project.pbxproj` by hand), verify it appears under
> **Target → Build Phases → Compile Sources**. It should already be
> there; if not, drag `ByWaveCalendar/Auth/AppleSignIn.swift` into the
> target.

---

## 3. Server — configure the allowed client id

The server route `POST /api/v1/auth/apple` returns
`503 apple_signin_not_configured` until the audience (`aud`) it should
accept in Apple's identity token is set. For the native app that
audience is the bundle id.

Set the environment variable on the server (Baota / `.env`):

```
SIWA_CLIENT_IDS=cn.bywave.calendar
```

- Comma-separate if you ever ship more than one bundle id
  (e.g. a separate Catalyst id): `SIWA_CLIENT_IDS=cn.bywave.calendar,cn.bywave.calendar.mac`.
- Restart the server after setting it.
- Also confirm **APP 登录 (appsEnabled)** is turned **on** in
  `/admin/api#apps` — otherwise every native login (Apple included)
  returns `403 apps_disabled`.

Verify it's live by opening `https://<your-server>/api/v1/health/app`
and checking the server starts without the
`apple_signin_not_configured` warning in its logs.

---

## How the client behaves before setup is complete

- The button shows on the login screen whenever a server URL is known
  (it is gated on `ServerCapabilities.hasAppleSignIn`, which is
  optimistic for servers that don't yet report the `appleSignIn`
  capability flag).
- If the server lacks `SIWA_CLIENT_IDS`, the user sees a friendly
  banner: *"该服务器尚未启用 Apple 登录…"* (mapped from the 503).
- If APP login is disabled, they see the existing *"管理员未启用 APP
  同步功能"* banner.

So nothing crashes if you ship the app before finishing step 3 — but
the button won't sign anyone in until the server is configured.
