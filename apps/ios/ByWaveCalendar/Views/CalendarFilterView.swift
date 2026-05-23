// CalendarFilterView.swift
// Sheet listing all the user's calendars with show/hide toggles. Hidden
// IDs are persisted in AppState.hiddenCalendarIds; CalendarView filters
// the event list through that set before rendering each sub-view.

import SwiftUI

struct CalendarFilterView: View {
    let calendars: [CalendarMeta]
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(calendars) { cal in
                        Toggle(isOn: visibilityBinding(for: cal.id)) {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Color(hex: cal.color) ?? .accentColor)
                                    .frame(width: 12, height: 12)
                                Text(cal.name)
                            }
                        }
                    }
                } header: {
                    Text("显示的日历")
                } footer: {
                    Text("关闭的日历事件不显示在日 / 周 / 月 / 年视图，但仍然存在 — 在网页或重新打开开关后即可看到。")
                        .font(.footnote)
                }

                if !state.hiddenCalendarIds.isEmpty {
                    Section {
                        Button("全部显示") {
                            state.hiddenCalendarIds.removeAll()
                        }
                    }
                }
            }
            .navigationTitle("筛选日历")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    // SwiftUI Toggle wants a binding. We translate "is this id visible"
    // to/from the hiddenCalendarIds set.
    private func visibilityBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { !state.hiddenCalendarIds.contains(id) },
            set: { isVisible in
                if isVisible {
                    state.hiddenCalendarIds.remove(id)
                } else {
                    state.hiddenCalendarIds.insert(id)
                }
            },
        )
    }
}
