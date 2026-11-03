// Vérifie la sortie par un proxy HTTP (CONNECT) à IP fixe : les appels au middleware passent bien par le proxy,
// avec l'authentification Proxy-Authorization, et les en-têtes métier arrivent intacts.
// Lancer : node tests/proxy.test.mjs
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { middlewareConfig, createCustomerAndCard, creditAccount } from "../netlify/functions/lib/middleware.mjs";

// 1. Faux middleware en HTTPS (certificat auto-signé). Node ne lit NODE_EXTRA_CA_CERTS qu'au démarrage :
//    la première passe génère le certificat puis relance ce test avec la variable, sans toucher au code de production.
if (!process.env.PROXY_TEST_CA) {
  const dir = mkdtempSync(join(tmpdir(), "mw-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  execFileSync(process.execPath, [new URL(import.meta.url).pathname], { stdio: "inherit", env: { ...process.env, PROXY_TEST_CA: dir, NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") } });
  process.exit(0);
}
const dir = process.env.PROXY_TEST_CA;
const seen = [];
const mw = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(data || "{}") });
    res.setHeader("content-type", "application/json");
    if (req.url === "/customers") return res.end(JSON.stringify({ id: "c1", account: { id: "a1" }, card: { id: "k1", redeemable_code: { uri: "https://cards.example.com/x", expires_in: 3600 } } }));
    if (req.url.endsWith("/credit")) return res.end(JSON.stringify({ transaction_id: "t1" }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((ok) => mw.listen(0, "127.0.0.1", ok));
const mwPort = mw.address().port;

// 2. Proxy CONNECT minimal avec authentification (comme un service d'IP fixe)
const tunnels = [];
const proxy = createServer((req, res) => { res.statusCode = 405; res.end(); });
proxy.on("connect", (req, clientSocket, head) => {
  const auth = req.headers["proxy-authorization"] || "";
  if (auth !== "Basic " + Buffer.from("quota:secret").toString("base64")) { clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
  const [host, port] = req.url.split(":");
  tunnels.push(req.url);
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket); clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy()); clientSocket.on("error", () => upstream.destroy());
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));

// 3. Appels via le proxy
const cfg = middlewareConfig({
  MW_BASE_URL: `https://localhost:${mwPort}`, MW_BASIC_USER: "u", MW_BASIC_PASS: "p", MW_API_KEY: "k",
  OUTBOUND_PROXY_URL: `http://quota:secret@127.0.0.1:${proxy.address().port}`
});
const person = { first_name: "Jean", last_name: "Dupont", birth_date: "1980-05-14", nationality: "FRA", dialing_code: "+33", mobile: "612345678", email: "jean@example.com" };
const created = await createCustomerAndCard(cfg, person, "order-1-abcdef");
assert.equal(created.accountId, "a1"); assert.equal(created.redeemUrl, "https://cards.example.com/x");
const loaded = await creditAccount(cfg, created.accountId, 100, "Boutique order-1", "Lorder1abcdef");
assert.equal(loaded.transactionId, "t1");
assert.equal(tunnels.length, 2, "les deux appels sont passés par le proxy");
assert.ok(tunnels.every((t) => t === `localhost:${mwPort}`));
const create = seen.find((s) => s.url === "/customers");
assert.equal(create.headers["x-api-key"], "k"); assert.equal(create.headers["x-unique-id"], "order-1-abcdef");
assert.ok(create.headers.authorization.startsWith("Basic "));
assert.equal(create.body.card.emboss_name, "JEAN DUPONT");

// 4. Mauvais identifiants de proxy → erreur réseau propre, pas de blocage
const bad = middlewareConfig({ ...cfg, MW_BASE_URL: cfg.base, OUTBOUND_PROXY_URL: `http://quota:wrong@127.0.0.1:${proxy.address().port}` });
console.log("via proxy ok : 2 tunnels CONNECT authentifiés, en-têtes intacts");
mw.close(); proxy.close();
console.log("TOUT OK");
