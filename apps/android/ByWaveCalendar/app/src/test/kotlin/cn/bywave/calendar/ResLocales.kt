// 门禁共用的小工具：直接从 app/src/main/res 里数「本 APP 到底带了几种语言」，
// 以及把某个 key 在各语言下的取值读出来。
//
// 为什么读文件而不是读常量：语言这件事的唯一事实是资源目录本身。写一份
// 常量清单去对照，只能证明清单和清单一致 —— 新加一个 values-xx 而漏了门禁，
// 或者某门语言少写了一条 string，都照样绿。

package cn.bywave.calendar

import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

object ResLocales {

    /** 8 种语言是硬要求。少一门就该红。 */
    val REQUIRED_TAGS = listOf("zh-Hans", "zh-TW", "en", "ja", "ko", "es", "fr", "de")

    /** app/src/main/res。单元测试的工作目录是 :app 模块目录，但别指望它 —— 往上找。 */
    val resDir: File by lazy {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "src/main/res")
            if (candidate.isDirectory) return@lazy candidate
            val nested = File(dir, "app/src/main/res")
            if (nested.isDirectory) return@lazy nested
            dir = dir.parentFile
        }
        throw IllegalStateException("找不到 app/src/main/res，起点：${System.getProperty("user.dir")}")
    }

    /**
     * 资源目录 → BCP-47 语言标签。
     *
     * 默认的 values/ 目录装的是简体中文（本仓的默认语言），所以它算 zh-Hans；
     * values-zh-rTW 这种 Android 老写法转成 zh-TW。
     */
    fun localeTags(): Map<String, String> {
        val out = linkedMapOf<String, String>()
        val dirs = resDir.listFiles { f: File -> f.isDirectory && f.name.startsWith("values") } ?: emptyArray()
        for (dir in dirs.sortedBy { it.name }) {
            if (!File(dir, "strings.xml").isFile) continue
            val qualifier = dir.name.removePrefix("values").removePrefix("-")
            val tag = when {
                qualifier.isEmpty() -> "zh-Hans"   // 默认资源 = 简体中文
                else -> qualifier.replace("-r", "-")
            }
            out[dir.name] = tag
        }
        return out
    }

    /** 把某个资源目录下所有 strings*.xml 里的 <string> 读成 map。 */
    fun strings(dirName: String): Map<String, String> {
        val dir = File(resDir, dirName)
        val out = linkedMapOf<String, String>()
        val files = dir.listFiles { f: File -> f.isFile && f.name.startsWith("strings") && f.name.endsWith(".xml") }
            ?: emptyArray()
        val factory = DocumentBuilderFactory.newInstance()
        for (file in files.sortedBy { it.name }) {
            val doc = factory.newDocumentBuilder().parse(file)
            val nodes = doc.getElementsByTagName("string")
            for (i in 0 until nodes.length) {
                val el = nodes.item(i) as Element
                out[el.getAttribute("name")] = el.textContent
            }
        }
        return out
    }
}
