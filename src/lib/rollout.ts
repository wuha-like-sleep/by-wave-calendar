// 灰度发布（staged rollout）的分桶口径 —— 服务端与客户端共用同一份定义。
//
// ── 业界做法与本仓的取舍 ────────────────────────────────────────────────
//
// Google Play 的 staged rollout、LaunchDarkly 的 percentage rollout、
// App Store 的 phased release 是同一套骨架：拿一个**稳定标识**（设备 /
// 账号）做确定性哈希，映射到 0–100 的桶，桶号小于放量比例就进灰度。
// 三个性质缺一不可：
//
// 1. **确定性**：同一台设备对同一个版本，问一百次答案都一样。随机抽样
//    会让用户在「有更新 / 没更新」之间横跳，支持侧也没法复现。
// 2. **单调扩张**：比例从 10 提到 25，已经在灰度里的设备必须还在里面，
//    只有新增的进来。用「桶号 < 比例」天然满足；用「哈希取模 == 某个值」
//    就不满足。
// 3. **按版本分桶**：桶的输入里带上目标 versionCode。否则一台「永远在
//    前 10%」的设备每个版本都第一个吃到，灰度样本永远偏向同一批人。
//
// ── 本仓的落地形状 ──────────────────────────────────────────────────────
//
// - 标识：客户端本来就有的稳定设备 ID（安卓 ClientDeviceId 的每安装
//   UUID、桌面端 profile 的服务端 deviceId）。不引入新标识、不上传任何
//   硬件指纹。
// - 服务端在 /api/app/*/latest 上按 `deviceId` 查询参数分桶：没进灰度
//   就回 404 `rollout_not_included` —— 对老客户端而言这和「这台服务器
//   还没发布」一模一样，它们会照常去走 GitHub 清单那条路。
// - GitHub 清单那条路服务端管不着，所以新客户端在本地用**同一个函数**
//   再判一次（apps/shared 的 Rollout.kt，测试向量和这里钉死成同一组）。
//   老客户端不认 rolloutPercent 字段，会直接全量更新 —— 灰度拦不住
//   没装这套逻辑的版本，这是任何客户端侧灰度的固有限制，不是 bug。
// - **召回豁免**：当前版本低于清单的 minSupportedVersionCode 时永远
//   放行，不进分桶。那条线的意思是「你正在跑的版本有严重问题」，把
//   这批人按比例留在坏版本上是把灰度用反了。服务端靠客户端上报的
//   `currentVersionCode` 参数判，客户端在本地路径上同一口径。

import { createHash } from "node:crypto";

export type RolloutPlatform = "android" | "desktop";

/** 归一化清单里的灰度比例：缺失 / 非法一律 100（= 不灰度，全量）。
 *  回落方向必须是「全量」：一份手写错了的清单最多让灰度失效，
 *  不能让全体用户失去更新通道。 */
export function normalizeRolloutPercent(raw: unknown): number {
  const n = Number(raw ?? 100);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, Math.floor(n)));
}

/** 归一化强升宽限天数：缺失 / 非法回落 7。
 *  7 的依据：App Store phased release 的完整放量周期就是 7 天，
 *  「一周内只提醒、过后强升」和商店渠道的节奏对齐，用户在两个渠道
 *  里的体感一致。0 = 发现即强升（留给真出大事的召回）。上限 30：
 *  再长就不是宽限，是放任坏版本继续跑。 */
export function normalizeGraceDays(raw: unknown): number {
  const n = Number(raw ?? 7);
  if (!Number.isFinite(n)) return 7;
  return Math.min(30, Math.max(0, Math.floor(n)));
}

/**
 * 这台设备对这个版本的桶号（0–99）。**算法是跨端协议的一部分**：
 * 输入串格式 `bywave-rollout:<platform>:<versionCode>:<deviceId>`，
 * sha256 后取前 4 字节大端无符号整数，对 100 取模。Kotlin 侧
 * （apps/shared/.../Rollout.kt）必须逐字节一致，两边测试里钉了
 * 同一组测试向量 —— 改任何一侧的格式，另一侧的向量测试会红。
 */
export function rolloutBucket(deviceId: string, platform: RolloutPlatform, versionCode: number): number {
  const digest = createHash("sha256")
    .update(`bywave-rollout:${platform}:${versionCode}:${deviceId}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % 100;
}

export interface RolloutDecisionInput {
  /** 客户端上报的稳定设备 ID。缺失 = 分不了桶。 */
  deviceId?: string | null;
  platform: RolloutPlatform;
  /** 清单里最新发布的 versionCode（分桶对象）。 */
  versionCode: number;
  /** 清单里的灰度比例（先过 normalizeRolloutPercent）。 */
  rolloutPercent: number;
  /** 客户端上报的当前 versionCode。低于 minSupported 时走召回豁免。 */
  currentVersionCode?: number | null;
  /** 清单里的最低支持版本。 */
  minSupportedVersionCode: number;
}

/**
 * 这台设备现在能不能看到这个新版本。
 *
 * - 比例 ≥ 100：全量，永远能。
 * - 没给 deviceId：能。分不了桶就不能装作分了 —— 这条接口同时被
 *   后台自检和下载页口径复用，无标识的调用方按「不是灰度对象」处理。
 * - 召回豁免：currentVersionCode < minSupportedVersionCode → 能。
 * - 其余：桶号 < 比例 → 能。
 */
export function isInRollout(input: RolloutDecisionInput): boolean {
  const percent = normalizeRolloutPercent(input.rolloutPercent);
  if (percent >= 100) return true;
  const deviceId = (input.deviceId ?? "").trim();
  if (!deviceId) return true;
  if (
    typeof input.currentVersionCode === "number" && Number.isFinite(input.currentVersionCode) &&
    input.currentVersionCode < input.minSupportedVersionCode
  ) {
    return true;
  }
  if (percent <= 0) return false;
  return rolloutBucket(deviceId, input.platform, input.versionCode) < percent;
}
