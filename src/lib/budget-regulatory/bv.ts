/**
 * BUDGET REGULATORY — LES BONS DE VERSEMENT 25 % / 75 % DES DOSSIERS D'ENREGISTREMENT (Direction, 08/10).
 *
 * « Regulatory gère le budget de ses BV de 25 % et 75 %. » Dans le code, ce sont les deux bons de versement des FRAIS
 * D'ENREGISTREMENT d'un dossier ANPP (`RegulatoryProduct`, processus `lib/regulatory-workflow.ts`) :
 *   • BV 25 % — étapes 4-5 « Demande / Paiement du BV 25 % », en PRÉPARATION, avant la demande de présoumission ;
 *   • BV 75 % — étapes 9-12 « Demande / Paiement du BV 75 % », à la CONSTITUTION ADMINISTRATIVE, après l'étude des
 *     modules 3-4-5 et AVANT le dépôt du dossier (et non à la décision).
 * Chaque demande émet un ORDRE DE DÉPENSE (`requestBV` : source `REGULATORY_PRODUCT`, bénéficiaire ANPP, libellé
 * « BV 25 % — REF DCI ») ; son règlement par les Finances écrit la dépense. Ce ne sont PAS les « bons de versement » de
 * l'Information médicale (visas publicitaires / MIP), qui suivent leur propre circuit.
 *
 * Module PUR, sans aucun import : lu par les requêtes, par les actions et testé.
 */

export const CLE_BV_25 = "BV_25" as const;
export const CLE_BV_75 = "BV_75" as const;
export type NatureBv = "25" | "75";
export type CleBv = typeof CLE_BV_25 | typeof CLE_BV_75;

export const CLE_DE_LA_NATURE: Record<NatureBv, CleBv> = { "25": CLE_BV_25, "75": CLE_BV_75 };

/** Les catégories créées d'office pour une enveloppe « Frais d'enregistrement (BV) ». */
export const CATEGORIES_BV: readonly { nom: string; cle: CleBv; nature: NatureBv }[] = [
  { nom: "BV 25 % (préparation)", cle: CLE_BV_25, nature: "25" },
  { nom: "BV 75 % (avant dépôt)", cle: CLE_BV_75, nature: "75" },
];

/** Les étapes du processus qui portent chaque BV (`REG_STEPS`). */
export const ETAPES_BV: Record<NatureBv, { demande: string; paiement: string }> = {
  "25": { demande: "bv25_req", paiement: "bv25_pay" },
  "75": { demande: "bv75_req", paiement: "bv75_pay" },
};

/** La part de chaque BV dans les frais d'enregistrement — d'où la prévision du 75 % à partir du 25 %. */
export const PART_BV: Record<NatureBv, number> = { "25": 0.25, "75": 0.75 };

/**
 * LA NATURE D'UN ORDRE DE BV, lue sur son libellé (« BV 25 % — REG-2026-001 … »). Les libellés libres de l'assistant
 * (« BV », « BV1 ») ne disent pas leur part : `null`, et l'écran les range à part plutôt que de deviner.
 */
export function natureDuLibelle(label: string | null | undefined): NatureBv | null {
  if (!label) return null;
  const tete = label.split("—")[0] ?? label;
  if (/\b25\s*%/.test(tete)) return "25";
  if (/\b75\s*%/.test(tete)) return "75";
  return null;
}

/** Un ordre de dépense de BV, réduit à ce qui compte ici. */
export interface OrdreBv {
  id: string;
  productId: string;
  label: string;
  amount: number;
  /** PENDING | REVISION_REQUESTED | PAID | CANCELLED */
  status: string;
  paidDate: Date | null;
  createdAt: Date;
  /** La catégorie où l'ordre (non payé) est déjà rangé. */
  budgetCategoryId: string | null;
  /** Payé : la catégorie de l'écriture qu'il a produite. */
  transactionCategoryId: string | null;
}

/** Un BV saisi à la main dans l'enveloppe (ligne budgétaire liée au dossier). */
export interface SaisieBv { id: string; productId: string; categoryId: string; amount: number; date: Date }

export interface DossierBv {
  id: string;
  reference: string;
  dci: string;
  nom: string | null;
  /** RegulatoryStatus — pour savoir si le dossier est encore en cours. */
  status: string;
  /** L'état des étapes du processus (`workflow` JSON) : { [clé]: { status, date } }. */
  workflow: Record<string, { status?: string; date?: string } | undefined> | null;
}

export type StatutBv = "PAYE" | "DEMANDE" | "PAYE_SANS_MONTANT" | "A_VENIR";

export interface CelluleBv {
  statut: StatutBv;
  /** Réglé (ordres payés + saisies à la main). */
  paye: number;
  /** Demandé, pas encore réglé (ordres en attente). */
  demande: number;
  /** Payé le (ou demandé le) — ISO, `null` si inconnu. */
  date: string | null;
  /** Ce qui est compté dans CETTE enveloppe (payé et rangé ici, ou saisi ici). */
  dansEnveloppe: number;
  /** Les ordres de ce BV à ranger dans l'enveloppe (payés ou demandés, mais imputés ailleurs ou nulle part). */
  aImputer: { orderId: string; montant: number; paye: boolean }[];
}

export interface LigneBv {
  dossierId: string;
  reference: string;
  dci: string;
  nom: string | null;
  bv25: CelluleBv;
  bv75: CelluleBv;
  /** Les ordres de BV dont le libellé ne dit pas la part (« BV », « BV1 »). */
  autres: number;
  /** Le BV 75 % attendu, estimé : 3 × le BV 25 % quand celui-ci est connu et que le 75 % n'est pas encore demandé. */
  prevision75: number;
}

const STATUTS_EN_COURS = new Set(["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_BV_PAYMENT", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "BLOCKED"]);

function cellule(
  nature: NatureBv,
  ordres: readonly OrdreBv[],
  saisies: readonly SaisieBv[],
  dossier: DossierBv,
  categorieIci: string | null,
): CelluleBv {
  const payes = ordres.filter((o) => o.status === "PAID");
  const demandes = ordres.filter((o) => o.status === "PENDING" || o.status === "REVISION_REQUESTED");
  const montantPaye = payes.reduce((a, o) => a + o.amount, 0) + saisies.reduce((a, s) => a + s.amount, 0);
  const montantDemande = demandes.reduce((a, o) => a + o.amount, 0);
  const dansEnveloppe = payes.filter((o) => categorieIci !== null && o.transactionCategoryId === categorieIci).reduce((a, o) => a + o.amount, 0)
    + saisies.reduce((a, s) => a + s.amount, 0);
  const aImputer = categorieIci === null ? [] : [
    ...payes.filter((o) => o.transactionCategoryId !== categorieIci).map((o) => ({ orderId: o.id, montant: o.amount, paye: true })),
    ...demandes.filter((o) => o.budgetCategoryId !== categorieIci).map((o) => ({ orderId: o.id, montant: o.amount, paye: false })),
  ];
  const datePaye = [...payes.map((o) => o.paidDate).filter((d): d is Date => d !== null), ...saisies.map((s) => s.date)]
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const etape = dossier.workflow?.[ETAPES_BV[nature].paiement];

  const base = { paye: montantPaye, demande: montantDemande, dansEnveloppe, aImputer };
  if (montantPaye > 0) return { ...base, statut: "PAYE", date: datePaye ? datePaye.toISOString() : null };
  if (montantDemande > 0) {
    const demandeLe = demandes.map((o) => o.createdAt).sort((a, b) => b.getTime() - a.getTime())[0];
    return { ...base, statut: "DEMANDE", date: demandeLe ? demandeLe.toISOString() : null };
  }
  // Le processus dit « payé », mais aucun ordre ni aucune saisie ne porte le montant : on le DIT, on ne l'invente pas.
  if (etape?.status === "DONE") return { ...base, statut: "PAYE_SANS_MONTANT", date: etape.date ?? null };
  return { ...base, statut: "A_VENIR", date: null };
}

/**
 * LES BV, DOSSIER PAR DOSSIER. `categories` = les catégories BV de l'enveloppe affichée (par clé). Un dossier n'apparaît
 * que s'il a un BV (ordre, saisie, étape payée) ou s'il attend encore son BV 75 % alors que le 25 % est réglé.
 */
export function lignesBv(input: {
  dossiers: readonly DossierBv[];
  ordres: readonly OrdreBv[];
  saisies: readonly SaisieBv[];
  categories: { bv25: string | null; bv75: string | null };
}): LigneBv[] {
  const ordresPar = new Map<string, OrdreBv[]>();
  for (const o of input.ordres) {
    if (o.status === "CANCELLED") continue;
    ordresPar.set(o.productId, [...(ordresPar.get(o.productId) ?? []), o]);
  }
  const saisiesPar = new Map<string, SaisieBv[]>();
  for (const s of input.saisies) saisiesPar.set(s.productId, [...(saisiesPar.get(s.productId) ?? []), s]);

  const lignes: LigneBv[] = [];
  for (const d of input.dossiers) {
    const ordres = ordresPar.get(d.id) ?? [];
    const saisies = saisiesPar.get(d.id) ?? [];
    const de = (n: NatureBv) => ordres.filter((o) => natureDuLibelle(o.label) === n);
    const saisiesDe = (cat: string | null) => (cat ? saisies.filter((s) => s.categoryId === cat) : []);
    const bv25 = cellule("25", de("25"), saisiesDe(input.categories.bv25), d, input.categories.bv25);
    const bv75 = cellule("75", de("75"), saisiesDe(input.categories.bv75), d, input.categories.bv75);
    const autres = ordres.filter((o) => natureDuLibelle(o.label) === null && o.status !== "CANCELLED").reduce((a, o) => a + o.amount, 0);
    const prevision75 = prevoirBv75(bv25, bv75, d.status);
    const actif = bv25.statut !== "A_VENIR" || bv75.statut !== "A_VENIR" || autres > 0;
    if (!actif) continue;
    lignes.push({ dossierId: d.id, reference: d.reference, dci: d.dci, nom: d.nom, bv25, bv75, autres, prevision75 });
  }
  return lignes.sort((a, b) => a.reference.localeCompare(b.reference, "fr"));
}

/**
 * LE BV 75 % À VENIR. Les frais d'enregistrement se règlent en deux temps (25 % puis 75 %) : le 25 % connu donne le
 * 75 % attendu (×3). Rien n'est prévu pour un dossier clos, ni quand le 75 % est déjà demandé ou payé.
 */
export function prevoirBv75(bv25: Pick<CelluleBv, "paye" | "demande">, bv75: Pick<CelluleBv, "statut">, statutDossier: string): number {
  if (bv75.statut !== "A_VENIR") return 0;
  if (!STATUTS_EN_COURS.has(statutDossier)) return 0;
  const connu = bv25.paye + bv25.demande;
  if (connu <= 0) return 0;
  return Math.round((connu * PART_BV["75"]) / PART_BV["25"]);
}

export interface TotauxBv { paye25: number; paye75: number; demande: number; prevision75: number; dansEnveloppe: number; aImputer: number }

export function totauxBv(lignes: readonly LigneBv[]): TotauxBv {
  const t: TotauxBv = { paye25: 0, paye75: 0, demande: 0, prevision75: 0, dansEnveloppe: 0, aImputer: 0 };
  for (const l of lignes) {
    for (const [c, k] of [[l.bv25, "paye25"], [l.bv75, "paye75"]] as const) {
      t[k] += c.paye;
      t.demande += c.demande;
      t.dansEnveloppe += c.dansEnveloppe;
      t.aImputer += c.aImputer.length;
    }
    t.prevision75 += l.prevision75;
  }
  return t;
}
