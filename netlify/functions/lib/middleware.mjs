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
//   OUTBOUND_PROXY_URL   proxy HTTP(S) à IP fixe, si le middleware exige une liste blanche d'IP

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
    proxyUrl: env.OUTBOUND_PROXY_URL || ""
  };
}

// Nom embossé : majuscules, chiffres, espaces, tirets, points ; sans accents ; 21 caractères max.
export function embossName(first, last) {
  return `${first} ${last}`
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9 .-]/g, "").replace(/\s+/g, " ").trim().slice(0, 21);
}

export class MiddlewareError extends Error {
  constructor(code, message, status, body) { super(message); this.code = code; this.status = status; this.body = body; }
}

let dispatcherPromise = null;
async function dispatcherFor(cfg) {
  if (!cfg.proxyUrl) return undefined;
  if (!dispatcherPromise) {
    dispatcherPromise = import("undici").then(({ ProxyAgent }) => new ProxyAgent(cfg.proxyUrl));
  }
  return dispatcherPromise;
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
    const dispatcher = await dispatcherFor(cfg);
    res = await fetch(cfg.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, dispatcher });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const timeout = err && (err.name === "AbortError" || err.name === "TimeoutError");
    console.log(JSON.stringify({ mw: path, uniqueId, status: timeout ? "timeout" : "network", ms: Date.now() - t0 }));
    throw new MiddlewareError(timeout ? "TIMEOUT" : "NETWORK", timeout ? "Délai dépassé" : "Erreur réseau", 0, null);
  }
  clearTimeout(timer);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 500) }; }
  console.log(JSON.stringify({ mw: path, uniqueId, status: res.status, ms: Date.now() - t0, code: data && data.code }));
  if (!res.ok) {
    const code = res.status === 409 ? "DUPLICATE" : res.status >= 500 || res.status === 424 ? "UPSTREAM" : "REFUSED";
    throw new MiddlewareError(code, `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

// Crée le client, le compte et la carte en un appel. Renvoie les identifiants et le lien d'activation.
export async function createCustomerAndCard(cfg, person, uniqueId) {
  const payload = {
    first_name: person.first_name,
    last_name: person.last_name,
    birth_date: person.birth_date,                 // AAAA-MM-JJ
    gender: person.gender,                         // F / M — à confirmer avec le Swagger du middleware
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
    customerId: d && d.id,
    accountId: d && d.account && d.account.id,
    cardId: card.id,
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
