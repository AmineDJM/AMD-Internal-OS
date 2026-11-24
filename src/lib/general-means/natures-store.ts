import { prisma } from "@/lib/prisma";
import { CLE_MOYENS_GENERAUX, CODE_ENVELOPPE_ADMINISTRATION, ligneMoyensGeneraux } from "@/modules/finances/api";
import { GENERAL_MEANS_MODULE } from "./budget-targets";
import { NATURES_PAR_DEFAUT, categorieDuMemeNom, normaliserNomNature, type CategorieConnue } from "./natures";

/**
 * LES NATURES DES MOYENS GÉNÉRAUX, CÔTÉ BASE — la ligne qui les porte, ses catégories par défaut, et la création d'une
 * nouvelle catégorie quand l'IA (ou la personne) en nomme une (Direction, 10/2026).
 *
 * Les natures SONT des catégories budgétaires (`BudgetCategoryLine`) : le module Budget les montre, les Finances les
 * renomment ou en ajoutent, et l'écran des moyens généraux les lit comme avant (`generalMeansBudgetTargets`). Rien de
 * parallèle — c'est la seule façon que « Par nature » et le budget disent la même chose.
 *
 * ── OÙ ELLES VIVENT : PAR SOCIÉTÉ, DANS LE BUDGET DE L'ADMINISTRATION (Super Admin, 24/11/2026) ─────────────────────
 *
 * L'enveloppe « Moyens généraux » était UNIQUE pour le groupe ; les moyens généraux passent par société, dans le budget
 * de l'Administration tenu par les Finances : les natures sont les SOUS-LIGNES de la ligne « Moyens généraux »
 * (`MOYENS_GENERAUX`) de l'enveloppe « Administration <année> » de la société (ouverte au besoin, montant 0). Les
 * catégories par défaut absentes y sont ajoutées, reconnues par leur CLÉ (`MG_…`) ou, pour une catégorie créée à la main
 * avant elles, par leur nom : rien n'est dupliqué, rien n'est renommé. La migration
 * `20270249000000_charges_fixes_administration` y a recopié les catégories de l'ancienne enveloppe et rattaché chaque
 * dépense à la société de son département. Une enveloppe encore marquée « moyens généraux » (créée à la main) reste lue.
 *
 * Sans société connue (aucune fiche, aucun département), on ne devine pas : rien n'est créé, la dépense reste « à classer ».
 */

/** La garantie ne se rejoue pas à chaque affichage : une fois posée, la ligne ne disparaît pas d'elle-même. */
const garanties = new Map<string, { ligneId: string; at: number }>();
const DUREE_GARANTIE_MS = 10 * 60 * 1000;

/**
 * GARANTIT la ligne « Moyens généraux » de la société (année en cours) et ses catégories par défaut ; rend l'identifiant
 * de la ligne. Idempotent, sûr à appeler à chaque affichage (mis en mémoire dix minutes par processus).
 */
export async function assurerNaturesMoyensGeneraux(companyId: string | null | undefined): Promise<string | null> {
  if (!companyId) return null;
  const deja = garanties.get(companyId);
  if (deja && Date.now() - deja.at < DUREE_GARANTIE_MS) return deja.ligneId;
  const { ligneId } = await ligneMoyensGeneraux(companyId, new Date().getUTCFullYear(), null);
  const ligne = await prisma.budgetCategoryLine.findUnique({ where: { id: ligneId }, select: { envelopeId: true } });
  if (!ligne) return null;
  const presentes = await prisma.budgetCategoryLine.findMany({ where: { parentId: ligneId }, select: { id: true, name: true, cle: true } });
  const connues: CategorieConnue[] = presentes.map((c) => ({ id: c.id, nom: c.name, cle: c.cle }));
  const manquantes = NATURES_PAR_DEFAUT.filter((n) => !connues.some((c) => c.cle === n.cle) && !categorieDuMemeNom(n.nom, connues));
  if (manquantes.length > 0) {
    await prisma.budgetCategoryLine.createMany({
      data: manquantes.map((n) => ({ envelopeId: ligne.envelopeId, parentId: ligneId, name: n.nom, cle: n.cle, module: GENERAL_MEANS_MODULE })),
    });
  }
  garanties.set(companyId, { ligneId, at: Date.now() });
  return ligneId;
}

/**
 * Où l'on range : les sous-lignes « Moyens généraux » des budgets de l'Administration actifs (de la société, quand elle
 * est connue), et les catégories d'une enveloppe encore marquée « moyens généraux ».
 */
export function clauseNaturesMoyensGeneraux(companyId?: string | null) {
  const societe = companyId ? { companyId } : {};
  return {
    OR: [
      { parent: { cle: CLE_MOYENS_GENERAUX, parentId: null }, envelope: { isActive: true, module: CODE_ENVELOPPE_ADMINISTRATION, ...societe } },
      {
        envelope: {
          isActive: true,
          AND: [
            { OR: [{ modules: { has: GENERAL_MEANS_MODULE } }, { module: GENERAL_MEANS_MODULE }] },
            ...(companyId ? [{ OR: [{ companyId }, { companyId: null }] }] : []),
          ],
        },
      },
    ],
  };
}

/** Les catégories où l'on range (sous-catégories comprises), pour la société de la dépense quand elle est connue. */
export async function naturesConnues(companyId?: string | null): Promise<CategorieConnue[]> {
  const rows = await prisma.budgetCategoryLine.findMany({
    where: clauseNaturesMoyensGeneraux(companyId),
    select: { id: true, name: true, cle: true, envelope: { select: { periodStart: true } } },
    orderBy: [{ envelope: { periodStart: "desc" } }, { name: "asc" }],
  });
  return rows.map((c) => ({ id: c.id, nom: c.name, cle: c.cle }));
}

/**
 * La catégorie qui porte ce nom — créée sous la ligne « Moyens généraux » de la société si elle n'existe pas. Rend `null`
 * pour un nom invalide, ou sans société connue. Deux noms qui ne diffèrent que par les accents, la casse ou un pluriel
 * désignent la MÊME catégorie.
 */
export async function categoriePourNom(brut: string, connues?: CategorieConnue[], companyId?: string | null): Promise<CategorieConnue | null> {
  const nom = normaliserNomNature(brut);
  if (!nom) return null;
  const liste = connues ?? (await naturesConnues(companyId));
  const meme = categorieDuMemeNom(nom, liste);
  if (meme) return meme;
  const ligneId = await assurerNaturesMoyensGeneraux(companyId);
  const ligne = ligneId ? await prisma.budgetCategoryLine.findUnique({ where: { id: ligneId }, select: { envelopeId: true } }) : null;
  if (!ligneId || !ligne) return null;
  const creee = await prisma.budgetCategoryLine.create({
    data: { envelopeId: ligne.envelopeId, parentId: ligneId, name: nom, module: GENERAL_MEANS_MODULE, notes: "Créée à la saisie d'une dépense des moyens généraux." },
    select: { id: true, name: true, cle: true },
  });
  const c = { id: creee.id, nom: creee.name, cle: creee.cle };
  liste.push(c);
  return c;
}

/** La société d'un département — celle dont les moyens généraux portent la dépense. */
export async function societeDuDepartement(departmentId: string | null | undefined): Promise<string | null> {
  if (!departmentId) return null;
  return (await prisma.department.findUnique({ where: { id: departmentId }, select: { companyId: true } }))?.companyId ?? null;
}
