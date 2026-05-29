# 宝塔面板部署指南（无反代 / Node 直接监听 443）

适用于 **rl.lz-ss.com** 子域名独占部署。Node 进程直接监听 80/443，**不走 nginx 反代**。宝塔只负责申请/续 SSL 证书。

---

## 一、宝塔后台准备

### 1. 装运行时（软件商店）
- **Node.js 版本管理器** + Node 22 LTS
- **PostgreSQL 16**
- **PM2 管理器**（也可以全局 `npm i -g pm2`）

### 2. 建数据库
PostgreSQL → 数据库 → 添加：
- 库名 `rl_lz_ss_com`
- 用户 `rl_lz_ss_com`
- 密码：自己生成强密码

### 3. 建站点（仅为了让宝塔申请证书）
- 网站 → 添加站点 → 域名 `rl.lz-ss.com`
- 根目录：`/www/wwwroot/rl.lz-ss.com`（这个目录我们会用来放代码 + ACME 挑战）
- PHP 版本：纯静态（无 PHP）
- 创建后到 SSL 标签 → 申请 Let's Encrypt（**记下证书路径**，通常是 `/www/server/panel/vhost/cert/rl.lz-ss.com/`）

### 4. **关键：让 nginx 让出 80/443 端口**
默认 BT 站点会让 nginx 监听 80/443，跟我们 Node 应用冲突。两种做法：

**方案 A（推荐）：直接停掉这个站点的 nginx，但保留它在面板里**
- 网站 → rl.lz-ss.com → 设置 → 站点 → 停用（仅停用 nginx 代理，不删除站点和证书）
- 续证用 DNS-01 模式（SSL 标签下切换）；如果用不了 DNS-01，看下面方案 B

**方案 B：保留 nginx 站点，但通过我们 Node 的 ACME 透传完成续证**
- 我们的 Node 应用在 80 端口已经做了 ACME http-01 challenge 透传 —— 它会读 `${ACME_WEBROOT}/.well-known/acme-challenge/<token>`
- 宝塔续证用 webroot 模式，目标目录设为 `/www/wwwroot/rl.lz-ss.com`
- 但要先把 nginx 站点的 80/443 监听**完全关掉**，让 Node 接管

---

## 二、上传 release 包

### 1. 本地打包
```bash
cd ~/Desktop/by-wave-calendar
npm run release
```
产物：`release/by-wave-calendar-v0.1.0.tar.gz`

### 2. 上传 & 解压
宝塔 → 文件 → `/www/wwwroot/rl.lz-ss.com`：
- 拖入 tar.gz
- 右键解压（解压到当前目录）
- 把解压出来的 `by-wave-calendar-v0.1.0/` 里的所有文件移到 `rl.lz-ss.com` 根目录

---

## 三、一键安装

SSH 或宝塔自带终端，**以 root 跑**（要 setcap）：

```bash
cd /www/wwwroot/rl.lz-ss.com
bash deploy/bt-panel/install.sh
```

**第一次运行**会创建 `.env` 然后退出，让你编辑：

```bash
vi .env
```

需要改的关键变量：

```
DATABASE_URL=postgres://rl_lz_ss_com:<密码>@127.0.0.1:5432/rl_lz_ss_com
PUBLIC_BASE_URL=https://rl.lz-ss.com
USE_HTTPS=true
HTTPS_CERT_PATH=/www/server/panel/vhost/cert/rl.lz-ss.com/fullchain.pem
HTTPS_KEY_PATH=/www/server/panel/vhost/cert/rl.lz-ss.com/privkey.pem
ACME_WEBROOT=/www/wwwroot/rl.lz-ss.com
```

**再次执行**：
```bash
bash deploy/bt-panel/install.sh
```

脚本会自动：
1. `npm ci --omit=dev`
2. 数据库迁移
3. `setcap 'cap_net_bind_service=+ep'` 让 Node 能绑 80/443
4. 交互式提示创建管理员账号（或读 `ADMIN_EMAIL` / `ADMIN_PASSWORD`）
5. PM2 启动

---

## 四、证书热重载（无需重启）

我们的 TLS 模块 `fs.watch` 监听证书目录，宝塔续证后**自动 reload TLS 上下文**，PM2 进程无需重启。

查看是否生效：
```bash
pm2 logs by-wave-calendar | grep "certificate reloaded"
```

如果热重载有问题，手动重启：
```bash
pm2 reload by-wave-calendar
```

---

## 五、日常维护

| 操作 | 命令 |
|---|---|
| 查日志 | `pm2 logs by-wave-calendar` |
| 重启 | `pm2 reload by-wave-calendar` |
| 状态 | `pm2 status` |
| 升级 | 上传新 tarball 覆盖解压，再 `bash deploy/bt-panel/install.sh` |
| 跳过依赖装 | `SKIP_DEPS=1 bash deploy/bt-panel/install.sh` |
| 跳过 admin | `SKIP_ADMIN=1 bash deploy/bt-panel/install.sh` |
| 强制重置管理员密码 | `node dist/scripts/create-admin.js` |
| 验证证书读取 | `openssl x509 -in /www/server/panel/vhost/cert/rl.lz-ss.com/fullchain.pem -noout -dates` |

---

## 六、ipv6 / 防火墙

- 宝塔 → 安全 → 放行 80, 443 端口（同时 ipv4 和 ipv6 如果有用）
- 宝塔防火墙插件（用户已启用）会做边缘 IP 限频和 CC 防护
- 我们应用层还有 `@fastify/rate-limit`（120/min 全局、10/min 登录）

---

## 七、自动化场景（CI 部署）

```bash
ADMIN_EMAIL=admin@rl.lz-ss.com \
ADMIN_PASSWORD='your-strong-password' \
SKIP_SETCAP=1 \
bash deploy/bt-panel/install.sh
```

---

## 八、备份恢复链路验证（数据保险）

后台「数据备份 / 恢复」功能很重要 —— 但是不验证你不知道它真的能用。
搬服务器之前，先在一个空 PG 库里跑一次自动 round-trip：

```bash
# 1. 起一个本地一次性数据库
createdb bywave_test_restore

# 2. 灌当前代码的 schema 进去
DATABASE_URL=postgresql://localhost:5432/bywave_test_restore \
  npm run db:migrate

# 3. 跑 export → import 全链路自检
DATABASE_URL=postgresql://localhost:5432/bywave_test_restore \
  npx tsx scripts/verify-backup-restore.ts

# 期望看到结尾：
#   ✅ 29/29 checks passed
#   Backup round-trip OK — exportData() and importData() are mutually inverse for every table in EXPORT_TABLES.

# 4. 收拾
dropdb bywave_test_restore
```

脚本会：seed 15 张业务表 → 调 `exportData()` → 全表 TRUNCATE → 调
`importData(bundle)` → 重新读出来比对行数、Date 字段反序列化、外键完整。

🛡️ **脚本不会跑非 `*test*` 数据库**（看到非 test 关键字 URL 直接拒绝），
所以不会误清生产库。但保险起见，永远只针对一次性创建的库跑。
