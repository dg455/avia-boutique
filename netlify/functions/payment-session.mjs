// POST /api/payment-session — enregistre la commande et ouvre une session de paiement hébergée.
//
// Prestataire choisi par PAYMENT_PROVIDER :
//   - stripe     : Stripe Checkout, autorisation seule (capture après émission de la carte ; annulation si refus → zéro débit) ;
//   - paytently  : à brancher dès réception de la documentation marchand (même principe) ;
//   - simulated  : pas de session, la boutique utilise /api/issue-card.
//
// Les données du client sont enregistrées côté serveur (magasin « orders ») : seul l'identifiant de commande
// voyage dans la session de paiement et dans l'URL de retour.

import { gateOk, json } from "./lib/http.mjs";
import { verificationRequired, checkToken } from "./lib/verify.mjs";
import { validateOrder, catalogProduct } from "./lib/issue.mjs";
import { saveOrder } from "./lib/orders.mjs";
import { getStripe, paymentProvider } from "./lib/stripe.mjs";

export const config = { path: "/api/payment-session" };

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

  const provider = paymentProvider();
  const origin = new URL(request.url).origin;
  const orderId = body.orderId;
  const email = body.email.trim().toLowerCase();

  if (provider === "stripe") {
    const stripe = getStripe();
    const face = product.faceCents / 100;
    const cardName = process.env.SHOP_CARD_NAME || "Carte carburant AVIA";
    const sessionParams = {
        mode: "payment",
        locale: "fr",
        customer_email: email,
        client_reference_id: orderId,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: product.priceCents,
            product_data: { name: `${cardName} ${face} €`, description: `Carte virtuelle créditée de ${face} €, valable 12 mois` }
          }
        }],
        payment_intent_data: {
          capture_method: "manual",
          metadata: { orderId },
          statement_descriptor_suffix: (process.env.STRIPE_DESCRIPTOR_SUFFIX || "CARTE AVIA").slice(0, 22)
        },
        metadata: { orderId },
        success_url: `${origin}/#/creating?order=${orderId}`,
        cancel_url: `${origin}/#/review?cancel=1`,
        expires_at: Math.floor(Date.now() / 1000) + 45 * 60
    };
    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams);
    } catch (err) {
      const msg = String(err && err.message);
      if (/statement_descriptor/i.test(msg)) {
        // Le compte n'a pas de libellé de relevé configuré : on retente sans suffixe.
        try { delete sessionParams.payment_intent_data.statement_descriptor_suffix; session = await stripe.checkout.sessions.create(sessionParams); }
        catch (err2) { console.log(JSON.stringify({ step: "stripe-session", orderId, fail: String(err2 && err2.message) })); return json(502, { ok: false, code: "PAYMENT_UNAVAILABLE", error: "Le paiement n'est pas disponible pour le moment." }); }
      } else {
        console.log(JSON.stringify({ step: "stripe-session", orderId, fail: msg }));
        return json(502, { ok: false, code: "PAYMENT_UNAVAILABLE", error: "Le paiement n'est pas disponible pour le moment." });
      }
    }
    await saveOrder({ orderId, status: "pending", payment: "stripe", sessionId: session.id, product, email, person: body.person, origin, createdAt: new Date().toISOString() });
    return json(200, { ok: true, provider, redirectUrl: session.url });
  }

  if (provider === "paytently") {
    return json(501, { ok: false, code: "NOT_IMPLEMENTED", error: "Intégration du prestataire en attente de sa documentation." });
  }

  return json(400, { ok: false, code: "NO_HOSTED_PAYMENT", error: "Aucun paiement en ligne n'est activé sur cette boutique." });
};
