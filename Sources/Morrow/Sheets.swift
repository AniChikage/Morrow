import SwiftUI

struct NewProjectSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var path = ""
    @State private var goal = ""
    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !path.isEmpty && !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            SheetHeading(symbol: "folder.badge.plus", title: "连接一个项目", detail: "从项目目录和一个长期目标开始。")
            FormField(title: "项目名称") { TextField("例如：Atlas", text: $name).textFieldStyle(.roundedBorder) }
            FormField(title: store.usingRemote ? "远程项目目录" : "本地项目目录") {
                HStack(spacing: 8) {
                    TextField(store.usingRemote ? "输入远程主机上的绝对路径" : "选择仓库或项目文件夹", text: $path).textFieldStyle(.roundedBorder)
                    if !store.usingRemote {
                        NHButton(title: "选择…", symbol: "folder") {
                            if let folder = store.chooseFolder() {
                                path = folder
                                if name.isEmpty { name = URL(fileURLWithPath: folder).lastPathComponent }
                            }
                        }
                    }
                }
            }
            FormField(title: "长期目标", hint: "描述你希望项目持续改善的方向，越具体越好。") {
                GoalEditor(text: $goal, placeholder: "例如：持续改善产品可靠性，发现影响用户体验的问题，并提出可验证的改进。")
            }
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "info.circle").foregroundStyle(Color.morrowAccent).padding(.top, 1)
                Text("创建后会添加「系统完善」与「运营洞察」两个频道，初始为暂停、只读。你可以检查设置后开始运行。")
                    .font(.system(size: 11)).foregroundStyle(Color.morrowSecondary).lineSpacing(4)
            }
            SheetError()
            HStack {
                Spacer()
                NHButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                NHButton(title: store.isBusy ? "正在创建…" : "创建项目", symbol: "plus", primary: true) {
                    Task { await store.createProject(name: name.trimmingCharacters(in: .whitespacesAndNewlines), path: path, goal: goal); if store.errorMessage == nil { dismiss() } }
                }.disabled(!valid || store.isBusy || !store.isConnected).keyboardShortcut(.defaultAction)
            }
        }.padding(30).frame(width: 540).background(Color.morrowCanvas)
    }
}

struct NewChannelSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var goal = ""
    @State private var runtime = "codex"
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            SheetHeading(symbol: "number", title: "新建持续频道", detail: "让一个 Agent 长期关注一个清晰的方向。")
            FormField(title: "频道名称") { TextField("例如：性能与稳定性", text: $name).textFieldStyle(.roundedBorder) }
            FormField(title: "频道目标", hint: "频道会带着项目上下文，围绕这个目标开展探索。") {
                GoalEditor(text: $goal, placeholder: "持续识别系统瓶颈，验证假设，并留下可以复现的证据。")
            }
            FormField(title: "运行引擎") {
                Picker("运行引擎", selection: $runtime) {
                    ForEach(["codex", "claude", "trae"], id: \.self) { id in
                        Text("\(runtimeTitle(id))\(store.snapshot.runtimes.first { $0.id == id }?.available == true ? "" : " · 未检测到")").tag(id)
                    }
                }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("新频道将以只读权限创建并保持暂停。创建后可调整模型、运行间隔与每日预算。")
                .font(.system(size: 11)).foregroundStyle(Color.morrowSecondary).lineSpacing(4)
            SheetError()
            HStack {
                Spacer()
                NHButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                NHButton(title: store.isBusy ? "正在创建…" : "创建频道", symbol: "plus", primary: true) {
                    Task { await store.createChannel(name: name.trimmingCharacters(in: .whitespacesAndNewlines), goal: goal, runtime: runtime); if store.errorMessage == nil { dismiss() } }
                }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isBusy || !store.isConnected)
                    .keyboardShortcut(.defaultAction)
            }
        }.padding(30).frame(width: 520).background(Color.morrowCanvas)
    }
}

struct ChannelSettingsSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State var channel: Channel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SheetHeading(symbol: "slider.horizontal.3", title: "频道设置", detail: "设置持续探索的目标、边界和节奏。")
            HStack(alignment: .top, spacing: 18) {
                FormField(title: "频道名称") { TextField("频道名称", text: $channel.name).textFieldStyle(.roundedBorder) }
                FormField(title: "运行引擎") {
                    Picker("运行引擎", selection: $channel.runtime) {
                        ForEach(["codex", "claude", "trae"], id: \.self) { id in Text(runtimeTitle(id)).tag(id) }
                    }.labelsHidden().disabled(channel.status == "running")
                }.frame(width: 180)
            }
            FormField(title: "持续目标") { GoalEditor(text: $channel.goal, placeholder: "描述频道需要持续推进的目标。") }
            HStack(alignment: .top, spacing: 18) {
                FormField(title: "模型", hint: "留空时沿用 CLI 默认模型。") { TextField("CLI 默认模型", text: $channel.model).textFieldStyle(.roundedBorder).disabled(channel.status == "running") }
                FormField(title: "执行权限", hint: "由所选引擎执行并约束。") {
                    Picker("执行权限", selection: $channel.permission) {
                        Text("只读工作空间").tag("read-only")
                        Text("允许工作区写入").tag("workspace-write")
                    }.labelsHidden().disabled(channel.status == "running")
                }.frame(width: 180)
            }
            HStack(alignment: .top, spacing: 18) {
                FormField(title: "运行间隔（分钟）") {
                    Stepper(value: $channel.intervalMinutes, in: 1...1440, step: 5) { TextField("分钟", value: $channel.intervalMinutes, format: .number).textFieldStyle(.roundedBorder) }
                }
                FormField(title: "每日运行上限") {
                    Stepper(value: $channel.maxRunsPerDay, in: 1...200) { TextField("次数", value: $channel.maxRunsPerDay, format: .number).textFieldStyle(.roundedBorder) }
                }
            }
            if channel.status == "running" {
                Text("当前正在运行。暂停频道后可以更换引擎、模型或执行权限。 ").font(.system(size: 11)).foregroundStyle(Color.morrowOrange)
            } else {
                Text("切换引擎会开启新的原生会话，保留频道目标与历史证据。保存设置不会自动启动频道。")
                    .font(.system(size: 10)).foregroundStyle(Color.morrowSecondary).lineSpacing(4)
            }
            SheetError()
            HStack {
                Spacer()
                NHButton(title: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                NHButton(title: store.isBusy ? "正在保存…" : "保存设置", symbol: "checkmark", primary: true) {
                    Task { await store.updateChannel(channel); if store.errorMessage == nil { dismiss() } }
                }.disabled(channel.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || channel.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || channel.intervalMinutes < 1 || channel.intervalMinutes > 1440 || channel.maxRunsPerDay < 1 || channel.maxRunsPerDay > 200 || store.isBusy || !store.isConnected)
                    .keyboardShortcut(.defaultAction)
            }
        }.padding(30).frame(width: 580).background(Color.morrowCanvas)
    }
}

struct SearchSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var focused: Bool
    var select: (WorkItem) -> Void
    private var results: [WorkItem] {
        let ids = Set(store.projectChannels.map(\.id))
        return store.snapshot.items.filter { ids.contains($0.channelId) && (query.isEmpty || "\($0.title) \($0.summary) \($0.evidence.joined(separator: " "))".localizedCaseInsensitiveContains(query)) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.morrowAccent)
                TextField("搜索当前项目的发现与证据…", text: $query).textFieldStyle(.plain).font(.system(size: 15)).focused($focused)
                SmallIconButton(symbol: "xmark", help: "关闭搜索") { dismiss() }
            }.padding(22)
            Rectangle().fill(Color.morrowLine).frame(height: 1)
            ScrollView {
                if results.isEmpty { EmptyPanel(symbol: "magnifyingglass", title: "没有找到相关发现", detail: "尝试搜索标题、描述或证据中的关键词。") }
                else {
                    LazyVStack(spacing: 0) {
                        ForEach(results) { item in
                            WorkItemRow(item: item, channelName: store.projectChannels.first { $0.id == item.channelId }?.name) {
                                if store.selection == "runtimes" { store.selection = "overview" }
                                select(item); dismiss()
                            }
                            Rectangle().fill(Color.morrowLine.opacity(0.5)).frame(height: 1).padding(.horizontal, 15)
                        }
                    }.padding(8)
                }
            }.frame(height: 350)
            HStack { Text("本地搜索 · \(results.count) 条发现"); Spacer(); Text("ESC 关闭") }.font(.system(size: 10)).foregroundStyle(Color.morrowSecondary).padding(.horizontal, 20).padding(.vertical, 13).background(Color.morrowSidebar)
        }.frame(width: 620).background(Color.white).onAppear { focused = true }
            .background { Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction).hidden() }
    }
}

struct SheetHeading: View {
    var symbol: String
    var title: String
    var detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 20, weight: .light)).foregroundStyle(Color.morrowAccent).frame(width: 42, height: 42).background(Color.morrowAccent.opacity(0.065), in: RoundedRectangle(cornerRadius: 10))
            Text(title).font(.system(size: 23, weight: .semibold)).tracking(-0.5)
            Text(detail).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
        }.padding(.bottom, 3)
    }
}
struct FormField<Content: View>: View {
    var title: String
    var hint: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11, weight: .medium))
            content().font(.system(size: 12))
            if let hint { Text(hint).font(.system(size: 10)).foregroundStyle(Color.morrowSecondary).lineSpacing(3) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct GoalEditor: View {
    @Binding var text: String
    var placeholder: String
    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty { Text(placeholder).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary.opacity(0.6)).lineSpacing(4).padding(10).allowsHitTesting(false) }
            TextEditor(text: $text).font(.system(size: 12)).scrollContentBackground(.hidden).padding(5).frame(height: 92)
        }.background(Color.white, in: RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.morrowLine, lineWidth: 1))
    }
}
struct SheetError: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        if let error = store.errorMessage { Label(error, systemImage: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(Color.morrowOrange).lineSpacing(3).textSelection(.enabled) }
    }
}
