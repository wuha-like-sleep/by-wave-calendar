# 桌面端 1.4.0（版本代码 31）

- 新增购买清单：清单可以关联到某个日程，从工具栏打开清单窗口新建、勾选、改名、增删条目并调整顺序；日程编辑里也能直接新建或关联清单，买齐进度一目了然。
- 设置中新增 API Token 管理：在应用内自助创建、轮换和撤销 Token，不必再经过管理员。创建时验证账号密码，写权限 Token 还需要两步验证；密钥只在创建时显示一次，默认只读，撤销立即生效。
- 地址建议接入本地地址包：装好官方地址包后，地址联想在本机完成、断网也能用；同一地址有多个单元号时折叠为一条，副行列出全部单元号。本地地址簿可在应用内维护。
- 事件邀请改进：参与者页面与邀请状态展示更完整。
- 其余为稳定性与细节修复。

Mac Apple Silicon 和 Intel 安装包均在本机编译，使用既有 Developer ID 签名及 Apple 公证。Windows x64 安装包在本机 Windows 11 虚拟机编译，仍未签名；安装时会显示未验证发布者。本轮不发布新的 Linux 安装包，Linux 保持 1.2.0。

下载：[GitHub](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.4.0) · [Gitee](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.4.0)。
