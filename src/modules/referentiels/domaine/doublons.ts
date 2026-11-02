/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOUBLONS DES RÉFÉRENTIELS — le système PROPOSE, une personne TRANCHE (refonte des données, palier P2,
 * `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` §3 R1-R2 et §4).
 *
 * Décision de la Direction : deux fiches ne sont JAMAIS fusionnées d'office. Ce module ne fusionne rien et
 * n'écrit rien : il compare des fiches deux à deux et rend, pour chaque paire qui se ressemble, un NIVEAU et
 * ses RAISONS lisibles. Le responsable du module ou le Super Admin décide.
 *
 *   CERTAIN   — un identifiant fort identique, et rien ne le contredit : NIF, RC ou NIS d'une organisation ;
 *               NIN, passeport ou e-mail PERSONNEL d'une personne ; ou un lien que l'ERP porte déjà.
 *   PROBABLE  — plusieurs indices concordants, ou un indice fort d'une autre nature : même mobile, même nom
 *               et même date de naissance, même nom dans le même établissement, même nom de société dans la
 *               même wilaya, identifiant fort identique MAIS contredit par un autre.
 *   POSSIBLE  — un indice faible : le nom seul, à la graphie près, dans la même wilaya ou nulle part ailleurs.
 *
 * ── LES FAUX POSITIFS CONNUS, TRAITÉS ICI ─────────────────────────────────────────────────
 *
 *   • HOMONYMES COURANTS — « Mohamed Benali », « Fatima Brahimi » : des dizaines de personnes réelles. Un
 *     rapprochement par le nom seul d'un nom courant descend d'un niveau (le POSSIBLE disparaît).
 *   • BOÎTES ET NUMÉROS PARTAGÉS — contact@, secretariat@, le standard d'un CHU : une boîte générique ne
 *     rapproche pas deux personnes ; un numéro porté par trois noms différents ou plus est un standard.
 *   • CONTRADICTIONS — deux dates de naissance, deux NIN, deux NIF différents : ce ne sont PAS les mêmes,
 *     quel que soit le nom. Deux sociétés d'un même groupe (« Saidal Médéa » / « Saidal Constantine »,
 *     même domaine, NIF distincts) sont écartées par leurs NIF, ou au plus « possibles » par leur domaine.
 *   • IDENTIFIANTS DU GROUPE — le NIF d'une société du groupe recopié sur un fournisseur (le client d'une
 *     pièce pris pour son émetteur, cf. `pieces-lues/fournisseur.ts`) ne rapproche rien.
 *
 * Module PUR : il n'importe que `normalisation.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  clePhonetiquePersonne, cleOrganisation, comparerNoms, extraireTelephones, motPhonetique, motsDuNom,
  normaliserArticleImposition, normaliserEmail, normaliserNifStrict, normaliserNis, normaliserRcStrict, normaliserWilaya,
  type EmailNormalise, type RessemblanceNom,
} from "./normalisation";

export type NiveauDoublon = "CERTAIN" | "PROBABLE" | "POSSIBLE";

const RANG: Record<NiveauDoublon, number> = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };
const DU_RANG: (NiveauDoublon | null)[] = [null, "POSSIBLE", "PROBABLE", "CERTAIN"];
const BASE_SCORE: Record<NiveauDoublon, number> = { CERTAIN: 90, PROBABLE: 60, POSSIBLE: 30 };

const plusFort = (a: NiveauDoublon | null, b: NiveauDoublon | null): NiveauDoublon | null =>
  (a ? RANG[a] : 0) >= (b ? RANG[b] : 0) ? a : b;
const descendre = (n: NiveauDoublon | null, crans = 1): NiveauDoublon | null => (n ? DU_RANG[Math.max(0, RANG[n] - crans)] : null);
const auPlus = (n: NiveauDoublon | null, plafond: NiveauDoublon): NiveauDoublon | null => (n && RANG[n] > RANG[plafond] ? plafond : n);

/** Le verdict sur UNE paire. `niveau: null` : pas un doublon — les `reserves` disent pourquoi quand c'est utile. */
export interface ComparaisonDoublon {
  niveau: NiveauDoublon | null;
  /** 0-100, pour trier les propositions d'un même niveau (plus d'indices concordants = plus haut). */
  score: number;
  /** Ce qui rapproche les deux fiches, en français. */
  raisons: string[];
  /** Ce qui éloigne, ou pourquoi le niveau a été abaissé. */
  reserves: string[];
}

export interface PropositionDoublon extends ComparaisonDoublon {
  a: string;
  b: string;
  niveau: NiveauDoublon;
}

class Verdict {
  niveau: NiveauDoublon | null = null;
  points = 0;
  raisons: string[] = [];
  reserves: string[] = [];
  indice(n: NiveauDoublon, raison: string, points = 2) {
    this.niveau = plusFort(this.niveau, n);
    this.points += points;
    this.raisons.push(raison);
  }
  rendre(): ComparaisonDoublon {
    const score = this.niveau ? Math.min(BASE_SCORE[this.niveau] + 9, BASE_SCORE[this.niveau] + this.points) : 0;
    return { niveau: this.niveau, score, raisons: this.raisons, reserves: this.reserves };
  }
}

const nonVides = <T>(xs: readonly (T | null | undefined)[] | null | undefined): T[] => (xs ?? []).filter((x): x is T => x != null && x !== "");

// ─────────────────────────────── Homonymes courants ───────────────────────────────

/**
 * Les noms de famille et prénoms les plus portés en Algérie (relevés ONS et annuaires, ordre de grandeur) :
 * un rapprochement par le nom seul n'y vaut rien. La liste est comparée en phonétique — « Benali » couvre
 * « Ben Ali » et « Bin Ali ».
 */
const NOMS_COURANTS = [
  "benali", "brahimi", "saidi", "mansouri", "hamidi", "belkacem", "haddad", "meziane", "bouzid", "cherif", "rahmani",
  "khelifi", "amrani", "ziani", "larbi", "slimani", "bouaziz", "benamar", "mebarki", "boudjemaa", "kaci", "djebbar",
  "bensaid", "benyahia", "belaid", "hamdi", "toumi", "ferhat", "aissaoui", "benmoussa", "touati", "bouzidi", "messaoudi",
  "benahmed", "hadjadj", "bekkouche", "boukhari", "taleb", "lounis", "chaib", "benchikh", "allouche",
  "bouchama", "bendjeddou", "boumediene", "laib", "yahiaoui", "hamadi", "kadri", "mokrani", "benabdallah",
];
const PRENOMS_COURANTS = [
  "mohamed", "ahmed", "ali", "abdelkader", "mustapha", "karim", "amine", "yacine", "sofiane", "rachid", "said", "omar",
  "youcef", "nabil", "samir", "farid", "kamel", "djamel", "hocine", "abdallah", "brahim", "ismail", "bilal", "walid",
  "fatima", "amina", "khadidja", "meriem", "nadia", "samira", "sarah", "yasmine", "souad", "leila", "nawel", "hanane",
  "imane", "asma", "lamia", "aicha", "zineb", "malika", "karima", "fatiha", "rym", "nesrine", "sabrina", "amel",
];
const PHON_NOMS_COURANTS = new Set(NOMS_COURANTS.map(motPhonetique));
const PHON_COURANTS = new Set([...NOMS_COURANTS, ...PRENOMS_COURANTS].map(motPhonetique));

/** Un nom dont TOUS les mots sont courants, dont au moins un nom de famille courant (« Mohamed Benali »). */
export function estNomCourant(nom: string | null | undefined): boolean {
  const mots = motsDuNom(nom).map(motPhonetique);
  return mots.length > 0 && mots.every((m) => PHON_COURANTS.has(m)) && mots.some((m) => PHON_NOMS_COURANTS.has(m));
}

// ─────────────────────────────── Personnes ───────────────────────────────

export interface FichePersonne {
  /** Unique dans le lot : « MedicalDoctor:ck… ». */
  ref: string;
  /** Le nom tel qu'affiché, titres compris (« Dr BENALI Ahmed »). */
  nom: string;
  emails?: readonly (string | null | undefined)[];
  /** Les champs téléphone bruts : un champ peut en porter plusieurs (« 0555… / 0661… »). */
  telephones?: readonly (string | null | undefined)[];
  /** Date de naissance, ISO « AAAA-MM-JJ » (ou `Date`). */
  naissance?: string | Date | null;
  wilaya?: string | null;
  /** L'établissement en texte (« CHU Mustapha ») et/ou sa fiche. */
  etablissement?: string | null;
  etablissementId?: string | null;
  nin?: string | null;
  passeport?: string | null;
  /** Les fiches que l'ERP relie DÉJÀ à celle-ci (Employee.userId, CareBeneficiary.doctorId…). */
  liens?: readonly string[];
}

export interface ContextePersonnes {
  /** Les numéros (E.164) portés par trop de noms différents : des standards, ils ne rapprochent rien. */
  telephonesPartages?: ReadonlySet<string>;
  /** Les e-mails (clé normalisée) portés par trop de noms différents. */
  emailsPartages?: ReadonlySet<string>;
}

const isoDate = (d: string | Date | null | undefined): string | null => {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const f = d.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return f ? `${f[3]}-${f[2].padStart(2, "0")}-${f[1].padStart(2, "0")}` : null;
};

const identifiantPersonne = (v: string | null | undefined): string | null => {
  const s = (v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length >= 6 && !/^(.)\1+$/.test(s) ? s : null;
};

const memeEtablissement = (a: FichePersonne, b: FichePersonne): boolean => {
  if (a.etablissementId && b.etablissementId) return a.etablissementId === b.etablissementId;
  const ka = cleComparable(a.etablissement);
  const kb = cleComparable(b.etablissement);
  return ka.length >= 3 && ka === kb;
};

const LIBELLE_NOM: Record<RessemblanceNom, string> = {
  IDENTIQUE: "même nom",
  PHONETIQUE: "même nom à la graphie près",
  COMPATIBLE: "noms compatibles (l'un complète l'autre)",
  PARTIEL: "un seul mot du nom en commun",
  DIFFERENT: "noms différents",
  INCONNU: "nom absent d'une des fiches",
};

/**
 * COMPARE DEUX FICHES PERSONNE. Ne rend jamais CERTAIN sans identifiant fort ; ne rend rien quand une
 * donnée certaine les distingue (deux NIN, deux dates de naissance) et qu'aucun identifiant ne les rejoint.
 */
export function comparerPersonnes(a: FichePersonne, b: FichePersonne, ctx: ContextePersonnes = {}): ComparaisonDoublon {
  const v = new Verdict();
  const nom = comparerNoms(a.nom, b.nom);
  const nomsProches = nom === "IDENTIQUE" || nom === "PHONETIQUE" || nom === "COMPATIBLE";
  let fort = false; // un identifiant ou un lien a parlé : les indices faibles ne comptent plus pour le niveau
  let contreditFort = false;

  // 0 — LE LIEN QUE L'ERP PORTE DÉJÀ.
  if (a.liens?.includes(b.ref) || b.liens?.includes(a.ref)) {
    v.indice("CERTAIN", "déjà reliées dans l'ERP", 5);
    fort = true;
  }

  // 1 — LES IDENTIFIANTS D'ÉTAT.
  for (const [cle, libelle] of [["nin", "NIN"], ["passeport", "n° de passeport"]] as const) {
    const x = identifiantPersonne(a[cle]);
    const y = identifiantPersonne(b[cle]);
    if (x && y && x === y) { v.indice("CERTAIN", `même ${libelle}`, 5); fort = true; }
    else if (x && y) { contreditFort = true; v.reserves.push(`${libelle} différents`); }
  }
  if (contreditFort && !fort) return { niveau: null, score: 0, raisons: [], reserves: [...v.reserves, "deux personnes distinctes"] };

  const na = isoDate(a.naissance);
  const nb = isoDate(b.naissance);
  const naissanceDiffere = !!na && !!nb && na !== nb;
  if (naissanceDiffere) v.reserves.push(`dates de naissance différentes (${na} / ${nb})`);

  // 2 — L'E-MAIL : personnel, il identifie ; générique (contact@, secretariat@) ou partagé, il ne dit rien.
  const ea = new Map(nonVides(a.emails).map(normaliserEmail).filter((e): e is EmailNormalise => e != null).map((e) => [e.cle, e]));
  for (const e of nonVides(b.emails).map(normaliserEmail)) {
    if (!e || !ea.has(e.cle)) continue;
    if (e.generique) { v.reserves.push(`boîte générique partagée (${e.cle}) : ne compte pas`); continue; }
    if (ctx.emailsPartages?.has(e.cle)) { v.reserves.push(`e-mail porté par plusieurs noms (${e.cle}) : ne compte pas`); continue; }
    if (nom === "DIFFERENT") {
      v.indice("PROBABLE", `même e-mail (${e.cle})`, 3);
      v.reserves.push("noms différents : boîte partagée (assistant, famille) ?");
    } else if (naissanceDiffere) {
      v.indice("PROBABLE", `même e-mail (${e.cle})`, 3);
    } else {
      v.indice("CERTAIN", `même e-mail personnel (${e.cle})`, 4);
      fort = true;
    }
  }

  // 3 — LE TÉLÉPHONE : un mobile désigne une personne (souvent), un fixe un lieu.
  const ta = new Map(nonVides(a.telephones).flatMap(extraireTelephones).map((t) => [t.e164, t]));
  for (const t of nonVides(b.telephones).flatMap(extraireTelephones)) {
    if (!ta.has(t.e164)) continue;
    if (ctx.telephonesPartages?.has(t.e164)) { v.reserves.push(`numéro porté par plusieurs noms (${t.e164}) : un standard, ne compte pas`); continue; }
    if (t.nature !== "FIXE") {
      if (nom === "DIFFERENT") {
        v.indice("POSSIBLE", `même mobile (${t.e164})`, 2);
        v.reserves.push("noms différents : famille, ou numéro réattribué ?");
      } else if (nom === "INCONNU") v.indice("POSSIBLE", `même mobile (${t.e164})`, 2);
      else v.indice("PROBABLE", `même mobile (${t.e164})`, 3);
    } else if (nomsProches) v.indice("PROBABLE", `même téléphone fixe (${t.e164})`, 2);
    else if (nom === "PARTIEL") v.indice("POSSIBLE", `même téléphone fixe (${t.e164})`, 1);
  }

  // 4 — LE NOM, avec ce qui le confirme.
  const wa = normaliserWilaya(a.wilaya);
  const wb = normaliserWilaya(b.wilaya);
  let parNom: NiveauDoublon | null = null;
  const raisonsNom: string[] = [];
  if (nom === "IDENTIQUE" && na && na === nb) { parNom = plusFort(parNom, "PROBABLE"); raisonsNom.push(`même nom et même date de naissance (${na})`); }
  if (nomsProches && memeEtablissement(a, b)) {
    parNom = plusFort(parNom, nom === "IDENTIQUE" ? "PROBABLE" : "POSSIBLE");
    raisonsNom.push(`${LIBELLE_NOM[nom]}, même établissement (${a.etablissement ?? b.etablissement ?? "fiche commune"})`);
  }
  if ((nom === "IDENTIQUE" || nom === "PHONETIQUE") && wa && wa === wb) {
    parNom = plusFort(parNom, "POSSIBLE");
    raisonsNom.push(`${LIBELLE_NOM[nom]}, même wilaya (${wa})`);
  }
  if ((nom === "IDENTIQUE" || nom === "PHONETIQUE") && !parNom && motsDuNom(a.nom).length >= 2 && motsDuNom(b.nom).length >= 2) {
    parNom = "POSSIBLE";
    raisonsNom.push(`${LIBELLE_NOM[nom]}, rien d'autre ne le confirme`);
  }
  if (parNom) {
    // Les CONTRADICTIONS d'un rapprochement par le nom.
    if (naissanceDiffere) { parNom = null; v.reserves.push("même nom mais pas la même personne"); }
    else if (wa && wb && wa !== wb) { parNom = descendre(parNom); v.reserves.push(`wilayas différentes (${wa} / ${wb})`); }
    if (parNom && (estNomCourant(a.nom) || estNomCourant(b.nom))) { parNom = descendre(parNom); v.reserves.push("nom très courant : les homonymes sont fréquents"); }
  }
  if (parNom) for (const r of raisonsNom) v.indice(parNom, r, parNom === "PROBABLE" ? 2 : 1);
  else if (v.niveau && nom !== "DIFFERENT" && nom !== "INCONNU") v.raisons.push(LIBELLE_NOM[nom]);

  // 5 — Une date de naissance différente plafonne tout ce qui n'est pas un identifiant d'État.
  if (naissanceDiffere && !fort) v.niveau = descendre(v.niveau);
  if (!fort) v.niveau = auPlus(v.niveau, "PROBABLE");
  return v.rendre();
}

// ─────────────────────────────── Organisations ───────────────────────────────

export interface FicheOrganisation {
  ref: string;
  nom: string;
  nif?: string | null;
  rc?: string | null;
  nis?: string | null;
  ai?: string | null;
  wilaya?: string | null;
  emails?: readonly (string | null | undefined)[];
  telephones?: readonly (string | null | undefined)[];
  liens?: readonly string[];
  /** Une société du groupe elle-même : ses identifiants comptent, même quand ce sont ceux du groupe. */
  estDuGroupe?: boolean;
}

export interface ContexteOrganisations {
  /** Les identifiants des sociétés du GROUPE : recopiés sur un tiers, ils ne le désignent pas. */
  identifiantsGroupe?: { nifs?: readonly (string | null | undefined)[]; rcs?: readonly (string | null | undefined)[]; nis?: readonly (string | null | undefined)[] };
  telephonesPartages?: ReadonlySet<string>;
}

/** Les mots qui ne DISTINGUENT pas deux organisations : « Biopharm » = « Biopharm Distribution ». */
const MOTS_VIDES = new Set([
  "de", "du", "des", "la", "le", "les", "et", "d", "l", "el", "al", "the", "of", "and", "dz",
  "societe", "entreprise", "ets", "etablissement", "etablissements", "algerie", "algerienne", "algerien",
  "distribution", "import", "export", "commerce", "general", "generale", "national", "nationale",
]);
/** Les mots qui disent la NATURE de l'organisation : ils distinguent (« Clinique El Nour » ≠ « Pharmacie El Nour »)
 *  mais ne nomment personne seuls (« Clinique Médicale »). */
const MOTS_DE_TYPE = new Set([
  "pharmacie", "clinique", "hopital", "chu", "eph", "ehs", "epsp", "eh", "polyclinique", "cabinet", "centre", "medical",
  "medicale", "agence", "bureau", "direction", "service", "sante", "hotel", "imprimerie", "transport", "transports",
]);

/** La clé comparable : la clé d'organisation sans les mots vides. */
const cleComparable = (nom: string | null | undefined): string => cleOrganisation(nom).split(" ").filter((m) => m && !MOTS_VIDES.has(m)).join(" ");

const motsSignifiants = (cle: string): string[] => cle.split(" ").filter((m) => m.length >= 3 && !MOTS_VIDES.has(m) && !MOTS_DE_TYPE.has(m));

/**
 * UN NOM QUI DÉSIGNE QUELQU'UN : au moins un mot qui n'est ni vide ni une nature (« CHU », « Clinique médicale »,
 * « Association » seuls ne nomment aucune organisation — les rapprocher réunirait tous les CHU en un).
 */
export function nomDesigneUneOrganisation(nom: string | null | undefined): boolean {
  return motsSignifiants(cleComparable(nom)).length > 0;
}

type TypeIdOrg = "NIF" | "RC" | "NIS";

/**
 * COMPARE DEUX FICHES ORGANISATION. CERTAIN : un NIF, un RC ou un NIS identique, sans identifiant contraire
 * et avec des noms qui se rapportent l'un à l'autre. Deux NIF (RC, NIS) différents : deux entités juridiques,
 * quel que soit le nom — c'est le cas des sociétés d'un même groupe.
 */
export function comparerOrganisations(a: FicheOrganisation, b: FicheOrganisation, ctx: ContexteOrganisations = {}): ComparaisonDoublon {
  const v = new Verdict();
  const g = ctx.identifiantsGroupe ?? {};
  const groupe: Record<TypeIdOrg, Set<string>> = {
    NIF: new Set(nonVides(g.nifs).map(normaliserNifStrict).filter((x): x is string => !!x)),
    RC: new Set(nonVides(g.rcs).map(normaliserRcStrict).filter((x): x is string => !!x)),
    NIS: new Set(nonVides(g.nis).map(normaliserNis).filter((x): x is string => !!x)),
  };
  const ids: [TypeIdOrg, string | null, string | null][] = [
    ["NIF", normaliserNifStrict(a.nif), normaliserNifStrict(b.nif)],
    ["RC", normaliserRcStrict(a.rc), normaliserRcStrict(b.rc)],
    ["NIS", normaliserNis(a.nis), normaliserNis(b.nis)],
  ];
  const egaux: string[] = [];
  const differents: string[] = [];
  for (const [type, x, y] of ids) {
    if (!x || !y) continue;
    if (x === y && groupe[type].has(x) && !a.estDuGroupe && !b.estDuGroupe) { v.reserves.push(`${type} d'une société du groupe recopié : ne compte pas`); continue; }
    if (x === y) egaux.push(type);
    else differents.push(type);
  }

  const ka = cleComparable(a.nom);
  const kb = cleComparable(b.nom);
  const sa = motsSignifiants(ka);
  const sb = motsSignifiants(kb);
  const communs = sa.filter((m) => sb.includes(m));
  const nomsSansRapport = sa.length > 0 && sb.length > 0 && communs.length === 0
    && !sa.some((m) => sb.some((n) => motPhonetique(m) === motPhonetique(n)));
  const wa = normaliserWilaya(a.wilaya);
  const wb = normaliserWilaya(b.wilaya);

  if (a.liens?.includes(b.ref) || b.liens?.includes(a.ref)) v.indice("CERTAIN", "déjà reliées dans l'ERP", 5);

  // 1 — LES IDENTIFIANTS FISCAUX.
  if (egaux.length) {
    const raison = `même ${egaux.join(" et même ")}`;
    if (differents.length) {
      v.indice("PROBABLE", raison, 4);
      v.reserves.push(`mais ${differents.join(", ")} différent(s) : une erreur de saisie à vérifier`);
    } else if (nomsSansRapport) {
      v.indice("PROBABLE", raison, 4);
      v.reserves.push("noms sans rapport : un identifiant recopié d'une autre fiche ?");
    } else v.indice("CERTAIN", raison, 3 + egaux.length);
  } else if (differents.length) {
    const reserve = `${differents.join(", ")} différent(s) : deux entités juridiques distinctes (sociétés d'un même groupe ?)`;
    // Seul un lien que l'ERP porte déjà survit à deux NIF différents — et il le dit.
    if (!v.niveau) return { niveau: null, score: 0, raisons: [], reserves: [...v.reserves, reserve] };
    v.reserves.push(reserve);
  }
  const ai = normaliserArticleImposition(a.ai);
  if (ai && ai === normaliserArticleImposition(b.ai)) v.indice("PROBABLE", "même article d'imposition", 3);

  // 2 — LE NOM, et la wilaya.
  if (ka && ka === kb && sa.length > 0) {
    if (wa && wb && wa !== wb) {
      v.indice("POSSIBLE", "même raison sociale", 1);
      v.reserves.push(`wilayas différentes (${wa} / ${wb}) : agences, filiales ou homonymes ?`);
    } else if (wa && wa === wb) v.indice("PROBABLE", `même raison sociale, même wilaya (${wa})`, 2);
    else v.indice("POSSIBLE", "même raison sociale", 1);
  } else if (sa.length && sb.length && !nomsSansRapport) {
    const [petit, grand] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    // Le plus court contenu dans le plus long, et pas deux natures différentes (« Clinique X » / « Pharmacie X »).
    const ta = ka.split(" ").filter((m) => MOTS_DE_TYPE.has(m));
    const tb = kb.split(" ").filter((m) => MOTS_DE_TYPE.has(m));
    const natures = ta.length && tb.length && !ta.some((m) => tb.includes(m));
    const contenu = !natures && petit.every((m) => grand.includes(m));
    if (contenu && (!wa || !wb || wa === wb) && petit.join("").length >= 4) {
      v.indice("POSSIBLE", "un nom contient l'autre", 1);
      v.reserves.push("même société, ou société du même groupe ?");
    }
  }

  // 3 — LES COORDONNÉES. Pour une organisation, contact@ est SON adresse : il compte.
  const ea = new Map(nonVides(a.emails).map(normaliserEmail).filter((e): e is EmailNormalise => e != null).map((e) => [e.cle, e]));
  const domainesA = new Set([...ea.values()].filter((e) => !e.webmail).map((e) => e.domaine));
  let domaineCommun: string | null = null;
  for (const e of nonVides(b.emails).map(normaliserEmail)) {
    if (!e) continue;
    if (ea.has(e.cle)) v.indice(nomsSansRapport ? "POSSIBLE" : "PROBABLE", `même e-mail (${e.cle})`, 2);
    else if (!e.webmail && domainesA.has(e.domaine)) domaineCommun = e.domaine;
  }
  if (domaineCommun && !v.raisons.some((r) => r.startsWith("même e-mail"))) {
    v.indice("POSSIBLE", `même domaine de messagerie (${domaineCommun})`, 1);
    v.reserves.push("un domaine est souvent celui de tout un groupe");
  }
  const ta = new Set(nonVides(a.telephones).flatMap(extraireTelephones).map((t) => t.e164));
  for (const t of nonVides(b.telephones).flatMap(extraireTelephones)) {
    if (!ta.has(t.e164)) continue;
    if (ctx.telephonesPartages?.has(t.e164)) { v.reserves.push(`numéro porté par plusieurs fiches (${t.e164}) : ne compte pas`); continue; }
    v.indice(nomsSansRapport ? "POSSIBLE" : "PROBABLE", `même téléphone (${t.e164})`, 2);
  }

  return v.rendre();
}

// ─────────────────────────────── Le lot : blocage, paires, regroupement ───────────────────────────────

/** Au-delà, un bloc (« même nom courant ») coûterait n² comparaisons pour des propositions sans valeur. */
export const TAILLE_MAX_BLOC = 300;

export interface ResultatLot {
  propositions: PropositionDoublon[];
  comparaisons: number;
  /** Les clés de blocage trop peuplées, ignorées (avec leur taille) : dit, pas tu. */
  blocsIgnores: { cle: string; taille: number }[];
}

function parBlocs<F extends { ref: string }>(
  fiches: readonly F[], cles: (f: F) => string[], comparer: (a: F, b: F) => ComparaisonDoublon,
): ResultatLot {
  const blocs = new Map<string, number[]>();
  fiches.forEach((f, i) => {
    for (const c of new Set(cles(f))) {
      const l = blocs.get(c);
      if (l) l.push(i);
      else blocs.set(c, [i]);
    }
  });
  const vues = new Set<string>();
  const propositions: PropositionDoublon[] = [];
  const blocsIgnores: { cle: string; taille: number }[] = [];
  let comparaisons = 0;
  for (const [cle, idx] of blocs) {
    if (idx.length < 2) continue;
    if (idx.length > TAILLE_MAX_BLOC) { blocsIgnores.push({ cle, taille: idx.length }); continue; }
    for (let i = 0; i < idx.length; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        const [x, y] = idx[i] < idx[j] ? [idx[i], idx[j]] : [idx[j], idx[i]];
        const k = `${x}|${y}`;
        if (vues.has(k)) continue;
        vues.add(k);
        comparaisons++;
        const r = comparer(fiches[x], fiches[y]);
        if (r.niveau) propositions.push({ ...r, niveau: r.niveau, a: fiches[x].ref, b: fiches[y].ref });
      }
    }
  }
  propositions.sort((p, q) => RANG[q.niveau] - RANG[p.niveau] || q.score - p.score || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  return { propositions, comparaisons, blocsIgnores: blocsIgnores.sort((p, q) => q.taille - p.taille) };
}

/** Les valeurs portées par `seuil` noms différents ou plus : des standards, des boîtes partagées. */
function partages<F>(fiches: readonly F[], valeurs: (f: F) => string[], nom: (f: F) => string, seuil: number): Set<string> {
  const noms = new Map<string, Set<string>>();
  for (const f of fiches) {
    const n = nom(f);
    for (const x of new Set(valeurs(f))) {
      const s = noms.get(x) ?? new Set<string>();
      s.add(n);
      noms.set(x, s);
    }
  }
  return new Set([...noms].filter(([, s]) => s.size >= seuil).map(([x]) => x));
}

export const SEUIL_PARTAGE = 3;

/**
 * LES DOUBLONS PROBABLES D'UN LOT DE PERSONNES. Les paires ne sont comparées que dans des BLOCS (même nom
 * phonétique, même e-mail, même téléphone, même mot du nom dans la même wilaya ou le même établissement) :
 * jamais n², et chaque paire une seule fois.
 */
export function proposerDoublonsPersonnes(fiches: readonly FichePersonne[]): ResultatLot & { contexte: ContextePersonnes } {
  const telephones = (f: FichePersonne) => nonVides(f.telephones).flatMap(extraireTelephones).map((t) => t.e164);
  const emails = (f: FichePersonne) => nonVides(f.emails).map(normaliserEmail).filter((e): e is EmailNormalise => e != null && !e.generique).map((e) => e.cle);
  const contexte: ContextePersonnes = {
    telephonesPartages: partages(fiches, telephones, (f) => clePhonetiquePersonne(f.nom), SEUIL_PARTAGE),
    emailsPartages: partages(fiches, emails, (f) => clePhonetiquePersonne(f.nom), SEUIL_PARTAGE),
  };
  const cles = (f: FichePersonne): string[] => {
    const out: string[] = [];
    const phon = clePhonetiquePersonne(f.nom);
    if (phon) out.push(`nom:${phon}`);
    for (const e of emails(f)) out.push(`email:${e}`);
    for (const t of telephones(f)) out.push(`tel:${t}`);
    for (const id of [f.nin, f.passeport]) { const x = identifiantPersonne(id); if (x) out.push(`id:${x}`); }
    for (const l of f.liens ?? []) out.push(`lien:${[f.ref, l].sort().join("|")}`);
    const w = normaliserWilaya(f.wilaya);
    const etab = f.etablissementId ?? (cleComparable(f.etablissement) || null);
    for (const m of motsDuNom(f.nom).map(motPhonetique).filter((x) => x.length >= 4)) {
      if (w) out.push(`mot:${m}|w:${w}`);
      if (etab) out.push(`mot:${m}|e:${etab}`);
    }
    return out;
  };
  return { ...parBlocs(fiches, cles, (a, b) => comparerPersonnes(a, b, contexte)), contexte };
}

/** LES DOUBLONS PROBABLES D'UN LOT D'ORGANISATIONS (blocs : identifiants, nom, coordonnées, mot + wilaya). */
export function proposerDoublonsOrganisations(
  fiches: readonly FicheOrganisation[], identifiantsGroupe?: ContexteOrganisations["identifiantsGroupe"],
): ResultatLot {
  const telephones = (f: FicheOrganisation) => nonVides(f.telephones).flatMap(extraireTelephones).map((t) => t.e164);
  const ctx: ContexteOrganisations = {
    identifiantsGroupe,
    telephonesPartages: partages(fiches, telephones, (f) => cleComparable(f.nom), SEUIL_PARTAGE),
  };
  const cles = (f: FicheOrganisation): string[] => {
    const out: string[] = [];
    const nif = normaliserNifStrict(f.nif); if (nif) out.push(`nif:${nif}`);
    const rc = normaliserRcStrict(f.rc); if (rc) out.push(`rc:${rc}`);
    const nis = normaliserNis(f.nis); if (nis) out.push(`nis:${nis}`);
    const ai = normaliserArticleImposition(f.ai); if (ai) out.push(`ai:${ai}`);
    const k = cleComparable(f.nom);
    if (k) out.push(`nom:${k}`);
    for (const e of nonVides(f.emails).map(normaliserEmail)) {
      if (!e) continue;
      out.push(`email:${e.cle}`);
      if (!e.webmail) out.push(`dom:${e.domaine}`);
    }
    for (const t of telephones(f)) out.push(`tel:${t}`);
    const w = normaliserWilaya(f.wilaya);
    for (const m of motsSignifiants(k).filter((x) => x.length >= 4)) out.push(w ? `mot:${m}|w:${w}` : `mot:${m}`);
    for (const l of f.liens ?? []) out.push(`lien:${[f.ref, l].sort().join("|")}`);
    return out;
  };
  return parBlocs(fiches, cles, (a, b) => comparerOrganisations(a, b, ctx));
}

/**
 * LES GROUPES qu'on obtiendrait en suivant les propositions d'au moins `niveauMin` — une ESTIMATION du nombre
 * de choses réelles, jamais une fusion. Union-Find sur les refs ; une fiche sans proposition est son propre groupe.
 */
export function regrouper(refs: readonly string[], propositions: readonly PropositionDoublon[], niveauMin: NiveauDoublon): string[][] {
  const parent = new Map(refs.map((r) => [r, r]));
  const racine = (r: string): string => {
    let x = r;
    while (parent.get(x) !== x) { const p = parent.get(x)!; parent.set(x, parent.get(p)!); x = p; }
    return x;
  };
  for (const p of propositions) {
    if (RANG[p.niveau] < RANG[niveauMin] || !parent.has(p.a) || !parent.has(p.b)) continue;
    const [x, y] = [racine(p.a), racine(p.b)];
    if (x !== y) parent.set(y, x);
  }
  const groupes = new Map<string, string[]>();
  for (const r of refs) {
    const k = racine(r);
    const g = groupes.get(k);
    if (g) g.push(r);
    else groupes.set(k, [r]);
  }
  return [...groupes.values()].sort((g, h) => h.length - g.length);
}

