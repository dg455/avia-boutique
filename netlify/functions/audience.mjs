// GET /api/audience?from=AAAA-MM-JJ&to=AAAA-MM-JJ — ce que la boutique sait, mis en forme pour décider (back-office /audience).
// Derrière le code admin. Jours et heures de Paris. Aucune adresse IP ; e-mails masqués.
//
//   today / allTime   visites (sessions), cartes vendues (émises ET encaissées), euros encaissés — aujourd'hui et depuis le début
//   todo              ce qui attend un geste : cartes payées dont le lien n'a pas été ouvert, paiements à capturer ou à trancher
//                     dans Stripe, commandes bloquées, signaux d'échec Google Wallet (mode « Version ordinateur », lien ouvert deux fois…)
//   people            une ligne par visiteur de la période : heure, appareil, e-mail masqué, dernière étape, pourquoi ça s'est arrêté
//   le reste          entonnoir, appareils, villes, heures, jours, provenance, erreurs, commandes, sessions (détail replié de la page)
//
// Les visites se comptent sur les clés des traces (trace:JOUR:HORODATAGE:SESSION) sans lire les contenus ; seules les traces
// de la période, les commandes et les enregistrements d'activation (act:REF, posés par /api/trace) sont lus.
import { adminOk, json } from "./lib/http.mjs";
import { listKeys, getRecords } from "./lib/orders.mjs";

export const config = { path: "/api/audience" };

// Ordre de l'entonnoir : un visiteur « atteint » une étape s'il l'a vue au moins une fois.
const FUNNEL = [
  ["home", "Accueil"], ["email", "E-mail saisi"], ["code", "Code de vérification"], ["details", "Coordonnées"],
  ["review", "Récapitulatif"], ["stripe", "Départ vers le paiement"], ["creating", "Retour du paiement"], ["ready", "Carte prête"]
];
const STEP_LABEL = {
  home: "Accueil", email: "E-mail", code: "Code de vérification", known: "Client reconnu", details: "Coordonnées", review: "Récapitulatif",
  pay: "Paiement (démo)", stripe: "Caisse Stripe", creating: "Création de la carte", ready: "Carte prête", carte: "Carte (lien e-mail)",
  error: "Erreur", business: "Entreprise", "business-done": "Demande entreprise envoyée",
  "wallet-step1": "Wallet préparé", "wallet-open": "Lien ouvert → Wallet", "link-open": "Lien ouvert", "desktop-mode": "Chrome mode ordinateur"
};
const DEVICE_LABEL = { iphone: "iPhone", ipad: "iPad", android: "Android", "android-tablet": "Tablette Android", ordinateur: "Ordinateur", autre: "?" };
// Début des textes d'erreur affichés au client (tracés sur 32 caractères) → cause courte.
const ERROR_TEXTS = [
  ["Une carte a déjà été créée", "déjà une carte ce mois-ci (mobile connu)"],
  ["L'émetteur n'a pas pu", "refus de l'émetteur"],
  ["L'émetteur est momentanément", "émetteur indisponible"],
  ["La carte est créée mais", "carte créée, chargement à vérifier"],
  ["Le paiement n'a pas abouti", "paiement non abouti"],
  ["Votre session a expiré", "session expirée (code d'accès)"],
  ["Le paiement n'est pas disponible", "paiement indisponible (Stripe)"],
  ["L'e-mail de vérification", "e-mail de vérification non parti"],
  ["La création prend plus", "création trop longue (3 min sans réponse)"],
  ["La connexion a été interrompue", "connexion coupée pendant la création"]
];
const FAIL_CODES = {
  DUPLICATE: ["refusée · déjà une carte ce mois-ci (mobile connu), rien débité", "warn"],
  REFUSED: ["refusée par l'émetteur, rien débité", "warn"],
  UPSTREAM: ["émetteur indisponible, rien débité", "warn"],
  TIMEOUT: ["émetteur sans réponse, rien débité", "warn"],
  ERROR: ["erreur technique à l'émission, rien débité", "warn"],
  LOAD_PENDING: ["carte créée, chargement non confirmé · paiement à trancher", "todo"],
  PAYMENT_FAILED: ["paiement abandonné à la caisse, rien débité", "drop"],
  AMOUNT_MISMATCH: ["montant payé ≠ prix · à vérifier dans Stripe", "todo"]
};

const GRACE_ACTIVATION_MS = 15 * 60000, STUCK_MS = 5 * 60000, CHECKOUT_MS = 45 * 60000, LIVE_MS = 10 * 60000, TODO_WINDOW_MS = 30 * 86400000;
const MAX_PERIOD_TRACES = 8000;

const mask = (e) => { if (!e) return null; const [u, d] = String(e).split("@"); return (u.length > 2 ? u[0] + "***" + u[u.length - 1] : u[0] + "***") + "@" + (d || ""); };
const ref = (id) => String(id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
const utcDay = (d) => new Date(d).toISOString().slice(0, 10);
const parisDay = (d) => new Date(d).toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ, jour de Paris
const parisHour = (d) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(d)).find((x) => x.type === "hour").value.padStart(2, "0");
const count = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (k == null) continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })); };
const euros = (cents) => Math.round(cents) / 100;
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "à l'instant"; if (m < 60) return `${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} j`;
}

// Ce que la boutique sait d'une commande, mis en mots pour quelqu'un qui doit décider quoi faire.
function describeOrder(o, act, now) {
  const age = now - Date.parse(o.createdAt || o.updatedAt || now);
  const sold = o.status === "issued" && o.captured === true;
  const out = { flag: "drop", why: "", step: null, action: null, todo: null, sold, euros: sold ? euros(o.product ? o.product.priceCents : 0) : 0 };
  const resent = o.resend && o.resend.count ? ` · e-mail renvoyé ×${o.resend.count}` : "";
  if (o.status === "issued") {
    out.step = "ready";
    if (sold) {
      const a = act || {};
      const times = a.opens > 1 ? ` ${a.opens}×` : "";
      if (a.wallet) {
        if (a.opens > 1) { out.why = `vendue · lien ouvert${times} vers Wallet, ajout probablement raté`; out.flag = "todo"; out.todo = "wallet"; out.action = "Appeler : le lien ne s'ouvre qu'une fois ; vérifier que la carte est dans Google Wallet"; }
        else { out.why = "vendue · lien ouvert → Google Wallet"; out.flag = "sold"; }
      } else if (a.link) {
        if (a.device === "ordinateur") { out.why = `vendue · lien ouvert${times} sur ordinateur, pas de portefeuille`; out.flag = "todo"; out.todo = "wallet"; out.action = "Appeler : la carte s'affiche sur l'ordinateur, numéro à saisir dans Cartes sur le téléphone"; }
        else if (a.device === "android" || a.device === "android-tablet") { out.why = `vendue · lien ouvert${times} sur Android hors Google Wallet`; out.flag = "todo"; out.todo = "wallet"; out.action = "Appeler : vérifier que la carte est dans Google Wallet"; }
        else if (a.device === "iphone" || a.device === "ipad") { out.why = `vendue · lien ouvert${times} sur iPhone (saisie manuelle)`; out.flag = "sold"; }
        else { out.why = `vendue · lien ouvert${times}`; out.flag = "sold"; }
      } else if (a.desktop) {
        out.why = "vendue · Chrome « Version ordinateur », Wallet ne se lance pas"; out.flag = "todo"; out.todo = "wallet"; out.action = "Appeler : décocher « Version ordinateur » dans Chrome avant d'ouvrir le lien";
      } else if (age < GRACE_ACTIVATION_MS) {
        out.why = "vendue · lien pas encore ouvert"; out.flag = "sold";
      } else {
        out.why = `vendue · lien pas ouvert depuis ${ago(age)}`; out.flag = "todo"; out.todo = "activation"; out.action = "Appeler ou renvoyer l'e-mail : la carte attend dans la boîte mail";
      }
      if (!out.todo && o.resend && o.resend.count) { out.flag = "todo"; out.todo = "wallet"; out.action = "Appeler : le client a redemandé l'e-mail, il n'y arrive pas"; }
      out.why += resent;
    } else if (o.captureError) {
      out.why = "émise, paiement NON capturé (erreur Stripe)"; out.flag = "todo"; out.todo = "capture"; out.action = "Capturer le paiement dans Stripe";
    } else if (o.paymentReleased) {
      out.why = o.mode === "staging" ? "test plateforme · carte de test, paiement annulé" : "démo · carte fictive, paiement annulé"; out.flag = "test";
    } else if (o.payment !== "stripe") {
      out.why = o.mode === "real" ? "carte réelle émise sans paiement (test de production)" : "démo · carte fictive, aucun paiement"; out.flag = "test";
    } else {
      out.why = "émise, encaissement à vérifier dans Stripe"; out.flag = "todo"; out.todo = "capture"; out.action = "Vérifier la capture dans Stripe";
    }
  } else if (o.status === "failed") {
    out.step = "error";
    const f = FAIL_CODES[o.code] || [`échec (${o.code || "inconnu"}) — rien débité`, "warn"];
    out.why = f[0]; out.flag = f[1];
    if (o.code === "LOAD_PENDING") { out.todo = "capture"; out.action = "Vérifier le chargement côté émetteur, puis capturer ou annuler dans Stripe"; }
    if (o.code === "AMOUNT_MISMATCH") { out.todo = "capture"; out.action = "Comparer le montant Stripe au prix, puis capturer, annuler ou rembourser"; }
  } else if (o.status === "pending") {
    out.step = "stripe";
    if (age < CHECKOUT_MS) { out.why = "à la caisse Stripe en ce moment"; out.flag = "live"; }
    else { out.why = "parti à la caisse Stripe, n'a pas payé"; out.flag = "drop"; }
  } else { // issuing / processing
    out.step = "creating";
    if (age < STUCK_MS) { out.why = "paiement autorisé, carte en création"; out.flag = "live"; }
    else { out.why = `bloquée en création depuis ${ago(age)} · payée, non émise`; out.flag = "todo"; out.todo = "capture"; out.action = "Relancer l'émission (POST /api/issue-worker avec le jeton interne) ou annuler l'autorisation dans Stripe"; }
  }
  return out;
}

// Ce qu'on peut dire d'une visite sans commande : jusqu'où, et pourquoi ça s'est arrêté.
function describeSession(s, now) {
  const seen = (k) => s.screens.has(k);
  if (s.errors.length) {
    const txt = s.errors[s.errors.length - 1] || "";
    const known = ERROR_TEXTS.find(([start]) => txt.startsWith(start));
    return { step: "error", why: known ? known[1] : FAIL_CODES[txt] ? FAIL_CODES[txt][0] : txt, flag: "warn" };
  }
  if (seen("business-done")) return { step: "business-done", why: "demande entreprise envoyée (formulaire Netlify)", flag: "biz" };
  if (seen("business")) return { step: "business", why: "parcours entreprise, formulaire non envoyé", flag: "drop" };
  let last = "home";
  for (const [k] of FUNNEL) if (seen(k)) last = k;
  if (seen("carte")) last = "carte";
  if (last === "review" && seen("pay")) last = "pay";
  if (["email", "code"].includes(last) && seen("known")) last = "known";
  const live = now - Date.parse(s.last) < LIVE_MS && !["ready", "carte"].includes(last);
  const why = {
    home: "n'a pas commencé", email: "pas d'e-mail saisi", code: "code de vérification non saisi (e-mail non reçu ?)",
    known: "client reconnu, n'a pas continué", details: "coordonnées non terminées", review: "n'a pas lancé le paiement",
    pay: "paiement démo non validé", stripe: "parti chez Stripe, pas revenu", creating: "pas de retour de la création",
    ready: "carte prête (commande non retrouvée)", carte: "arrivé par le lien e-mail" + (seen("wallet-open") ? " — ouvert vers Wallet" : seen("link-open") ? " — lien ouvert" : seen("desktop-mode") ? " — Chrome en mode ordinateur" : " — lien pas ouvert")
  }[last];
  return { step: last, why: live ? "en cours : " + why : why, flag: live ? "live" : last === "ready" || last === "carte" ? "info" : "drop" };
}

export default async (request) => {
  if (request.method !== "GET") return json(405, { ok: false });
  if (!adminOk(request, process.env)) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Code admin requis." });
  const now = Date.now();
  const today = parisDay(now);
  const q = new URL(request.url).searchParams;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get("to") || "") ? q.get("to") : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") || "") ? q.get("from") : utcDay(Date.parse(to) - 6 * 86400000);
  if (from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) return json(400, { ok: false, error: "Période invalide (92 jours max)." });

  // 1. Toutes les clés, sans lire les contenus : les visites se comptent sur les clés de trace.
  const keys = await listKeys("");
  const traceKeys = [], orderKeys = [], actKeys = [];
  for (const k of keys) { if (k.startsWith("trace:")) traceKeys.push(k); else if (k.startsWith("act:")) actKeys.push(k); else if (!k.includes(":")) orderKeys.push(k); }
  const sidsAll = new Set(), sidsToday = new Set(); let firstDay = null;
  const fromUtc = utcDay(Date.parse(from) - 86400000); // un jour de Paris déborde sur deux jours UTC
  const periodKeys = [];
  for (const k of traceKeys) {
    const [, day, ts, sid8] = k.split(":");
    if (!day || !ts || !sid8) continue;
    const pd = parisDay(Number(ts));
    sidsAll.add(sid8); if (pd === today) sidsToday.add(sid8);
    if (!firstDay || pd < firstDay) firstDay = pd;
    if (day >= fromUtc && day <= to && pd >= from && pd <= to) periodKeys.push(k);
  }
  periodKeys.sort();
  const truncated = periodKeys.length > MAX_PERIOD_TRACES;
  const [traceRecs, orderRecs, actRecs] = await Promise.all([
    getRecords(truncated ? periodKeys.slice(-MAX_PERIOD_TRACES) : periodKeys),
    getRecords(orderKeys),
    getRecords(actKeys)
  ]);
  const acts = new Map(actRecs.map((r) => [r.key.slice(4), r.value]));
  const allOrders = orderRecs.map((r) => r.value).filter((o) => o && o.orderId && o.createdAt);
  const ordersByRef = new Map(allOrders.map((o) => [ref(o.orderId), o]));
  const stripeTest = /_test_/.test(process.env.STRIPE_SECRET_KEY || "");
  const stripeUrl = (o) => o.paymentIntentId ? `https://dashboard.stripe.com/${stripeTest ? "test/" : ""}payments/${o.paymentIntentId}` : null;

  // 2. Les chiffres : visites, cartes vendues, euros — aujourd'hui et depuis le début.
  const sum = (list) => list.reduce((t, o) => ({ sold: t.sold + 1, euros: t.euros + euros(o.product ? o.product.priceCents : 0) }), { sold: 0, euros: 0 });
  const soldAll = allOrders.filter((o) => o.status === "issued" && o.captured === true);
  const soldToday = soldAll.filter((o) => parisDay(o.createdAt) === today);
  const totals = { today: { visits: sidsToday.size, ...sum(soldToday) }, allTime: { visits: sidsAll.size, ...sum(soldAll), since: firstDay || (allOrders.length ? parisDay(allOrders.map((o) => o.createdAt).sort()[0]) : today) } };
  totals.allTime.euros = Math.round(totals.allTime.euros * 100) / 100; totals.today.euros = Math.round(totals.today.euros * 100) / 100;

  // 3. Sessions de la période, à partir des traces lues.
  const traces = traceRecs.map((r) => r.value).sort((a, b) => a.t.localeCompare(b.t));
  const sessions = new Map();
  for (const t of traces) {
    const s = sessions.get(t.sid) || { sid: t.sid, first: t.t, last: t.t, screens: new Set(), path: [], device: t.device, country: t.country, city: t.city, lang: t.lang, ref: t.ref, orderRef: null, em: null, errors: [], host: t.host };
    s.last = t.t; s.screens.add(t.screen); if (s.path[s.path.length - 1] !== t.screen) s.path.push(t.screen);
    if (t.orderId) s.orderRef = ref(t.orderId); if (t.em) s.em = t.em; if (t.ref && !s.ref) s.ref = t.ref;
    if (t.screen === "error") s.errors.push(t.code || "");
    if (t.screen === "desktop-mode" && s.device !== "android") s.device = "android";
    sessions.set(t.sid, s);
  }
  const S = [...sessions.values()];
  const reached = (k) => S.filter((s) => s.screens.has(k)).length;
  const funnel = FUNNEL.map(([k, label], i) => {
    const n = reached(k); const prev = i ? reached(FUNNEL[i - 1][0]) : n;
    return { step: k, label, sessions: n, pctOfPrevious: prev ? Math.round(100 * n / prev) : null, pctOfAll: S.length ? Math.round(100 * n / S.length) : null };
  });
  const lastScreen = (s) => { let best = -1; FUNNEL.forEach(([k], i) => { if (s.screens.has(k) && i > best) best = i; }); return best >= 0 ? FUNNEL[best][1] : STEP_LABEL[[...s.screens][0]] || [...s.screens][0]; };

  // 4. Une ligne par personne : les sessions de la période, complétées par leur commande ; puis les commandes de la période sans visite tracée.
  const orderView = (o, d) => ({
    ref: ref(o.orderId), status: o.status, code: o.code || null, mode: o.mode || null, payment: o.payment || null,
    product: o.product ? `${o.product.faceCents / 100} €` : null, price: o.product ? euros(o.product.priceCents) : null,
    captured: o.captured ?? null, delivered: o.delivery && o.delivery.email ? !!o.delivery.email.ok : null, resend: o.resend ? o.resend.count : 0,
    last4: o.result && o.result.last4 || null, createdAt: o.createdAt, updatedAt: o.updatedAt || null, stripeUrl: stripeUrl(o), action: d.action
  });
  const people = [];
  const linked = new Set();
  for (const s of S) {
    const o = s.orderRef ? ordersByRef.get(s.orderRef) : null;
    const act = s.orderRef ? acts.get(s.orderRef) : null;
    let d;
    if (o) { linked.add(ref(o.orderId)); d = describeOrder(o, act, now); }
    else d = describeSession(s, now);
    const stepKey = o ? (d.step === "ready" ? (s.screens.has("carte") && !s.screens.has("ready") ? "carte" : "ready") : d.step) : d.step;
    people.push({
      at: s.first, last: s.last, device: DEVICE_LABEL[s.device] || s.device, deviceKey: s.device, email: o ? mask(o.email) : s.em, step: STEP_LABEL[stepKey] || stepKey, why: d.why, flag: d.flag,
      ref: o ? ref(o.orderId) : s.orderRef, path: s.path.map((k) => STEP_LABEL[k] || k), city: s.city, country: s.country, lang: s.lang, referrer: s.ref,
      order: o ? orderView(o, d) : null, act: act ? { prep: act.prep || null, wallet: act.wallet || null, link: act.link || null, desktop: act.desktop || null, opens: act.opens || 0, device: DEVICE_LABEL[act.device] || act.device || null } : null
    });
  }
  for (const o of allOrders) {
    const pd = parisDay(o.createdAt);
    if (pd < from || pd > to || linked.has(ref(o.orderId))) continue;
    const act = acts.get(ref(o.orderId)) || null;
    const d = describeOrder(o, act, now);
    people.push({
      at: o.createdAt, last: o.updatedAt || o.createdAt, device: act ? (DEVICE_LABEL[act.device] || act.device) : "?", deviceKey: act ? act.device : null, email: mask(o.email), step: STEP_LABEL[d.step] || d.step, why: d.why + " (visite non tracée)", flag: d.flag,
      ref: ref(o.orderId), path: [], city: null, country: null, lang: null, referrer: null, order: orderView(o, d),
      act: act ? { prep: act.prep || null, wallet: act.wallet || null, link: act.link || null, desktop: act.desktop || null, opens: act.opens || 0, device: DEVICE_LABEL[act.device] || act.device || null } : null
    });
  }
  people.sort((a, b) => b.at.localeCompare(a.at));

  // 5. À traiter : sur toutes les commandes des 30 derniers jours, pas seulement la période affichée.
  const todo = { activation: [], capture: [], wallet: [] };
  for (const o of allOrders) {
    if (now - Date.parse(o.createdAt) > TODO_WINDOW_MS) continue;
    const act = acts.get(ref(o.orderId)) || null;
    const d = describeOrder(o, act, now);
    if (!d.todo) continue;
    todo[d.todo].push({ ref: ref(o.orderId), at: o.createdAt, email: mask(o.email), product: o.product ? `${o.product.faceCents / 100} €` : null, price: o.product ? euros(o.product.priceCents) : null,
      device: act ? (DEVICE_LABEL[act.device] || act.device) : null, why: d.why, action: d.action, stripeUrl: stripeUrl(o), status: o.status, code: o.code || null });
  }
  for (const k of Object.keys(todo)) todo[k].sort((a, b) => b.at.localeCompare(a.at));

  // 6. Commandes de la période (détail) et agrégats classiques.
  const orders = allOrders.filter((o) => { const pd = parisDay(o.createdAt); return pd >= from && pd <= to; })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => { const d = describeOrder(o, acts.get(ref(o.orderId)) || null, now); return { orderId: o.orderId, at: o.createdAt, status: o.status, code: o.code || null, mode: o.mode || null, payment: o.payment || null,
      product: o.product ? `${o.product.faceCents / 100} €` : null, email: mask(o.email), last4: o.result && o.result.last4 || null,
      delivered: o.delivery && o.delivery.email ? !!o.delivery.email.ok : null, captured: o.captured ?? null, why: d.why, flag: d.flag }; });

  return json(200, {
    ok: true, from, to, today, now: new Date(now).toISOString(), truncated,
    totals, todo, todoCount: todo.activation.length + todo.capture.length + todo.wallet.length,
    people: people.slice(0, 400),
    sessions: S.length, visitorsWithEmail: reached("email"), visitorsWithOrder: S.filter((s) => s.orderRef).length,
    funnel,
    dropOff: count(S.filter((s) => !s.screens.has("ready") && !s.screens.has("carte") && !s.screens.has("business-done")), lastScreen),
    devices: count(S, (s) => DEVICE_LABEL[s.device] || s.device), countries: count(S, (s) => s.country), cities: count(S, (s) => s.city && s.country ? `${s.city} (${s.country})` : null),
    languages: count(S, (s) => s.lang), referrers: count(S, (s) => s.ref), hosts: count(S, (s) => s.host),
    hours: count(traces.filter((t) => t.screen === "home"), (t) => parisHour(t.t) + " h"),
    days: count(S, (s) => parisDay(s.first)).sort((a, b) => a.k.localeCompare(b.k)),
    errors: count(traces.filter((t) => t.screen === "error"), (t) => t.code || "inconnue"),
    orders: { total: orders.length, byStatus: count(orders, (o) => o.status), sold: orders.filter((o) => o.flag === "sold" || (o.status === "issued" && o.captured === true)).length, list: orders.slice(0, 200) },
    sessionsList: S.sort((a, b) => b.first.localeCompare(a.first)).slice(0, 300).map((s) => ({ first: s.first, last: s.last, device: DEVICE_LABEL[s.device] || s.device, city: s.city, country: s.country, lastScreen: lastScreen(s), screens: [...s.screens], orderId: s.orderRef }))
  });
};
