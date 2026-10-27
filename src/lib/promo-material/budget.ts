/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL PROMOTIONNEL AU BUDGET (Direction, 27/10 — point 21).
 *
 * « Matériel promotionnel hors budget » : ses bons de commande étaient signés et ses factures payées sans
 * qu'aucune enveloppe ne le voie passer. Désormais :
 *   • la DIRECTION MARKETING impute une (sous-)catégorie du Budget Marketing au dossier
 *     (`PromoMaterial.budgetCategoryId`) — la catégorie doit convenir au matériel promotionnel
 *     (`ad-pro/categorie-budgetaire.ts`) ;
 *   • ses BC SIGNÉS comptent en ENGAGÉ sur cette catégorie, pour ce qui n'est pas encore parti en paiement ;
 *   • ses ordres FOURNISSEUR (factures envoyées au règlement, bordereau et règlement de l'ancien parcours)
 *     comptent en CONSOMMÉ — « en circuit » tant qu'ils ne sont pas réglés, puis payés : l'écriture du
 *     règlement porte la catégorie de l'ordre.
 * Jamais deux fois le même dinar : l'engagé est ce que les BC signés promettent MOINS ce que les ordres
 * vivants paient déjà (`engagementDuPoste`, même raisonnement que pour un poste Ad & Pro).
 *
 * Module PUR (son seul import est pur lui aussi) : la lecture (`queries/promo-budget.ts`) passe des faits.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { estDirectionMarketing } from "@/lib/personnes/roles-vente";

export interface BcDuDossierPromo {
  montant: number | null;
  /** Signé par les Finances (`signedAt` posé) — un BC non signé ne part pas chez le fournisseur. */
  signe: boolean;
}

export interface OrdreDuDossierPromo {
  montant: number;
  /** `ExpenseOrder.status` : PENDING | REVISION_REQUESTED | PAID | CANCELLED. */
  statut: string;
}

const positif = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : 0);

/** Les statuts d'un ordre qui attend encore son règlement — les mêmes que `STATUTS_ORDRE_ENGAGES`. */
const EN_CIRCUIT = ["PENDING", "REVISION_REQUESTED"];

export function ordreEnCircuitPromo(statut: string): boolean {
  return EN_CIRCUIT.includes(statut);
}

/** Le total des BC signés du dossier. */
export function totalBcSignes(bcs: readonly BcDuDossierPromo[]): number {
  return bcs.reduce((a, b) => a + (b.signe ? positif(b.montant) : 0), 0);
}

/**
 * L'ENGAGÉ du dossier : les BC signés, moins ce que ses ordres vivants (en circuit ou payés) couvrent déjà.
 * Un ordre annulé ne couvre rien ; l'engagé n'est jamais négatif.
 */
export function engageDuDossierPromo(f: { bcs: readonly BcDuDossierPromo[]; ordres: readonly OrdreDuDossierPromo[] }): number {
  const couvert = f.ordres.reduce((a, o) => a + (o.statut !== "CANCELLED" ? positif(o.montant) : 0), 0);
  return Math.max(0, totalBcSignes(f.bcs) - couvert);
}

/** Qui impute : la Direction Marketing (rôle principal ou secondaire) — et le Super Admin. */
export function peutImputerMaterielPromo(user: { role: string; secondaryRole?: string | null }): boolean {
  return estDirectionMarketing(user) || user.role === "SUPER_ADMIN" || user.secondaryRole === "SUPER_ADMIN";
}

export const REFUS_IMPUTATION_PROMO =
  "L'imputation budgétaire d'un matériel promotionnel revient à la Direction Marketing.";

/** Le refus d'une imputation (hors droit et hors convenance de la catégorie), ou `null`. */
export function refusImputationPromo(p: {
  dossierRefuse: boolean;
  cible: { id: string; domaine: string } | null;
  actuelleId: string | null;
}): string | null {
  if (p.dossierRefuse) return "Ce dossier est refusé : il ne pèse sur aucun budget.";
  if (!p.cible) return "Choisissez une catégorie du Budget Marketing.";
  if (p.cible.domaine !== "MARKETING") return "Un matériel promotionnel ne s'impute qu'à une catégorie d'une enveloppe du Budget Marketing.";
  if (p.cible.id === p.actuelleId) return "C'est déjà le budget de ce dossier.";
  return null;
}
