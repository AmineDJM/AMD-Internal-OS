/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FAIRE PASSER `fetch` PAR LE MANDATAIRE — préchargement de BANC, jamais du produit.
 *
 * ── LE DÉFAUT MESURÉ ─────────────────────────────────────────────────────────────────────
 *
 * Dans ce conteneur, `curl https://api.openai.com/v1/chat/completions` rend 200 : le mandataire
 * remplace l'en-tête d'autorisation par de vrais identifiants. Le MÊME appel depuis l'ERP rend
 * `HTTP 401 — Incorrect API key provided`. La cause n'est ni la clé ni le réseau : le `fetch`
 * global de Node (undici) N'HONORE PAS `HTTPS_PROXY`, contrairement à curl. Les appels de
 * modèle sortaient donc en direct, sans jamais croiser le mandataire qui les aurait signés.
 *
 * Conséquence pratique : tout banc LIVE — celui qui a produit la moitié des leçons de ce
 * dépôt — était injouable ici, et l'échec ressemblait à une clé manquante. Un diagnostic
 * plausible et faux, comme d'habitude (§118.76).
 *
 * ── POURQUOI CE FICHIER N'EST PAS DU CODE DE PRODUCTION ──────────────────────────────────
 *
 * Le produit tourne sur Render, sans mandataire, avec sa vraie clé : router son `fetch` vers
 * un mandataire local serait un défaut là-bas. Ce réglage appartient donc à l'ENVIRONNEMENT
 * d'exécution du banc, pas au code — d'où un préchargement (`node --require`) qu'on n'active
 * que lorsqu'on lance un banc ici.
 *
 * ── CE QU'IL NE FAIT PAS ─────────────────────────────────────────────────────────────────
 *
 * Il ne touche NI à la vérification TLS (le magasin de certificats vient de
 * `NODE_EXTRA_CA_CERTS`, posé par l'environnement), NI aux variables de mandataire : il les
 * LIT. Sans `HTTPS_PROXY`, il ne fait rien et le dit — se taire laisserait croire qu'il a
 * agi.
 *
 * ── LES IDENTIFIANTS VIENNENT DU MANDATAIRE, DONC LA CLÉ EST UN JETON DE PRÉSENCE ────────
 *
 * `fournisseurConfigure()` lit `OPENAI_API_KEY` : sans elle, le produit refuse AVANT d'appeler,
 * et rend « Clé OPENAI_API_KEY non configurée ». Or dans ce conteneur la clé RÉELLE n'existe
 * nulle part : le mandataire remplace l'en-tête d'autorisation par de vrais identifiants. La
 * valeur envoyée n'a donc aucune importance — ce qui compte est qu'il y en ait une, pour que le
 * produit consente à sortir.
 *
 * Ce n'est PAS une clé en dur : c'est la conséquence du fait « un mandataire signe pour nous »,
 * posée au même endroit que le routage qui en découle. Deux garde-fous : on n'écrase JAMAIS une
 * clé existante (sur une machine qui en a une vraie, c'est elle qui parle), et on ne pose rien
 * sans mandataire — sans lui, un jeton factice produirait un 401 déguisé en « configuré », et un
 * diagnostic faux coûte plus cher qu'un refus franc (§118.84).
 *
 * ── IL S'INSTALLE PARTOUT, IL NE PARLE QU'UNE FOIS ───────────────────────────────────────
 *
 * `tsx` lance des processus enfants (le service esbuild, le chargeur ESM) qui héritent de
 * `NODE_OPTIONS`, donc du préchargement : chacun DOIT poser son dispatcher — un `fetch` non
 * routé dans un enfant sortirait en direct — mais la ligne d'annonce, elle, sortait CINQ fois
 * par banc. Un en-tête répété est du bruit, et le bruit apprend à ne plus lire la sortie
 * (§118.52) : le drapeau est posé dans l'environnement, donc hérité, donc seul le premier
 * processus parle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dejaDit = process.env.__BANC_MANDATAIRE_ANNONCE === "1";
process.env.__BANC_MANDATAIRE_ANNONCE = "1";
if (!proxy) {
  if (!dejaDit) console.info("[banc] aucun HTTPS_PROXY : `fetch` reste en direct (c'est le cas en production).");
} else {
  // `NO_PROXY` honoré (localhost, 127.0.0.1…) : un banc qui parle à un serveur LOCAL (faux Meta du lot K6) ne passe pas
  // par le mandataire. `EnvHttpProxyAgent` lit HTTPS_PROXY et NO_PROXY ; à défaut (undici ancien), tout passe par lui.
  const { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(EnvHttpProxyAgent ? new EnvHttpProxyAgent() : new ProxyAgent(proxy));
  let jeton = "";
  for (const cle of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (!process.env[cle]) { process.env[cle] = "mandataire"; jeton += ` ${cle}`; }
  }
  if (!dejaDit) {
    console.info(`[banc] fetch routé par le mandataire ${proxy} — les appels de modèle seront signés par lui.`);
    if (jeton) console.info(`[banc] jeton de présence posé sur${jeton} : la valeur est remplacée par le mandataire.`);
  }
}
