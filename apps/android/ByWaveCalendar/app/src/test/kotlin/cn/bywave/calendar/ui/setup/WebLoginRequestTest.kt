package cn.bywave.calendar.ui.setup

import org.junit.Assert.*
import org.junit.Test

class WebLoginRequestTest {
    private val now = 10_000L
    private val code = "BW1." + "a".repeat(43)
    private fun request() = WebLoginRequest.create("https://calendar.example", "bywave-staging", now)
    private fun callback(r: WebLoginRequest) = "bywave-staging://auth/complete?state=${r.state}&code=$code"
    @Test fun pkceMatchesPublishedVector() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", WebLoginRequest.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }
    @Test fun keepsProofOffBrowserAndBindsReturn() {
        val r = request()
        assertEquals(43, r.verifier.length); assertEquals(43, r.state.length)
        assertFalse(r.authorizationUrl.contains(r.verifier))
        assertEquals(code, r.callbackCode(callback(r), now))
        assertNotEquals(r.state, request().state)
    }
    @Test fun rejectsCallbackSubstitutionDuplicatesAndReplayWindow() {
        val r = request(); val good = callback(r)
        for (bad in listOf(good.replace("staging", "other"), good.replace("//auth", "//evil"), good.replace("/complete", "/elsewhere"), good + "&state=${r.state}", good + "&code=$code", good + "#fragment", good.replace(r.state, "bad"), good.replace(code, "ABC123"))) {
            assertThrows(Exception::class.java) { r.callbackCode(bad, now) }
        }
        assertThrows(Exception::class.java) { r.callbackCode(good, now - 1) }
        assertThrows(Exception::class.java) { r.callbackCode(good, now + 600_000) }
    }
    @Test fun rejectsUntrustedServerAndRecognizesExplicitCancellation() {
        for (server in listOf("http://calendar.example", "https://user:pass@calendar.example", "https://calendar.example#x", "https://calendar.example?x=y")) {
            assertThrows(Exception::class.java) { WebLoginRequest.create(server, "bywave", now) }
        }
        val r = request()
        assertThrows(WebLoginCancelled::class.java) { r.callbackCode("bywave-staging://auth/complete?state=${r.state}&error=access_denied", now) }
    }
}
