// QR rendering via zxing. Produces a Compose ImageBitmap straight from
// a string, no temp file or stream. Sized as a power of two for clean
// pixel-aligned rendering on hi-dpi screens.
//
// We pin error-correction to M (15%) — high enough to survive a phone
// camera pointed slightly askew at the screen, low enough that the
// pattern doesn't get overly dense for short URLs.

package cn.bywave.calendar.desktop.ui.auth

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.awt.image.BufferedImage

fun qrBitmap(content: String, sizePx: Int = 320): ImageBitmap {
    val writer = QRCodeWriter()
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.MARGIN to 1,
        EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val matrix = writer.encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
    val img = BufferedImage(sizePx, sizePx, BufferedImage.TYPE_INT_RGB)
    for (y in 0 until sizePx) {
        for (x in 0 until sizePx) {
            img.setRGB(x, y, if (matrix.get(x, y)) 0x000000 else 0xFFFFFF)
        }
    }
    return img.toComposeImageBitmap()
}
