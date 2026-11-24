import { natureDuLibelle, type NatureBv } from "@/lib/budget-regulatory/bv";
import { etatDeLOrdreBv, type OrdrePourEtatBv } from "@/lib/regulatory/bv-circuit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BV D'UN DOSSIER PAR LE CENTRE DE VALIDATIONS (Super Admin, 24/11/2026) — les règles PURES.
 *
 * « Demande du BV 25 % » (ou 75 %) : le pharmacien saisit un MONTANT et demande l'autorisation. La demande part au
 * CENTRE DE VALIDATIONS (une `ValidationRequest` de nature `REGULATORY_BV_25` / `_75`, liée au dossier) ; toute
 * personne qui a accès au centre peut accepter ou refuser, une seule décision suffit. Plus d'ordre de dépense, plus de
 * centre de paiement ni de Finances : c'est une EXCEPTION assumée — le BV consomme pourtant le budget Regulatory.
 *
 * L'ÉTAT N'EST ÉCRIT NULLE PART À PART : il se LIT sur les demandes de validation du dossier (§118.5), comme l'ancien
 * circuit le lisait sur ses ordres (`bv-circuit.ts`). Les deux circuits cohabitent : un ordre déjà émis finit son
 * parcours (centre de paiement → Finances), seules les nouvelles demandes passent par le centre de validations.
 *
 * Module PUR (seuls des modules purs sont importés) : la fiche (client), les actions, le budget et les tests le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature (`ValidationRequest.objectType`) d'une demande de BV — une par part, pour la lire sans deviner. */
export const OBJET_BV_REGULATORY: Record<NatureBv, string> = { "25": "REGULATORY_BV_25", "75": "REGULATORY_BV_75" };
export const OBJETS_BV_REGULATORY: readonly string[] = Object.values(OBJET_BV_REGULATORY);

/** La part (25 / 75) d'une demande de validation de BV — `null` pour toute autre demande. */
export function natureDeLObjetBv(objectType: string | null | undefined): NatureBv | null {
  if (objectType === OBJET_BV_REGULATORY["25"]) return "25";
  if (objectType === OBJET_BV_REGULATORY["75"]) return "75";
  return null;
}

export const estObjetBv = (objectType: string | null | undefined): boolean => natureDeLObjetBv(objectType) !== null;

/** Ce que dit une demande au centre de validations. */
export type EtatDemandeBv = "EN_ATTENTE" | "ACCEPTE" | "REFUSE";

/**
 * L'état d'une demande, lu sur le statut de sa validation. Un renvoi « à corriger » se lit comme un refus : il n'y a
 * rien à corriger sur place, le pharmacien redemande (et la redemande clôt la précédente). Une demande retirée
 * (`CANCELLED`) ne dit plus rien du dossier.
 */
export function etatDeLaDemandeBv(status: string): EtatDemandeBv | null {
  if (status === "PENDING") return "EN_ATTENTE";
  if (status === "APPROVED") return "ACCEPTE";
  if (status === "REJECTED" || status === "CHANGES_REQUESTED") return "REFUSE";
  return null;
}

/** Une demande en attente ou acceptée empêche d'en faire une autre : redemander n'est prévu qu'après un refus. */
export function demandeBvBloquante(d: { status: string }): boolean {
  const e = etatDeLaDemandeBv(d.status);
  return e === "EN_ATTENTE" || e === "ACCEPTE";
}

/**
 * LA DEMANDE QUI DIT L'ÉTAT DE L'ÉTAPE — la plus récente vivante (en attente, acceptée) ; à défaut le plus récent
 * refus (l'étape dit « Refusé — motif » et propose de redemander) ; à défaut, rien. `demandes` : celles d'UNE nature.
 */
export function demandeQuiDitLEtat<T extends { status: string; createdAt: string | Date }>(
  demandes: readonly T[],
): { demande: T; etat: EtatDemandeBv } | null {
  const tri = [...demandes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const vivante = tri.find(demandeBvBloquante);
  if (vivante) return { demande: vivante, etat: etatDeLaDemandeBv(vivante.status)! };
  const refusee = tri.find((d) => etatDeLaDemandeBv(d.status) === "REFUSE");
  return refusee ? { demande: refusee, etat: "REFUSE" } : null;
}

/**
 * LE PAIEMENT DU BV EST-IL DÉVERROUILLÉ ? — oui quand la demande est ACCEPTÉE au centre de validations, ou, pour un BV
 * de l'ancien circuit, quand son ordre a été AUTORISÉ par le centre de paiement (ou déjà payé) : c'était son
 * acceptation. Tant que ce n'est pas le cas, l'étape « Paiement du BV » ne bouge pas (écran ET serveur).
 */
export function paiementBvDeverrouille(
  nature: NatureBv,
  d: { demandes: readonly { objectType: string | null; status: string }[]; ordres: readonly (OrdrePourEtatBv & { label: string })[] },
): boolean {
  if (d.demandes.some((v) => natureDeLObjetBv(v.objectType) === nature && v.status === "APPROVED")) return true;
  return d.ordres.some((o) => {
    if (natureDuLibelle(o.label) !== nature) return false;
    const e = etatDeLOrdreBv(o);
    return e === "AUTORISE" || e === "PAYE";
  });
}

/** Le refus du serveur, dit avec son remède. */
export function refusPaiementVerrouille(nature: NatureBv): string {
  return `Le paiement du BV ${nature} % est verrouillé tant que sa demande n'est pas acceptée au Centre de validations : demandez d'abord l'autorisation depuis l'étape « Demande du BV ${nature} % ».`;
}

/**
 * L'ÉTAPE « DEMANDE DU BV » SUIT LA DÉCISION — « en cours » tant que le centre n'a pas tranché, « fait » une fois
 * acceptée, « à faire » après un refus (on redemande).
 *
 * C'est ce qui garde le niveau de process juste (`process-status.ts`, `BV_PAIRS`) : « Attente paiement BV » se lit
 * sur une demande FAITE et un paiement non fait. Un BV demandé mais pas encore accepté n'attend pas son paiement — il
 * attend une autorisation : le dossier reste au niveau que ses autres étapes disent (préparation, le plus souvent).
 */
export function etapeDeDemandeSelonLaDecision(status: string): "DOING" | "DONE" | "TODO" {
  const e = etatDeLaDemandeBv(status);
  return e === "ACCEPTE" ? "DONE" : e === "EN_ATTENTE" ? "DOING" : "TODO";
}

/** Ce que l'étape « Demande du BV » affiche d'une demande au centre de validations (sérialisable). */
export interface SuiviDemandeBvVue {
  etat: EtatDemandeBv;
  validationId: string;
  reference: string;
  montant: number;
  demandeLe: string;
  decideLe: string | null;
  /** Qui a tranché (accepté ou refusé). */
  decideur: string | null;
  /** Le motif du refus, tel que le validateur l'a écrit. */
  motifRefus: string | null;
}

/**
 * LA FILE D'UN MEMBRE DU CENTRE : une demande de BV n'y paraît qu'UNE fois — par son étape s'il en a une, sinon par une
 * étape de la demande (il la tranchera sur la sienne, créée à la décision : `etapeDuCentrePourLeBv`). Qui n'a plus
 * l'accès au centre ne voit plus les BV, même ceux où une étape l'attendait : il ne peut plus les trancher. Les autres
 * demandes passent telles quelles.
 */
export function uneEtapeParDemandeBv<T extends { validatorId: string; request: { id: string; objectType: string | null } }>(
  etapes: readonly T[], userId: string, accesAuCentre: boolean,
): T[] {
  const retenue = new Map<string, T>();
  for (const e of etapes) {
    if (!estObjetBv(e.request.objectType) || !accesAuCentre) continue;
    const deja = retenue.get(e.request.id);
    if (!deja || (deja.validatorId !== userId && e.validatorId === userId)) retenue.set(e.request.id, e);
  }
  return etapes.filter((e) => !estObjetBv(e.request.objectType) || retenue.get(e.request.id) === e);
}
