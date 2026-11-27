import Foundation

// 购买清单条目 PATCH 的数量三态编码校验（ShoppingItemUpdateInput）：
// 服务端按「键不出现 = 不动、显式 null = 清空、数字 = 改值」逐字段
// 合并，而 Swift 合成编码会把 nil 一律省掉 —— 数量一度因此清不掉。
// 这里把三种命运在 JSON 层面钉死。本机无 Xcode 工具链，这份脚本
// 随代码提交、在有工具链的环境按其余 *Check.swift 的方式编译
// 运行（依赖 Models.swift）。
@main struct ShoppingItemUpdateEncodingCheck {
    static func json(_ input: ShoppingItemUpdateInput) throws -> [String: Any] {
        let data = try JSONEncoder.iso().encode(input)
        let obj = try JSONSerialization.jsonObject(with: data)
        return obj as? [String: Any] ?? [:]
    }

    static func main() throws {
        // 勾选切换：只发 done，数量键整个不出现（服务端保持原值）。
        var body = try json(ShoppingItemUpdateInput(
            name: nil, quantity: .unmanaged, unit: nil, note: nil, done: true))
        precondition(body.count == 1 && (body["done"] as? Bool) == true)

        // 编辑器把数量框清空：quantity 必须是显式 null，而不是省掉。
        body = try json(ShoppingItemUpdateInput(
            name: "番茄", quantity: .cleared, unit: "", note: "", done: nil))
        precondition(body["quantity"] is NSNull)

        // 填了数量：原样发数字。
        body = try json(ShoppingItemUpdateInput(
            name: "番茄", quantity: .value(2.5), unit: "个", note: nil, done: nil))
        precondition((body["quantity"] as? Double) == 2.5)
        precondition(body["note"] == nil)

        print("ShoppingItemUpdateEncodingCheck: all preconditions passed")
    }
}
