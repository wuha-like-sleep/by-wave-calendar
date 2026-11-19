// PushService.swift
// APNs registration + handling of incoming silent pushes.
//
// SwiftUI doesn't have a native "register for remote notifications"
// hook, so we bridge through a tiny UIApplicationDelegate (attached
// via @UIApplicationDelegateAdaptor in ByWaveCalendarApp).
//
// Flow:
//   1. APP launches → AppDelegate calls application.registerForRemoteNotifications()
//   2. iOS issues a device token → didRegisterForRemoteNotifications fires
//   3. We send the token to /api/v1/devices/me/push-token
//   4. When server fires silent push → didReceiveRemoteNotification fires
//      while APP is backgrounded, giving us up to 30s to do background work
//   5. We post a Notification through NotificationCenter that CalendarView
//      observes, triggering a foreground-style reload on next visibility

import Foundation
import UIKit
import UserNotifications

// Posted when an incoming silent push tells us the server has changed
// data. CalendarView listens for this and reloads.
extension Notification.Name {
    static let bwcRemoteDataChanged = Notification.Name("bwc.remoteDataChanged")
}

final class PushService: NSObject, UIApplicationDelegate {
    // Singleton — UIApplicationDelegateAdaptor needs a default-constructable
    // class but we want one instance for the app lifetime. Static var pulls
    // double duty.
    static var shared: PushService?

    override init() {
        super.init()
        PushService.shared = self
    }

    // Reference to AppState set after launch — used to look up the
    // server URL + access token for the push-token POST. Without this
    // we'd register the token before the user has even signed in, and
    // we'd have nowhere to send it.
    weak var appState: AppState?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // We don't ask for alert permission — silent push doesn't need it
        // (and LocalNotifications.swift already asks when the user enables
        // visible alerts in Settings). Just register for remote pushes.
        application.registerForRemoteNotifications()
        return true
    }

    // iOS hands us the new APNs token. Forward it to the server so it can
    // address pushes to this device. Called multiple times in the app
    // lifecycle — once on first launch, again any time iOS rotates the
    // token (uninstall/reinstall, switch SIM, etc.).
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await uploadToken(tokenHex) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Most common cause: simulator without push support, no entitlement,
        // or device offline. Not fatal — APP works fine without push.
        print("[push] register failed: \(error.localizedDescription)")
    }

    // Silent push arrived. iOS gives us ~30s to do background work; we
    // re-fetch events (so the cache is warm next time the user opens
    // the APP) and post a notification so any visible CalendarView
    // re-renders immediately.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // Post the notification on main; CalendarView is bound to it
        // via Combine in body / .onReceive. We tag with userInfo so
        // listeners can do more sophisticated routing later (currently
        // they all just call load(force: true)).
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .bwcRemoteDataChanged,
                object: nil,
                userInfo: userInfo as? [String: Any] ?? [:],
            )
        }
        // Background fetch — best-effort. We don't have an easy hook to
        // wait for CalendarView's load() to complete (it lives in SwiftUI
        // view state), so signal "no new data" and let the visible APP
        // do the actual work. Future: move event fetch into an
        // AppState-owned service so we can fetch here directly.
        completionHandler(.noData)
    }

    // Ask iOS to (re-)issue the device token. Registration first runs
    // at launch — usually BEFORE the user has signed in, in which case
    // uploadToken has no session to upload with and the token goes
    // nowhere until the next cold launch. AppState calls this once a
    // sign-in is known-good (bootstrap / completePairing); iOS answers
    // with a fresh didRegisterForRemoteNotifications, which uploads.
    func reregister() {
        // registerForRemoteNotifications is main-thread API; callers
        // sit in async contexts, so hop explicitly.
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // Tell the server to drop this device session's push token
    // (POST push-token with null — the unregister form of the same
    // endpoint). Called on user-initiated sign-out: without it the
    // server keeps addressing silent pushes to a signed-out account
    // until the device row is revoked or APNs reports the token stale.
    //
    // The request is built synchronously from a credentials snapshot
    // on purpose: sign-out immediately retires the local refresh token
    // and access token, so an APIClient call deferred into a Task
    // would find no session left to authenticate with. Best-effort —
    // if the snapshotted access token has already expired the clear
    // fails and APNs feedback cleans the stale token up later.
    func clearServerToken(serverURL: URL, accessToken: String) {
        guard let url = APIClient.makeURL(server: serverURL, path: "/devices/me/push-token") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{\"pushToken\":null}".utf8)
        Task {
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    // POST /api/v1/devices/me/push-token. Best-effort; failures are
    // logged but never surface to the user — they don't know they
    // expected a push registration.
    private func uploadToken(_ token: String) async {
        guard let appState else { return }
        guard appState.serverURL != nil else {
            // Not signed in yet. Re-try once we are — the upload will
            // happen automatically on the next remote-notification
            // registration (iOS reissues tokens periodically anyway).
            return
        }
        do {
            let client = APIClient(state: appState)
            struct Body: Encodable { let pushToken: String }
            struct Response: Decodable { let ok: Bool }
            let _: Response = try await client.post("/devices/me/push-token", body: Body(pushToken: token))
        } catch {
            print("[push] upload failed: \(error.localizedDescription)")
        }
    }
}
