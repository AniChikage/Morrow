import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: AppStore
    @State private var showNewProject = false
    @State private var showNewChannel = false
    @State private var showSearch = false
    @State private var selectedItemID: String?
    @State private var showInspector = true
    @State private var showSidebar = true

    private var selectedItem: WorkItem? { store.snapshot.items.first { $0.id == selectedItemID } }
    private var canShowInspector: Bool { store.selectedProject != nil && store.selection != "runtimes" }

    var body: some View {
        HStack(spacing: 0) {
            if showSidebar {
                SidebarView(newProject: { showNewProject = true }, newChannel: { showNewChannel = true }, search: { showSearch = true })
                    .frame(width: 246)
            }
            VStack(spacing: 0) {
                projectTabs
                workspace
                    .background(Color.morrowCanvas)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.morrowLine, lineWidth: 1))
                    .padding(.trailing, 6).padding(.bottom, 6)
            }
        }
        .ignoresSafeArea(.container, edges: .top)
        .background(Color.morrowSidebar)
        .foregroundStyle(Color.morrowInk)
        .frame(minWidth: 1080, minHeight: 680)
        .sheet(isPresented: $showNewProject) { NewProjectSheet() }
        .sheet(isPresented: $showNewChannel) { NewChannelSheet() }
        .sheet(isPresented: $showSearch) {
            SearchSheet { item in selectedItemID = item.id; showInspector = true }
        }
        .background {
            Group {
                Button("新建项目") { showNewProject = true }.keyboardShortcut("n", modifiers: .command)
                Button("搜索") { showSearch = true }.keyboardShortcut("k", modifiers: .command)
                Button("切换侧边栏") { showSidebar.toggle() }.keyboardShortcut("s", modifiers: [.command, .control])
            }.hidden()
        }
        .onChange(of: store.selectedProjectID) { _, _ in selectedItemID = nil }
        .onChange(of: store.selectedChannelID) { _, _ in selectedItemID = nil }
    }

    private var projectTabs: some View {
        HStack(spacing: 3) {
            SmallIconButton(symbol: "sidebar.left", help: "切换侧边栏") { showSidebar.toggle() }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(store.snapshot.projects) { project in
                        Button { store.selectProject(project) } label: {
                            HStack(spacing: 7) {
                                Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
                                Text(project.name).font(.system(size: 12, weight: project.id == store.selectedProjectID ? .medium : .regular)).lineLimit(1)
                            }
                            .padding(.horizontal, 13).frame(minWidth: 108, maxWidth: 210).frame(height: 32)
                            .foregroundStyle(project.id == store.selectedProjectID ? Color.morrowInk : Color.morrowSecondary)
                            .background(project.id == store.selectedProjectID ? Color.morrowCanvas : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                            .overlay(RoundedRectangle(cornerRadius: 7).stroke(project.id == store.selectedProjectID ? Color.morrowLine : Color.clear, lineWidth: 1))
                        }.buttonStyle(.plain)
                    }
                }
            }
            .frame(maxWidth: min(CGFloat(max(store.snapshot.projects.count, 1)) * 170, 620))
            .fixedSize(horizontal: false, vertical: true)
            SmallIconButton(symbol: "plus", help: "新建项目") { showNewProject = true }
            Spacer(minLength: 12)
        }.padding(.leading, showSidebar ? 8 : 86).padding(.trailing, 8).padding(.top, 6).frame(height: 46)
    }

    private var workspace: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                breadcrumb
                if let error = store.errorMessage {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).lineLimit(3)
                        Spacer()
                        SmallIconButton(symbol: "xmark", help: "关闭提示") { store.errorMessage = nil }
                    }.font(.system(size: 12)).foregroundStyle(Color.morrowOrange)
                        .padding(.leading, 16).padding(.trailing, 5).padding(.vertical, 4)
                        .background(Color.morrowOrange.opacity(0.045))
                }
                mainContent.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if canShowInspector && showInspector {
                Rectangle().fill(Color.morrowLine).frame(width: 1)
                InspectorView(item: selectedItem, clearItem: { selectedItemID = nil }).frame(width: 250)
            }
        }
    }

    private var breadcrumb: some View {
        HStack(spacing: 8) {
            if store.selection == "runtimes" {
                Text("运行引擎").fontWeight(.medium)
            } else {
                Button("项目") { store.selection = "overview"; store.selectedChannelID = nil; selectedItemID = nil }
                    .buttonStyle(.plain).foregroundStyle(Color.morrowSecondary)
            }
            if let project = store.selectedProject, store.selection != "runtimes" {
                Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(Color.morrowSecondary)
                Text(project.name).fontWeight(.medium).lineLimit(1)
                if store.selection != "overview" {
                    Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(Color.morrowSecondary)
                    Text(pageTitle).foregroundStyle(Color.morrowSecondary).lineLimit(1)
                }
                if project.isDemo { DemoBadge() }
            }
            Spacer(minLength: 6)
            if store.isBusy { ProgressView().controlSize(.small).frame(width: 18) }
            SmallIconButton(symbol: "arrow.clockwise", help: "刷新工作空间") { Task { await store.refresh() } }
            if canShowInspector {
                SmallIconButton(symbol: "sidebar.right", help: showInspector ? "收起属性栏" : "显示属性栏") { showInspector.toggle() }
            }
        }.font(.system(size: 13)).padding(.leading, 16).padding(.trailing, 9).frame(height: 46)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.morrowLine).frame(height: 1) }
    }
    private var pageTitle: String {
        switch store.selection {
        case "channel": return store.selectedChannel?.name ?? "频道"
        case "activity": return "运行记录"
        case "runtimes": return "运行引擎"
        default: return "发现"
        }
    }
    @ViewBuilder private var mainContent: some View {
        if store.selection == "runtimes" { RuntimesView() }
        else if store.selectedProject == nil { welcome }
        else {
            switch store.selection {
            case "channel":
                if let channel = store.selectedChannel { ChannelView(channel: channel, selectItem: inspect) }
                else { OverviewView(newChannel: { showNewChannel = true }, selectItem: inspect, selectedItemID: $selectedItemID) }
            case "activity": ActivityView()
            default: OverviewView(newChannel: { showNewChannel = true }, selectItem: inspect, selectedItemID: $selectedItemID)
            }
        }
    }
    private func inspect(_ item: WorkItem) { selectedItemID = item.id; showInspector = true }
    private var welcome: some View {
        VStack(spacing: 13) {
            Image(systemName: "folder.badge.plus").font(.system(size: 30, weight: .regular)).foregroundStyle(Color.morrowSecondary).padding(.bottom, 4)
            Text("还没有项目").font(.system(size: 15, weight: .medium))
            Text("接入代码目录，添加持续负责项目的 AI 频道。").font(.system(size: 13)).foregroundStyle(Color.morrowSecondary)
            HStack(spacing: 8) {
                NHButton(title: "新建项目", symbol: "plus") { showNewProject = true }
                Button("浏览示例") { Task { await store.loadDemo() } }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Color.morrowSecondary)
            }.disabled(store.isBusy || !store.isConnected).padding(.top, 2)
            if !store.isConnected { Text("正在连接执行服务…").font(.system(size: 12)).foregroundStyle(Color.morrowSecondary) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
