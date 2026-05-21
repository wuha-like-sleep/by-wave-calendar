# by-wave-calendar

日历共享平台 —— 支持 ICS 订阅发布 / CalDAV 服务端 / CalDAV 客户端（拉取外部源）。

## Phase 状态

- [x] Phase 1：注册登录、日历/事件 CRUD、ICS 订阅发布
- [ ] Phase 2：订阅外部 ICS 源（Google 公开日历等）
- [ ] Phase 3：CalDAV 客户端（拉 Google / iCloud 到本地）
- [ ] Phase 4：CalDAV 服务端（让 Apple / Thunderbird 直接连）
- [ ] Phase 5：分享权限 / 邀请 / 重复事件 / 提醒

## 本地开发

前置：Node 22+、PostgreSQL 16+。

```bash
cp .env.example .env
npm install
npm run db:generate     # 生成迁移
npm run db:migrate      # 应用迁移
npm run create-admin    # 交互式创建管理员
npm run dev             # 起 dev server, http://127.0.0.1:3000
```

## 部署（宝塔面板）

见 `deploy/bt-panel/README.md`。一句话流程：
1. 本地 `npm run release` 出 tarball
2. 上传到服务器，解压
3. `bash install.sh` 自动装依赖、build、迁移、建管理员、PM2 启动
4. 宝塔 UI 里加反向代理到 `127.0.0.1:3000` 并申请 SSL

## 技术栈

- TypeScript + Fastify 5
- PostgreSQL 16 + Drizzle ORM
- ical-generator (ICS 输出)
- bcryptjs (密码) + 签名 cookie session
