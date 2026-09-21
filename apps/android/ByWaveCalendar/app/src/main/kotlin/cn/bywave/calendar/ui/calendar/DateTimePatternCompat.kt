// 把 ICU / CLDR 语法的日期 pattern 翻成 java.time 能吃的 pattern。
//
// 为什么要有这一层：
//   android.text.format.DateFormat.getBestDateTimePattern() 返回的是
//   **ICU（CLDR）语法**的 pattern；java.time 的 DateTimeFormatter.ofPattern()
//   收的是 **java.time 语法**的 pattern。两套语法不是一个集合，交集之外的
//   字符会让 ofPattern() 当场抛 IllegalArgumentException。
//
//   app/build.gradle.kts 没有开 coreLibraryDesugaring，minSdk = 26，所以设备上
//   跑的是 Android 平台自带的 java.time（OpenJDK 9/11 血统），它：
//     - 不认识 B / b（flexible day period，JDK 16 才进 java.time）；
//     - 把 #、{、} 当保留字符，出现在 pattern 里直接抛
//       "Pattern includes reserved character"；
//     - 不认识 ICU 后来新增的其它字段字母。
//
//   这不是假想。实测（icu4j 77.1 / CLDR 47，跑遍全部 881 个 locale）：
//     tok（托克劳语）的 Hm 就是 "#HH:mm"，喂给 ofPattern() 抛
//     IllegalArgumentException: Pattern includes reserved character: '#'。
//   而 zh-Hant 的**标准短时间格式**是 "Bh:mm"（JDK 自己的 CLDR 数据也是
//   这个），同样是 Android 那套 java.time 不认识的字母。
//
//   CalendarFormats 的五个 formatter 全是构造时求值的 val，任意一个抛出来
//   就是顶栏所在的每一个界面白屏 —— 所以这里做降级、CalendarFormats.of()
//   再包一层兜底，两道都要有。
//
// 这个文件**不引用任何 Android 类**，所以能在纯 JVM 单元测试里跑。

package cn.bywave.calendar.ui.calendar

/**
 * Android 平台自带的 java.time（JDK 9/11 血统）认识的 pattern 字母。
 *
 * 对照 java.time.format.DateTimeFormatter 的文档表格；JDK 16 之后才加进去的
 * B/b **不在**这里，因为 minSdk 26 且没开 desugaring 的情况下，设备上那份
 * java.time 是旧的。
 */
internal const val JAVA_TIME_PATTERN_LETTERS = "GuyDMLdQqYwWEecFahKkHmsSAnNVvzOXxZp"

/** java.time 的保留字符：出现在 pattern 里（未加引号）就抛异常。 */
private const val JAVA_TIME_RESERVED = "#{}"

private fun Char.isAsciiLetter(): Boolean = this in 'a'..'z' || this in 'A'..'Z'

/**
 * 把一条 CLDR pattern 翻成 java.time 语法。规则：
 *
 *   - 引号里的字面量原样搬运（含 '' 转义）；引号没闭合的补齐，
 *     否则 ofPattern() 会在末尾抛 "Pattern ends with an incomplete string literal"。
 *   - B / b（细分时段：早上/下午/晚上）降级成 a（AM/PM）。语义上这是
 *     CLDR 自己认的等价降级 —— 时段名没了，但时间本身仍然对。
 *   - 其它 java.time 不认识的字段字母整段丢掉。CLDR 里未加引号的 ASCII
 *     字母一律是字段而不是文字，所以丢掉字段比把字母当文字印出来更接近原意。
 *   - #、{、} 这三个保留字符在 CLDR 里是普通字面量，这里加引号保成字面量。
 *
 * 注意这里只保证「字母集合」合法。字段重复次数非法（例如 java.time 不收的
 * "cc"）这类问题 CLDR 数据里没出现过，但仍由 CalendarFormats.of() 的
 * runCatching 兜底。
 */
internal fun toJavaTimePattern(cldr: String): String {
    val out = StringBuilder(cldr.length)
    var i = 0
    while (i < cldr.length) {
        val c = cldr[i]
        when {
            c == '\'' -> i = copyQuoted(cldr, i, out)
            c.isAsciiLetter() -> {
                var j = i
                while (j < cldr.length && cldr[j] == c) j++
                when {
                    // 细分时段 → AM/PM。整段折成一个 a：java.time 里 a 只收一位。
                    c == 'B' || c == 'b' -> out.append('a')
                    JAVA_TIME_PATTERN_LETTERS.indexOf(c) >= 0 -> out.append(cldr, i, j)
                    else -> Unit
                }
                i = j
            }
            JAVA_TIME_RESERVED.indexOf(c) >= 0 -> {
                out.append('\'').append(c).append('\'')
                i++
            }
            else -> {
                out.append(c)
                i++
            }
        }
    }
    return out.toString()
}

/**
 * pattern 里所有 java.time 不认识的字符（未加引号的 ASCII 字母 + 保留字符）。
 * 空集合 = 这条 pattern 的字符集合是安全的。给门禁用，报错时能指名道姓。
 */
internal fun javaTimeUnsupportedChars(pattern: String): Set<Char> {
    val bad = linkedSetOf<Char>()
    var i = 0
    while (i < pattern.length) {
        val c = pattern[i]
        when {
            c == '\'' -> i = skipQuoted(pattern, i)
            c.isAsciiLetter() -> {
                if (JAVA_TIME_PATTERN_LETTERS.indexOf(c) < 0) bad += c
                i++
            }
            JAVA_TIME_RESERVED.indexOf(c) >= 0 -> {
                bad += c
                i++
            }
            else -> i++
        }
    }
    return bad
}

/** 搬运 pattern[start] 开始的那段引号字面量，返回下一个待处理下标。 */
private fun copyQuoted(src: String, start: Int, out: StringBuilder): Int {
    // '' —— 一个转义出来的单引号字面量，不是一段字面量的开头。
    if (start + 1 < src.length && src[start + 1] == '\'') {
        out.append("''")
        return start + 2
    }
    out.append('\'')
    var i = start + 1
    while (i < src.length) {
        val c = src[i]
        if (c == '\'') {
            if (i + 1 < src.length && src[i + 1] == '\'') {
                out.append("''")
                i += 2
                continue
            }
            out.append('\'')
            return i + 1
        }
        out.append(c)
        i++
    }
    // 引号没闭合（CLDR 数据里真的有这种，例如 nnh 的 yMMMd）。补一个。
    out.append('\'')
    return i
}

/** 跳过 pattern[start] 开始的那段引号字面量，返回下一个待处理下标。 */
private fun skipQuoted(src: String, start: Int): Int {
    if (start + 1 < src.length && src[start + 1] == '\'') return start + 2
    var i = start + 1
    while (i < src.length) {
        if (src[i] == '\'') {
            if (i + 1 < src.length && src[i + 1] == '\'') {
                i += 2
                continue
            }
            return i + 1
        }
        i++
    }
    return i
}
