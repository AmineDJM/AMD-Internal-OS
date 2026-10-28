import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { jourAlger, compteParDefaut, resoudreCompte, type CompteTresorerie } from "../domaine/tresorerie";

/**
 * LES COMPTES DE TRÉSORERIE, LUS POUR LA RÈGLE (§118.176) — le domaine Finances.
 *
 * Les écrivains d'écritures (règlement d'un ordre, d'une facture, paie, caisse, saisie, import) et
 * la façade de lecture (`queries/finance`) en ont tous besoin : ce module vit dans le DOMAINE, que
 * la façade a le droit de lire — l'inverse ferait remonter un domaine vers une façade, ce que la
 * carte des domaines refuse (§118.171).
 */

export type CompteRow = Awaited<ReturnType<typeof lireComptes>>[number];

export async function lireComptes() {
  return prisma.treasuryAccount.findMany({
    orderBy: [{ principal: "desc" }, { name: "asc" }],
    select: {
      id: true, name: true, openingBalance: true, openingDate: true, notes: true, bank: true, rib: true,
      companyId: true, principal: true, company: { select: { name: true, shortName: true } },
    },
  });
}

export const versCompte = (c: CompteRow): CompteTresorerie => ({
  id: c.id, nom: c.name, societeId: c.companyId, principal: c.principal,
  ancrage: toNumber(c.openingBalance), jourAncrage: jourAlger(c.openingDate),
});

/**
 * LE COMPTE QU'UNE ÉCRITURE NEUVE FIGE — la même règle que la lecture (`compteDuFlux`), appliquée
 * au moment où l'argent bouge. Le compte NOMMÉ par celui qui écrit (« payé depuis… ») l'emporte
 * s'il existe ; sinon le libellé de compte, puis le principal de l'entité, puis le compte unique.
 * Sans compte, `null` : l'écriture reste lisible par l'historique, rien ne se bloque — un paiement
 * ne doit jamais attendre qu'un compte soit ancré (§118.27).
 */
export async function compteDeLEcriture(input: { compteId?: string | null; compte?: string | null; societeId: string | null }): Promise<string | null> {
  return resoudreCompte(await comptesTresorerie(), input);
}

/** Tous les comptes, sous la forme que lit la règle — pour un écrivain qui en résout plusieurs (import). */
export async function comptesTresorerie(): Promise<CompteTresorerie[]> {
  return (await lireComptes()).map(versCompte);
}

/** Le compte par défaut d'une entité, parmi tous — pour pré-sélectionner « payé depuis ». */
export async function compteParDefautDe(societeId: string | null): Promise<string | null> {
  return compteParDefaut((await lireComptes()).map(versCompte), societeId);
}
