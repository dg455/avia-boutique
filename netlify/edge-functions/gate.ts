// Porte d'entrée de la boutique (staging) : tout le site est derrière un code d'accès,
// servi par une page à nos couleurs (/gate.html), jamais par la page de mot de passe de Netlify.
//
// - SHOP_ACCESS_CODE (variable d'environnement Netlify) : le code. À défaut, "Avia2026".
// - Un cookie signé (hash SHA-256 du code) est posé pour 30 jours après un code correct.
// - Les appels /api/* sans cookie reçoivent un 401 JSON au lieu d'une redirection.
//
// Pour ouvrir la boutique au public : mettre SHOP_ACCESS_CODE à "open" (ou retirer cette edge function du déploiement).

import type { Context } from "https://edge.netlify.com";

const OPEN_PATHS = new Set(["/gate", "/gate.html", "/styles.css", "/config.js", "/favicon.ico", "/robots.txt"]);
const OPEN_PREFIXES = ["/assets/", "/.netlify/"];

async function token(code: string): Promise<string> {
  const data = new TextEncoder().encode("shop-gate|" + code);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const path = url.pathname;
  const code = Netlify.env.get("SHOP_ACCESS_CODE") || "Avia2026";

  if (code === "open") return context.next();

  const expected = await token(code);

  // Soumission du code.
  if (request.method === "POST" && path === "/gate") {
    const form = await request.formData();
    const given = String(form.get("code") || "").trim();
    const nextRaw = String(form.get("next") || "/");
    const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
    if (given === code) {
      const headers = new Headers({ Location: url.origin + next });
      headers.append("Set-Cookie", `shop_gate=${expected}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
      return new Response(null, { status: 303, headers });
    }
    return Response.redirect(`${url.origin}/gate?err=1&next=${encodeURIComponent(next)}`, 303);
  }

  // Ressources toujours accessibles (la page d'entrée et ce dont elle a besoin).
  if (OPEN_PATHS.has(path) || OPEN_PREFIXES.some((p) => path.startsWith(p))) {
    if (path === "/gate") return context.rewrite("/gate.html");
    return context.next();
  }

  const cookie = context.cookies.get("shop_gate");
  if (cookie === expected) return context.next();

  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", error: "Code d'accès requis." }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  return Response.redirect(`${url.origin}/gate?next=${encodeURIComponent(path + url.search)}`, 302);
};

export const config = { path: "/*" };
