// POST /api/trace — trace d'étape du parcours (audience). Sans cookie, sans donnée personnelle en clair :
// identifiant de session volatil (sessionStorage), écran atteint, appareil, pays/ville fournis par Netlify, heure,
// e-mail masqué (j***n@…) une fois saisi, référence de commande une fois connue.
// Ne bloque jamais le parcours : la boutique l'envoie en « beacon » et n'attend pas la réponse.
//
// Les écrans qui touchent au lien d'activation (wallet-step1, wallet-open, link-open, desktop-mode) sont aussi
// reportés sur un enregistrement « act:REF » par commande : c'est ce qui permet au back-office de dire si une carte
// payée a été ouverte, vers quel portefeuille, et si Chrome était en mode « Version ordinateur » (Wallet ne se lance pas).
import { gateOk, json } from "./lib/http.mjs";
import { setRecord, getRecord } from "./lib/orders.mjs";
import { shortCode } from "./lib/notify.mjs";

export const config = { path: "/api/trace" };

const SCREENS = new Set(["home", "email", "code", "known", "details", "review", "pay", "stripe", "creating", "ready", "carte", "error", "business", "business-done", "wallet-step1", "wallet-open", "link-open", "desktop-mode"]);
// Écran → champ de l'enregistrement d'activation (horodatage de la première fois).
const ACTIVATION = { "wallet-step1": "prep", "wallet-open": "wallet", "link-open": "link", "desktop-mode": "desktop" };
const MASKED_EMAIL = /^[^\s@*]\*{3}[^\s@*]?@[^\s@*]{3,64}$/;

function deviceOf(ua) {
  if (/iphone|ipod/i.test(ua)) return "iphone";
  if (/ipad|macintosh.*mobile/i.test(ua)) return "ipad";
  if (/android/i.test(ua)) return /mobile/i.test(ua) ? "android" : "android-tablet";
  if (/windows|macintosh|linux|cros/i.test(ua)) return "ordinateur";
  return "autre";
}

export default async (request, context) => {
  if (request.method !== "POST") return json(405, { ok: false });
  if (!gateOk(request, process.env)) return json(401, { ok: false });
  let body = {}; try { body = await request.json(); } catch { body = {}; }
  const sid = String(body.sid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const screen = String(body.screen || "");
  if (sid.length < 8 || !SCREENS.has(screen)) return json(400, { ok: false });
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const geo = (context && context.geo) || {};
  const ua = request.headers.get("user-agent") || "";
  const em = String(body.em || "").slice(0, 80);
  const rec = {
    t: now.toISOString(), sid, screen,
    device: deviceOf(ua),
    country: geo.country && geo.country.code || null, city: geo.city || null,
    lang: ((request.headers.get("accept-language") || "").split(",")[0].trim().slice(0, 8).replace(/^\*$/, "")) || null,
    ref: String(body.ref || "").slice(0, 120) || null,
    // Identifiant de commande complet (même session) ou référence courte REF (arrivée par le lien e-mail) : les deux se ramènent à REF.
    orderId: /^[A-Za-z0-9-]{8,64}$/.test(String(body.orderId || "")) ? body.orderId : null,
    em: MASKED_EMAIL.test(em) ? em : null,
    code: String(body.code || "").slice(0, 32) || null,
    host: new URL(request.url).host
  };
  try { await setRecord(`trace:${day}:${now.getTime()}:${sid.slice(0, 8)}`, rec); } catch (err) { console.log(JSON.stringify({ step: "trace", fail: String(err && err.message) })); }
  const field = ACTIVATION[screen];
  if (field && rec.orderId) {
    try {
      const key = "act:" + shortCode(rec.orderId);
      const a = (await getRecord(key)) || { ref: shortCode(rec.orderId), opens: 0 };
      if (!a[field]) a[field] = rec.t;
      if (field === "wallet" || field === "link") a.opens = (a.opens || 0) + 1;
      a.last = rec.t; a.device = rec.device; a.sid = sid;
      await setRecord(key, a);
    } catch (err) { console.log(JSON.stringify({ step: "trace", fail: "activation", msg: String(err && err.message) })); }
  }
  console.log(JSON.stringify({ step: "trace", ...rec }));
  return json(202, { ok: true });
};
