package cn.bywave.calendar.ui.setup

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.Serializable

class WebLoginCancelled : Exception()

@Serializable
data class WebLoginRequest(
    val server: String,
    val scheme: String,
    val state: String,
    val verifier: String,
    val createdAt: Long,
) {
    val authorizationUrl: String get() = server.trimEnd('/') + "/app/auth/native?" + mapOf(
        "state" to state, "scheme" to scheme, "code_challenge" to challenge(verifier),
        "code_challenge_method" to "S256",
    ).entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, "UTF-8")}" }

    fun isExpired(now: Long = System.currentTimeMillis()) = now < createdAt || now - createdAt >= 600_000

    fun callbackCode(callback: String, now: Long = System.currentTimeMillis()): String {
        require(!isExpired(now)) { "expired" }
        val url = URI(callback)
        require(url.scheme == scheme && url.rawAuthority == "auth" && url.rawPath == "/complete" && url.rawFragment == null)
        val query = (url.rawQuery ?: "").split('&').map {
            val pair = it.split('=', limit = 2)
            URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
        }.groupBy({ it.first }, { it.second })
        require(query["state"] == listOf(state))
        if (query["error"] == listOf("access_denied") && query["code"] == null) throw WebLoginCancelled()
        require(query["error"] == null)
        val code = query["code"]?.singleOrNull() ?: throw IllegalArgumentException("missing code")
        require(Regex("BW1\\.[A-Za-z0-9_-]{43}").matches(code))
        return code
    }

    companion object {
        private fun base64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        fun challenge(verifier: String) = base64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        fun create(server: String, scheme: String, now: Long = System.currentTimeMillis()): WebLoginRequest {
            val url = URI(server)
            require(url.host != null && url.userInfo == null && url.rawQuery == null && url.rawFragment == null)
            val loopback = url.host.lowercase() in listOf("localhost", "127.0.0.1", "[::1]", "::1")
            require(url.scheme.equals("https", true) || (url.scheme.equals("http", true) && loopback))
            require(scheme in listOf("bywave", "bywave-staging"))
            val random = SecureRandom()
            return WebLoginRequest(server.trimEnd('/'), scheme,
                base64(ByteArray(32).also(random::nextBytes)), base64(ByteArray(32).also(random::nextBytes)), now)
        }
    }
}
