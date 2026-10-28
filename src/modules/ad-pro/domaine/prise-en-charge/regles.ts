import type {
  CareBeneficiaryStatus, CareCellKind, CareCellStatus, CareOpinion, CareQuoteStatus, CareServiceKind,
} from "@prisma/client";

/**
 * PRISE EN CHARGE — la logique métier, en fonctions PURES.
 *
 * Le module ne traite pas d'un congrès : il traite de **personnes** qu'on emmène à un
 * événement. Chacune est examinée séparément — on peut en accorder une et en écarter une
 * autre — et chacune a ses propres besoins : l'une a besoin d'un visa et pas l'autre, l'une
 * loge à l'hôtel et l'autre chez elle.
 *
 * D'où le tableau : **une ligne par personne**, et sur cette ligne des **cases** de deux
 * natures, qui ne se traitent pas pareil :
 *   • une **pièce à fournir** — on la collecte (passeport, visa, CV) ;
 *   • un **élément à acheter** — on demande un devis, il est accepté ou refusé, puis il devient
 *     une dépense (hôtel, transport, billet, restauration, inscription).
 *
 * Fichier importé par des composants client : aucune lecture de fichier ni de base.
 */

// ───────────────────────────── Libellés ─────────────────────────────

export const OPINION_LABELS: Record<CareOpinion, string> = {
  FAVORABLE: "Favorable",
  UNFAVORABLE: "Défavorable",
  NONE: "Pas d'avis",
};

export const BENEFICIARY_STATUS_LABELS: Record<CareBeneficiaryStatus, string> = {
  PROPOSED: "Proposée",
  APPROVED: "Accordée",
  REJECTED: "Écartée",
  WITHDRAWN: "Retirée",
};

export const SERVICE_KIND_LABELS: Record<CareServiceKind, string> = {
  HOTEL: "Hôtellerie",
  TRANSPORT: "Transport",
  TICKET: "Billet",
  CATERING: "Restauration",
  REGISTRATION: "Inscription",
  VISA_FEE: "Frais de visa",
  PROMO_MATERIAL: "Matériel promotionnel",
  OTHER: "Autre",
};

/** Ordre d'affichage : l'ordre dans lequel on s'en occupe réellement. */
export const SERVICE_KINDS: CareServiceKind[] = [
  "TICKET", "HOTEL", "TRANSPORT", "REGISTRATION", "CATERING", "VISA_FEE", "PROMO_MATERIAL", "OTHER",
];

export const CELL_STATUS_LABELS: Record<CareCellStatus, string> = {
  REQUESTED: "Demandé",
  PROVIDED: "Reçu",
  SETTLED: "Validé",
  WAIVED: "Sans objet",
};

export const QUOTE_STATUS_LABELS: Record<CareQuoteStatus, string> = {
  PENDING: "En attente",
  ACCEPTED: "Accepté",
  REJECTED: "Refusé",
};

// ───────────────────────────── Identité ─────────────────────────────

export interface BeneficiaryIdentity {
  doctorId?: string | null;
  /** Nom lisible du médecin quand il vient de l'annuaire. */
  doctorName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  institution?: string | null;
}

/**
 * Le nom à afficher. Une personne vient soit de l'annuaire, soit d'un profil libre saisi sur
 * place — on ne crée pas une fiche médecin permanente pour un intervenant vu une seule fois.
 * Ne rend jamais une chaîne vide : un bénéficiaire sans nom affichable serait introuvable.
 */
export function beneficiaryName(b: BeneficiaryIdentity): string {
  if (b.doctorId && b.doctorName?.trim()) return b.doctorName.trim();
  const full = [b.firstName?.trim(), b.lastName?.trim()].filter(Boolean).join(" ").trim();
  return full || "Personne sans nom";
}

/** Ligne secondaire : poste et établissement, ce qui situe la personne. */
export function beneficiarySubtitle(b: BeneficiaryIdentity): string {
  return [b.jobTitle?.trim(), b.institution?.trim()].filter(Boolean).join(" · ");
}

// ───────────────────────────── Cases par défaut ─────────────────────────────

export interface DefaultCell {
  kind: CareCellKind;
  serviceKind: CareServiceKind | null;
  label: string;
}

/**
 * LES PIÈCES ATTENDUES DE CHAQUE PROFESSIONNEL PROPOSÉ — décision de la Direction (04/10/2026).
 *
 * National : le passeport. International : le passeport, le visa et les informations de voyage.
 * Une seule liste, lue par la demande des pièces, par leur suivi à l'écran et par l'accord d'une
 * personne : trois copies finiraient par demander une chose et en suivre une autre (§118.5).
 *
 * `reconnait` dit quelle case existante TIENT cette pièce — une case d'avant cette liste
 * (« Copie du passeport ») vaut le passeport : la redemander ferait deux cases pour le même papier.
 */
export interface PieceAttendue {
  cle: "PASSEPORT" | "VISA" | "VOYAGE";
  label: string;
  reconnait: RegExp;
}

const PASSEPORT: PieceAttendue = { cle: "PASSEPORT", label: "Passeport", reconnait: /passeport/i };
const VISA: PieceAttendue = { cle: "VISA", label: "Visa", reconnait: /\bvisa\b/i };
const VOYAGE: PieceAttendue = { cle: "VOYAGE", label: "Informations de voyage", reconnait: /voyage|itin[ée]raire|\bvols?\b/i };

export function piecesAttendues(scope: "NATIONAL" | "INTERNATIONAL"): PieceAttendue[] {
  return scope === "INTERNATIONAL" ? [PASSEPORT, VISA, VOYAGE] : [PASSEPORT];
}

/**
 * Ce qu'on demande D'OFFICE à une personne dès qu'elle est accordée : ses pièces attendues.
 * Le reste (hôtel, billet) s'ajoute au cas par cas — pré-remplir dix cases qu'il faudra effacer
 * coûte plus cher que d'ajouter les deux qui servent.
 */
export function defaultCells(scope: "NATIONAL" | "INTERNATIONAL"): DefaultCell[] {
  return piecesAttendues(scope).map((p) => ({ kind: "DOCUMENT" as const, serviceKind: null, label: p.label }));
}

/** L'état d'UNE pièce pour UN professionnel, dans les mots de la demande : demandée, reçue, manquante. */
export type EtatPiece = "MANQUANTE" | "DEMANDEE" | "RECUE" | "SANS_OBJET";

export const ETAT_PIECE_LABELS: Record<EtatPiece, string> = {
  MANQUANTE: "Manquante — pas encore demandée",
  DEMANDEE: "Demandée",
  RECUE: "Reçue",
  SANS_OBJET: "Sans objet",
};

export function etatDeCase(status: CareCellStatus): EtatPiece {
  if (status === "PROVIDED" || status === "SETTLED") return "RECUE";
  if (status === "WAIVED") return "SANS_OBJET";
  return "DEMANDEE";
}

export interface LignePiece {
  label: string;
  etat: EtatPiece;
  /** La case qui porte la pièce — absente tant que la pièce n'a pas été demandée. */
  cellId: string | null;
  documentId: string | null;
}

/**
 * Les pièces d'UN professionnel : chaque pièce attendue (reconnue sur une case existante, ou
 * « manquante »), puis les autres pièces qu'on lui a demandées à la main — rien n'est caché.
 * Seules les cases PIÈCE comptent : « Frais de visa » est un achat, pas le visa.
 */
export function piecesDuProfessionnel(
  scope: "NATIONAL" | "INTERNATIONAL",
  cells: { id: string; kind: CareCellKind; label: string; status: CareCellStatus; documentId?: string | null }[],
): LignePiece[] {
  const docs = cells.filter((c) => c.kind === "DOCUMENT");
  const prises = new Set<string>();
  const lignes: LignePiece[] = piecesAttendues(scope).map((p) => {
    const c = docs.find((d) => !prises.has(d.id) && p.reconnait.test(d.label));
    if (!c) return { label: p.label, etat: "MANQUANTE" as const, cellId: null, documentId: null };
    prises.add(c.id);
    return { label: p.label, etat: etatDeCase(c.status), cellId: c.id, documentId: c.documentId ?? null };
  });
  for (const d of docs) {
    if (!prises.has(d.id)) lignes.push({ label: d.label, etat: etatDeCase(d.status), cellId: d.id, documentId: d.documentId ?? null });
  }
  return lignes;
}

/** Les pièces attendues qui n'ont encore AUCUNE case : ce que « Demander les pièces » va créer. */
export function piecesADemander(
  scope: "NATIONAL" | "INTERNATIONAL",
  cells: { kind: CareCellKind; label: string }[],
): PieceAttendue[] {
  const docs = cells.filter((c) => c.kind === "DOCUMENT");
  const prises = new Set<number>();
  return piecesAttendues(scope).filter((p) => {
    const i = docs.findIndex((d, k) => !prises.has(k) && p.reconnait.test(d.label));
    if (i < 0) return true;
    prises.add(i);
    return false;
  });
}

// ───────────────────────────── Avancement ─────────────────────────────

export interface CellLike {
  kind: CareCellKind;
  status: CareCellStatus;
  label: string;
  amountDzd?: number | null;
}

export interface CareProgress {
  /** Cases qui comptent : celles écartées (« sans objet ») ne pèsent pas. */
  total: number;
  settled: number;
  /** Ce qui manque encore, nommé — pour qu'on sache quoi relancer. */
  missing: string[];
  /** Toutes les cases utiles sont réglées. */
  complete: boolean;
  /** Somme des montants des cases chiffrées. */
  costDzd: number;
}

/**
 * Où en est UNE personne.
 *
 * Une case « sans objet » est exclue du décompte : marquer une case inutile plutôt que de la
 * supprimer garde la trace de la décision (« on a bien regardé le visa, il n'en faut pas »)
 * sans faire croire à un dossier incomplet.
 *
 * Fonction PURE — testée.
 */
export function careProgress(cells: CellLike[]): CareProgress {
  const useful = cells.filter((c) => c.status !== "WAIVED");
  const settled = useful.filter((c) => c.status === "SETTLED");
  const costDzd = Math.round(
    cells.reduce((a, c) => a + (typeof c.amountDzd === "number" && Number.isFinite(c.amountDzd) ? c.amountDzd : 0), 0) * 100,
  ) / 100;
  return {
    total: useful.length,
    settled: settled.length,
    missing: useful.filter((c) => c.status !== "SETTLED").map((c) => c.label),
    // Une personne sans aucune case n'est pas « complète » : son dossier n'a pas commencé.
    complete: useful.length > 0 && settled.length === useful.length,
    costDzd,
  };
}

// ───────────────────────────── Devis ─────────────────────────────

export interface QuoteLike {
  id: string;
  status: CareQuoteStatus;
  amountDzd: number;
  cellIds: string[];
}

export interface QuoteConflict {
  cellId: string;
  /** Le devis DÉJÀ accepté qui couvre cette case. */
  acceptedQuoteId: string;
}

/**
 * Peut-on accepter ce devis ?
 *
 * Le seul refus qui compte : **une case déjà couverte par un devis accepté**. Accepter deux
 * devis sur le même hôtel pour la même personne, c'est payer deux fois — et personne ne s'en
 * apercevrait avant la facture. Le reste (montant, fournisseur) relève du jugement, pas du code.
 *
 * Fonction PURE — testée.
 */
export function quoteConflicts(quote: QuoteLike, others: QuoteLike[]): QuoteConflict[] {
  const covered = new Map<string, string>();
  for (const q of others) {
    if (q.id === quote.id || q.status !== "ACCEPTED") continue;
    for (const cellId of q.cellIds) covered.set(cellId, q.id);
  }
  return quote.cellIds
    .filter((cellId) => covered.has(cellId))
    .map((cellId) => ({ cellId, acceptedQuoteId: covered.get(cellId) as string }));
}

export interface QuoteSummary {
  pending: number;
  accepted: number;
  rejected: number;
  /** Ce que les devis ACCEPTÉS engagent réellement. */
  acceptedDzd: number;
  /** Ce qui est encore en attente de décision. */
  pendingDzd: number;
}

/** L'état des devis d'une demande, tel qu'affiché avant l'envoi aux Finances. */
export function quoteSummary(quotes: QuoteLike[]): QuoteSummary {
  const by = (s: CareQuoteStatus) => quotes.filter((q) => q.status === s);
  const sum = (qs: QuoteLike[]) => Math.round(qs.reduce((a, q) => a + (Number.isFinite(q.amountDzd) ? q.amountDzd : 0), 0) * 100) / 100;
  return {
    pending: by("PENDING").length,
    accepted: by("ACCEPTED").length,
    rejected: by("REJECTED").length,
    acceptedDzd: sum(by("ACCEPTED")),
    pendingDzd: sum(by("PENDING")),
  };
}

// ───────────────────────────── Passage aux Finances ─────────────────────────────

export interface FinanceReadiness {
  ready: boolean;
  /** Ce qui bloque, en clair. Vide si tout est prêt. */
  blockers: string[];
}

/**
 * La demande peut-elle partir aux Finances ?
 *
 * Trois conditions, et chacune correspond à une erreur réelle qu'on veut empêcher :
 *   • **au moins une personne accordée** — sinon on ferait payer une demande vide ;
 *   • **aucun devis en attente** — envoyer aux Finances pendant que le secrétariat négocie
 *     encore produit un montant faux ;
 *   • **aucune case d'une personne accordée laissée en suspens** — c'est la pièce ou la
 *     prestation qui manquera le jour de l'événement.
 *
 * Fonction PURE — testée.
 */
export function financeReadiness(
  beneficiaries: { status: CareBeneficiaryStatus; name: string; progress: CareProgress }[],
  quotes: QuoteLike[],
): FinanceReadiness {
  const blockers: string[] = [];

  const approved = beneficiaries.filter((b) => b.status === "APPROVED");
  if (approved.length === 0) blockers.push("Aucune personne n'a été accordée par la Direction.");

  const pending = quotes.filter((q) => q.status === "PENDING").length;
  if (pending > 0) blockers.push(`${pending} devis attend${pending > 1 ? "ent" : ""} encore une décision.`);

  for (const b of approved) {
    if (!b.progress.complete) {
      const what = b.progress.total === 0 ? "aucun élément demandé" : b.progress.missing.join(", ");
      blockers.push(`${b.name} — en attente : ${what}.`);
    }
  }

  return { ready: blockers.length === 0, blockers };
}
