// ScannerView.swift
// AVFoundation QR scanner wrapped in SwiftUI. No external dep — uses the
// system AVCaptureSession + AVCaptureMetadataOutput directly.
//
// v1.3.1: added a proper viewfinder. Before this, the whole preview was
// scannable but there was no visual cue showing where to point — users
// had to guess. Now we mask everything outside a centered square,
// draw corner brackets, and animate a scan line inside it. Matches
// the iOS Camera app's QR UI.
//
// Calls back with the decoded string OR a user-friendly error.

import SwiftUI
import AVFoundation

enum ScanResult {
    case success(String)
    case failure(String)
}

struct ScannerView: View {
    let onResult: (ScanResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permissionDenied = false
    @State private var torchOn = false
    @State private var scanLinePhase: CGFloat = 0

    // Viewfinder side length as a fraction of the SMALLER screen dimension.
    // 0.70 matches the visual proportion of iOS Camera's QR cutout.
    private let frameFraction: CGFloat = 0.70

    var body: some View {
        ZStack {
            if permissionDenied {
                permissionDeniedView
            } else {
                CameraPreview(
                    onResult: { raw in onResult(.success(raw)) },
                    onError: { _ in onResult(.failure("相机初始化失败".loc)) },
                    torchOn: $torchOn,
                )
                .ignoresSafeArea()

                viewfinderOverlay

                topBar
                hintLabel
            }
        }
        .task {
            await requestPermission()
        }
    }

    // MARK: - Permission denied
    private var permissionDeniedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill").font(.system(size: 48))
            Text("没有相机权限").font(.headline)
            Text("打开 设置 → 隐私 → 相机 → ByWaveCalendar，开启权限后回到 APP 重试。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("关闭") { dismiss() }.buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.9))
        .foregroundStyle(.white)
    }

    // MARK: - Viewfinder
    // 1) Four black-translucent rectangles forming a hole in the middle.
    // 2) Corner brackets (8pt thick, 28pt long) at the four corners of
    //    the hole — the universal "scan-here" affordance.
    // 3) A horizontal accent-colored scan line that loops top↔bottom.
    private var viewfinderOverlay: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height) * frameFraction
            let leftover = (geo.size.height - side) / 2
            let sideMargin = (geo.size.width - side) / 2

            ZStack {
                // Dim mask with a square hole. Done as 4 rectangles so we
                // don't depend on `.reverseMask` (iOS 17+) or compositing
                // tricks that interact badly with `.ignoresSafeArea`.
                VStack(spacing: 0) {
                    Color.black.opacity(0.5).frame(height: leftover)
                    HStack(spacing: 0) {
                        Color.black.opacity(0.5).frame(width: sideMargin)
                        Color.clear.frame(width: side, height: side)
                        Color.black.opacity(0.5).frame(width: sideMargin)
                    }
                    .frame(height: side)
                    Color.black.opacity(0.5).frame(height: leftover)
                }
                .ignoresSafeArea()

                // Faint outline around the cutout — helps when the
                // background is also dark (e.g. dim room, the brackets
                // alone disappear into the photo)
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.white.opacity(0.35), lineWidth: 1)
                    .frame(width: side, height: side)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)

                // Corner brackets
                CornerBrackets(side: side, color: .white)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)

                // Animated scan line (only while we haven't fired)
                ScanLine(side: side, phase: scanLinePhase)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
        }
        .onAppear {
            // Loop the scan-line vertical position 0 → 1 → 0 forever.
            // .repeatForever doesn't reverse automatically, so use a
            // SwiftUI animation with `.autoreverses: true`.
            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                scanLinePhase = 1
            }
        }
    }

    // MARK: - Top bar (close + torch)
    private var topBar: some View {
        VStack {
            HStack {
                Button {
                    dismiss()
                    onResult(.failure("已取消".loc))
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.white.opacity(0.9))
                        .padding()
                }
                Spacer()
                Button {
                    torchOn.toggle()
                    UISelectionFeedbackGenerator().selectionChanged()
                } label: {
                    Image(systemName: torchOn ? "bolt.fill" : "bolt")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.95))
                        .frame(width: 40, height: 40)
                        .background(.black.opacity(0.45), in: Circle())
                        .padding()
                }
            }
            Spacer()
        }
    }

    // MARK: - Hint below the viewfinder
    private var hintLabel: some View {
        VStack {
            Spacer()
            Text("将二维码放入框内 — 自动识别")
                .font(.callout)
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(.black.opacity(0.5), in: Capsule())
                .padding(.bottom, 60)
        }
    }

    private func requestPermission() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            if !ok { permissionDenied = true }
        case .denied, .restricted:
            permissionDenied = true
        @unknown default:
            permissionDenied = true
        }
    }
}

// MARK: - Viewfinder pieces

/// Four L-shaped brackets drawn at the corners of a centered square.
/// Pure SwiftUI shapes so the brackets crisp-pixel-snap at any scale.
private struct CornerBrackets: View {
    let side: CGFloat
    let color: Color
    private let armLength: CGFloat = 26
    private let thickness: CGFloat = 4

    var body: some View {
        ZStack {
            // Each bracket = two thin rounded rectangles meeting at the corner.
            // Built as a single Path for crisp, hairline-free corners.
            BracketShape(armLength: armLength, thickness: thickness)
                .fill(color)
                .frame(width: side, height: side)
        }
    }
}

private struct BracketShape: Shape {
    let armLength: CGFloat
    let thickness: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let t = thickness
        let L = armLength
        // Top-left
        p.addRoundedRect(in: CGRect(x: rect.minX, y: rect.minY, width: L, height: t),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        p.addRoundedRect(in: CGRect(x: rect.minX, y: rect.minY, width: t, height: L),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        // Top-right
        p.addRoundedRect(in: CGRect(x: rect.maxX - L, y: rect.minY, width: L, height: t),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        p.addRoundedRect(in: CGRect(x: rect.maxX - t, y: rect.minY, width: t, height: L),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        // Bottom-left
        p.addRoundedRect(in: CGRect(x: rect.minX, y: rect.maxY - t, width: L, height: t),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        p.addRoundedRect(in: CGRect(x: rect.minX, y: rect.maxY - L, width: t, height: L),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        // Bottom-right
        p.addRoundedRect(in: CGRect(x: rect.maxX - L, y: rect.maxY - t, width: L, height: t),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        p.addRoundedRect(in: CGRect(x: rect.maxX - t, y: rect.maxY - L, width: t, height: L),
                         cornerSize: CGSize(width: t / 2, height: t / 2))
        return p
    }
}

/// Thin glowing line that sweeps vertically inside the viewfinder. Pure
/// visual signal that the scanner is "live" — users intuitively understand
/// "if it's moving, it's working."
private struct ScanLine: View {
    let side: CGFloat
    let phase: CGFloat  // 0 = top, 1 = bottom

    var body: some View {
        let inset: CGFloat = 8
        let usable = side - inset * 2
        let y = -side / 2 + inset + usable * phase
        return Capsule()
            .fill(
                LinearGradient(
                    colors: [
                        Color.accentColor.opacity(0.0),
                        Color.accentColor.opacity(0.85),
                        Color.accentColor.opacity(0.0),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing,
                ),
            )
            .frame(width: side - inset * 2, height: 2)
            .shadow(color: .accentColor.opacity(0.6), radius: 4)
            .offset(y: y)
    }
}

// UIKit-backed camera preview + metadata recognition. The SwiftUI side
// just hands us callbacks; we wire AVCaptureSession + AVCaptureVideoPreviewLayer.
private struct CameraPreview: UIViewControllerRepresentable {
    let onResult: (String) -> Void
    let onError: (Error) -> Void
    @Binding var torchOn: Bool

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIViewController(context: Context) -> CameraVC {
        let vc = CameraVC()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: CameraVC, context: Context) {
        vc.setTorch(torchOn)
    }

    final class Coordinator: NSObject, CameraVCDelegate {
        let onResult: (String) -> Void
        var hasFired = false
        init(onResult: @escaping (String) -> Void) { self.onResult = onResult }
        func cameraVC(_ vc: CameraVC, didScan code: String) {
            // Fire once — the metadata callback can repeat dozens of times
            // a second once a QR is in frame.
            if hasFired { return }
            hasFired = true
            // Haptic confirm before we dismiss.
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onResult(code)
        }
    }
}

protocol CameraVCDelegate: AnyObject {
    func cameraVC(_ vc: CameraVC, didScan code: String)
}

final class CameraVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    weak var delegate: CameraVCDelegate?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var captureDevice: AVCaptureDevice?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        captureDevice = device
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        // AVCaptureSession.startRunning is blocking — run on a background queue.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            session.stopRunning()
        }
        // Make sure the torch is off when we leave — otherwise it stays
        // lit when the user backs out to settings.
        setTorch(false)
    }

    /// Toggle the device torch. Silently no-ops on devices without one
    /// (front camera, iPad without flash) so SwiftUI doesn't have to
    /// branch.
    func setTorch(_ on: Bool) {
        guard let device = captureDevice, device.hasTorch else { return }
        do {
            try device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        } catch {
            // Swallow — losing the torch isn't worth interrupting a scan.
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let raw = obj.stringValue
        else { return }
        delegate?.cameraVC(self, didScan: raw)
    }
}
