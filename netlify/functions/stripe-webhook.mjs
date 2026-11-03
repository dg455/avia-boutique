// POST /api/stripe-webhook — notification Stripe après le passage en caisse.
// Vérifie la signature, s'assure que le paiement est autorisé, puis confie l'émission à la fonction d'arrière-plan
// (le middleware peut mettre plusieurs dizaines de secondes à répondre ; Stripe attend une réponse rapide).
//
// Événements : checkout.session.completed, checkout.session.async_payment_succeeded (émission),
//              checkout.session.expired, checkout.session.async_payment_failed (commande close, rien débité).

import { json } from "./lib/http.mjs";
import { getOrder, saveOrder } from "./lib/orders.mjs";
import { getStripe, internalToken } from "./lib/stripe.mjs";

export const config = { path: "/api/stripe-webhook" };

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false });
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return json(503, { ok: false, error: "Stripe non configuré." });

  const raw = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, request.headers.get("stripe-signature") || "", secret);
  } catch (err) {
    console.log(JSON.stringify({ step: "stripe-webhook", fail: "signature", msg: String(err && err.message) }));
    return json(400, { ok: false, error: "Signature invalide." });
  }

  const session = event.data && event.data.object;
  const orderId = session && (session.client_reference_id || (session.metadata && session.metadata.orderId));
  if (!orderId) return json(200, { ok: true, ignored: "no-order" });
  const order = await getOrder(orderId);
  if (!order) { console.log(JSON.stringify({ step: "stripe-webhook", orderId, fail: "unknown-order", type: event.type })); return json(200, { ok: true, ignored: "unknown-order" }); }

  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    if (order.status === "pending") { order.status = "failed"; order.code = "PAYMENT_FAILED"; await saveOrder(order); }
    return json(200, { ok: true });
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return json(200, { ok: true, ignored: event.type });
  }
  if (order.status !== "pending") return json(200, { ok: true, ignored: "already-" + order.status }); // relivraison Stripe : idempotent

  const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
  if (!["requires_capture", "succeeded"].includes(pi.status)) {
    console.log(JSON.stringify({ step: "stripe-webhook", orderId, fail: "pi-status", status: pi.status }));
    return json(200, { ok: true, ignored: "pi-" + pi.status });
  }
  if (pi.amount !== order.product.priceCents) {
    console.log(JSON.stringify({ step: "stripe-webhook", orderId, fail: "amount-mismatch", paid: pi.amount, expected: order.product.priceCents }));
    order.status = "failed"; order.code = "AMOUNT_MISMATCH"; await saveOrder(order);
    return json(200, { ok: true });
  }

  order.status = "issuing"; order.paymentIntentId = pi.id; order.paymentStatus = pi.status; await saveOrder(order);

  // Déclenche l'émission en arrière-plan ; la boutique suit l'avancement sur /api/order-status.
  const origin = order.origin || new URL(request.url).origin;
  try {
    const r = await fetch(`${origin}/api/issue-worker`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": internalToken() }, body: JSON.stringify({ orderId }) });
    console.log(JSON.stringify({ step: "stripe-webhook", orderId, worker: r.status }));
  } catch (err) {
    console.log(JSON.stringify({ step: "stripe-webhook", orderId, fail: "worker-trigger", msg: String(err && err.message) }));
  }
  return json(200, { ok: true });
};
