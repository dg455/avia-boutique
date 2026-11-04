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
  audience.html         tableau de bord d'audience (derrière la porte d'entrée) : /audience.html
netlify/functions/
  issue-card.mjs              POST /api/issue-card : commande avec paiement simulé (démonstration, tests)
  payment-session.mjs         POST /api/payment-session : enregistre la commande, ouvre Stripe Checkout
  stripe-webhook.mjs          POST /api/stripe-webhook : paiement autorisé → déclenche l'émission
  issue-worker-background.mjs POST /api/issue-worker : émission en arrière-plan, puis capture ou annulation du paiement
  order-status.mjs            GET  /api/order-status : avancement d'une commande (suivi par la boutique)
  email-code.mjs              POST /api/email-code/send, /verify : vérification de l'adresse e-mail par code avant paiement
  trace.mjs                   POST /api/trace : trace d'étape du parcours (audience, sans cookie ni IP)
  audience.mjs                GET  /api/audience?from&to : audience agrégée (sessions, entonnoir, appareils, lieux, commandes)
  health.mjs                  GET  /api/health : état de la configuration (sans secret)
  lib/middleware.mjs          client du middleware (création client + carte, chargement)
  lib/issue.mjs               émission (simulation ou réel), catalogue serveur, validation
  lib/orders.mjs              commandes (Netlify Blobs en production, fichier local en test)
  lib/stripe.mjs              client Stripe, prestataire effectif, jeton interne
  lib/verify.mjs              code de vérification e-mail (6 chiffres, 10 min, 5 essais) et jeton d'adresse vérifiée (24 h)
netlify/edge-functions/
  gate.ts               porte d'entrée : tout le site derrière un code d'accès
tests/                  test local des fonctions, serveur de développement
docs/                   notes techniques
```

## Modes

| | Émission | Paiement |
|---|---|---|
| **Simulation** (aucune variable `MW_*`) | identifiants fictifs, lien vers `demo-carte.html` | formulaire fictif, aucun débit |
| **Réel** (`MW_BASE_URL` renseignée) | appels au middleware | `PAYMENT_PROVIDER=stripe` (Stripe Checkout) ou `paytently` (à brancher) ; un paiement simulé est refusé sauf `ALLOW_SIMULATED_PAYMENT=true` (tests de production) |

Paiement réel : autorisation seule à la caisse, carte créée et chargée, puis capture ; création refusée → autorisation annulée, zéro débit. Tant que l'émission est simulée (pas de `MW_BASE_URL`), un paiement Stripe réel est toujours annulé après le parcours : on ne capture jamais pour une carte fictive. Une commande se suit sur `/api/order-status` : `pending` → `issuing` → `processing` → `issued` ou `failed` ; au retour de la caisse, la session Stripe est vérifiée directement, donc le webhook n'est pas indispensable (il couvre le client qui ferme son navigateur avant de revenir).

Le mode courant se lit sur `/api/health`.

## Variables d'environnement (Netlify → Site configuration → Environment variables)

| Variable | Rôle |
|---|---|
| `SHOP_ACCESS_CODE` | code de la porte d'entrée (défaut `Avia2026` ; `open` = boutique ouverte au public) |
| `ADMIN_CODE` | code de l'espace admin (`/audience`, `/api/audience`) ; à défaut, le code de la boutique tant qu'elle est fermée — boutique ouverte sans `ADMIN_CODE` = admin inaccessible |
| `MW_BASE_URL` | URL de base du middleware (absente = simulation) |
| `MW_BASIC_USER`, `MW_BASIC_PASS` | identifiants Basic de l'utilisateur API |
| `MW_API_KEY`, `MW_API_KEY_HEADER` | clé API et nom de son en-tête (défaut `x-api-key`) |
| `MW_CARD_STYLE`, `MW_ACCOUNT_NAME` | style de carte (`01`) et nom du compte (`Voucher`) |
| `MW_ENVIRONMENT` | `production` (défaut) ou `staging` : en staging les cartes sont des cartes de test, le paiement simulé est accepté et un paiement Stripe n'est jamais capturé |
| `OUTBOUND_PROXY_URL` | proxy HTTP à IP fixe (ex. QuotaGuard Static : `http://user:pass@eu-west-static-01.quotaguard.com:9293`), parce que le middleware exige une liste blanche d'IP ; les fonctions Netlify n'ont pas d'IP fixe |
| `ALLOW_SIMULATED_PAYMENT` | `true` pour émettre sans paiement en mode réel (tests seulement) |
| `PAYMENT_PROVIDER` | `simulated` (défaut), `stripe` ou `paytently` |
| `STRIPE_SECRET_KEY` | clé API Stripe (clé restreinte : Checkout Sessions, PaymentIntents, Refunds en écriture) |
| `STRIPE_WEBHOOK_SECRET` | secret de signature du point de terminaison webhook |
| `STRIPE_DESCRIPTOR_SUFFIX` | libellé sur le relevé bancaire du client (défaut `CARTE AVIA`) |
| `SHOP_CARD_NAME` | nom du produit sur la page de paiement (défaut `Carte carburant AVIA`) |
| `PRODUCTS_JSON` | catalogue serveur si différent de celui du code (`[{"id","faceCents","priceCents"}]`) |
| `INTERNAL_TOKEN` | jeton de la fonction d'arrière-plan (dérivé du code d'accès si absent) |

## Déploiement

1. Netlify → **Add new project** → **Import an existing project** → GitHub → ce dépôt, branche `main`. Le `netlify.toml` fixe le dossier publié (`public`) et les fonctions ; aucune commande de build.
2. Renseigner les variables d'environnement ci-dessus (au minimum `SHOP_ACCESS_CODE`).
3. Déployer. La porte d'entrée s'applique à tout le site ; les fonctions `/api/*` exigent le même cookie.
4. Domaine : ajouter le sous-domaine voulu dans **Domain management**, puis le CNAME chez le registrar.

Chaque `git push` sur `main` redéploie.

### Stripe (période bêta)

1. Stripe → Developers → API keys → **Create restricted key** : Checkout Sessions *write*, PaymentIntents *write*, Refunds *write*. La coller dans `STRIPE_SECRET_KEY`.
2. Stripe → Developers → Webhooks → **Add endpoint** : `https://<site>/api/stripe-webhook`, événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`. Coller le *signing secret* dans `STRIPE_WEBHOOK_SECRET`.
3. `PAYMENT_PROVIDER=stripe`, puis redéployer. `/api/health` doit répondre `"payment":"stripe"`.

Le compte Stripe encaisse au nom de son titulaire : le libellé sur le relevé du client sera celui du compte suivi du suffixe `STRIPE_DESCRIPTOR_SUFFIX`. Les commandes et leurs résultats sont dans Netlify Blobs (magasin `orders`). Le formulaire entreprise est un formulaire Netlify (`commande-entreprise`) : les demandes apparaissent dans **Forms**, où l'on peut activer une notification par e-mail.

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
- Contrat du middleware vérifié sur son Swagger (en-tête `x-api-key`, pas de champ de civilité, identifiants de 18 chiffres lus en chaînes) : voir `docs/api-middleware.md`.


## Remise du lien d'activation au porteur (e-mail, SMS)

La plateforme émettrice n'envoie rien au porteur : le lien d'activation est renvoyé à la boutique, qui l'affiche à l'écran et peut l'envoyer.

- **E-mail (gratuit)** par SMTP — par exemple le compte Google Workspace de la boutique avec un mot de passe d'application : `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=info@soshop.club`, `SMTP_PASS=<mot de passe d'application>`, `MAIL_FROM="AVIA by SoShop.Club <info@soshop.club>"`. Sans ces variables, aucun e-mail n'est envoyé et la page affiche seulement le lien et le QR code.
- **SMS (payant, coupé par défaut)** via Brevo : `BREVO_API_KEY`, `SMS_SENDER=AVIA`, `DELIVERY_SMS=true`.
- Le message contient un **lien court** `https://<boutique>/c/REF` (REF = référence de commande) qui mène à la page de guidage (Android / iPhone) portant le lien d'activation ; le lien d'activation lui-même ne s'ouvre qu'une fois. `SHOP_PUBLIC_ORIGIN` fixe l'origine de ces liens courts si elle diffère de celle des commandes.
- `/api/health` indique `delivery.email` et `delivery.sms` ; `/api/mail-check` (porte d'entrée ou `?code=`) envoie un e-mail de test à une adresse soshop.club (`?to=`, défaut damien@soshop.club) sans émettre de carte.
- `POST /api/resend-link { orderId }` renvoie l'e-mail à l'adresse de la commande (bouton « renvoyez l'e-mail » sous le lien ; 3 renvois au plus, une minute entre deux).

## Vérification de l'adresse e-mail (code avant paiement)

Dès que l'envoi d'e-mail est configuré, la boutique envoie un code à 6 chiffres à l'adresse saisie et ne laisse pas payer tant qu'il n'est pas recopié (une faute de frappe produirait une carte payée que personne ne reçoit, et l'adresse part chez l'émetteur). Code valable 10 minutes, 5 essais ; 1 envoi par minute et 5 par heure par adresse. L'adresse vérifiée donne un jeton signé (24 h) que `/api/payment-session` et `/api/issue-card` exigent pour cette adresse (`403 EMAIL_UNVERIFIED` sinon). `EMAIL_VERIFICATION=false` pour couper. `/api/health` indique `emailVerification`.

## Google Wallet (Android) en deux temps

Le lien d'activation ne s'ouvre qu'une fois : la page « carte prête » demande d'abord de préparer Google Wallet (bouton « intent » Android : ouvre Wallet s'il est installé, sinon sa fiche Play Store), puis seulement déverrouille « Ajouter ma carte à Google Wallet », qui ouvre le lien dans Chrome où se trouve le bouton de la plateforme. L'état « Wallet prêt » est mémorisé sur l'appareil (session).

## Audience (qui vient, jusqu'où, et où ça décroche)

À chaque écran du parcours, la boutique envoie une trace à `POST /api/trace` : identifiant de session volatil (sessionStorage, jamais de cookie), écran atteint, type d'appareil, pays et ville fournis par Netlify, langue, provenance, identifiant de commande une fois connu. Aucune adresse IP ni donnée personnelle n'est conservée. Les traces sont dans le magasin `orders` (clés `trace:AAAA-MM-JJ:…`).

`GET /api/audience?from=AAAA-MM-JJ&to=AAAA-MM-JJ` (porte d'entrée) agrège la période : sessions, entonnoir étape par étape avec taux de passage, dernière étape vue avant abandon, appareils, villes, pays, heures d'arrivée, jours, provenance, erreurs affichées, commandes (statut, produit, e-mail masqué, e-mail envoyé) et dernières sessions. La page `/audience` l'affiche (7 derniers jours par défaut) ; l'un et l'autre exigent le code admin (`ADMIN_CODE`), demandé par la même page d'entrée, cookie valable 12 h.
