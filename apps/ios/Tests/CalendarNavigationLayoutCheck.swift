import Foundation

@main struct CalendarNavigationLayoutCheck {
    static func main() {
        typealias Layout = CalendarNavigationLayout
        func layout(_ width: CGFloat, _ regular: Bool = true, large: Bool = false, collapsed: Bool = false) -> Layout {
            Layout(width: width, regular: regular, accessibilityText: large, collapsed: collapsed)
        }
        for width in [0, 320, 375, 466, 678, 951] {
            precondition(layout(CGFloat(width), false) == .systemTabs)
        }
        precondition(layout(.nan) == .systemTabs)
        precondition(layout(414) == .systemTabs)
        precondition(layout(415) == .rail(canExpand: false))
        precondition(layout(626) == .rail(canExpand: false))
        precondition(layout(627) == .sidebar(width: 218))
        precondition(layout(669, large: true) == .rail(canExpand: false))
        precondition(layout(951, collapsed: true) == .rail(canExpand: true))
        for width in stride(from: 0, through: 1600, by: 1) {
            for large in [false, true] {
                let result = layout(CGFloat(width), large: large)
                if case .sidebar(let sidebar) = result {
                    let dayWidth = (CGFloat(width) - sidebar - 1 - 44) / 7
                    precondition(dayWidth >= (large ? 60 : 52))
                    precondition(sidebar <= 310)
                }
            }
        }
        print("CalendarNavigationLayoutCheck passed")
    }
}
