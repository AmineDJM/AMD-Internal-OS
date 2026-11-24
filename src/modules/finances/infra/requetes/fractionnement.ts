import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { toNumber } from "@/lib/utils";
import {
  detecterFractionnement, seuilsDeFractionnement, FENETRE_FRACTIONNEMENT_JOURS,
  type DemandeComparable, type SeuilDeFractionnement, type SignalFractionnement,
} from "../../domaine/fractionnement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SIGNAL « POSSIBLE FRACTIONNEMENT », LU SUR LES ORDRES DE DÉPENSE — la porte que les écrans de décision appellent.
 *
 * Tout paiement de la société naît en ordre de dépense et passe par le centre de paiement, quel que soit son montant :
 * c'est là que des demandes restées une à une sous les seuils se retrouvent côte à côte. La règle est pure
 * (`domaine/fractionnement.ts`) ; ici, on lit les seuils EN VIGUEUR (réglages + règles actives du centre de validations)
 * et les ordres voisins du même demandeur.
 *
 * Ce qui compte : un ordre non annulé et non refusé par le centre — l'argent engagé ou en passe de l'être. Un refus n'a
 * rien engagé ; une demande retirée non plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const JOUR_MS = 24 * 60 * 60 * 1000;
const FENETRE_MS = FENETRE_FRACTIONNEMENT_JOURS * JOUR_MS;

/** Les seuils d'aujourd'hui, tels que les circuits les appliquent — on n'en invente aucun. */
export async function seuilsDeFractionnementEnVigueur(): Promise<SeuilDeFractionnement[]> {
  const [reglages, regles] = await Promise.all([
    getAppSettings(),
    prisma.validationRule.findMany({ where: { active: true, minAmount: { gt: 0 } }, select: { name: true, minAmount: true } }),
  ]);
  return seuilsDeFractionnement({
    adProDgThreshold: reglages.adProDgThreshold,
    bcValidationThreshold: reglages.bcValidationThreshold,
    bcValidationThresholdCentre: reglages.bcValidationThresholdCentre,
    reglesDeValidation: regles.map((r) => ({ nom: r.name, minAmount: toNumber(r.minAmount) })),
  });
}

const SELECT_ORDRE = {
  id: true, reference: true, amount: true, createdAt: true, requestedById: true, beneficiary: true, budgetCategoryId: true,
} as const;

function comparable(o: {
  id: string; reference: string; amount: unknown; createdAt: Date; requestedById: string | null; beneficiary: string | null; budgetCategoryId: string | null;
}): DemandeComparable {
  return {
    id: o.id, reference: o.reference, montant: toNumber(o.amount), date: o.createdAt,
    demandeurId: o.requestedById, beneficiaire: o.beneficiary, ligneBudgetaire: o.budgetCategoryId,
  };
}

/** Les ordres voisins (même demandeur, fenêtre élargie de 30 jours de part et d'autre) qui comptent dans un cumul. */
async function voisins(demandeurs: string[], debut: Date, fin: Date): Promise<DemandeComparable[]> {
  if (demandeurs.length === 0) return [];
  const rows = await prisma.expenseOrder.findMany({
    where: {
      requestedById: { in: demandeurs },
      createdAt: { gte: new Date(debut.getTime() - FENETRE_MS), lte: new Date(fin.getTime() + FENETRE_MS) },
      status: { not: "CANCELLED" },
      centralStatus: { not: "REFUSED" },
    },
    select: SELECT_ORDRE,
  });
  return rows.map(comparable);
}

/**
 * LES SIGNAUX DES ORDRES DONNÉS — une entrée par ordre signalé (les autres sont absents de la table). Pour la file du centre
 * de paiement, la fiche d'un paiement, l'assistant : la donnée est la même partout.
 */
export async function signauxDeFractionnement(orderIds: readonly string[]): Promise<Map<string, SignalFractionnement>> {
  const signaux = new Map<string, SignalFractionnement>();
  if (orderIds.length === 0) return signaux;
  const cibles = (await prisma.expenseOrder.findMany({ where: { id: { in: [...orderIds] } }, select: SELECT_ORDRE })).map(comparable);
  const avecDemandeur = cibles.filter((c) => c.demandeurId);
  if (avecDemandeur.length === 0) return signaux;
  const seuils = await seuilsDeFractionnementEnVigueur();
  if (seuils.length === 0) return signaux;
  const temps = avecDemandeur.map((c) => c.date.getTime());
  const autres = await voisins(
    [...new Set(avecDemandeur.map((c) => c.demandeurId as string))], new Date(Math.min(...temps)), new Date(Math.max(...temps)),
  );
  for (const c of avecDemandeur) {
    const s = detecterFractionnement(c, autres, seuils);
    if (s) signaux.set(c.id, s);
  }
  return signaux;
}

/**
 * LE SIGNAL D'UNE DEMANDE QUI N'EST PAS (ENCORE) UN ORDRE — pour la porte DG / le centre Ad & Pro et le centre de
 * validations : la demande examinée, comparée aux ordres déjà nés du même demandeur. `id` ne doit désigner aucun ordre
 * (ou celui de la demande, qui est alors écarté du cumul).
 */
export async function signalDeFractionnementPour(demande: DemandeComparable): Promise<SignalFractionnement | null> {
  if (!demande.demandeurId) return null;
  const seuils = await seuilsDeFractionnementEnVigueur();
  if (seuils.length === 0) return null;
  return detecterFractionnement(demande, await voisins([demande.demandeurId], demande.date, demande.date), seuils);
}
