import { CLE_DE_LA_NATURE, type NatureBv } from "./bv";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BV ACCEPTÉS AU CENTRE DE VALIDATIONS, DANS LE BUDGET REGULATORY (Super Admin, 24/11/2026) — règles PURES.
 *
 * Ces BV ne passent plus par un ordre de dépense : ni centre de paiement, ni Finances, ni écriture de trésorerie. Ils
 * consomment pourtant le budget Regulatory — c'est l'exception voulue. Rien n'est écrit pour autant : l'engagé et le
 * consommé se DÉDUISENT (§118.5), comme partout ailleurs dans le budget.
 *
 *   • ENGAGÉ   = le montant d'une demande ACCEPTÉE dont l'étape « Paiement du BV » n'est pas « fait » ;
 *   • CONSOMMÉ = le montant d'une demande ACCEPTÉE dont le paiement est « fait » — le même montant passe d'une colonne
 *                à l'autre, il ne s'ajoute pas ; remis à « à faire », il redevient engagé.
 *
 * LA LIGNE : la catégorie BV 25 % ou BV 75 % de l'enveloppe Regulatory qui couvre la date d'ACCEPTATION (l'active
 * d'abord, puis la plus récente) — la règle même qui rangeait un ordre de BV à sa demande (`categorieBvPourOrdre`),
 * appliquée à l'instant où l'argent est engagé. Elle se lit au moment du calcul plutôt que d'être figée : la date
 * d'acceptation, elle, ne bouge pas, et les enveloppes Regulatory se suivent par période sans se chevaucher ; une
 * colonne figée aurait été une seconde vérité (et une migration) pour le seul cas d'une enveloppe recréée après coup.
 * Aucune enveloppe ne couvre la date → le BV n'est compté nulle part, et la fiche le DIT.
 *
 * Module PUR, sans valeur importée hors du dossier : lu par les requêtes du budget et par la fiche, et testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une catégorie BV (1er niveau) d'une enveloppe Regulatory, avec ce qu'il faut pour choisir. */
export interface CategorieBvCandidate {
  id: string;
  nom: string;
  cle: string | null;
  enveloppe: { id: string; nom: string; companyId: string | null; isActive: boolean; periodStart: Date; periodEnd: Date };
}

/**
 * La catégorie où compte un BV de cette part, accepté à cette date — `null` si aucune enveloppe ne la couvre. Une
 * enveloppe d'une AUTRE entité que celle du dossier n'est jamais retenue (une enveloppe sans entité couvre tout).
 */
export function categorieDuBvAccepte(
  nature: NatureBv, date: Date, candidates: readonly CategorieBvCandidate[], societeDuDossier: string | null = null,
): CategorieBvCandidate | null {
  const t = date.getTime();
  const couvrent = candidates.filter((c) => c.cle === CLE_DE_LA_NATURE[nature]
    && (!societeDuDossier || !c.enveloppe.companyId || c.enveloppe.companyId === societeDuDossier)
    && c.enveloppe.periodStart.getTime() <= t && t <= c.enveloppe.periodEnd.getTime());
  couvrent.sort((a, b) => Number(b.enveloppe.isActive) - Number(a.enveloppe.isActive)
    || b.enveloppe.periodStart.getTime() - a.enveloppe.periodStart.getTime());
  return couvrent[0] ?? null;
}

/** La date du paiement d'un BV : celle de l'étape « fait » (AAAA-MM-JJ), à défaut le jour de l'acceptation. */
export function dateDuPaiement(etape: { date?: string | null } | null | undefined, accepteLe: Date): Date {
  const d = etape?.date ? new Date(`${etape.date.slice(0, 10)}T00:00:00Z`) : null;
  return d && Number.isFinite(d.getTime()) ? d : accepteLe;
}

/** Un BV accepté, réduit à ce que le budget en lit. */
export interface BvAccepte {
  validationId: string;
  productId: string;
  /** L'entité du dossier (`RegulatoryProduct.companyId`). */
  companyId: string | null;
  nature: NatureBv;
  montant: number;
  accepteLe: Date;
  /** L'étape « Paiement du BV » est-elle « fait » ? */
  paiementFait: boolean;
  /** Date du paiement (étape « fait ») — `null` tant qu'il n'est pas fait. */
  payeLe: Date | null;
  /** La catégorie retenue (`categorieDuBvAccepte`). */
  categoryId: string | null;
}

export interface ImputationBvAcceptes {
  consumed: Map<string, number>;
  committed: Map<string, number>;
  /** Les consommations datées (courbe mensuelle). */
  rows: { categoryId: string; date: Date; amount: number }[];
}

/**
 * CE QUE LES BV ACCEPTÉS PÈSENT SUR CES CATÉGORIES. Le consommé est borné à la période (date du paiement) quand elle
 * est donnée — comme les écritures réglées ; l'engagé ne l'est que par sa fin (accepté après elle, il n'y est pas
 * encore), comme les ordres émis.
 */
export function imputationDesBvAcceptes(
  bvs: readonly BvAccepte[], catIds: ReadonlySet<string>, from?: Date | null, to?: Date | null,
): ImputationBvAcceptes {
  const out: ImputationBvAcceptes = { consumed: new Map(), committed: new Map(), rows: [] };
  const ajoute = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const b of bvs) {
    if (!b.categoryId || !catIds.has(b.categoryId) || !(b.montant > 0)) continue;
    if (b.paiementFait) {
      const d = b.payeLe ?? b.accepteLe;
      if ((from && d < from) || (to && d > to)) continue;
      ajoute(out.consumed, b.categoryId, b.montant);
      out.rows.push({ categoryId: b.categoryId, date: d, amount: b.montant });
    } else {
      if (to && b.accepteLe > to) continue;
      ajoute(out.committed, b.categoryId, b.montant);
    }
  }
  return out;
}

// ─────────────────────────────── L'encadré « Budget » de la fiche dossier ───────────────────────────────

/** Un BV du dossier tel que l'encadré le lit — quel que soit son circuit. */
export interface BvDuDossier {
  nature: NatureBv;
  /** VALIDATION = centre de validations (nouveau circuit) ; ORDRE = ordre de dépense (ancien circuit). */
  circuit: "VALIDATION" | "ORDRE";
  /** Le montant demandé (la demande vivante, ou le dernier refus). */
  demande: number;
  engage: number;
  consomme: number;
  /** « Enveloppe › catégorie » où le BV compte — `null` si nulle part. */
  enveloppe: string | null;
}

export interface LigneEncadreBv {
  nature: NatureBv;
  demande: number | null;
  engage: number;
  consomme: number;
  enveloppe: string | null;
  circuit: "VALIDATION" | "ORDRE" | null;
  /** BV 75 % seulement : 3 × le BV 25 % connu, tant que le 75 % n'est ni engagé ni consommé (prévision conservée). */
  prevision: number;
}

/**
 * L'ENCADRÉ BUDGET D'UN DOSSIER : pour chaque BV, ce qui est demandé, engagé, consommé, et où. La prévision du 75 %
 * (3 × le 25 %) reprend la règle de la page Budget Regulatory (`prevoirBv75`) : elle s'efface dès que le 75 % réel est
 * engagé ou consommé — jamais les deux à la fois.
 */
export function encadreBudgetBv(bvs: readonly BvDuDossier[], dossierEnCours: boolean): LigneEncadreBv[] {
  const ligne = (nature: NatureBv): LigneEncadreBv => {
    const b = bvs.find((x) => x.nature === nature) ?? null;
    return {
      nature, demande: b ? b.demande : null, engage: b?.engage ?? 0, consomme: b?.consomme ?? 0,
      enveloppe: b?.enveloppe ?? null, circuit: b?.circuit ?? null, prevision: 0,
    };
  };
  const l25 = ligne("25");
  const l75 = ligne("75");
  const connu25 = l25.engage + l25.consomme;
  if (dossierEnCours && connu25 > 0 && l75.engage + l75.consomme === 0) l75.prevision = connu25 * 3;
  return [l25, l75];
}
