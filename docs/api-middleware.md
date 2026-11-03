# Middleware : ce que la boutique utilise

Deux appels suffisent au parcours particulier. Référence : le Swagger de chaque environnement fait foi ; ce document résume ce qui a été vérifié sur les échanges de production d'octobre–novembre 2026.

## Authentification

- Identifiants Basic (utilisateur API créé dans la console du middleware) + clé API dans l'en-tête `x-api-key` (16 à 40 caractères alphanumériques).
- Swagger : `<base>/swagger/index.html` (spec `/swagger/v1/swagger.json`, OpenAPI 3.0.4, « MiddlewareApi v1 ») — deux endpoints seulement : `POST /customers` et `POST /accounts/{account_id}/credit`.
- Liste blanche d'IP possible côté middleware : les fonctions Netlify n'ont pas d'IP fixe (voir `OUTBOUND_PROXY_URL`).
- En-tête `x-unique-id` : 10 à 36 caractères `[A-Za-z0-9-._]`, unique pour toutes les requêtes (la boutique envoie l'identifiant de commande pour la création, et `L` + cet identifiant sans tirets pour le chargement).

## 1. Créer le client, le compte et la carte

`POST /customers`

```json
{
  "first_name": "Jean",
  "last_name": "Dupont",
  "birth_date": "1980-05-14",
  "mobile_number": "612345678",
  "mobile_number_dialing_code": "+33",
  "nationality": "FRA",
  "email": "jean.dupont@example.com",
  "card": { "style": "01", "emboss_name": "JEAN DUPONT" },
  "account": { "name": "Voucher", "currency": "EUR" }
}
```

- Aucun champ de civilité dans le contrat ; tout champ inconnu est refusé (`additionalProperties: false`).
- `emboss_name` est obligatoire en pratique (constaté le 3 novembre 2026 : sans lui, la page carte s'arrête à l'étape 2) : lettres A-Z, espaces, tirets et points seulement (le Swagger n'admet pas de chiffres), sans accent, 21 caractères maximum.
- `first_name` / `last_name` : 50 caractères max, sans chiffres ni `_!¡?÷¿/\+=@#$%ˆ&*(){}|~<>;:[]`, sans double espace.
- Les identifiants renvoyés (client `9…`, compte `8…`, carte `7…`) sont des entiers de 18 chiffres, au-delà de la précision de `Number` : la boutique les lit comme des chaînes.
- `200` = créé ; `206` = création partielle (identifiant de compte à vérifier avant de charger).
- `mobile_number` sans le 0 initial ; `nationality` en ISO 3166-1 alpha-3.
- Réponse : `id` (client), `account.id`, `card.id`, `card.redeemable_code.uri` (lien d'activation) et `card.redeemable_code.expires_in` (secondes). Toujours lire `expires_in`, ne jamais le coder en dur.
- Le lien d'activation est à usage unique. Il n'existe pas d'endpoint de régénération dans le middleware.
- Le caractère `+` dans une adresse e-mail est refusé (constaté le 3 novembre 2026).
- Un second client avec un **mobile déjà utilisé** est refusé par la plateforme : réponse `424` avec `code: 4245001` (constaté le 3 novembre 2026 en staging : e-mail neuf + même mobile → 4245001 ; e-mail neuf + mobile neuf, même nom et même date de naissance → carte émise). Le nom et l'e-mail ne comptent pas, la clé est le mobile. La boutique traduit ce code en `DUPLICATE` (liste réglable par `MW_DUPLICATE_CODES`).

## 2. Charger la carte

`POST /accounts/{account_id}/credit`

```json
{ "transaction_code": "AccountLoad", "amount": 10000, "description": "Boutique <commande>" }
```

- `amount` en centimes : `10000` = 100,00 €. `VoucherLoad` n'est pas configuré pour ce programme (erreur 403 → 424).
- `description` : 100 caractères max, lettres, chiffres, `- . ? '` et espaces.
- Réponse : `transaction_id`.
- Après un délai dépassé ou une erreur 5xx, ne pas renvoyer le crédit sans vérification : il pourrait être comptabilisé deux fois.

## Règles du programme (telles que configurées)

- Une carte par personne et par 30 jours, contrôlée par le couple e-mail + mobile.
- Données obligatoires : prénom, nom, date de naissance, civilité, nationalité, e-mail, mobile.
- Plafond plateforme 150 € ; plafond du programme AVIA 100 €.
- Le lien d'activation est envoyé par SMS par la plateforme ; la boutique l'affiche aussi et peut l'envoyer par e-mail.
- Portefeuille : Google en push, Apple par saisie manuelle du numéro tant que la certification n'est pas faite.
