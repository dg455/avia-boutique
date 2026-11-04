// POST /api/issue-card — commande avec paiement SIMULÉ (démonstration ou tests de production).
// Enregistre la commande au statut « issuing » et confie l'émission à la fonction d'arrière-plan ;
// la boutique suit l'avancement sur /api/order-status. Le paiement réel passe par /api/payment-session.
//
// Garde-fous :
//   - cookie de la porte d'entrée exigé ;
//   - en mode réel (MW_BASE_URL renseignée), refusé sauf ALLOW_SIMULATED_PAYMENT=true ;
//   - le produit doit exister au catalogue serveur (le client ne fixe pas le prix).

import { gateOk, json } from "./lib/http.mjs";
import { verificationRequired, checkToken } from "./lib/verify.mjs";
import { validateOrder, catalogProduct, issuingMode } from "./lib/issue.mjs";
import { getOrder, saveOrder } from "./lib/orders.mjs";
import { internalToken } from "./lib/stripe.mjs";

export const config = { path: "/api/issue-card" };

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false, error: "Méthode non autorisée." });
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Code d'accès requis." });

  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: "Corps de requête invalide." }); }
  const errors = validateOrder(body);
  if (errors.length) return json(400, { ok: false, code: "INVALID", error: "Informations incomplètes : " + errors.join(", ") });
  const product = catalogProduct(body);
  if (!product) return json(400, { ok: false, code: "INVALID", error: "Produit inconnu." });
  if (verificationRequired(process.env) && !checkToken(body.emailToken, body.email)) {
    return json(403, { ok: false, code: "EMAIL_UNVERIFIED", error: "Adresse e-mail non vérifiée." });
  }

  if (issuingMode() === "real" && process.env.ALLOW_SIMULATED_PAYMENT !== "true") {
    return json(402, { ok: false, code: "PAYMENT_REQUIRED", error: "Le paiement n'a pas été confirmé." });
  }

  const orderId = body.orderId;
  const existing = await getOrder(orderId);
  if (existing && existing.status !== "failed") return json(200, { ok: true, orderId, status: existing.status }); // rejeu : idempotent

  const origin = new URL(request.url).origin;
  await saveOrder({ orderId, status: "issuing", payment: "simulated", product, email: body.email.trim().toLowerCase(), person: body.person, origin, createdAt: new Date().toISOString() });
  try {
    const r = await fetch(`${origin}/api/issue-worker`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": internalToken() }, body: JSON.stringify({ orderId }) });
    if (r.status >= 400) throw new Error("worker " + r.status);
  } catch (err) {
    console.log(JSON.stringify({ step: "issue-card", orderId, fail: "worker-trigger", msg: String(err && err.message) }));
    return json(502, { ok: false, code: "ERROR", error: "L'émission n'a pas pu démarrer." });
  }
  return json(202, { ok: true, orderId, status: "issuing" });
};
