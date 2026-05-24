// Normalize user-typed server URLs. Mirrors iOS SetupView's auto-detect
// logic (v0.9.1 "自动识别 https / http"). Strips trailing slash, lower-
// cases the host, prepends https:// if missing scheme.
//
// Why try HTTPS first: most self-hosted setups have Let's Encrypt these
// days. We only fall back to HTTP when HTTPS connect actively fails
// (handled in SetupViewModel, not here).

package cn.bywave.calendar.util

object ServerUrl {
    fun normalize(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return s
        // If user pasted with trailing slash(es), strip them.
        while (s.endsWith("/")) s = s.dropLast(1)
        // No scheme → assume https. We don't auto-fallback to http
        // here because that would silently downgrade users with typos
        // (e.g. "example.com.foo") to an unencrypted attempt.
        if (!s.startsWith("http://", ignoreCase = true) &&
            !s.startsWith("https://", ignoreCase = true)) {
            s = "https://$s"
        }
        return s
    }

    /** True if `s` looks like a parseable HTTP(S) URL after normalize. */
    fun looksValid(s: String): Boolean {
        val n = normalize(s)
        // Cheap structural check; OkHttp will do the real work.
        return n.length > 8 && (n.startsWith("http://") || n.startsWith("https://")) &&
            n.substringAfter("//").isNotEmpty()
    }
}
