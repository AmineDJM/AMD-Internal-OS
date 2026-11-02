/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MONTANT D'UNE DEMANDE Ad & Pro QUAND UNE RALLONGE EST ACCORDÉE — module PUR.
 *
 * ── LA DEMANDE DE LA DIRECTION (09/2026) ────────────────────────────────────────────────
 *
 * « Quand on ajoute un poste dans un événement, sponsoring ou quoi de Ad&Pro, une fois budget
 * supplémentaire accordé par la Direction Marketing, il doit être mis à jour dans la demande, le
 * montant. »
 *
 * ── LES DEUX DISTINCTIONS QUI FONT TOUT ─────────────────────────────────────────────────
 *
 * 1. SEULE UNE RALLONGE S'AJOUTE. Un poste `INCLUDED` est déjà DANS l'enveloppe accordée ;
 *    l'additionner compterait la même dépense deux fois, et la fiche annoncerait un budget que
 *    personne n'a accordé. `budgetKind` porte exactement cette distinction depuis le début —
 *    « sans quoi une rallonge assumée passerait pour un dépassement subi ».
 *
 * 2. ON RECALCULE, ON N'INCRÉMENTE PAS. Un poste se décide plusieurs fois (accordé → à revoir →
 *    accordé, `AdProItemDecision` garde chaque tour) : une addition au fil de l'eau doublerait
 *    la rallonge au second passage. Le total se REFAIT depuis la base et la liste des rallonges
 *    en cours, ce qui le rend idempotent — le seul moyen de survivre à une re-décision.
 *
 * ── LA BASE, ET POURQUOI ELLE NE PEUT PAS ÊTRE LE MONTANT AFFICHÉ ───────────────────────
 *
 * La base est le montant que le CIRCUIT a accordé (`WorkflowInstance.amount`). Le champ affiché
 * sur la fiche (`amountGranted` / `finalAmount`) est justement ce que cette fonction écrit :
 * s'en servir comme base le ferait grossir à chaque passage. Deux rôles, deux champs.
 *
 * Base inconnue ⇒ `null` ⇒ ON NE TOUCHE À RIEN. Fabriquer un montant à partir des seules
 * rallonges annoncerait un budget accordé que personne n'a accordé (§118.16) : une opération
 * sans circuit de financement n'a pas de montant de demande, et c'est une réponse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un poste, réduit aux trois faits dont le calcul a besoin. */
export interface PostePourMontant {
  /** `INCLUDED` (dans l'enveloppe) ou `ADDITIONAL` (rallonge accordée en plus). */
  budgetKind: string | null | undefined;
  /** `APPROVED` | `REJECTED` | `REVISION` | `DRAFT`… — seul APPROVED compte. */
  status: string | null | undefined;
  /** Le montant réellement accordé au poste. */
  amountGranted: number | null | undefined;
}

/** Un poste est-il une RALLONGE accordée — donc un ajout au montant de la demande ? */
export function estRallongeAccordee(p: PostePourMontant): boolean {
  return p.budgetKind === "ADDITIONAL" && p.status === "APPROVED" && (p.amountGranted ?? 0) > 0;
}

/**
 * LE MONTANT DE LA DEMANDE = base accordée par le circuit + rallonges accordées.
 *
 * Rend `null` quand la base est inconnue (voir l'en-tête) : l'appelant n'écrit alors rien.
 * Rend la base INCHANGÉE quand il n'y a aucune rallonge — c'est le cas de loin le plus fréquent,
 * et il doit être un no-op parfait.
 */
export function montantDeLaDemande(
  base: number | null | undefined,
  postes: readonly PostePourMontant[],
): number | null {
  if (base == null || !Number.isFinite(base)) return null;
  const rallonges = postes.filter(estRallongeAccordee).reduce((t, p) => t + (p.amountGranted ?? 0), 0);
  return base + rallonges;
}
