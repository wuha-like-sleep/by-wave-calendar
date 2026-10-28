// 「某个账号被服务端登出了」—— 日历页顶上的提示条。
//
// 改密码 / 重置密码 / 后台移除设备 / 后台停用都会让服务端吊销这台设备上的那个账号。
// 本机还登着别的账号时，App 会切到最近用过的那个继续用；这条提示负责把这件事说出来：
// 哪个账号被登出了、为什么、现在看的是谁的日历。以前是静默切走 —— 顶栏头像只显示
// 一个首字母，用户以为自己还在原来那个账号里。

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.auth.SignedOutNotice

@Composable
internal fun SignedOutBanner(
    notice: SignedOutNotice,
    /** 现在显示的是哪个账号的日历（邮箱）。 */
    currentEmail: String?,
    onSignInAgain: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            // 读屏用户也要第一时间听到，而不是自己摸到这一块才知道。
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, top = 12.dp, end = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                modifier = Modifier.padding(top = 2.dp, end = 12.dp),
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = stringResource(R.string.cal_signed_out_title, notice.email),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stringResource(R.string.cal_signed_out_reason),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (currentEmail != null) {
                    Text(
                        text = stringResource(R.string.cal_signed_out_now_showing, currentEmail),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                TextButton(
                    onClick = onSignInAgain,
                    modifier = Modifier.padding(top = 2.dp),
                    // 默认的主题色落在错误色底上对比度不够，跟着正文颜色走。
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                ) {
                    Text(
                        text = stringResource(R.string.cal_signed_out_sign_in_again),
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            IconButton(onClick = onDismiss) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = stringResource(R.string.action_close),
                )
            }
        }
    }
}
