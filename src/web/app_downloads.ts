// 三端 App 的「有没有新版本」接口 + 从本站发安装包。
//
// ── 为什么抽成插件 ────────────────────────────────────────────────────
//
// 这四条路由以前写在 src/server.ts 顶层,不属于任何 plugin —— 于是**集成
// 测试里注册不了它们**,至今一次都没被真正打过。已经踩到的后果:
// 「传到本地的包对 App 的自动更新毫无作用」这条 bug 活了很久,而门禁全绿,
// 因为断言全落在 /download 那个 HTML 页面上,而真正发文件的那条路由和
// 两条 latest 接口根本不在测试实例里。
//
// ── 发 100MB 级别的文件,和发一张图片不是一回事 ────────────────────────
//
// 1. **断点续传**。没有 Accept-Ranges,客户端根本不会尝试续传;109MB 的包
//    网断一次就得从 0 重来 —— 而「从本站发包」存在的全部理由就是给那些
//    从 GitHub 下不动的人一条路。不做 Range,这个功能对他们没有意义。
// 2. **HEAD**。Fastify 会给每个 GET 自动生成 HEAD,而它对流的处理是
//    payload.resume() —— 把 109MB 从磁盘读完再丢掉。客户端花几百字节,
//    服务器做一次全量磁盘读,出站流量 0。必须自己声明 HEAD 顶掉它。
// 3. **压缩**。今天这几种安装包不被压是 mime-db 凑巧(它们的 compressible
//    不为 true),不是设计。扩展名一旦放宽到 .zip / .exe,或者落到
//    application/octet-stream 兜底分支,就会命中 @fastify/compress 的默认
//    正则:白烧 CPU、删掉 Content-Length、还破坏 Range。
//    关法是路由的 `config: { compress: false }`(插件 index.js:54-55、:67)。
//    **不是**在响应上发 Content-Encoding: identity —— 那一行是空操作,
//    插件读的是**请求**的 content-encoding(index.js:339),那是解压用的。
//    第一版就写错成了后者,而守它的测试断言的正好是那个自己刚设的头。
// 4. **限流**。原来是 rateLimit: false(完全不挂钩子)。公开下载确实不该按
//    普通接口的额度算,但也不该彻底不设防 —— 给一个宽松的专用桶。

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** 一次要发的那个文件。 */
type Served = { path: string; size: number; contentType: string; filename: string };

/** 解析单段 Range。返回 null = 没带 Range(发整个文件);
 *  返回 "invalid" = 带了但不合法(要回 416)。
 *
 *  只支持单段。多段(bytes=0-99,200-299)要发 multipart/byteranges,
 *  而没有任何下载器对安装包用它 —— 按 RFC 7233,不支持时**忽略整个
 *  Range 头、发 200 全量**是允许的,比回 416 对用户友好。 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;            // 多段或语法怪异 → 当作没带
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";
  let start: number;
  let end: number;
  if (rawStart === "") {
    // bytes=-N → 最后 N 字节
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
    if (start > end) return "invalid";
    // start 超出文件尾 → 416。end 超出则钳到文件尾(RFC 允许)。
    if (start >= size) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** 发一个本地文件,带 Range / HEAD / 缓存头。headOnly 时只发头不发体。 */
async function sendBinary(
  req: FastifyRequest,
  reply: FastifyReply,
  s: Served,
  headOnly: boolean,
): Promise<FastifyReply> {
  const fs = await import("node:fs");

  // **Range 先解析、再设二进制的那几个头。** 反过来的话 416 那条路会
  // 带着 Content-Type: application/x-apple-diskimage 去 send 一个 JSON 对象,
  // Fastify 找不到那个类型的序列化器 → 500。实测踩过。
  const range = parseRange(req.headers.range as string | undefined, s.size);
  if (range === "invalid") {
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Range", `bytes */${s.size}`);
    return reply.code(416).send({ error: "range_not_satisfiable" });
  }

  reply.header("Content-Type", s.contentType);
  reply.header("Content-Disposition", `attachment; filename="${s.filename}"`);
  // 文件名里带版本号,所以同名即同内容 —— 可以往死里缓存。
  reply.header("Cache-Control", "public, max-age=2592000, immutable");
  // **无条件发**。不发这个头,客户端根本不会尝试续传,哪怕我们支持。
  reply.header("Accept-Ranges", "bytes");

  if (range) {
    const len = range.end - range.start + 1;
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${s.size}`);
    reply.header("Content-Length", String(len));
    reply.code(206);
    if (headOnly) return reply.send();
    return reply.send(fs.createReadStream(s.path, { start: range.start, end: range.end }));
  }

  reply.header("Content-Length", String(s.size));
  if (headOnly) return reply.send();
  return reply.send(fs.createReadStream(s.path));
}

/** 公开下载的专用桶。比普通接口宽得多(一个人连着点几次很正常),
 *  但不是「完全不设防」—— 原来写的是 rateLimit: false,那不是放宽,
 *  是根本不挂限流钩子。 */
const DOWNLOAD_RATE = { max: 30, timeWindow: "1 minute" } as const;

/** 灰度分桶要的两个查询参数。都可选：不给 deviceId = 分不了桶（按
 *  不在灰度对象里处理，见 rollout.ts）；currentVersionCode 只用来判
 *  召回豁免。解析口径宽松 —— 参数是客户端自愿上报的诊断信息，写错了
 *  就当没给，绝不能因为一个脏参数让检查更新整条挂掉。 */
function rolloutQuery(req: FastifyRequest): { deviceId: string | null; currentVersionCode: number | null } {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const rawId = typeof q.deviceId === "string" ? q.deviceId.trim() : "";
  const deviceId = rawId && rawId.length <= 128 ? rawId : null;
  const rawVc = typeof q.currentVersionCode === "string" ? Number(q.currentVersionCode) : NaN;
  const currentVersionCode = Number.isFinite(rawVc) && rawVc > 0 ? Math.floor(rawVc) : null;
  return { deviceId, currentVersionCode };
}

export async function appDownloadRoutes(app: FastifyInstance) {
  const android = await import("../lib/android_release.js");
  const desktop = await import("../lib/desktop_release.js");
  const rollout = await import("../lib/rollout.js");

  // ---- 安卓：有没有新版本 ----
  // App 回到前台时轮询(客户端 6 小时节流)。versionCode 比本地大就弹更新。
  app.get("/api/app/android/latest", { config: { rateLimit: false } }, async (req, reply) => {
    const rel = await android.getLatestRelease();
    if (!rel) return reply.code(404).send({ error: "no_release_published" });
    // 灰度门：没轮到的设备回 404，和「这台服务器还没发布」同一个形状 ——
    // 老客户端本来就把 404 当「这个源没有」去走下一条路（GitHub 清单），
    // 新客户端认 rollout_not_included 这个码、且会在本地对 GitHub 清单
    // 再分一次桶。分桶口径只此一份（rollout.ts）。
    const { deviceId, currentVersionCode } = rolloutQuery(req);
    if (!rollout.isInRollout({
      deviceId, platform: "android", versionCode: rel.versionCode,
      rolloutPercent: rel.rolloutPercent, currentVersionCode,
      minSupportedVersionCode: rel.minSupportedVersionCode,
    })) {
      return reply.code(404).send({ error: "rollout_not_included" });
    }
    // 「本站有这个包就本站优先」—— 口径收口在 resolveApkUrls,
    // /download 网页和这条接口共用同一份。
    // 走 req.protocol / req.hostname，不自己读转发头：那两个属性经过
    // trustProxy 的信任判定，自己读等于把「这个包从哪下载」交给调用方决定。
    const [url, fallbackUrl] = await android.resolveApkUrls(`${req.protocol}://${req.hostname}`, rel);
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      versionCode: rel.versionCode, versionName: rel.versionName, url,
      // 备选地址必须一起给到 App：/download 网页早就把两个地址都摆出来了
      // （主链接走本站时，备选是给「下不动本站」的人兜底），而 App 内更新
      // 以前只拿到主地址 —— 本站这条路一断（反代配置、磁盘、证书），
      // 已装机的用户就只能干等，尽管同一份包在 GitHub 上好好的。
      // 没有备选时是空串，客户端按「没给」处理。
      fallbackUrl,
      // 第三级下载源（Gitee 镜像）。主备都失败时客户端才试。没有就是
      // 空串，客户端按「没给」处理 —— 和 fallbackUrl 同一个约定。
      mirrorUrl: rel.mirrorUrl,
      sha256: rel.sha256, sizeBytes: rel.sizeBytes, releasedAt: rel.releasedAt,
      notes: rel.notes, mandatory: rel.mandatory,
      minSupportedVersionCode: rel.minSupportedVersionCode,
      // 灰度比例与强升宽限也一并下发：客户端在本地路径（GitHub 清单）
      // 分桶、算宽限倒计时都要用同一组数。老客户端忽略未知字段。
      rolloutPercent: rel.rolloutPercent,
      graceDays: rel.graceDays,
    });
  });

  // ---- 安卓：发 APK ----
  const apkHandler = (headOnly: boolean) =>
    async (req: FastifyRequest<{ Params: { filename: string } }>, reply: FastifyReply) => {
      const filename = req.params.filename;
      // 判据和上传共用一份(android_release.ts 导出) —— 各写一份必然漂移,
      // 而漂移的表现是「上传成功、页面有按钮、点下去 400」。
      if (!android.isServableApkName(filename)) {
        return reply.code(400).send({ error: "invalid_filename" });
      }
      const full = android.apkPathFor(filename);
      if (!full) return reply.code(400).send({ error: "invalid_filename" });
      const fsp = await import("node:fs/promises");
      const st = await fsp.stat(full).catch(() => null);
      // size > 0：和 /download 页面的判据对齐。0 字节是上传半途留下的壳。
      if (!st || !st.isFile() || st.size === 0) {
        return reply.code(404).send({ error: "apk_not_found" });
      }
      return sendBinary(req, reply, {
        path: full, size: st.size, filename,
        contentType: "application/vnd.android.package-archive",
      }, headOnly);
    };
  // exposeHeadRoute: false —— 必须写。Fastify 默认在注册 GET 的**同时**
  // 自动生成 HEAD,而那个自动版对流的处理是 payload.resume():把整个文件从
  // 磁盘读完再丢掉,出站 0 字节。不关掉它,下面那行 app.head 会直接抛
  // 「Method 'HEAD' already declared」—— **服务起不来**。
  // (这条是被集成测试当场抓住的:全量单元测试里没有任何一处真的启动服务。)
  app.get<{ Params: { filename: string } }>("/downloads/android/:filename",
    { exposeHeadRoute: false, config: { rateLimit: DOWNLOAD_RATE, compress: false } }, apkHandler(false));
  app.head<{ Params: { filename: string } }>("/downloads/android/:filename",
    { config: { rateLimit: DOWNLOAD_RATE, compress: false } }, apkHandler(true));

  // ---- 桌面：有没有新版本 ----
  app.get("/api/app/desktop/latest", { config: { rateLimit: false } }, async (req, reply) => {
    const rel = await desktop.getLatestRelease();
    if (!rel) return reply.code(404).send({ error: "no_release_published" });
    // 灰度门，口径与安卓那条完全一致（rollout.ts 一份实现），只是桶以
    // 「桌面」为平台键 —— 一台机器一个桶，不按四个资产各分一次。
    const { deviceId, currentVersionCode } = rolloutQuery(req);
    if (!rollout.isInRollout({
      deviceId, platform: "desktop", versionCode: rel.versionCode,
      rolloutPercent: rel.rolloutPercent, currentVersionCode,
      minSupportedVersionCode: rel.minSupportedVersionCode,
    })) {
      return reply.code(404).send({ error: "rollout_not_included" });
    }
    const origin = `${req.protocol}://${req.hostname}`;
    const assets: Record<string, { url: string; fallbackUrl: string; mirrorUrl: string; sha256: string; sizeBytes: number }> = {};
    for (const [platform, a] of Object.entries(rel.assets)) {
      if (!a) continue;
      // 备选地址的理由同安卓那条：只给主地址，本站一断就没有第二条路。
      const [url, fallbackUrl] = await desktop.resolveAssetUrls(origin, a);
      assets[platform] = { url, fallbackUrl, mirrorUrl: a.mirrorUrl, sha256: a.sha256, sizeBytes: a.sizeBytes };
    }
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      versionCode: rel.versionCode, versionName: rel.versionName,
      releasedAt: rel.releasedAt, notes: rel.notes, mandatory: rel.mandatory,
      minSupportedVersionCode: rel.minSupportedVersionCode,
      rolloutPercent: rel.rolloutPercent, graceDays: rel.graceDays, assets,
    });
  });

  // ---- iOS：应用内公告 ----
  // iOS 没有自更新通道，「商店里有新版」只能由服务端喊这一嗓子。
  // 公告存 site_settings（管理员在 /admin/client-release 维护），
  // 这里只读：没开 / 没填版本 / 标题正文全空 → 404，和上面两条 latest
  // 的「没有可给的东西」同一个形状。判空口径在 ios_announcement.ts。
  app.get("/api/app/ios/announcement", { config: { rateLimit: false } }, async (_req, reply) => {
    const { getSettings } = await import("../lib/site_settings.js");
    const { announcementFromSettings } = await import("../lib/ios_announcement.js");
    const announcement = announcementFromSettings(await getSettings());
    if (!announcement) return reply.code(404).send({ error: "no_announcement" });
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(announcement);
  });

  // ---- 桌面：发 DMG / MSI / DEB ----
  const desktopHandler = (headOnly: boolean) =>
    async (req: FastifyRequest<{ Params: { filename: string } }>, reply: FastifyReply) => {
      const filename = req.params.filename;
      if (!desktop.isServableBinaryName(filename)) {
        return reply.code(400).send({ error: "invalid_filename" });
      }
      const full = desktop.binaryPathFor(filename);
      if (!full) return reply.code(400).send({ error: "invalid_filename" });
      const fsp = await import("node:fs/promises");
      const st = await fsp.stat(full).catch(() => null);
      if (!st || !st.isFile() || st.size === 0) {
        return reply.code(404).send({ error: "binary_not_found" });
      }
      return sendBinary(req, reply, {
        path: full, size: st.size, filename,
        contentType: desktop.contentTypeForBinary(filename),
      }, headOnly);
    };
  // exposeHeadRoute: false —— 理由同安卓那两行。
  app.get<{ Params: { filename: string } }>("/downloads/desktop/:filename",
    { exposeHeadRoute: false, config: { rateLimit: DOWNLOAD_RATE, compress: false } }, desktopHandler(false));
  app.head<{ Params: { filename: string } }>("/downloads/desktop/:filename",
    { config: { rateLimit: DOWNLOAD_RATE, compress: false } }, desktopHandler(true));
}
