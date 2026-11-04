// Test local des fonctions, sans Netlify : simulation, porte fermée, validation,
// puis paiement Stripe + émission réelle contre un faux middleware et un faux Stripe.
// Lancer : npm test
import { createServer } from "node:http";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./dev-server.mjs";

// Magasin local des commandes (voir lib/orders.mjs) : repartir de zéro, sinon un ancien test est rejoué (200 au lieu de 202).
await rm(join(tmpdir(), "avia-boutique-orders"), { recursive: true, force: true });

const order = (id, extra = {}) => ({
  orderId: id,
  product: { id: "avia-100", faceCents: 10000, priceCents: 9600 },
  email: "Jean.Dupont@example.com",
  person: { first_name: "Jean-Élie", last_name: "Dupont", birth_date: "1980-05-14", nationality: "FRA", dialing_code: "+33", mobile: "612345678" },
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
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("bbbbbbbb-0000", { person: { ...order("x").person, mobile: "061" } })) });
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
      // Refus réel de la plateforme (3 novembre 2026) : même mobile qu'une carte déjà émise → 424 + code 4245001.
      if (mwMode === "dup424") { resp.statusCode = 424; return resp.end(JSON.stringify({ code: 4245001, message: "Customer already exists" })); }
      if (mwMode === "down") { resp.statusCode = 424; return resp.end(JSON.stringify({ code: 4249999, message: "Platform unavailable" })); }
      const b = JSON.parse(data);
      if ("gender" in b) { resp.statusCode = 400; return resp.end(JSON.stringify({ code: 4000001, errors: { gender: ["unknown field"] } })); }
      if (!/^[A-Za-z0-9-._]{10,36}$/.test(req.headers["x-unique-id"] || "")) { resp.statusCode = 400; return resp.end(JSON.stringify({ code: 4000002, errors: { "x-unique-id": ["bad"] } })); }
      return resp.end('{"id":959104060001252713,"account":{"id":859104060001156411},"card":{"id":759104060001524487,"cardholder_id":759104060001524487,"redeemable_code":{"uri":"https://cards.example.com/abc","expires_in":86400}}}');
    }
    if (req.url.startsWith("/accounts/") && !/^[A-Za-z0-9-._]{10,36}$/.test(req.headers["x-unique-id"] || "")) { resp.statusCode = 400; return resp.end(JSON.stringify({ code: 4000002 })); }
    if (req.url.startsWith("/accounts/") && req.url.endsWith("/credit")) return resp.end(JSON.stringify({ transaction_id: "tx-1" }));
    resp.statusCode = 404; resp.end("{}");
  });
});
await new Promise((ok) => mw.listen(0, "127.0.0.1", ok));

const seenStripe = []; let sessionPaid = false;
const stripeMock = createServer((req, resp) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => {
    seenStripe.push({ method: req.method, url: req.url, body: data });
    resp.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return resp.end(JSON.stringify({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.test/cs_test_1" }));
    if (req.method === "GET" && req.url.startsWith("/v1/checkout/sessions/cs_test_1")) return resp.end(JSON.stringify(sessionPaid ? { id: "cs_test_1", object: "checkout.session", status: "complete", payment_intent: { id: "pi_1", object: "payment_intent", status: "requires_capture", amount: 9600 } } : { id: "cs_test_1", object: "checkout.session", status: "open", payment_intent: null }));
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
assert.ok(!("gender" in create.body), "pas de champ civilité");
assert.equal(create.body.email, "jean.dupont@example.com");
assert.equal(create.headers["x-unique-id"], id); assert.equal(create.headers["x-api-key"], "k");
assert.ok(create.headers.authorization.startsWith("Basic "));
const load = seenMw.find((s) => s.url.endsWith("/credit"));
assert.deepEqual(load.body, { transaction_code: "AccountLoad", amount: 10000, description: "Boutique " + id });
assert.equal(load.url, "/accounts/859104060001156411/credit", "identifiant de compte 18 chiffres conservé exactement");
assert.ok(load.headers["x-unique-id"].length <= 36 && load.headers["x-unique-id"] !== id, "x-unique-id du chargement distinct et ≤ 36");
console.log("webhook → émission → capture ok (ids 18 chiffres intacts, x-unique-id conformes)");

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

// Même refus, tel que la plateforme le renvoie réellement (424 + code 4245001) → DUPLICATE, pas UPSTREAM ; autre 424 → UPSTREAM
process.env.ALLOW_SIMULATED_PAYMENT = "true";
for (const [mode, expected, id] of [["dup424", "DUPLICATE", "33333333-2222-3333-4444-555555555556"], ["down", "UPSTREAM", "33333333-2222-3333-4444-555555555557"]]) {
  mwMode = mode;
  res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id)) });
  assert.equal(res.status, 202);
  st = await waitStatus(base, id, "failed");
  assert.equal(st.code, expected, `424 ${mode} → ${expected}`);
}
delete process.env.ALLOW_SIMULATED_PAYMENT; mwMode = "ok";
console.log("424 doublon plateforme → DUPLICATE, autre 424 → UPSTREAM ok");

// Retour client sans webhook : la session est vérifiée auprès de Stripe et l'émission démarre
mwMode = "ok"; sessionPaid = true;
const id3 = "44444444-2222-3333-4444-555555555555";
await fetch(`${base}/api/payment-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id3)) });
st = await waitStatus(base, id3, "issued");
assert.equal(st.status, "issued"); assert.equal(st.mode, "real");
console.log("vérification au retour (sans webhook) → émission ok");

// Staging : émission réelle sur la plateforme de test, paiement simulé accepté, paiement Stripe jamais capturé
process.env.MW_ENVIRONMENT = "staging";
r = await fetch(`${base}/api/health`).then((x) => x.json()); assert.equal(r.issuing, "staging");
const idS = "66666666-2222-3333-4444-555555555555";
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(idS)) });
assert.equal(res.status, 202, "paiement simulé accepté en staging");
st = await waitStatus(base, idS, "issued"); assert.equal(st.status, "issued"); assert.equal(st.mode, "staging");
const idS2 = "77777777-2222-3333-4444-555555555555"; const beforeS = seenStripe.filter((s) => s.url.endsWith("/cancel")).length;
await fetch(`${base}/api/payment-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(idS2)) });
st = await waitStatus(base, idS2, "issued"); assert.equal(st.mode, "staging"); assert.equal(st.paymentReleased, true);
assert.equal(seenStripe.filter((s) => s.url.endsWith("/cancel")).length, beforeS + 1, "staging : autorisation annulée");
console.log("staging : émission réelle, paiement jamais capturé ok");
delete process.env.MW_ENVIRONMENT;

// Émission simulée + paiement Stripe réel : autorisation annulée, jamais capturée
delete process.env.MW_BASE_URL;
const before = seenStripe.filter((s) => s.url.endsWith("/cancel")).length;
const id4 = "55555555-2222-3333-4444-555555555555";
await fetch(`${base}/api/payment-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id4)) });
st = await waitStatus(base, id4, "issued");
assert.equal(st.status, "issued"); assert.equal(st.mode, "simulated"); assert.equal(st.paymentReleased, true);
assert.equal(seenStripe.filter((s) => s.url.endsWith("/cancel")).length, before + 1, "autorisation annulée en simulation");
console.log("simulation + Stripe réel → paiement annulé, rien débité ok");

// Remise du lien au porteur : e-mail (transport JSON, aucun envoi réel) avec le lien court /c/REF, qui renvoie vers la page de guidage
process.env.SMTP_HOST = "json"; process.env.SMTP_USER = "cartes@example.com"; process.env.MAIL_FROM = "AVIA by SoShop.Club <cartes@example.com>";
process.env.ALLOW_SIMULATED_PAYMENT = "true";
const id5 = "88888888-2222-3333-4444-555555555555";
// Vérification de l'adresse e-mail par code : exigée dès que l'e-mail est configuré
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id5)) });
assert.equal(res.status, 403); assert.equal((await res.json()).code, "EMAIL_UNVERIFIED", "pas d'émission sans adresse vérifiée");
res = await fetch(`${base}/api/email-code/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: order(id5).email }) });
let vc = await res.json();
assert.equal(res.status, 200); assert.equal(vc.required, true); assert.match(vc.devCode, /^\d{6}$/, "code à 6 chiffres (transport JSON)");
res = await fetch(`${base}/api/email-code/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: order(id5).email }) });
assert.equal(res.status, 429); assert.equal((await res.json()).code, "TOO_SOON", "un envoi par minute");
res = await fetch(`${base}/api/email-code/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: order(id5).email, code: "000000" === vc.devCode ? "111111" : "000000" }) });
assert.equal(res.status, 400); assert.equal((await res.json()).code, "WRONG");
res = await fetch(`${base}/api/email-code/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: order(id5).email, code: vc.devCode }) });
vc = await res.json(); assert.equal(res.status, 200); assert.ok(vc.token, "jeton d'adresse vérifiée");
res = await fetch(`${base}/api/email-code/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: order(id5).email, code: "123456" }) });
assert.equal(res.status, 409, "un code ne sert qu'une fois");
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id5, { emailToken: vc.token, email: "autre@example.com" })) });
assert.equal(res.status, 403, "le jeton ne vaut que pour l'adresse vérifiée");
res = await fetch(`${base}/api/issue-card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(id5, { emailToken: vc.token })) });
assert.equal(res.status, 202);
console.log("vérification e-mail par code ok");
st = await waitStatus(base, id5, "issued");
const { getOrder: readOrder } = await import("../netlify/functions/lib/orders.mjs");
const full = await readOrder(id5);
assert.ok(full.delivery && full.delivery.email && full.delivery.email.ok, "e-mail construit et remis au transport");
const mail = JSON.parse(full.delivery.email.preview);
assert.equal(mail.to[0].address, order(id5).email.toLowerCase());
assert.match(mail.subject, /prête/);
assert.ok(mail.text.includes(`${base}/c/88888888`), "lien court dans l'e-mail");
assert.ok(mail.html.includes("Google Wallet") && mail.html.includes("Cartes"), "consignes Android et iPhone dans l'e-mail");
assert.equal(full.delivery.sms, null, "SMS coupé par défaut (payant)");
res = await fetch(`${base}/c/88888888`, { redirect: "manual" });
assert.equal(res.status, 302);
assert.ok(res.headers.get("location").startsWith(`${base}/#/carte?u=`), "lien court → page de guidage");
res = await fetch(`${base}/c/ZZZZZZZZ`, { redirect: "manual" });
assert.equal(res.status, 404);
// Renvoi de l'e-mail : vers l'adresse de la commande uniquement, 3 fois au plus, une minute entre deux
res = await fetch(`${base}/api/resend-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: id5, email: "pirate@example.com" }) });
let rs = await res.json();
assert.equal(res.status, 200); assert.equal(rs.ok, true); assert.equal(rs.remaining, 2);
assert.match(rs.email, /^j\*\*\*t@example\.com$/, "adresse masquée, celle de la commande");
const again = await readOrder(id5);
assert.equal(JSON.parse(again.delivery.email.preview).to[0].address, order(id5).email.toLowerCase(), "renvoyé à l'adresse de la commande, pas à celle de la requête");
res = await fetch(`${base}/api/resend-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: id5 }) });
rs = await res.json(); assert.equal(res.status, 429); assert.equal(rs.code, "TOO_SOON");
res = await fetch(`${base}/api/resend-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "00000000-0000-0000-0000-000000000000" }) });
assert.equal(res.status, 404);
delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.MAIL_FROM; delete process.env.ALLOW_SIMULATED_PAYMENT;
console.log("remise du lien : e-mail + lien court ok");

// Audience : traces d'étape (sans IP) puis agrégation par période
const tr = (sid, screen, extra = {}) => fetch(`${base}/api/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, screen, ...extra }) });
res = await tr("abcdef1234", "home", { ref: "https://avia.example/promo" }); assert.equal(res.status, 202);
await tr("abcdef1234", "email"); await tr("abcdef1234", "details"); await tr("abcdef1234", "review"); await tr("abcdef1234", "stripe"); await tr("abcdef1234", "creating"); await tr("abcdef1234", "ready", { orderId: id5 });
await tr("zzzz987654", "home"); await tr("zzzz987654", "email"); await tr("zzzz987654", "error", { code: "DUPLICATE" });
res = await tr("short", "home"); assert.equal(res.status, 400, "session invalide refusée");
res = await tr("abcdef1234", "nimporte"); assert.equal(res.status, 400, "écran inconnu refusé");
const today = new Date().toISOString().slice(0, 10);
res = await fetch(`${base}/api/audience?from=${today}&to=${today}`);
const au = await res.json();
assert.equal(res.status, 200); assert.equal(au.sessions, 2); assert.equal(au.visitorsWithEmail, 2); assert.equal(au.visitorsWithOrder, 1);
assert.equal(au.funnel[0].sessions, 2); assert.equal(au.funnel[au.funnel.length - 1].sessions, 1, "une session arrive à « carte prête »");
assert.equal(au.dropOff[0].k, "E-mail saisi", "l'autre décroche après l'e-mail");
assert.equal(au.errors[0].k, "DUPLICATE");
assert.ok(au.orders.total >= 1 && au.orders.list.every((o) => !o.email || o.email.includes("***")), "e-mails masqués");
assert.ok(JSON.stringify([au.sessionsList, au.orders]).indexOf("127.0.0.1") === -1 && !("ip" in (au.sessionsList[0] || {})), "aucune IP dans l'audience");
assert.equal(au.referrers[0].k, "https://avia.example/promo");
console.log("audience : traces + agrégation ok");

mw.close(); stripeMock.close(); app.close();
console.log("TOUT OK");
