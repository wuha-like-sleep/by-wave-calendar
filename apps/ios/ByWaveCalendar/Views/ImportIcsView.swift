// ImportIcsView.swift
// Confirmation sheet for importing a .ics file — handed over by the
// system ("Open in ByWave") or picked in CalendarView's fileImporter.
// Pick the target calendar, preview the counts, confirm, see the
// result: the same two steps as the web import dialog and the Android
// import screen, on the /api/v1 import endpoints. Switching the
// target calendar voids the preview, like the web.

import SwiftUI

struct ImportIcsView: View {
    @EnvironmentObject var state: AppState

    let fileURL: URL
    let calendars: [CalendarMeta]
    /// Called with true when events were actually imported (the
    /// caller reloads its event list), false on plain dismissal.
    let onFinished: (Bool) -> Void

    private enum Phase {
        case reading, ready, previewing, previewed, importing, done, failed
    }

    private enum Failure {
        case read, tooLarge, notIcs, message(String)

        var text: String {
            switch self {
            case .read: return "读不到这个文件".loc
            case .tooLarge: return "文件过大（超过 8 MB）".loc
            case .notIcs: return "这个文件不是日历文件（.ics）".loc
            case .message(let m): return m
            }
        }
    }

    /// Server-side cap, mirrored from src/lib/ics_limits.ts
    /// (MAX_ICS_IMPORT_BYTES) — checked on the raw bytes before the
    /// text is even decoded.
    private static let maxBytes = 8 * 1024 * 1024

    @State private var phase: Phase = .reading
    @State private var failure: Failure?
    /// True when the failure came from a preview/import API call and
    /// the file's text is still in hand — the failure view can then
    /// offer a retry that returns to the form instead of forcing the
    /// user to re-pick the file from scratch.
    @State private var failureRetryable = false
    @State private var filename: String?
    @State private var text: String?
    @State private var selectedCalendarId: String?
    @State private var preview: IcsImportPreview?
    @State private var result: IcsImportResult?

    private var busy: Bool { phase == .previewing || phase == .importing }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .reading:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed:
                    failureView
                case .done:
                    doneView
                default:
                    form
                }
            }
            .navigationTitle("导入日程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { onFinished(false) }
                        .disabled(busy)
                }
            }
        }
        .task {
            selectedCalendarId = calendars.first?.id
            await read()
        }
    }

    // MARK: - States

    private var failureView: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(failure?.text ?? "导入失败，请稍后再试".loc)
                .multilineTextAlignment(.center)
            if failureRetryable {
                // Back to the form with the same file + calendar: a
                // preview failure lands on 预览, an import failure on
                // 确认导入 (the preview is still in state).
                Button("重试") {
                    phase = preview != nil ? .previewed : .ready
                }
                .buttonStyle(.borderedProminent)
                Button("完成") { onFinished(false) }
                    .buttonStyle(.bordered)
            } else {
                Button("完成") { onFinished(false) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var doneView: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 34))
                .foregroundStyle(.green)
            if let r = result {
                Text("导入完成：新增 %lld · 更新 %lld · 跳过 %lld".locFormat(r.inserted, r.updated, r.skipped))
                    .multilineTextAlignment(.center)
            }
            Button("完成") { onFinished(true) }
                .buttonStyle(.borderedProminent)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var form: some View {
        List {
            if let filename {
                Section {
                    Label(filename, systemImage: "doc")
                        .foregroundStyle(.secondary)
                }
            }
            Section("选择要导入到的日历") {
                if calendars.isEmpty {
                    Text("还没有日历，先创建一个日历再导入")
                        .foregroundStyle(.secondary)
                }
                ForEach(calendars) { cal in
                    Button {
                        selectCalendar(cal.id)
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hex: cal.color) ?? .accentColor)
                                .frame(width: 12, height: 12)
                            Text(cal.name)
                                .foregroundStyle(.primary)
                            Spacer()
                            if selectedCalendarId == cal.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .disabled(busy)
                }
            }
            if let p = preview {
                Section {
                    Text("共 %lld 条：新增 %lld · 更新 %lld · 重复 %lld · 无效 %lld"
                        .locFormat(p.total, p.inserted, p.updated, p.duplicates, p.invalid))
                }
                if p.invalid > 0 {
                    Section("无效条目") {
                        ForEach(Array(p.invalidReasons.enumerated()), id: \.offset) { _, reason in
                            Text(reason)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            actionButton
                .padding()
                .background(.bar)
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if busy {
            Button {} label: {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(phase == .importing ? "正在导入…".loc : "正在计算…".loc)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(true)
        } else if phase == .previewed {
            Button {
                Task { await runImport() }
            } label: {
                Text("确认导入").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(selectedCalendarId == nil)
        } else {
            Button {
                Task { await runPreview() }
            } label: {
                Text("预览").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(selectedCalendarId == nil || calendars.isEmpty)
        }
    }

    // MARK: - Actions

    private func selectCalendar(_ id: String) {
        guard selectedCalendarId != id else { return }
        selectedCalendarId = id
        // The preview was computed against another calendar — void it.
        if phase == .previewed || phase == .previewing {
            preview = nil
            phase = .ready
        }
    }

    private func read() async {
        let url = fileURL
        let data = await Task.detached(priority: .userInitiated) { () -> Data? in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return try? Data(contentsOf: url)
        }.value
        guard let data else { fail(.read); return }
        if data.count > Self.maxBytes { fail(.tooLarge); return }
        // Lossy UTF-8 decode — same stance as the server (Node's
        // Buffer.toString replaces invalid sequences rather than
        // rejecting the file).
        let content = String(decoding: data, as: UTF8.self)
        // Same cheap pre-check the web dialog does before uploading.
        if !content.localizedCaseInsensitiveContains("BEGIN:VCALENDAR") { fail(.notIcs); return }
        text = content
        filename = url.lastPathComponent
        phase = .ready
    }

    private func runPreview() async {
        guard let text, let calId = selectedCalendarId else { return }
        phase = .previewing
        do {
            let p = try await APIClient(state: state)
                .previewIcsImport(calendarId: calId, text: text, filename: filename)
            preview = p
            phase = .previewed
        } catch {
            failAPI(error)
        }
    }

    private func runImport() async {
        guard let text, let calId = selectedCalendarId else { return }
        phase = .importing
        do {
            let r = try await APIClient(state: state)
                .importIcs(calendarId: calId, text: text, filename: filename)
            result = r
            phase = .done
        } catch {
            failAPI(error)
        }
    }

    private func fail(_ f: Failure) {
        failure = f
        failureRetryable = false
        phase = .failed
    }

    private func failAPI(_ error: Error) {
        if let api = error as? APIError, case .server(let status, _) = api {
            if status == 413 { fail(.tooLarge); return }
            if status == 400 { fail(.notIcs); return }
        }
        // Anything else here (network drop, 5xx, auth refresh hiccup)
        // is transient by nature and the file text is still in state —
        // let the user retry in place. The 413/400 mappings above are
        // properties of the file itself, so retrying them is pointless
        // and they stay on the non-retryable path.
        failure = .message((error as? APIError)?.localizedDescription ?? "导入失败，请稍后再试".loc)
        failureRetryable = text != nil
        phase = .failed
    }
}
