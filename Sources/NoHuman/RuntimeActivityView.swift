import SwiftUI

struct RuntimesView: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("已检测到 \(store.snapshot.runtimes.filter(\.available).count) 个引擎")
                    .font(.system(size: 12)).foregroundStyle(Color.nhSecondary)
                Spacer()
                NHButton(title: "重新检测", symbol: "arrow.clockwise") { Task { await store.refreshRuntimes() } }
                    .disabled(store.isBusy || !store.isConnected)
            }
            .padding(.horizontal, 18).frame(height: 44)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Text("引擎").frame(maxWidth: .infinity, alignment: .leading)
                        Text("版本").frame(width: 150, alignment: .leading)
                        Text("状态").frame(width: 88, alignment: .trailing)
                    }
                    .font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                    .padding(.vertical, 10)
                    .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
                    if store.snapshot.runtimes.isEmpty {
                        EmptyPanel(symbol: "terminal", title: "暂无检测结果", detail: "连接执行服务后，点击「重新检测」。")
                    } else {
                        ForEach(store.snapshot.runtimes) { runtime in RuntimeRow(runtime: runtime) }
                    }
                    Text("使用 \(store.connectionName) 上的 CLI 登录状态。检测仅确认安装；登录与配额在执行时验证。")
                        .font(.system(size: 12)).foregroundStyle(Color.nhSecondary).lineSpacing(3)
                        .padding(.top, 16)
                    Text("在终端安装并登录引擎后，为频道选择运行时、模型和权限。切换引擎会开启新会话，保留频道历史与证据。")
                        .font(.system(size: 12)).foregroundStyle(Color.nhSecondary).lineSpacing(3)
                        .padding(.top, 8)
                }
                .padding(.horizontal, 18).padding(.bottom, 20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct RuntimeRow: View {
    let runtime: Runtime
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: runtime.id == "claude" ? "sun.max" : "terminal")
                        .font(.system(size: 14)).foregroundStyle(Color.nhSecondary)
                        .frame(width: 17)
                    Text(runtime.name).font(.system(size: 13, weight: .medium))
                }.frame(maxWidth: .infinity, alignment: .leading)
                Text(runtime.version.isEmpty ? "—" : runtime.version)
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.nhSecondary)
                    .lineLimit(1).help(runtime.version)
                    .frame(width: 150, alignment: .leading)
                HStack(spacing: 5) {
                    Circle().fill(runtime.available ? Color.nhGreen : Color.nhSecondary).frame(width: 5, height: 5)
                    Text(runtime.available ? "已检测到" : "未检测到").font(.system(size: 11))
                }.foregroundStyle(Color.nhSecondary).frame(width: 88, alignment: .trailing)
            }
            Text(runtime.detail).font(.system(size: 12)).foregroundStyle(Color.nhSecondary)
                .lineSpacing(3).textSelection(.enabled)
            if !runtime.path.isEmpty {
                Text(runtime.path).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.nhSecondary)
                    .textSelection(.enabled)
            }
            if runtime.available {
                Label(runtime.canWrite ? "只读 / 工作区写入" : "仅只读", systemImage: "lock.shield")
                    .font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
    }
}

struct ActivityView: View {
    @EnvironmentObject var store: AppStore
    private var runs: [Run] {
        let ids = Set(store.projectChannels.map(\.id))
        return store.snapshot.runs.filter { ids.contains($0.channelId) }.sorted { $0.startedAt > $1.startedAt }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("全部运行").font(.system(size: 12, weight: .medium))
                Text("\(runs.count)").font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
                Spacer()
                Text("最新优先").font(.system(size: 11)).foregroundStyle(Color.nhSecondary)
            }
            .padding(.horizontal, 18).frame(height: 44)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.nhLine).frame(height: 1) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if runs.isEmpty {
                        EmptyPanel(symbol: "clock.arrow.circlepath", title: "暂无运行记录", detail: "打开频道，点击「运行一次」开始执行。")
                    } else {
                        ForEach(runs) { run in
                            VStack(alignment: .leading, spacing: 0) {
                                if let channel = store.projectChannels.first(where: { $0.id == run.channelId }) {
                                    Button { store.selectChannel(channel) } label: {
                                        HStack(spacing: 5) {
                                            Text("# \(channel.name)")
                                            Image(systemName: "arrow.up.right").font(.system(size: 9))
                                        }
                                        .font(.system(size: 12)).foregroundStyle(Color.nhSecondary)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(.top, 13)
                                }
                                RunCard(run: run)
                            }
                        }
                    }
                }.padding(.horizontal, 18).padding(.bottom, 16)
            }
        }
    }
}
