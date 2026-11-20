// PendingOpsView.swift
// 离线队列的指示条 + 队列页。
//
// 队列里两种条目：
//   · 待同步——还没送到服务端，网络恢复自动重放，这里只展示；
//   · 待处理——被服务端明确拒绝（版本冲突 / 校验失败之类），自动
//     重试没意义，用户逐条裁决：保留我的修改（重新入队再打一次）/
//     采用服务端版本 / 放弃。

import SwiftUI

/// 日历页顶上的指示条。有待处理时优先报待处理（要用户动手），
/// 否则报待同步数量。队列空了整条不显示。
struct PendingSyncBarView: View {
    @ObservedObject var service: OfflineSyncService
    let onTap: () -> Void

    var body: some View {
        if !service.ops.isEmpty {
            Button(action: onTap) {
                HStack(spacing: 8) {
                    Image(systemName: service.attentionCount > 0
                        ? "exclamationmark.triangle.fill" : "icloud.slash")
                    Text(service.attentionCount > 0
                        ? "%lld 项改动需要你处理".locFormat(Int64(service.attentionCount))
                        : "%lld 项改动待同步".locFormat(Int64(service.pendingCount)))
                        .font(.footnote.weight(.medium))
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(service.attentionCount > 0 ? Color.orange : Color.secondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(Color(.secondarySystemBackground))
            }
            .buttonStyle(.plain)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

struct PendingOpsView: View {
    @EnvironmentObject private var state: AppState
    /// 裁决完通知呈现方刷新一次（采用服务端版本 / 放弃要靠一次拉取
    /// 把本地行覆盖回正）。
    let onResolved: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PendingOpsListContent(service: state.offlineSync, onResolved: onResolved)
                .navigationTitle("待同步".loc)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成".loc) { dismiss() }
                    }
                }
        }
    }
}

/// 设置页里的入口点进去的页面（已经在导航栈里，不再套一层）。
struct PendingOpsPage: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        PendingOpsListContent(service: state.offlineSync, onResolved: {})
            .navigationTitle("待同步".loc)
            .navigationBarTitleDisplayMode(.inline)
    }
}

struct PendingOpsListContent: View {
    @ObservedObject var service: OfflineSyncService
    let onResolved: () -> Void

    var body: some View {
        Group {
            if service.ops.isEmpty {
                ContentUnavailableView {
                    Label("全部已同步".loc, systemImage: "checkmark.icloud")
                } description: {
                    Text("离线时做的改动会先保存在这台设备上，网络恢复后自动发送。".loc)
                }
            } else {
                List(service.ops) { op in
                    PendingOpRow(op: op) { resolution in
                        Task {
                            await service.resolveAttention(opId: op.id, resolution: resolution)
                            onResolved()
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
    }
}

private struct PendingOpRow: View {
    let op: PendingOp
    let onResolve: (AttentionResolution) -> Void

    private var kindLabel: String {
        switch op.kind {
        case .create: return "新建事件".loc
        case .update: return "修改事件".loc
        case .delete: return "删除事件".loc
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(op.summary.isEmpty ? kindLabel : op.summary)
                .font(.body.weight(.medium))
                .lineLimit(2)
            Text(kindLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            if op.state == .attention {
                Text(op.errorMessage?.isEmpty == false ? op.errorMessage!
                    : "服务端拒绝了这项改动。".loc)
                    .font(.footnote)
                    .foregroundStyle(.red)
                HStack(spacing: 12) {
                    Button("保留我的修改".loc) { onResolve(.keepMine) }
                        .font(.footnote.weight(.semibold))
                    Button("采用服务端版本".loc) { onResolve(.useServer) }
                        .font(.footnote.weight(.semibold))
                    Button("放弃".loc, role: .destructive) { onResolve(.discard) }
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.borderless)
            } else {
                Text("待同步，网络恢复后自动发送".loc)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
