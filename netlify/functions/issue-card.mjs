// POST /api/issue-card — crée et charge une carte pour un particulier après paiement.
//
// Deux modes, choisis par la présence de MW_BASE_URL :
//   - simulation (aucune variable) : aucune carte réelle, identifiants fictifs, lien de démonstration ;
//   - réel : appels au middleware (création client + carte, puis chargement).
//
// Garde-fous :
//   - le cookie de la porte d'entrée est exigé (même règle que l'edge function) ;
//   - en mode réel, un paiement "simulé" est refusé sauf ALLOW_SIMULATED_PAYMENT=true (tests de production) ;
//   - idempotence : l'identifiant de commande sert d'x-unique-id, le même pour la création et (suffixé) pour le chargement.

import { createHash } from "node:crypto";
import { middlewareConfig, createCustomerAndCard, creditAccount, embossName, MiddlewareError } from "./lib/middleware.mjs";

export const config = { path: "/api/issue-card" };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function gateOk(request, env) {
  const code = env.SHOP_ACCESS_CODE || "Avia2026";
  if (code === "open") return true;
  const expected = createHash("sha256").update("shop-gate|" + code).digest("hex");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)shop_gate=([a-f0-9]{64})/);
  return !!m && m[1] === expected;
}

function validate(body) {
  const errors = [];
  const p = body && body.person;
  const prod = body && body.product;
  if (!body || typeof body.orderId !== "string" || body.orderId.length < 8 || body.orderId.length > 64) errors.push("orderId");
  if (!prod || !Number.isInteger(prod.faceCents) || prod.faceCents <= 0 || prod.faceCents > 15000) errors.push("product");
  if (!body || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) errors.push("email");
  if (!p) errors.push("person");
  else {
    for (const k of ["first_name", "last_name", "birth_date", "gender", "nationality", "dialing_code", "mobile"]) {
      if (typeof p[k] !== "string" || !p[k].trim()) errors.push(k);
    }
    if (p.birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.birth_date)) errors.push("birth_date");
    if (p.nationality && !/^[A-Z]{3}$/.test(p.nationality)) errors.push("nationality");
    if (p.dialing_code && !/^\+\d{1,4}$/.test(p.dialing_code)) errors.push("dialing_code");
    if (p.mobile && !/^\d{6,12}$/.test(p.mobile)) errors.push("mobile");
  }
  return errors;
}

export default async (request, context) => {
  if (request.method !== "POST") return json(405, { ok: false, error: "Méthode non autorisée." });
  const env = process.env;
  if (!gateOk(request, env)) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Code d'accès requis." });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { ok: false, error: "Corps de requête invalide." }); }
  const errors = validate(body);
  if (errors.length) return json(400, { ok: false, code: "INVALID", error: "Informations incomplètes : " + errors.join(", ") });

  const cfg = middlewareConfig(env);
  const person = { ...body.person, email: body.email.trim().toLowerCase() };
  const face = body.product.faceCents;
  const orderId = body.orderId;
  const paymentMethod = (body.payment && body.payment.method) || "none";

  // ----- Mode simulation -----
  if (!cfg.enabled) {
    await new Promise((r) => setTimeout(r, 1800));
    const origin = new URL(request.url).origin;
    const last4 = String(1000 + (parseInt(orderId.replace(/\D/g, "").slice(-4) || "0", 10) % 9000));
    const name = embossName(person.first_name, person.last_name);
    return json(200, {
      ok: true, mode: "simulated", orderId,
      customerId: "SIM-C-" + orderId.slice(0, 8), accountId: "SIM-A-" + orderId.slice(0, 8), cardId: "SIM-K-" + orderId.slice(0, 8),
      last4, redeemUrl: `${origin}/demo-carte.html?face=${face / 100}&name=${encodeURIComponent(name)}&l4=${last4}`, expiresIn: 3600,
      loadedCents: face
    });
  }

  // ----- Mode réel -----
  if (paymentMethod !== "paytently" && env.ALLOW_SIMULATED_PAYMENT !== "true") {
    return json(402, { ok: false, code: "PAYMENT_REQUIRED", error: "Le paiement n'a pas été confirmé." });
  }

  let created;
  try {
    created = await createCustomerAndCard(cfg, person, orderId);
  } catch (err) {
    if (err instanceof MiddlewareError) {
      const code = err.code === "DUPLICATE" ? "DUPLICATE" : err.code === "TIMEOUT" ? "TIMEOUT" : err.code === "UPSTREAM" ? "UPSTREAM" : "REFUSED";
      console.log(JSON.stringify({ step: "create", orderId, fail: err.code, status: err.status, body: err.body }));
      return json(502, { ok: false, code, error: code === "UPSTREAM" ? "L'émetteur est momentanément indisponible." : undefined });
    }
    console.log(JSON.stringify({ step: "create", orderId, fail: "unexpected", msg: String(err && err.message) }));
    return json(500, { ok: false, code: "ERROR" });
  }
  if (!created.accountId) {
    console.log(JSON.stringify({ step: "create", orderId, fail: "no-account-id", raw: created.raw }));
    return json(502, { ok: false, code: "REFUSED" });
  }

  let loaded;
  try {
    loaded = await creditAccount(cfg, created.accountId, face, `Boutique ${orderId}`, orderId + "-load");
  } catch (err) {
    // La carte existe mais le chargement n'est pas confirmé : ne pas rejouer automatiquement.
    console.log(JSON.stringify({ step: "load", orderId, accountId: created.accountId, fail: err && err.code, status: err && err.status, body: err && err.body }));
    return json(502, { ok: false, code: "LOAD_PENDING", accountId: created.accountId, cardId: created.cardId });
  }

  return json(200, {
    ok: true, mode: "real", orderId,
    customerId: created.customerId, accountId: created.accountId, cardId: created.cardId,
    last4: created.last4, redeemUrl: created.redeemUrl, expiresIn: created.expiresIn,
    loadedCents: face, transactionId: loaded.transactionId
  });
};
