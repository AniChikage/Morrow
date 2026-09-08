import SwiftUI

struct ConnectionSettingsView: View {
    @EnvironmentObject var store: AppStore
    @State private var host = UserDefaults.standard.string(forKey: "remoteHost") ?? ""
    @State private var directory = UserDefaults.standard.string(forKey: "remoteDirectory") ?? "~/.local/share/nohuman"
    @State private var servicePort = UserDefaults.standard.integer(forKey: "remotePort") == 0 ? 43821 : UserDefaults.standard.integer(forKey: "remotePort")

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Label("执行位置", systemImage: "desktopcomputer").font(.title2.weight(.semibold))
            Text("当前：\(store.connectionName)").font(.subheadline).foregroundStyle(.secondary)
            GroupBox {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("这台 Mac").font(.headline)
                        Text("服务随 App 启动，关窗或退出 App 后仍会继续。Mac 休眠时执行暂停。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("连接本机") { Task { await store.connectLocal() } }
                }.padding(8)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 12) {
                    Label("远程主机 · SSH", systemImage: "server.rack").font(.headline)
                    Text("连接已运行的 NoHuman 服务。使用已有 SSH 登录配置；远程任务在 Mac 合盖后继续。")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("SSH 主机别名或 user@host", text: $host)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("SSH 主机")
                    TextField("远程数据目录", text: $directory).textFieldStyle(.roundedBorder)
                    HStack {
                        Text("服务端口").font(.caption)
                        TextField("43821", value: $servicePort, format: .number.grouping(.never)).frame(width: 90)
                        Spacer()
                        Button("连接远程服务") { Task { await store.connectRemote(host: host, remotePort: servicePort, directory: directory) } }
                            .buttonStyle(.borderedProminent).disabled(host.isEmpty)
                    }
                }.padding(8)
            }
            if let error = store.errorMessage { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            if store.isBusy { ProgressView("正在连接…").controlSize(.small) }
            Text("服务令牌只保留在内存，通过 SSH 读取；不会复制模型凭据。远程目录与本地目录独立。")
                .font(.caption2).foregroundStyle(.secondary)
        }.padding(28).frame(width: 560).disabled(store.isBusy)
    }
}
