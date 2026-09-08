import SwiftUI
import AppKit

@main
struct NoHumanApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 1080, minHeight: 680)
                .preferredColorScheme(.light)
                .task { await store.start() }
        }
        .defaultSize(width: 1280, height: 800)
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("关于 NoHuman") {
                    NSApplication.shared.orderFrontStandardAboutPanel(options: [
                        .applicationName: "NoHuman",
                        .applicationVersion: "0.1.0",
                        .credits: NSAttributedString(string: "让每个项目，都有持续负责的 AI。\n本地优先 · 原生 macOS · 多运行时")
                    ])
                }
            }
            CommandGroup(after: .appSettings) {
                Button("打开执行服务数据目录") { store.openDataDirectory() }
                Button("重新连接执行服务") { Task { await store.reconnect() } }
            }
            CommandGroup(replacing: .newItem) { }
        }
        Settings {
            ConnectionSettingsView().environmentObject(store)
        }
    }
}
