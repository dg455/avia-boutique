// POST /api/email-code/send   { email }        → envoie un code à 6 chiffres à l'adresse
// POST /api/email-code/verify { email, code }  → vérifie le code, renvoie un jeton à joindre à la commande
// Voir lib/verify.mjs. Si l'envoi d'e-mail n'est pas configuré, la vérification n'est pas exigée (required:false).
import { gateOk, json, brandInfo } from "./lib/http.mjs";
import { verificationRequired, normalizeEmail, isEmail, sendCode, verifyCode } from "./lib/verify.mjs";

export const config = { path: ["/api/email-code/send", "/api/email-code/verify"] };

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false });
  if (!gateOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Code d'accès requis." });
  let body = {}; try { body = await request.json(); } catch { body = {}; }
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) return json(400, { ok: false, code: "INVALID", error: "Adresse e-mail invalide." });
  if (!verificationRequired(process.env)) return json(200, { ok: true, required: false });

  const action = new URL(request.url).pathname.endsWith("/verify") ? "verify" : "send";
  if (action === "send") {
    const r = await sendCode({ env: process.env, email, brand: brandInfo(process.env) });
    console.log(JSON.stringify({ step: "email-code", action, email, ok: r.ok, code: r.code || null }));
    if (!r.ok) {
      const msg = r.code === "TOO_SOON" ? `Un code vient d'être envoyé : patientez ${r.retryIn} s.` : r.code === "TOO_MANY" ? "Trop d'envois pour cette adresse : réessayez dans une heure ou appelez le service client." : "L'e-mail n'a pas pu partir. Réessayez dans une minute.";
      return json(r.code === "SEND_FAILED" ? 502 : 429, { ok: false, code: r.code, error: msg, retryIn: r.retryIn });
    }
    return json(200, { ok: true, required: true, expiresIn: r.expiresIn, devCode: r.devCode });
  }
  const r = await verifyCode({ email, code: body.code });
  console.log(JSON.stringify({ step: "email-code", action, email, ok: r.ok, code: r.code || null }));
  if (!r.ok) {
    const msg = { NO_CODE: "Aucun code en cours pour cette adresse : demandez-en un nouveau.", EXPIRED: "Ce code a expiré : demandez-en un nouveau.", TOO_MANY_ATTEMPTS: "Trop d'essais : demandez un nouveau code.", WRONG: "Code incorrect." }[r.code] || "Code refusé.";
    return json(r.code === "WRONG" ? 400 : 409, { ok: false, code: r.code, error: msg, remaining: r.remaining });
  }
  return json(200, { ok: true, token: r.token });
};
