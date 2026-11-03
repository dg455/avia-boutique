// Remise du lien d'activation au porteur, en plus de l'affichage à l'écran.
// La plateforme émettrice n'envoie rien au porteur (confirmé par écrit le 23 août 2026) : c'est la boutique qui livre le lien.
//
// E-mail (gratuit, par SMTP — compte Google Workspace de la boutique avec un mot de passe d'application, ou tout SMTP) :
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS   (absents = aucun e-mail) ; SMTP_HOST=json dans les tests (aucun envoi réel)
//   MAIL_FROM            expéditeur, ex. "AVIA by SoShop.Club <cartes@soshop.club>" (défaut : SMTP_USER)
//   MAIL_REPLY_TO        adresse de réponse (défaut : l'expéditeur)
//   DELIVERY_EMAIL       "false" pour couper l'e-mail
// SMS (payant, via Brevo ; coupé par défaut) :
//   BREVO_API_KEY, BREVO_API_URL (défaut https://api.brevo.com/v3), SMS_SENDER (11 caractères max, défaut AVIA), DELIVERY_SMS="true" pour l'activer
// Liens courts :
//   SHOP_PUBLIC_ORIGIN   origine publique de la boutique (défaut : origine de la commande)

export function deliveryConfig(env) {
  const key = env.BREVO_API_KEY || "";
  const smtp = env.SMTP_HOST ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER || "", pass: env.SMTP_PASS || "" } : null;
  const from = parseAddress(env.MAIL_FROM || (smtp && smtp.user) || "");
  return {
    smtp, key,
    base: (env.BREVO_API_URL || "https://api.brevo.com/v3").replace(/\/+$/, ""),
    from,
    replyTo: parseAddress(env.MAIL_REPLY_TO || "") || from,
    smsSender: (env.SMS_SENDER || "AVIA").replace(/[^A-Za-z0-9]/g, "").slice(0, 11) || "AVIA",
    email: !!smtp && !!from && env.DELIVERY_EMAIL !== "false",
    sms: !!key && env.DELIVERY_SMS === "true",
    publicOrigin: (env.SHOP_PUBLIC_ORIGIN || "").replace(/\/+$/, "")
  };
}

let mailerPromise = null;
async function mailer(cfg) {
  if (!mailerPromise) {
    mailerPromise = import("nodemailer").then(({ default: nodemailer }) => cfg.smtp.host === "json"
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465, auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } }));
  }
  return mailerPromise;
}
export function resetMailer() { mailerPromise = null; }

// E-mail de test (sonde /api/mail-check) : même transport SMTP que les vrais envois, aucun secret dans la réponse.
export async function sendTestMail({ env, to }) {
  const cfg = deliveryConfig(env || process.env);
  const base = { to, host: cfg.smtp ? cfg.smtp.host : null, port: cfg.smtp ? cfg.smtp.port : null, from: cfg.from ? cfg.from.email : null, enabled: cfg.email };
  if (!cfg.email) return { ok: false, ...base, error: "E-mail non configuré (SMTP_HOST / MAIL_FROM) ou coupé (DELIVERY_EMAIL=false)" };
  const when = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const text = `E-mail de test envoyé par la boutique le ${when} (Europe/Paris).\nSi vous le lisez, l'envoi des liens d'activation par e-mail fonctionne.`;
  try {
    const t = await mailer(cfg);
    const fromStr = cfg.from.name ? `"${cfg.from.name.replace(/"/g, "")}" <${cfg.from.email}>` : cfg.from.email;
    const info = await t.sendMail({ from: fromStr, replyTo: cfg.replyTo ? cfg.replyTo.email : undefined, to, subject: "Test d'envoi — boutique AVIA", text, html: `<p>${text.replace("\n", "</p><p>")}</p>` });
    console.log(JSON.stringify({ step: "mail-check", ok: true, to, id: info.messageId || null }));
    return { ok: true, ...base, id: info.messageId || null, preview: cfg.smtp.host === "json" ? info.message : undefined };
  } catch (err) {
    const msg = String(err && err.message);
    console.log(JSON.stringify({ step: "mail-check", ok: false, to, msg }));
    return { ok: false, ...base, error: msg };
  }
}

function parseAddress(s) {
  const m = String(s).match(/^\s*(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  if (!m) return null;
  return { name: (m[1] || "").trim() || undefined, email: m[2].trim() };
}

// Référence courte montrée au client et utilisée dans le lien court /c/REF (8 premiers caractères de la commande).
export function shortCode(orderId) { return String(orderId).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase(); }

export function shortLink(origin, orderId) { return `${origin}/c/${shortCode(orderId)}`; }

// Page de guidage sur le téléphone (onglets Android / iPhone), qui porte le lien d'activation.
export function guidedLink(origin, redeemUrl) { return `${origin}/#/carte?u=${encodeURIComponent(redeemUrl)}`; }

function validity(expiresIn) {
  if (!expiresIn) return null;
  const mins = Math.round(expiresIn / 60);
  return mins >= 60 ? `${Math.round(mins / 60)} h` : `${mins} min`;
}

function money(cents) { return (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" }); }

// Textes des messages. brand : { name, cardName, operator, supportPhone }.
export function buildMessages({ brand, person, faceCents, link, expiresIn }) {
  const first = person && person.first_name ? String(person.first_name).trim() : "";
  const v = validity(expiresIn);
  const hello = first ? `Bonjour ${first},` : "Bonjour,";
  const subject = `Votre ${brand.cardName} de ${money(faceCents)} est prête`;
  const text = [
    hello, "",
    `Votre ${brand.cardName} de ${money(faceCents)} est prête. Ouvrez ce lien depuis votre téléphone :`,
    link, "",
    `Ce lien ne s'ouvre qu'une seule fois${v ? ` et reste valable ${v}` : ""}. Si vous le fermez par erreur, appelez le service client avant de réessayer.`, "",
    "Sur Android : installez et ouvrez Google Wallet une première fois (compte Google connecté, verrouillage d'écran activé), puis ouvrez le lien dans Chrome et touchez « Add to Google Wallet ».",
    "Sur iPhone : ouvrez le lien, puis ajoutez la carte dans Cartes (Apple Wallet) en saisissant le numéro, la date d'expiration et le cryptogramme affichés.",
    "En station : approchez votre téléphone du terminal, comme avec une carte bancaire.", "",
    `Service client : ${brand.supportPhone}.`, "",
    brand.operator ? `${brand.name} by ${brand.operator}` : brand.name
  ].join("\n");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#141B2D;max-width:560px">
<p>${esc(hello)}</p>
<p>Votre <b>${esc(brand.cardName)}</b> de <b>${esc(money(faceCents))}</b> est prête. Il reste trois gestes pour la mettre dans votre téléphone.</p>
<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#ED1C24;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px">Ouvrir ma carte sur mon téléphone</a></p>
<p style="font-size:14px;color:#5a6478">Ce lien ne s'ouvre qu'une seule fois${v ? ` et reste valable ${esc(v)}` : ""}. Ouvrez-le depuis votre téléphone, pas depuis un ordinateur. Si vous le fermez par erreur, appelez le service client avant de réessayer.</p>
<h3 style="font-size:16px;margin:24px 0 6px">Sur Android</h3>
<ol style="margin:0;padding-left:20px"><li>Installez et ouvrez <b>Google Wallet</b> une première fois : compte Google connecté, verrouillage d'écran activé.</li><li>Ouvrez le lien dans <b>Chrome</b> (pas depuis WhatsApp ou Messenger), acceptez les conditions.</li><li>Touchez <b>« Add to Google Wallet »</b>.</li></ol>
<h3 style="font-size:16px;margin:24px 0 6px">Sur iPhone</h3>
<ol style="margin:0;padding-left:20px"><li>Ouvrez le lien, acceptez les conditions : la carte s'affiche avec son numéro, sa date d'expiration et son cryptogramme.</li><li>Ouvrez <b>Cartes</b> (Apple Wallet), touchez <b>+</b>, puis <b>Carte de débit ou de crédit</b>, puis <b>Saisir les informations manuellement</b>.</li><li>Recopiez les informations affichées.</li></ol>
<p>En station, approchez votre téléphone du terminal, comme avec une carte bancaire.</p>
<p style="font-size:14px;color:#5a6478">Service client : ${esc(brand.supportPhone)}.<br>${esc(brand.operator ? `${brand.name} by ${brand.operator}` : brand.name)}</p>
</div>`;
  const sms = `${brand.name} : votre carte de ${money(faceCents)} est prete. Ouvrez ce lien sur votre telephone (une seule ouverture${v ? `, valable ${v}` : ""}) : ${link}`;
  return { subject, text, html, sms };
}

async function brevo(cfg, path, payload) {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: { "api-key": cfg.key, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

// Envoie l'e-mail et le SMS ; ne lève jamais : renvoie { email: {...}|null, sms: {...}|null }.
export async function sendCardLink({ env, order, brand }) {
  const cfg = deliveryConfig(env || process.env);
  const out = { email: null, sms: null };
  if ((!cfg.email && !cfg.sms) || !order || !order.result || !order.result.redeemUrl) return out;
  const origin = cfg.publicOrigin || order.origin;
  const link = shortLink(origin, order.orderId);
  const msg = buildMessages({ brand, person: order.person, faceCents: order.product.faceCents, link, expiresIn: order.result.expiresIn });
  const log = (k, r) => console.log(JSON.stringify({ step: "notify", orderId: order.orderId, channel: k, ok: r.ok, status: r.status, id: r.data && (r.data.messageId || r.data.reference) || null, msg: r.ok ? undefined : JSON.stringify(r.data).slice(0, 200) }));

  if (cfg.email && order.email) {
    try {
      const t = await mailer(cfg);
      const fromStr = cfg.from.name ? `"${cfg.from.name.replace(/"/g, "")}" <${cfg.from.email}>` : cfg.from.email;
      const info = await t.sendMail({ from: fromStr, replyTo: cfg.replyTo ? cfg.replyTo.email : undefined, to: order.email, subject: msg.subject, text: msg.text, html: msg.html });
      out.email = { ok: true, id: info.messageId || null, preview: cfg.smtp.host === "json" ? info.message : undefined };
      console.log(JSON.stringify({ step: "notify", orderId: order.orderId, channel: "email", ok: true, id: info.messageId || null }));
    } catch (err) { out.email = { ok: false, error: String(err && err.message) }; console.log(JSON.stringify({ step: "notify", orderId: order.orderId, channel: "email", ok: false, msg: String(err && err.message) })); }
  }
  if (cfg.sms && order.person && order.person.mobile) {
    try {
      const recipient = String(order.person.dialing_code || "+33").replace(/[^\d+]/g, "") + String(order.person.mobile).replace(/\D/g, "");
      const r = await brevo(cfg, "/transactionalSMS/sms", { type: "transactional", unicodeEnabled: false, sender: cfg.smsSender, recipient, content: msg.sms, tag: "carte-prete" });
      out.sms = { ok: r.ok, status: r.status, id: r.data && r.data.reference || null }; log("sms", r);
    } catch (err) { out.sms = { ok: false, status: 0, error: String(err && err.message) }; console.log(JSON.stringify({ step: "notify", orderId: order.orderId, channel: "sms", ok: false, msg: String(err && err.message) })); }
  }
  return out;
}
