package cn.bywave.calendar.desktop.data.update

import java.util.Base64

/** Windows paths are data, never cmd.exe source. EncodedCommand preserves Unicode. */
internal object WindowsUpdateScript {
    fun literal(value: String): String {
        require(value.none { it == '\u0000' || it == '\r' || it == '\n' }) { "Invalid path" }
        return "'" + value.replace("'", "''") + "'"
    }

    fun encoded(script: String): String = Base64.getEncoder().encodeToString(script.toByteArray(Charsets.UTF_16LE))

    fun build(msi: String, executable: String?, parentPid: Long, sha256: String,
              log: String, ready: String, relaunch: Boolean): String {
        require(sha256.matches(Regex("[a-fA-F0-9]{64}")))
        require(parentPid > 0)
        val dollar = '$'
        return """
            ${dollar}ErrorActionPreference = 'Stop'
            ${dollar}ProgressPreference = 'SilentlyContinue'
            ${dollar}msi = ${literal(msi)}
            ${dollar}exe = ${executable?.let(::literal) ?: "\$null"}
            ${dollar}log = ${literal(log)}
            ${dollar}ready = ${literal(ready)}
            ${dollar}expectedHash = ${literal(sha256.lowercase())}
            ${dollar}relaunch = ${if (relaunch) "\$true" else "\$false"}
            function Write-UpdateLog([string]${dollar}message) {
                Add-Content -LiteralPath ${dollar}log -Value ("[{0:o}] {1}" -f [DateTime]::Now, ${dollar}message) -Encoding UTF8
            }
            try {
                if (-not (Test-Path -LiteralPath ${dollar}msi -PathType Leaf)) { throw 'Installer is missing' }
                if ((Get-FileHash -LiteralPath ${dollar}msi -Algorithm SHA256).Hash -ne ${dollar}expectedHash) {
                    throw 'Installer changed before installation'
                }
                ${dollar}parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
                Set-Content -LiteralPath ${dollar}ready -Value 'ready' -Encoding ASCII
                if (${dollar}parent -and -not ${dollar}parent.WaitForExit(120000)) {
                    throw 'Application is still running; installation cancelled'
                }
                # Recheck after waiting: a staged file may have changed while the app closed.
                if ((Get-FileHash -LiteralPath ${dollar}msi -Algorithm SHA256).Hash -ne ${dollar}expectedHash) {
                    throw 'Installer changed while waiting for application exit'
                }
                ${dollar}arguments = '/i "' + ${dollar}msi + '" /passive /norestart /L*v "' + ${dollar}log + '.msi.log"'
                ${dollar}msiexec = Join-Path ${dollar}env:SystemRoot 'System32\msiexec.exe'
                ${dollar}process = Start-Process -FilePath ${dollar}msiexec -ArgumentList ${dollar}arguments -Wait -PassThru
                ${dollar}result = ${dollar}process.ExitCode
                if (${dollar}result -eq 0) {
                    Write-UpdateLog 'Installation succeeded'
                    if (${dollar}relaunch -and ${dollar}exe -and (Test-Path -LiteralPath ${dollar}exe)) {
                        Start-Process -FilePath ${dollar}exe
                    }
                } elseif (${dollar}result -in @(3010, 1641)) {
                    # Success requiring a reboot is not a failed installation. Do not reinstall
                    # or launch a runtime whose files may still be pending replacement.
                    Write-UpdateLog ("Installation succeeded; Windows restart required ({0})" -f ${dollar}result)
                } elseif (${dollar}result -eq 1602) {
                    Write-UpdateLog 'Installation cancelled by user'
                    if (${dollar}relaunch -and ${dollar}exe -and (Test-Path -LiteralPath ${dollar}exe)) {
                        Start-Process -FilePath ${dollar}exe
                    }
                } else {
                    Write-UpdateLog ("Installation failed ({0})" -f ${dollar}result)
                    if (${dollar}relaunch) { Start-Process -FilePath ${dollar}msi }
                    exit 1
                }
            } catch {
                Write-UpdateLog ${dollar}_.Exception.Message
                exit 1
            } finally {
                Remove-Item -LiteralPath ${dollar}ready -Force -ErrorAction SilentlyContinue
            }
        """.trimIndent()
    }
}
