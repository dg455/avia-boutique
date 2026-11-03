// POST /api/issue-worker — fonction d'arrière-plan : émet la carte d'une commande au statut « issuing »,
// puis capture le paiement (Stripe) ou l'annule si l'émission a échoué (zéro débit).
// Protégée par un jeton interne, jamais appelée par le navigateur.

import { json } from "./lib/http.mjs";
import { getOrder, saveOrder } from "./lib/orders.mjs";
import { issueCard } from "./lib/issue.mjs";
import { getStripe, internalToken } from "./lib/stripe.mjs";

export const config = { path: "/api/issue-worker" };

export async function processOrder(orderId) {
  const order = await getOrder(orderId);
  if (!order) { console.log(JSON.stringify({ step: "worker", orderId, fail: "unknown-order" })); return null; }
  if (order.status !== "issuing") { console.log(JSON.stringify({ step: "worker", orderId, ignored: order.status })); return order; }
  // Verrou optimiste : un second déclenchement (webhook + retour client) trouve « processing » et s'arrête.
  order.status = "processing"; await saveOrder(order);

  const result = await issueCard({ orderId, person: order.person, email: order.email, faceCents: order.product.faceCents, origin: order.origin });
  order.mode = result.mode || order.mode || null;

  if (result.ok) {
    order.status = "issued"; order.code = null; order.result = result;
    if (order.payment === "stripe" && order.paymentIntentId) {
      const stripe = getStripe();
      try {
        if (result.mode !== "real") {
          // Émission simulée ou en staging : on ne capture jamais un paiement réel pour une carte qui n'est pas réelle.
          if (order.paymentStatus === "requires_capture") { await stripe.paymentIntents.cancel(order.paymentIntentId); order.cancelled = true; }
          else { await stripe.refunds.create({ payment_intent: order.paymentIntentId }); order.refunded = true; }
          order.captured = false; order.paymentReleased = true;
        } else {
          if (order.paymentStatus === "requires_capture") await stripe.paymentIntents.capture(order.paymentIntentId);
          order.captured = true;
        }
      } catch (err) {
        // Carte émise mais paiement non capturé : à capturer à la main depuis Stripe, la commande reste « issued ».
        order.captured = false; order.captureError = String(err && err.message);
        console.log(JSON.stringify({ step: "worker", orderId, fail: "capture", msg: order.captureError }));
      }
    }
  } else {
    order.status = "failed"; order.code = result.code; order.result = null;
    if (result.accountId) order.partial = { accountId: result.accountId, cardId: result.cardId }; // LOAD_PENDING : carte créée, chargement non confirmé
    if (order.payment === "stripe" && order.paymentIntentId) {
      const stripe = getStripe();
      try {
        if (result.code === "LOAD_PENDING") {
          // Ne rien annuler : le chargement a peut-être été comptabilisé. Vérification manuelle avant capture ou annulation.
          order.captured = null;
        } else if (order.paymentStatus === "requires_capture") {
          await stripe.paymentIntents.cancel(order.paymentIntentId); order.captured = false; order.cancelled = true;
        } else {
          await stripe.refunds.create({ payment_intent: order.paymentIntentId }); order.captured = false; order.refunded = true;
        }
      } catch (err) {
        order.captureError = String(err && err.message);
        console.log(JSON.stringify({ step: "worker", orderId, fail: "release-payment", msg: order.captureError }));
      }
    }
  }
  await saveOrder(order);
  console.log(JSON.stringify({ step: "worker", orderId, status: order.status, code: order.code, captured: order.captured }));
  return order;
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false });
  if ((request.headers.get("x-internal-token") || "") !== internalToken()) return json(401, { ok: false });
  let body; try { body = await request.json(); } catch { return json(400, { ok: false }); }
  if (!body || typeof body.orderId !== "string") return json(400, { ok: false });
  await processOrder(body.orderId);
  return json(200, { ok: true });
};
