// GET /api/health — état de la configuration, sans aucun secret.
import { middlewareConfig } from "./lib/middleware.mjs";

export const config = { path: "/api/health" };

export default async () => {
  const cfg = middlewareConfig(process.env);
  const body = {
    ok: true,
    issuing: cfg.enabled ? "real" : "simulated",
    middlewareHost: cfg.enabled ? new URL(cfg.base).host : null,
    outboundProxy: !!cfg.proxyUrl,
    payment: process.env.PAYMENT_PROVIDER || "simulated",
    simulatedPaymentAllowed: process.env.ALLOW_SIMULATED_PAYMENT === "true",
    gate: (process.env.SHOP_ACCESS_CODE || "Avia2026") === "open" ? "open" : "code"
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};
