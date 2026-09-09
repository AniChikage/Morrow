import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var store: AppStore
    var newProject: () -> Void
    var newChannel: () -> Void
    var search: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 46)
            HStack(spacing: 9) {
                Text("M").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.morrowSecondary).frame(width: 18)
                Text("Morrow").font(.system(size: 14, weight: .semibold))
                Spacer()
                Menu {
                    ForEach(store.snapshot.projects) { project in Button(project.name) { store.selectProject(project) } }
                    Divider()
                    Button("新建项目", action: newProject)
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 10)).foregroundStyle(Color.morrowSecondary).frame(width: 20, height: 28)
                }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("切换项目")
            }.padding(.horizontal, 16).frame(height: 38)
            VStack(spacing: 1) {
                Button(action: search) {
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").font(.system(size: 14)).frame(width: 18)
                        Text("搜索…")
                        Spacer()
                        Text("⌘ K").font(.system(size: 11)).foregroundStyle(Color.morrowSecondary.opacity(0.65))
                    }.font(.system(size: 13)).foregroundStyle(Color.morrowSecondary).padding(.horizontal, 12).frame(height: 32).contentShape(Rectangle())
                }.buttonStyle(.plain)
                navRow("新建频道", symbol: "square.and.pencil", selected: false) { if store.selectedProject == nil { newProject() } else { newChannel() } }
            }.padding(.horizontal, 8).padding(.top, 6)

            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    heading("工作区").padding(.top, 25)
                    navRow("运行记录", symbol: "clock", selected: store.selection == "activity") { store.selection = "activity"; store.selectedChannelID = nil }
                    HStack { heading("项目"); Spacer(); SmallIconButton(symbol: "plus", help: "新建项目", action: newProject) }.padding(.top, 19)
                    ForEach(store.snapshot.projects) { project in
                        navRow(project.name, symbol: "folder", selected: project.id == store.selectedProjectID && store.selection == "overview") { store.selectProject(project) }
                    }
                    if store.snapshot.projects.isEmpty { navRow("添加项目", symbol: "plus", selected: false, action: newProject) }
                    if store.selectedProject != nil {
                        HStack { heading("持续频道"); Spacer(); SmallIconButton(symbol: "plus", help: "新建频道", action: newChannel) }.padding(.top, 19)
                        ForEach(store.projectChannels) { channel in
                            Button { store.selectChannel(channel) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "number").font(.system(size: 14)).frame(width: 18)
                                    Text(channel.name).font(.system(size: 13)).lineLimit(1)
                                    Spacer(minLength: 3)
                                    if channel.status == "running" { Circle().fill(Color.morrowAccent).frame(width: 5, height: 5) }
                                    else if channel.status == "blocked" { Circle().fill(Color.morrowOrange).frame(width: 5, height: 5) }
                                }
                                .foregroundStyle(channel.id == store.selectedChannelID ? Color.morrowInk : Color.morrowSecondary)
                                .padding(.horizontal, 12).frame(height: 32)
                                .background(channel.id == store.selectedChannelID && store.selection == "channel" ? Color.black.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 6))
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                    heading("配置").padding(.top, 25)
                    navRow("运行引擎", symbol: "desktopcomputer", selected: store.selection == "runtimes") { store.selection = "runtimes" }
                    SettingsLink {
                        HStack(spacing: 10) {
                            Image(systemName: "gearshape").font(.system(size: 14)).frame(width: 18)
                            Text("设置").font(.system(size: 13))
                            Spacer()
                        }.foregroundStyle(Color.morrowSecondary).padding(.horizontal, 12).frame(height: 32).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }.padding(.horizontal, 8)
            }.scrollIndicators(.hidden)
            HStack(spacing: 7) {
                Circle().fill(store.isConnected ? Color.morrowGreen : Color.morrowOrange).frame(width: 5, height: 5)
                Text(store.isConnected ? store.connectionName : "服务未连接").font(.system(size: 12))
                Spacer()
                SmallIconButton(symbol: "arrow.clockwise", help: "重新连接执行服务") { Task { await store.reconnect() } }
            }.foregroundStyle(Color.morrowSecondary).padding(.leading, 19).padding(.trailing, 11).frame(height: 44)
        }.frame(maxHeight: .infinity).background(Color.morrowSidebar)
    }
    private func heading(_ value: String) -> some View {
        Text(value).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.morrowSecondary).padding(.leading, 8).frame(height: 28)
    }
    private func navRow(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14)).frame(width: 18)
                Text(title).font(.system(size: 13, weight: selected ? .medium : .regular)).lineLimit(1)
                Spacer(minLength: 4)
            }.foregroundStyle(selected ? Color.morrowInk : Color.morrowSecondary).padding(.horizontal, 12).frame(height: 32)
                .background(selected ? Color.black.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}
