// Petits utilitaires partagés par les fonctions.
import { createHash } from "node:crypto";

export const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

// Même règle que l'edge function : cookie shop_gate = SHA-256("shop-gate|" + code).
export function gateOk(request, env) {
  const code = env.SHOP_ACCESS_CODE || "Avia2026";
  if (code === "open") return true;
  const expected = createHash("sha256").update("shop-gate|" + code).digest("hex");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)shop_gate=([a-f0-9]{64})/);
  return !!m && m[1] === expected;
}

// Espace admin (audience) : cookie shop_admin = SHA-256("shop-gate|admin|" + ADMIN_CODE). Même règle que gate.ts.
export function adminOk(request, env) {
  const code = env.SHOP_ACCESS_CODE || "Avia2026";
  const adminCode = env.ADMIN_CODE || (code === "open" ? "" : code);
  if (!adminCode) return false;
  const expected = createHash("sha256").update("shop-gate|admin|" + adminCode).digest("hex");
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)shop_admin=([a-f0-9]{64})/);
  return !!m && m[1] === expected;
}

// Marque telle que les messages au porteur la nomment (mêmes valeurs par défaut que public/config.js).
export function brandInfo(env) {
  return {
    name: env.BRAND_NAME || "AVIA",
    cardName: env.BRAND_CARD_NAME || "Carte carburant AVIA",
    operator: env.BRAND_OPERATOR || "SoShop.Club",
    supportPhone: env.SUPPORT_PHONE || "0 811 880 200"
  };
}
