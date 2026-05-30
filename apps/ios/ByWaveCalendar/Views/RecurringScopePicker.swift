// RecurringScopePicker.swift
// Bottom-sheet style "三选一" for editing/deleting a recurring event:
//   仅此事件 / 此事件及后续 / 整个系列
// Matches the web client's UX so users get the same mental model.

import SwiftUI

enum RecurringAction {
    case edit
    case delete

    var title: String {
        self == .edit ? "保存重复事件" : "删除重复事件"
    }
    var subtitle: String {
        self == .edit ? "这是一个重复事件，请选择保存范围："
                      : "这是一个重复事件，请选择删除范围："
    }
    var perInstance: String { self == .edit ? "只修改这一次" : "只删除这一次" }
    var perFuture: String   { self == .edit ? "修改此次及之后" : "删除此次及之后" }
    var perSeries: String   { self == .edit ? "修改整个系列" : "删除整个系列" }
}

struct RecurringScopePicker: View {
    let action: RecurringAction
    let onPick: (RecurringScope) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(action.title.loc).font(.headline)
                Text(action.subtitle.loc).font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 12)

            VStack(spacing: 8) {
                pickButton(.instance, title: "仅此事件", detail: action.perInstance, systemImage: "1.circle")
                pickButton(.future,   title: "此事件及后续", detail: action.perFuture, systemImage: "arrow.right.to.line")
                pickButton(.series,   title: "整个系列", detail: action.perSeries, systemImage: "repeat",
                           tint: action == .delete ? .red : nil)
            }
            // NOTE: `title` / `detail` reach pickButton as plain String values,
            // so they're localized via `.loc` inside pickButton (not here).
            .padding(.horizontal, 16).padding(.bottom, 16)

            Button("取消", role: .cancel) { onCancel() }
                .padding(.bottom, 20)
        }
        .presentationDetents([.height(380)])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func pickButton(_ scope: RecurringScope, title: String, detail: String, systemImage: String, tint: Color? = nil) -> some View {
        Button {
            onPick(scope)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(tint ?? .accentColor)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.loc).font(.body.weight(.medium)).foregroundStyle(.primary)
                    Text(detail.loc).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Theme.fieldBackground, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
