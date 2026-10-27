/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SOCLE DES EXTRACTEURS « ORGANISATIONS ET COMMERCE » — fabriquer un fait, normaliser une
 * valeur, garder sa preuve (refonte des données, §3-E, étape 3).
 *
 * Les extracteurs du lot (devis / facture, registre du commerce, RIB, contrat, programme de
 * congrès) rendent tous un `ResultatExtraction` ; ce module porte ce qu'ils partagent, pour que
 * deux extracteurs ne normalisent pas le même NIF de deux façons :
 *
 *   • `fait` — le SEUL constructeur d'un `FaitExtrait` : l'attribut doit être au catalogue
 *     (`ATTRIBUTS`), la sensibilité en est RECOPIÉE (jamais décidée ici), la valeur est bornée,
 *     et l'extrait d'un fait sensible est MASQUÉ — la preuve d'un RIB ne recopie pas le RIB.
 *   • les normalisations — NIF / RC (celles de `pieces-lues/fournisseur.ts`, pas une seconde
 *     règle), NIS, article d'imposition, téléphone en E.164, e-mail, adresse, raison sociale
 *     (`cleSociete` du moteur de qualité), montant, date ISO.
 *   • les COMPTES BANCAIRES — un RIB algérien (20 chiffres) n'est proposé que si sa CLÉ est
 *     juste ; un IBAN que si son contrôle modulo 97 l'est. Un compte faux n'est pas « à
 *     confirmer » : il n'est pas proposé, et la note le dit.
 *   • la lecture par ÉTIQUETTES (« Raison sociale : … », valeur sur la ligne ou la suivante), les
 *     identifiants d'un passage de texte libre (« immatriculée au registre du commerce sous le
 *     n° … »), les dates et les périodes (« du 12 au 14 novembre 2026 »).
 *
 * ── LA CONFIANCE, UNE ÉCHELLE COMMUNE ──────────────────────────────────────────────────────
 *
 *   identifiant imprimé sous son étiquette ET dont la forme se vérifie   → CONFIANCE.VERIFIE  (0,95)
 *   valeur imprimée sous son étiquette                                  → CONFIANCE.ETIQUETTE (0,85)
 *   valeur lue dans une phrase (« sise au … », « représentée par … »)   → CONFIANCE.PHRASE   (0,75)
 *   valeur rattachée par déduction (bloc, position, seule restante)     → CONFIANCE.DEDUITE  (0,65)
 *   valeur venue d'un modèle, sans appui sur le texte imprimé           → CONFIANCE.MODELE   (0,55)
 *
 * Une pièce se lit page par page quand le texte porte des sauts de page (`\f`, ce que rendent
 * l'extraction PDF et l'OCR) ; sans eux, la page est `null` — on ne l'invente pas.
 *
 * Module PUR : aucune lecture de fichier, aucune base, aucun modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { ATTRIBUT_PAR_CLE, type FaitExtrait, type RoleSujet } from "@/lib/enrichissement/types";
import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";
import { analyserNombre } from "@/lib/pieces-lues/montants";
import { cleSociete } from "@/lib/quality/model";

export { normaliserNif, normaliserRc };

export const CONFIANCE = {
  VERIFIE: 0.95,
  ETIQUETTE: 0.85,
  PHRASE: 0.75,
  DEDUITE: 0.65,
  MODELE: 0.55,
} as const;

/** Une valeur proposée reste une valeur de fiche, pas un paragraphe. */
const VALEUR_MAX = 300;
const EXTRAIT_MAX = 200;

// ─────────────────────────────── Le texte : pli, lignes, pages ───────────────────────────────

/**
 * Minuscules, sans accents, espaces exotiques ramenées à l'espace — SANS changer la longueur :
 * une position du pli est celle de l'original, on y découpe la valeur imprimée avec sa casse.
 */
export function plier(s: string): string {
  let out = "";
  for (const c of s) {
    if (/[      \t]/.test(c)) { out += " "; continue; }
    if (c === "’" || c === "‘" || c === "`") { out += "'"; continue; }
    if (c === "«" || c === "»" || c === "“" || c === "”") { out += "\""; continue; }
    const d = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (d.length === c.length) { out += d; continue; }
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

export interface LigneDeTexte {
  /** Telle qu'imprimée (saut de page retiré). */
  texte: string;
  /** Le pli de `texte`, même longueur. */
  pli: string;
  /** Rang dans le texte, 1-indexé — le même que celui du repérage des en-têtes (`entetes.ts`). */
  rang: number;
  /** La page, si le texte porte des sauts de page ; sinon `null`. */
  page: number | null;
}

/** Les lignes d'un texte lu, avec leur page quand le texte la dit (sauts de page `\f`). */
export function lignesDe(texte: string | null | undefined): LigneDeTexte[] {
  const brut = String(texte ?? "").replace(/\r\n?/g, "\n");
  const pagine = brut.includes("\f");
  let page = 1;
  return brut.split("\n").map((l, i) => {
    const sauts = (l.match(/\f/g) ?? []).length;
    // Un saut en tête de ligne ouvre la page de cette ligne ; un saut en fin de ligne, la suivante.
    const enTete = /^\f/.test(l) ? (l.match(/^\f+/)?.[0].length ?? 0) : 0;
    page += enTete;
    // Un saut au milieu d'une ligne la laisse entière : les rangs restent ceux du repérage des en-têtes.
    const t = l.replace(/^\f+/, "").replace(/\f/g, " ");
    const ligne: LigneDeTexte = { texte: t, pli: plier(t), rang: i + 1, page: pagine ? page : null };
    page += sauts - enTete;
    return ligne;
  });
}

/** Une ligne d'extrait : un seul blanc entre les mots, bornée. */
export function extraitDe(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EXTRAIT_MAX ? `${t.slice(0, EXTRAIT_MAX - 1)}…` : t;
}

/** Une valeur lue : un seul blanc, sans ponctuation de bord. */
export function nettoyer(s: string | null | undefined): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().replace(/^[\s:;,.\-–—=]+/, "").replace(/[\s:;,\-–—=]+$/, "").trim();
}

/**
 * MASQUER UNE PREUVE SENSIBLE : tout groupe d'au moins quatre caractères alphanumériques qui porte
 * des chiffres est réduit à ses deux derniers. « RIB : 004 00364 4000030946 07 » → « RIB : •••• ••64 ••46 07 ».
 */
export function masquer(extrait: string): string {
  return extrait.replace(/[A-Za-z0-9]{3,}/g, (m) => (/\d/.test(m) ? `${"•".repeat(Math.max(0, m.length - 2))}${m.slice(-2)}` : m));
}

/** La première ligne qui contient la valeur (espaces et casse mis à part) — la preuve d'une valeur venue d'ailleurs. */
export function ligneQuiContient(lignes: readonly LigneDeTexte[], valeur: string | null | undefined): LigneDeTexte | null {
  const cle = plier(String(valeur ?? "")).replace(/\s+/g, "");
  if (cle.length < 3) return null;
  return lignes.find((l) => l.pli.replace(/\s+/g, "").includes(cle)) ?? null;
}

// ─────────────────────────────── Le fait ───────────────────────────────

export interface FaitAConstruire {
  sujetRef: string;
  role: RoleSujet;
  attribut: string;
  valeur: string;
  valeurNormalisee: string;
  confiance: number;
  page: number | null;
  extrait: string;
}

/**
 * LE CONSTRUCTEUR D'UN FAIT. Un attribut hors catalogue est une faute du code, pas de la pièce :
 * elle lève. Une valeur vide ne fait pas de fait (`null`). La sensibilité vient du catalogue.
 */
export function fait(f: FaitAConstruire): FaitExtrait | null {
  const attribut = ATTRIBUT_PAR_CLE.get(f.attribut);
  if (!attribut) throw new Error(`Attribut hors catalogue : « ${f.attribut} ».`);
  const valeur = nettoyer(f.valeur).slice(0, VALEUR_MAX);
  const valeurNormalisee = f.valeurNormalisee.trim().slice(0, VALEUR_MAX);
  if (!valeur || !valeurNormalisee) return null;
  const extrait = extraitDe(f.extrait);
  return {
    sujetRef: f.sujetRef,
    sujetType: attribut.sujet,
    role: f.role,
    attribut: attribut.cle,
    valeur,
    valeurNormalisee,
    confiance: Math.round(Math.min(1, Math.max(0, f.confiance)) * 100) / 100,
    preuve: { page: f.page, extrait: attribut.sensible ? masquer(extrait) : extrait },
    sensible: attribut.sensible,
  };
}

/** Une liste de faits sans les absents ni les doublons (même sujet, même attribut, même valeur normalisée). */
export function sansDoublons(faits: readonly (FaitExtrait | null)[]): FaitExtrait[] {
  const vus = new Map<string, FaitExtrait>();
  for (const f of faits) {
    if (!f) continue;
    const cle = `${f.sujetRef}|${f.attribut}|${f.valeurNormalisee}`;
    const deja = vus.get(cle);
    if (!deja || deja.confiance < f.confiance) vus.set(cle, f);
  }
  return [...vus.values()];
}

// ─────────────────────────────── Les normalisations ───────────────────────────────

/** Le NIS algérien : 15 chiffres (on tolère 16 à 20, des extensions existent). */
export function normaliserNis(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s || /[^\d\s.-]/.test(s)) return null;
  const chiffres = s.replace(/\D/g, "");
  return chiffres.length >= 15 && chiffres.length <= 20 ? chiffres : null;
}

/** L'article d'imposition : 8 à 15 chiffres (la règle du repérage des en-têtes). */
export function normaliserAi(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s || /[^\d\s.-]/.test(s)) return null;
  const chiffres = s.replace(/\D/g, "");
  return chiffres.length >= 8 && chiffres.length <= 15 ? chiffres : null;
}

/**
 * LE TÉLÉPHONE EN E.164. Un numéro algérien national (« 021 23 45 67 », « 0550 12 34 56 ») devient
 * « +21321234567 » ; « +213 (0) 21… » et « 00213… » aussi ; un numéro étranger en « + » garde son
 * indicatif. Ce qui n'a ni la longueur d'un fixe (9 chiffres) ni celle d'un mobile (10) n'en est pas un.
 */
export function normaliserTelephone(v: string | null | undefined): string | null {
  let s = String(v ?? "").trim();
  if (!s) return null;
  s = s.replace(/\(\s*0\s*\)/g, "").replace(/\(\d{1,3}\)\s*$/, "");
  if (/[^\d\s().+/-]/.test(s)) return null;
  let chiffres = s.replace(/\D/g, "");
  const international = s.trimStart().startsWith("+") || chiffres.startsWith("00");
  if (chiffres.startsWith("00")) chiffres = chiffres.slice(2);
  if (international) {
    if (chiffres.startsWith("213")) {
      const national = chiffres.slice(3).replace(/^0/, "");
      return national.length === 8 || national.length === 9 ? `+213${national}` : null;
    }
    return chiffres.length >= 8 && chiffres.length <= 15 ? `+${chiffres}` : null;
  }
  if (!chiffres.startsWith("0")) return null;
  const national = chiffres.slice(1);
  // Fixe : 0 + indicatif de wilaya (2 chiffres) + 6 chiffres ; mobile : 0 + 5/6/7 + 8 chiffres.
  if (national.length === 8 || (national.length === 9 && /^[567]/.test(national))) return `+213${national}`;
  return null;
}

export function normaliserEmail(v: string | null | undefined): string | null {
  const m = String(v ?? "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

/** Une adresse se compare sans casse, sans accents, sans ponctuation. */
export function normaliserAdresse(v: string | null | undefined): string | null {
  const t = plier(nettoyer(v)).replace(/[^a-z0-9]+/g, " ").trim();
  return t.length >= 4 ? t : null;
}

/** Un site web : son hôte, sans protocole ni « www. ». */
export function normaliserSiteWeb(v: string | null | undefined): string | null {
  const m = String(v ?? "").toLowerCase().match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(\/[^\s]*)?/);
  return m ? m[1] + (m[2] && m[2] !== "/" ? m[2].replace(/\/$/, "") : "") : null;
}

/** La raison sociale, telle qu'elle se compare (« Hetero Labs SARL » = « HETERO LABS ») ; le pli si elle n'est faite que de formes. */
export function normaliserRaisonSociale(v: string | null | undefined): string | null {
  const t = nettoyer(v);
  if (t.length < 2) return null;
  return cleSociete(t) || plier(t).replace(/[^a-z0-9]+/g, " ").trim() || null;
}

/** Un nom de personne ou de banque : le pli, mots seuls. */
export function normaliserTexte(v: string | null | undefined): string | null {
  const t = plier(nettoyer(v)).replace(/[^a-z0-9]+/g, " ").trim();
  return t || null;
}

export interface MontantLu {
  valeur: number;
  /** Tel qu'imprimé. */
  brut: string;
  /** « DZD », « EUR », « USD » — `null` si le papier ne la dit pas. */
  devise: string | null;
}

const RE_DEVISE_APRES = /^\s*(dzd|d\.?\s?a\.?(?![a-z])|da(?![a-z])|dinars?(?:\s+algeriens?)?|eur(?:os?)?|€|usd|\$|dollars?)/;

/**
 * UN MONTANT dans un passage (« 1 000 000,00 DA », « 2 500 000 dinars algériens ») : le premier
 * nombre plausible, et sa devise. Un nombre ambigu (« 1.200 ») n'est pas un montant — `null`.
 */
export function montantDans(passage: string): MontantLu | null {
  const pli = plier(passage);
  for (const m of pli.matchAll(/(?<![\d.,])\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,2})?(?![\d])|(?<![\d.,])\d{4,}(?:[.,]\d{1,2})?(?![\d])/g)) {
    const debut = m.index ?? 0;
    const apres = pli.slice(debut + m[0].length);
    const d = RE_DEVISE_APRES.exec(apres);
    const devise = d ? (/eur|€/.test(d[1]) ? "EUR" : /usd|\$|dollar/.test(d[1]) ? "USD" : "DZD") : null;
    const lu = analyserNombre(d ? `${m[0]} ${devise === "DZD" ? "DA" : ""}`.trim() : m[0]);
    if (lu.valeur === null) continue;
    return { valeur: lu.valeur, brut: passage.slice(debut, debut + m[0].length + (d ? d[0].length : 0)).trim(), devise };
  }
  return null;
}

/** « 1000000.00 DZD » — la forme qui se compare. */
export const montantNormalise = (m: Pick<MontantLu, "valeur" | "devise">): string => `${m.valeur.toFixed(2)}${m.devise ? ` ${m.devise}` : ""}`;

// ─────────────────────────────── Les formes juridiques ───────────────────────────────

/** De la plus précise à la plus courte : « Société à responsabilité limitée » avant « SARL ». */
const FORMES: { forme: string; re: RegExp }[] = [
  { forme: "EURL", re: /entreprise\s+unipersonnelle\s+a\s+responsabilite\s+limitee|(?<![a-z])e\.?\s?u\.?\s?r\.?\s?l\.?(?![a-z])/ },
  { forme: "SARL", re: /societe\s+a\s+responsabilite\s+limitee|(?<![a-z])s\.?\s?a\.?\s?r\.?\s?l\.?(?![a-z])/ },
  { forme: "SPA", re: /societe\s+par\s+actions|(?<![a-z])s\.?\s?p\.?\s?a\.?(?![a-z])/ },
  { forme: "SNC", re: /societe\s+en\s+nom\s+collectif|(?<![a-z])s\.?\s?n\.?\s?c\.?(?![a-z])/ },
  { forme: "SCS", re: /societe\s+en\s+commandite\s+simple|(?<![a-z])s\.?\s?c\.?\s?s\.?(?![a-z])/ },
  { forme: "SCA", re: /societe\s+en\s+commandite\s+par\s+actions/ },
  { forme: "EPE", re: /entreprise\s+publique\s+economique|(?<![a-z])e\.?\s?p\.?\s?e\.?(?![a-z])/ },
  { forme: "EPIC", re: /etablissement\s+public\s+a\s+caractere\s+industriel\s+et\s+commercial|(?<![a-z])e\.?\s?p\.?\s?i\.?\s?c\.?(?![a-z])/ },
  { forme: "GIE", re: /groupement\s+d'?\s?interet\s+economique|(?<![a-z])g\.?\s?i\.?\s?e\.?(?![a-z])/ },
  { forme: "Entreprise individuelle", re: /entreprise\s+individuelle|personne\s+physique/ },
  { forme: "Association", re: /^association(?![a-z])|(?<![a-z])association\s+(?:a\s+caractere|agreee|scientifique|nationale)/ },
];

/** La forme juridique imprimée dans un passage, canonique (« SARL », « SPA ») — `null` si aucune. */
export function formeJuridiqueDans(passage: string | null | undefined): string | null {
  const p = plier(String(passage ?? ""));
  // Les formes courtes (« SPA », « SNC ») ne comptent qu'en majuscules : « spa » d'un hôtel-spa n'est pas une SPA.
  for (const { forme, re } of FORMES) {
    const m = re.exec(p);
    if (!m) continue;
    const brut = String(passage).slice(m.index, m.index + m[0].length);
    const lettres = brut.replace(/[^A-Za-z]/g, "");
    if (lettres.length <= 5 && lettres !== lettres.toUpperCase()) continue;
    return forme;
  }
  return null;
}

/** Les mots qui disent une organisation, pas une personne. */
const RE_ORGANISATION = /(?<![a-z])(?:societe|ste|sarl|eurl|spa|snc|epe|epic|entreprise|ets|etablissements?|groupe|laboratoires?|labo|pharma\w*|hotel|agence|cabinet|clinique|imprimerie|association|federation|college|centre|bureau|banque|bank|compagnie|industries?|distribution|import|export|trading|services?|consulting|international|algerie|el\s+djazair|holding|office|institut|universite|chu|ehs|eph|ministere|direction)(?![a-z])/;
const RE_CIVILITE = /^(?:m\.|mr\.?|mme\.?|mlle\.?|melle|dr\.?|pr\.?|me\.?|monsieur|madame|mademoiselle|docteur|professeur|maitre)(?=\s|$)/;

/** « M. Karim B. », « Dr Amel K. » — une personne, pas une société. `null` : non tranché. */
export function estPersonne(nom: string | null | undefined): boolean | null {
  const p = plier(nettoyer(nom));
  if (!p) return null;
  if (RE_CIVILITE.test(p)) return true;
  if (RE_ORGANISATION.test(p) || formeJuridiqueDans(nom) !== null) return false;
  return null;
}

// ─────────────────────────────── Les comptes bancaires ───────────────────────────────

/**
 * LA CLÉ D'UN RIB ALGÉRIEN (et du RIP d'Algérie Poste) : 3 chiffres de banque, 5 d'agence, 10 de
 * compte, 2 de clé ; clé = 97 − ((agence + compte) × 100 mod 97). Vérifiée sur un RIB réel.
 */
export function ribValide(chiffres: string): boolean {
  if (!/^\d{20}$/.test(chiffres)) return false;
  const base = BigInt(chiffres.slice(3, 18));
  const cle = 97n - ((base * 100n) % 97n);
  return cle === BigInt(chiffres.slice(18));
}

/** L'IBAN : lettres en nombres (A = 10), quatre premiers caractères à la fin, modulo 97 = 1. */
export function ibanValide(iban: string): boolean {
  const s = iban.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const tourne = s.slice(4) + s.slice(0, 4);
  const chiffres = tourne.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let reste = 0;
  for (const c of chiffres) reste = (reste * 10 + Number(c)) % 97;
  return reste === 1;
}

export interface CompteLu {
  type: "RIB" | "IBAN";
  /** Chiffres seuls (RIB) ou lettres et chiffres en majuscules (IBAN). */
  valeur: string;
  valide: boolean;
  ligne: LigneDeTexte;
}

const RE_IBAN = /(?<![A-Za-z0-9])([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?)(?![A-Za-z0-9])/g;
/** Vingt chiffres, groupés ou non (« 004 00364 4000030946 07 », « 00400364400003094607 »). */
const RE_VINGT_CHIFFRES = /(?<![\d])(?:\d[ .\-/]{0,3}){19}\d(?![\d])/g;
/** L'étiquette d'un compte : « RIB », « RIP », « IBAN », « compte n° », « relevé d'identité bancaire ». */
export const RE_ETIQUETTE_COMPTE = /(?<![a-z])(?:r\.?\s?i\.?\s?[bp]\.?|iban|releve\s+d'?\s?identite\s+(?:bancaire|postale)|(?:n[°o]\s*(?:de\s+)?)?compte(?:\s+bancaire)?|coordonnees\s+bancaires)(?![a-z])/;

/**
 * LES COMPTES D'UN TEXTE : chaque IBAN, chaque suite de vingt chiffres — sur la ligne d'une
 * étiquette ou dans un relevé (`toutes: true`) — avec sa validité. Ce n'est pas un NIF : un NIF
 * de 20 chiffres sur une ligne « NIF » n'est jamais pris pour un compte.
 */
export function comptesDans(lignes: readonly LigneDeTexte[], o: { toutes?: boolean } = {}): CompteLu[] {
  const out: CompteLu[] = [];
  const vus = new Set<string>();
  const ajouter = (c: CompteLu) => { if (!vus.has(c.valeur)) { vus.add(c.valeur); out.push(c); } };
  lignes.forEach((l, i) => {
    if (/(?<![a-z])(?:n\.?\s?i\.?\s?[fs]\.?|identifi\w*\s+(?:fiscal|statisti)\w*|registre|r\.?\s?c\.?\s*(?:n|:))(?![a-z])/.test(l.pli) && !RE_ETIQUETTE_COMPTE.test(l.pli)) return;
    let sansIban = l.texte;
    for (const m of l.texte.toUpperCase().matchAll(RE_IBAN)) {
      const v = m[1].replace(/\s/g, "");
      if (!/^\d+$/.test(v.slice(2))) continue;
      ajouter({ type: "IBAN", valeur: v, valide: ibanValide(v), ligne: l });
      sansIban = sansIban.slice(0, m.index) + " ".repeat(m[0].length) + sansIban.slice((m.index ?? 0) + m[0].length);
    }
    // Une étiquette seule sur sa ligne : le compte est sur la suivante.
    const etiquette = RE_ETIQUETTE_COMPTE.test(l.pli) || (i > 0 && RE_ETIQUETTE_COMPTE.test(lignes[i - 1].pli) && nettoyer(lignes[i - 1].pli.replace(RE_ETIQUETTE_COMPTE, "")).replace(/n[°o]/, "") === "");
    if (!etiquette && !o.toutes) return;
    for (const m of sansIban.matchAll(RE_VINGT_CHIFFRES)) {
      const v = m[0].replace(/\D/g, "");
      ajouter({ type: "RIB", valeur: v, valide: ribValide(v), ligne: l });
    }
  });
  return out;
}

// ─────────────────────────────── Les étiquettes ───────────────────────────────

/** Une ligne qui n'est qu'une étiquette (« Adresse : », « NIF ») — jamais la valeur d'une autre. */
export function estEtiquetteSeule(pli: string): boolean {
  const t = pli.trim();
  return t.endsWith(":") && t.length <= 40;
}

export interface ValeurEtiquetee {
  valeur: string;
  ligne: LigneDeTexte;
  /** L'extrait de preuve : la ligne de l'étiquette, et celle de la valeur si elle est à la suite. */
  extrait: string;
}

/**
 * LA VALEUR D'UNE ÉTIQUETTE : sur la même ligne après l'étiquette, sinon sur la ligne non vide
 * suivante si elle n'est pas elle-même une étiquette. `re` s'applique au PLI et doit s'ancrer au
 * début de ce qui est lu (le moteur cherche aussi après un « | » ou deux blancs de colonne).
 */
export function valeurEtiquetee(lignes: readonly LigneDeTexte[], re: RegExp, o: { exclure?: (l: LigneDeTexte) => boolean } = {}): ValeurEtiquetee | null {
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (!l.pli.trim() || o.exclure?.(l)) continue;
    // L'étiquette en début de ligne, ou en début de colonne (après « | » ou une large marge).
    const departs = [0, ...[...l.pli.matchAll(/\|\s*|\s{3,}/g)].map((m) => (m.index ?? 0) + m[0].length)];
    for (const d of departs) {
      const reste = l.pli.slice(d).replace(/^\s+/, "");
      const m = re.exec(reste);
      if (!m || m.index !== 0) continue;
      const debutValeur = l.pli.length - reste.length + m[0].length;
      // La valeur s'arrête à la colonne suivante.
      const brute = l.texte.slice(debutValeur).split(/\s*\|\s*|\s{3,}/)[0];
      let valeur = nettoyer(brute);
      if (valeur) return { valeur, ligne: l, extrait: extraitDe(l.texte) };
      const suivante = lignes.slice(i + 1).find((x) => x.pli.trim() !== "");
      if (suivante && !estEtiquetteSeule(suivante.pli) && !o.exclure?.(suivante)) {
        valeur = nettoyer(suivante.texte.split(/\s*\|\s*|\s{3,}/)[0]);
        if (valeur && !re.test(suivante.pli.trim())) return { valeur, ligne: suivante, extrait: extraitDe(`${l.texte} ${suivante.texte}`) };
      }
    }
  }
  return null;
}

// ─────────────────────────────── Les identifiants dans un passage ───────────────────────────────

export type ChampIdentifiant = "NIF" | "NIS" | "RC" | "AI";

export interface IdentifiantLu {
  champ: ChampIdentifiant;
  /** Normalisé. */
  valeur: string;
  /** Tel qu'imprimé. */
  brut: string;
  ligne: LigneDeTexte;
}

/** « sous le n° », « numéro : », « N° » — ce qui sépare l'étiquette d'un identifiant de sa valeur dans une phrase. */
const LIAISON = String.raw`\s*(?:\(\s*[a-z.]{2,8}\s*\))?\s*(?:sous\s+(?:le\s+)?)?(?:n\s*[°º]|n[o°º](?![a-z])|num(?:ero)?(?![a-z]))?\.?\s*[:=\-]?\s*`;
const ETIQUETTES_ID: { champ: ChampIdentifiant; re: RegExp }[] = [
  { champ: "NIF", re: new RegExp(String.raw`(?<![a-z])(?:n\.?\s?i\.?\s?f\.?|(?:numero\s+d'\s?)?identifi\w*\s+fiscal\w*)(?![a-z])${LIAISON}`, "g") },
  { champ: "NIS", re: new RegExp(String.raw`(?<![a-z])(?:n\.?\s?i\.?\s?s\.?|(?:numero\s+d'\s?)?identifi\w*\s+statisti\w*)(?![a-z])${LIAISON}`, "g") },
  { champ: "RC", re: new RegExp(String.raw`(?<![a-z])(?:r\.?\s?c\.?|registre\s+(?:du\s+|de\s+)?commerce|immatricul\w*(?:\s+au\s+(?:registre\s+du\s+commerce|r\.?\s?c\.?))?)(?![a-z])${LIAISON}`, "g") },
  { champ: "AI", re: new RegExp(String.raw`(?<![a-z])(?:a\.?\s?i\.?|art(?:icle)?\.?\s*(?:d'\s?)?imp(?:osition)?\.?)(?![a-z])${LIAISON}`, "g") },
];

function lireIdentifiant(champ: ChampIdentifiant, apres: string): { valeur: string; brut: string } | null {
  const jetons = apres.split(/\s+/).filter(Boolean);
  const pris: string[] = [];
  for (const j0 of jetons) {
    const j = j0.replace(/[,;)]+$/, "");
    const chiffre = /\d/.test(j);
    if (champ === "RC" ? chiffre || (/^[A-Za-z]{1,2}$/.test(j) && pris.length > 0 && j0 === j) : /^[\d.]+$/.test(j)) pris.push(j);
    else break;
    if (j0 !== j) break; // une virgule clôt l'identifiant
  }
  const brut = pris.join(" ").replace(/\.$/, "");
  if (!brut) return null;
  const valeur = champ === "NIF" ? normaliserNif(brut) : champ === "NIS" ? normaliserNis(brut) : champ === "RC" ? normaliserRc(brut) : normaliserAi(brut);
  return valeur ? { valeur, brut } : null;
}

/**
 * LES IDENTIFIANTS D'UN PASSAGE — NIF, NIS, RC, article d'imposition — sous leur étiquette ou dans
 * une phrase (« immatriculée au registre du commerce sous le n° 16/00-0012345 B 15 »), normalisés.
 * Les formes courtes (« RC », « AI ») ne comptent qu'en majuscules ; une valeur de forme fausse
 * n'est pas rendue. Une étiquette seule sur sa ligne prend la ligne suivante.
 */
export function identifiantsDans(lignes: readonly LigneDeTexte[]): IdentifiantLu[] {
  const out: IdentifiantLu[] = [];
  lignes.forEach((l, i) => {
    const marques: { champ: ChampIdentifiant; debut: number; fin: number }[] = [];
    for (const { champ, re } of ETIQUETTES_ID) {
      for (const m of l.pli.matchAll(re)) {
        const debut = m.index ?? 0;
        const fin = debut + m[0].length;
        const motBrut = l.texte.slice(debut, debut + m[0].trimEnd().length).replace(/[^A-Za-z]/g, "");
        if ((champ === "RC" || champ === "AI") && motBrut.length <= 3 && motBrut !== motBrut.toUpperCase()) continue;
        if (marques.some((x) => debut < x.fin && x.debut < fin)) continue;
        marques.push({ champ, debut, fin });
      }
    }
    marques.sort((a, b) => a.debut - b.debut);
    marques.forEach((mq, k) => {
      const fin = k + 1 < marques.length ? marques[k + 1].debut : l.texte.length;
      let segment = l.texte.slice(mq.fin, fin);
      let ligne = l;
      if (!segment.trim() && k === marques.length - 1 && lignes[i + 1]) { segment = lignes[i + 1].texte; ligne = lignes[i + 1]; }
      const v = lireIdentifiant(mq.champ, segment.replace(/[   ]/g, " "));
      if (v && !out.some((x) => x.champ === mq.champ && x.valeur === v.valeur)) out.push({ champ: mq.champ, ...v, ligne });
    });
  });
  return out;
}

export const ATTRIBUT_IDENTIFIANT: Record<ChampIdentifiant, string> = {
  NIF: "organisation.nif", NIS: "organisation.nis", RC: "organisation.rc", AI: "organisation.ai",
};

// ─────────────────────────────── Les dates ───────────────────────────────

const MOIS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const RE_MOIS = MOIS.join("|");

function iso(j: number, m: number, a: number): string | null {
  const annee = a < 100 ? 2000 + a : a;
  if (annee < 1950 || annee > 2100 || m < 1 || m > 12 || j < 1) return null;
  if (j > new Date(Date.UTC(annee, m, 0)).getUTCDate()) return null;
  return `${annee}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
}

export interface DateLue { iso: string; debut: number; fin: number }

/** Les dates d'un passage plié, jour/mois/année à la française : « 12/10/2026 », « 1er octobre 2026 », « 2026-10-12 ». */
export function datesDans(pli: string): DateLue[] {
  const out: DateLue[] = [];
  for (const m of pli.matchAll(/(?<!\d)(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4})(?!\d)/g)) {
    const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) out.push({ iso: d, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  for (const m of pli.matchAll(new RegExp(String.raw`(?<!\d)(1er|\d{1,2})\s+(${RE_MOIS})\s+(\d{4})(?!\d)`, "g"))) {
    const d = iso(m[1] === "1er" ? 1 : Number(m[1]), MOIS.indexOf(m[2]) + 1, Number(m[3]));
    if (d) out.push({ iso: d, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  for (const m of pli.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    const d = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) out.push({ iso: d, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  return out.sort((a, b) => a.debut - b.debut);
}

export interface PeriodeLue { debut: string; fin: string; ligne: LigneDeTexte }

/**
 * UNE PÉRIODE IMPRIMÉE : « du 12 au 14 novembre 2026 », « 12-14 novembre 2026 », « 12, 13 et 14
 * novembre 2026 », « du 30 novembre au 2 décembre 2026 », « du 12/11/2026 au 14/11/2026 », ou une
 * seule date (« le 12 novembre 2026 », début = fin). La première période du texte — `null` sinon.
 */
export function periodeDans(lignes: readonly LigneDeTexte[], o: { exclure?: (l: LigneDeTexte) => boolean } = {}): PeriodeLue | null {
  const reJours = new RegExp(String.raw`(?<!\d)(1er|\d{1,2})(?:\s*(?:${RE_MOIS}))?(?:\s+(\d{4}))?\s*(?:au|-|–|a|et|&)\s*(?:(?:1er|\d{1,2})\s*(?:,|et)\s*)*(1er|\d{1,2})\s+(${RE_MOIS})\s+(\d{4})(?!\d)`);
  const reMoisDebut = new RegExp(String.raw`(?<!\d)(1er|\d{1,2})\s+(${RE_MOIS})(?:\s+(\d{4}))?\s*(?:au|-|–)\s*(1er|\d{1,2})\s+(${RE_MOIS})\s+(\d{4})(?!\d)`);
  const reListe = new RegExp(String.raw`(?<!\d)(1er|\d{1,2})((?:\s*,\s*\d{1,2})*)\s+et\s+(\d{1,2})\s+(${RE_MOIS})\s+(\d{4})(?!\d)`);
  const jour = (s: string) => (s === "1er" ? 1 : Number(s));
  for (const l of lignes) {
    if (o.exclure?.(l)) continue;
    const p = l.pli;
    let m = reMoisDebut.exec(p);
    if (m) {
      const a = Number(m[6]);
      const debut = iso(jour(m[1]), MOIS.indexOf(m[2]) + 1, m[3] ? Number(m[3]) : a);
      const fin = iso(jour(m[4]), MOIS.indexOf(m[5]) + 1, a);
      if (debut && fin && debut <= fin) return { debut, fin, ligne: l };
    }
    m = reListe.exec(p);
    if (m) {
      const mois = MOIS.indexOf(m[4]) + 1;
      const debut = iso(jour(m[1]), mois, Number(m[5]));
      const fin = iso(Number(m[3]), mois, Number(m[5]));
      if (debut && fin && debut <= fin) return { debut, fin, ligne: l };
    }
    m = reJours.exec(p);
    if (m) {
      const mois = MOIS.indexOf(m[4]) + 1;
      const debut = iso(jour(m[1]), mois, Number(m[5]));
      const fin = iso(jour(m[3]), mois, Number(m[5]));
      if (debut && fin && debut <= fin) return { debut, fin, ligne: l };
    }
    const ds = datesDans(p);
    if (ds.length >= 2 && /(?<![a-z])(?:du|au)(?![a-z])/.test(p) && ds[0].iso <= ds[1].iso) return { debut: ds[0].iso, fin: ds[1].iso, ligne: l };
    if (ds.length === 1) return { debut: ds[0].iso, fin: ds[0].iso, ligne: l };
  }
  return null;
}
