# Passkey 架构调研（#82 / #67 前置）

> 状态：调研 / 决策文档。不含实现。
> 范围：把 Passkey 从「可选第二登录方式」推进到「一等公民」该怎么做、代价多大、推荐路线。

## 0. TL;DR

- 现状：Passkey **已经能用**，但只是「先用密码注册 → 之后在设置里加一把 Passkey → 登录页可选用 Passkey」。账号的**根**仍然是密码（`users.password_hash NOT NULL`）。
- 想要的：注册即用 Passkey、无密码账号、Passkey 丢失能恢复。
- 推荐：**分三步走**，先做「设密码可选 + Passkey 为主」（中等改动），再视需求做「纯无密码注册」（大改动，牵动恢复流程）。不建议一步到位。
- 不动数据库主键、不动 WebAuthn 验证逻辑（都已就绪），主要工作量在**账号生命周期**（注册 / 恢复 / 降级路径）和 **UX 动线**。

---

## 1. 现状梳理

### 1.1 已经有的（能用）

| 能力 | 位置 | 说明 |
|---|---|---|
| 注册 Passkey | `POST /webauthn/register/options` + `/verify` | 需已登录 cookie session |
| 删除 Passkey | `POST /webauthn/credentials/:id/delete` | 设置 → 安全 |
| Passkey 登录 | `POST /webauthn/auth/options` + `/verify` | 无需 session；验证通过直接建 session |
| 多把 Passkey | `webauthn_credentials` 表，1 user → N cred | 每把有 deviceName / counter / lastUsedAt |
| 登录页入口 | `/login` 「使用 Passkey 登录」按钮 | 跟密码 / 扫码并列 |
| 防回放 | `counter` 单调递增校验 | `verifyAuthentication` |
| 停用账号联动 | `auth/verify` 里先查 `userIsActive` | 停用用户的 Passkey 立即失效 |
| 「记住我」 | `auth/verify` 读 `remember` flag | 跟密码登录同契约 |
| 登录历史 / 异地提醒 | `recordLoginEvent("passkey")` + `notifyLoginSuccess` | 已接 |

**结论**：WebAuthn 协议层（challenge / attestation / assertion / counter）**完全就绪，不需要重写**。Passkey 登录 = 双因子满足（something-you-have + 生物/PIN 验证），代码里已经 `createSession(..., { mfaSatisfied: true })`。

### 1.2 缺的（阻碍「Passkey 为主」）

1. **账号根仍是密码**：`users.password_hash` 是 `NOT NULL`。没有密码就建不了账号。SSO 账号目前是塞一个随机不可用密码绕过。
2. **注册流程强制先有密码**：`/register` 表单要求密码字段；没有「用 Passkey 注册」入口。
3. **没有 Passkey 恢复路径**：Passkey 丢了（换手机、清数据）只能靠「忘记密码」邮件重置回密码登录。如果账号本来就无密码，这条路断了。
4. **没有「至少留一把」保护**：删最后一把 Passkey 的无密码账号 = 永久锁死。当前因为有密码兜底所以没这个问题，转无密码后必须加守卫。

---

## 2. 三个架构选项

### 选项 A：保持现状（Passkey 为可选增强）
- 改动：0
- 体验：用户必须先有密码，Passkey 只是「更快的第二条路」
- 适合：如果只是想让有技术意识的用户少打密码，现状已经够了
- ❌ 不满足「注册即 Passkey / 无密码账号」

### 选项 B：Passkey 为主，密码降级为可选恢复手段（**推荐第一步**）
- 账号仍**可以**有密码，但密码退到「备用恢复方式」的地位
- 注册流程二选一：① 邮箱 + Passkey（推荐）② 邮箱 + 密码（传统）
- Schema 改动：`password_hash` 从 `NOT NULL` 改 `NULLABLE`
- 守卫：无密码账号删最后一把 Passkey 前，强制「先设密码或先加新 Passkey」
- 恢复：无密码账号走「邮箱验证码 → 临时登录 → 加新 Passkey」，复用现有 email 验证基建
- 工作量：**中**。主要在注册 UX + 账号生命周期守卫，验证逻辑不动。

### 选项 C：纯无密码（密码完全移除）
- 账号根 = 邮箱 + Passkey，没有密码概念
- 恢复**完全**依赖：多把 Passkey 互为备份 + 邮箱魔法链接（magic link）兜底
- Schema：删 `password_hash`、`password_resets`、整套密码策略代码
- ❌ 风险高：邮箱被攻破 = 账号被攻破（魔法链接是唯一兜底）；老用户迁移要全员加 Passkey；MFA 概念需要重新定义（Passkey 本身已是双因子，TOTP 变冗余）
- 工作量：**大**，且不可逆。不建议现在做。

---

## 3. 推荐路线：B 优先，分阶段

### Phase 1 — `password_hash` 可空 + 「至少一种登录方式」不变量
```
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
```
- 引入不变量：**每个 active 账号必须至少有 (密码) 或 (≥1 把 Passkey) 之一**
- 守卫点（都要加 active-credential 检查）：
  - 删最后一把 Passkey（设置 → 安全）
  - 关闭密码（如果做「移除密码」功能）
  - 删账号不受影响（本来就是整体删）
- SSO 账号顺势清理：不再塞假密码，`password_hash = NULL` + 标记 SSO-only

### Phase 2 — 「用 Passkey 注册」入口
- `/register` 加一个 tab：邮箱 → 发验证码 → 验证后**当场**走 `register/options`+`verify` 建第一把 Passkey → `password_hash` 留空
- 关键顺序：**先验邮箱再建 Passkey**（否则拿不到稳定的 user handle）
- 复用现有 `email_verifications` 表 + 验证码邮件

### Phase 3 — 无密码账号的恢复动线
- 「登录不了？」→ 邮箱收一次性验证码 → 临时 session（标记 `recovery`，权限受限）→ 强制「加一把新 Passkey」才能解除限制
- 这是 B 方案安全性的核心：恢复必须落到「重新拥有一把 Passkey」，不能停在「邮箱登进来就行」

### Phase 4（可选）— iOS / Android 原生 Passkey（对应 #67）
- iOS：`ASAuthorizationPlatformPublicKeyCredentialProvider`（iOS 16+），关联 `apple-app-site-association` 的 webcredentials
- Android：Credential Manager + Digital Asset Links
- 服务端 RP（relying party）逻辑**复用现有 web 那套**，只是多两个原生客户端发起 assertion
- 注意：原生 Passkey 跟「Sign in with Apple」（#67 标题里的 SIWA）是**两件事** —— SIWA 是 Apple 当 IdP（OAuth），Passkey 是我们自己当 RP。建议优先做 Passkey（统一栈），SIWA 作为额外 SSO provider 单独评估。

---

## 4. 数据库改动清单（Phase 1-3）

| 改动 | 影响 |
|---|---|
| `users.password_hash` → NULLABLE | 迁移脚本；所有读 `password_hash` 的地方加 null 检查 |
| （无新表）`webauthn_credentials` 已够用 | — |
| `email_verifications` 复用于 Passkey 注册 + 恢复 | 可能加一个 `purpose` 列区分 register/recovery/login |
| 可选：`users.passwordless` 派生标记 | 也可以用 `password_hash IS NULL` 直接判，省一列 |

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 删最后一把 Passkey 锁死账号 | Phase 1 不变量守卫 + UI 拦截 |
| 邮箱被攻破 → 恢复被滥用 | 恢复 session 权限受限，必须落到「加新 Passkey」；恢复操作发安全提醒邮件 |
| 老用户没 Passkey | 不强制迁移；密码继续可用，引导而非逼迫 |
| 跨设备 Passkey 同步差异 | iCloud Keychain / Google Password Manager 已处理大部分；提示用户「至少留 2 把（手机 + 笔记本）」 |
| MFA 与 Passkey 语义重叠 | Passkey 登录已记 `mfaSatisfied: true`；无密码账号不需要再叠 TOTP，UI 上说明 |

## 6. 工作量估计（粗）

| 阶段 | 估时 | 可独立上线 |
|---|---|---|
| Phase 1（schema + 不变量） | 1-2 天 | ✅ |
| Phase 2（Passkey 注册） | 2-3 天 | ✅ |
| Phase 3（恢复动线） | 2-3 天 | ✅（依赖 P1） |
| Phase 4（原生 iOS/Android） | 各 3-5 天 | ✅（依赖现有 RP） |

## 7. 建议

1. **先做 Phase 1**：低风险、解锁后续一切，单独就有价值（SSO 账号不再塞假密码）。
2. Phase 2/3 一起上，构成完整的「无密码可注册可恢复」闭环。
3. 选项 C（纯移除密码）**暂不做** —— 不可逆、收益不明确、把恢复全压在邮箱上反而降低安全性。
4. #67 的 SIWA 和原生 Passkey 分开评估：原生 Passkey 复用本栈、优先级更高；SIWA 是额外 IdP、按需。

---

*维护：随实现推进更新各 Phase 状态。当前全部为「未开始」。*
