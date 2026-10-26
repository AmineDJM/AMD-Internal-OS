import { prisma } from "@/lib/prisma";
import { GENERAL_MEANS_MODULE } from "./budget-targets";
import { NATURES_PAR_DEFAUT, categorieDuMemeNom, normaliserNomNature, type CategorieConnue } from "./natures";

/**
 * LES NATURES DES MOYENS GÉNÉRAUX, CÔTÉ BASE — l'enveloppe qui les porte, ses catégories par défaut, et la création
 * d'une nouvelle catégorie quand l'IA (ou la personne) en nomme une (Direction, 10/2026).
 *
 * Les natures SONT des catégories budgétaires (`BudgetCategoryLine`) : le module Budget les montre, les Finances les
 * renomment ou en ajoutent, et l'écran des moyens généraux les lit comme avant (`generalMeansBudgetTargets`). Rien de
 * parallèle — c'est la seule façon que « Par nature » et le budget disent la même chose.
 *
 * ── QUELLE ENVELOPPE ───────────────────────────────────────────────────────────────────────
 *
 * La plus récente des enveloppes ACTIVES qui couvrent les moyens généraux (la même règle que la liste du formulaire).
 * S'il n'y en a aucune, on en crée une : « Moyens généraux », exercice en cours, montant 0 — les Finances y posent le
 * montant si elles le souhaitent. Les catégories par défaut absentes y sont ajoutées, reconnues par leur CLÉ
 * (`MG_…`) ou, pour une catégorie créée à la main avant elles, par leur nom : rien n'est dupliqué, rien n'est renommé.
 */

/** La garantie ne se rejoue pas à chaque affichage : une fois posée, l'enveloppe ne disparaît pas d'elle-même. */
let garantie: { enveloppeId: string; at: number } | null = null;
const DUREE_GARANTIE_MS = 10 * 60 * 1000;

async function enveloppeDesNatures(): Promise<string> {
  const existante = await prisma.budgetEnvelope.findFirst({
    where: { isActive: true, OR: [{ modules: { has: GENERAL_MEANS_MODULE } }, { module: GENERAL_MEANS_MODULE }] },
    orderBy: [{ periodStart: "desc" }],
    select: { id: true },
  });
  if (existante) return existante.id;
  const annee = new Date().getUTCFullYear();
  const creee = await prisma.budgetEnvelope.create({
    data: {
      name: "Moyens généraux",
      module: GENERAL_MEANS_MODULE,
      modules: [GENERAL_MEANS_MODULE],
      domaine: "GENERAL",
      periodStart: new Date(Date.UTC(annee, 0, 1)),
      periodEnd: new Date(Date.UTC(annee, 11, 31)),
      notes: "Créée automatiquement : les natures des dépenses des moyens généraux (catégories rangées par l'IA).",
    },
    select: { id: true },
  });
  return creee.id;
}

/**
 * GARANTIT l'enveloppe et ses catégories par défaut ; rend l'identifiant de l'enveloppe. Idempotent, sûr à appeler à
 * chaque affichage (mis en mémoire dix minutes par processus).
 */
export async function assurerNaturesMoyensGeneraux(): Promise<string> {
  if (garantie && Date.now() - garantie.at < DUREE_GARANTIE_MS) return garantie.enveloppeId;
  const enveloppeId = await enveloppeDesNatures();
  const presentes = await prisma.budgetCategoryLine.findMany({
    where: { envelopeId: enveloppeId, parentId: null },
    select: { id: true, name: true, cle: true },
  });
  const connues: CategorieConnue[] = presentes.map((c) => ({ id: c.id, nom: c.name, cle: c.cle }));
  const manquantes = NATURES_PAR_DEFAUT.filter((n) => !connues.some((c) => c.cle === n.cle) && !categorieDuMemeNom(n.nom, connues));
  if (manquantes.length > 0) {
    await prisma.budgetCategoryLine.createMany({
      data: manquantes.map((n) => ({ envelopeId: enveloppeId, name: n.nom, cle: n.cle, module: GENERAL_MEANS_MODULE })),
    });
  }
  garantie = { enveloppeId, at: Date.now() };
  return enveloppeId;
}

/** Les catégories où l'on range (toutes les enveloppes des moyens généraux, sous-catégories comprises). */
export async function naturesConnues(): Promise<CategorieConnue[]> {
  const rows = await prisma.budgetCategoryLine.findMany({
    where: { envelope: { isActive: true, OR: [{ modules: { has: GENERAL_MEANS_MODULE } }, { module: GENERAL_MEANS_MODULE }] } },
    select: { id: true, name: true, cle: true },
    orderBy: { name: "asc" },
  });
  return rows.map((c) => ({ id: c.id, nom: c.name, cle: c.cle }));
}

/**
 * La catégorie qui porte ce nom — créée dans l'enveloppe des natures si elle n'existe pas. Rend `null` pour un nom
 * invalide. Deux noms qui ne diffèrent que par les accents, la casse ou un pluriel désignent la MÊME catégorie.
 */
export async function categoriePourNom(brut: string, connues?: CategorieConnue[]): Promise<CategorieConnue | null> {
  const nom = normaliserNomNature(brut);
  if (!nom) return null;
  const liste = connues ?? (await naturesConnues());
  const meme = categorieDuMemeNom(nom, liste);
  if (meme) return meme;
  const enveloppeId = await assurerNaturesMoyensGeneraux();
  const creee = await prisma.budgetCategoryLine.create({
    data: { envelopeId: enveloppeId, name: nom, module: GENERAL_MEANS_MODULE, notes: "Créée à la saisie d'une dépense des moyens généraux." },
    select: { id: true, name: true, cle: true },
  });
  const c = { id: creee.id, nom: creee.name, cle: creee.cle };
  liste.push(c);
  return c;
}
