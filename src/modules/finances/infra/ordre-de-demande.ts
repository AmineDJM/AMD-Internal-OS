import type { FinanceCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { annulerOrdreNonRegle } from "./annulation";
import { lireTauxRetenue } from "./retenues";
import { natureDepense, type NatureDepense } from "../domaine/natures-depense";
import { type CalculRetenue, calculerRetenue, phraseRetenue, type RegimeRetenueSource } from "../domaine/retenues";
import { ordreDeLaDemande, type DemandeEnOrdre } from "../domaine/payment-request";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORDRE QU'OUVRE UNE DEMANDE DE PAIEMENT, SELON SA NATURE (24/11/2026).
 *
 * Une seule préparation pour les trois moments où une demande devient un ordre (transmise à la création, transmise depuis
 * le brouillon, bon à payer d'un dossier d'avant l'ordre-à-la-soumission) — l'ordre lui-même naît toujours par
 * `createExpenseOrder`, son unique écrivain, appelé par l'action. La nature y ajoute :
 *   • la RUBRIQUE comptable (fin du `FOURNISSEUR` forcé) ;
 *   • la LIGNE BUDGÉTAIRE pré-choisie (`ligneBudgetaireDeLaNature`) — les Finances peuvent encore la changer au règlement ;
 *   • la RETENUE À LA SOURCE : l'ordre paie le NET, la retenue naît PRÉVUE à côté (`infra/retenues.ts`).
 * Une demande sans nature (d'avant la règle) garde l'ordre d'avant : le montant demandé, en `FOURNISSEUR`, sans ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA LIGNE BUDGÉTAIRE D'UNE NATURE pour une société : une ligne active qui porte sa clé (la société d'abord, puis une
 * enveloppe sans société ; l'exercice en cours d'abord, puis le plus récent) ; sinon, la première ligne d'une enveloppe
 * qui couvre son module (`pickAutoCategory`, la règle du règlement). `null` : les Finances classeront en payant.
 */
export async function ligneBudgetaireDeLaNature(nature: NatureDepense, companyId: string | null, quand: Date = new Date()): Promise<string | null> {
  if (nature.tresorerieSeulement) return null;
  const societes = { OR: [{ companyId }, { companyId: null }] };
  if (nature.ligne) {
    const lignes = await prisma.budgetCategoryLine.findMany({
      where: { cle: nature.ligne, envelope: { isActive: true, ...societes } },
      select: { id: true, createdAt: true, envelope: { select: { companyId: true, periodStart: true, periodEnd: true } } },
    });
    const rang = (l: (typeof lignes)[number]) => [
      l.envelope.companyId === companyId && companyId !== null ? 0 : 1,
      l.envelope.periodStart <= quand && quand <= l.envelope.periodEnd ? 0 : 1,
      -l.envelope.periodStart.getTime(),
      l.createdAt.getTime(),
    ];
    const triees = [...lignes].sort((a, b) => {
      const ra = rang(a), rb = rang(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    });
    if (triees[0]) return triees[0].id;
  }
  if (nature.module) {
    const [envelopes, categories] = await Promise.all([
      prisma.budgetEnvelope.findMany({ where: { isActive: true, ...societes }, select: { id: true, isActive: true, modules: true, module: true, periodStart: true } }),
      prisma.budgetCategoryLine.findMany({ where: { parentId: null, envelope: { isActive: true, ...societes } }, select: { id: true, envelopeId: true, module: true, parentId: true, createdAt: true } }),
    ]);
    return pickAutoCategory(nature.module, envelopes, categories);
  }
  return null;
}

/** Ce que la nature fait de l'ordre d'une demande : son entrée pour `createExpenseOrder`, et la retenue à prévoir. */
export interface OrdrePrepare {
  ordre: ReturnType<typeof ordreDeLaDemande> & { category: FinanceCategory };
  demande: { id: string; reference: string; payee: string; requesterId: string };
  retenue: { nature: string; regime: RegimeRetenueSource; calcul: CalculRetenue; phrase: string } | null;
}

/**
 * PRÉPARER L'ORDRE D'UNE DEMANDE — l'action le fait naître elle-même par `createExpenseOrder` (son unique écrivain, visible
 * au point d'appel), puis appelle `prevoirLaRetenue`.
 */
export async function preparerOrdreDeLaDemande(
  demande: DemandeEnOrdre & { companyId: string | null; natureDepense: string | null },
  notes: string | null,
): Promise<OrdrePrepare> {
  const nature = natureDepense(demande.natureDepense);
  const taux = nature?.retenue ? (await lireTauxRetenue())[nature.retenue] : null;
  const calcul = nature?.retenue && taux ? calculerRetenue(demande.amount, taux.taux) : null;
  const retenue = calcul && calcul.retenue > 0 && nature?.retenue && taux
    ? { nature: nature.code, regime: nature.retenue, calcul, phrase: phraseRetenue(calcul, nature.retenue, taux.confirmeParCabinet) }
    : null;
  const base = ordreDeLaDemande(demande, [notes, retenue?.phrase].filter(Boolean).join(" — ") || null, nature ? {
    rubrique: nature.rubrique,
    montant: retenue ? retenue.calcul.net : demande.amount,
    budgetCategoryId: await ligneBudgetaireDeLaNature(nature, demande.companyId),
  } : undefined);
  return {
    ordre: { ...base, category: base.category as FinanceCategory },
    demande: { id: demande.id, reference: demande.reference, payee: demande.payee, requesterId: demande.requesterId },
    retenue,
  };
}

/**
 * LA RETENUE PRÉVUE de l'ordre qui vient de naître (rien si la nature n'en porte pas), et sa phrase dans le fil du dossier.
 * Un net sans sa retenue ne part pas : si elle ne s'enregistre pas, l'ordre est annulé et l'erreur remonte.
 */
export async function prevoirLaRetenue(prep: OrdrePrepare, ordre: { id: string; companyId: string | null }): Promise<void> {
  const r = prep.retenue;
  if (!r) return;
  try {
    await prisma.retenueSource.create({
      data: {
        expenseOrderId: ordre.id, companyId: ordre.companyId, paymentRequestId: prep.demande.id, natureDepense: r.nature,
        regime: r.regime, beneficiaire: prep.demande.payee, brut: r.calcul.brut, taux: r.calcul.taux, montant: r.calcul.retenue,
        net: r.calcul.net, statut: "PREVUE", createdById: prep.demande.requesterId,
      },
    });
  } catch (e) {
    await annulerOrdreNonRegle(ordre.id, { acteurId: prep.demande.requesterId, motif: `retenue à la source non enregistrée (${prep.demande.reference})` });
    throw e;
  }
  await prisma.paymentRequestEvent.create({ data: { requestId: prep.demande.id, actorId: null, kind: "COMMENT", message: r.phrase } });
}
