import Foundation

/// The UI owns only the tunnel. The remote execution service has an independent lifecycle.
@MainActor
final class SSHConnection {
    private var tunnel: Process?
    let localPort = 43822

    func stop() {
        if let tunnel, tunnel.isRunning { tunnel.terminate() }
        tunnel = nil
    }

    func connect(host: String, remotePort: Int, remoteDirectory: String) async throws -> String {
        guard host.range(of: "^[A-Za-z0-9][A-Za-z0-9_.@:-]*$", options: .regularExpression) != nil,
              (1...65535).contains(remotePort) else {
            throw ServiceError.message("请输入 SSH 配置中的主机别名或 user@host，以及有效端口。")
        }
        let directory = remoteDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (directory.hasPrefix("/") || directory.hasPrefix("~/")), !directory.contains("\n"), !directory.contains("\0") else {
            throw ServiceError.message("远程数据目录必须是绝对路径，或以 ~/ 开头。")
        }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let tokenPath = directory.hasPrefix("~/") ? "\"$HOME\"/" + quote(String(directory.dropFirst(2)) + "/token") : quote(directory + "/token")
        let token = try await Self.captureSSH(host: host, command: "head -c 129 -- " + tokenPath)
        guard token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw ServiceError.message("远程令牌格式无效。请确认远程 Morrow 服务已启动、数据目录正确。")
        }
        stop()
        try await Task.sleep(for: .milliseconds(200))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", "127.0.0.1:\(localPort):127.0.0.1:\(remotePort)", host]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        tunnel = process
        try await Task.sleep(for: .milliseconds(800))
        guard process.isRunning else {
            throw ServiceError.message("SSH 隧道未能建立。请检查主机连接，或本地 43822 端口是否被占用。")
        }
        return token
    }

    private static func captureSSH(host: String, command: String) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            process.arguments = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", host, command]
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            let timer = DispatchSource.makeTimerSource()
            timer.schedule(deadline: .now() + 12)
            timer.setEventHandler { if process.isRunning { process.terminate() } }
            timer.resume()
            defer { timer.cancel() }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0, data.count <= 128 else {
                throw ServiceError.message("无法读取远程服务令牌。请先在终端完成 SSH 首次连接，并确认远程服务已运行。")
            }
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }.value
    }
}
