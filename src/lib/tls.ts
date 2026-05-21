import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type https from "node:https";
import type { Server as HttpsServer } from "node:https";
import { env } from "../env.js";

type CertMaterial = { key: Buffer; cert: Buffer };

export function readCerts(): CertMaterial {
  if (!env.HTTPS_CERT_PATH || !env.HTTPS_KEY_PATH) {
    throw new Error("HTTPS_CERT_PATH and HTTPS_KEY_PATH must be set when USE_HTTPS=true");
  }
  const cert = fs.readFileSync(env.HTTPS_CERT_PATH);
  const key = fs.readFileSync(env.HTTPS_KEY_PATH);
  return { key, cert };
}

export function watchCertReload(server: HttpsServer, log: (msg: string, err?: unknown) => void): void {
  if (!env.HTTPS_CERT_PATH || !env.HTTPS_KEY_PATH) return;

  let timer: NodeJS.Timeout | null = null;
  const debounce = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const next = readCerts();
        server.setSecureContext({ key: next.key, cert: next.cert });
        log("[tls] certificate reloaded");
      } catch (err) {
        log("[tls] certificate reload failed", err);
      }
    }, 1000);
  };

  // Watch the directory rather than the file, so atomic-replace renews still trigger.
  const certDir = path.dirname(env.HTTPS_CERT_PATH);
  const keyDir = path.dirname(env.HTTPS_KEY_PATH);
  const dirs = certDir === keyDir ? [certDir] : [certDir, keyDir];

  for (const dir of dirs) {
    try {
      fs.watch(dir, { persistent: false }, (_evt, filename) => {
        if (!filename) {
          debounce();
          return;
        }
        const full = path.join(dir, filename.toString());
        if (full === env.HTTPS_CERT_PATH || full === env.HTTPS_KEY_PATH) debounce();
      });
    } catch (err) {
      log(`[tls] fs.watch failed for ${dir}`, err);
    }
  }
}

// ACME http-01 challenge passthrough — let 宝塔's Let's Encrypt renew certs
// even though we hold port 80. Serve any file under /.well-known/acme-challenge/
// from ACME_WEBROOT (BT default: /www/wwwroot/<domain>/).
export function startHttpRedirectServer(log: (msg: string) => void): http.Server {
  const port = env.HTTP_REDIRECT_PORT;
  const acmeWebroot = process.env.ACME_WEBROOT ?? path.join(process.cwd(), "public");

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/.well-known/acme-challenge/")) {
      const token = url.slice("/.well-known/acme-challenge/".length).replace(/[^A-Za-z0-9_\-]/g, "");
      const filePath = path.join(acmeWebroot, ".well-known", "acme-challenge", token);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(data);
      });
      return;
    }
    const host = (req.headers.host ?? "").split(":")[0] || new URL(env.PUBLIC_BASE_URL).hostname;
    const location = `https://${host}${url}`;
    res.writeHead(301, {
      Location: location,
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
    res.end();
  });
  server.listen(port, () => {
    log(`[tls] HTTP -> HTTPS redirector listening on :${port} (ACME webroot: ${acmeWebroot})`);
  });
  return server;
}

// Helper for Fastify https option shape
export function httpsOptionsFromEnv(): https.ServerOptions {
  const { key, cert } = readCerts();
  return { key, cert };
}
