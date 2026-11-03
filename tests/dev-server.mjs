// Serveur de développement minimal : fichiers de /public + fonctions /api/* (sans la porte d'entrée).
// Lancer : node tests/dev-server.mjs  →  http://localhost:8788
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

const ROOT = new URL("../public/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const fns = {
  "/api/issue-card": () => import("../netlify/functions/issue-card.mjs"),
  "/api/health": () => import("../netlify/functions/health.mjs"),
  "/api/payment-session": () => import("../netlify/functions/payment-session.mjs"),
  "/api/stripe-webhook": () => import("../netlify/functions/stripe-webhook.mjs"),
  "/api/issue-worker": () => import("../netlify/functions/issue-worker-background.mjs"),
  "/api/order-status": () => import("../netlify/functions/order-status.mjs")
};

export function start(port = 8788) {
  const cookie = "shop_gate=" + createHash("sha256").update("shop-gate|" + (process.env.SHOP_ACCESS_CODE || "Avia2026")).digest("hex");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const shortCode = url.pathname.match(/^\/c\/([A-Za-z0-9]+)$/);
    if (fns[url.pathname] || shortCode) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const { default: handler } = shortCode ? await import("../netlify/functions/card-link.mjs") : await fns[url.pathname]();
      const headers = { ...req.headers, cookie };
      const origin = `http://127.0.0.1:${server.address().port}`;
      const r = await handler(new Request(origin + req.url, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), shortCode ? { params: { code: shortCode[1] } } : {});
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (req.method === "POST" && url.pathname === "/") { res.writeHead(200); res.end("ok"); return; } // formulaire entreprise
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (p === "/gate") p = "/gate.html";
    try {
      const file = join(ROOT, p); await stat(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end("not found"); }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && process.argv[1].endsWith("dev-server.mjs")) {
  start(8788).then((s) => console.log(`dev server: http://localhost:${s.address().port}`));
}
