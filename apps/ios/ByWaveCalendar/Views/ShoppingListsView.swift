// ShoppingListsView.swift
// Shopping lists — the native twin of the Web /shopping-lists pages.
// A list is standalone or linked to one event. The detail page's
// settings rename, re-link (a picker over the calendar window's
// events, like the Web detail page's select), unlink, and delete;
// the event editor's shopping section can link from the other side
// too. Items are ticked off in place; after a toggle / move
// the detail is re-fetched so order and counts match the server.

import SwiftUI

struct ShoppingListsView: View {
    @EnvironmentObject var state: AppState

    @State private var lists: [ShoppingListDTO]?
    @State private var loading = false
    @State private var errorMessage: String?

    @State private var newTitle = ""
    @State private var creating = false
    @State private var createError: String?

    var body: some View {
        Form {
            if loading && lists == nil {
                Section {
                    ProgressView().controlSize(.small)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                    Button("重试") { Task { await reload() } }
                }
            }

            if let lists {
                Section("我的清单") {
                    if lists.isEmpty {
                        Text("还没有购买清单——在下方建一张吧。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(lists) { list in
                        NavigationLink {
                            ShoppingListDetailView(listId: list.id)
                        } label: {
                            listRow(list)
                        }
                    }
                }
            }

            Section("新建清单") {
                TextField("例如：周末烧烤采购", text: $newTitle)
                if let createError {
                    Text(createError).foregroundStyle(.red).font(.callout)
                }
                Button {
                    Task { await create() }
                } label: {
                    HStack {
                        if creating { ProgressView().controlSize(.small) }
                        Text("创建清单")
                    }
                }
                .disabled(creating || newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .navigationTitle("购买清单")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
    }

    @ViewBuilder
    private func listRow(_ list: ShoppingListDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(list.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                if list.isAllDone {
                    Text("已买齐")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.green.opacity(0.15), in: Capsule())
                        .foregroundStyle(Color.green)
                }
            }
            if list.totalCount > 0 {
                Text("已买 %1$lld/%2$lld".locFormat(list.doneCount, list.totalCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let eventSummary = list.eventSummary {
                Text(eventSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Networking

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            lists = try await APIClient(state: state).listShoppingLists()
            errorMessage = nil
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func create() async {
        creating = true
        createError = nil
        defer { creating = false }
        do {
            _ = try await APIClient(state: state).createShoppingList(
                title: newTitle.trimmingCharacters(in: .whitespaces),
                eventId: nil,
            )
            newTitle = ""
            await reload()
        } catch {
            createError = shoppingErrorText(error)
        }
    }
}

// MARK: - 清单详情

struct ShoppingListDetailView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let listId: String

    @State private var detail: ShoppingListDetailDTO?
    @State private var loading = false
    @State private var errorMessage: String?

    // Add-item form
    @State private var newName = ""
    @State private var newQuantity = ""
    @State private var newUnit = ""
    @State private var newNote = ""
    @State private var adding = false
    @State private var addError: String?

    // Item edit / delete
    @State private var editItem: ShoppingListItemDTO?
    @State private var deleteItemCandidate: ShoppingListItemDTO?

    // List settings
    @State private var renameTitle = ""
    @State private var renaming = false
    @State private var settingsError: String?
    @State private var showDeleteListAlert = false
    @State private var deleting = false
    @State private var showLinkPicker = false
    @State private var linkCandidates: [EventDTO]?
    @State private var linking = false

    var body: some View {
        Form {
            if loading && detail == nil {
                Section {
                    ProgressView().controlSize(.small)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                    Button("重试") { Task { await reload() } }
                }
            }

            if let detail {
                itemsSection(detail)
                addItemSection()
                settingsSection(detail.list)
            }
        }
        .navigationTitle(detail?.list.title ?? "购买清单".loc)
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert(
            "删除".loc,
            isPresented: Binding(
                get: { deleteItemCandidate != nil },
                set: { if !$0 { deleteItemCandidate = nil } },
            ),
        ) {
            Button("取消", role: .cancel) { deleteItemCandidate = nil }
            Button("删除", role: .destructive) {
                if let item = deleteItemCandidate { Task { await deleteItem(item) } }
                deleteItemCandidate = nil
            }
        } message: {
            Text("确定删除这个条目？")
        }
        .alert("删除这张清单".loc, isPresented: $showDeleteListAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                Task { await deleteList() }
            }
        } message: {
            Text("确定删除这张清单？里面的条目会一并删除。")
        }
        .sheet(item: $editItem) { item in
            ShoppingItemEditSheet(
                item: item,
                onSave: { name, quantity, unit, note in
                    editItem = nil
                    Task { await saveItem(item, name: name, quantity: quantity, unit: unit, note: note) }
                },
                onCancel: { editItem = nil },
            )
            .environmentObject(state)
        }
        .sheet(isPresented: $showLinkPicker) {
            linkPickerSheet
                .environmentObject(state)
        }
    }

    /// 改绑选择器：候选是日历宽窗口（前 2 个月 / 后 13 个月，与
    /// CalendarView 同一窗口）里的事件，按开始时间倒序、同一系列
    /// 只留一行（窗口里是展开后的 occurrence 行），上限 100 ——
    /// 与 Web 详情页那个 select 的口径尽量对齐（Web 是全量最近
    /// 100 条，客户端受窗口所限）。第一行恒为「不关联事件」。
    @ViewBuilder
    private var linkPickerSheet: some View {
        NavigationStack {
            List {
                if let list = detail?.list {
                    Section {
                        Button {
                            Task { await setLink(list, eventId: nil) }
                        } label: {
                            HStack {
                                Text("不关联事件")
                                Spacer()
                                if list.eventId == nil {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                    Section {
                        if linkCandidates == nil {
                            ProgressView().controlSize(.small)
                        } else {
                            ForEach(linkCandidates ?? [], id: \.id) { ev in
                                Button {
                                    Task { await setLink(list, eventId: ev.id) }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ev.summary).lineLimit(1)
                                            Text(linkCandidateDate(ev))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if list.eventId == ev.id {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("关联事件（可选）")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { showLinkPicker = false }
                }
            }
        }
    }

    private func linkCandidateDate(_ ev: EventDTO) -> String {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateStyle = .medium
        f.timeStyle = .none
        // 全天事件的 startsAt 是 UTC 午夜，按 UTC 读日期才不会
        // 在 UTC 以西错到前一天（与 AllDayDates 同一条纪律）。
        if ev.allDay { f.timeZone = TimeZone(identifier: "UTC") }
        return f.string(from: ev.startsAt)
    }

    // MARK: - Sections

    @ViewBuilder
    private func itemsSection(_ detail: ShoppingListDetailDTO) -> some View {
        Section {
            if detail.list.totalCount > 0 {
                // 进度条和区头「已买 x/y」是同一个数的两种读法：数字
                // 给确切值，条给一眼进度。勾选后的重拉走动画事务
                // （见 reload(animated:)），条会平滑地涨过去而不是跳。
                ProgressView(
                    value: Double(detail.list.doneCount),
                    total: Double(detail.list.totalCount),
                )
            }
            if detail.items.isEmpty {
                Text("这张清单还是空的——在下方添加第一件要买的东西。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(detail.items) { item in
                itemRow(item)
            }
        } header: {
            if detail.list.totalCount > 0 {
                Text("已买 %1$lld/%2$lld".locFormat(detail.list.doneCount, detail.list.totalCount))
            }
        }
    }

    @ViewBuilder
    private func itemRow(_ item: ShoppingListItemDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                Button {
                    Task { await toggleDone(item) }
                } label: {
                    Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(item.done ? Color.green : Color.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("标记已买 / 未买".loc)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .font(.body)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? .secondary : .primary)
                    if let sub = itemSubtitle(item) {
                        Text(sub)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Spacer()
                Button {
                    Task { await move(item, direction: "up") }
                } label: {
                    Text("上移").font(.callout)
                }
                .buttonStyle(.borderless)
                Button {
                    Task { await move(item, direction: "down") }
                } label: {
                    Text("下移").font(.callout)
                }
                .buttonStyle(.borderless)
                Button {
                    editItem = item
                } label: {
                    Text("编辑").font(.callout)
                }
                .buttonStyle(.borderless)
                Button(role: .destructive) {
                    deleteItemCandidate = item
                } label: {
                    Text("删除").font(.callout)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    /// "数量 单位 · 备注" line under the item name; nil when the item
    /// carries none of the three.
    private func itemSubtitle(_ item: ShoppingListItemDTO) -> String? {
        var parts: [String] = []
        if let quantity = item.quantity {
            var text = ShoppingQuantity.format(quantity)
            if let unit = item.unit, !unit.isEmpty { text += " " + unit }
            parts.append(text)
        } else if let unit = item.unit, !unit.isEmpty {
            parts.append(unit)
        }
        if let note = item.note, !note.isEmpty { parts.append(note) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func addItemSection() -> some View {
        Section("添加条目") {
            TextField("例如：番茄", text: $newName)
            HStack {
                Text("数量")
                Spacer()
                TextField("数量", text: $newQuantity)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 90)
            }
            HStack {
                Text("单位")
                Spacer()
                TextField("单位", text: $newUnit)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 120)
            }
            HStack {
                Text("备注")
                Spacer()
                TextField("备注", text: $newNote)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 160)
            }
            if let addError {
                Text(addError).foregroundStyle(.red).font(.callout)
            }
            Button {
                Task { await addItem() }
            } label: {
                HStack {
                    if adding { ProgressView().controlSize(.small) }
                    Text("添加条目")
                }
            }
            .disabled(adding || newName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    @ViewBuilder
    private func settingsSection(_ list: ShoppingListDTO) -> some View {
        Section("清单设置") {
            HStack {
                TextField("标题", text: $renameTitle)
                Button {
                    Task { await rename(list) }
                } label: {
                    if renaming {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("重命名")
                    }
                }
                .buttonStyle(.borderless)
                .disabled(renaming || renameTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            LabeledContent("关联事件（可选）") {
                if list.eventId != nil {
                    // eventSummary is nil when the linked event was
                    // deleted — show a dash rather than the raw id.
                    Text(list.eventSummary ?? "—")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("不关联事件").foregroundStyle(.secondary)
                }
            }
            Button("更改关联") {
                showLinkPicker = true
                Task { await loadLinkCandidates() }
            }
            .disabled(linking)
            if let settingsError {
                Text(settingsError).foregroundStyle(.red).font(.callout)
            }
            Button(role: .destructive) {
                showDeleteListAlert = true
            } label: {
                HStack {
                    if deleting { ProgressView().controlSize(.small) }
                    Text("删除这张清单")
                }
            }
            .disabled(deleting)
        }
    }

    // MARK: - Networking

    private func reload(animated: Bool = false) async {
        loading = true
        defer { loading = false }
        do {
            let fresh = try await APIClient(state: state).getShoppingList(id: listId)
            // 勾选 / 排序这类用户刚刚亲手触发的变更，重拉结果落进
            // 动画事务：勾变绿、删除线、上移下移都平滑过渡，而不是
            // 整页数据啪地换一茬。首次加载和下拉刷新不走动画。
            if animated && !reduceMotion {
                withAnimation(.easeInOut(duration: 0.25)) {
                    detail = fresh
                    renameTitle = fresh.list.title
                }
            } else {
                detail = fresh
                renameTitle = fresh.list.title
            }
            errorMessage = nil
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func toggleDone(_ item: ShoppingListItemDTO) async {
        do {
            _ = try await APIClient(state: state).updateShoppingItem(
                listId: listId, itemId: item.id,
                ShoppingItemUpdateInput(name: nil, quantity: .unmanaged, unit: nil, note: nil, done: !item.done),
            )
            // 只在「勾上」时给一下成功触觉，取消勾选不给——和保存
            // 成功给触觉的口径一致，克制着用。
            if !item.done {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            await reload(animated: true)
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func move(_ item: ShoppingListItemDTO, direction: String) async {
        do {
            _ = try await APIClient(state: state).moveShoppingItem(
                listId: listId, itemId: item.id, direction: direction,
            )
            await reload(animated: true)
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func addItem() async {
        adding = true
        addError = nil
        defer { adding = false }
        let input = ShoppingItemCreateInput(
            name: newName.trimmingCharacters(in: .whitespaces),
            quantity: ShoppingQuantity.parse(newQuantity),
            unit: newUnit.trimmingCharacters(in: .whitespaces),
            note: newNote.trimmingCharacters(in: .whitespaces),
        )
        do {
            _ = try await APIClient(state: state).addShoppingItem(listId: listId, input)
            newName = ""
            newQuantity = ""
            newUnit = ""
            newNote = ""
            await reload()
        } catch {
            addError = shoppingErrorText(error)
        }
    }

    private func saveItem(_ item: ShoppingListItemDTO, name: String, quantity: String, unit: String, note: String) async {
        // 数量框清空 = 把数量删掉（显式 null）；填了但解析不了 =
        // 不动服务端上的旧值，别拿一次手误把数量清了。
        let quantityField: ExtraField<Double>
        if quantity.trimmingCharacters(in: .whitespaces).isEmpty {
            quantityField = .cleared
        } else if let parsed = ShoppingQuantity.parse(quantity) {
            quantityField = .value(parsed)
        } else {
            quantityField = .unmanaged
        }
        let input = ShoppingItemUpdateInput(
            name: name,
            quantity: quantityField,
            unit: unit,
            note: note,
            done: nil,
        )
        do {
            _ = try await APIClient(state: state).updateShoppingItem(listId: listId, itemId: item.id, input)
            await reload()
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func deleteItem(_ item: ShoppingListItemDTO) async {
        do {
            try await APIClient(state: state).deleteShoppingItem(listId: listId, itemId: item.id)
            await reload()
        } catch {
            errorMessage = shoppingErrorText(error)
        }
    }

    private func rename(_ list: ShoppingListDTO) async {
        renaming = true
        settingsError = nil
        defer { renaming = false }
        do {
            _ = try await APIClient(state: state).updateShoppingList(
                id: list.id,
                title: renameTitle.trimmingCharacters(in: .whitespaces),
                eventId: nil,
            )
            await reload()
        } catch {
            settingsError = shoppingErrorText(error)
        }
    }

    private func loadLinkCandidates() async {
        if linkCandidates != nil { return }
        let cal = Calendar.current
        let now = Date()
        guard
            let from = cal.date(byAdding: .month, value: -2, to: now),
            let to = cal.date(byAdding: .month, value: 13, to: now)
        else { return }
        do {
            let resp = try await APIClient(state: state).getEventsSync(
                from: DateFormatters.isoPlain.string(from: from),
                to: DateFormatters.isoPlain.string(from: to),
                syncToken: nil,
            )
            // 倒序后按 id 去重：同一系列的多个 occurrence 只留最近一行。
            var seen = Set<String>()
            linkCandidates = resp.events
                .sorted { $0.startsAt > $1.startsAt }
                .filter { seen.insert($0.id).inserted }
                .prefix(100)
                .map { $0 }
        } catch {
            linkCandidates = []
            settingsError = shoppingErrorText(error)
        }
    }

    /// 改绑（含解绑：eventId 传 nil）。两种情况都要显式发
    /// eventId —— .some(nil) 是解绑的 null，省掉键是「不动关联」。
    private func setLink(_ list: ShoppingListDTO, eventId: String?) async {
        linking = true
        settingsError = nil
        defer { linking = false }
        do {
            _ = try await APIClient(state: state).updateShoppingList(
                id: list.id, title: nil, eventId: .some(eventId),
            )
            showLinkPicker = false
            await reload()
        } catch {
            settingsError = shoppingErrorText(error)
            showLinkPicker = false
        }
    }

    private func deleteList() async {
        deleting = true
        defer { deleting = false }
        do {
            try await APIClient(state: state).deleteShoppingList(id: listId)
            dismiss()
        } catch {
            settingsError = shoppingErrorText(error)
        }
    }
}

// MARK: - 条目编辑 sheet

/// Edit one item's name / quantity / unit / note. Done state is not
/// edited here — the row's check button owns it.
private struct ShoppingItemEditSheet: View {
    @EnvironmentObject var state: AppState

    let item: ShoppingListItemDTO
    let onSave: (String, String, String, String) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var quantity: String
    @State private var unit: String
    @State private var note: String

    init(
        item: ShoppingListItemDTO,
        onSave: @escaping (String, String, String, String) -> Void,
        onCancel: @escaping () -> Void,
    ) {
        self.item = item
        self.onSave = onSave
        self.onCancel = onCancel
        _name = State(initialValue: item.name)
        _quantity = State(initialValue: item.quantity.map(ShoppingQuantity.format) ?? "")
        _unit = State(initialValue: item.unit ?? "")
        _note = State(initialValue: item.note ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("例如：番茄", text: $name)
                } header: {
                    Text("名称")
                }
                Section {
                    HStack {
                        Text("数量")
                        Spacer()
                        TextField("数量", text: $quantity)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 90)
                    }
                    HStack {
                        Text("单位")
                        Spacer()
                        TextField("单位", text: $unit)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 120)
                    }
                    HStack {
                        Text("备注")
                        Spacer()
                        TextField("备注", text: $note)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 160)
                    }
                }
            }
            .navigationTitle("编辑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        onSave(
                            name.trimmingCharacters(in: .whitespaces),
                            quantity,
                            unit.trimmingCharacters(in: .whitespaces),
                            note.trimmingCharacters(in: .whitespaces),
                        )
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

/// Localized copy for the shopping-list failures the user can act
/// on. The API client surfaces the server's machine code (see
/// APIError.serverErrorCode); anything unmapped falls back to the
/// error's own description, mirroring tokenErrorText.
func shoppingErrorText(_ error: Error) -> String {
    if let e = error as? APIError, case .server(_, let body) = e {
        switch APIError.serverErrorCode(body) {
        case "list_limit_reached":
            return "清单数量已达上限。".loc
        case "item_limit_reached":
            return "这张清单的条目已达上限。".loc
        case "event_not_found":
            return "这个事件已经不存在了，无法关联。".loc
        default:
            break
        }
    }
    if let e = error as? APIError { return e.localizedDescription }
    return error.localizedDescription
}
