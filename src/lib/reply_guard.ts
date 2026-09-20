// Guards against the double-writeHead crash.
//
// 背景：Fastify 的 fallbackErrorHandler 里写着
//
//     try   { raw.writeHead(status, headers) }
//     catch { log(); raw.writeHead(status) }   // ← 这个重试没有包 try/catch
//
// 只要响应已经发出、之后又有异常走到错误处理链，重试就会抛
// ERR_HTTP_HEADERS_SENT，从一条没人接的 promise 链里逃出去 → 未捕获异常 →
// 进程退出。一个未认证的请求就够了，不需要任何凭据。
//
// 历史与现状（2026-09 复核，逐条实测）：
//
// 1. 原始触发器是 lib/session.ts 的「先 reply.send()、再 throw」写法。
//    那个已经根除——requireUserOrSend() 现在发完响应就 return null，
//    调用方 `if (!user) return reply;`。实测：改之前每个未认证请求触发一次
//    下面的 isBenignDoubleWrite；改之后 100+ 请求零次。
//    test/no_send_then_throw.test.ts 防止这个写法被写回来。
//
// 2. replyAlreadySent() 当初是加在 server.ts 的 setErrorHandler 里的，
//    但那个处理器注册在所有 await app.register(...) 之后——Fastify 在注册
//    路由时就把 errorHandler 按值快照进 route context，所以它对**每一条**
//    路由都是死代码，这个谓词从上线起一次都没被调用过。
//    （用本仓库的 fastify 5.11.2 复现确认：处理器执行 0 次。）
//    真正在扛的一直是下面的进程级 isBenignDoubleWrite。
//
// 3. 两个谓词都保留，因为还有第二个、与认证无关的触发器：
//    src/web/caldav.ts 的流式 multistatus 会 reply.hijack() 之后直接
//    raw.writeHead()。那条路径这次没碰。
//
// 它们放在这里而不是内联在 server.ts，是为了能单测，
// 也为了删掉任何一个都会变成「未使用的 import」而不是悄无声息地消失。

/**
 * True once the response has left the building — the error handler must then
 * return the reply untouched instead of trying to render an error page.
 *
 * Both checks matter: `reply.sent` covers Fastify-level sends whose onSend
 * chain is still in flight, `reply.raw.headersSent` covers anything that
 * wrote to the socket directly (CalDAV streaming, hijacked replies).
 */
export function replyAlreadySent(reply: {
  sent?: boolean;
  raw?: { headersSent?: boolean };
}): boolean {
  return reply.sent === true || reply.raw?.headersSent === true;
}

/**
 * True for the specific "wrote the headers twice" error. The response it was
 * retrying had already been delivered in full, so the error is harmless —
 * only the process death it causes matters. Everything else must stay fatal:
 * an unknown uncaught exception means unknown state, and a clean exit lets
 * the process manager restart into a good one.
 */
export function isBenignDoubleWrite(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "ERR_HTTP_HEADERS_SENT"
  );
}
