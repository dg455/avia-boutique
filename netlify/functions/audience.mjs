// GET /api/audience?from=AAAA-MM-JJ&to=AAAA-MM-JJ — audience de la boutique sur une période (défaut : 7 derniers jours).
// Derrière la porte d'entrée. Agrège les traces d'étape (/api/trace) et les commandes : sessions, entonnoir, appareils,
// pays/villes, heures, commandes (statut, produit, e-mail masqué). Aucune adresse IP n'est conservée ni renvoyée.
import { adminOk, json } from "./lib/http.mjs";
import { listRecords } from "./lib/orders.mjs";

export const config = { path: "/api/audience" };

// Ordre de l'entonnoir : un visiteur « atteint » une étape s'il l'a vue au moins une fois.
const FUNNEL = [
  ["home", "Accueil"], ["email", "E-mail saisi"], ["code", "Code de vérification"], ["details", "Coordonnées"],
  ["review", "Récapitulatif"], ["stripe", "Départ vers le paiement"], ["creating", "Retour du paiement"], ["ready", "Carte prête"]
];

const mask = (e) => { if (!e) return null; const [u, d] = String(e).split("@"); return (u.length > 2 ? u[0] + "***" + u[u.length - 1] : u[0] + "***") + "@" + (d || ""); };
const day = (d) => d.toISOString().slice(0, 10);
const count = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (k == null) continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })); };

export default async (request) => {
  if (request.method !== "GET") return json(405, { ok: false });
  if (!adminOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Code admin requis." });
  const q = new URL(request.url).searchParams;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get("to") || "") ? q.get("to") : day(new Date());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") || "") ? q.get("from") : day(new Date(Date.parse(to) - 6 * 86400000));
  if (from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) return json(400, { ok: false, error: "Période invalide (92 jours max)." });

  // Traces de la période (une liste par jour, clés trace:AAAA-MM-JJ:…)
  const traces = [];
  for (let d = new Date(from + "T00:00:00Z"); day(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    for (const r of await listRecords(`trace:${day(d)}:`)) traces.push(r.value);
  }
  traces.sort((a, b) => a.t.localeCompare(b.t));
  const sessions = new Map();
  for (const t of traces) {
    const s = sessions.get(t.sid) || { sid: t.sid, first: t.t, last: t.t, screens: new Set(), device: t.device, country: t.country, city: t.city, lang: t.lang, ref: t.ref, orderId: null, host: t.host };
    s.last = t.t; s.screens.add(t.screen); if (t.orderId) s.orderId = t.orderId; if (t.ref && !s.ref) s.ref = t.ref;
    sessions.set(t.sid, s);
  }
  const S = [...sessions.values()];
  const reached = (k) => S.filter((s) => s.screens.has(k)).length;
  const funnel = FUNNEL.map(([k, label], i) => {
    const n = reached(k); const prev = i ? reached(FUNNEL[i - 1][0]) : n;
    return { step: k, label, sessions: n, pctOfPrevious: prev ? Math.round(100 * n / prev) : null, pctOfAll: S.length ? Math.round(100 * n / S.length) : null };
  });
  const lastScreen = (s) => { let best = -1; for (const [k] of FUNNEL) { const i = FUNNEL.findIndex((f) => f[0] === k); if (s.screens.has(k) && i > best) best = i; } return best >= 0 ? FUNNEL[best][1] : [...s.screens][0]; };

  // Commandes de la période (clés sans « : » = identifiants de commande)
  const orders = (await listRecords("")).filter((r) => !r.key.includes(":")).map((r) => r.value)
    .filter((o) => o.createdAt && o.createdAt.slice(0, 10) >= from && o.createdAt.slice(0, 10) <= to)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => ({ orderId: o.orderId, at: o.createdAt, status: o.status, code: o.code || null, mode: o.mode || null, payment: o.payment || null,
      product: o.product ? `${o.product.faceCents / 100} €` : null, email: mask(o.email), last4: o.result && o.result.last4 || null,
      delivered: o.delivery && o.delivery.email ? !!o.delivery.email.ok : null, captured: o.captured ?? null }));

  return json(200, {
    ok: true, from, to,
    sessions: S.length, visitorsWithEmail: reached("email"), visitorsWithOrder: S.filter((s) => s.orderId).length,
    funnel,
    dropOff: count(S.filter((s) => !s.screens.has("ready")), lastScreen),
    devices: count(S, (s) => s.device), countries: count(S, (s) => s.country), cities: count(S, (s) => s.city && s.country ? `${s.city} (${s.country})` : null),
    languages: count(S, (s) => s.lang), referrers: count(S, (s) => s.ref), hosts: count(S, (s) => s.host),
    hours: count(traces.filter((t) => t.screen === "home"), (t) => new Date(t.t).toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit" }) + " h"),
    days: count(S, (s) => s.first.slice(0, 10)).sort((a, b) => a.k.localeCompare(b.k)),
    errors: count(traces.filter((t) => t.screen === "error"), (t) => t.code || "inconnue"),
    orders: { total: orders.length, byStatus: count(orders, (o) => o.status), list: orders.slice(0, 200) },
    sessionsList: S.sort((a, b) => b.first.localeCompare(a.first)).slice(0, 300).map((s) => ({ first: s.first, last: s.last, device: s.device, city: s.city, country: s.country, lastScreen: lastScreen(s), screens: [...s.screens], orderId: s.orderId }))
  });
};
