// Test local des fonctions, sans Netlify : simulation, porte fermée, validation,
// puis paiement Stripe + émission réelle contre un faux middleware et un faux Stripe.
// Lancer : npm test
import { createServer } from "node:http";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { start } from "./dev-server.mjs";

const order = (id, extra = {}) => ({
  orderId: id,
  product: { id: "avia-100", faceCents: 10000, priceCents: 9600 },
  email: "Jean.Dupont@example.com",
  person: { first_name: "Jean-Élie", last_name: "Dupont", birth_date: "1980-05-14", gender: "M", nationality: "FRA", dialing_code: "+33", mobile: "612345678" },
  payment: { method: "simulated" },
  ...extra
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(base, id, want, max = 20) {
  for (let i = 0; i < max; i++) {
    const j = await (await fetch(`${base}/api/order-status?orderId=${id}`)).json();
    if (j.status === want || j.status === "failed" || j.status === "issued") return j;
    await sleep(250);
  }
  throw new Error("timeout status " + want);
}

// ---------- 1. Simulation ----------
delete process.env.MW_BASE_URL; delete process.env.PAYMENT_PROVIDER;
const app = await start(0);
const base = `http://127.0.0.1:${app.address().port}`;

let r = await fetch(`${base}/api/health`).then((x) => x.json());
assert.equal(r.issuing, "simulated"); assert.equal(r.payment, "simulated");

let res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("11111111-2222-3333-4444-555555555555")) });
assert.equal(res.status, 202);
let st = await waitStatus(base, "11111111-2222-3333-4444-555555555555", "issued");
assert.equal(st.status, "issued"); assert.equal(st.mode, "simulated"); assert.ok(st.redeemUrl.includes("/demo-carte.html"));
console.log("simulation ok:", st.redeemUrl);

// Porte fermée sans cookie (appel direct du gestionnaire)
const { default: issue } = await import("../netlify/functions/issue-card.mjs");
const noCookie = await issue(new Request(base + "/api/issue-card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("aaaaaaaa-0000")) }), {});
assert.equal(noCookie.status, 401); console.log("porte fermée sans cookie ok");

// Validation et catalogue
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("bbbbbbbb-0000", { person: { ...order("x").person, mobile: "0612" } })) });
assert.equal(res.status, 400); console.log("validation ok:", (await res.json()).error);
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("cccccccc-0000", { product: { id: "avia-100", faceCents: 10000, priceCents: 100 } })) });
assert.equal(res.status, 400); console.log("prix du client ignoré ok");

// ---------- 2. Faux middleware et faux Stripe ----------
const seenMw = []; let mwMode = "ok";
const mw = createServer((req, resp) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => {
    seenMw.push({ url: req.url, headers: req.headers, body: JSON.parse(data || "{}") });
    resp.setHeader("content-type", "application/json");
    if (req.url === "/customers") {
      if (mwMode === "dup") { resp.statusCode = 409; return resp.end(JSON.stringify({ code: 4090001 })); }
      return resp.end(JSON.stringify({ id: "959104060001252713", account: { id: "859104060001156411" }, card: { id: "759104060001524487", redeemable_code: { uri: "https://cards.example.com/abc", expires_in: 86400 } } }));
    }
    if (req.url.startsWith("/accounts/") && req.url.endsWith("/credit")) return resp.end(JSON.stringify({ transaction_id: "tx-1" }));
    resp.statusCode = 404; resp.end("{}");
  });
});
await new Promise((ok) => mw.listen(0, "127.0.0.1", ok));

const seenStripe = [];
const stripeMock = createServer((req, resp) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => {
    seenStripe.push({ method: req.method, url: req.url, body: data });
    resp.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return resp.end(JSON.stringify({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.test/cs_test_1" }));
    if (req.method === "GET" && req.url.startsWith("/v1/payment_intents/pi_1")) return resp.end(JSON.stringify({ id: "pi_1", object: "payment_intent", status: "requires_capture", amount: 9600 }));
    if (req.method === "POST" && req.url === "/v1/payment_intents/pi_1/capture") return resp.end(JSON.stringify({ id: "pi_1", status: "succeeded" }));
    if (req.method === "POST" && req.url === "/v1/payment_intents/pi_1/cancel") return resp.end(JSON.stringify({ id: "pi_1", status: "canceled" }));
    resp.statusCode = 404; resp.end(JSON.stringify({ error: { message: "mock: " + req.url } }));
  });
});
await new Promise((ok) => stripeMock.listen(0, "127.0.0.1", ok));

process.env.MW_BASE_URL = `http://127.0.0.1:${mw.address().port}`;
process.env.MW_BASIC_USER = "u"; process.env.MW_BASIC_PASS = "p"; process.env.MW_API_KEY = "k";
process.env.PAYMENT_PROVIDER = "stripe"; process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
process.env.STRIPE_API_BASE = `http://127.0.0.1:${stripeMock.address().port}`;

r = await fetch(`${base}/api/health`).then((x) => x.json());
assert.equal(r.issuing, "real"); assert.equal(r.payment, "stripe");

// Paiement simulé refusé en mode réel
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("dddddddd-0000")) });
assert.equal(res.status, 402); console.log("paiement requis en réel ok");

// Session de paiement
const id = "22222222-2222-3333-4444-555555555555";
res = await fetch(`${base}/api/payment-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id)) });
assert.equal(res.status, 200); const sess = await res.json();
assert.equal(sess.redirectUrl, "https://checkout.stripe.test/cs_test_1");
const created = seenStripe.find((s) => s.url === "/v1/checkout/sessions");
assert.ok(created.body.includes("capture_method%5D=manual") || created.body.includes("capture_method]=manual"), "autorisation seule");
assert.ok(created.body.includes("unit_amount%5D=9600") || created.body.includes("unit_amount]=9600"), "montant payé = prix catalogue");
st = await waitStatus(base, id, "pending"); assert.equal(st.status, "pending");
console.log("session Stripe ok (autorisation seule, 96 €)");

// Webhook signé → émission → capture
const stripe = new Stripe("sk_test_x");
const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: id, payment_intent: "pi_1", metadata: { orderId: id } } } });
const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_x" });
res = await fetch(`${base}/api/stripe-webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
assert.equal(res.status, 200);
st = await waitStatus(base, id, "issued");
assert.equal(st.status, "issued"); assert.equal(st.mode, "real"); assert.equal(st.redeemUrl, "https://cards.example.com/abc");
assert.ok(seenStripe.some((s) => s.url === "/v1/payment_intents/pi_1/capture"), "capture après émission");
const create = seenMw.find((s) => s.url === "/customers");
assert.equal(create.body.card.emboss_name, "JEAN-ELIE DUPONT");
assert.equal(create.body.email, "jean.dupont@example.com");
assert.equal(create.headers["x-unique-id"], id); assert.equal(create.headers["x-api-key"], "k");
assert.ok(create.headers.authorization.startsWith("Basic "));
const load = seenMw.find((s) => s.url.endsWith("/credit"));
assert.deepEqual(load.body, { transaction_code: "AccountLoad", amount: 10000, description: "Boutique " + id });
console.log("webhook → émission → capture ok");

// Rejeu du webhook : idempotent
res = await fetch(`${base}/api/stripe-webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
assert.equal((await res.json()).ignored, "already-issued"); console.log("rejeu webhook ignoré ok");

// Signature invalide
res = await fetch(`${base}/api/stripe-webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" }, body: payload });
assert.equal(res.status, 400); console.log("signature invalide refusée ok");

// Refus de l'émetteur (doublon) → annulation de l'autorisation, commande failed
mwMode = "dup";
const id2 = "33333333-2222-3333-4444-555555555555";
await fetch(`${base}/api/payment-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id2)) });
const payload2 = JSON.stringify({ id: "evt_2", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: id2, payment_intent: "pi_1" } } });
res = await fetch(`${base}/api/stripe-webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: payload2, secret: "whsec_x" }) }, body: payload2 });
assert.equal(res.status, 200);
st = await waitStatus(base, id2, "failed");
assert.equal(st.status, "failed"); assert.equal(st.code, "DUPLICATE");
assert.ok(seenStripe.some((s) => s.url === "/v1/payment_intents/pi_1/cancel"), "autorisation annulée, zéro débit");
console.log("refus émetteur → annulation du paiement ok");

mw.close(); stripeMock.close(); app.close();
console.log("TOUT OK");
