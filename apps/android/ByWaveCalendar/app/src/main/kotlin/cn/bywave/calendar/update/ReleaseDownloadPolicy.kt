package cn.bywave.calendar.update

import java.net.URI

internal fun validReleaseDownload(release: AndroidReleaseDto): Boolean = runCatching {
    val url = URI(release.url)
    url.scheme.equals("https", true) && !url.host.isNullOrBlank() && url.userInfo == null && url.fragment == null &&
        release.versionCode > 0 && release.sizeBytes in 1..(512L * 1024 * 1024) &&
        Regex("[a-fA-F0-9]{64}").matches(release.sha256)
}.getOrDefault(false)
