// Guards against the double-writeHead crash.
//
// Several auth helpers (requireUser() and friends in lib/session.ts)
// deliberately `reply.code(401).send(...)` and THEN `throw`, using the throw
// only to abort the caller's flow. The response is already on the wire by the
// time the error surfaces. If the error handler then touches `reply` again —
// or merely resolves with `undefined`, which Fastify reads as "unhandled" —
// Fastify falls through to its built-in fallbackErrorHandler, which does:
//
//     try   { raw.writeHead(status, headers) }
//     catch { log(); raw.writeHead(status) }   // <- the retry is NOT wrapped
//
// The retry throws ERR_HTTP_HEADERS_SENT out of a promise chain nothing
// catches, so the process exits. One unauthenticated GET /api/calendars was
// enough to take the whole server down, over and over.
//
// These two predicates are the fix, kept here (rather than inline in
// server.ts) so they can be unit-tested and so deleting either one shows up
// as an unused import rather than a silent removal of a safety net.

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
