// GET /api/order-status?orderId=… — avancement d'une commande (pending, issuing, issued, failed).
// Ne renvoie que ce que la boutique affiche : statut, lien d'activation, derniers chiffres.
import { gateOk, json } from "./lib/http.mjs";
import { getOrder, publicView } from "./lib/orders.mjs";

export const config = { path: "/api/order-status" };

export default async (request) => {
  if (request.method !== "GET") return json(405, { ok: false });
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED" });
  const orderId = new URL(request.url).searchParams.get("orderId") || "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) return json(400, { ok: false, error: "orderId invalide." });
  const order = await getOrder(orderId);
  if (!order) return json(404, { ok: false, code: "UNKNOWN_ORDER" });
  return json(200, { ok: true, ...publicView(order) });
};
