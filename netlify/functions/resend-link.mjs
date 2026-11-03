// POST /api/resend-link { orderId } — renvoie l'e-mail « votre carte est prête » à l'adresse de la commande.
// Jamais vers une autre adresse (l'adresse vient de la commande, pas de la requête) ; au plus 3 renvois par commande,
// espacés d'une minute. Sert au client qui n'a pas reçu l'e-mail, et au support.
import { gateOk, json, brandInfo } from "./lib/http.mjs";
import { getOrder, saveOrder, saveShortCode } from "./lib/orders.mjs";
import { deliveryConfig, sendCardLink, shortCode } from "./lib/notify.mjs";

export const config = { path: "/api/resend-link" };

const MAX_RESENDS = 3, MIN_GAP_MS = 60000;

function maskEmail(e) {
  const [u, d] = String(e).split("@");
  return (u.length > 2 ? u[0] + "***" + u[u.length - 1] : u[0] + "***") + "@" + (d || "");
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false });
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED" });
  let body = {}; try { body = await request.json(); } catch { body = {}; }
  const orderId = String(body.orderId || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) return json(400, { ok: false, error: "orderId invalide." });
  if (!deliveryConfig(process.env).email) return json(409, { ok: false, code: "EMAIL_OFF", error: "L'envoi d'e-mail n'est pas activé." });

  const order = await getOrder(orderId);
  if (!order) return json(404, { ok: false, code: "UNKNOWN_ORDER" });
  if (order.status !== "issued" || !order.result || !order.result.redeemUrl) return json(409, { ok: false, code: "NOT_ISSUED", error: "La carte n'est pas encore émise." });
  if (!order.email) return json(409, { ok: false, code: "NO_EMAIL", error: "Aucune adresse e-mail sur cette commande." });

  const r = order.resend || { count: 0, last: 0 };
  if (r.count >= MAX_RESENDS) return json(429, { ok: false, code: "TOO_MANY", error: "Trois renvois déjà effectués : appelez le service client." });
  if (Date.now() - r.last < MIN_GAP_MS) return json(429, { ok: false, code: "TOO_SOON", error: "Patientez une minute avant de renvoyer." });

  await saveShortCode(shortCode(order.orderId), order.orderId); // commandes émises avant l'arrivée des liens courts
  const out = await sendCardLink({ env: process.env, order, brand: brandInfo(process.env) }); // SMS seulement si DELIVERY_SMS=true
  order.resend = { count: r.count + 1, last: Date.now() };
  order.delivery = out;
  await saveOrder(order);
  const ok = !!(out.email && out.email.ok);
  if (!ok) return json(502, { ok: false, code: "SEND_FAILED", error: "L'e-mail n'a pas pu partir. Réessayez dans une minute ou appelez le service client." });
  return json(200, { ok: true, email: maskEmail(order.email), remaining: MAX_RESENDS - order.resend.count });
};
