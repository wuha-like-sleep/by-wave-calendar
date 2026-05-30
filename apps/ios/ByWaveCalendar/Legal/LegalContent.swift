// LegalContent.swift
// Privacy policy + Terms of Service bundled inside the APP.
//
// Why in-app fallback (when server doesn't have /privacy):
//   * The project is open-source — bundling specific operator URLs
//     in the binary would leak any one operator's host into every fork.
//   * Apple's App Store requires a privacy policy accessible BEFORE
//     login; if we only fetch from the server, App Review can't see it
//     until they configure a server in the APP. In-app text is always
//     available.
//
// Text is intentionally generic — refers to "your bound server" and
// "the server operator" rather than a specific domain. Self-hosters
// can update the SERVER-side /privacy + /terms pages to reflect their
// own operational specifics; the APP's bundled text covers what the
// APP itself does (cache events on disk, sync to EventKit, etc.) which
// is identical across every deployment.
//
// v1.3.3 — APNs push registration removed; APP currently does not
// subscribe to Apple Push. Privacy text reflects this.
//
// 2026-05-31 — text refresh + added a Data Processing policy
// (LegalContent.dataProcessing) to mirror the server's three-document
// set (privacy / data-processing / terms). Wording kept consistent
// with the web EJS pages and the Android in-app text.

import Foundation

enum LegalContent {
    /// One source of truth — bump on every meaningful change so the
    /// version line at the bottom of each page nudges users to re-read.
    static let lastUpdated = "2026-05-31"

    static let privacy: String = """
    # 隐私政策

    本应用（ByWave Calendar，以下简称"APP"）是一个开源的自托管日历客户端。\
    APP 本身不收集你的任何信息，也不会把你的数据发送给 APP 的开发者。\
    本文说明 APP 在你设备上的数据行为；你账户里的数据如何被处理，\
    请同时参阅你所绑定服务器的《隐私政策》《数据处理政策》《使用条款》\
    （多数服务器在网页 /privacy、/data-processing、/terms 提供）。

    ## 1. 数据流向

    APP 是一个纯客户端。所有的日历、事件、订阅、邀请数据都存储和处理在**你绑定的服务器**上 —— \
    通常是你或你的组织自行搭建的 ByWave Calendar 服务器。这台服务器的运营者是你的数据控制方。

    具体到 APP 本机层面，APP 会：

    - 把服务器的访问凭证（refresh token）保存在 iOS Keychain 里（加密、不上传到任何第三方）
    - 把最近一次拉取的日历事件缓存在 APP 的 Documents 目录下，方便离线查看
    - 如果你开启「同步到系统日历」，会把事件镜像到 iOS「日历」APP 的一个子日历里
    - 如果你开启「事件开始前提醒」，会在本机排好 iOS 本地通知队列
    - 通过定期后台轮询和应用前台刷新从你绑定的服务器拉取最新事件 \
      （当前发布版本未声明 Apple Push / APNs 能力，不会获取或上传推送 token；\
      后续若启用推送，会在升级说明里另行公告）

    APP 不会把以上任何数据发送给 ByWave Calendar 项目的开发者或任何其它第三方，\
    也不含任何广告、行为追踪或第三方分析 SDK。\
    iCloud Keychain 同步的项目（服务器地址、设备标识符）由 Apple 的端到端加密保护，开发者也无法访问。

    ## 2. APP 申请的权限

    - **相机**：仅用于扫描登录二维码；不录像、不保存照片
    - **日历**：仅当你开启「同步到系统日历」时申请；APP 不会读取你 iOS 日历里已有的事件，只写入
    - **通知**：仅当你开启「事件开始前提醒」时申请（本机定时本地通知，不走 Apple Push）

    所有权限都可以在 iOS 系统设置 → ByWave Calendar 里随时关闭。关闭后 APP 仍能正常使用，\
    只是相应功能（扫码登录 / 系统日历同步 / 提醒）不可用。

    ## 3. 数据存储位置

    - **服务器端**：事件、日历、订阅等业务数据存在你绑定的那台服务器上。\
      具体物理位置由该服务器的运营者决定 —— 你应该向**服务器管理员**询问具体的数据存储和处理政策。
    - **本机**：访问凭证（Keychain，加密）+ 事件缓存（Documents，明文 JSON）。\
      卸载 APP 时 iOS 会一并清除这些数据。

    ## 4. 你的权利

    因为 APP 不收集你的数据，所以本应用层面无权可主张。涉及到你账户里的数据（事件、个人信息），\
    请按 GDPR / 中国《个人信息保护法》或你所在地的相关法规，向**服务器管理员**主张：

    - 查看你的数据：在 APP 里就可以直接查看；服务器端也提供 CalDAV / API 导出
    - 修改你的数据：在 APP 或 web 端任意修改
    - 删除你的数据：APP「设置 → 账号 → 删除账户」会请求服务器永久清除你的账号 + 所有关联数据
    - 数据可携：服务器支持导出 .ics 文件 + 通过 CalDAV 对接其它客户端

    ## 5. 儿童隐私

    本应用没有针对 13 岁以下用户的设计；服务器是否接受未成年人注册由该服务器管理员决定。

    ## 6. 联系方式

    - APP / 软件层面的问题：邮件 info@by-wave.com，或到 \
      https://github.com/wuha-like-sleep/by-wave-calendar 提 issue
    - 账户 / 数据 / 服务器层面的问题：联系你绑定的那台服务器的管理员
    - 通用咨询 / 商务合作：info@by-wave.com（1-3 工作日回复）

    ---

    最近更新：\(lastUpdated)
    """

    static let dataProcessing: String = """
    # 数据处理政策

    本文是《隐私政策》的配套说明，从「处理什么、为什么、存多久、怎么保护、\
    与谁共享、是否跨境」的角度，描述与 ByWave Calendar APP 相关的数据处理。\
    APP 是一个纯客户端，**真正的数据控制者是你绑定的那台服务器的运营者**；\
    本软件作者既不运营服务器，也不接触你的数据。

    ## 1. 角色划分

    - **数据控制者**：你绑定的服务器的运营者 —— 决定为何、如何处理你账户里的数据
    - **软件作者**：仅提供开源软件（MIT），不运营服务、不接触你的数据
    - **APP 本机**：仅作客户端，不向作者或任何第三方回传你的数据

    ## 2. APP 在本机处理的数据

    - **访问凭证（refresh token）**：存于 iOS Keychain（加密），用于免重复登录
    - **事件缓存**：最近拉取的事件存于 APP Documents 目录，仅供离线查看
    - **多账号档案**：服务器地址 / 邮箱 / 显示名存于本机 Keychain；\
      可选地经 iCloud Keychain 端到端加密同步到你自己的其它 Apple 设备
    - **本地通知队列**：若开启「事件开始前提醒」，在本机排程 iOS 本地通知

    这些数据**不出你的设备 + 你绑定的服务器**这一范围。卸载 APP 时 iOS 会一并清除。

    ## 3. 服务器侧处理（由运营者负责）

    你的账号、日历、事件、邀请、设备配对信息、推送订阅 token、可选 SSO 身份、\
    审计日志等存储在**运营者的服务器**（通常是 PostgreSQL）上，不经第三方 SaaS。\
    具体的收集范围、目的、保存期限、安全措施、子处理者与跨境安排，\
    以**该服务器的《数据处理政策》**为准（多数服务器在网页 /data-processing 提供）。

    ## 4. 第三方（仅限运营者自行配置）

    服务器默认不依赖任何第三方。运营者可能自行配置：发邮件的 SMTP、\
    推送用的 APNs / FCM、登录用的 SSO 提供方。传输全程强制 HTTPS。\
    **不含任何分析、广告或追踪服务**；APP 也不内置任何此类 SDK。

    ## 5. 当前发布版本关于推送的说明

    当前发布的 iOS APP **未声明 Apple Push / APNs 能力**，不会获取或上传推送 token，\
    仅通过前台刷新与后台轮询同步事件。后续若启用推送，会在升级说明中另行公告，\
    届时设备的推送 token 会被服务器存储以便向你投递通知。

    ## 6. 你的权利与行使方式

    - **查看**：在 APP 内直接查看；服务器也支持 CalDAV / API 导出
    - **更正**：在 APP 或 web 端任意修改
    - **删除**：APP「设置 → 账号 → 删除账户」会请求服务器永久清除你的账号 + 全部关联数据
    - **可携**：导出 .ics 文件，或经 CalDAV 对接其它客户端
    - **撤回同意**：在 iOS 系统设置或 APP 内关闭相机 / 日历 / 通知等权限

    更具体的数据权利请按你所在地法规（如 GDPR、中国《个人信息保护法》），\
    向**服务器运营者**主张。

    ## 7. 跨境传输

    数据是否跨境，取决于运营者把服务器及其 SMTP / 推送 / SSO 基础设施部署在何处。\
    APP 本身不规定服务器位置；请向你绑定服务器的运营者咨询。

    ## 8. 联系方式

    - 账户 / 数据 / 服务器层面：联系你绑定服务器的运营者
    - APP / 软件层面：邮件 info@by-wave.com，或到 \
      https://github.com/wuha-like-sleep/by-wave-calendar 提 issue

    ---

    最近更新：\(lastUpdated)
    """

    static let terms: String = """
    # 使用条款

    欢迎使用 ByWave Calendar（以下简称"APP"）。本应用是一个开源的自托管日历客户端，\
    使用前请阅读以下条款。关于数据如何被处理，请同时参阅《隐私政策》与《数据处理政策》。

    ## 1. 服务说明

    APP 是一个纯客户端，本身不提供任何后端服务。你需要绑定一台 ByWave Calendar 服务器才能使用 —— \
    服务器可以是你自己搭建的，也可以是你的组织 / 朋友提供的。

    APP 本身**免费**，不含广告、不内购、不订阅，遵循 [开源许可证][1]。
    [1]: https://github.com/wuha-like-sleep/by-wave-calendar

    ## 2. 你与服务器之间的关系

    你绑定的服务器的可用性 / 数据保护责任 / 服务等级，由该服务器的运营者决定。\
    APP 的开发者**不为任何第三方服务器**的内容、可用性、安全性或法律合规性负责。\
    使用任何特定服务器前，请阅读该服务器的服务条款（如果有的话），或直接与其管理员沟通。

    ## 3. 你的责任

    使用 APP 时，你同意：

    - 遵守你所在地的法律法规
    - 遵守你绑定的服务器的使用规则
    - 不利用 APP 干扰服务器的正常运行（暴力扫描、扫描漏洞等）
    - 保管好你的登录凭证，不在不可信的设备上登录

    ## 4. 知识产权

    - 你在 APP 中创建的日历、事件等内容的版权归你所有
    - APP 的代码遵循其开源许可证（见仓库 LICENSE 文件）
    - 「ByWave Calendar」这个名字 + 商标属于项目原作者；fork 时不强制要求改名，\
      但若做了实质性修改后再发布，建议改用其它名称避免混淆

    ## 5. 可用性免责

    APP 按"现状"提供，不附带任何明示或暗示的担保。开发者尽力保证质量，但不保证：

    - 软件无 bug、无中断
    - 在所有 iOS 版本 / 设备组合上都能正常工作
    - 永久维护或永远兼容未来的 iOS 版本

    ## 6. 责任限制

    在适用法律允许的范围内，APP 开发者对任何因使用或无法使用 APP 而产生的间接、\
    偶然、特殊或后果性损失不承担责任。

    ## 7. 终止

    你可以随时通过卸载 APP 或调用「删除账户」终止使用。开发者不会主动停止你对本应用的使用。\
    服务器端的访问由服务器管理员决定，与 APP 无关。

    ## 8. 适用法律

    本条款采用项目原作者所在地的法律解释（除非另有约定）。\
    fork 项目的二次分发者可以根据自身需要调整本条款。

    ## 9. 条款变更

    APP 升级时本文本可能调整。重大变更会在下一次升级的发布说明中提及；继续使用即视为接受新版条款。

    ---

    最近更新：\(lastUpdated)
    """
}
