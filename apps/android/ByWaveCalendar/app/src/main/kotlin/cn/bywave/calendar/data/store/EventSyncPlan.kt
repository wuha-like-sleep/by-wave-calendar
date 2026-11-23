// EventSyncPlan — 增量同步（GET /events/sync）的本地应用计划。
// 纯逻辑，不碰网络与 Room，测试在 EventSyncPlanTest。
//
// 语义与 Web 的 planDeltaApply、iOS 的 EventSyncLogic 对齐：
//   · 变更母事件整组替换——本地旧行全删、响应行全收；母事件移出
//     窗口时响应里没有它的行，整组替换的结果就是删干净；
//   · deletedIds 直接删；
//   · 每次响应带的完整日历名单是可见性权威，名单之外的日历整批
//     剪掉（删日历 / 被取消共享时，服务端变更日志未必记得到
//     所有者，靠这一路兜底）。
//
// protectedIds 是离线队列里还没落定的母事件（新建 / 修改 / 删除，
// 含停在待处理里的）——它们的行一律不动：删了会把用户还没送出去
// 的改动冲掉，收了服务端的行又会把本地版本盖回去。与 Web 的
// _dirty 保护同语义；结果之后还会再过一遍
// OfflineQueue.mergeServerEvents（同一套保护的第二层，幂等）。
//
// localCreateIds（队列里的 CREATE 临时 id）单独排除：本地新建行
// 不是服务端镜像的一部分，把它留在底稿里，mergeServerEvents
// 又会从 previousLocal 把它接回一遍，同一行出现两次。排除掉、
// 由合并阶段统一接回，与全量路径的行为一致。

package cn.bywave.calendar.data.store

import cn.bywave.calendar.data.model.EventDTO

object EventSyncPlan {

    /**
     * 把一份增量响应套到本地镜像上，返回新的服务端底稿（未过
     * 离线队列合并）。[previousLocal] 是上一份合并集——没被队列
     * 碰过的母事件，它的展示行与镜像行是同一批，整组替换等价。
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
