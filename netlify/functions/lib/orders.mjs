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

// Enregistrements techniques (codes de vérification e-mail, etc.) : même magasin, clé préfixée.
function recordFile(key) { return join(LOCAL_DIR, String(key).replace(/[^A-Za-z0-9._-]/g, "_") + ".json"); }
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

// Liste les enregistrements dont la clé commence par prefix ("" = tout). Volume modeste : la boutique n'a pas vocation à des millions de lignes.
export async function listRecords(prefix = "") {
  const store = await blobStore();
  if (store) {
    const out = []; let cursor;
    do {
      const page = await store.list({ prefix, cursor, paginate: true });
      for (const b of page.blobs || []) { const v = await store.get(b.key, { type: "json" }); if (v) out.push({ key: b.key, value: v }); }
      cursor = page.cursor;
    } while (cursor);
    return out;
  }
  let names = []; try { names = await readdir(LOCAL_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    const key = n.replace(/\.json$/, "");
    if (!key.startsWith(prefix.replace(/[^A-Za-z0-9._-]/g, "_"))) continue;
    try { out.push({ key, value: JSON.parse(await readFile(join(LOCAL_DIR, n), "utf8")) }); } catch { /* ignoré */ }
  }
  return out;
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
