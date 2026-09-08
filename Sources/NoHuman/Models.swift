import Foundation

struct WorkspaceSnapshot: Codable, Equatable {
    var projects: [Project]
    var channels: [Channel]
    var items: [WorkItem]
    var runs: [Run]
    var events: [Event]
    var runtimes: [Runtime]
    static let empty = WorkspaceSnapshot(projects: [], channels: [], items: [], runs: [], events: [], runtimes: [])
}

struct Project: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var path: String
    var goal: String
    var createdAt: String
    var isDemo: Bool
}

struct Channel: Codable, Identifiable, Hashable {
    var id: String
    var projectId: String
    var name: String
    var goal: String
    var runtime: String
    var model: String
    var status: String
    var intervalMinutes: Int
    var maxRunsPerDay: Int
    var permission: String
    var nextRunAt: String
    var lastRunAt: String
    var sessionId: String
}

struct WorkItem: Codable, Identifiable, Hashable {
    var id: String
    var channelId: String
    var title: String
    var summary: String
    var status: String
    var kind: String
    var evidence: [String]
    var nextStep: String
    var createdAt: String
    var updatedAt: String
}

struct Run: Codable, Identifiable, Hashable {
    var id: String
    var channelId: String
    var runtime: String
    var status: String
    var startedAt: String
    var finishedAt: String
    var summary: String
    var sessionId: String
}

struct Event: Codable, Identifiable, Hashable {
    var id: String
    var channelId: String
    var runId: String
    var kind: String
    var text: String
    var createdAt: String
}

struct Runtime: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var available: Bool
    var path: String
    var version: String
    var detail: String
    var canWrite: Bool
}
