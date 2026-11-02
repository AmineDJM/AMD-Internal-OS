/**
 * QUI PEUT ÉMETTRE UNE PIÈCE, QUI PEUT RÉGLER LE PROFIL — les deux questions que l'outil d'Adam
 * pose AVANT d'être proposé au modèle ou au planificateur de missions.
 *
 * Ce module est volontairement minuscule et sans état : il traduit deux règles qui existent déjà
 * (`legalWriteAllowed`, la porte d'écriture du registre Legal ; `canManageLetterheads`, la
 * responsabilité de la papeterie) pour que `office-capabilities.ts` puisse fermer ses outils
 * sans importer l'ERP — la frontière Adam ↔ ERP est au plafond mesuré, et c'est le pont qui a
 * le droit de la traverser. La MÊME règle est rejouée dans `factory.ts` au moment d'agir :
 * l'outil fermé est une commodité pour le planificateur, la garde est dans le pont.
 */

import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { legalWriteAllowed } from "@/lib/legal/invoices";
import { canManageLetterheads } from "@/lib/office/letterhead";

/** Peut émettre AU MOINS une nature de pièce (Legal ouvre tout ; Finances ouvre les factures). */
export function peutEmettrePieces(user: CurrentUser): boolean {
  const onLegal = userCan(user, "LEGAL", "CREATE");
  const onFinances = userCan(user, "FINANCES", "CREATE");
  return legalWriteAllowed({ onLegal, onFinances, kind: "QUOTE" }) || legalWriteAllowed({ onLegal, onFinances, kind: "INVOICE" });
}

export function peutReglerProfilDocumentaire(user: CurrentUser): boolean {
  return canManageLetterheads(user);
}
