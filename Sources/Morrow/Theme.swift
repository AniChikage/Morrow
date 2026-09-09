import SwiftUI

extension Color {
    static let morrowAccent = Color(red: 0.39, green: 0.34, blue: 0.88)
    static let morrowInk = Color(red: 0.14, green: 0.14, blue: 0.15)
    static let morrowSecondary = Color(red: 0.49, green: 0.49, blue: 0.51)
    static let morrowSidebar = Color(red: 0.9608, green: 0.9647, blue: 0.9686)
    static let morrowCanvas = Color(red: 0.9882, green: 0.9882, blue: 0.9882)
    static let morrowLine = Color(red: 0.919, green: 0.923, blue: 0.927)
    static let morrowGreen = Color(red: 0.23, green: 0.54, blue: 0.43)
    static let morrowOrange = Color(red: 0.69, green: 0.45, blue: 0.21)
}

struct NHButton: View {
    var title: String
    var symbol: String? = nil
    var primary = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 12)) }
                Text(title).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(primary ? .white : Color.morrowInk)
            .padding(.horizontal, 9).frame(height: 28)
            .background(primary ? Color.morrowInk : Color.morrowCanvas, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(primary ? Color.clear : Color.morrowLine, lineWidth: 1))
        }.buttonStyle(.plain).fixedSize()
    }
}

struct StatusBadge: View {
    var status: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: 5, height: 5)
            Text(statusTitle(status)).font(.system(size: 12))
        }
        .foregroundStyle(Color.morrowSecondary)
    }
    var tint: Color {
        switch status {
        case "running", "investigating": return .morrowAccent
        case "completed", "verified", "resolved", "idle": return .morrowGreen
        case "failed", "error", "blocked": return .morrowOrange
        default: return .morrowSecondary
        }
    }
}

struct DemoBadge: View {
    var body: some View {
        Text("示例").font(.system(size: 11)).foregroundStyle(Color.morrowSecondary)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.morrowLine, lineWidth: 1))
    }
}

struct SectionEyebrow: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.morrowInk)
    }
}

struct EmptyPanel: View {
    var symbol: String
    var title: String
    var detail: String
    var body: some View {
        VStack(spacing: 11) {
            Image(systemName: symbol).font(.system(size: 29, weight: .regular)).foregroundStyle(Color.morrowSecondary)
                .frame(height: 42)
            Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Color.morrowSecondary)
            Text(detail).font(.system(size: 13)).foregroundStyle(Color.morrowSecondary).multilineTextAlignment(.center).lineSpacing(3).frame(maxWidth: 360)
        }.frame(maxWidth: .infinity).padding(.vertical, 44)
    }
}

func statusTitle(_ value: String) -> String {
    switch value {
    case "paused": return "已暂停"
    case "idle": return "等待下次运行"
    case "running": return "运行中"
    case "waiting": return "等待运行"
    case "blocked": return "需要关注"
    case "open": return "待处理"
    case "investigating": return "调查中"
    case "verified": return "已验证"
    case "resolved": return "已解决"
    case "completed": return "已完成"
    case "failed": return "运行失败"
    case "interrupted": return "已中断"
    default: return value
    }
}

func runtimeTitle(_ value: String) -> String {
    switch value { case "codex": return "Codex"; case "claude": return "Claude Code"; case "trae": return "Trae"; default: return value }
}
func kindTitle(_ value: String) -> String {
    switch value { case "issue": return "问题"; case "opportunity": return "机会"; case "hypothesis": return "假设"; default: return value }
}
func kindSymbol(_ value: String) -> String {
    switch value { case "issue": return "circle.dashed"; case "opportunity": return "sparkle"; default: return "lightbulb" }
}
func displayDate(_ value: String, includeDate: Bool = true) -> String {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = iso.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return value.isEmpty ? "尚未运行" : value }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = includeDate ? "MM月dd日 HH:mm" : "HH:mm"
    return formatter.string(from: date)
}

struct SmallIconButton: View {
    var symbol: String
    var help: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(Color.morrowSecondary).frame(width: 28, height: 28).contentShape(Rectangle()) }
            .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }
}
