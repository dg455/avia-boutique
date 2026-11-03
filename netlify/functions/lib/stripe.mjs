// Client Stripe (période bêta : compte Stripe de l'opérateur de la boutique).
// Variables : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_DESCRIPTOR_SUFFIX (défaut "CARTE AVIA"),
//             STRIPE_API_BASE (tests locaux uniquement, ex. http://127.0.0.1:4242).
import Stripe from "stripe";
import { createHash } from "node:crypto";

let client = null;
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (client) return client;
  const opts = { maxNetworkRetries: 1, timeout: 20000 };
  if (process.env.STRIPE_API_BASE) {
    const u = new URL(process.env.STRIPE_API_BASE);
    opts.host = u.hostname; opts.port = Number(u.port || (u.protocol === "https:" ? 443 : 80)); opts.protocol = u.protocol.replace(":", "");
  }
  client = new Stripe(key, opts);
  return client;
}

export function paymentProvider() {
  const p = process.env.PAYMENT_PROVIDER || "simulated";
  if (p === "stripe" && !process.env.STRIPE_SECRET_KEY) return "simulated";
  return p;
}

// Jeton interne pour déclencher la fonction d'arrière-plan sans passer par la porte d'entrée.
export function internalToken() {
  if (process.env.INTERNAL_TOKEN) return process.env.INTERNAL_TOKEN;
  return createHash("sha256").update("internal|" + (process.env.SHOP_ACCESS_CODE || "Avia2026")).digest("hex");
}
