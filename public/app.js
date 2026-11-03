/* Boutique carte virtuelle — logique d'écran (sans framework).
   Parcours particulier : accueil → e-mail → (client reconnu) → coordonnées → récapitulatif → paiement → création → carte prête.
   Parcours entreprise : formulaire → confirmation (commande réglée par virement). */

(function () {
  "use strict";

  const CFG = window.SHOP_CONFIG;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ----- Données de référence -----
  const NATIONALITIES = [
    ["FRA", "Française"], ["BEL", "Belge"], ["CHE", "Suisse"], ["LUX", "Luxembourgeoise"], ["DEU", "Allemande"],
    ["ESP", "Espagnole"], ["ITA", "Italienne"], ["PRT", "Portugaise"], ["GBR", "Britannique"], ["NLD", "Néerlandaise"],
    ["IRL", "Irlandaise"], ["AUT", "Autrichienne"], ["POL", "Polonaise"], ["ROU", "Roumaine"], ["GRC", "Grecque"],
    ["SWE", "Suédoise"], ["DNK", "Danoise"], ["NOR", "Norvégienne"], ["FIN", "Finlandaise"], ["CZE", "Tchèque"],
    ["HUN", "Hongroise"], ["BGR", "Bulgare"], ["HRV", "Croate"], ["SVK", "Slovaque"], ["SVN", "Slovène"],
    ["LTU", "Lituanienne"], ["LVA", "Lettone"], ["EST", "Estonienne"], ["MAR", "Marocaine"], ["DZA", "Algérienne"],
    ["TUN", "Tunisienne"], ["SEN", "Sénégalaise"], ["CIV", "Ivoirienne"], ["CMR", "Camerounaise"], ["MDG", "Malgache"],
    ["COM", "Comorienne"], ["MUS", "Mauricienne"], ["TUR", "Turque"], ["USA", "Américaine"], ["CAN", "Canadienne"],
    ["BRA", "Brésilienne"], ["ARG", "Argentine"], ["MEX", "Mexicaine"], ["CHN", "Chinoise"], ["JPN", "Japonaise"],
    ["IND", "Indienne"], ["VNM", "Vietnamienne"], ["LBN", "Libanaise"], ["AUS", "Australienne"], ["UKR", "Ukrainienne"]
  ];
  const DIALING = [
    ["+33", "+33 FR"], ["+32", "+32 BE"], ["+41", "+41 CH"], ["+352", "+352 LU"],
    ["+262", "+262 RE/YT"], ["+590", "+590 GP"], ["+596", "+596 MQ"], ["+594", "+594 GF"],
    ["+49", "+49 DE"], ["+34", "+34 ES"], ["+39", "+39 IT"], ["+351", "+351 PT"], ["+44", "+44 GB"],
    ["+31", "+31 NL"], ["+212", "+212 MA"], ["+213", "+213 DZ"], ["+216", "+216 TN"]
  ];

  // ----- Utilitaires -----
  const fmt = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const money = (cents) => fmt.format(cents / 100).replace(/ /g, " ");
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "o-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const emboss = (first, last) => (first + " " + last).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 .-]/g, "").replace(/\s+/g, " ").trim().slice(0, 21);
  const maskPhone = (dial, n) => dial + " " + n.slice(0, 1) + " •• •• •• " + n.slice(-2);
  const maskEmail = (e) => { const [u, d] = e.split("@"); return (u.length > 2 ? u.slice(0, 2) : u) + "•••@" + d; };

  // ----- Mode test : ?test=1 affiche les produits de test (mémorisé), ?test=0 les cache -----
  (function () { try { const q = new URLSearchParams(location.search).get("test"); if (q === "1") localStorage.setItem("shop_test", "1"); if (q === "0") localStorage.removeItem("shop_test"); } catch (e) {} })();
  const testMode = (() => { try { return localStorage.getItem("shop_test") === "1"; } catch (e) { return false; } })();
  CFG.products = CFG.products.filter((p) => !p.test || testMode);

  // ----- État -----
  const state = load() || { product: defaultProduct(), email: "", person: null, orderId: null, result: null };
  function defaultProduct() { return (CFG.products.find((p) => p.default) || CFG.products[0]).id; }
  function product() { return CFG.products.find((p) => p.id === state.product) || CFG.products[0]; }
  function save() { try { sessionStorage.setItem("shop_order", JSON.stringify(state)); } catch (e) {} }
  function load() { try { return JSON.parse(sessionStorage.getItem("shop_order") || "null"); } catch (e) { return null; } }
  function known() { try { return JSON.parse(localStorage.getItem("shop_known") || "{}"); } catch (e) { return {}; } }
  function remember(email, person) { try { const k = known(); k[email.toLowerCase()] = person; localStorage.setItem("shop_known", JSON.stringify(k)); } catch (e) {} }

  // ----- Marque -----
  function paintBrand() {
    document.documentElement.style.setProperty("--accent", CFG.brand.accent);
    document.documentElement.style.setProperty("--accent-deep", CFG.brand.accentDeep);
    if (CFG.brand.navy) document.documentElement.style.setProperty("--ink", CFG.brand.navy);
    const brand = $("#brand-link");
    brand.innerHTML = CFG.brand.partnerLogo
      ? `<img src="${esc(CFG.brand.partnerLogo)}" alt="${esc(CFG.brand.name)}"><span class="brand-by">by</span><img class="brand-op" src="${esc(CFG.brand.operatorLogo)}" alt="${esc(CFG.brand.operator)}">`
      : `<span class="brand-name">${esc(CFG.brand.name)}</span><span class="brand-sub">Carte virtuelle</span>`;
    $("#cv-brand").textContent = CFG.brand.name;
    $("#cv-brand-2").textContent = CFG.brand.name;
    if (CFG.brand.cardImage) {
      $$(".card-visual").forEach((cv) => { cv.classList.add("has-image"); cv.style.backgroundImage = `url("${CFG.brand.cardImage}")`; });
    }
    $("#home-lead").textContent = `Remise de ${CFG.discountPct} % sur ${CFG.rules.usage}. La carte arrive sur votre téléphone en moins d'une minute, sans application.`;
    $("#benefit").innerHTML = `<strong>Comment ça marche.</strong> Vous payez ${money(product().priceCents)}, votre carte est créditée de ${money(product().faceCents)}. Elle fonctionne dans toutes les stations ${esc(CFG.brand.name)} pendant ${CFG.rules.validityMonths} mois.`;
    $("#privacy-note").textContent = CFG.legal.privacyNote;
    $("#terms-link").href = CFG.legal.termsUrl;
    $("#footer-terms").href = CFG.legal.termsUrl;
    $("#footer-operator").innerHTML = `<img src="${esc(CFG.brand.operatorLogo)}" alt=""><span>Un service ${esc(CFG.brand.operator)}</span>`;
    $("#footer-legal").textContent = `${CFG.legal.operatorCompany}, ${CFG.legal.operatorAddress}. ${CFG.legal.operatorRegistration}.`;
    $("#footer-issuer").textContent = CFG.legal.issuerLine;
    $("#footer-support").textContent = `Service client : ${CFG.support.phone} (${CFG.support.phoneNote}).`;
    $("#biz-note").textContent = `Minimum ${CFG.business.minCards} cartes. Nous revenons vers vous sous un jour ouvré à l'adresse indiquée.`;
    if (!CFG.business.enabled) { $("#biz-entry").hidden = true; $("#nav-business").hidden = true; }
    document.title = `${CFG.brand.cardName} — carte virtuelle`;
  }

  // ----- Accueil : produits -----
  function paintProducts() {
    const box = $("#choices");
    box.innerHTML = CFG.products.map((p) => `
      <button type="button" class="choice" data-id="${esc(p.id)}" aria-pressed="${p.id === state.product}">
        <div class="c-face">${money(p.faceCents)}</div>
        <div class="c-price">${p.test ? "test de production" : "pour " + money(p.priceCents)}</div>
      </button>`).join("");
    $$(".choice", box).forEach((b) => b.addEventListener("click", () => { state.product = b.dataset.id; save(); paintProducts(); paintPrice(); }));
    paintPrice();
  }
  function paintPrice() {
    const p = product();
    $("#cv-amount").textContent = money(p.faceCents);
    $("#p-face").textContent = money(p.faceCents);
    $("#p-price").textContent = money(p.priceCents);
    $("#btn-pay-amount").textContent = money(p.priceCents);
    $("#pay-amount").textContent = money(p.priceCents);
    $("#creating-amount").textContent = money(p.faceCents);
    $("#benefit").innerHTML = `<strong>Comment ça marche.</strong> Vous payez ${money(p.priceCents)}, votre carte est créditée de ${money(p.faceCents)}. Elle fonctionne dans toutes les stations ${esc(CFG.brand.name)} pendant ${CFG.rules.validityMonths} mois.`;
    if (state.person) $("#cv-holder").textContent = emboss(state.person.first_name, state.person.last_name) || "Votre nom";
  }

  // ----- Listes -----
  function paintLists() {
    $("#f-nat").innerHTML = NATIONALITIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
    $("#f-dial").innerHTML = DIALING.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
    $("#b-face").innerHTML = CFG.products.map((p) => `<option value="${p.faceCents}" ${p.default ? "selected" : ""}>${money(p.faceCents)} (${money(p.priceCents)})</option>`).join("");
  }

  // ----- Validation -----
  function setError(input, on) {
    const field = input.closest(".field");
    if (field) field.classList.toggle("has-error", !!on);
    input.setAttribute("aria-invalid", on ? "true" : "false");
  }
  const isEmail = (v) => /^[^\s@+]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
  function isAdult(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const d = new Date(iso + "T00:00:00"); if (isNaN(d)) return false;
    const now = new Date(); const a = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate());
    return d <= a && d.getFullYear() > 1900;
  }
  function cleanMobile(dial, raw) {
    let n = String(raw).replace(/[^\d]/g, "");
    if (dial === "+33" && n.startsWith("33")) n = n.slice(2);
    if (n.startsWith("0")) n = n.slice(1);
    return n;
  }
  function mobileOk(dial, n) {
    if (dial === "+33") return /^[67]\d{8}$/.test(n);
    return /^\d{4,11}$/.test(n);
  }

  // ----- Écrans -----
  const screens = $$(".screen");
  function show(id) {
    screens.forEach((s) => s.classList.toggle("is-active", s.id === id));
    const sc = $("#" + id);
    const step = Number(sc.dataset.step || 0);
    $$(".steps", sc).forEach((bar) => {
      bar.innerHTML = [1, 2, 3, 4].map((i) => `<span class="${i < step ? "done" : i === step ? "now" : ""}"></span>`).join("");
    });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function route() {
    const full = location.hash || "#/";
    const [h, qs] = full.split("?");
    const q = new URLSearchParams(qs || "");
    const guardPerson = () => { if (!state.person) { location.replace("#/email"); return false; } return true; };
    switch (h) {
      case "#/": show("screen-home"); break;
      case "#/email": $("#f-email").value = state.email || ""; show("screen-email"); break;
      case "#/known": if (!state.person) { location.replace("#/email"); break; } paintKnown(); show("screen-known"); break;
      case "#/details": fillDetails(); show("screen-details"); break;
      case "#/review": if (guardPerson()) { paintReview(q.get("cancel") === "1"); show("screen-review"); } break;
      case "#/pay": if (guardPerson()) { paintPay(); show("screen-pay"); } break;
      case "#/creating": {
        // Retour du paiement hébergé : l'identifiant de commande est dans l'URL, la session peut avoir été perdue.
        const fromPayment = q.get("order");
        if (fromPayment) { state.orderId = fromPayment; save(); show("screen-creating"); runCreation(true); break; }
        if (guardPerson()) { show("screen-creating"); runCreation(false); }
        break;
      }
      case "#/ready": if (!state.result) { location.replace("#/"); break; } paintReady(); show("screen-ready"); break;
      case "#/error": show("screen-error"); break;
      case "#/entreprise": show("screen-business"); break;
      case "#/entreprise/ok": show("screen-business-done"); break;
      default: location.replace("#/");
    }
  }
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  window.addEventListener("hashchange", route);

  // ----- Accueil -----
  $("#btn-start").addEventListener("click", () => go("#/email"));

  // ----- E-mail -----
  $("#form-email").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#f-email"); const v = inp.value.trim().toLowerCase();
    if (!isEmail(v)) { setError(inp, true); inp.focus(); return; }
    setError(inp, false);
    state.email = v; save();
    const k = known()[v];
    if (k) { state.person = k; save(); go("#/known"); } else { go("#/details"); }
  });

  // ----- Client reconnu -----
  function paintKnown() {
    const p = state.person;
    $("#known-title").textContent = `Content de vous revoir, ${p.first_name}`;
    $("#known-summary").innerHTML = kv("Nom", `${p.first_name} ${p.last_name}`) + kv("E-mail", state.email) + kv("Mobile", maskPhone(p.dialing_code, p.mobile)) + kv("Date de naissance", frDate(p.birth_date));
  }
  $("#btn-known-ok").addEventListener("click", () => go("#/review"));
  $("#btn-known-edit").addEventListener("click", () => go("#/details"));

  // ----- Coordonnées -----
  function fillDetails() {
    const p = state.person; if (!p) return;
    $("#f-first").value = p.first_name || ""; $("#f-last").value = p.last_name || "";
    $("#f-birth").value = p.birth_date || ""; $("#f-nat").value = p.nationality || "FRA";
    $("#f-dial").value = p.dialing_code || "+33"; $("#f-mobile").value = p.mobile || "";
  }
  $("#form-details").addEventListener("submit", (e) => {
    e.preventDefault();
    let ok = true;
    const first = $("#f-first"), last = $("#f-last"), birth = $("#f-birth"), mob = $("#f-mobile"), dial = $("#f-dial").value;
    const fv = first.value.trim(), lv = last.value.trim();
    setError(first, !fv); setError(last, !lv); ok = ok && !!fv && !!lv;
    setError(birth, !isAdult(birth.value)); ok = ok && isAdult(birth.value);
    const n = cleanMobile(dial, mob.value);
    setError(mob, !mobileOk(dial, n)); ok = ok && mobileOk(dial, n);
    if (!ok) { ($(".has-error .input") || first).focus(); return; }
    state.person = {
      first_name: fv, last_name: lv, birth_date: birth.value,
      nationality: $("#f-nat").value, dialing_code: dial, mobile: n
    };
    save(); paintPrice(); go("#/review");
  });

  // ----- Récapitulatif -----
  const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  function frDate(iso) { const [y, m, d] = (iso || "").split("-"); return d && m && y ? `${d}/${m}/${y}` : ""; }
  let cancelNotice = false;
  function paintReview(cancelled) {
    const p = product(), q = state.person;
    $("#review-order").innerHTML =
      (cancelled ? `<div class="notice notice-demo" style="margin:12px 0 4px">Paiement annulé. Rien n'a été débité.</div>` : "") +
      `<div class="price-line"><span class="pl-label">${esc(CFG.brand.cardName)}</span><span class="pl-value">${money(p.faceCents)}</span></div>` +
      `<div class="price-line"><span class="pl-label">Remise ${CFG.discountPct} %</span><span class="pl-value">− ${money(p.faceCents - p.priceCents)}</span></div>` +
      `<div class="price-line is-total"><span class="pl-label">À payer</span><span class="pl-value">${money(p.priceCents)}</span></div>`;
    $("#review-person").innerHTML = kv("Titulaire", `${q.first_name} ${q.last_name}`) + kv("E-mail", state.email) + kv("Mobile (lien d'activation)", maskPhone(q.dialing_code, q.mobile)) +
      `<div class="kv"><a class="edit-link" href="#/details">Modifier</a></div>`;
    $("#f-terms").checked = false; $("#btn-pay").disabled = true;
    if (cancelled) { state.orderId = null; save(); }
  }
  $("#f-terms").addEventListener("change", (e) => { $("#btn-pay").disabled = !e.target.checked; });
  $("#btn-pay").addEventListener("click", () => {
    if (provider() === "simulated") go("#/pay"); else startHostedPayment();
  });

  // ----- Paiement -----
  // Le prestataire effectif est décidé côté serveur (variables d'environnement) ; config.js sert de repli.
  let serverProvider = null;
  function provider() { return serverProvider || CFG.payment.provider || "simulated"; }
  fetch("/api/health", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((h) => { if (h && h.payment) serverProvider = h.payment; }).catch(() => {});

  function paintPay() { $("#pay-demo-notice").hidden = provider() !== "simulated"; }
  $("#form-pay").addEventListener("submit", (e) => {
    e.preventDefault();
    // Démonstration : aucune donnée de carte bancaire n'est envoyée ni conservée.
    state.orderId = state.orderId || uuid(); state.payment = { method: "simulated", ref: "demo-" + state.orderId.slice(0, 8) };
    save(); go("#/creating");
  });
  async function startHostedPayment() {
    state.orderId = uuid(); save(); // nouvelle commande à chaque passage en caisse
    const btn = $("#btn-pay"); btn.disabled = true;
    try {
      const body = { orderId: state.orderId, product: product(), email: state.email, person: state.person };
      const r = await fetch("/api/payment-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.redirectUrl) { remember(state.email, state.person); location.href = j.redirectUrl; return; }
      btn.disabled = false;
      showError(j.error || "Le paiement n'est pas disponible pour le moment.", "Rien n'a été débité. Réessayez dans quelques minutes.");
    } catch (err) { btn.disabled = false; showError("Le paiement n'est pas disponible pour le moment.", "Vérifiez votre connexion, puis réessayez."); }
  }

  // ----- Création -----
  // Deux chemins : paiement simulé (POST /api/issue-card, puis suivi) ou retour du paiement hébergé (suivi seul).
  let creating = false;
  async function runCreation(fromPayment) {
    if (creating) return; creating = true;
    const items = $$("#creating-list li"); items.forEach((li) => { li.className = ""; li.querySelector(".dot").textContent = ""; });
    const mark = (i, cls) => { items[i].className = cls; items[i].querySelector(".dot").textContent = cls === "is-done" ? "✓" : ""; };
    const fail = (j) => { creating = false; showError(errorText(j), errorHelp(j)); };
    mark(0, "is-doing");
    state.orderId = state.orderId || uuid(); save();

    if (!fromPayment) {
      try {
        const body = { orderId: state.orderId, product: product(), email: state.email, person: state.person, payment: state.payment || { method: "simulated" } };
        const r = await fetch("/api/issue-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return fail(j);
      } catch (err) {
        creating = false;
        return showError("La connexion a été interrompue pendant la création.", "Ne payez pas une seconde fois. Réessayez : si la carte a déjà été créée, elle vous sera simplement renvoyée.");
      }
    }

    // Suivi de la commande jusqu'à la carte (ou l'échec). Au plus 3 minutes.
    const t0 = Date.now(); let seenIssuing = false;
    while (Date.now() - t0 < 180000) {
      let j = null;
      try { const r = await fetch(`/api/order-status?orderId=${encodeURIComponent(state.orderId)}`, { cache: "no-store" }); j = await r.json().catch(() => ({})); if (r.status === 401) return fail({ code: "UNAUTHORIZED" }); } catch (e) { j = null; }
      if (j && j.status === "issued") {
        mark(0, "is-done"); mark(1, "is-done"); mark(2, "is-done"); mark(3, "is-doing");
        state.result = { mode: j.mode, redeemUrl: j.redeemUrl, expiresIn: j.expiresIn, last4: j.last4, paymentReleased: !!j.paymentReleased };
        if (state.person) remember(state.email, state.person);
        save();
        setTimeout(() => { mark(3, "is-done"); creating = false; go("#/ready"); }, 900);
        return;
      }
      if (j && j.status === "failed") return fail({ code: j.code });
      if (j && (j.status === "issuing") && !seenIssuing) { seenIssuing = true; mark(0, "is-done"); mark(1, "is-doing"); }
      if (seenIssuing && Date.now() - t0 > 6000) { mark(1, "is-done"); mark(2, "is-doing"); }
      await new Promise((r) => setTimeout(r, 2000));
    }
    creating = false;
    showError("La création prend plus de temps que prévu.", `Ne commandez pas une seconde carte : si elle a été créée, le lien vous arrive par SMS. Référence ${state.orderId.slice(0, 8).toUpperCase()}, service client ${CFG.support.phone}.`);
  }
  function errorText(j) {
    switch (j && j.code) {
      case "DUPLICATE": return "Une carte a déjà été créée pour ce numéro de mobile au cours des 30 derniers jours.";
      case "REFUSED": return "L'émetteur n'a pas pu créer cette carte.";
      case "UPSTREAM": return "L'émetteur est momentanément indisponible.";
      case "LOAD_PENDING": return "La carte est créée mais son chargement est en cours de vérification.";
      case "PAYMENT_FAILED": return "Le paiement n'a pas abouti.";
      case "UNAUTHORIZED": return "Votre session a expiré.";
      default: return (j && j.error) || "Une erreur technique est survenue.";
    }
  }
  function errorHelp(j) {
    switch (j && j.code) {
      case "DUPLICATE": return "Le programme autorise une carte par personne et par 30 jours. Vous n'avez pas été débité.";
      case "REFUSED": case "UPSTREAM": return `Vous n'avez pas été débité. Pour toute question, contactez le service client au ${CFG.support.phone}.`;
      case "LOAD_PENDING": return `Ne commandez pas une seconde carte. Contactez le service client au ${CFG.support.phone} avec la référence ${(state.orderId || "").slice(0, 8).toUpperCase()}.`;
      case "PAYMENT_FAILED": return "Rien n'a été débité. Vous pouvez recommencer la commande.";
      case "UNAUTHORIZED": return "Rechargez la page et saisissez à nouveau le code d'accès.";
      default: return "Vous n'avez pas été débité. Réessayez dans quelques minutes.";
    }
  }
  function showError(text, help) { $("#error-text").textContent = text; $("#error-help").textContent = help || ""; go("#/error"); }
  $("#btn-retry").addEventListener("click", () => { state.orderId = null; state.payment = null; save(); go(state.person ? "#/review" : "#/"); });

  // ----- Carte prête -----
  function paintReady() {
    const r = state.result, p = product(), q = state.person;
    $("#ready-demo-notice").hidden = r.mode === "real";
    $("#ready-demo-notice").textContent = r.mode === "staging"
      ? "Plateforme de test : cette carte est une carte de test, non utilisable en station." + (r.paymentReleased ? " Votre paiement a été annulé, rien n'est débité." : "")
      : "Démonstration : cette carte n'est pas réelle." + (r.paymentReleased ? " Votre paiement a été annulé, rien n'est débité." : "");
    $("#ready-lead").textContent = q
      ? `Le lien d'activation a été envoyé par SMS au ${maskPhone(q.dialing_code, q.mobile)} et par e-mail à ${maskEmail(state.email)}.`
      : "Le lien d'activation vous a été envoyé par SMS et par e-mail.";
    $("#cv-amount-2").textContent = money(p.faceCents);
    $("#cv-holder-2").textContent = q ? emboss(q.first_name, q.last_name) : "";
    $("#cv-last4").textContent = r.last4 ? "•••• " + r.last4 : "";
    $("#btn-open-card").href = r.redeemUrl || "#";
    const mins = r.expiresIn ? Math.round(r.expiresIn / 60) : null;
    $("#ready-meta").textContent = `Le lien ne s'ouvre qu'une seule fois${mins ? ` et reste valable ${mins >= 60 ? Math.round(mins / 60) + " h" : mins + " min"}` : ""}. Référence : ${(state.orderId || "").slice(0, 8).toUpperCase()}.`;
    $("#ready-support").textContent = `Une question sur votre carte ? Service client ${CFG.support.phone}, ${CFG.support.phoneNote}.`;
    state.orderId = null; state.payment = null; save();
  }

  // ----- Entreprise -----
  function bizTotals() {
    const n = Math.max(0, parseInt($("#b-count").value || "0", 10));
    const face = parseInt($("#b-face").value || "0", 10);
    const pr = CFG.products.find((x) => x.faceCents === face) || CFG.products[0];
    const tf = n * pr.faceCents, tp = n * pr.priceCents;
    $("#b-total-face").value = (tf / 100).toFixed(2); $("#b-total-price").value = (tp / 100).toFixed(2);
    const box = $("#biz-summary");
    if (n > 0) {
      box.hidden = false;
      box.innerHTML = `<div class="price-line"><span class="pl-label">${n} carte${n > 1 ? "s" : ""} de ${money(pr.faceCents)}</span><span class="pl-value">${money(tf)}</span></div>` +
        `<div class="price-line"><span class="pl-label">Remise ${CFG.discountPct} %</span><span class="pl-value">− ${money(tf - tp)}</span></div>` +
        `<div class="price-line is-total"><span class="pl-label">Virement à prévoir</span><span class="pl-value">${money(tp)}</span></div>`;
    } else { box.hidden = true; }
  }
  $("#b-count").addEventListener("input", bizTotals); $("#b-face").addEventListener("change", bizTotals);
  $("#form-business").addEventListener("submit", async (e) => {
    e.preventDefault();
    let ok = true;
    const req = [["#b-company", (v) => !!v], ["#b-siren", (v) => /^\d{9}$/.test(v.replace(/\s/g, ""))], ["#b-contact", (v) => !!v], ["#b-phone", (v) => v.replace(/\D/g, "").length >= 9], ["#b-email", isEmail]];
    req.forEach(([sel, test]) => { const i = $(sel); const bad = !test(i.value.trim()); setError(i, bad); ok = ok && !bad; });
    const cnt = $("#b-count"); const n = parseInt(cnt.value || "0", 10);
    const badCount = !(n >= CFG.business.minCards);
    $("#b-count-error").textContent = `Minimum ${CFG.business.minCards} cartes.`; setError(cnt, badCount); ok = ok && !badCount;
    if (!ok) { ($(".has-error .input") || $("#b-company")).focus(); return; }
    bizTotals();
    const form = e.target; const data = new FormData(form);
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      const r = await fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });
      if (!r.ok) throw new Error("form");
      form.reset(); $("#biz-summary").hidden = true; go("#/entreprise/ok");
    } catch (err) {
      alert("La demande n'a pas pu être envoyée. Écrivez-nous à " + CFG.business.contactEmail + ".");
    } finally { btn.disabled = false; }
  });

  // ----- Démarrage -----
  paintBrand(); paintLists(); paintProducts();
  if (!location.hash) location.replace("#/");
  route();
})();
