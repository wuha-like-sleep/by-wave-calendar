// 调试日志垫片。
//
// 为什么要有这个文件：正式包里散落的 System.err.println 会被写进
// ~/Library/Logs/DiagnosticReports 和用户自己 `open -a` 起进程时的终端里。
// 里面有服务器地址、设备 id、更新源 URL、异常原文——都不该在一台
// 普通用户的机器上默认落盘。而开发时又确实需要这些行，所以不是删掉，
// 是加一道闸：默认关，需要排查时用环境变量临时打开。
//
// 打开方式（两种任选，都不需要重新打包）：
//   BYWAVE_DEBUG=1 open -a ByWaveCalendar
//   ./gradlew run -Dbywave.debug=true
//
// 两条约束，加新日志时请守住：
//   1. 消息体写成 lambda。关闭时 lambda 根本不执行，字符串模板里的
//      拼接（尤其是异常 message 的读取）就不会有任何开销。
//   2. 永远不要把 accessToken / refreshToken / 配对码打进来。日志会被
//      用户贴到 issue 里，那等于把账号交出去。

package cn.bywave.calendar.desktop.util

object DebugLog {
    /** 进程启动时读一次即可——环境变量在进程生命周期内不会变。 */
    private val enabled: Boolean =
        System.getenv("BYWAVE_DEBUG") == "1" ||
            System.getProperty("bywave.debug")?.equals("true", ignoreCase = true) == true

    fun d(tag: String, message: () -> String) {
        if (enabled) System.err.println("[$tag] ${message()}")
    }
}
