// Émission d'une carte : simulation (aucune variable MW_*) ou réel (middleware).
// Utilisé par /api/issue-card (paiement simulé) et par le webhook de paiement (paiement réel).

import { middlewareConfig, createCustomerAndCard, creditAccount, embossName, loadUniqueId, MiddlewareError } from "./middleware.mjs";

export function validateOrder(body) {
  const errors = [];
  const p = body && body.person;
  const prod = body && body.product;
  if (!body || typeof body.orderId !== "string" || !/^[A-Za-z0-9-._]{10,36}$/.test(body.orderId)) errors.push("orderId");
  if (!prod || !Number.isInteger(prod.faceCents) || prod.faceCents <= 0 || prod.faceCents > 15000) errors.push("product");
  if (prod && (!Number.isInteger(prod.priceCents) || prod.priceCents <= 0 || prod.priceCents > prod.faceCents)) errors.push("price");
  if (!body || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) errors.push("email");
  if (!p) errors.push("person");
  else {
    for (const k of ["first_name", "last_name", "birth_date", "nationality", "dialing_code", "mobile"]) {
      if (typeof p[k] !== "string" || !p[k].trim()) errors.push(k);
    }
    if (p.birth_date && !/^(19|20)\d{2}-(0[1-9]|1[012])-(0[1-9]|[12]\d|3[01])$/.test(p.birth_date)) errors.push("birth_date");
    if (body.email && /\+/.test(body.email)) errors.push("email");
    if (p.nationality && !/^[A-Z]{3}$/.test(p.nationality)) errors.push("nationality");
    if (p.dialing_code && !/^\+\d{1,4}$/.test(p.dialing_code)) errors.push("dialing_code");
    if (p.mobile && !/^\d{4,11}$/.test(p.mobile)) errors.push("mobile");
    for (const k of ["first_name", "last_name"]) { if (typeof p[k] === "string" && (/[0-9_!¡?÷¿\/\\+=@#$%ˆ&*(){}|~<>;:\[\]]/.test(p[k]) || p[k].trim().length > 50)) errors.push(k); }
  }
  return errors;
}

// Vérifie que le produit demandé est bien un produit du catalogue (le client ne fixe pas le prix).
export function catalogProduct(body) {
  const catalog = loadCatalog();
  const prod = body && body.product;
  if (!prod) return null;
  return catalog.find((c) => c.id === prod.id && c.faceCents === prod.faceCents && c.priceCents === prod.priceCents) || null;
}

// Catalogue : copie serveur des produits de public/config.js (variable PRODUCTS_JSON pour le surcharger).
export function loadCatalog() {
  if (process.env.PRODUCTS_JSON) { try { return JSON.parse(process.env.PRODUCTS_JSON); } catch { /* ignoré */ } }
  return [
    { id: "avia-50", faceCents: 5000, priceCents: 4800 },
    { id: "avia-100", faceCents: 10000, priceCents: 9600 },
    { id: "avia-test-1", faceCents: 100, priceCents: 100 }
  ];
}

export function isSimulation() { return !middlewareConfig(process.env).enabled; }
// "simulated" (pas de middleware), "staging" (plateforme de test) ou "real" (production).
export function issuingMode() { const c = middlewareConfig(process.env); return !c.enabled ? "simulated" : c.environment === "staging" ? "staging" : "real"; }

// Résultat : { ok:true, mode, customerId, accountId, cardId, last4, redeemUrl, expiresIn, loadedCents, transactionId }
// ou { ok:false, code } avec code ∈ DUPLICATE | REFUSED | UPSTREAM | TIMEOUT | LOAD_PENDING | ERROR.
export async function issueCard({ orderId, person, email, faceCents, origin }) {
  const cfg = middlewareConfig(process.env);
  const clean = (v) => String(v || "").normalize("NFC").replace(/\s+/g, " ").trim();
  const who = { ...person, first_name: clean(person.first_name), last_name: clean(person.last_name), email: String(email).trim().toLowerCase() };
  const mode = cfg.environment === "staging" ? "staging" : "real";

  if (!cfg.enabled) {
    await new Promise((r) => setTimeout(r, 1500));
    const last4 = String(1000 + (parseInt(orderId.replace(/\D/g, "").slice(-4) || "0", 10) % 9000));
    const name = embossName(who.first_name, who.last_name);
    return {
      ok: true, mode: "simulated",
      customerId: "SIM-C-" + orderId.slice(0, 8), accountId: "SIM-A-" + orderId.slice(0, 8), cardId: "SIM-K-" + orderId.slice(0, 8),
      last4, redeemUrl: `${origin}/demo-carte.html?face=${faceCents / 100}&name=${encodeURIComponent(name)}&l4=${last4}`,
      expiresIn: 3600, loadedCents: faceCents, transactionId: null
    };
  }

  let created;
  try {
    created = await createCustomerAndCard(cfg, who, orderId);
  } catch (err) {
    const code = err instanceof MiddlewareError ? (["DUPLICATE", "TIMEOUT", "UPSTREAM"].includes(err.code) ? err.code : "REFUSED") : "ERROR";
    console.log(JSON.stringify({ step: "create", orderId, fail: code, status: err && err.status, body: err && err.body, msg: code === "ERROR" ? String(err && err.message) : undefined }));
    return { ok: false, code };
  }
  if (!created.accountId) {
    console.log(JSON.stringify({ step: "create", orderId, fail: "no-account-id", raw: created.raw }));
    return { ok: false, code: "REFUSED" };
  }

  let loaded;
  try {
    loaded = await creditAccount(cfg, created.accountId, faceCents, `Boutique ${orderId}`, loadUniqueId(orderId));
  } catch (err) {
    // Carte créée, chargement non confirmé : on n'insiste pas automatiquement (risque de double crédit).
    console.log(JSON.stringify({ step: "load", orderId, accountId: created.accountId, fail: err && err.code, status: err && err.status, body: err && err.body }));
    return { ok: false, code: "LOAD_PENDING", accountId: created.accountId, cardId: created.cardId };
  }

  return {
    ok: true, mode,
    customerId: created.customerId, accountId: created.accountId, cardId: created.cardId,
    last4: created.last4, redeemUrl: created.redeemUrl, expiresIn: created.expiresIn,
    loadedCents: faceCents, transactionId: loaded.transactionId
  };
}
