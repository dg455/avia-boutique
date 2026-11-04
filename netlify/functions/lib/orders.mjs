// Stockage des commandes en attente de paiement et de leurs résultats.
// En production : Netlify Blobs (magasin « orders » du site). En local : un fichier JSON temporaire.
//
// Une commande passe par : pending (session de paiement créée) → issuing (paiement autorisé, émission en cours)
// → issued (carte créée et chargée, paiement capturé) ou failed (rien débité).

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCAL_DIR = join(tmpdir(), "avia-boutique-orders");

async function blobStore() {
  if (!process.env.NETLIFY && !process.env.NETLIFY_BLOBS_CONTEXT) return null;
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "orders", consistency: "strong" });
  } catch (e) {
    console.log(JSON.stringify({ orders: "blobs-unavailable", msg: String(e && e.message) }));
    return null;
  }
}

export async function getOrder(orderId) {
  const store = await blobStore();
  if (store) return (await store.get(orderId, { type: "json" })) || null;
  try { return JSON.parse(await readFile(join(LOCAL_DIR, orderId + ".json"), "utf8")); } catch { return null; }
}

export async function saveOrder(order) {
  order.updatedAt = new Date().toISOString();
  const store = await blobStore();
  if (store) { await store.setJSON(order.orderId, order); return order; }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(join(LOCAL_DIR, order.orderId + ".json"), JSON.stringify(order));
  return order;
}

// Lien court /c/REF : REF (8 caractères) → identifiant de commande, enregistré à l'émission.
export async function saveShortCode(code, orderId) {
  const key = "code:" + String(code).toUpperCase();
  const store = await blobStore();
  if (store) { await store.setJSON(key, { orderId }); return; }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(join(LOCAL_DIR, key + ".json"), JSON.stringify({ orderId }));
}
export async function getOrderByCode(code) {
  if (!/^[A-Za-z0-9]{6,12}$/.test(String(code))) return null;
  const key = "code:" + String(code).toUpperCase();
  const store = await blobStore();
  let map = null;
  if (store) map = await store.get(key, { type: "json" });
  else { try { map = JSON.parse(await readFile(join(LOCAL_DIR, key + ".json"), "utf8")); } catch { map = null; } }
  return map && map.orderId ? getOrder(map.orderId) : null;
}

// Enregistrements techniques (codes de vérification e-mail, traces, activations) : même magasin, clé préfixée.
// En local, le nom de fichier encode la clé de façon réversible (« : » et « @ » compris) pour que listKeys la restitue telle quelle.
function recordFile(key) { return join(LOCAL_DIR, encodeURIComponent(String(key)) + ".json"); }
export async function getRecord(key) {
  const store = await blobStore();
  if (store) return (await store.get(key, { type: "json" })) || null;
  try { return JSON.parse(await readFile(recordFile(key), "utf8")); } catch { return null; }
}
export async function setRecord(key, value) {
  const store = await blobStore();
  if (store) { await store.setJSON(key, value); return; }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(recordFile(key), JSON.stringify(value));
}
export async function deleteRecord(key) {
  const store = await blobStore();
  if (store) { try { await store.delete(key); } catch { /* déjà absent */ } return; }
  try { await rm(recordFile(key), { force: true }); } catch { /* déjà absent */ }
}

// Clés dont le nom commence par prefix ("" = tout), sans lire les contenus : sert à compter (les clés de trace
// portent le jour, l'heure et la session) avant de ne charger que ce qu'il faut.
export async function listKeys(prefix = "") {
  const store = await blobStore();
  if (store) {
    const keys = []; let cursor;
    do {
      const page = await store.list({ prefix, cursor, paginate: true });
      for (const b of page.blobs || []) keys.push(b.key);
      cursor = page.cursor;
    } while (cursor);
    return keys;
  }
  let names = []; try { names = await readdir(LOCAL_DIR); } catch { return []; }
  const keys = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    let key = n.slice(0, -5); try { key = decodeURIComponent(key); } catch { /* nom brut */ }
    if (key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

// Lit plusieurs enregistrements à la fois (lectures en parallèle, par paquets) : { key, value } pour chaque clé trouvée.
export async function getRecords(keys, concurrency = 24) {
  const store = await blobStore();
  const read = store
    ? (key) => store.get(key, { type: "json" })
    : async (key) => {
      // Fichier local : commandes et liens courts gardent leur nom brut, les autres enregistrements sont encodés.
      for (const f of [join(LOCAL_DIR, key + ".json"), recordFile(key)]) { try { return JSON.parse(await readFile(f, "utf8")); } catch { /* suivant */ } }
      return null;
    };
  const out = new Array(keys.length); let next = 0;
  const worker = async () => { while (next < keys.length) { const i = next++; let v = null; try { v = await read(keys[i]); } catch { v = null; } out[i] = v ? { key: keys[i], value: v } : null; } };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return out.filter(Boolean);
}

// Liste les enregistrements dont la clé commence par prefix ("" = tout). Volume modeste : la boutique n'a pas vocation à des millions de lignes.
export async function listRecords(prefix = "") {
  return getRecords(await listKeys(prefix));
}

// Ce que la boutique peut afficher au client (jamais les données complètes).
export function publicView(order) {
  if (!order) return null;
  return {
    orderId: order.orderId, status: order.status, mode: order.mode || null, code: order.code || null,
    redeemUrl: order.result && order.result.redeemUrl || null,
    expiresIn: order.result && order.result.expiresIn || null,
    last4: order.result && order.result.last4 || null,
    paymentReleased: !!order.paymentReleased
  };
}
