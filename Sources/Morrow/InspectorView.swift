import SwiftUI

struct InspectorView: View {
    @EnvironmentObject var store: AppStore
    var item: WorkItem?
    var clearItem: () -> Void
    @State private var showSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let item { itemDetails(item) }
                else if store.selection == "channel", let channel = store.selectedChannel { channelDetails(channel) }
                else { projectDetails }
            }.padding(.horizontal, 22).padding(.top, 23).padding(.bottom, 28)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .frame(maxHeight: .infinity)
        .background(Color.morrowCanvas)
        .sheet(isPresented: $showSettings) {
            if let channel = store.selectedChannel { ChannelSettingsSheet(channel: channel) }
        }
    }

    private var projectDetails: some View {
        Group {
            VStack(alignment: .leading, spacing: 15) {
                Image(systemName: "folder.fill").symbolRenderingMode(.hierarchical).font(.system(size: 25)).foregroundStyle(Color.morrowSecondary)
                Text(store.selectedProject?.name ?? "项目").font(.system(size: 16, weight: .semibold)).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 12) {
                section("属性")
                property("状态") {
                    let channels = store.projectChannels
                    StatusBadge(status: channels.contains(where: { $0.status == "running" }) ? "running" : channels.contains(where: { $0.status == "blocked" }) ? "blocked" : channels.allSatisfy({ $0.status == "paused" }) ? "paused" : "waiting")
                }
                property("持续频道") { Label("\(store.projectChannels.count) 个频道", systemImage: "number") }
                property("运行位置") { Text(store.connectionName) }
                property("创建日期") { Text(shortDate(store.selectedProject?.createdAt ?? "")) }
            }
            VStack(alignment: .leading, spacing: 14) {
                section("描述")
                Text(store.selectedProject?.goal ?? "尚未填写项目目标。").font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
                Text("所有频道共享这个项目目标。").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
            }
            VStack(alignment: .leading, spacing: 14) {
                section("资源")
                if let project = store.selectedProject, !project.path.isEmpty {
                    HStack(alignment: .top, spacing: 7) {
                        Image(systemName: "folder").font(.system(size: 13)).padding(.top, 2)
                        Text(project.path).font(.system(size: 12)).lineSpacing(3).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }.foregroundStyle(Color.morrowSecondary)
                } else {
                    Text("示例项目，未关联实际目录。").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                }
            }
        }
    }

    private func channelDetails(_ channel: Channel) -> some View {
        Group {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "number").font(.system(size: 24, weight: .light)).foregroundStyle(Color.morrowSecondary)
                Text(channel.name).font(.system(size: 16, weight: .semibold))
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    section("属性")
                    Spacer()
                    Button("编辑") { showSettings = true }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                }
                property("状态") { StatusBadge(status: channel.status) }
                property("引擎") { Label(runtimeTitle(channel.runtime), systemImage: "terminal") }
                property("模型") { Text(channel.model.isEmpty ? "默认" : channel.model).lineLimit(2) }
                property("权限") { Text(channel.permission == "read-only" ? "只读" : "工作区编辑") }
                property("复查间隔") { Text("\(channel.intervalMinutes) 分钟") }
                property("每日上限") { Text("\(channel.maxRunsPerDay) 次") }
            }
            VStack(alignment: .leading, spacing: 13) {
                section("持续目标")
                Text(channel.goal).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 13) {
                section("调度")
                textProperty("上次运行", value: displayDate(channel.lastRunAt))
                textProperty("下次运行", value: channel.status == "paused" ? "已暂停" : channel.nextRunAt.isEmpty ? "等待调度" : displayDate(channel.nextRunAt))
                if !channel.sessionId.isEmpty { textProperty("原生会话", value: channel.sessionId) }
            }
            if store.selectedProject?.isDemo == true {
                Text("示例频道，不会执行或自动调度。").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary).lineSpacing(3)
            }
        }
    }

    private func itemDetails(_ item: WorkItem) -> some View {
        Group {
            VStack(alignment: .leading, spacing: 13) {
                HStack {
                    Label(kindTitle(item.kind), systemImage: kindSymbol(item.kind)).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                    Spacer()
                    SmallIconButton(symbol: "xmark", help: "关闭发现详情", action: clearItem)
                }
                Text(item.title).font(.system(size: 16, weight: .semibold)).lineSpacing(4).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 12) {
                section("属性")
                property("状态") {
                    Menu {
                        ForEach(["open", "investigating", "verified", "resolved", "blocked"], id: \.self) { value in
                            Button(statusTitle(value)) { Task { await store.updateItem(item, status: value) } }
                        }
                    } label: { StatusBadge(status: item.status) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).disabled(store.isBusy || !store.isConnected)
                }
                property("频道") {
                    Text(store.snapshot.channels.first(where: { $0.id == item.channelId })?.name ?? "—").lineLimit(1)
                }
                property("更新时间") { Text(shortDate(item.updatedAt)) }
            }
            VStack(alignment: .leading, spacing: 13) {
                section("描述")
                Text(item.summary.isEmpty ? "暂无补充描述。" : item.summary).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 7) { section("证据"); Text("\(item.evidence.count)").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary) }
                if item.evidence.isEmpty {
                    Text("尚未附带证据，保留为待验证。").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                }
                ForEach(Array(item.evidence.enumerated()), id: \.offset) { index, evidence in
                    VStack(alignment: .leading, spacing: 7) {
                        Label("证据 \(index + 1)", systemImage: "link").font(.system(size: 11)).foregroundStyle(Color.morrowSecondary)
                        Text(evidence).font(.system(size: 12)).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }.padding(.leading, 10).overlay(alignment: .leading) { Rectangle().fill(Color.morrowLine).frame(width: 2) }
                }
            }
            VStack(alignment: .leading, spacing: 13) {
                section("下一步")
                Text(item.nextStep.isEmpty ? "尚未设置下一步。" : item.nextStep).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
            }
        }
    }

    private func section(_ name: String) -> some View { Text(name).font(.system(size: 12, weight: .medium)) }
    private func property<Value: View>(_ name: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(name).foregroundStyle(Color.morrowSecondary).frame(width: 70, alignment: .leading)
            value().frame(maxWidth: .infinity, alignment: .leading)
        }.font(.system(size: 12)).frame(minHeight: 22)
    }
    private func textProperty(_ name: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(name).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
            Text(value).font(.system(size: 12)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func shortDate(_ value: String) -> String {
        if value.count >= 10 { return String(value.prefix(10)).replacingOccurrences(of: "-", with: "/") }
        return "—"
    }
}
