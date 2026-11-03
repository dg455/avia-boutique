// Stockage des commandes en attente de paiement et de leurs résultats.
// En production : Netlify Blobs (magasin « orders » du site). En local : un fichier JSON temporaire.
//
// Une commande passe par : pending (session de paiement créée) → issuing (paiement autorisé, émission en cours)
// → issued (carte créée et chargée, paiement capturé) ou failed (rien débité).

import { readFile, writeFile, mkdir } from "node:fs/promises";
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

// Ce que la boutique peut afficher au client (jamais les données complètes).
export function publicView(order) {
  if (!order) return null;
  return {
    orderId: order.orderId, status: order.status, mode: order.mode || null, code: order.code || null,
    redeemUrl: order.result && order.result.redeemUrl || null,
    expiresIn: order.result && order.result.expiresIn || null,
    last4: order.result && order.result.last4 || null
  };
}
