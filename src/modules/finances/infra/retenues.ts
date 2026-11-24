import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  type CalculRetenue, calculerRetenue, LIBELLE_REGIME_RETENUE, moisDeLaRetenue, type RegimeRetenueSource, totalRetenues, type TauxRetenue,
  tauxEnVigueur,
} from "../domaine/retenues";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RETENUES À LA SOURCE — leur vie en base (règles : `domaine/retenues.ts`).
 *
 *   PREVUE      née avec l'ordre qui paie le net (taux figé ce jour-là) — rien n'est encore dû ;
 *   A_REVERSER  l'ordre est réglé : la retenue est due sur la déclaration du MOIS du paiement, et elle consomme la ligne
 *               budgétaire du règlement (une ligne purement budgétaire, `BudgetExpenseLine` : aucun argent ne bouge) ;
 *   REVERSEE    la déclaration qui la porte est payée (`marquerRetenuesReversees`, à brancher par Impôts & cotisations).
 *
 * Un ordre annulé laisse sa retenue PRÉVUE : elle n'est jamais devenue due, et aucune lecture « à reverser » ne la compte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** Les taux en vigueur : ceux réglés par le Super Admin, sinon les défauts (« à confirmer par le cabinet »). */
export async function lireTauxRetenue(client: Client = prisma): Promise<Record<RegimeRetenueSource, TauxRetenue>> {
  const lignes = await client.tauxRetenueSource.findMany({ select: { regime: true, taux: true, confirmeParCabinet: true } });
  return tauxEnVigueur(lignes.map((l) => ({ regime: l.regime, taux: toNumber(l.taux), confirmeParCabinet: l.confirmeParCabinet })));
}

/**
 * LE BRUT CORRIGÉ AVANT LE RÈGLEMENT — la retenue prévue se recalcule au taux FIGÉ, et l'ordre doit porter le nouveau net.
 * Rend le montant que l'ordre doit prendre (le brut lui-même quand l'ordre ne porte pas de retenue).
 */
export async function netApresCorrection(tx: Prisma.TransactionClient, ordreId: string, brut: number): Promise<number> {
  const prevue = await tx.retenueSource.findFirst({ where: { expenseOrderId: ordreId, statut: "PREVUE" }, select: { id: true, taux: true } });
  if (!prevue) return brut;
  const c = calculerRetenue(brut, toNumber(prevue.taux));
  await tx.retenueSource.update({ where: { id: prevue.id }, data: { brut: c.brut, montant: c.retenue, net: c.net } });
  return c.net;
}

/**
 * LE RÈGLEMENT D'UN ORDRE QUI PORTE UNE RETENUE — dans la MÊME transaction que l'écriture de trésorerie (le net) : la
 * retenue devient « à reverser » sur le mois du paiement, et consomme la ligne budgétaire du règlement par une ligne
 * purement budgétaire. Sans ligne (dépense « à imputer »), la retenue est quand même due : seule la consommation attend.
 * Rend la phrase à dire, ou `null` si l'ordre ne porte pas de retenue.
 */
export async function constaterRetenueAuReglement(tx: Prisma.TransactionClient, input: {
  ordreId: string; reference: string; budgetCategoryId: string | null; date: Date; acteurId: string;
}): Promise<string | null> {
  const r = await tx.retenueSource.findFirst({ where: { expenseOrderId: input.ordreId, statut: "PREVUE" } });
  if (!r) return null;
  const montant = toNumber(r.montant);
  const ligne = input.budgetCategoryId
    ? await tx.budgetExpenseLine.create({
        data: {
          categoryId: input.budgetCategoryId, amount: montant, date: input.date, createdById: input.acteurId,
          reference: `Retenue à la source — ${input.reference} (${r.beneficiaire})`,
          notes: `${LIBELLE_REGIME_RETENUE[r.regime as RegimeRetenueSource] ?? r.regime} : à reverser à l'administration fiscale — la dépense coûte le brut (${toNumber(r.brut).toLocaleString("fr-FR")} DZD).`,
        },
        select: { id: true },
      })
    : null;
  const mois = moisDeLaRetenue(input.date);
  await tx.retenueSource.update({
    where: { id: r.id },
    data: { statut: "A_REVERSER", mois, payeeLe: input.date, budgetCategoryId: input.budgetCategoryId, budgetExpenseLineId: ligne?.id ?? null },
  });
  return `Retenue à la source de ${montant.toLocaleString("fr-FR")} DZD à reverser sur la déclaration de ${mois}.`;
}

export interface RetenueAReverser {
  id: string;
  ordreId: string;
  beneficiaire: string;
  regime: RegimeRetenueSource;
  brut: number;
  taux: number;
  montant: number;
  payeeLe: Date | null;
}

/**
 * « RETENUES DU MOIS À REVERSER » d'une société — ce que la déclaration du mois (G50) doit porter en plus. Lu par
 * Impôts & cotisations ; le total est déjà CONSOMMÉ sur les lignes des dépenses : la déclaration ne le reconsomme pas.
 */
export async function retenuesDuMoisAReverser(input: { companyId: string | null; mois: string }): Promise<{ total: number; lignes: RetenueAReverser[] }> {
  const rows = await prisma.retenueSource.findMany({
    where: { companyId: input.companyId, mois: input.mois, statut: "A_REVERSER" },
    orderBy: { payeeLe: "asc" },
  });
  const lignes = rows.map((r) => ({
    id: r.id, ordreId: r.expenseOrderId, beneficiaire: r.beneficiaire, regime: r.regime as RegimeRetenueSource,
    brut: toNumber(r.brut), taux: toNumber(r.taux), montant: toNumber(r.montant), payeeLe: r.payeeLe,
  }));
  return { total: totalRetenues(lignes), lignes };
}

/**
 * LA DÉCLARATION QUI LES PORTE EST PAYÉE — les retenues passent « reversées », rattachées à l'ordre de la déclaration.
 * Conditionnelle : seules celles encore « à reverser » changent (deux règlements ne les reversent pas deux fois).
 */
export async function marquerRetenuesReversees(input: { ids: readonly string[]; ordreId: string; date: Date }, client: Client = prisma): Promise<number> {
  if (input.ids.length === 0) return 0;
  const r = await client.retenueSource.updateMany({
    where: { id: { in: [...input.ids] }, statut: "A_REVERSER" },
    data: { statut: "REVERSEE", reverseeLe: input.date, reverseeParOrdreId: input.ordreId },
  });
  return r.count;
}

/** La retenue d'un ordre (ou d'une demande), pour l'afficher — `null` s'il n'en porte pas. */
export async function retenueDeLOrdre(ordreId: string): Promise<{ brut: number; taux: number; montant: number; net: number; statut: string; mois: string | null; regime: RegimeRetenueSource } | null> {
  const r = await prisma.retenueSource.findUnique({ where: { expenseOrderId: ordreId } });
  return r ? { brut: toNumber(r.brut), taux: toNumber(r.taux), montant: toNumber(r.montant), net: toNumber(r.net), statut: r.statut, mois: r.mois, regime: r.regime as RegimeRetenueSource } : null;
}
