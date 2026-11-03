// GET /api/mail-check — envoie un e-mail de test depuis la boîte SMTP de la boutique, pour vérifier le raccordement
// (identifiants, port, expéditeur) sans émettre de carte ni rien payer. Réservé à la porte d'entrée (cookie)
// ou au code d'accès passé en ?code=. Destinataire : ?to= (domaine soshop.club seulement), défaut damien@soshop.club.
import { gateOk, json } from "./lib/http.mjs";
import { sendTestMail } from "./lib/notify.mjs";

export const config = { path: "/api/mail-check" };

export default async (request) => {
  const url = new URL(request.url);
  const code = process.env.SHOP_ACCESS_CODE || "Avia2026";
  const byCode = code !== "open" && url.searchParams.get("code") === code;
  if (!gateOk(request, process.env) && !byCode) return json(401, { ok: false, code: "UNAUTHORIZED" });
  const to = (url.searchParams.get("to") || "damien@soshop.club").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@soshop\.club$/.test(to)) return json(400, { ok: false, code: "RECIPIENT_NOT_ALLOWED", hint: "domaine soshop.club seulement" });
  const r = await sendTestMail({ env: process.env, to });
  return json(r.ok ? 200 : 502, r);
};
