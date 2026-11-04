// Vérification de l'adresse e-mail avant paiement : un code à 6 chiffres envoyé à l'adresse, recopié dans la boutique.
// Pourquoi : une faute de frappe dans l'e-mail produirait une carte payée que personne ne reçoit (constaté le 3 novembre 2026),
// et l'adresse part aussi chez l'émetteur comme adresse du client.
//
// - Active dès que l'envoi d'e-mail l'est (SMTP configuré) ; EMAIL_VERIFICATION=false pour la couper.
// - Code valable 10 minutes, 5 essais ; 1 envoi par minute et 5 par heure pour une même adresse.
// - Une adresse vérifiée donne un jeton signé (HMAC, 24 h) que la boutique joint à la commande ; le serveur l'exige
//   dans /api/payment-session et /api/issue-card pour l'adresse de la commande.
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getRecord, setRecord, deleteRecord } from "./orders.mjs";
import { deliveryConfig, sendCodeMail } from "./notify.mjs";
import { internalToken } from "./stripe.mjs";

const CODE_TTL_MS = 10 * 60 * 1000, MAX_ATTEMPTS = 5, MIN_GAP_MS = 60 * 1000, MAX_PER_HOUR = 5, TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function verificationRequired(env) {
  const e = env || process.env;
  return e.EMAIL_VERIFICATION !== "false" && deliveryConfig(e).email;
}
export function normalizeEmail(s) { return String(s || "").trim().toLowerCase(); }
export function isEmail(s) { return /^[^\s@+]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }

const secret = () => createHash("sha256").update("verify|" + internalToken()).digest();
const key = (email) => "otp:" + email;
const codeHash = (email, code) => createHash("sha256").update(`${email}|${code}|${internalToken()}`).digest("hex");

export function issueToken(email, now = Date.now()) {
  const sig = createHmac("sha256", secret()).update(`${email}|${now}`).digest("hex");
  return `${now}.${sig}`;
}
export function checkToken(token, email, now = Date.now()) {
  const m = /^(\d{10,16})\.([a-f0-9]{64})$/.exec(String(token || ""));
  if (!m) return false;
  const ts = Number(m[1]);
  if (!(ts <= now + 60000 && now - ts <= TOKEN_TTL_MS)) return false;
  const expected = createHmac("sha256", secret()).update(`${normalizeEmail(email)}|${ts}`).digest("hex");
  return expected.length === m[2].length && timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}

// Envoie un code. Renvoie { ok, code? } avec code ∈ TOO_SOON | TOO_MANY | SEND_FAILED ; devCode seulement avec SMTP_HOST=json (tests).
export async function sendCode({ env, email, brand }) {
  const e = env || process.env;
  const now = Date.now();
  const rec = (await getRecord(key(email))) || { sends: [] };
  const sends = (rec.sends || []).filter((t) => now - t < 3600 * 1000);
  if (sends.length && now - sends[sends.length - 1] < MIN_GAP_MS) return { ok: false, code: "TOO_SOON", retryIn: Math.ceil((MIN_GAP_MS - (now - sends[sends.length - 1])) / 1000) };
  if (sends.length >= MAX_PER_HOUR) return { ok: false, code: "TOO_MANY" };
  const digits = String(randomInt(0, 1000000)).padStart(6, "0");
  const out = await sendCodeMail({ env: e, to: email, code: digits, brand });
  if (!out.ok) return { ok: false, code: "SEND_FAILED", error: out.error };
  await setRecord(key(email), { hash: codeHash(email, digits), exp: now + CODE_TTL_MS, attempts: 0, sends: [...sends, now] });
  return { ok: true, expiresIn: CODE_TTL_MS / 1000, devCode: out.preview ? digits : undefined };
}

// Vérifie un code. Renvoie { ok, token } ou { ok:false, code } avec code ∈ NO_CODE | EXPIRED | TOO_MANY_ATTEMPTS | WRONG.
export async function verifyCode({ email, code }) {
  const rec = await getRecord(key(email));
  const digits = String(code || "").replace(/\D/g, "");
  if (!rec || !rec.hash) return { ok: false, code: "NO_CODE" };
  if (Date.now() > rec.exp) { await setRecord(key(email), { sends: rec.sends || [] }); return { ok: false, code: "EXPIRED" }; }
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, code: "TOO_MANY_ATTEMPTS" };
  const expected = rec.hash, given = codeHash(email, digits);
  if (digits.length !== 6 || !timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    rec.attempts = (rec.attempts || 0) + 1; await setRecord(key(email), rec);
    return { ok: false, code: rec.attempts >= MAX_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "WRONG", remaining: Math.max(0, MAX_ATTEMPTS - rec.attempts) };
  }
  await setRecord(key(email), { sends: rec.sends || [] }); // le code ne sert qu'une fois ; on garde l'historique des envois
  return { ok: true, token: issueToken(email) };
}
