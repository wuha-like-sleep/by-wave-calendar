// 列表骨架屏。
//
// 为什么需要它:日/日程两个视图以前是「events 为空就画『无事件』」,而第一次
// 加载时 events 本来就是空的 —— 于是打开 App 的头一两秒,界面斩钉截铁地
// 告诉用户「今天没有事件」,数据回来之后又突然冒出五条。用户读到的是一句
// 假话,不是「在加载」。
//
// 骨架只在「正在加载 且 一条都还没有」时出现。已经有缓存内容时不要盖骨架
// —— 那会把用户正在看的东西换成灰条,比不刷新还糟。
//
// 也顺带满足一条产品规矩:没数据时整块区域不许消失,得留下占位。

package cn.bywave.calendar.desktop.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp

/** 一条灰色占位条。宽度用 fraction 表达,让几条之间长短不一,看起来像
 *  一段真的文字而不是等长的进度条。 */
@Composable
private fun SkeletonBar(widthFraction: Float, heightDp: Int) {
    Box(
        modifier = Modifier
            .fillMaxWidth(widthFraction)
            .height(heightDp.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)),
    )
}

/** 一行事件的骨架:色点 + 标题条 + 时间条。尺寸对着真实的事件行来,
 *  数据到位时整块不会跳一下。 */
@Composable
fun EventRowSkeleton(titleFraction: Float = 0.55f) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(rowShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Dimens.cardFillAlpha))
            .padding(Dimens.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(Dimens.colorDot)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f)),
        )
        Spacer(Modifier.width(14.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            SkeletonBar(widthFraction = titleFraction, heightDp = 14)
            SkeletonBar(widthFraction = titleFraction * 0.45f, heightDp = 10)
        }
    }
}

/** 几条事件骨架堆在一起。fraction 不等长,免得看上去像一个表格。 */
@Composable
fun EventListSkeleton(rows: Int = 4, modifier: Modifier = Modifier) {
    val fractions = listOf(0.62f, 0.44f, 0.72f, 0.38f, 0.55f)
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(Dimens.rowGap),
    ) {
        repeat(rows) { i -> EventRowSkeleton(titleFraction = fractions[i % fractions.size]) }
    }
}
