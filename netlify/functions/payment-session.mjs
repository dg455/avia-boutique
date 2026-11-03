// POST /api/payment-session — ouvre une session de paiement hébergée (Paytently).
//
// À brancher dès réception de la documentation marchand. Flux prévu :
//   1. la boutique appelle cette fonction avec l'identifiant de commande, le montant et l'e-mail ;
//   2. la fonction crée la session chez le prestataire et renvoie redirectUrl ;
//   3. le client paie sur la page hébergée (aucune donnée de carte bancaire ne transite par la boutique) ;
//   4. le prestataire notifie /api/payment-webhook (à créer), qui déclenche l'émission puis la capture ;
//      création refusée → annulation de l'autorisation, aucun débit.
//
// Variables prévues : PAYMENT_PROVIDER=paytently, PAYTENTLY_API_URL, PAYTENTLY_API_KEY, PAYTENTLY_WEBHOOK_SECRET.

export const config = { path: "/api/payment-session" };

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Méthode non autorisée." }), { status: 405, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const provider = process.env.PAYMENT_PROVIDER || "simulated";
  if (provider !== "paytently" || !process.env.PAYTENTLY_API_KEY) {
    return new Response(JSON.stringify({ ok: false, code: "NOT_CONFIGURED", error: "Le paiement en ligne n'est pas encore activé sur cette boutique." }), {
      status: 501, headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  // Intégration à écrire avec la documentation du prestataire.
  return new Response(JSON.stringify({ ok: false, code: "NOT_IMPLEMENTED", error: "Intégration du prestataire en attente de sa documentation." }), {
    status: 501, headers: { "content-type": "application/json; charset=utf-8" }
  });
};
