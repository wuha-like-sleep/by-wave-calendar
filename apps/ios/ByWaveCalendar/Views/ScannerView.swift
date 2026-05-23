// ScannerView.swift
// AVFoundation QR scanner wrapped in SwiftUI. No external dep — uses the
// system AVCaptureSession + AVCaptureMetadataOutput directly.
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

    var body: some View {
        ZStack {
            if permissionDenied {
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
            } else {
                CameraPreview(onResult: { raw in
                    onResult(.success(raw))
                }, onError: { _ in
                    onResult(.failure("相机初始化失败"))
                })
                    .ignoresSafeArea()
                VStack {
                    HStack {
                        Button {
                            dismiss()
                            onResult(.failure("已取消"))
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(.white.opacity(0.9))
                                .padding()
                        }
                        Spacer()
                    }
                    Spacer()
                    Text("对准网页上的二维码")
                        .font(.callout)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.black.opacity(0.45), in: Capsule())
                        .padding(.bottom, 60)
                }
            }
        }
        .task {
            await requestPermission()
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

// UIKit-backed camera preview + metadata recognition. The SwiftUI side
// just hands us callbacks; we wire AVCaptureSession + AVCaptureVideoPreviewLayer.
private struct CameraPreview: UIViewControllerRepresentable {
    let onResult: (String) -> Void
    let onError: (Error) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIViewController(context: Context) -> CameraVC {
        let vc = CameraVC()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: CameraVC, context: Context) {}

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

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
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
