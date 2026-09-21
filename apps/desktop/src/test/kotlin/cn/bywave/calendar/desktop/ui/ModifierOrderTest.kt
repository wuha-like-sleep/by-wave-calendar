// 修饰符顺序的门禁。
//
// 为什么值得一条测试：Compose 里 `Modifier.fillMaxWidth().widthIn(max = 760.dp)`
// 编译通过、运行不报错、窄窗口上看起来完全正常 —— 只有在够宽的屏幕上才看得出
// 限宽根本没生效。fillMaxWidth 先把约束钉成 min=max=父容器宽度，后面的 widthIn
// 只能在这个区间里 coerce，上限被吃掉。上一轮这批限宽第一版就是反着写的，
// 靠人眼在源码里看出来的。人眼下次不一定看得出来。
//
// 这条扫的是源码而不是渲染结果：桌面端没有 Compose UI 测试环境，而这个错误
// 恰好是纯语法层面就能判死的。

package cn.bywave.calendar.desktop.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

class ModifierOrderTest {

    // 只在**同一条轴**上才是问题。fillMaxWidth() 只钉宽度，后面跟一个
    // heightIn(max = 360.dp) 完全正常 —— 这条门禁的第一版没分轴，
    // 把 WeekView 的全天条带和 SearchDialog 的结果列表这两处正确写法
    // 也判成了错。一条会误报的门禁迟早被人注掉，所以这里按轴分开写。
    private val constraintAfterFill = listOf(
        // fillMaxSize 两条轴都钉死，后面任何一种限制都会被吃掉。
        Regex("""fillMaxSize\([^)]*\)\.(widthIn|heightIn|sizeIn|requiredWidthIn|requiredHeightIn|requiredSizeIn)\("""),
        Regex("""fillMaxWidth\([^)]*\)\.(widthIn|sizeIn|requiredWidthIn|requiredSizeIn)\("""),
        Regex("""fillMaxHeight\([^)]*\)\.(heightIn|sizeIn|requiredHeightIn|requiredSizeIn)\("""),
    )

    private fun sourceRoot(): File {
        // Gradle 把测试的工作目录设在模块根（apps/desktop）。
        val direct = File("src/main/kotlin")
        if (direct.isDirectory) return direct
        val fromRepo = File("apps/desktop/src/main/kotlin")
        if (fromRepo.isDirectory) return fromRepo
        error("找不到 src/main/kotlin，当前工作目录是 ${File(".").absolutePath}")
    }

    @Test
    fun `限宽限高不能排在 fillMax 后面`() {
        val offenders = mutableListOf<String>()
        sourceRoot().walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .forEach { f ->
                // 整份去空白，让跨行写的修饰符链也能被看成一条链。
                val flat = f.readText().replace(Regex("\\s+"), "")
                for (rx in constraintAfterFill) {
                    rx.findAll(flat).forEach { m ->
                        offenders.add("${f.path}: ${m.value}")
                    }
                }
            }
        assertTrue(
            offenders.isEmpty(),
            "这些地方的限宽/限高会被前面的 fillMax 静默吃掉（窄窗口上看不出来，宽屏上整段铺满）：\n" +
                offenders.joinToString("\n"),
        )
    }
}
