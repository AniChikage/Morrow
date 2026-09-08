import SwiftUI

struct ChannelView: View {
    @EnvironmentObject var store: AppStore
    let channel: Channel
    var selectItem: (WorkItem) -> Void
    @State private var tab = "feed"
    @State private var message = ""

    private var events: [Event] { store.snapshot.events.filter { $0.channelId == channel.id }.sorted { $0.createdAt < $1.createdAt } }
    private var items: [WorkItem] { store.snapshot.items.filter { $0.channelId == channel.id }.sorted { $0.updatedAt > $1.updatedAt } }
    private var runs: [Run] { store.snapshot.runs.filter { $0.channelId == channel.id }.sorted { $0.startedAt > $1.startedAt } }
    private var isDemo: Bool { store.selectedProject?.isDemo == true }
    private var isPaused: Bool { channel.status == "paused" || channel.status == "blocked" }
    private var canSend: Bool { !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.isBusy && store.isConnected }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if tab == "feed" {
                            if events.isEmpty {
                                EmptyPanel(symbol: "bubble.left", title: "暂无频道动态", detail: "发送补充说明，或运行一次以开始记录。")
                            } else {
                                ForEach(events) { event in
                                    EventCard(event: event, runtime: channel.runtime).id(event.id)
                                }
                            }
                        } else if tab == "items" {
                            if items.isEmpty {
                                EmptyPanel(symbol: "tray", title: "暂无发现", detail: "运行后，事项、证据与下一步会保存在这里。")
                            } else {
                                ForEach(items) { item in
                                    WorkItemRow(item: item, action: { selectItem(item) })
                                        .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
                                }
                            }
                        } else {
                            if runs.isEmpty {
                                EmptyPanel(symbol: "clock", title: "暂无运行记录", detail: isDemo ? "示例频道没有执行真实任务。" : "点击「运行一次」开始执行。")
                            } else {
                                ForEach(runs) { run in RunCard(run: run) }
                            }
                        }
                    }
                    .padding(.horizontal, tab == "items" ? 0 : 18)
                    .padding(.top, tab == "feed" ? 8 : 0)
                    .padding(.bottom, 12)
                }
                .onChange(of: events.count) { _, _ in
                    if tab == "feed", let last = events.last {
                        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            if tab == "feed" { composer }
        }
        .onChange(of: channel.id) { _, _ in message = ""; tab = "feed" }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            tabButton("动态", value: "feed", count: events.count)
            tabButton("发现", value: "items", count: items.count)
            tabButton("运行记录", value: "runs", count: runs.count)
            Spacer(minLength: 6)
            HStack(spacing: 6) {
                NHButton(title: channel.status == "running" ? "运行中" : "运行一次", symbol: "play.fill", primary: true) {
                    Task { await store.channelAction("run") }
                }
                .disabled(isDemo || store.isBusy || channel.status == "running" || !store.isConnected)
                NHButton(title: isPaused ? "持续运行" : "暂停", symbol: isPaused ? "arrow.triangle.2.circlepath" : "pause") {
                    Task { await store.channelAction(isPaused ? "resume" : "pause") }
                }
                .disabled(isDemo || store.isBusy || !store.isConnected)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
    }

    private func tabButton(_ title: String, value: String, count: Int) -> some View {
        Button { tab = value } label: {
            HStack(spacing: 4) {
                Text(title).font(.system(size: 12, weight: tab == value ? .medium : .regular))
                Text("\(count)").font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
            }
            .foregroundStyle(tab == value ? Color.nhInk : Color.nhSecondary)
            .fixedSize()
            .frame(height: 44)
            .overlay(alignment: .bottom) {
                if tab == value { Rectangle().fill(Color.nhInk).frame(height: 1.5) }
            }
        }.buttonStyle(.plain)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                if message.isEmpty {
                    Text("添加说明…")
                        .font(.system(size: 13)).foregroundStyle(Color.nhSecondary)
                        .padding(.horizontal, 5).padding(.top, 8).allowsHitTesting(false)
                }
                TextEditor(text: $message)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 46, maxHeight: 66)
            }
            HStack(spacing: 8) {
                Text(isDemo ? "示例频道不会执行任务" : "下次运行时读取")
                    .font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                Spacer()
                Text("⌘ ↵").font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                Button(action: sendMessage) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(canSend ? Color.white : Color.nhSecondary)
                        .frame(width: 28, height: 28)
                        .background(canSend ? Color.nhInk : Color.nhLine.opacity(0.55), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .help("发送说明 · ⌘Return")
                .disabled(!canSend)
            }
        }
        .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 12)
        .overlay(alignment: .top) { Rectangle().fill(Color.nhLine).frame(height: 1) }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task {
            await store.sendMessage(text)
            if store.errorMessage == nil { message = ""; tab = "feed" }
        }
    }
}

struct EventCard: View {
    let event: Event
    let runtime: String
    @State private var expanded = false
    private var isSystem: Bool { ["system", "error", "tool"].contains(event.kind) }
    private var symbol: String {
        switch event.kind {
        case "message": return "person.crop.circle"
        case "error": return "exclamationmark.circle"
        case "tool": return "terminal"
        case "result": return "checkmark.circle"
        case "system": return "circle.dotted"
        default: return "sparkle"
        }
    }
    private var label: String {
        switch event.kind {
        case "message": return "你"
        case "error": return "执行错误"
        case "tool": return "工具调用"
        case "system": return "系统"
        case "result": return "\(runtimeTitle(runtime)) · 结果"
        default: return runtimeTitle(runtime)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(event.kind == "error" ? Color.nhOrange : Color.nhSecondary)
                .frame(width: 16, height: 17)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(label).font(.system(size: 12, weight: isSystem ? .regular : .medium))
                        .foregroundStyle(isSystem ? Color.nhSecondary : Color.nhInk)
                    Spacer(minLength: 4)
                    Text(displayDate(event.createdAt)).font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                }
                Text(event.text)
                    .font(.system(size: event.kind == "tool" ? 11 : 13, design: event.kind == "tool" ? .monospaced : .default))
                    .foregroundStyle(event.kind == "error" ? Color.nhOrange : isSystem ? Color.nhSecondary : Color.nhInk)
                    .lineSpacing(3)
                    .lineLimit(expanded ? nil : isSystem ? 3 : 12)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if event.text.count > (isSystem ? 160 : 650) || event.text.components(separatedBy: "\n").count > (isSystem ? 3 : 12) {
                    Button(expanded ? "收起" : "展开") { expanded.toggle() }
                        .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                }
            }
        }
        .padding(.vertical, isSystem ? 10 : 14)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine.opacity(0.65)).frame(height: 1) }
    }
}

struct RunCard: View {
    let run: Run
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "terminal").font(.system(size: 12)).foregroundStyle(Color.nhSecondary)
                Text(runtimeTitle(run.runtime)).font(.system(size: 13, weight: .medium))
                Text(String(run.id.prefix(8))).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.nhSecondary)
                Spacer(minLength: 4)
                StatusBadge(status: run.status)
            }
            Text(run.summary.isEmpty ? "等待执行结果…" : run.summary)
                .font(.system(size: 13)).foregroundStyle(Color.nhInk)
                .lineSpacing(3).lineLimit(expanded ? nil : 3).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                Text(displayDate(run.startedAt))
                if !run.finishedAt.isEmpty { Text("→ \(displayDate(run.finishedAt, includeDate: false))") }
                Spacer()
                if run.summary.count > 160 || run.summary.components(separatedBy: "\n").count > 3 {
                    Button(expanded ? "收起" : "展开") { expanded.toggle() }.buttonStyle(.plain)
                }
            }.font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
        }
        .padding(.vertical, 14)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
    }
}
