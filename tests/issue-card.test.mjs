// Test local des fonctions, sans Netlify : mode simulation, puis mode réel contre un faux middleware.
// Lancer : npm test
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const gateCookie = () => "shop_gate=" + createHash("sha256").update("shop-gate|Avia2026").digest("hex");

const order = {
  orderId: "11111111-2222-3333-4444-555555555555",
  product: { id: "avia-100", faceCents: 10000, priceCents: 9600 },
  email: "Jean.Dupont@example.com",
  person: { first_name: "Jean-Élie", last_name: "Dupont", birth_date: "1980-05-14", gender: "M", nationality: "FRA", dialing_code: "+33", mobile: "612345678" },
  payment: { method: "simulated" }
};

async function post(handler, body, headers = {}) {
  const req = new Request("https://boutique.test/api/issue-card", { method: "POST", headers: { "content-type": "application/json", cookie: gateCookie(), ...headers }, body: JSON.stringify(body) });
  const res = await handler(req, {});
  return { status: res.status, body: await res.json() };
}

// 1. Simulation
delete process.env.MW_BASE_URL;
const { default: issue } = await import("../netlify/functions/issue-card.mjs?sim");
let r = await post(issue, order);
assert.equal(r.status, 200); assert.equal(r.body.mode, "simulated"); assert.ok(r.body.redeemUrl.includes("/demo-carte.html"));
console.log("simulation ok:", r.body.redeemUrl);

// Sans cookie → 401
const noCookie = await issue(new Request("https://boutique.test/api/issue-card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) }), {});
assert.equal(noCookie.status, 401);
console.log("porte fermée sans cookie ok");

// Validation
r = await post(issue, { ...order, person: { ...order.person, mobile: "0612" } });
assert.equal(r.status, 400); console.log("validation ok:", r.body.error);

// 2. Mode réel contre un faux middleware
const seen = [];
const server = createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(data || "{}") });
    res.setHeader("content-type", "application/json");
    if (req.url === "/customers") {
      res.end(JSON.stringify({ id: "959104060001252713", account: { id: "859104060001156411" }, card: { id: "759104060001524487", redeemable_code: { uri: "https://cards.example.com/abc", expires_in: 86400 } } }));
    } else if (req.url.startsWith("/accounts/") && req.url.endsWith("/credit")) {
      res.end(JSON.stringify({ transaction_id: "tx-1" }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
process.env.MW_BASE_URL = `http://127.0.0.1:${port}`;
process.env.MW_BASIC_USER = "u"; process.env.MW_BASIC_PASS = "p"; process.env.MW_API_KEY = "k";

const { default: issueReal } = await import("../netlify/functions/issue-card.mjs?real");
r = await post(issueReal, order);
assert.equal(r.status, 402, "paiement simulé refusé en mode réel"); console.log("paiement requis en réel ok");

process.env.ALLOW_SIMULATED_PAYMENT = "true";
r = await post(issueReal, order);
assert.equal(r.status, 200); assert.equal(r.body.mode, "real"); assert.equal(r.body.redeemUrl, "https://cards.example.com/abc");
const create = seen.find((s) => s.url === "/customers");
assert.equal(create.body.card.emboss_name, "JEAN-ELIE DUPONT");
assert.equal(create.body.email, "jean.dupont@example.com");
assert.equal(create.body.mobile_number_dialing_code, "+33");
assert.equal(create.headers["x-unique-id"], order.orderId);
assert.equal(create.headers["x-api-key"], "k");
assert.ok(create.headers.authorization.startsWith("Basic "));
const load = seen.find((s) => s.url.endsWith("/credit"));
assert.deepEqual(load.body, { transaction_code: "AccountLoad", amount: 10000, description: "Boutique " + order.orderId });
assert.equal(load.headers["x-unique-id"], order.orderId + "-load");
console.log("mode réel ok (création + chargement, en-têtes et corps conformes)");
server.close();
console.log("TOUT OK");
