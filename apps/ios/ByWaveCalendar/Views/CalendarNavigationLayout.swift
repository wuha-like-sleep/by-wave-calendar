import Foundation

/// The sidebar may use the space left after reserving a readable seven-day grid.
enum CalendarNavigationLayout: Equatable {
    case systemTabs
    case rail(canExpand: Bool)
    case sidebar(width: CGFloat)

    static let railWidth: CGFloat = 62

    init(width: CGFloat, regular: Bool, accessibilityText: Bool, collapsed: Bool) {
        let gutter: CGFloat = 44
        let divider: CGFloat = 1
        guard regular, width.isFinite, width >= Self.railWidth + divider + gutter + 7 * 44 else {
            self = .systemTabs
            return
        }
        let minimumSidebar: CGFloat = accessibilityText ? 270 : 218
        let preferredDayWidth: CGFloat = accessibilityText ? 60 : 52
        let available = width - divider - gutter - 7 * preferredDayWidth
        let canExpand = available >= minimumSidebar
        if canExpand && !collapsed {
            let preferredWidth = min(310, max(minimumSidebar, width * 0.30))
            self = .sidebar(width: min(preferredWidth, available))
        } else {
            self = .rail(canExpand: canExpand)
        }
    }

    var width: CGFloat? {
        switch self {
        case .systemTabs: nil
        case .rail: Self.railWidth
        case .sidebar(let width): width
        }
    }

    var showsCalendarTools: Bool {
        if case .sidebar = self { return true }
        return false
    }

    var canToggle: Bool {
        switch self {
        case .systemTabs: false
        case .rail(let canExpand): canExpand
        case .sidebar: true
        }
    }
}
