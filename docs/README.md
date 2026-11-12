# 文档导航

| 内容 | 入口 |
|---|---|
| 项目介绍与部署概览 | [简体中文](../README.md)、[English](../README.en.md)、[繁體中文](../README.zh-TW.md) |
| 本地开发与检查命令 | [贡献指南](../CONTRIBUTING.md) |
| 数据库迁移约定 | [迁移指南](../drizzle/README.md) |
| 宝塔部署 | [安装说明](../deploy/bt-panel/README.md) |
| 安全策略与报告方式 | [SECURITY.md](../SECURITY.md) |
| 桌面端开发与分发 | [Desktop README](../apps/desktop/README.md) |
| Passkey 设计 | [架构说明](design/passkey-architecture.md) |
| 历史发布说明 | [发布记录](releases/README.md) |

服务端、网页和各客户端源码仍保留原有目录。`src/public/lib/`、
`src/public/_built/`、`dist/` 是构建产物，不提交；历史版本说明归档到
`docs/releases/`，新版本说明也放在该目录。

完整本地检查：`npm run check`。生产构建：`npm run build`。
依赖审计：`npm run audit:prod`（需要联网）。
