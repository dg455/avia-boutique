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
