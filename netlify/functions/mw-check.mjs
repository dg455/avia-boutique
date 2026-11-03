// GET /api/mw-check — vérifie le raccordement au middleware (relais, liste blanche d'IP, authentification)
// sans rien créer : un POST /customers vide doit être refusé en 400 (validation). Réservé à la porte d'entrée.
import { gateOk, json } from "./lib/http.mjs";
import { middlewareConfig, probe } from "./lib/middleware.mjs";

export const config = { path: "/api/mw-check" };

export default async (request) => {
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED" });
  const cfg = middlewareConfig(process.env);
  const r = await probe(cfg);
  return json(200, { ...r, host: cfg.enabled ? new URL(cfg.base).host : null, environment: cfg.environment, outboundProxy: !!cfg.proxyUrl });
};
