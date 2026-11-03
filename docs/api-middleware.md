# Middleware : ce que la boutique utilise

Deux appels suffisent au parcours particulier. Référence : le Swagger de chaque environnement fait foi ; ce document résume ce qui a été vérifié sur les échanges de production d'octobre–novembre 2026.

## Authentification

- Identifiants Basic (utilisateur API créé dans la console du middleware) + clé API dans un en-tête dédié.
- Liste blanche d'IP possible côté middleware : les fonctions Netlify n'ont pas d'IP fixe (voir `OUTBOUND_PROXY_URL`).
- Idempotence : en-tête `x-unique-id` (la boutique envoie l'identifiant de commande).

## 1. Créer le client, le compte et la carte

`POST /customers`

```json
{
  "first_name": "Jean",
  "last_name": "Dupont",
  "birth_date": "1980-05-14",
  "gender": "M",
  "mobile_number": "612345678",
  "mobile_number_dialing_code": "+33",
  "nationality": "FRA",
  "email": "jean.dupont@example.com",
  "card": { "style": "01", "emboss_name": "JEAN DUPONT" },
  "account": { "name": "Voucher", "currency": "EUR" }
}
```

- `emboss_name` est obligatoire (constaté le 3 novembre 2026 : sans lui, la page carte s'arrête à l'étape 2) : majuscules, chiffres, espaces, tirets et points, sans accent, 21 caractères maximum.
- `mobile_number` sans le 0 initial ; `nationality` en ISO 3166-1 alpha-3.
- Réponse : `id` (client), `account.id`, `card.id`, `card.redeemable_code.uri` (lien d'activation) et `card.redeemable_code.expires_in` (secondes). Toujours lire `expires_in`, ne jamais le coder en dur.
- Le lien d'activation est à usage unique. Il n'existe pas d'endpoint de régénération dans le middleware.
- Le caractère `+` dans une adresse e-mail est refusé (constaté le 3 novembre 2026).

## 2. Charger la carte

`POST /accounts/{account_id}/credit`

```json
{ "transaction_code": "AccountLoad", "amount": 10000, "description": "Boutique <commande>" }
```

- `amount` en centimes : `10000` = 100,00 €. `VoucherLoad` n'est pas configuré pour ce programme (erreur 403 → 424).
- Réponse : `transaction_id`.
- Après un délai dépassé ou une erreur 5xx, ne pas renvoyer le crédit sans vérification : il pourrait être comptabilisé deux fois.

## Règles du programme (telles que configurées)

- Une carte par personne et par 30 jours, contrôlée par le couple e-mail + mobile.
- Données obligatoires : prénom, nom, date de naissance, civilité, nationalité, e-mail, mobile.
- Plafond plateforme 150 € ; plafond du programme AVIA 100 €.
- Le lien d'activation est envoyé par SMS par la plateforme ; la boutique l'affiche aussi et peut l'envoyer par e-mail.
- Portefeuille : Google en push, Apple par saisie manuelle du numéro tant que la certification n'est pas faite.
