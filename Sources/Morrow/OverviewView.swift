import SwiftUI

struct OverviewView: View {
    @EnvironmentObject var store: AppStore
    var newChannel: () -> Void
    var selectItem: (WorkItem) -> Void
    @Binding var selectedItemID: String?

    @State private var tab = "items"
    @State private var statusFilter = "all"
    @State private var channelFilter = "all"
    @State private var displayMode = "list"
    @State private var collapsedGroups: Set<String> = []

    private let statusOrder = ["open", "investigating", "blocked", "verified", "resolved"]
    private var allItems: [WorkItem] {
        let ids = Set(store.projectChannels.map(\.id))
        return store.snapshot.items.filter { ids.contains($0.channelId) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private var items: [WorkItem] {
        allItems.filter {
            (statusFilter == "all" || $0.status == statusFilter) &&
            (channelFilter == "all" || $0.channelId == channelFilter)
        }
    }
    private var visibleStatuses: [String] {
        statusOrder.filter { status in items.contains { $0.status == status } }
    }
    private var hasFilters: Bool { channelFilter != "all" || (tab == "items" && statusFilter != "all") }
    private var visibleChannels: [Channel] {
        store.projectChannels.filter { channelFilter == "all" || $0.id == channelFilter }
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if tab == "channels" {
                channelList
            } else if items.isEmpty {
                emptyState
            } else if displayMode == "board" {
                board
            } else {
                itemList
            }
        }
        .background(Color.morrowCanvas)
        .onChange(of: store.selectedProjectID) { _, _ in
            statusFilter = "all"
            channelFilter = "all"
            selectedItemID = nil
            collapsedGroups = []
        }
    }

    private var toolbar: some View {
        HStack(spacing: 5) {
            tabButton("所有发现", value: "items")
            tabButton("持续频道", value: "channels")
            Spacer(minLength: 8)
            Text("\(store.projectChannels.filter { $0.status == "running" }.count) 个频道工作中")
                .font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                .lineLimit(1).padding(.trailing, 5)
                .accessibilityLabel("当前有 \(store.projectChannels.filter { $0.status == "running" }.count) 个频道正在运行")
            filterMenu
            if tab == "items" {
                Button {
                    displayMode = displayMode == "list" ? "board" : "list"
                } label: {
                    toolbarLabel(displayMode == "list" ? "看板" : "列表", symbol: displayMode == "list" ? "rectangle.split.3x1" : "list.bullet")
                }.buttonStyle(.plain).help(displayMode == "list" ? "切换为看板" : "切换为列表")
            } else {
                Button(action: newChannel) { toolbarLabel("新建频道", symbol: "plus") }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16).frame(height: 44)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.morrowLine).frame(height: 1) }
    }

    private func tabButton(_ title: String, value: String) -> some View {
        Button { tab = value } label: {
            Text(title).font(.system(size: 13, weight: tab == value ? .medium : .regular))
                .foregroundStyle(tab == value ? Color.morrowInk : Color.morrowSecondary)
                .padding(.horizontal, 10).frame(height: 27)
                .background(tab == value ? Color.black.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 5))
        }.buttonStyle(.plain)
    }

    private var filterMenu: some View {
        Menu {
            if tab == "items" {
                Picker("状态", selection: $statusFilter) {
                    Text("所有状态").tag("all")
                    ForEach(statusOrder, id: \.self) { Text(statusTitle($0)).tag($0) }
                }
            }
            Picker("频道", selection: $channelFilter) {
                Text("所有频道").tag("all")
                ForEach(store.projectChannels) { Text($0.name).tag($0.id) }
            }
            if hasFilters {
                Divider()
                Button("清除筛选") { statusFilter = "all"; channelFilter = "all" }
            }
        } label: {
            toolbarLabel(hasFilters ? "已筛选" : "筛选", symbol: "line.3.horizontal.decrease", active: hasFilters)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }

    private func toolbarLabel(_ title: String, symbol: String, active: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 12))
            Text(title).font(.system(size: 12))
        }
        .foregroundStyle(active ? Color.morrowInk : Color.morrowSecondary)
        .padding(.horizontal, 8).frame(height: 27)
        .background(active ? Color.black.opacity(0.035) : .white, in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.morrowLine, lineWidth: 1))
    }

    private var itemList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(visibleStatuses, id: \.self) { status in
                    groupHeader(status)
                    if !collapsedGroups.contains(status) {
                        ForEach(items.filter { $0.status == status }) { item in
                            let channel = store.projectChannels.first { $0.id == item.channelId }
                            WorkItemRow(item: item, channelName: channel?.name, runtimeName: channel.map { runtimeTitle($0.runtime) }, isSelected: selectedItemID == item.id) {
                                selectedItemID = item.id
                                selectItem(item)
                            }
                            Rectangle().fill(Color.morrowLine.opacity(0.6)).frame(height: 1).padding(.leading, 48)
                        }
                    }
                }
            }.padding(.top, 12)
        }
    }

    private func groupHeader(_ status: String) -> some View {
        Button {
            if collapsedGroups.contains(status) { collapsedGroups.remove(status) }
            else { collapsedGroups.insert(status) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: collapsedGroups.contains(status) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .medium)).frame(width: 12).foregroundStyle(Color.morrowSecondary)
                OverviewStatusSymbol(status: status)
                Text(statusTitle(status)).font(.system(size: 12, weight: .medium))
                Text("\(items.filter { $0.status == status }.count)").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                Spacer()
            }
            .padding(.horizontal, 17).frame(height: 34)
            .background(Color(red: 0.975, green: 0.975, blue: 0.978))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private var board: some View {
        GeometryReader { geometry in
            ScrollView([.horizontal, .vertical]) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(visibleStatuses, id: \.self) { status in
                        VStack(alignment: .leading, spacing: 9) {
                            HStack(spacing: 7) {
                                OverviewStatusSymbol(status: status)
                                Text(statusTitle(status)).font(.system(size: 13, weight: .medium))
                                Text("\(items.filter { $0.status == status }.count)").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                                Spacer()
                            }.frame(height: 30).padding(.horizontal, 3)
                            ForEach(items.filter { $0.status == status }) { item in
                                Button {
                                    selectedItemID = item.id
                                    selectItem(item)
                                } label: {
                                    VStack(alignment: .leading, spacing: 13) {
                                        Text(kindTitle(item.kind)).font(.system(size: 11)).foregroundStyle(Color.morrowSecondary)
                                        Text(item.title).font(.system(size: 13)).lineSpacing(3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                        HStack(spacing: 6) {
                                            Text("# \(store.projectChannels.first { $0.id == item.channelId }?.name ?? "频道")").lineLimit(1)
                                            Spacer(minLength: 4)
                                            Image(systemName: "link").font(.system(size: 10))
                                            Text("\(item.evidence.count)")
                                        }.font(.system(size: 11)).foregroundStyle(Color.morrowSecondary)
                                    }
                                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(selectedItemID == item.id ? Color.black.opacity(0.025) : .white, in: RoundedRectangle(cornerRadius: 6))
                                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.morrowLine, lineWidth: 1))
                                }.buttonStyle(.plain)
                            }
                        }.frame(width: 240)
                    }
                }
                .padding(18)
                .frame(minWidth: geometry.size.width, minHeight: geometry.size.height, alignment: .topLeading)
            }
        }
    }

    private var channelList: some View {
        VStack(spacing: 0) {
            if visibleChannels.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "number").font(.system(size: 28, weight: .light)).foregroundStyle(Color.morrowSecondary)
                    Text("还没有持续频道").font(.system(size: 14)).foregroundStyle(Color.morrowSecondary)
                    Text("创建一个频道，为项目持续关注一个方向。").font(.system(size: 13)).foregroundStyle(Color.morrowSecondary)
                    NHButton(title: "新建频道", symbol: "plus", action: newChannel)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack {
                    Text("频道").frame(maxWidth: .infinity, alignment: .leading)
                    Text("运行引擎").frame(width: 98, alignment: .leading)
                    Text("间隔").frame(width: 74, alignment: .leading)
                    Text("状态").frame(width: 114, alignment: .leading)
                }
                .font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                .padding(.horizontal, 22).frame(height: 35)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.morrowLine).frame(height: 1) }
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(visibleChannels) { channel in
                            OverviewChannelRow(channel: channel) { store.selectChannel(channel) }
                        }
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 13) {
            Image(systemName: "checklist").font(.system(size: 32, weight: .regular)).foregroundStyle(Color.morrowSecondary.opacity(0.85)).padding(.bottom, 3)
            Text(hasFilters ? "没有符合筛选条件的发现" : "还没有项目发现").font(.system(size: 14)).foregroundStyle(Color.morrowSecondary)
            Text(hasFilters ? "调整筛选条件，查看项目中的其他发现。" : "运行一个持续频道，发现和证据会保存在这里。")
                .font(.system(size: 13)).foregroundStyle(Color.morrowSecondary).multilineTextAlignment(.center)
            HStack(spacing: 8) {
                if hasFilters {
                    NHButton(title: "清除筛选", symbol: "xmark") { statusFilter = "all"; channelFilter = "all" }
                } else {
                    if let channel = store.projectChannels.first {
                        NHButton(title: "打开频道", symbol: "arrow.up.right") { store.selectChannel(channel) }
                    }
                    NHButton(title: "新建频道", symbol: "plus", action: newChannel)
                }
            }.padding(.top, 2)
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct WorkItemRow: View {
    let item: WorkItem
    var channelName: String?
    var runtimeName: String? = nil
    var isSelected = false
    var action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                OverviewStatusSymbol(status: item.status)
                Text(item.title).font(.system(size: 13)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text(kindTitle(item.kind)).font(.system(size: 11)).foregroundStyle(Color.morrowSecondary).fixedSize()
                if let channelName {
                    Text("# \(channelName)").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).lineLimit(1).frame(width: 104, alignment: .leading)
                }
                if let runtimeName {
                    Text(runtimeName).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).lineLimit(1).frame(width: 82, alignment: .leading)
                }
                HStack(spacing: 4) {
                    Image(systemName: "link").font(.system(size: 10))
                    Text("\(item.evidence.count)").font(.system(size: 12))
                }.foregroundStyle(Color.morrowSecondary).frame(width: 32, alignment: .trailing)
            }
            .padding(.horizontal, 22).frame(height: 40)
            .background(isSelected ? Color.black.opacity(0.045) : hovered ? Color.black.opacity(0.025) : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .help("\(item.title) · \(statusTitle(item.status)) · \(item.evidence.count) 条证据")
        .accessibilityLabel("\(item.title)，\(kindTitle(item.kind))，\(statusTitle(item.status))，\(item.evidence.count) 条证据")
    }
}

private struct OverviewStatusSymbol: View {
    var status: String
    private var symbol: String {
        switch status {
        case "investigating", "running": return "circle.lefthalf.filled"
        case "verified", "resolved": return "checkmark.circle.fill"
        case "blocked": return "exclamationmark.circle"
        case "paused": return "pause.circle"
        default: return "circle.dashed"
        }
    }
    private var tint: Color {
        switch status {
        case "verified", "resolved": return Color(red: 0.47, green: 0.50, blue: 0.47)
        case "blocked": return .morrowOrange
        case "investigating", "running": return .morrowAccent
        default: return .morrowSecondary
        }
    }
    var body: some View {
        Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(tint).frame(width: 16)
    }
}

private struct OverviewChannelRow: View {
    let channel: Channel
    var action: () -> Void
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack {
                HStack(spacing: 10) {
                    Image(systemName: "number").font(.system(size: 13)).foregroundStyle(Color.morrowSecondary).frame(width: 16)
                    Text(channel.name).font(.system(size: 13)).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Text(runtimeTitle(channel.runtime)).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).frame(width: 98, alignment: .leading)
                Text("\(channel.intervalMinutes) 分钟").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).frame(width: 74, alignment: .leading)
                HStack(spacing: 6) {
                    OverviewStatusSymbol(status: channel.status)
                    Text(statusTitle(channel.status)).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).lineLimit(1)
                }.frame(width: 114, alignment: .leading)
            }
            .padding(.horizontal, 22).frame(height: 44)
            .background(hovered ? Color.black.opacity(0.025) : .clear)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(Color.morrowLine.opacity(0.6)).frame(height: 1).padding(.leading, 48) }
        }.buttonStyle(.plain).onHover { hovered = $0 }
    }
}
