// Client du middleware SoShop (création client + carte, chargement).
// Aucun nom de fournisseur ici : l'URL, les identifiants et le nom de l'en-tête de clé API
// viennent des variables d'environnement (voir README).
//
// Variables :
//   MW_BASE_URL          ex. https://middleware.example.com   (absente = mode simulation)
//   MW_BASIC_USER / MW_BASIC_PASS                             identifiants Basic
//   MW_API_KEY                                                clé API
//   MW_API_KEY_HEADER    nom de l'en-tête de la clé (défaut : x-api-key)
//   MW_CARD_STYLE        style de carte (défaut : 01)
//   MW_ACCOUNT_NAME      nom du compte créé (défaut : Voucher)
//   MW_TIMEOUT_MS        délai max par appel (défaut : 60000)
//   MW_ENVIRONMENT       "production" (défaut) ou "staging" : en staging les cartes sont des cartes de test
//                        et aucun paiement n'est jamais capturé
//   OUTBOUND_PROXY_URL   proxy HTTP(S) à IP fixe, si le middleware exige une liste blanche d'IP
//
// Contrat vérifié sur le Swagger du middleware (v1, OpenAPI 3.0.4) :
//   - en-têtes x-unique-id (10 à 36 caractères [A-Za-z0-9-._], unique pour TOUTES les requêtes) et x-api-key ;
//   - POST /customers : first_name, last_name, email (sans « + »), birth_date (AAAA-MM-JJ), mobile_number (4 à 11 chiffres),
//     mobile_number_dialing_code (+33), nationality (ISO alpha-3), card {style, emboss_name}, account {name, currency}
//     — aucun champ de civilité, et tout champ inconnu est refusé (additionalProperties: false) ;
//   - emboss_name : lettres A-Z, espaces, tirets et points seulement (pas de chiffres), 21 caractères max ;
//   - les identifiants (client 9…, compte 8…, carte 7…) sont des entiers de 18 chiffres : au-delà de la précision
//     de Number en JavaScript, ils sont lus comme des chaînes avant tout JSON.parse.

export function middlewareConfig(env) {
  const base = (env.MW_BASE_URL || "").replace(/\/+$/, "");
  return {
    enabled: !!base,
    base,
    user: env.MW_BASIC_USER || "",
    pass: env.MW_BASIC_PASS || "",
    apiKey: env.MW_API_KEY || "",
    apiKeyHeader: env.MW_API_KEY_HEADER || "x-api-key",
    cardStyle: env.MW_CARD_STYLE || "01",
    accountName: env.MW_ACCOUNT_NAME || "Voucher",
    timeoutMs: Number(env.MW_TIMEOUT_MS || 60000),
    environment: (env.MW_ENVIRONMENT || "production").toLowerCase() === "staging" ? "staging" : "production",
    proxyUrl: env.OUTBOUND_PROXY_URL || "",
    duplicateCodes: env.MW_DUPLICATE_CODES || "4245001" // codes plateforme (derrière un 424) = carte déjà émise pour ce mobile
  };
}

// Nom embossé : majuscules, espaces, tirets, points ; sans accents ni chiffres ; 21 caractères max.
export function embossName(first, last) {
  const s = `${first} ${last}`
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z .-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 21).trim();
  return s || "CARTE";
}

// Identifiant unique de la requête de chargement, dérivé de la commande (36 caractères max).
export function loadUniqueId(orderId) { return ("L" + String(orderId).replace(/[^A-Za-z0-9]/g, "")).slice(0, 36); }

// Les identifiants du middleware sont des entiers de 18 chiffres : on les garde en chaînes.
export function parseMiddlewareJson(text) {
  const safe = text.replace(/("(?:id|cardholder_id|account_id|customer_id|card_id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  return JSON.parse(safe);
}

export class MiddlewareError extends Error {
  constructor(code, message, status, body) { super(message); this.code = code; this.status = status; this.body = body; }
}

// Sortie par un proxy à IP fixe (OUTBOUND_PROXY_URL, ex. http://user:pass@proxy.example.com:9293) :
// on utilise le fetch d'undici avec son ProxyAgent — le fetch natif de Node ignore un dispatcher venu d'un autre undici.
let proxyPromise = null;
async function fetcherFor(cfg) {
  if (!cfg.proxyUrl) return { fetch: globalThis.fetch, dispatcher: undefined };
  if (!proxyPromise) {
    proxyPromise = import("undici").then(({ fetch, ProxyAgent }) => ({ fetch, dispatcher: new ProxyAgent({ uri: cfg.proxyUrl, requestTls: { rejectUnauthorized: true } }) }));
  }
  return proxyPromise;
}

async function call(cfg, method, path, body, uniqueId) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "x-unique-id": uniqueId
  };
  if (cfg.user || cfg.pass) headers.authorization = "Basic " + Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  if (cfg.apiKey) headers[cfg.apiKeyHeader] = cfg.apiKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const t0 = Date.now();
  let res, text;
  try {
    const { fetch: doFetch, dispatcher } = await fetcherFor(cfg);
    res = await doFetch(cfg.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, dispatcher });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const timeout = err && (err.name === "AbortError" || err.name === "TimeoutError");
    console.log(JSON.stringify({ mw: path, uniqueId, status: timeout ? "timeout" : "network", ms: Date.now() - t0 }));
    throw new MiddlewareError(timeout ? "TIMEOUT" : "NETWORK", timeout ? "Délai dépassé" : "Erreur réseau", 0, null);
  }
  clearTimeout(timer);
  let data = null;
  try { data = text ? parseMiddlewareJson(text) : null; } catch (e) { data = { raw: text.slice(0, 500) }; }
  const platformCode = data && data.code != null ? String(data.code) : null;
  const msg = res.ok ? undefined : refusalMessage(data);
  console.log(JSON.stringify({ mw: path, uniqueId, status: res.status, ms: Date.now() - t0, code: platformCode, msg }));
  if (!res.ok) {
    // 409 = doublon signalé par le middleware. La plateforme signale aussi « une carte existe déjà pour ce mobile »
    // par un 424 portant le code 4245001 (constaté le 3 novembre 2026 : même mobile → 4245001, mobile neuf → carte émise).
    const duplicate = res.status === 409 || (res.status === 424 && duplicateCodes(cfg).includes(platformCode));
    const code = duplicate ? "DUPLICATE" : res.status >= 500 || res.status === 424 ? "UPSTREAM" : "REFUSED";
    throw new MiddlewareError(code, `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

// Codes de refus de la plateforme (derrière un 424) qui signifient « carte déjà émise pour cette personne ».
function duplicateCodes(cfg) {
  return String((cfg && cfg.duplicateCodes) || "4245001").split(",").map((s) => s.trim()).filter(Boolean);
}

// Texte court du refus, pour les journaux (jamais renvoyé au navigateur).
function refusalMessage(data) {
  if (!data || typeof data !== "object") return undefined;
  const parts = [];
  for (const k of ["message", "detail", "title", "error", "raw"]) if (typeof data[k] === "string") parts.push(data[k]);
  if (data.errors && typeof data.errors === "object") parts.push(JSON.stringify(data.errors));
  const s = parts.join(" | ");
  return s ? s.slice(0, 200) : undefined;
}

// Crée le client, le compte et la carte en un appel. Renvoie les identifiants et le lien d'activation.
export async function createCustomerAndCard(cfg, person, uniqueId) {
  const payload = {
    first_name: person.first_name,
    last_name: person.last_name,
    birth_date: person.birth_date,                 // AAAA-MM-JJ
    mobile_number: person.mobile,                  // sans le 0 initial
    mobile_number_dialing_code: person.dialing_code, // ex. +33
    nationality: person.nationality,               // ISO 3166-1 alpha-3
    email: person.email,
    card: { style: cfg.cardStyle, emboss_name: embossName(person.first_name, person.last_name) },
    account: { name: cfg.accountName, currency: "EUR" }
  };
  const d = await call(cfg, "POST", "/customers", payload, uniqueId);
  const card = (d && d.card) || {};
  const rc = card.redeemable_code || {};
  return {
    customerId: d && d.id != null ? String(d.id) : null,
    accountId: d && d.account && d.account.id != null ? String(d.account.id) : null,
    cardId: card.id != null ? String(card.id) : null,
    last4: card.last4 || card.masked_pan && String(card.masked_pan).slice(-4) || null,
    redeemUrl: rc.uri || rc.url || null,
    expiresIn: rc.expires_in || null,
    raw: d
  };
}

// Charge la carte. amountCents en centimes (10000 = 100,00 €). Ne jamais renvoyer cet appel après un
// délai dépassé sans vérification : il pourrait créditer deux fois.
export async function creditAccount(cfg, accountId, amountCents, description, uniqueId) {
  const d = await call(cfg, "POST", `/accounts/${encodeURIComponent(accountId)}/credit`, {
    transaction_code: "AccountLoad",
    amount: amountCents,
    description
  }, uniqueId);
  return { transactionId: d && (d.transaction_id || d.id) || null, raw: d };
}
