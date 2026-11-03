// GET /api/health — état de la configuration, sans aucun secret.
import { middlewareConfig } from "./lib/middleware.mjs";
import { issuingMode } from "./lib/issue.mjs";
import { paymentProvider } from "./lib/stripe.mjs";
import { deliveryConfig } from "./lib/notify.mjs";

export const config = { path: "/api/health" };

export default async () => {
  const cfg = middlewareConfig(process.env);
  const body = {
    ok: true,
    issuing: issuingMode(),
    middlewareHost: cfg.enabled ? new URL(cfg.base).host : null,
    outboundProxy: !!cfg.proxyUrl,
    payment: paymentProvider(),
    simulatedPaymentAllowed: process.env.ALLOW_SIMULATED_PAYMENT === "true",
    delivery: (() => { const d = deliveryConfig(process.env); return { email: d.email && !!d.from, sms: d.sms }; })(),
    gate: (process.env.SHOP_ACCESS_CODE || "Avia2026") === "open" ? "open" : "code"
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};
