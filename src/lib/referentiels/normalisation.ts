/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES NORMALISATIONS DES RÉFÉRENTIELS — ce qui permet de dire « c'est la même valeur » (refonte des
 * données, palier P2, `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` §3 R1-R2).
 *
 *   nom de personne  → deux clés : ORTHOGRAPHIQUE (accents, casse, titres, particules, ordre) et
 *                      PHONÉTIQUE (les graphies latines d'un même nom arabe : Benali / Ben Ali / Bin Ali,
 *                      Mohamed / Mohammed / Muhammad, Abdelkader / Abd El Kader / Abdulkader) ;
 *   téléphone        → E.164 (+213…), avec sa nature : MOBILE (05/06/07), FIXE, ÉTRANGER ;
 *   e-mail           → plié (casse, `mailto:`), Gmail sans points ni « +étiquette » ; générique ou non ;
 *   NIF / RC         → les normaliseurs des pièces lues (`pieces-lues/fournisseur.ts`), pas une seconde règle ;
 *   NIS / AI         → leurs chiffres ;
 *   nom de société   → `cleSociete` du moteur de qualité, pas une seconde règle.
 *
 * Une clé phonétique RAPPROCHE, elle n'IDENTIFIE pas : deux noms qui la partagent sont « peut-être »
 * la même personne, jamais « sûrement » (`doublons.ts`). Une normalisation qui échoue rend `null` :
 * une valeur illisible ne ressemble à rien, elle ne ressemble surtout pas à une autre valeur illisible.
 *
 * Module PUR : il n'importe que des modules purs (aucune base, aucun fichier).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";
import { cleSociete, emailNormalise, EMAIL_RE } from "@/lib/quality/model";

export { normaliserNif, normaliserRc, cleSociete };

// ─────────────────────────────── Texte ───────────────────────────────

/** Minuscules, sans accents ni ponctuation ; tirets et apostrophes séparent les mots (« Aït-Ahmed », « M'hamed »). */
export function plier(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ßæœ]/g, (c) => ({ ß: "ss", æ: "ae", œ: "oe" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ─────────────────────────────── Noms de personnes ───────────────────────────────

/** Les titres et civilités : ils ne nomment personne (« Dr », « Pr », « M. », « Mme », « Me »…). */
const TITRES = new Set([
  "dr", "docteur", "doctoresse", "pr", "prof", "professeur", "professeure",
  "m", "mr", "monsieur", "mme", "madame", "mlle", "mademoiselle", "me", "maitre",
  "sr", "sir", "mrs", "ms", "miss", "ing", "ingenieur",
]);

/**
 * Les particules qui s'ATTACHENT au mot suivant : « Ben Ali » = « Benali », « Aït Ahmed » = « Aitahmed »,
 * « El Hadi » = « Elhadi ». Attachées plutôt que retirées : « Ben Ali » et « Ali » ne sont pas le même nom.
 * `bin` et `ibn` s'écrivent `ben` (« Bin Ali » = « Ben Ali »).
 */
const PARTICULES: Record<string, string> = {
  ben: "ben", bin: "ben", ibn: "ben", bent: "bent", bint: "bent",
  ould: "ould", ait: "ait", at: "ait",
  el: "el", al: "el", ul: "el", ech: "el", ed: "el", es: "el", et: "el",
  bel: "bel", bou: "bou", abou: "abou", abu: "abou",
  de: "de", du: "du", des: "des", la: "la", le: "le", d: "d", l: "l", van: "van", von: "von",
};

/** Les préfixes « Abd » (serviteur de) qui s'écrivent collés ou non : Abd El Kader, Abdel Kader, Abdelkader. */
const PREFIXES_ABD = new Set(["abd", "abdel", "abdal", "abdul", "abdou", "abdoul", "abdu"]);

/** Les abréviations courantes d'un prénom (« Med Benali » est Mohamed Benali). */
const ABREVIATIONS: Record<string, string> = { med: "mohamed", mhd: "mohamed", mohd: "mohamed" };

/**
 * Les MOTS d'un nom de personne, prêts à comparer : pliés, sans titres, particules attachées, abréviations
 * dépliées. Les initiales (« A. Benali ») sont retirées : elles ne départagent ni ne rapprochent.
 */
export function motsDuNom(nom: string | null | undefined): string[] {
  const bruts = plier(nom).split(" ").filter(Boolean).filter((m) => !TITRES.has(m) && !/^\d+$/.test(m));
  const mots: string[] = [];
  for (let i = 0; i < bruts.length; i++) {
    let m = bruts[i];
    // Les particules se suivent parfois (« Ben El Hadj ») : on les attache toutes au premier mot plein.
    if (PARTICULES[m] !== undefined || PREFIXES_ABD.has(m)) {
      let colle = PARTICULES[m] ?? m;
      let j = i + 1;
      while (j < bruts.length && (PARTICULES[bruts[j]] !== undefined) && j + 1 < bruts.length) colle += PARTICULES[bruts[j++]];
      if (j < bruts.length) { mots.push(colle + bruts[j]); i = j; continue; }
      // Une particule en dernier mot n'a rien à quoi s'attacher : c'est un mot (« Ali Ben »).
      if (m.length > 1) mots.push(m);
      continue;
    }
    m = ABREVIATIONS[m] ?? m;
    if (m.length > 1) mots.push(m);
  }
  return mots;
}

/**
 * LA CLÉ ORTHOGRAPHIQUE : les mots triés. « Dr BENALI Ahmed » = « Ahmed Ben Ali » = « ahmed benali ».
 * Vide quand le nom ne porte aucun mot (« Dr », « M. »).
 */
export function cleNomPersonne(nom: string | null | undefined): string {
  return [...motsDuNom(nom)].sort().join(" ");
}

/**
 * LA FORME PHONÉTIQUE D'UN MOT — les graphies latines d'un même nom arabe se rejoignent :
 *
 *   ch/sh/tch → ch   dj → j   kh → k   gh → g   q → k   ph → f   th → t   dh → d   ck → k
 *   c devant e/i → s (Kacem = Kassem = Qasim)   y → i, sauf en tête (Yamina ≠ Amina)
 *   lettres doublées simplifiées (Mohammed → Mohamed)
 *   préfixe Abd-el / Abd-ul / Abdou → abdal (Abdelkader = Abdulkader = Abdoulkader)
 *   ben- / bin- / ibn- → ben-  (déjà attachés par `motsDuNom`)
 *   « e » ou « h » final muet retiré (Amine = Amin, Abdallah = Abdalla)
 *   toute suite de voyelles → « a », sauf la voyelle finale « a » ou « i » qui reste distincte
 *   (Karim ≠ Karima, Amin ≠ Amina, Said ≠ Saidi, Brahim ≠ Brahimi)
 *
 * Le dernier point est le plus fort : Karim = Kerim, Khaled = Khalid, Amel = Amal, Mohamed = Muhammad,
 * Benali = Binali. Il rapproche aussi Salim et Salem — c'est pourquoi une clé phonétique ne vaut qu'un
 * « possible » tant qu'aucune autre donnée ne la confirme.
 */
export function motPhonetique(mot: string): string {
  let s = plier(mot).replace(/\s+/g, "");
  if (!s) return "";
  s = s.replace(/^(abdoul|abdal|abdel|abdul|abdou|abdu|abdl|abd)(?=[a-z]{3,})/, "abdal");
  s = s.replace(/^(bin|ibn)(?=[a-z]{2,})/, "ben");
  s = s
    .replace(/tch|sch|sh/g, "ch")
    .replace(/dj/g, "j")
    .replace(/kh/g, "k").replace(/gh/g, "g").replace(/ph/g, "f").replace(/th/g, "t").replace(/dh/g, "d")
    .replace(/ck|q|c(?=[aou])/g, "k").replace(/c(?=[eiy])/g, "s")
    .replace(/(?<=.)y/g, "i")
    .replace(/([a-z])\1+/g, "$1");
  // Le muet final : « e » (Amine), « h » après voyelle (Abdallah, Fatiha garde son « a » : fatia → fatia).
  s = s.replace(/([aeiou])h$/, "$1").replace(/(?<=[^aeiou])e$/, "");
  // La voyelle finale « a » ou « i » distingue (Karima ≠ Karim, Saidi ≠ Said) ; les autres tombent.
  const finale = s.length > 2 ? (/a$/.test(s) ? "a" : /i$/.test(s) ? "i" : "") : "";
  s = s.replace(/[aeiou]+/g, "a");
  if (/(?<=.)a$/.test(s)) s = s.slice(0, -1) + finale;
  return s;
}

/** LA CLÉ PHONÉTIQUE d'un nom : ses mots phonétiques, triés. */
export function clePhonetiquePersonne(nom: string | null | undefined): string {
  return motsDuNom(nom).map(motPhonetique).filter(Boolean).sort().join(" ");
}

/** Comment deux noms se ressemblent, du plus fort au plus faible. */
export type RessemblanceNom = "IDENTIQUE" | "PHONETIQUE" | "COMPATIBLE" | "PARTIEL" | "DIFFERENT" | "INCONNU";

/**
 * COMPARE DEUX NOMS.
 *   IDENTIQUE   — mêmes mots, dans n'importe quel ordre ;
 *   PHONETIQUE  — mêmes mots à la graphie près ;
 *   COMPATIBLE  — l'un contient l'autre et le plus court a au moins deux mots (un second prénom en plus) ;
 *   PARTIEL     — un seul mot en commun, l'un des deux n'en a qu'un (« Dr Benali » / « Ahmed Benali ») ;
 *   DIFFERENT   — rien de cela ; INCONNU — un des deux noms est vide.
 */
export function comparerNoms(a: string | null | undefined, b: string | null | undefined): RessemblanceNom {
  const ma = motsDuNom(a);
  const mb = motsDuNom(b);
  if (!ma.length || !mb.length) return "INCONNU";
  if ([...ma].sort().join(" ") === [...mb].sort().join(" ")) return "IDENTIQUE";
  const pa = ma.map(motPhonetique);
  const pb = mb.map(motPhonetique);
  if ([...pa].sort().join(" ") === [...pb].sort().join(" ")) return "PHONETIQUE";
  const [petit, grand] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  const reste = [...grand];
  const contenu = petit.every((m) => { const k = reste.indexOf(m); if (k < 0) return false; reste.splice(k, 1); return true; });
  if (contenu && petit.length >= 2) return "COMPATIBLE";
  if (contenu && petit.length === 1) return "PARTIEL";
  return "DIFFERENT";
}

/**
 * Le nom d'une fiche qui le porte en deux colonnes (nom, prénom) ET parfois en une (`name`) : la colonne
 * complète d'abord, sinon les deux parties. L'ordre n'a pas d'importance, la clé trie les mots.
 */
export function nomComplet(p: { nom?: string | null; prenom?: string | null; complet?: string | null }): string {
  const complet = (p.complet ?? "").trim();
  if (motsDuNom(complet).length >= 2) return complet;
  const parties = [p.prenom, p.nom].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
  return parties || complet;
}

// ─────────────────────────────── Téléphones ───────────────────────────────

export type NatureTelephone = "MOBILE" | "FIXE" | "ETRANGER";

export interface TelephoneNormalise {
  /** E.164 : « +213555123456 ». */
  e164: string;
  nature: NatureTelephone;
}

/**
 * UN TÉLÉPHONE ALGÉRIEN EN E.164. Formes acceptées : « 0555 12 34 56 », « +213 (0)5 55 12 34 56 »,
 * « 00213555123456 », « 213 555 12 34 56 », « 555123456 », « 021 23 45 67 », « 021-23-45-67 ».
 *
 *   mobile : 0 + [567] + 8 chiffres  → +213 5XX XX XX XX (MOBILE)
 *   fixe   : 0 + [1-4] + 7 chiffres  → +213 XX XX XX XX  (FIXE ; 021 Alger, 031 Constantine, 041 Oran…)
 *   un autre indicatif international (+33…, 0033…) : gardé tel quel (ÉTRANGER), 8 à 15 chiffres.
 *
 * `null` pour tout le reste : trop court, trop long, « 0000000000 », une suite de chiffres identiques.
 */
export function normaliserTelephone(v: string | null | undefined): TelephoneNormalise | null {
  let s = (v ?? "").trim();
  if (!s) return null;
  s = s.replace(/\(0\)/g, "").replace(/[\s().\-/]/g, "");
  if (/[^\d+]/.test(s)) return null;
  let international: string | null = null;
  if (s.startsWith("+")) international = s.slice(1);
  else if (s.startsWith("00")) international = s.slice(2);
  let national: string;
  if (international !== null) {
    if (!/^\d+$/.test(international)) return null;
    if (!international.startsWith("213")) {
      if (international.length < 8 || international.length > 15 || /^(\d)\1+$/.test(international)) return null;
      return { e164: `+${international}`, nature: "ETRANGER" };
    }
    national = international.slice(3).replace(/^0/, "");
  } else if (/^213\d{8,9}$/.test(s)) {
    national = s.slice(3);
  } else if (s.startsWith("0")) {
    national = s.slice(1);
  } else {
    national = s;
  }
  if (!/^\d+$/.test(national) || /^(\d)\1+$/.test(national)) return null;
  if (/^[567]\d{8}$/.test(national)) return { e164: `+213${national}`, nature: "MOBILE" };
  if (/^[1-4]\d{7}$/.test(national)) return { e164: `+213${national}`, nature: "FIXE" };
  return null;
}

/**
 * TOUS LES TÉLÉPHONES D'UN CHAMP : « 0555 12 34 56 / 0661 23 45 67 », « 021 23 45 67 - 0770 11 22 33 »,
 * « Tél : 0555123456 ; Fax : 021234567 » (le fax est un numéro comme un autre, on ne le devine pas).
 */
export function extraireTelephones(v: string | null | undefined): TelephoneNormalise[] {
  const s = v ?? "";
  if (!s.trim()) return [];
  const vus = new Map<string, TelephoneNormalise>();
  const morceaux = s.split(/[;,/|]|\s+(?:et|ou)\s+|\s[-–]\s|\n/i);
  for (const m of morceaux) {
    const candidat = m.replace(/^[^\d+]*/, "").replace(/[^\d)]*$/, "");
    const t = normaliserTelephone(candidat);
    if (t) vus.set(t.e164, t);
  }
  if (!vus.size) {
    const t = normaliserTelephone(s.replace(/^[^\d+]*/, ""));
    if (t) vus.set(t.e164, t);
  }
  return [...vus.values()];
}

// ─────────────────────────────── E-mails ───────────────────────────────

/** Les fournisseurs de messagerie personnelle : leur domaine ne dit rien de l'organisation. */
export const DOMAINES_WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "ymail.com", "hotmail.com", "hotmail.fr", "outlook.com",
  "outlook.fr", "live.com", "live.fr", "msn.com", "icloud.com", "me.com", "aol.com", "gmx.com", "gmx.fr",
  "protonmail.com", "proton.me", "laposte.net", "orange.fr", "free.fr", "sfr.fr", "wanadoo.fr", "mail.com", "yandex.com",
]);

/** Les boîtes PARTAGÉES (contact@, secretariat@…) : la même adresse pour plusieurs personnes. */
const LOCAUX_GENERIQUES = /^(contact|info|infos|information|admin|administration|secretariat|secretaire|direction|dg|accueil|commercial|commerciale|ventes?|sales|achats?|compta|comptabilite|finance|rh|hr|recrutement|support|service|noreply|no-reply|office|bureau|reception|pharmacie|labo|laboratoire|marketing|export|import|logistique|facturation|courrier|mail|email)\d*$/;

export interface EmailNormalise {
  /** Comparable : plié, Gmail sans points ni « +étiquette ». */
  cle: string;
  domaine: string;
  /** Boîte partagée : n'identifie pas une personne. */
  generique: boolean;
  webmail: boolean;
}

/** UN E-MAIL COMPARABLE, ou `null` si ce n'est pas une adresse. */
export function normaliserEmail(v: string | null | undefined): EmailNormalise | null {
  const n = emailNormalise(v);
  if (!EMAIL_RE.test(n)) return null;
  const at = n.lastIndexOf("@");
  let local = n.slice(0, at);
  const domaine = n.slice(at + 1).replace(/^googlemail\.com$/, "gmail.com");
  if (domaine === "gmail.com") local = local.replace(/\+.*$/, "").replace(/\./g, "");
  return {
    cle: `${local}@${domaine}`,
    domaine,
    generique: LOCAUX_GENERIQUES.test(local.replace(/[._-]/g, "")),
    webmail: DOMAINES_WEBMAIL.has(domaine),
  };
}

// ─────────────────────────────── Identifiants d'organisation ───────────────────────────────

const chiffres = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const repetitif = (s: string) => /^(\d)\1+$/.test(s);

/**
 * Le NIS (numéro d'identification statistique, ONS) : ses chiffres, 11 à 20. Les espaces et points ne
 * comptent pas ; une suite de zéros (« 000000000000000 », saisie pour « néant ») n'en est pas un.
 */
export function normaliserNis(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s || /[a-z]{3,}/i.test(s)) return null;
  const c = chiffres(s);
  return c.length >= 11 && c.length <= 20 && !repetitif(c) ? c : null;
}

/** L'article d'imposition : ses chiffres, 8 à 15. */
export function normaliserArticleImposition(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s || /[a-z]{3,}/i.test(s)) return null;
  const c = chiffres(s);
  return c.length >= 8 && c.length <= 15 && !repetitif(c) ? c : null;
}

/** Le NIF des pièces lues, sans les « néant » saisis en zéros. */
export function normaliserNifStrict(v: string | null | undefined): string | null {
  const n = normaliserNif(v);
  return n && !repetitif(n) ? n : null;
}

/** Le RC des pièces lues, sans les suites de zéros. */
export function normaliserRcStrict(v: string | null | undefined): string | null {
  const n = normaliserRc(v);
  return n && !repetitif(n.replace(/\D/g, "")) ? n : null;
}

// ─────────────────────────────── Noms d'organisations ───────────────────────────────

/**
 * LA CLÉ D'UNE ORGANISATION : `cleSociete` (formes juridiques retirées), les sigles recollés
 * (« C.H.U Mustapha-Pacha » = « CHU Mustapha Pacha », « E.P.H » = « EPH »).
 */
export function cleOrganisation(nom: string | null | undefined): string {
  const out: string[] = [];
  let lettres = "";
  for (const m of cleSociete(nom).split(" ").filter(Boolean)) {
    if (m.length === 1) { lettres += m; continue; }
    if (lettres) { out.push(lettres); lettres = ""; }
    out.push(m);
  }
  if (lettres) out.push(lettres);
  // Un sigle recollé peut être lui-même une forme juridique (« S.P.A ») : un second passage la retire.
  return cleSociete(out.join(" "));
}

// ─────────────────────────────── Lieux ───────────────────────────────

/**
 * UNE WILAYA COMPARABLE : son nom plié, ou son code (« 16 », « 16 - Alger », « Wilaya d'Alger » → « alger »).
 * Les 58 wilayas ne sont pas encore un référentiel (R3) : on compare les noms pliés, le code donne le nom.
 */
const WILAYAS = [
  "adrar", "chlef", "laghouat", "oum el bouaghi", "batna", "bejaia", "biskra", "bechar", "blida", "bouira",
  "tamanrasset", "tebessa", "tlemcen", "tiaret", "tizi ouzou", "alger", "djelfa", "jijel", "setif", "saida",
  "skikda", "sidi bel abbes", "annaba", "guelma", "constantine", "medea", "mostaganem", "msila", "mascara", "ouargla",
  "oran", "el bayadh", "illizi", "bordj bou arreridj", "boumerdes", "el tarf", "tindouf", "tissemsilt", "el oued", "khenchela",
  "souk ahras", "tipaza", "mila", "ain defla", "naama", "ain temouchent", "ghardaia", "relizane", "timimoun", "bordj badji mokhtar",
  "ouled djellal", "beni abbes", "in salah", "in guezzam", "touggourt", "djanet", "el mghair", "el meniaa",
];
const ALIAS_WILAYA: Record<string, string> = {
  algiers: "alger", "el djazair": "alger", "dzair": "alger", bougie: "bejaia", "m sila": "msila", "tizi": "tizi ouzou",
  "bba": "bordj bou arreridj", "sba": "sidi bel abbes", "oeb": "oum el bouaghi", "temouchent": "ain temouchent",
};

export function normaliserWilaya(v: string | null | undefined): string | null {
  let s = plier(v).replace(/^(wilaya|w)( de| d)?\s+/, "").trim();
  if (!s) return null;
  const code = s.match(/^(\d{1,2})\b/);
  if (code) {
    const n = Number(code[1]);
    if (n >= 1 && n <= WILAYAS.length) return WILAYAS[n - 1];
    s = s.slice(code[0].length).trim();
  }
  s = ALIAS_WILAYA[s] ?? s;
  return s || null;
}
