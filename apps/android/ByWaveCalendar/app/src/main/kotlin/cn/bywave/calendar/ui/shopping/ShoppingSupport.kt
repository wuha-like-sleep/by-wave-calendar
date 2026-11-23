// Shared plumbing for the shopping-list screens (the overview /
// detail screen and the event editor's shopping section): how to get
// the active profile's API, how to read the machine code out of a
// shopping-endpoint failure, and how quantities render.

package cn.bywave.calendar.ui.shopping

import android.content.Context
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.BywaveApi
import cn.bywave.calendar.data.api.serverErrorMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigDecimal

/** The active profile's API, or throw — same one-liner the settings
 *  screens use; the message is the shared not-signed-in string. */
internal fun shoppingApi(): BywaveApi {
    val profile = BywaveApp.instance.profiles.active()
        ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
    return ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
}

/** The machine code out of a shopping-endpoint failure. After the
 *  envelope interceptor, error bodies are `{ code, message }`; the
 *  flat legacy shape `{ error: "code" }` is accepted too. */
internal fun shoppingErrorCode(e: Throwable): String? {
    val http = e as? retrofit2.HttpException ?: return null
    val raw = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
    if (raw.isNullOrBlank()) return null
    val obj = runCatching {
        Json { ignoreUnknownKeys = true }.parseToJsonElement(raw).jsonObject
    }.getOrNull() ?: return null
    runCatching { obj["code"]?.jsonPrimitive?.content }.getOrNull()?.let { return it }
    return runCatching { obj["error"]?.jsonPrimitive?.content }.getOrNull()
}

/** Localized copy for the shopping-endpoint failures the user can act
 *  on; anything else falls back to the server message / [fallbackRes]. */
internal fun shoppingErrorText(context: Context, e: Throwable, fallbackRes: Int): String =
    when (shoppingErrorCode(e)) {
        "list_limit_reached" -> context.getString(R.string.shopping_error_list_limit)
        "item_limit_reached" -> context.getString(R.string.shopping_error_item_limit)
        "event_not_found" -> context.getString(R.string.shopping_error_event_not_found)
        else -> serverErrorMessage(e) ?: context.getString(fallbackRes)
    }

/** Quantity display without meaningless trailing zeros: 2.0 → "2",
 *  0.5 → "0.5", 2.25 → "2.25". Quantities arrive as JSON numbers
 *  backed by the server's numeric(12,3) column, so three decimals is
 *  the most that can ever show. */
internal fun formatShoppingQuantity(quantity: Double): String {
    if (quantity == quantity.toLong().toDouble()) return quantity.toLong().toString()
    return BigDecimal.valueOf(quantity).stripTrailingZeros().toPlainString()
}

/** Parse a quantity field: blank or unparseable → null (the field is
 *  optional everywhere it appears). Accepts a comma decimal separator
 *  because several of the APP's locales write 0,5. */
internal fun parseShoppingQuantity(text: String): Double? {
    val cleaned = text.trim().replace(',', '.')
    if (cleaned.isEmpty()) return null
    return cleaned.toDoubleOrNull()?.takeIf { it > 0 }
}
