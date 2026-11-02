import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * LE MOMENT OÙ LES RH ONT TRAITÉ UNE DEMANDE — posé UNE fois, jamais écrasé.
 *
 * Une demande RH change d'état à six endroits (statut posé par les RH, document déposé, décision d'accord,
 * entrevue confirmée, ordre de mission généré…). Plutôt que d'y recopier la règle, chacun appelle ce geste après
 * son écriture : l'écriture est CONDITIONNELLE (« encore non daté »), donc idempotente et sans course. Elle alimente la
 * brique KPI « demandes traitées » et son délai médian (`kpi/briques-calcul.ts`).
 */

/** Les états qui disent « traitée » : le document est prêt ou remis, la décision est prise. */
export const ETATS_RH_TRAITES = ["READY", "DELIVERED", "APPROVED", "REJECTED"] as const;

export const estEtatRhTraite = (statut: string): boolean => (ETATS_RH_TRAITES as readonly string[]).includes(statut);

/** Date la demande si elle ne l'est pas encore. Ne lève jamais : un KPI ne doit pas faire échouer un traitement. */
export async function marquerDemandeRhTraitee(id: string, quand: Date = new Date()): Promise<void> {
  await prisma.hrDocumentRequest.updateMany({ where: { id, handledAt: null }, data: { handledAt: quand } }).catch(sansBloquer("hr-demande-traitee.marquerDemandeRhTraitee.hrDocumentRequest"));
}
