// EventSyncPlan — 增量同步（GET /events/sync）的本地应用计划。
// 纯逻辑，不碰网络与文件，测试在 EventSyncPlanTest。
//
// 语义与 Web 的 planDeltaApply、iOS 的 EventSyncLogic、Android 的
// EventSyncPlan 对齐：
//   · 变更主事件整组替换——本地旧行全删、响应行全收；主事件移出
//     窗口时响应里没有它的行，整组替换的结果就是删干净；
//   · deletedIds 直接删；
//   · 每次响应带的完整日历名单是可见性权威，名单之外的日历整批
//     剪掉（删日历 / 被取消共享时，服务端变更日志未必记得到
//     所有者，靠这一路兜底）。
//
// protectedIds 是离线队列里还没落定的主事件（新建 / 修改 / 删除，
// 含停在待处理里的）——它们的行一律不动：删了会把用户还没送出去
// 的改动冲掉，收了服务端的行又会把本地版本盖回去。与 Web 的
// _dirty 保护同语义；结果之后还会再过一遍 OfflineQueue.overlay
// （同一套保护的第二层，幂等）。
//
// localCreateIds（队列里的 CREATE 临时 id）单独排除：本地新建行
// 不是服务端镜像的一部分。桌面端的基线是窗口缓存文件里的服务端
// 原始快照，正常情况下根本没有这种行；留这一道是与各端口径对齐
// 的防御——万一基线混进本地行，也不会被当成服务端行留下来、
// 再被 overlay 接回一遍变成两行。
//
// 基线与令牌同住在一个窗口缓存文件里：文件被 TTL 淘汰 / 被写
// 操作整表清掉时，令牌随基线一起消失，下一次刷新自动回到初始
// 同步，不存在「有令牌没基线」的悬空状态。

package cn.bywave.calendar.desktop.data.sync

import cn.bywave.calendar.desktop.data.model.EventDTO

object EventSyncPlan {

    /**
     * 把一份增量响应套到这个窗口的服务端底稿上，返回新的底稿
     * （未过离线队列 overlay）。[previousLocal] 是窗口缓存文件里
     * 上一份原始快照的行——没被队列碰过的主事件，它的展示行与
     * 底稿行是同一批，整组替换等价。
     */
    fun applyDelta(
        previousLocal: List<EventDTO>,
        upsertedIds: Set<String>,
        deletedIds: Set<String>,
        incoming: List<EventDTO>,
        visibleCalendarIds: Set<String>,
        protectedIds: Set<String>,
        localCreateIds: Set<String>,
    ): List<EventDTO> {
        val touched = (upsertedIds + deletedIds) - protectedIds
        val base = previousLocal.filter { dto ->
            dto.id !in localCreateIds &&
                dto.id !in touched &&
                (dto.calendarId in visibleCalendarIds || dto.id in protectedIds)
        }
        return base + incoming.filter { it.id !in protectedIds }
    }
}
