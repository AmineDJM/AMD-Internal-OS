/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCRIPT QUE LE SITE PUBLIC INCLUT (Direction, 07/10) — module PUR : il ne rend qu'une chaîne.
 *
 *   <script src="https://<ERP>/api/site-web/v1/audience.js" defer></script>
 *
 * Ce qu'il envoie (par lots, à `POST /api/site-web/v1/audience`) :
 *   • une PAGE VUE au chargement et à chaque changement de route (pushState, replaceState,
 *     popstate) — chemin sans paramètres, titre, hôte du référent, paramètres utm de l'arrivée ;
 *   • un CLIC sur tout élément marqué `data-adventum-track="…"`, et d'office sur « Postuler »,
 *     `tel:`, `mailto:`, WhatsApp, les liens externes et les téléchargements ;
 *   • un LEAVE avec le temps passé VISIBLE sur la page, quand l'onglet est caché ou quitté
 *     (`navigator.sendBeacon`).
 *
 * Ce qu'il ne fait pas : aucun cookie, aucun `localStorage`. Seul un identifiant de SESSION vit en
 * `sessionStorage` (il meurt avec l'onglet). Rien n'est envoyé si le navigateur demande de ne pas
 * être suivi (`doNotTrack`, `globalPrivacyControl`). Le corps part en `text/plain` : une requête
 * « simple », sans pré-vérification CORS, et sans cookie (`credentials: "omit"`).
 *
 * Il trouve l'ERP par sa propre adresse (`document.currentScript`) ; `repli` sert si elle manque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function scriptAudience(repli: string): string {
  return `/* Adventum — mesure d'audience, sans cookie. */
(function () {
  "use strict";
  var w = window, d = document, n = navigator;
  if (w.__adventumAudience) return;
  w.__adventumAudience = 1;
  if (n.doNotTrack === "1" || w.doNotTrack === "1" || n.globalPrivacyControl === true) return;
  var cs = d.currentScript, ep = ${JSON.stringify(repli)};
  try { if (cs && cs.src) ep = new URL(cs.src).origin + "/api/site-web/v1/audience"; } catch (e) {}

  function ss(k, v) {
    try { if (v === undefined) return w.sessionStorage.getItem(k); w.sessionStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function rnd() {
    var a = new Uint8Array(12), s = "";
    try { w.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 12; i++) a[i] = Math.floor(Math.random() * 256); }
    for (var j = 0; j < a.length; j++) s += (a[j] < 16 ? "0" : "") + a[j].toString(16);
    return s;
  }
  var sid = ss("adv_aud_s");
  if (!sid) { sid = rnd(); ss("adv_aud_s", sid); }
  var o = null;
  try { o = JSON.parse(ss("adv_aud_o") || "null"); } catch (e) {}
  if (!o) {
    var q = new URLSearchParams(location.search), rh = "";
    try { rh = d.referrer ? new URL(d.referrer).hostname : ""; } catch (e) {}
    o = { r: rh, s: q.get("utm_source") || "", m: q.get("utm_medium") || "", c: q.get("utm_campaign") || "" };
    ss("adv_aud_o", JSON.stringify(o));
  }

  var file = [], minuteur = null;
  function pousser(e) {
    e.session = sid; e.referrer = o.r; e.utmSource = o.s; e.utmMedium = o.m; e.utmCampaign = o.c;
    file.push(e);
    if (file.length >= 10) envoyer(false);
    else if (!minuteur) minuteur = setTimeout(function () { envoyer(false); }, 4000);
  }
  function envoyer(balise) {
    if (minuteur) { clearTimeout(minuteur); minuteur = null; }
    while (file.length) {
      var corps = JSON.stringify({ events: file.splice(0, 50) }), parti = false;
      if (balise && n.sendBeacon) { try { parti = n.sendBeacon(ep, corps); } catch (e) {} }
      if (!parti) {
        try {
          fetch(ep, { method: "POST", body: corps, keepalive: true, credentials: "omit", mode: "cors", headers: { "Content-Type": "text/plain" } })["catch"](function () {});
        } catch (e) {}
      }
    }
  }

  var page = null, cumul = 0, depuis = null;
  function ecoule() { return cumul + (depuis !== null ? Date.now() - depuis : 0); }
  function depart() {
    var ms = ecoule();
    cumul = 0; depuis = d.visibilityState === "hidden" ? null : Date.now();
    if (page && ms >= 1000) pousser({ type: "LEAVE", path: page, durationMs: ms });
  }
  function vue() {
    var p = location.pathname;
    if (p === page) return;
    depart();
    page = p;
    pousser({ type: "PAGEVIEW", path: p, title: d.title });
  }
  function apres() { setTimeout(vue, 150); }
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== "function") return;
    history[m] = function () { var r = orig.apply(this, arguments); apres(); return r; };
  });
  w.addEventListener("popstate", apres);
  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") { depart(); depuis = null; envoyer(true); }
    else if (depuis === null) depuis = Date.now();
  });
  w.addEventListener("pagehide", function () { depart(); depuis = null; envoyer(true); });

  function texte(el) { return ((el.innerText || el.textContent || "") + "").replace(/\\s+/g, " ").trim().slice(0, 80); }
  d.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var marque = t.closest("[data-adventum-track]"), el = marque || t.closest("a,button");
    if (!el) return;
    var href = el.getAttribute("href") || "", txt = texte(el), label = null, cible = null;
    if (marque) {
      label = (marque.getAttribute("data-adventum-track") || "cta").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80) || "cta";
      cible = href || txt;
    } else if (/postuler/i.test(txt) || (/\\/carrieres\\//i.test(href) && /postuler/i.test(href))) { label = "postuler"; cible = href || txt; }
    else if (/^tel:/i.test(href)) { label = "telephone"; cible = href; }
    else if (/^mailto:/i.test(href)) { label = "email"; cible = href; }
    else if (/wa\\.me|whatsapp/i.test(href)) { label = "whatsapp"; cible = el.href || href; }
    else if (el.hasAttribute("download") || /\\.(pdf|docx?|xlsx?|pptx?|odt|ods|zip|csv)([?#]|$)/i.test(href)) { label = "telechargement"; cible = el.href || href; }
    else if (el.tagName === "A" && /^https?:$/.test(el.protocol || "") && el.hostname && el.hostname !== location.hostname) { label = "externe"; cible = el.href; }
    if (!label) return;
    pousser({ type: "CLICK", path: location.pathname, label: label, target: cible });
    envoyer(true);
  }, true);

  if (d.visibilityState !== "hidden") depuis = Date.now();
  vue();
})();
`;
}
