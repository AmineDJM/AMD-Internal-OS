import { prisma } from "@/lib/prisma";
import type { SourceOrganisation } from "../../domaine/organisations/candidats";
import { rattacherFiche } from "./fiches";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DOUBLE ÉCRITURE DES ORGANISATIONS (palier P3, `docs/architecture/refonte-p3-inventaire.md` §5).
 *
 * À la création d'un fournisseur, d'un partenaire ou d'un établissement, l'action appelle
 * `doubleEcrireOrganisation` APRÈS son écriture : la fiche est rattachée à son organisation par le MÊME code
 * que la reprise (`fiches.ts` → `ecriture.ts`), donc avec la même règle d'identifiants et de doublons.
 *
 *   • INTERRUPTEUR : `AppSetting.doubleEcritureOrganisations`, faux par défaut, réglé par le Super Admin
 *     (Administration › Refonte des données). Fermé, rien n'est écrit — la reprise rattrapera.
 *   • NON BLOQUANTE : tant qu'aucun écran ne LIT le référentiel, un échec est journalisé et laisse
 *     `organisationId` nul ; l'action métier réussit quand même. Elle deviendra bloquante quand un écran
 *     basculera sur le référentiel (§6 de l'inventaire).
 *   • HORS DE LA TRANSACTION de l'écrivain, et non dedans comme le proposait §5.1 : une erreur Postgres
 *     annule toute la transaction en cours, et « non bloquante » serait alors un mensonge. La fiche et son
 *     lien sont écrits dans une transaction à elles ; une fiche créée sans lien est rattrapée par la reprise.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export async function doubleEcritureOrganisationsOuverte(): Promise<boolean> {
  const s = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { doubleEcritureOrganisations: true } });
  return s?.doubleEcritureOrganisations ?? false;
}

export async function doubleEcrireOrganisation(source: SourceOrganisation, id: string, acteurId: string | null): Promise<void> {
  try {
    if (!(await doubleEcritureOrganisationsOuverte())) return;
    await rattacherFiche(source, id, acteurId);
  } catch (e) {
    console.error(`[referentiels] double écriture ${source} ${id} :`, e);
  }
}
