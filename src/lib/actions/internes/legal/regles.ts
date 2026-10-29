/**
 * LEGAL — les règles du registre lues par les actions : les natures saisissables, la porte d'écriture
 * (Legal / Comptabilité), le maillon amont d'une chaîne.
 *
 * Sorti de `actions/legal-actions.ts` (lot V4) : aucune écriture.
 */
import type { LegalDocKind } from "@prisma/client";
import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { refusMaillonAmont } from "@/lib/legal/chaine";
import { legalWriteAllowed } from "@/lib/legal/invoices";

// AMENDMENT n'y figure pas, et c'est délibéré : un avenant naît de SON contrat (`amendsId`), pas
// d'un formulaire libre — un avenant orphelin ne modifierait rien et fausserait la valeur du marché.
// CREDIT_NOTE non plus, pour la même raison : un avoir naît de SA facture, par la fabrique (§118.195), qui reprend son
// calcul et vérifie ce qui reste à créditer. Saisi ici et chaîné par « Fait suite à », il serait retiré du règlement de
// la facture sans être passé par ce plafond — un crédit que personne n'a borné.
export const KINDS: LegalDocKind[] = ["CONTRACT", "QUOTE", "PURCHASE_ORDER", "INVOICE", "AGREEMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "OTHER"];
export const parseKind = (v: string | null): LegalDocKind =>
  v && KINDS.includes(v as LegalDocKind) ? (v as LegalDocKind) : "CONTRACT";

/**
 * LA PORTE D'ÉCRITURE DU REGISTRE.
 *
 * Legal tient tout le registre ; la COMPTABILITÉ ne tient que les factures. La règle est un
 * module pur partagé avec l'écran et avec les actions du vocabulaire « facture » — trois copies
 * d'un contrôle d'accès finissent par diverger, et la divergence s'appelle une faille.
 */
export function peutEcrire(user: CurrentUser, verb: "CREATE" | "UPDATE" | "DELETE", kind: string): boolean {
  return legalWriteAllowed({
    onLegal: userCan(user, "LEGAL", verb),
    onFinances: userCan(user, "FINANCES", verb),
    kind,
  });
}

/** Le maillon amont existe-t-il ? La règle vit dans `legal/chaine.ts`, partagée avec les factures. */
export const checkChainFrom = refusMaillonAmont;
