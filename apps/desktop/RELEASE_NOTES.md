# 桌面端 1.3.2（版本代码 29）

- 预约链接管理标明发起方日历时区；日程详情显示设备与日程时区。更改电脑系统时区后，重启桌面 App 生效。
- 修复日期选择器在西半球偏移一天、全天日程显示及复制日期偏移。
- 清空描述、地点、会议链接、会议密码、重复规则及最后一位参与者后正确保存。
- 事件详情窗口持续接收刷新；删除成功后立即移除可见日程，防止重复提交，并保留尚未保存的编辑内容。
- 服务端修复批量删除重复实例时的冲突重试和同步排队，减轻双向同步删除延迟。

Mac Apple Silicon 和 Intel 安装包均在本机编译，使用既有 Developer ID 签名及 Apple 公证。Windows x64 安装包在本机 Windows 11 虚拟机编译，仍未签名；安装时会显示未验证发布者。

预约时区计算、重复事件事务与服务器同步修复需要服务端 1.9.2。本轮不发布新的 Linux 安装包。GitHub 编译 CI 保持停用，免费标准 Ubuntu 运行器仅转传已验证文件到 Gitee。

下载：[GitHub](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.3.2) · [Gitee](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.3.2)。
