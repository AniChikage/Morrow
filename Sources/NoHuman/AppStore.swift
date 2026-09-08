import SwiftUI
import AppKit

enum ServiceError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

@MainActor
final class AppStore: ObservableObject {
    @Published var snapshot = WorkspaceSnapshot.empty
    @Published var selectedProjectID: String? {
        didSet { UserDefaults.standard.set(selectedProjectID, forKey: "selectedProjectID") }
    }
    @Published var selectedChannelID: String?
    @Published var selection = "overview"
    @Published var isConnected = false
    @Published var errorMessage: String?
    @Published var isBusy = false
    @Published var isStarting = true
    @Published private(set) var usingRemote = false
    @Published private(set) var remoteHost = ""

    private var pollTask: Task<Void, Never>?
    private var refreshing = false
    private var connectionTransition = false
    private var connectionGeneration = 0
    private var remoteToken = ""
    private let ssh = SSHConnection()
    private var terminationObserver: NSObjectProtocol?
    private var serviceProcess: Process?
    private let session: URLSession
    let dataDirectory: URL
    let localPort: Int
    var port: Int { usingRemote ? ssh.localPort : localPort }
    var connectionName: String { usingRemote ? "远程 · \(remoteHost)" : "本机 Mac" }

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        session = URLSession(configuration: config)
        let env = ProcessInfo.processInfo.environment
        dataDirectory = env["NOHUMAN_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/NoHuman", isDirectory: true)
        localPort = Int(env["NOHUMAN_PORT"] ?? "43821") ?? 43821
        selectedProjectID = UserDefaults.standard.string(forKey: "selectedProjectID")
        terminationObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.ssh.stop() }
        }
    }

    var selectedProject: Project? { snapshot.projects.first { $0.id == selectedProjectID } }
    var selectedChannel: Channel? { snapshot.channels.first { $0.id == selectedChannelID } }
    var projectChannels: [Channel] { snapshot.channels.filter { $0.projectId == selectedProjectID } }
    var filteredItems: [WorkItem] {
        let ids = Set(projectChannels.map(\.id))
        return snapshot.items.filter { item in
            selection == "channel" ? item.channelId == selectedChannelID : ids.contains(item.channelId)
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func start() async {
        guard pollTask == nil else { return }
        isStarting = true
        do {
            if UserDefaults.standard.bool(forKey: "usingRemote"), let host = UserDefaults.standard.string(forKey: "remoteHost") {
                await connectRemote(host: host, remotePort: UserDefaults.standard.integer(forKey: "remotePort"), directory: UserDefaults.standard.string(forKey: "remoteDirectory") ?? "~/.local/share/nohuman")
            } else {
            if !(await healthCheck()) { try startService() }
            for _ in 0..<40 {
                if await healthCheck() { break }
                try await Task.sleep(for: .milliseconds(250))
            }
            guard await healthCheck() else {
                throw ServiceError.message("执行服务未能启动。请检查 Node.js 24+ 是否已安装，或打开数据目录中的 service.log。")
            }
            await refresh()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isStarting = false
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                await self.refresh()
            }
        }
    }

    private func healthCheck() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.8
        guard let (data, response) = try? await session.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return json["service"] as? String == "nohuman" && json["ok"] as? Bool == true
    }

    private func startService() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = fm.homeDirectoryForCurrentUser.path
        let resources = Bundle.main.resourceURL
        let nodeCandidates: [String?] = [resources?.appendingPathComponent("bin/node").path,
                              ProcessInfo.processInfo.environment["NOHUMAN_NODE"],
                              "/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.local/bin/node"]
        guard let node = nodeCandidates.compactMap({ $0 }).first(where: fm.isExecutableFile(atPath:)) else {
            throw ServiceError.message("未找到 Node.js。请安装 Node.js 24 或更高版本，再重新打开 NoHuman。")
        }
        let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let candidates = [resources?.appendingPathComponent("service/server.ts"), sourceRoot.appendingPathComponent("service/server.ts")]
        guard let entry = candidates.compactMap({ $0 }).first(where: { fm.fileExists(atPath: $0.path) }) else {
            throw ServiceError.message("应用内缺少执行服务，请重新运行 scripts/build-app.sh 构建完整应用。")
        }
        let log = dataDirectory.appendingPathComponent("service.log")
        if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let logHandle = try FileHandle(forWritingTo: log)
        try logHandle.seekToEnd()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [entry.path]
        process.currentDirectoryURL = entry.deletingLastPathComponent()
        var environment = ProcessInfo.processInfo.environment
        let extra = "\(home)/.local/bin:\(home)/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = extra + ":" + (environment["PATH"] ?? "")
        environment["NOHUMAN_HOME"] = dataDirectory.path
        environment["NOHUMAN_PORT"] = String(port)
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = logHandle
        process.standardError = logHandle
        // The independent daemon intentionally remains alive when the UI exits.
        try process.run()
        try logHandle.close()
        serviceProcess = process
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let tokenURL = dataDirectory.appendingPathComponent("token")
        let token = usingRemote ? remoteToken : ((try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? "")
        guard !token.isEmpty else {
            throw ServiceError.message("执行服务尚未准备好，请稍后重试。")
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/\(path)") else { throw ServiceError.message("无效的服务地址。") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw ServiceError.message("执行服务未返回有效响应。") }
        guard (200..<300).contains(http.statusCode) else {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw ServiceError.message(json?["error"] as? String ?? "操作失败（\(http.statusCode)）。")
        }
        return data
    }

    func refresh() async {
        guard !refreshing, !connectionTransition else { return }
        refreshing = true
        let generation = connectionGeneration
        defer { refreshing = false }
        do {
            let data = try await request("state")
            guard generation == connectionGeneration else { return }
            let next = try JSONDecoder().decode(WorkspaceSnapshot.self, from: data)
            if snapshot != next { snapshot = next }
            if !isConnected && errorMessage?.hasPrefix("无法连接执行服务") == true { errorMessage = nil }
            isConnected = true
            if selectedProject == nil, let first = next.projects.first { selectProject(first) }
            if selectedChannelID != nil && selectedChannel == nil { selectedChannelID = nil; selection = "overview" }
        } catch {
            guard generation == connectionGeneration else { return }
            isConnected = false
            if !isStarting { errorMessage = "无法连接执行服务：\(error.localizedDescription)" }
        }
    }

    private func perform(_ operation: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do { try await operation(); await refresh() }
        catch { errorMessage = error.localizedDescription }
    }

    func selectProject(_ project: Project) {
        selectedProjectID = project.id
        selectedChannelID = nil
        selection = "overview"
    }

    func selectChannel(_ channel: Channel) {
        selectedProjectID = channel.projectId
        selectedChannelID = channel.id
        selection = "channel"
    }

    func createProject(name: String, path: String, goal: String) async {
        await perform {
            let data = try await request("projects", method: "POST", body: ["name": name, "path": path, "goal": goal])
            let project = try JSONDecoder().decode(Project.self, from: data)
            selectProject(project)
        }
    }

    func createChannel(name: String, goal: String, runtime: String) async {
        guard let projectID = selectedProjectID else { return }
        await perform {
            let data = try await request("channels", method: "POST", body: ["projectId": projectID, "name": name, "goal": goal, "runtime": runtime])
            let channel = try JSONDecoder().decode(Channel.self, from: data)
            selectChannel(channel)
        }
    }

    func updateChannel(_ channel: Channel) async {
        await perform {
            _ = try await request("channels/\(channel.id)", method: "PATCH", body: [
                "name": channel.name, "goal": channel.goal, "runtime": channel.runtime, "model": channel.model,
                "intervalMinutes": channel.intervalMinutes, "maxRunsPerDay": channel.maxRunsPerDay, "permission": channel.permission
            ])
        }
    }

    func channelAction(_ action: String) async {
        guard let id = selectedChannelID else { return }
        await perform { _ = try await request("channels/\(id)/action", method: "POST", body: ["action": action]) }
    }

    func sendMessage(_ text: String) async {
        guard let id = selectedChannelID, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        await perform { _ = try await request("channels/\(id)/messages", method: "POST", body: ["text": text]) }
    }

    func updateItem(_ item: WorkItem, status: String) async {
        await perform { _ = try await request("items/\(item.id)", method: "PATCH", body: ["status": status]) }
    }

    func loadDemo() async {
        await perform { _ = try await request("demo", method: "POST", body: [:]) }
        if let project = snapshot.projects.first(where: \.isDemo) { selectProject(project) }
    }

    func refreshRuntimes() async {
        await perform { _ = try await request("runtimes/refresh", method: "POST", body: [:]) }
    }

    func reconnect() async {
        if usingRemote {
            await connectRemote(host: remoteHost, remotePort: UserDefaults.standard.integer(forKey: "remotePort"), directory: UserDefaults.standard.string(forKey: "remoteDirectory") ?? "~/.local/share/nohuman")
            return
        }
        errorMessage = nil
        if !(await healthCheck()) {
            do { try startService(); try await Task.sleep(for: .milliseconds(700)) }
            catch { errorMessage = error.localizedDescription }
        }
        await refresh()
    }

    func chooseFolder() -> String? {
        guard !usingRemote else { errorMessage = "远程项目请直接填写远程主机上的绝对目录路径。"; return nil }
        let panel = NSOpenPanel()
        panel.title = "选择项目目录"
        panel.prompt = "接入此目录"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    func openDataDirectory() { NSWorkspace.shared.open(dataDirectory) }

    func connectRemote(host: String, remotePort: Int, directory: String) async {
        guard !isBusy else { return }
        isBusy = true
        connectionTransition = true
        connectionGeneration += 1
        errorMessage = nil
        defer { isBusy = false; connectionTransition = false }
        usingRemote = true
        remoteHost = host
        isConnected = false
        snapshot = .empty
        selectedProjectID = nil
        selectedChannelID = nil
        do {
            remoteToken = try await ssh.connect(host: host, remotePort: remotePort, remoteDirectory: directory)
            var healthy = false
            for _ in 0..<12 {
                if await healthCheck() { healthy = true; break }
                try await Task.sleep(for: .milliseconds(250))
            }
            guard healthy else { throw ServiceError.message("SSH 已连接，但远程 NoHuman 服务无响应。请确认服务端口。") }
            let data = try await request("state")
            snapshot = try JSONDecoder().decode(WorkspaceSnapshot.self, from: data)
            isConnected = true
            if let first = snapshot.projects.first { selectProject(first) }
            UserDefaults.standard.set(true, forKey: "usingRemote")
            UserDefaults.standard.set(host, forKey: "remoteHost")
            UserDefaults.standard.set(remotePort, forKey: "remotePort")
            UserDefaults.standard.set(directory, forKey: "remoteDirectory")
        } catch { remoteToken = ""; ssh.stop(); errorMessage = error.localizedDescription }
    }

    func connectLocal() async {
        guard !isBusy else { return }
        ssh.stop()
        connectionGeneration += 1
        usingRemote = false
        remoteToken = ""
        UserDefaults.standard.set(false, forKey: "usingRemote")
        snapshot = .empty
        selectedProjectID = nil
        selectedChannelID = nil
        await reconnect()
    }
}
