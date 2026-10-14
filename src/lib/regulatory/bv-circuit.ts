import { natureDuLibelle, ETAPES_BV, type NatureBv } from "@/lib/budget-regulatory/bv";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT D'UN BV DE DOSSIER, LU SUR SON ORDRE DE DÉPENSE (Direction, 10/2026).
 *
 * « Demande du BV 25 % » (ou 75 %) se clique depuis l'étape du processus → l'ordre part au CENTRE DE
 * PAIEMENT, qui voit de quel produit il vient → autorisé, il va aux FINANCES → payé, les Finances
 * déposent la quittance et l'étape « Paiement du BV » se coche. Le centre peut aussi le REFUSER
 * (« Non prioritaire », ou un autre motif) : l'étape le dit, et l'on peut redemander.
 *
 * L'état n'est JAMAIS saisi à part : il se lit sur l'ordre (statut + décision du centre). Une seconde
 * écriture du même fait divergerait (§118.5).
 *
 * Module PUR — seuls des modules purs sont importés : la fiche (client) et les actions le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatBv = "DEMANDE" | "AUTORISE" | "PAYE" | "REFUSE";

export const ETAT_BV: Record<EtatBv, { label: string; detail: string; tone: "warning" | "info" | "success" | "danger" }> = {
  DEMANDE: { label: "Demandé", detail: "au centre de paiement", tone: "warning" },
  AUTORISE: { label: "Autorisé", detail: "chez les Finances", tone: "info" },
  PAYE: { label: "Payé", detail: "quittance déposée par les Finances", tone: "success" },
  REFUSE: { label: "Refusé", detail: "par le centre de paiement", tone: "danger" },
};

/** Le strict nécessaire d'un ordre pour en lire l'état. */
export interface OrdrePourEtatBv {
  status: string;
  centralStatus: string;
}

/** L'état d'un ordre de BV — `null` pour un ordre annulé (il ne dit plus rien du dossier). */
export function etatDeLOrdreBv(o: OrdrePourEtatBv): EtatBv | null {
  if (o.status === "CANCELLED") return null;
  if (o.status === "PAID") return "PAYE";
  if (o.centralStatus === "REFUSED") return "REFUSE";
  // `NOT_REQUIRED` : ordres d'avant le centre, payables tels quels — donc chez les Finances.
  if (o.centralStatus === "APPROVED" || o.centralStatus === "NOT_REQUIRED") return "AUTORISE";
  return "DEMANDE";
}

/**
 * UN ORDRE QUI EMPÊCHE DE REDEMANDER : tout ordre vivant — en attente, autorisé, payé. Seuls un refus
 * du centre et une annulation rendent la main : redemander un BV refusé est précisément le geste prévu.
 */
export function bloqueUneNouvelleDemande(o: OrdrePourEtatBv): boolean {
  return etatDeLOrdreBv(o) !== null && etatDeLOrdreBv(o) !== "REFUSE";
}

/** La nature (25 / 75) que porte une étape de demande ou de paiement du processus — `null` sinon. */
export function natureDeLEtape(stepKey: string | null | undefined): NatureBv | null {
  if (!stepKey) return null;
  for (const n of ["25", "75"] as const) {
    if (ETAPES_BV[n].demande === stepKey || ETAPES_BV[n].paiement === stepKey) return n;
  }
  return null;
}

/** Le libellé de la nature, tel que l'ordre le porte (« BV 25 % ») — la nature se relit dessus. */
export const LIBELLE_NATURE_BV: Record<NatureBv, string> = { "25": "BV 25 %", "75": "BV 75 %" };

/** Un ordre de dépense est-il le BV d'un dossier ? Et de quelle part ? */
export function natureDeLOrdreBv(o: { sourceType: string | null; label: string }): NatureBv | null {
  return o.sourceType === "REGULATORY_PRODUCT" ? natureDuLibelle(o.label) : null;
}

/**
 * L'ORDRE QUI DIT L'ÉTAT DE L'ÉTAPE — le plus récent ordre vivant de cette nature ; à défaut, le plus
 * récent refus (l'étape dit « refusé — motif » et propose de redemander) ; à défaut, rien.
 */
export function ordreQuiDitLEtat<T extends OrdrePourEtatBv & { label: string; createdAt: string | Date }>(
  ordres: readonly T[],
  nature: NatureBv,
): { ordre: T; etat: EtatBv } | null {
  const temps = (d: string | Date) => new Date(d).getTime();
  const miens = ordres
    .filter((o) => natureDuLibelle(o.label) === nature)
    .sort((a, b) => temps(b.createdAt) - temps(a.createdAt));
  const vivant = miens.find(bloqueUneNouvelleDemande);
  if (vivant) return { ordre: vivant, etat: etatDeLOrdreBv(vivant)! };
  const refuse = miens.find((o) => etatDeLOrdreBv(o) === "REFUSE");
  return refuse ? { ordre: refuse, etat: "REFUSE" } : null;
}

/** Ce que l'étape « Demande du BV » affiche de son ordre (sérialisable, préparé par la fiche). */
export interface SuiviBvVue {
  etat: EtatBv;
  orderId: string;
  reference: string;
  montant: number;
  demandeLe: string;
  decideLe: string | null;
  payeLe: string | null;
  /** Le motif du refus, tel que le centre l'a écrit. */
  motifRefus: string | null;
  /** La quittance déposée par les Finances au règlement (lien de téléchargement). */
  quittance: { id: string; name: string } | null;
}
