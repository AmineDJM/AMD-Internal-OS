import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { companyIdForNew } from "@/lib/company";
import { enSerie } from "@/lib/refs";
import { canGovernPoleEnvelope, type SessionUser } from "@/lib/rbac";
import { DOMAINES, bornesAnnee, type DomainePole } from "@/lib/budget/domaines";
import { CATEGORIES_AD_PRO } from "@/lib/budget-marketing/domaine";
import { CATEGORIES_BV } from "@/lib/budget-regulatory/bv";
import { CATEGORIES_OPERATIONS, CLE_MASSE_SALARIALE } from "@/lib/budget-operations/force-de-vente";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ENVELOPPES DES PÔLES — leurs catégories d'office, et l'enveloppe de l'année qui existe d'emblée.
 *
 * « Quand j'ouvre Budget Operations & Sales 2026, une enveloppe doit déjà exister, et commencer par la catégorie masse
 * salariale. Je ne comprends pas pourquoi je dois créer une enveloppe, puis une catégorie » (Direction, 10/2026). Le
 * formulaire « Nouvelle enveloppe » reste pour une enveloppe de plus ; l'enveloppe de l'année, elle, n'est plus un
 * geste à deviner : elle est là, avec ses catégories, et il ne reste qu'à saisir les montants.
 *
 * Module SERVEUR, sans action : les actions du pôle (`budget-pole-actions.ts`) et les pages l'appellent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface CategorieModele { name: string; module?: string | null; cle?: string | null; businessUnitId?: string | null; parentNom?: string }

/** Les catégories créées d'office pour une enveloppe du pôle. Operations : la masse salariale d'abord, une sous-catégorie par BU. */
async function categoriesModele(pole: DomainePole): Promise<CategorieModele[]> {
  if (pole === "MARKETING") return CATEGORIES_AD_PRO.map((c) => ({ name: c.nom, module: c.module }));
  if (pole === "REGULATORY") return CATEGORIES_BV.map((c) => ({ name: c.nom, cle: c.cle }));
  const bus = await prisma.businessUnit.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const mere = CATEGORIES_OPERATIONS[0].nom;
  return [
    ...CATEGORIES_OPERATIONS.map((c) => ({ name: c.nom, cle: c.cle })),
    ...bus.map((b) => ({ name: b.name, cle: CLE_MASSE_SALARIALE, businessUnitId: b.id, parentNom: mere })),
  ];
}

/** COMPLÈTE les catégories d'office d'une enveloppe — idempotent : ce qui existe (même nom ou même clé) n'est pas recréé. */
export async function completerCategoriesDuPole(envelopeId: string, pole: DomainePole): Promise<number> {
  const [existantes, modele] = await Promise.all([
    prisma.budgetCategoryLine.findMany({ where: { envelopeId }, select: { id: true, name: true, cle: true, module: true, businessUnitId: true, parentId: true } }),
    categoriesModele(pole),
  ]);
  let crees = 0;
  const meres = new Map(existantes.filter((c) => c.parentId === null).map((c) => [c.name, c.id]));
  for (const c of modele.filter((m) => !m.parentNom)) {
    const deja = existantes.find((e) => e.parentId === null && ((c.cle && e.cle === c.cle) || (c.module && e.module === c.module) || e.name === c.name));
    if (deja) {
      // Une catégorie du même nom, créée à la main : elle devient la catégorie reconnue (sa clé), sans doublon.
      if (c.cle && !deja.cle) { await prisma.budgetCategoryLine.update({ where: { id: deja.id }, data: { cle: c.cle } }); deja.cle = c.cle; crees += 1; }
      continue;
    }
    const cree = await prisma.budgetCategoryLine.create({ data: { envelopeId, name: c.name, module: c.module ?? null, cle: c.cle ?? null }, select: { id: true } });
    meres.set(c.name, cree.id);
    crees += 1;
  }
  const mereMs = existantes.find((e) => e.parentId === null && e.cle === CLE_MASSE_SALARIALE)?.id ?? meres.get(CATEGORIES_OPERATIONS[0].nom) ?? null;
  for (const c of modele.filter((m) => m.parentNom)) {
    if (!mereMs) break;
    if (existantes.some((e) => e.businessUnitId && e.businessUnitId === c.businessUnitId && e.cle === CLE_MASSE_SALARIALE)) continue;
    await prisma.budgetCategoryLine.create({ data: { envelopeId, name: c.name, cle: CLE_MASSE_SALARIALE, businessUnitId: c.businessUnitId ?? null, parentId: mereMs } });
    crees += 1;
  }
  return crees;
}

/** Le nom de l'enveloppe de l'année d'un pôle (« Operations & Sales 2026 »). */
export const nomEnveloppeAnnuelle = (pole: "OPERATIONS", annee: number): string => (pole === "OPERATIONS" ? `Operations & Sales ${annee}` : `${annee}`);

/**
 * L'ENVELOPPE DE L'ANNÉE EXISTE D'EMBLÉE — appelée par les écrans du pôle avant de lire.
 *
 * Seulement pour qui peut CRÉER une enveloppe du pôle (sinon l'écran dit, comme avant, qu'aucune ne lui est ouverte),
 * et seulement si AUCUNE enveloppe du pôle ne couvre aujourd'hui pour sa société : une enveloppe créée à la main, ou
 * désactivée exprès, n'est jamais doublée. Montant 0 : le montant est une décision, il se saisit. Sérialisée dans le
 * processus : deux onglets ouverts en même temps ne créent pas deux enveloppes.
 */
export async function assurerEnveloppeAnnuelle(pole: "OPERATIONS", user: SessionUser & { id: string }): Promise<string | null> {
  if (!canGovernPoleEnvelope(user, pole, "CREATE")) return null;
  const maintenant = new Date();
  const annee = maintenant.getUTCFullYear();
  const companyId = await companyIdForNew(user.id);
  return enSerie(`enveloppe-annuelle:${pole}:${companyId ?? "groupe"}`, async () => {
    const existe = await prisma.budgetEnvelope.findFirst({
      where: {
        domaine: pole, periodStart: { lte: maintenant }, periodEnd: { gte: maintenant },
        OR: [{ companyId }, { companyId: null }],
      },
      select: { id: true },
    });
    if (existe) return null;
    const { debut, fin } = bornesAnnee(annee);
    const nom = nomEnveloppeAnnuelle(pole, annee);
    const cree = await prisma.budgetEnvelope.create({
      data: { name: nom, domaine: pole, modules: [], periodStart: debut, periodEnd: fin, totalAmount: 0, createdById: user.id, companyId },
      select: { id: true },
    });
    const n = await completerCategoriesDuPole(cree.id, pole);
    await recordAudit({
      actorId: user.id, action: "CREATE", module: DOMAINES[pole].titre, entityId: cree.id,
      summary: `Enveloppe de l'année « ${nom} » ouverte d'office avec ${n} catégorie(s) (masse salariale d'abord) — montants à saisir`,
    }).catch(() => undefined);
    return cree.id;
  });
}
