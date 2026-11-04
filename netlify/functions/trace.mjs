// POST /api/trace — trace d'étape du parcours (audience). Sans cookie, sans donnée personnelle :
// identifiant de session volatil (sessionStorage), écran atteint, appareil, pays/ville fournis par Netlify, heure.
// Ne bloque jamais le parcours : la boutique l'envoie en « beacon » et n'attend pas la réponse.
import { gateOk, json } from "./lib/http.mjs";
import { setRecord } from "./lib/orders.mjs";

export const config = { path: "/api/trace" };

const SCREENS = new Set(["home", "email", "code", "known", "details", "review", "pay", "stripe", "creating", "ready", "carte", "error", "business", "business-done", "wallet-step1", "wallet-open", "desktop-mode"]);

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
  const rec = {
    t: now.toISOString(), sid, screen,
    device: deviceOf(ua),
    country: geo.country && geo.country.code || null, city: geo.city || null,
    lang: (request.headers.get("accept-language") || "").split(",")[0].slice(0, 8) || null,
    ref: String(body.ref || "").slice(0, 120) || null,
    orderId: /^[A-Za-z0-9-]{8,64}$/.test(String(body.orderId || "")) ? body.orderId : null,
    code: String(body.code || "").slice(0, 32) || null,
    host: new URL(request.url).host
  };
  try { await setRecord(`trace:${day}:${now.getTime()}:${sid.slice(0, 8)}`, rec); } catch (err) { console.log(JSON.stringify({ step: "trace", fail: String(err && err.message) })); }
  console.log(JSON.stringify({ step: "trace", ...rec }));
  return json(202, { ok: true });
};
