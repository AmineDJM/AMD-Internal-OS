/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AD & PRO — LE MOTEUR (Direction, 14/10/2026 : « ce qui a déjà été intégré au budget, dans les
 * demandes Ad & Pro ; chercher bien profond dans tous nos fichiers et les faire matcher »).
 *
 * Deux questions, une même façon d'y répondre :
 *   • DÉPENSES → DEMANDES : une écriture FIN-, une ligne budgétaire, un ordre de dépense imputés à l'enveloppe HORS poste,
 *     ou une écriture « à imputer » de la société — à quelle demande du lot (et à quel poste) correspond-elle ?
 *   • PIÈCES → DEMANDES : un fichier de la plateforme (Legal, pièces Ad & Pro, secrétariat, Drive, messagerie…) — quelle
 *     demande justifie-t-il, et quelle pièce attendue couvre-t-il ?
 *
 * Les SIGNAUX, chacun avec ses points (plafond 100) — et chacun DIT dans la justification ce qu'il a vu :
 *   montant exact 40 · à 1 DZD près 35 · somme de plusieurs dépenses = un poste 30 · proche (≤ 1 %) 12 ;
 *   fournisseur identique 25 · proche 15 ; même mois que l'événement 10 · mois voisin 5 ; mots du libellé communs 5 par
 *   mot (15 au plus) ; référence concordante (SPO-, MP-, DIM-, PAY-, OD-, FIN-, n° de facture / BC) 30 ; pièce déjà sur la
 *   demande ou l'un de ses postes 30 ; type de pièce attendu 5. Ce que Luna a lu d'une pièce (fournisseur, montant, date,
 *   références) compte comme ce qui est imprimé sur l'écriture.
 *
 * LA RÈGLE « CERTAINE » (stricte, la seule qui autorise « Accepter toutes les propositions certaines ») :
 *   MÊME MONTANT AU CENTIME (à 0,01 DZD) + MÊME FOURNISSEUR (identique ou nom contenu dans l'autre) + RÉFÉRENCE
 *   CONCORDANTE — et UNE SEULE cible qui la remplit : deux cibles « certaines » pour une même source, ou deux sources
 *   « certaines » pour un même poste, redeviennent « probables ». « Probable » : 60 points ou plus. « Possible » : le
 *   reste, à partir de 35 points et d'au moins un signal fort (montant, référence, fournisseur, pièce sur la demande).
 *
 * Et en chemin : les dépenses qui n'ont visiblement rien d'Ad & Pro (location de voiture, séjour de la Direction
 * Générale…) — un SIGNALEMENT avec l'enveloppe plausible, jamais une imputation —, et les DOUBLONS PROBABLES.
 *
 * Module PUR, sans aucun import : lu par le serveur, l'écran (client) et les tests. Rien ici ne décide : il propose.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Certitude = "CERTAINE" | "PROBABLE" | "POSSIBLE";

export type CritereRapprochement =
  | "MONTANT_EXACT" | "MONTANT_1_DZD" | "MONTANT_PROCHE" | "SOMME"
  | "FOURNISSEUR" | "FOURNISSEUR_PROCHE"
  | "MOIS" | "MOIS_VOISIN"
  | "LIBELLE" | "REFERENCE" | "SUR_LA_DEMANDE" | "TYPE_ATTENDU";

export const POINTS: Record<CritereRapprochement, number> = {
  MONTANT_EXACT: 40, MONTANT_1_DZD: 35, SOMME: 30, MONTANT_PROCHE: 12,
  FOURNISSEUR: 25, FOURNISSEUR_PROCHE: 15,
  MOIS: 10, MOIS_VOISIN: 5,
  LIBELLE: 5, REFERENCE: 30, SUR_LA_DEMANDE: 30, TYPE_ATTENDU: 5,
};
/** Au plus 15 points pour les mots communs. */
const LIBELLE_MAX = 15;
/** En dessous, rien n'est proposé. */
export const SEUIL_PROPOSITION = 35;
/** À partir de là, « probable ». */
export const SEUIL_PROBABLE = 60;

export const REGLE_CERTAINE =
  "« Certaine » = même montant au centime + même fournisseur + référence concordante (SPO-, MP-, DIM-, PAY-, OD-, FIN-, n° de facture ou de BC), et une seule cible qui remplit les trois. Tout le reste attend un regard humain.";

// ─────────────────────────────── Normalisations ───────────────────────────────

/** Minuscules, sans accents, apostrophes en espaces, espaces réduits. */
export function plier(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’'`]/g, " ").replace(/\s+/g, " ").trim();
}

const MOTS_VIDES = new Set([
  "le", "la", "les", "de", "des", "du", "et", "en", "au", "aux", "pour", "par", "sur", "avec", "un", "une", "dans", "ou",
  "the", "of", "and", "to", "a", "d", "l", "n", "no", "nr", "chez", "sous", "son", "sa", "ses", "est", "pas", "plus",
]);
/** Des mots que portent toutes les dépenses : ils ne rapprochent rien. */
const MOTS_GENERIQUES = new Set([
  "facture", "factures", "fact", "paiement", "reglement", "regle", "frais", "depense", "depenses", "total", "dzd", "da", "ttc",
  "ht", "tva", "montant", "sarl", "spa", "eurl", "sas", "sasu", "ste", "societe", "ets", "etablissement", "service", "services",
  "prestation", "prestations", "achat", "achats", "bon", "commande", "devis", "pdf", "scan", "img", "jpg", "jpeg", "png", "doc",
  "docx", "xlsx", "xls", "copie", "ref", "reference", "num", "numero", "historique", "ligne", "poste", "postes", "demande",
  "demandes", "adpro", "pro", "piece", "pieces", "jointe", "version", "final", "finale", "signe", "signee", "client",
  "date", "objet", "algerie", "alger", "dinars", "dinar", "versement", "virement", "budget", "budgetaire", "marketing",
  "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
]);

/** Les mots qui portent un sens (3 lettres et plus, hors mots vides et génériques, hors nombres) — sans doublon. */
export function motsSignificatifs(...textes: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of textes) {
    for (const m of plier(t).split(/[^a-z0-9]+/)) {
      if (m.length < 3 || /^\d+$/.test(m) || MOTS_VIDES.has(m) || MOTS_GENERIQUES.has(m)) continue;
      out.add(m);
    }
  }
  return [...out];
}

/** Les formes juridiques et mots qui ne distinguent pas deux fournisseurs. */
const FORMES = /\b(sarl|spa|eurl|sas|sasu|snc|ste|societe|ets|etablissements?|ltd|llc|inc|group|groupe|cie|et fils)\b/g;

/** La clé d'un fournisseur (casse, accents et formes juridiques mis à part) — `null` si trop courte pour rien dire. */
export function cleFournisseur(nom: string | null | undefined): string | null {
  const c = plier(nom).replace(FORMES, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return c.length >= 3 ? c : null;
}

/** Le même fournisseur ? `MEME` (clés égales, ou l'une contenue dans l'autre), `PROCHE` (un mot fort commun), sinon `null`. */
export function memeFournisseur(a: string | null | undefined, b: string | null | undefined): "MEME" | "PROCHE" | null {
  const x = cleFournisseur(a), y = cleFournisseur(b);
  if (!x || !y) return null;
  if (x === y) return "MEME";
  const court = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
  if (court.length >= 4 && (` ${long} `).includes(` ${court} `)) return "MEME";
  const mx = new Set(motsSignificatifs(x).filter((m) => m.length >= 4));
  return motsSignificatifs(y).some((m) => m.length >= 4 && mx.has(m)) ? "PROCHE" : null;
}

// ─────────────────────────────── Références ───────────────────────────────

/** Les préfixes de référence de la plateforme (et ceux des pièces commerciales). */
const RE_REF = /\b(SPO|MP|DIM|PAY|OD|FIN|BC|FORM|DP|PR|DEV|FAC|FA|CN|CI|EVT|AP)\s?[-_/ ]\s?(20\d{2})\s?[-_/ ]\s?0*(\d{1,6})\b/gi;
/** Un numéro de pièce imprimé après « N° », « facture n° », « BC n° »… */
const RE_NUMERO = /(?:\bn\s?[°o]|\bnum(?:e|é)ro|\bfacture|\bfact\.?|\bbon de commande|\bbc)\s*[:#.]?\s*(?:n\s?[°o]\s*)?([a-z0-9][a-z0-9\-/.]{2,24})/gi;

/** « FA 2026/0012 », « fa2026-012 » → « NUM:FA-2026-12 » : groupes lettres / chiffres, zéros de tête retirés. */
export function cleNumeroPiece(v: string | null | undefined): string | null {
  const groupes = plier(v).toUpperCase().match(/[A-Z]+|\d+/g) ?? [];
  if (!groupes.some((g) => /\d/.test(g))) return null;
  const norm = groupes.map((g) => (/^\d+$/.test(g) ? String(Number(g)) : g)).join("-");
  // Un numéro d'un seul petit nombre (« 3 ») ne désigne rien.
  if (norm.replace(/-/g, "").length < 4) return null;
  return `NUM:${norm}`;
}

/** Les références lues dans des textes : `SPO-2026-7`, `FIN-2026-116`… et les numéros de pièce (`NUM:…`). */
export function extraireReferences(...textes: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of textes) {
    if (!t) continue;
    for (const m of t.matchAll(RE_REF)) out.add(`${m[1].toUpperCase()}-${m[2]}-${Number(m[3])}`);
    for (const m of t.matchAll(RE_NUMERO)) {
      const c = cleNumeroPiece(m[1]);
      // Une référence de plateforme captée après « n° » reste une référence de plateforme (déjà ajoutée plus haut).
      if (c && !/^NUM:(SPO|MP|DIM|PAY|OD|FIN|FORM)-20\d{2}-/.test(c)) out.add(c);
    }
  }
  return [...out];
}

// ─────────────────────────────── Montants, dates ───────────────────────────────

export type ComparaisonMontant = "EXACT" | "A_1_DZD" | "PROCHE" | null;

export function comparerMontants(a: number | null | undefined, b: number | null | undefined): ComparaisonMontant {
  if (a == null || b == null || !(a > 0) || !(b > 0)) return null;
  const d = Math.abs(a - b);
  if (d <= 0.005) return "EXACT";
  if (d <= 1.0000001) return "A_1_DZD";
  if (d / Math.max(a, b) <= 0.01) return "PROCHE";
  return null;
}

/** « 53 550 » / « 92 000,01 » — séparateur d'espace fine insécable remplacé par une espace simple. */
export function dzd(n: number): string {
  const r = Math.round(n * 100) / 100;
  const [e, d] = Math.abs(r).toFixed(2).split(".");
  const ent = e.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${r < 0 ? "−" : ""}${ent}${d === "00" ? "" : `,${d}`}`;
}

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** « 2026-07 » d'une date ISO (ou `null`). */
export function moisDe(iso: string | null | undefined): string | null {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null;
}
const libelleMois = (m: string) => `${MOIS_FR[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
/** « 08/07 » d'une date ISO. */
export const jourMois = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
function ecartMois(a: string, b: string): number {
  return Math.abs((Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7))) - (Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7))));
}

// ─────────────────────────────── Ce que Luna a lu ───────────────────────────────

/** Le résumé d'une pièce lue par Luna (gardé par empreinte, `AdProRapprochementLecture`). */
export interface LuDePiece {
  fournisseur: string | null;
  montant: number | null;
  /** ISO `AAAA-MM-JJ`. */
  date: string | null;
  numero: string | null;
  nature: string | null;
  references: string[];
  motsCles: string[];
}

// ─────────────────────────────── Les cibles : les demandes du lot ───────────────────────────────

export interface PosteCible {
  id: string;
  libelle: string;
  montant: number;
  fournisseur: string | null;
  /** ISO — la date du paiement (poste historique : dernier jour du mois du fichier). */
  date: string | null;
}

export interface PieceAttendueCible { cle: string; libelle: string }

export interface DemandeCible {
  /** `AdProIntegrationDemande.id`. */
  rowId: string;
  /** `TYPE:id`. */
  cle: string;
  type: string;
  libelle: string;
  montant: number;
  date: string | null;
  historique: boolean;
  fournisseurs: string[];
  /** Les références de la demande (sa référence, ses BC, ses factures connues). */
  references: string[];
  postes: PosteCible[];
  attendues: PieceAttendueCible[];
  /** Les clés des pièces attendues encore manquantes. */
  manquantes: string[];
  /** Les pièces (sources `DOC:` / `DRIVE:` / `MSG:`) déjà déposées ou rattachées : jamais reproposées. */
  piecesDeja: string[];
  /** Les dossiers qui portent la demande : `TYPE:id`, `AD_PRO_ITEM:<poste>`, `LEGAL_DOCUMENT:<BC ou facture d'un poste>`. */
  entites: string[];
}

// ─────────────────────────────── Le signal d'une source ───────────────────────────────

interface Signal {
  montants: { valeur: number; origine: string }[];
  fournisseurs: { nom: string; origine: string }[];
  dates: { iso: string; origine: string }[];
  mots: string[];
  references: string[];
  entite: string | null;
}

interface Evaluation {
  score: number;
  criteres: CritereRapprochement[];
  morceaux: string[];
}

interface CibleEvaluee {
  montant: number;
  fournisseurs: string[];
  date: string | null;
  mots: string[];
  references: string[];
  entites: string[];
}

function evaluer(s: Signal, c: CibleEvaluee, opts: { sansMontant?: boolean } = {}): Evaluation {
  const criteres: CritereRapprochement[] = [];
  const morceaux: string[] = [];
  let score = 0;
  const ajouter = (k: CritereRapprochement, phrase: string, points = POINTS[k]) => { criteres.push(k); morceaux.push(phrase); score += points; };

  // MONTANT — le meilleur des montants connus de la source.
  if (!opts.sansMontant) {
    let meilleur: { cmp: ComparaisonMontant; valeur: number; origine: string } | null = null;
    const rang = (x: ComparaisonMontant) => (x === "EXACT" ? 3 : x === "A_1_DZD" ? 2 : x === "PROCHE" ? 1 : 0);
    for (const m of s.montants) {
      const cmp = comparerMontants(m.valeur, c.montant);
      if (cmp && (!meilleur || rang(cmp) > rang(meilleur.cmp))) meilleur = { cmp, valeur: m.valeur, origine: m.origine };
    }
    if (meilleur?.cmp === "EXACT") ajouter("MONTANT_EXACT", `même montant ${dzd(c.montant)} DZD${meilleur.origine ? ` (${meilleur.origine})` : ""}`);
    else if (meilleur?.cmp === "A_1_DZD") ajouter("MONTANT_1_DZD", `montant à 1 DZD près (${dzd(meilleur.valeur)} / ${dzd(c.montant)} DZD)`);
    else if (meilleur?.cmp === "PROCHE") ajouter("MONTANT_PROCHE", `montant proche (${dzd(meilleur.valeur)} / ${dzd(c.montant)} DZD)`);
  }

  // FOURNISSEUR
  let f: { niveau: "MEME" | "PROCHE"; nom: string; origine: string } | null = null;
  for (const a of s.fournisseurs) {
    for (const b of c.fournisseurs) {
      const n = memeFournisseur(a.nom, b);
      if (n && (!f || (n === "MEME" && f.niveau === "PROCHE"))) f = { niveau: n, nom: b, origine: a.origine };
    }
  }
  if (f?.niveau === "MEME") ajouter("FOURNISSEUR", `fournisseur ${f.nom}${f.origine ? ` (${f.origine})` : ""}`);
  else if (f?.niveau === "PROCHE") ajouter("FOURNISSEUR_PROCHE", `fournisseur proche de ${f.nom}`);

  // DATE — le mois de l'événement.
  const mc = moisDe(c.date);
  if (mc) {
    let best: { ecart: number; iso: string; origine: string } | null = null;
    for (const d of s.dates) {
      const md = moisDe(d.iso);
      if (!md) continue;
      const e = ecartMois(md, mc);
      if (!best || e < best.ecart) best = { ecart: e, iso: d.iso, origine: d.origine };
    }
    if (best?.ecart === 0) ajouter("MOIS", `même mois (${libelleMois(mc)})${best.origine ? `, ${best.origine} du ${jourMois(best.iso)}` : ""}`);
    else if (best?.ecart === 1) ajouter("MOIS_VOISIN", `mois voisin (${libelleMois(moisDe(best.iso) as string)} / ${libelleMois(mc)})`);
  }

  // LIBELLÉS — les mots communs.
  const mots = new Set(c.mots);
  const communs = s.mots.filter((m) => mots.has(m)).slice(0, 6);
  if (communs.length) ajouter("LIBELLE", `mots communs : ${communs.join(", ")}`, Math.min(LIBELLE_MAX, POINTS.LIBELLE * communs.length));

  // RÉFÉRENCES
  const refs = new Set(c.references);
  const ref = s.references.find((r) => refs.has(r));
  if (ref) ajouter("REFERENCE", `référence ${ref.replace(/^NUM:/, "n° ")}`);

  // LA PIÈCE EST DÉJÀ SUR LA DEMANDE (ou sur l'un de ses postes, ou sur le BC d'un poste).
  if (s.entite && c.entites.includes(s.entite)) ajouter("SUR_LA_DEMANDE", "déjà jointe à la demande ou à l'un de ses postes");

  return { score: Math.min(100, score), criteres, morceaux };
}

const FORTS: ReadonlySet<CritereRapprochement> = new Set(["MONTANT_EXACT", "MONTANT_1_DZD", "MONTANT_PROCHE", "SOMME", "REFERENCE", "FOURNISSEUR", "SUR_LA_DEMANDE"]);
const aUnSignalFort = (c: readonly CritereRapprochement[]) => c.some((x) => FORTS.has(x));

/** La certitude d'UNE proposition, avant le contrôle d'unicité (`finaliser`). */
export function certitudeDe(criteres: readonly CritereRapprochement[], score: number): Certitude {
  if (criteres.includes("MONTANT_EXACT") && criteres.includes("FOURNISSEUR") && criteres.includes("REFERENCE")) return "CERTAINE";
  return score >= SEUIL_PROBABLE ? "PROBABLE" : "POSSIBLE";
}

// ─────────────────────────────── Les propositions ───────────────────────────────

export interface Proposition {
  /** La source : `TX:` / `LIGNE:` / `ORDRE:` (dépense) ou `DOC:` / `DRIVE:` / `MSG:` (pièce). */
  source: string;
  demandeRowId: string;
  demandeCle: string;
  demandeLibelle: string;
  posteId: string | null;
  posteLibelle: string | null;
  /** Une pièce : la pièce attendue qu'elle couvre (`null` : aucune ne correspond à son type). */
  pieceCle: string | null;
  pieceLibelle: string | null;
  score: number;
  certitude: Certitude;
  criteres: CritereRapprochement[];
  justification: string;
  /** Une somme : les AUTRES sources qui la font avec celle-ci. */
  avec: string[];
}

const RANG_CERTITUDE: Record<Certitude, number> = { CERTAINE: 0, PROBABLE: 1, POSSIBLE: 2 };
export const trierPropositions = (a: Proposition, b: Proposition) =>
  RANG_CERTITUDE[a.certitude] - RANG_CERTITUDE[b.certitude] || b.score - a.score || a.demandeLibelle.localeCompare(b.demandeLibelle);

function phrase(e: Evaluation, cible: string): string {
  return `${e.morceaux.join(", ")} = ${cible}`;
}

// Les cibles se préparent UNE fois (mots, fournisseurs) : des milliers de pièces se comparent aux mêmes demandes.
const prepDemandes = new WeakMap<DemandeCible, CibleEvaluee>();
const prepPostes = new WeakMap<PosteCible, CibleEvaluee>();
const cibleDemande = (d: DemandeCible): CibleEvaluee => {
  let c = prepDemandes.get(d);
  if (!c) {
    c = { montant: d.montant, fournisseurs: d.fournisseurs, date: d.date, mots: motsSignificatifs(d.libelle), references: d.references, entites: d.entites };
    prepDemandes.set(d, c);
  }
  return c;
};
const ciblePoste = (d: DemandeCible, p: PosteCible): CibleEvaluee => {
  let c = prepPostes.get(p);
  if (!c) {
    c = {
      montant: p.montant,
      fournisseurs: [...(p.fournisseur ? [p.fournisseur] : []), ...d.fournisseurs],
      date: p.date ?? d.date,
      mots: motsSignificatifs(d.libelle, p.libelle),
      references: d.references,
      entites: d.entites,
    };
    prepPostes.set(p, c);
  }
  return c;
};

/** La meilleure lecture d'UNE source contre UNE demande : la demande entière, ou l'un de ses postes (à score égal, le poste). */
function meilleurContre(s: Signal, d: DemandeCible, opts: { sansMontant?: boolean } = {}): { e: Evaluation; poste: PosteCible | null } {
  let best: { e: Evaluation; poste: PosteCible | null } = { e: evaluer(s, cibleDemande(d), opts), poste: null };
  for (const p of d.postes) {
    const e = evaluer(s, ciblePoste(d, p), opts);
    if (e.score >= best.e.score) best = { e, poste: p };
  }
  // Une demande d'UN seul poste au montant de la demande : le poste.
  if (!best.poste && d.postes.length === 1) best = { ...best, poste: d.postes[0] };
  return best;
}

function nommer(d: DemandeCible, p: PosteCible | null): string {
  return p && d.postes.length > 1 ? `« ${p.libelle} » de ${d.libelle}` : d.libelle;
}

// ─────────────────────────────── Dépenses → demandes ───────────────────────────────

export type NatureDepense = "ECRITURE" | "LIGNE" | "ORDRE";

export interface DepenseARapprocher {
  source: string;
  nature: NatureDepense;
  /** Une écriture de la société pas encore imputée à une catégorie. */
  aImputer: boolean;
  reference: string;
  libelle: string;
  montant: number;
  date: string;
  fournisseur: string | null;
  /** Ce que la dépense dit encore d'elle : rubrique, noms de ses pièces, catégorie… */
  indices: string[];
  /** Ce que Luna a lu des pièces de la dépense (la facture jointe à l'écriture…). */
  lu: (LuDePiece & { nom: string })[];
}

function signalDepense(dep: DepenseARapprocher): Signal {
  return {
    montants: [{ valeur: dep.montant, origine: "" }, ...dep.lu.filter((l) => l.montant != null).map((l) => ({ valeur: l.montant as number, origine: `lu par Luna sur ${l.nom}` }))],
    fournisseurs: [...(dep.fournisseur ? [{ nom: dep.fournisseur, origine: "" }] : []), ...dep.lu.filter((l) => l.fournisseur).map((l) => ({ nom: l.fournisseur as string, origine: `lu par Luna sur ${l.nom}` }))],
    dates: [{ iso: dep.date, origine: "" }, ...dep.lu.filter((l) => l.date).map((l) => ({ iso: l.date as string, origine: `pièce` }))],
    mots: motsSignificatifs(dep.libelle, dep.fournisseur, ...dep.indices, ...dep.lu.flatMap((l) => l.motsCles)),
    references: [...extraireReferences(dep.reference, dep.libelle, ...dep.indices), ...dep.lu.flatMap((l) => [...l.references, ...(l.numero ? [cleNumeroPiece(l.numero)].filter((x): x is string => Boolean(x)) : [])])],
    entite: null,
  };
}

/** Les propositions DIRECTES d'une dépense (sans les sommes), triées, trois au plus. */
export function proposerPourDepense(dep: DepenseARapprocher, cibles: readonly DemandeCible[]): Proposition[] {
  const s = signalDepense(dep);
  const out: Proposition[] = [];
  for (const d of cibles) {
    const { e, poste } = meilleurContre(s, d);
    if (e.score < SEUIL_PROPOSITION || !aUnSignalFort(e.criteres)) continue;
    out.push({
      source: dep.source, demandeRowId: d.rowId, demandeCle: d.cle, demandeLibelle: d.libelle,
      posteId: poste?.id ?? null, posteLibelle: poste?.libelle ?? null, pieceCle: null, pieceLibelle: null,
      score: e.score, certitude: certitudeDe(e.criteres, e.score), criteres: e.criteres, justification: phrase(e, nommer(d, poste)), avec: [],
    });
  }
  return out.sort(trierPropositions).slice(0, 3);
}

/**
 * LES SOMMES — deux ou trois dépenses qui, ensemble, font le montant d'un poste (ou d'une demande) à 1 DZD près. Pour ne
 * pas inventer des sommes au hasard, seules entrent celles qui partagent avec la cible un fournisseur, un mot du libellé
 * ou le mois (à un mois près). Cinq combinaisons par cible au plus.
 */
export function sommesPossibles(depenses: readonly DepenseARapprocher[], cibles: readonly DemandeCible[]): Proposition[] {
  const out: Proposition[] = [];
  const signaux = new Map(depenses.map((d) => [d.source, signalDepense(d)]));
  const tolerance = 1.0000001;
  for (const d of cibles) {
    const cibs: { c: CibleEvaluee; poste: PosteCible | null }[] = [
      ...d.postes.map((p) => ({ c: ciblePoste(d, p), poste: p })),
      ...(d.postes.length > 1 ? [{ c: cibleDemande(d), poste: null }] : []),
    ];
    for (const { c, poste } of cibs) {
      const parentes = depenses
        .filter((x) => x.montant > 0 && x.montant < c.montant - 0.5)
        .map((x) => ({ x, e: evaluer(signaux.get(x.source) as Signal, c, { sansMontant: true }) }))
        .filter(({ e }) => e.criteres.some((k) => k === "FOURNISSEUR" || k === "FOURNISSEUR_PROCHE" || k === "LIBELLE" || k === "MOIS" || k === "MOIS_VOISIN" || k === "REFERENCE"))
        .sort((a, b) => b.e.score - a.e.score)
        .slice(0, 60);
      const combos: { membres: typeof parentes }[] = [];
      for (let i = 0; i < parentes.length && combos.length < 5; i++) {
        for (let j = i + 1; j < parentes.length && combos.length < 5; j++) {
          const s2 = parentes[i].x.montant + parentes[j].x.montant;
          if (Math.abs(s2 - c.montant) <= tolerance) { combos.push({ membres: [parentes[i], parentes[j]] }); continue; }
          if (s2 >= c.montant) continue;
          for (let k = j + 1; k < parentes.length && combos.length < 5; k++) {
            if (Math.abs(s2 + parentes[k].x.montant - c.montant) <= tolerance) combos.push({ membres: [parentes[i], parentes[j], parentes[k]] });
          }
        }
      }
      for (const combo of combos) {
        const refs = combo.membres.map((m) => m.x.reference).join(" + ");
        for (const m of combo.membres) {
          const score = Math.min(100, POINTS.SOMME + m.e.score);
          const criteres: CritereRapprochement[] = ["SOMME", ...m.e.criteres];
          out.push({
            source: m.x.source, demandeRowId: d.rowId, demandeCle: d.cle, demandeLibelle: d.libelle,
            posteId: poste?.id ?? (d.postes.length === 1 ? d.postes[0].id : null), posteLibelle: poste?.libelle ?? null, pieceCle: null, pieceLibelle: null,
            score, certitude: score >= SEUIL_PROBABLE ? "PROBABLE" : "POSSIBLE", criteres,
            justification: `${combo.membres.length} dépenses (${refs}) font ensemble ${dzd(c.montant)} DZD${m.e.morceaux.length ? `, ${m.e.morceaux.join(", ")}` : ""} = ${nommer(d, poste)}`,
            avec: combo.membres.filter((o) => o.x.source !== m.x.source).map((o) => o.x.source),
          });
        }
      }
    }
  }
  return out;
}

/**
 * LE CONTRÔLE D'UNICITÉ de la règle « certaine » : une source « certaine » pour deux cibles, ou deux sources « certaines »
 * pour un même poste (ou une même demande sans poste), redeviennent « probables ».
 */
export function finaliser(propositions: readonly Proposition[]): Proposition[] {
  const parSource = new Map<string, number>();
  const parCible = new Map<string, number>();
  const cibleDe = (p: Proposition) => `${p.demandeRowId}|${p.posteId ?? ""}|${p.pieceCle ?? ""}`;
  for (const p of propositions) {
    if (p.certitude !== "CERTAINE") continue;
    parSource.set(p.source, (parSource.get(p.source) ?? 0) + 1);
    parCible.set(cibleDe(p), (parCible.get(cibleDe(p)) ?? 0) + 1);
  }
  return propositions.map((p) => {
    if (p.certitude !== "CERTAINE") return p;
    if ((parSource.get(p.source) ?? 0) > 1) return { ...p, certitude: "PROBABLE" as const, justification: `${p.justification} — plusieurs cibles remplissent la règle « certaine » : à trancher` };
    if ((parCible.get(cibleDe(p)) ?? 0) > 1) return { ...p, certitude: "PROBABLE" as const, justification: `${p.justification} — une autre source vise la même cible : à trancher` };
    return p;
  });
}

/** Toutes les propositions des dépenses : directes et sommes, fusionnées (la meilleure par cible), unicité contrôlée. */
export function rapprocherDepenses(depenses: readonly DepenseARapprocher[], cibles: readonly DemandeCible[]): Map<string, Proposition[]> {
  const toutes = [...depenses.flatMap((d) => proposerPourDepense(d, cibles)), ...sommesPossibles(depenses, cibles)];
  const meilleures = new Map<string, Proposition>();
  for (const p of toutes) {
    const k = `${p.source}|${p.demandeRowId}|${p.posteId ?? ""}`;
    const deja = meilleures.get(k);
    if (!deja || p.score > deja.score) meilleures.set(k, p);
  }
  const finales = finaliser([...meilleures.values()]);
  const out = new Map<string, Proposition[]>();
  for (const p of finales) out.set(p.source, [...(out.get(p.source) ?? []), p]);
  for (const [k, v] of out) out.set(k, v.sort(trierPropositions).slice(0, 3));
  return out;
}

// ─────────────────────────────── « Pas Ad & Pro » ───────────────────────────────

export interface IndiceHorsAdPro {
  raison: string;
  /** L'enveloppe plausible — une suggestion, jamais une imputation. */
  enveloppe: string;
}

const REGLES_HORS_ADPRO: { re: RegExp; raison: string; enveloppe: string }[] = [
  { re: /\blocation\b.{0,40}\b(voitures?|vehicules?|autos?|automobiles?)\b|\b(voitures?|vehicules?)\b.{0,40}\blocation\b|\bcarburant|\bgasoil|\bessence\b|\bpeage/, raison: "location ou frais de véhicule", enveloppe: "Operations & Sales" },
  { re: /\b(dg|pdg|directeur general|direction generale)\b/, raison: "frais de la Direction Générale", enveloppe: "Operations & Sales" },
  { re: /\b(loyer|electricite|sonelgaz|seaal|internet|telephonie|abonnement|assurance|femme de menage|nettoyage)\b/, raison: "frais de structure", enveloppe: "Moyens généraux" },
];

/** Une dépense qui, à son libellé, n'a visiblement rien d'Ad & Pro — un signalement à confirmer, avec l'enveloppe plausible. */
export function indiceHorsAdPro(dep: Pick<DepenseARapprocher, "libelle" | "fournisseur" | "indices">): IndiceHorsAdPro | null {
  const t = plier([dep.libelle, dep.fournisseur, ...dep.indices].filter(Boolean).join(" "));
  for (const r of REGLES_HORS_ADPRO) if (r.re.test(t)) return { raison: r.raison, enveloppe: r.enveloppe };
  return null;
}

// ─────────────────────────────── Pièces → demandes ───────────────────────────────

export type TypePiece =
  | "FACTURE" | "PROFORMA" | "DEVIS" | "BC" | "CONVENTION" | "CONTRAT" | "VIREMENT" | "QUITTANCE" | "RECU" | "BILLET"
  | "HONORAIRES" | "EMARGEMENT" | "PROGRAMME" | "BAT" | "VISA" | "LISTE" | "AUTRE";

export const LIBELLE_TYPE_PIECE: Record<TypePiece, string> = {
  FACTURE: "facture", PROFORMA: "pro forma", DEVIS: "devis", BC: "bon de commande", CONVENTION: "convention", CONTRAT: "contrat",
  VIREMENT: "preuve de virement", QUITTANCE: "quittance / bon de versement", RECU: "reçu", BILLET: "billet", HONORAIRES: "note d'honoraires",
  EMARGEMENT: "liste d'émargement", PROGRAMME: "programme", BAT: "BAT", VISA: "décision de visa", LISTE: "liste", AUTRE: "pièce",
};

const TYPES_PAR_MOTS: { type: TypePiece; re: RegExp }[] = [
  { type: "PROFORMA", re: /\bpro ?forma\b/ },
  { type: "HONORAIRES", re: /\bhonoraires?\b/ },
  { type: "QUITTANCE", re: /\b(quittance|bordereaux? de versement|bon de versement)\b/ },
  { type: "FACTURE", re: /\b(facture|invoice|fact)\b/ },
  { type: "DEVIS", re: /\b(devis|quotation|offre de prix|cotation)\b/ },
  { type: "BC", re: /\b(bon de commande|purchase order|bc)\b/ },
  { type: "CONVENTION", re: /\b(convention|lettre de sponsoring|accord de sponsoring)\b/ },
  { type: "CONTRAT", re: /\bcontrat\b/ },
  { type: "VIREMENT", re: /\b(virement|swift|avis de debit|ordre de virement)\b/ },
  { type: "RECU", re: /\brecus?\b/ },
  { type: "BILLET", re: /\b(billets?|e ?tickets?|itineraire)\b/ },
  { type: "EMARGEMENT", re: /\bemargement\b/ },
  { type: "PROGRAMME", re: /\bprogramme\b/ },
  { type: "BAT", re: /\bbat\b/ },
  { type: "VISA", re: /\b(visa|decision)\b/ },
  { type: "LISTE", re: /\bliste\b/ },
];

const TYPE_DU_REGISTRE: Record<string, TypePiece> = {
  INVOICE: "FACTURE", QUOTE: "DEVIS", PURCHASE_ORDER: "BC", AGREEMENT: "CONVENTION", CONTRACT: "CONTRAT", AMENDMENT: "CONTRAT",
};

/** Le type d'une pièce : la nature du registre Legal, puis celle que Luna a lue au titre, puis les mots du nom. */
export function typeDePiece(p: { nom: string; titre?: string | null; kind?: string | null; natureLue?: string | null }): TypePiece {
  if (p.kind && TYPE_DU_REGISTRE[p.kind]) return TYPE_DU_REGISTRE[p.kind];
  if (p.natureLue === "PRO_FORMA") return "PROFORMA";
  const t = plier(`${p.nom} ${p.titre ?? ""}`).replace(/[_\-.]+/g, " ");
  for (const r of TYPES_PAR_MOTS) if (r.re.test(t)) return r.type;
  if (p.natureLue === "FACTURE" || p.natureLue === "ACOMPTE") return "FACTURE";
  return "AUTRE";
}

/** Les mots qu'une pièce attendue doit porter pour qu'un type la couvre. */
const MOTS_ATTENDUS: Record<TypePiece, string[]> = {
  FACTURE: ["facture"], PROFORMA: ["pro forma", "proforma"], DEVIS: ["devis"], BC: ["bon de commande"],
  CONVENTION: ["convention", "lettre de sponsoring"], CONTRAT: ["contrat", "convention"], VIREMENT: ["virement"],
  QUITTANCE: ["quittance", "versement"], RECU: ["recu"], BILLET: ["billet"], HONORAIRES: ["honoraires"], EMARGEMENT: ["emargement"],
  PROGRAMME: ["programme"], BAT: ["bat"], VISA: ["visa", "decision"], LISTE: ["liste"], AUTRE: [],
};

/** La pièce attendue qu'un type couvre — une MANQUANTE d'abord, sinon la première qui convient ; `null` sinon. */
export function attendueCouverte(type: TypePiece, attendues: readonly PieceAttendueCible[], manquantes: readonly string[]): PieceAttendueCible | null {
  const mots = MOTS_ATTENDUS[type];
  if (mots.length === 0) return null;
  const conviennent = attendues.filter((a) => {
    const l = plier(a.libelle);
    return mots.some((m) => (` ${l} `).includes(` ${m} `) || l.includes(m));
  });
  return conviennent.find((a) => manquantes.includes(a.cle)) ?? conviennent[0] ?? null;
}

export interface PieceARapprocher {
  source: string;
  nom: string;
  /** Où elle vit, dit à la personne (« Legal — BC-2026-014 », « Drive », « Messagerie »…). */
  ou: string;
  href: string | null;
  /** Le dossier qui la porte (`TYPE:id`) — `null` pour le Drive et la messagerie. */
  entite: string | null;
  /** Ce que le registre sait déjà (une pièce Legal : titre, référence, contrepartie, montant, nature). */
  meta: { titre?: string | null; reference?: string | null; fournisseur?: string | null; montant?: number | null; kind?: string | null; date?: string | null };
  lu: LuDePiece | null;
}

function signalPiece(p: PieceARapprocher): Signal {
  const lu = p.lu;
  return {
    montants: [
      ...(lu?.montant != null ? [{ valeur: lu.montant, origine: "lu par Luna" }] : []),
      ...(p.meta.montant != null ? [{ valeur: p.meta.montant, origine: "au registre" }] : []),
    ],
    fournisseurs: [
      ...(lu?.fournisseur ? [{ nom: lu.fournisseur, origine: "lu par Luna" }] : []),
      ...(p.meta.fournisseur ? [{ nom: p.meta.fournisseur, origine: "au registre" }] : []),
    ],
    dates: [...(lu?.date ? [{ iso: lu.date, origine: "pièce" }] : []), ...(p.meta.date ? [{ iso: p.meta.date, origine: "pièce" }] : [])],
    mots: motsSignificatifs(p.nom.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_\-.]+/g, " "), p.meta.titre, ...(lu?.motsCles ?? [])),
    references: [
      ...extraireReferences(p.nom, p.meta.titre, p.meta.reference),
      ...(p.meta.reference ? [cleNumeroPiece(p.meta.reference)].filter((x): x is string => Boolean(x)) : []),
      ...(lu?.references ?? []),
      ...(lu?.numero ? [cleNumeroPiece(lu.numero)].filter((x): x is string => Boolean(x)) : []),
    ],
    entite: p.entite,
  };
}

/** Les propositions d'une pièce (deux au plus), chacune avec la pièce attendue qu'elle couvre. */
export function proposerPourPiece(p: PieceARapprocher, cibles: readonly DemandeCible[]): Proposition[] {
  const s = signalPiece(p);
  // Sans montant, fournisseur, référence ni dossier, une pièce ne peut pas atteindre le seuil (mots 15 + mois 10 + type 5) :
  // inutile de la comparer aux demandes.
  if (s.montants.length === 0 && s.fournisseurs.length === 0 && s.references.length === 0 && !s.entite) return [];
  const type = typeDePiece({ nom: p.nom, titre: p.meta.titre, kind: p.meta.kind, natureLue: p.lu?.nature });
  const out: Proposition[] = [];
  for (const d of cibles) {
    if (d.piecesDeja.includes(p.source)) continue;
    const { e, poste } = meilleurContre(s, d);
    const attendue = attendueCouverte(type, d.attendues, d.manquantes);
    let score = e.score;
    const criteres = [...e.criteres];
    const morceaux = [...e.morceaux];
    if (attendue) { criteres.push("TYPE_ATTENDU"); score = Math.min(100, score + POINTS.TYPE_ATTENDU); morceaux.unshift(`${LIBELLE_TYPE_PIECE[type]} → « ${attendue.libelle} »${d.manquantes.includes(attendue.cle) ? " (manquante)" : ""}`); }
    if (score < SEUIL_PROPOSITION || !aUnSignalFort(criteres)) continue;
    out.push({
      source: p.source, demandeRowId: d.rowId, demandeCle: d.cle, demandeLibelle: d.libelle,
      posteId: poste?.id ?? null, posteLibelle: poste?.libelle ?? null,
      pieceCle: attendue?.cle ?? null, pieceLibelle: attendue?.libelle ?? null,
      score, certitude: certitudeDe(criteres, score), criteres,
      justification: `${morceaux.join(", ")} = ${nommer(d, poste)}`, avec: [],
    });
  }
  return out.sort(trierPropositions).slice(0, 2);
}

/** Toutes les propositions des pièces, unicité « certaine » contrôlée. */
export function rapprocherPieces(pieces: readonly PieceARapprocher[], cibles: readonly DemandeCible[]): Proposition[] {
  return finaliser(pieces.flatMap((p) => proposerPourPiece(p, cibles))).sort(trierPropositions);
}

// ─────────────────────────────── Les doublons probables ───────────────────────────────

export type NatureElement = "ECRITURE" | "A_IMPUTER" | "LIGNE" | "ORDRE" | "POSTE_HISTORIQUE" | "POSTE";

export interface ElementDoublon {
  cle: string;
  nature: NatureElement;
  reference: string;
  libelle: string;
  montant: number;
  date: string | null;
  fournisseur: string | null;
  /** La demande d'un poste (`TYPE:id`) — deux postes d'une même demande ne sont pas des doublons l'un de l'autre. */
  groupe: string | null;
  href: string | null;
}

export type MotifDoublon = "MEME_FOURNISSEUR" | "MONTANT_QUASI_EGAL" | "MEME_EVENEMENT" | "SOMME_DE_POSTES";

export interface DoublonProbable {
  cle: string;
  motif: MotifDoublon;
  elements: ElementDoublon[];
  raison: string;
  ecart: number;
}

/** Des mots différents qui disent la même chose (le visa de publicité se paie par bordereau de versement à l'ANPP). */
const SYNONYMES: string[][] = [["visa", "anpp", "publicite", "publicitaire"]];

function motsElement(e: ElementDoublon): Set<string> {
  const m = new Set(motsSignificatifs(e.libelle, e.fournisseur));
  for (const g of SYNONYMES) if (g.some((x) => m.has(x))) m.add(`~${g[0]}`);
  return m;
}

const rond = (n: number) => Math.abs(n - Math.round(n / 100) * 100) < 0.005;

/**
 * LES DOUBLONS PROBABLES — rien n'est supprimé, rien n'est décidé : on les montre, avec l'outil qui tranche.
 *   1. même fournisseur et même montant (à 1 DZD) — deux écritures du même traiteur, 87 500 chacune ;
 *   2. montants à 2 DZD près, montant non rond — « MP Goodies RIO » 35 819 et EPRINT 35 817 ;
 *   3. même événement (un mot fort commun, ou un synonyme) et montants à 0,2 % près — la ligne « Bordereaux ANPP »
 *      240 000 et le poste visa de publicité 240 000 ;
 *   4. les postes d'une même demande dont la SOMME vaut, à 0,2 % près, un autre élément du même événement —
 *      501 000 + 10 000 face aux « Journées de Batna » 510 400.
 * `liens` : les paires DÉJÀ reconnues comme une même dépense (`a|b`, triées) — jamais signalées.
 */
export function doublonsProbables(elements: readonly ElementDoublon[], liens: ReadonlySet<string> = new Set()): DoublonProbable[] {
  const out: DoublonProbable[] = [];
  const paires: DoublonProbable[] = [];
  const vus = new Set<string>();
  const mots = new Map(elements.map((e) => [e.cle, motsElement(e)]));
  const paire = (a: string, b: string) => [a, b].sort().join("|");
  const communs = (a: Set<string>, b: Set<string>) => [...a].filter((m) => b.has(m));
  const montre = (m: string[]) => m.map((x) => (x.startsWith("~") ? x.slice(1) : x)).join(", ");
  const els = elements.filter((e) => e.montant >= 1000);
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.groupe && a.groupe === b.groupe) continue;
      const k = paire(a.cle, b.cle);
      if (liens.has(k) || vus.has(k)) continue;
      const ecart = Math.abs(a.montant - b.montant);
      const f = memeFournisseur(a.fournisseur, b.fournisseur);
      const mc = communs(mots.get(a.cle) as Set<string>, mots.get(b.cle) as Set<string>);
      let d: DoublonProbable | null = null;
      if (ecart <= 1.0000001 && f) {
        d = { cle: k, motif: "MEME_FOURNISSEUR", elements: [a, b], ecart, raison: `même fournisseur (${a.fournisseur}) et même montant ${dzd(a.montant)} DZD` };
      } else if (ecart <= 2.0000001 && !rond(a.montant) && !rond(b.montant)) {
        d = { cle: k, motif: "MONTANT_QUASI_EGAL", elements: [a, b], ecart, raison: `montants à ${dzd(ecart) || "0"} DZD près (${dzd(a.montant)} / ${dzd(b.montant)} DZD) — un montant non rond se répète rarement par hasard` };
      } else if (ecart <= Math.max(2, 0.002 * Math.max(a.montant, b.montant)) && mc.length > 0) {
        d = { cle: k, motif: "MEME_EVENEMENT", elements: [a, b], ecart, raison: `même objet (${montre(mc)}) et montants ${ecart < 0.005 ? `identiques (${dzd(a.montant)} DZD)` : `à ${dzd(ecart)} DZD près (${dzd(a.montant)} / ${dzd(b.montant)} DZD)`}` };
      }
      if (d) { vus.add(k); paires.push(d); }
    }
  }
  // Une même dépense répétée cinq fois fait UN doublon de cinq éléments, pas dix paires : les paires qui se touchent se
  // regroupent (composantes connexes), et la raison de la première paire dit le motif.
  const parent = new Map<string, string>();
  const racine = (x: string): string => { let r = x; while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string; parent.set(x, r); return r; };
  for (const d of paires) {
    const [a, b] = d.elements.map((e) => e.cle);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = racine(a), rb = racine(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const groupesPaires = new Map<string, DoublonProbable[]>();
  for (const d of paires) { const r = racine(d.elements[0].cle); groupesPaires.set(r, [...(groupesPaires.get(r) ?? []), d]); }
  for (const ps of groupesPaires.values()) {
    if (ps.length === 1) { out.push(ps[0]); continue; }
    const membres = new Map<string, ElementDoublon>();
    for (const d of ps) for (const e of d.elements) membres.set(e.cle, e);
    const montants = [...membres.values()].map((e) => e.montant);
    out.push({
      cle: [...membres.keys()].sort().join("|"), motif: ps[0].motif, elements: [...membres.values()],
      ecart: Math.max(...montants) - Math.min(...montants),
      raison: `${membres.size} éléments — ${ps[0].raison}`,
    });
  }
  // 4. La somme des postes d'une même demande face à un autre élément.
  const groupes = new Map<string, ElementDoublon[]>();
  for (const e of els) if (e.groupe && e.nature === "POSTE") groupes.set(e.groupe, [...(groupes.get(e.groupe) ?? []), e]);
  for (const [g, membres] of groupes) {
    if (membres.length < 2) continue;
    const somme = membres.reduce((s, m) => s + m.montant, 0);
    const motsG = new Set(membres.flatMap((m) => [...(mots.get(m.cle) as Set<string>)]));
    for (const e of els) {
      if (e.groupe === g) continue;
      const ecart = Math.abs(somme - e.montant);
      if (ecart > Math.max(2, 0.002 * somme)) continue;
      const mc = communs(motsG, mots.get(e.cle) as Set<string>);
      if (mc.length === 0) continue;
      const k = [...membres.map((m) => m.cle), e.cle].sort().join("|");
      if (vus.has(k) || membres.some((m) => liens.has(paire(m.cle, e.cle)))) continue;
      vus.add(k);
      out.push({
        cle: k, motif: "SOMME_DE_POSTES", elements: [...membres, e], ecart,
        raison: `${membres.length} postes (${membres.map((m) => dzd(m.montant)).join(" + ")} = ${dzd(somme)} DZD) face à ${dzd(e.montant)} DZD, même objet (${montre(mc)})${ecart >= 0.005 ? ` — écart ${dzd(ecart)} DZD` : ""}`,
      });
    }
  }
  return out.sort((x, y) => Math.max(...y.elements.map((e) => e.montant)) - Math.max(...x.elements.map((e) => e.montant)));
}

// ─────────────────────────────── Les décisions ───────────────────────────────

export type DecisionRapprochement = "ACCEPTEE" | "REFUSEE" | "PAS_ADPRO";
export type SensRapprochement = "DEPENSE" | "PIECE";

export const estSourceDepense = (s: string) => /^(TX|LIGNE|ORDRE):[A-Za-z0-9_-]+$/.test(s);
export const estSourcePiece = (s: string) => /^(DOC|DRIVE|MSG):[A-Za-z0-9_-]+$/.test(s);

/** Retirer d'une liste de propositions celles qu'une décision a déjà tranchées (refus d'une cible, source décidée). */
export function sansLesDecidees(
  props: readonly Proposition[],
  decisions: readonly { source: string; decision: DecisionRapprochement; demandeRowId: string | null; posteId: string | null }[],
  sens: SensRapprochement,
): Proposition[] {
  return props.filter((p) => !decisions.some((d) => {
    if (d.source !== p.source) return false;
    if (d.decision === "REFUSEE") return d.demandeRowId === p.demandeRowId && (sens === "PIECE" || (d.posteId ?? null) === (p.posteId ?? null) || !d.posteId);
    // Une dépense acceptée ou « pas Ad & Pro » n'a plus de proposition ; une pièce acceptée ne se repropose pas à LA MÊME demande.
    return sens === "DEPENSE" || d.demandeRowId === p.demandeRowId;
  }));
}
