// GET /api/order-status?orderId=… — avancement d'une commande (pending, issuing, processing, issued, failed).
// Ne renvoie que ce que la boutique affiche : statut, lien d'activation, derniers chiffres.
//
// Filet de sécurité Stripe : si la commande est encore « pending » alors que le client est revenu de la caisse,
// la session de paiement est vérifiée directement auprès de Stripe et, si elle est payée, l'émission démarre —
// le webhook n'est donc pas indispensable (il reste recommandé : il couvre le client qui ferme son navigateur).
import { gateOk, json } from "./lib/http.mjs";
import { getOrder, saveOrder, publicView } from "./lib/orders.mjs";
import { getStripe, internalToken } from "./lib/stripe.mjs";

export const config = { path: "/api/order-status" };

async function verifyStripeOnReturn(order, origin) {
  const stripe = getStripe();
  if (!stripe || !order.sessionId) return order;
  let session;
  try { session = await stripe.checkout.sessions.retrieve(order.sessionId, { expand: ["payment_intent"] }); }
  catch (err) { console.log(JSON.stringify({ step: "status-verify", orderId: order.orderId, fail: String(err && err.message) })); return order; }
  const pi = session.payment_intent && typeof session.payment_intent === "object" ? session.payment_intent : null;
  if (session.status === "expired") { order.status = "failed"; order.code = "PAYMENT_FAILED"; await saveOrder(order); return order; }
  if (session.status !== "complete" || !pi || !["requires_capture", "succeeded"].includes(pi.status)) return order; // pas encore payé
  if (pi.amount !== order.product.priceCents) { order.status = "failed"; order.code = "AMOUNT_MISMATCH"; await saveOrder(order); return order; }
  // Relecture : le webhook a pu passer entre-temps.
  const fresh = await getOrder(order.orderId);
  if (!fresh || fresh.status !== "pending") return fresh || order;
  fresh.status = "issuing"; fresh.paymentIntentId = pi.id; fresh.paymentStatus = pi.status; fresh.verifiedOnReturn = true;
  await saveOrder(fresh);
  try {
    await fetch(`${fresh.origin || origin}/api/issue-worker`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": internalToken() }, body: JSON.stringify({ orderId: fresh.orderId }) });
  } catch (err) { console.log(JSON.stringify({ step: "status-verify", orderId: fresh.orderId, fail: "worker-trigger", msg: String(err && err.message) })); }
  return fresh;
}

export default async (request) => {
  if (request.method !== "GET") return json(405, { ok: false });
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED" });
  const orderId = new URL(request.url).searchParams.get("orderId") || "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) return json(400, { ok: false, error: "orderId invalide." });
  let order = await getOrder(orderId);
  if (!order) return json(404, { ok: false, code: "UNKNOWN_ORDER" });
  if (order.status === "pending" && order.payment === "stripe") order = await verifyStripeOnReturn(order, new URL(request.url).origin);
  return json(200, { ok: true, ...publicView(order) });
};
