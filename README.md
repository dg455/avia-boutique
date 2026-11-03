# Boutique carte virtuelle (marque blanche)

Boutique en ligne de la carte carburant virtuelle : le client choisit un montant, donne les informations exigées par l'émetteur, paie, et reçoit sa carte sur son téléphone en moins d'une minute, sans application. Un parcours entreprise permet de commander des cartes pour des salariés, réglées par virement.

La même base sert plusieurs boutiques : tout ce qui change d'un déploiement à l'autre (marque, couleurs, produits, textes, contacts) est dans `public/config.js` ; les secrets sont dans les variables d'environnement Netlify.

## Structure

```
public/                 site (statique)
  index.html            tous les écrans du parcours
  app.js                logique d'écran, validation, appels API
  config.js             configuration de la boutique (marque blanche)
  styles.css            feuille de style
  gate.html             page d'entrée (code d'accès), à nos couleurs
  cg.html               conditions générales du porteur, données personnelles
  demo-carte.html       page carte de démonstration (mode simulation uniquement)
netlify/functions/
  issue-card.mjs        POST /api/issue-card : création + chargement de la carte
  health.mjs            GET  /api/health : état de la configuration (sans secret)
  payment-session.mjs   POST /api/payment-session : paiement hébergé (à brancher)
  lib/middleware.mjs    client du middleware (création client + carte, chargement)
netlify/edge-functions/
  gate.ts               porte d'entrée : tout le site derrière un code d'accès
tests/                  test local des fonctions, serveur de développement
docs/                   notes techniques
```

## Modes

| | Émission | Paiement |
|---|---|---|
| **Simulation** (aucune variable `MW_*`) | identifiants fictifs, lien vers `demo-carte.html` | formulaire fictif, aucun débit |
| **Réel** (`MW_BASE_URL` renseignée) | appels au middleware | `PAYMENT_PROVIDER=paytently` (à brancher) ; un paiement simulé est refusé sauf `ALLOW_SIMULATED_PAYMENT=true` (tests de production) |

Le mode courant se lit sur `/api/health`.

## Variables d'environnement (Netlify → Site configuration → Environment variables)

| Variable | Rôle |
|---|---|
| `SHOP_ACCESS_CODE` | code de la porte d'entrée (défaut `Avia2026` ; `open` = boutique ouverte au public) |
| `MW_BASE_URL` | URL de base du middleware (absente = simulation) |
| `MW_BASIC_USER`, `MW_BASIC_PASS` | identifiants Basic de l'utilisateur API |
| `MW_API_KEY`, `MW_API_KEY_HEADER` | clé API et nom de son en-tête (défaut `x-api-key`) |
| `MW_CARD_STYLE`, `MW_ACCOUNT_NAME` | style de carte (`01`) et nom du compte (`Voucher`) |
| `OUTBOUND_PROXY_URL` | proxy HTTP à IP fixe, si le middleware exige une liste blanche d'IP |
| `ALLOW_SIMULATED_PAYMENT` | `true` pour émettre sans paiement en mode réel (tests seulement) |
| `PAYMENT_PROVIDER` | `simulated` (défaut) ou `paytently` |

## Déploiement

1. Netlify → **Add new project** → **Import an existing project** → GitHub → ce dépôt, branche `main`. Le `netlify.toml` fixe le dossier publié (`public`) et les fonctions ; aucune commande de build.
2. Renseigner les variables d'environnement ci-dessus (au minimum `SHOP_ACCESS_CODE`).
3. Déployer. La porte d'entrée s'applique à tout le site ; les fonctions `/api/*` exigent le même cookie.
4. Domaine : ajouter le sous-domaine voulu dans **Domain management**, puis le CNAME chez le registrar.

Chaque `git push` sur `main` redéploie. Le formulaire entreprise est un formulaire Netlify (`commande-entreprise`) : les demandes apparaissent dans **Forms**, où l'on peut activer une notification par e-mail.

## Tests en local

```
npm test                      # fonctions : simulation, porte fermée, validation, mode réel contre un faux middleware
node tests/dev-server.mjs     # http://localhost:8788 (site + fonctions, sans la porte d'entrée)
```

## Une seconde boutique (autre marque)

Dupliquer le dépôt ou créer une branche, modifier `public/config.js` (nom, logo dans `public/assets/`, couleurs, produits, contacts) et déployer un second projet Netlify avec ses propres variables.

## Reste à faire

- Paiement hébergé Paytently : `payment-session.mjs` + webhook de confirmation → émission → capture.
- Entreprises : traitement du fichier salariés (émission en lot après réception du virement).
- Champ `gender` et nom exact de l'en-tête de clé API : à confirmer avec le Swagger du middleware.
