package cn.bywave.calendar.ui.setup

import cn.bywave.calendar.data.auth.SignInPrefill
import cn.bywave.calendar.data.auth.SignInPrefillSlot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 登录表单的两条规矩，按行为测：
 *  - 发出去的邮箱去掉首尾空格。服务端先校验邮箱格式、后去空格，输入法补的
 *    一个尾随空格就能让登录必回 400。
 *  - 从「某账号已被登出」提示条进来，登录页预填那个账号；普通「添加账号」是空白页。
 */
class SignInFormTest {

    @Test
    fun `发出去的邮箱去掉首尾空格`() {
        val bad = listOf("  alice@example.com \n", "alice@example.com\t")
            .map { it to SetupUiState(email = it).signInEmail }
            .filter { (_, sent) -> sent != "alice@example.com" }
            .map { (typed, sent) -> "输入 ${typed.replace("\n", "\\n").replace("\t", "\\t")} 发出去的是「$sent」" }
        assertTrue(bad.joinToString("\n"), bad.isEmpty())
    }

    @Test
    fun `从提示条进来_预填服务器和邮箱_密码留空`() {
        assertEquals(
            SetupUiState(server = "https://cal.example.com", email = "bob@example.com"),
            SetupUiState.initial(SignInPrefill(serverUrl = "https://cal.example.com", email = "bob@example.com")),
        )
    }

    @Test
    fun `没有预填_空白登录页`() {
        assertEquals(SetupUiState(), SetupUiState.initial(null))
    }

    @Test
    fun `预填取得到`() {
        val slot = SignInPrefillSlot()
        val p = SignInPrefill(serverUrl = "https://cal.example.com", email = "bob@example.com")
        slot.put(p)
        assertEquals(p, slot.take())
    }

    @Test
    fun `预填只取一次_以后的添加账号不会冒出旧账号`() {
        val slot = SignInPrefillSlot()
        slot.put(SignInPrefill(serverUrl = "https://cal.example.com", email = "bob@example.com"))
        slot.take()
        assertNull("取过一次还在，下一次「添加账号」会预填成这个旧账号", slot.take())
    }

    @Test
    fun `普通添加账号会清掉没取走的预填`() {
        val slot = SignInPrefillSlot()
        slot.put(SignInPrefill(serverUrl = "https://cal.example.com", email = "bob@example.com"))
        slot.put(null)
        assertNull(slot.take())
    }
}
