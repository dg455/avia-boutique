// Configuration de la boutique (marque blanche).
// Tout ce qui change d'un déploiement à l'autre est ici : marque, produits, textes légaux, contacts.
// Les secrets (identifiants API, code d'accès) ne sont JAMAIS ici : ils vivent dans les variables
// d'environnement Netlify (voir README).

window.SHOP_CONFIG = {
  tenant: "avia",

  brand: {
    // Nom du programme tel qu'il apparaît à l'écran.
    name: "AVIA",
    // Nom complet de la carte.
    cardName: "Carte carburant AVIA",
    // Logo du partenaire : chemin d'un fichier dans /assets. Laisser vide pour afficher le nom en texte.
    partnerLogo: "",
    // Mention de l'opérateur de la boutique.
    operator: "SoShop.Club",
    operatorLogo: "/assets/logo-soshop.png",
    operatorUrl: "https://soshop.club",
    // Couleurs du programme (le reste de la palette est dans styles.css).
    accent: "#E1251B",
    accentDeep: "#B8160F"
  },

  // Produits en vente. Montants en centimes.
  // priceCents = ce que paie le client ; faceCents = ce qu'il reçoit sur la carte.
  discountPct: 4,
  products: [
    { id: "avia-50",  faceCents: 5000,  priceCents: 4800,  label: "50 €" },
    { id: "avia-100", faceCents: 10000, priceCents: 9600,  label: "100 €", default: true },
    // Carte de test en production : visible seulement avec ?test=1 dans l'adresse (mémorisé sur l'appareil).
    { id: "avia-test-1", faceCents: 100, priceCents: 100, label: "1 € (test)", test: true }
  ],

  // Règles du programme affichées au client (informatives).
  rules: {
    maxFaceCents: 10000,          // plafond par carte pour ce programme
    oneCardPer30Days: true,       // une carte par personne et par 30 jours
    validityMonths: 12,
    usage: "le carburant, la boutique et le lavage dans les stations AVIA"
  },

  // Paiement : "simulated" (démonstration, aucun débit) ou "paytently" (page de paiement hébergée).
  payment: {
    provider: "simulated"
  },

  // Entreprises : commande par virement (aucun PSP nécessaire).
  business: {
    enabled: true,
    minCards: 5,
    contactEmail: "info@soshop.club"
  },

  support: {
    phone: "0 811 880 200",
    phoneNote: "service client porteurs, prix d'un appel local",
    email: "info@soshop.club"
  },

  legal: {
    operatorCompany: "SoShop SAS",
    operatorAddress: "14 rue de Bassano, 75116 Paris",
    operatorRegistration: "SIREN 922 466 925",
    issuerLine: "La carte est émise par un établissement de monnaie électronique agréé, membre du réseau Mastercard.",
    termsUrl: "/cg.html",
    privacyNote: "Vos informations servent uniquement à créer votre carte et à respecter les obligations de l'émetteur. Elles ne sont ni vendues ni utilisées à d'autres fins."
  }
};
