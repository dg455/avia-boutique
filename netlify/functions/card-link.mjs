// GET /c/REF — lien court remis au porteur par e-mail et SMS : renvoie vers la page de guidage de la boutique
// (onglets Android / iPhone) qui porte le lien d'activation. Le lien d'activation lui-même ne s'ouvre qu'une fois :
// cette page ne l'ouvre pas, elle le présente au bon endroit, sur le téléphone.
import { getOrderByCode } from "./lib/orders.mjs";
import { guidedLink } from "./lib/notify.mjs";

export const config = { path: "/c/:code" };

export default async (request, context) => {
  const code = (context && context.params && context.params.code) || new URL(request.url).pathname.split("/").pop();
  const order = await getOrderByCode(code);
  const origin = new URL(request.url).origin;
  if (!order || order.status !== "issued" || !order.result || !order.result.redeemUrl) {
    return new Response("Lien inconnu ou expiré. Service client : voir le site de la boutique.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(null, { status: 302, headers: { location: guidedLink(origin, order.result.redeemUrl), "cache-control": "no-store" } });
};
