// GET /c/REF — lien court remis au porteur par e-mail et SMS : renvoie vers la page de guidage de la boutique
// (onglets Android / iPhone) qui porte le lien d'activation. Le lien d'activation lui-même ne s'ouvre qu'une fois :
// cette page ne l'ouvre pas, elle le présente au bon endroit, sur le téléphone.
import { createHash } from "node:crypto";
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
  // Le porteur arrive depuis son e-mail, sans le code de la porte d'entrée : un lien de commande valide vaut
  // laissez-passer, on pose le cookie de la porte (même valeur que gate.ts) avant de l'envoyer sur la page de guidage.
  const headers = new Headers({ location: guidedLink(origin, order.result.redeemUrl, order.orderId), "cache-control": "no-store" });
  const gateCode = process.env.SHOP_ACCESS_CODE || "Avia2026";
  if (gateCode !== "open") {
    const expected = createHash("sha256").update("shop-gate|" + gateCode).digest("hex");
    headers.append("set-cookie", `shop_gate=${expected}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
};
