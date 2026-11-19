package cn.bywave.calendar.update

import org.junit.Assert.*
import org.junit.Test

class ReleaseDownloadPolicyTest {
    private val release = AndroidReleaseDto(30, "1.0", "https://calendar.example/update.apk", "a".repeat(64), 128_000)
    @Test fun acceptsBoundedHttpsDownloadWithDigest() { assertTrue(validReleaseDownload(release)) }
    @Test fun rejectsMissingOrMalformedIntegrityAndSize() {
        for (hash in listOf("", "a".repeat(63), "g".repeat(64))) assertFalse(validReleaseDownload(release.copy(sha256 = hash)))
        for (size in listOf(0L, -1L, 512L * 1024 * 1024 + 1)) assertFalse(validReleaseDownload(release.copy(sizeBytes = size)))
    }
    @Test fun rejectsImpossibleMandatoryUpgradeAndEmptyVersion() {
        assertFalse(validReleaseDownload(release.copy(minSupportedVersionCode = 31)))
        assertFalse(validReleaseDownload(release.copy(minSupportedVersionCode = 0)))
        assertFalse(validReleaseDownload(release.copy(versionName = " ")))
        assertTrue(validReleaseDownload(release.copy(minSupportedVersionCode = 30)))
    }
    @Test fun rejectsInsecureAndCredentialBearingUrls() {
        for (url in listOf("http://calendar.example/app.apk", "file:///tmp/app.apk", "https://user:password@calendar.example/app.apk", "https://calendar.example/app.apk#file", "not a URL")) {
            assertFalse(url, validReleaseDownload(release.copy(url = url)))
        }
    }
    @Test fun fallbackUrlIsOptionalButMustBeUsableWhenPresent() {
        assertTrue(validReleaseDownload(release.copy(fallbackUrl = "")))
        assertTrue(validReleaseDownload(release.copy(fallbackUrl = "https://github.com/example/app.apk")))
        // A bad fallback must not poison an otherwise valid release —
        // the downloader just won't use it.
        assertTrue(validReleaseDownload(release.copy(fallbackUrl = "http://calendar.example/app.apk")))
        assertTrue(isUsableDownloadUrl("https://github.com/example/app.apk"))
        assertFalse(isUsableDownloadUrl("http://calendar.example/app.apk"))
        assertFalse(isUsableDownloadUrl("https://user:password@calendar.example/app.apk"))
        assertFalse(isUsableDownloadUrl("not a URL"))
    }
}
