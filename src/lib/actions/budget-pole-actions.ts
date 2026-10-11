"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { canGovernPoleEnvelope, canManageEnvelope } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { companyIdForNew } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { DOMAINES, bornesAnnee, estDomainePole, poleDe, type DomainePole } from "@/lib/budget/domaines";
import { CATEGORIES_AD_PRO, MODULES_AD_PRO_BUDGET } from "@/lib/budget-marketing/domaine";
import { CATEGORIES_BV, CLE_DE_LA_NATURE, natureDuLibelle, type NatureBv } from "@/lib/budget-regulatory/bv";
import { CATEGORIES_OPERATIONS, CLE_MASSE_SALARIALE } from "@/lib/budget-operations/force-de-vente";
import { refusReallocation } from "@/lib/budget/marketing-vue";

/**
 * LES BUDGETS DES PÔLES — les gestes de chaque pôle sur SES enveloppes (Direction, 08/10).
 *
 * Budget Marketing, Budget Regulatory et Budget Operations & Sales partagent les mêmes gestes : créer, régler (nom,
 * montant, période, BU / produit, active) et retirer une enveloppe de leur `domaine`, gardés par le module du pôle
 * (`canGovernPoleEnvelope`). Le CONTENU (catégories, lignes, imputation) passe par les actions de Budgets
 * (`budget-envelope-actions.ts`), qui reconnaissent le droit du pôle sur son enveloppe (`canManageEnvelope`). Les listes
 * d'accès ne sont jamais touchées ici : elles restent au Super Admin, dans Budgets.
 *
 * S'y ajoutent les gestes propres à un pôle : compléter les catégories reconnues (BV 25 % / 75 % ; masse salariale par
 * BU), saisir un BV payé hors circuit, ranger un BV demandé ou payé dans l'enveloppe.
 */

const refus = (pole: DomainePole): ActionResult => ({ ok: false, error: `Réservé à ${DOMAINES[pole].gestionnaire} (${DOMAINES[pole].titre}).` });

function revalider(pole: DomainePole | null) {
  if (pole) revalidatePath(DOMAINES[pole].chemin);
  revalidatePath("/budgets");
}

/** Le pôle demandé par le formulaire — un champ absent ou inconnu n'ouvre rien. */
function poleDuFormulaire(formData: FormData): DomainePole | null {
  const d = fdStr(formData, "domaine");
  return estDomainePole(d) ? d : null;
}

/** Les catégories créées d'office pour une enveloppe neuve du pôle (cochées dans le formulaire). */
async function categoriesModele(pole: DomainePole): Promise<{ name: string; module?: string | null; cle?: string | null; businessUnitId?: string | null; parentNom?: string }[]> {
  if (pole === "MARKETING") return CATEGORIES_AD_PRO.map((c) => ({ name: c.nom, module: c.module }));
  if (pole === "REGULATORY") return CATEGORIES_BV.map((c) => ({ name: c.nom, cle: c.cle }));
  const bus = await prisma.businessUnit.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const mere = CATEGORIES_OPERATIONS[0].nom;
  return [
    ...CATEGORIES_OPERATIONS.map((c) => ({ name: c.nom, cle: c.cle })),
    ...bus.map((b) => ({ name: b.name, cle: CLE_MASSE_SALARIALE, businessUnitId: b.id, parentNom: mere })),
  ];
}

export async function createPoleEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pole = poleDuFormulaire(formData);
  if (!pole) return { ok: false, error: "Pôle inconnu." };
  if (!canGovernPoleEnvelope(user, pole, "CREATE")) return refus(pole);
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de l'enveloppe est obligatoire." };
  const montant = fdNum(formData, "totalAmount") ?? 0;
  if (montant < 0) return { ok: false, error: "Le montant ne peut pas être négatif." };
  const { debut, fin } = bornesAnnee(fdNum(formData, "annee"));
  // Marketing : « Catégories Ad & Pro » ; Regulatory et Operations : « Catégories d'office ».
  const modele = pole === "MARKETING" ? fdCase(formData, "adPro") === true : fdCase(formData, "categoriesParDefaut") === true;
  const adPro = pole === "MARKETING" && modele;

  const created = await prisma.budgetEnvelope.create({
    data: {
      name,
      domaine: pole,
      // Une enveloppe Ad & Pro couvre sa famille. Les BV, eux, ne couvrent PAS le module Regulatory : l'attribution
      // automatique au règlement rangerait un BV 75 % dans la première catégorie venue (le 25 %). Un BV se range par
      // sa nature — à la demande (`requestBV`) ou depuis l'écran « BV par dossier ».
      modules: adPro ? [...MODULES_AD_PRO_BUDGET] : [],
      module: adPro ? MODULES_AD_PRO_BUDGET[0] : null,
      businessUnitId: fdStr(formData, "businessUnitId"),
      productId: fdStr(formData, "productId"),
      periodStart: debut,
      periodEnd: fin,
      totalAmount: montant,
      notes: fdStr(formData, "notes"),
      createdById: user.id,
      companyId: await companyIdForNew(user.id),
    },
    select: { id: true },
  });
  if (modele) await completer(created.id, pole);
  await recordAudit({ actorId: user.id, action: "CREATE", module: DOMAINES[pole].titre, entityId: created.id, summary: `Enveloppe ${DOMAINES[pole].court} « ${name} »` });
  revalider(pole);
  return { ok: true, id: created.id };
}

export async function updatePoleEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  const env = await prisma.budgetEnvelope.findUnique({ where: { id }, select: { domaine: true } });
  if (!env) return { ok: false, error: "Enveloppe introuvable." };
  const pole = poleDe(env);
  if (!pole || !canGovernPoleEnvelope(user, pole, "UPDATE", env)) return pole ? refus(pole) : { ok: false, error: "Enveloppe générale : elle se règle dans Budgets." };
  const montant = fdNum(formData, "totalAmount");
  if (montant != null && montant < 0) return { ok: false, error: "Le montant ne peut pas être négatif." };
  const debut = fdDate(formData, "periodStart");
  const fin = fdDate(formData, "periodEnd");
  if (debut && fin && fin < debut) return { ok: false, error: "La fin de période précède son début." };
  const actif = fdCase(formData, "isActive");

  await prisma.budgetEnvelope.update({
    where: { id },
    data: {
      name,
      businessUnitId: fdStr(formData, "businessUnitId"),
      productId: fdStr(formData, "productId"),
      notes: fdStr(formData, "notes"),
      ...(montant != null ? { totalAmount: montant } : {}),
      ...(debut ? { periodStart: debut } : {}),
      ...(fin ? { periodEnd: fin } : {}),
      ...(actif !== undefined ? { isActive: actif } : {}),
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: DOMAINES[pole].titre, entityId: id, summary: `Enveloppe ${DOMAINES[pole].court} « ${name} » modifiée` });
  revalider(pole);
  return { ok: true };
}

export async function deletePoleEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const env = await prisma.budgetEnvelope.findUnique({ where: { id }, select: { name: true, domaine: true } });
  if (!env) return { ok: false, error: "Enveloppe introuvable." };
  const pole = poleDe(env);
  if (!pole || !canGovernPoleEnvelope(user, pole, "DELETE", env)) return pole ? refus(pole) : { ok: false, error: "Enveloppe générale : elle se retire dans Budgets." };
  // Les dépenses imputées repassent en « à imputer » (clé étrangère SetNull) ; les catégories partent avec l'enveloppe.
  await prisma.budgetEnvelope.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: DOMAINES[pole].titre, entityId: id, summary: `Enveloppe ${DOMAINES[pole].court} « ${env.name} » supprimée` });
  revalider(pole);
  return { ok: true };
}

/**
 * Ajoute à l'enveloppe les catégories d'office qui lui MANQUENT — reconnues par leur clé (BV 25 % / 75 %, masse
 * salariale) ou, pour une sous-catégorie de masse salariale, par sa BU. Rien n'est renommé ni retiré : relancer ne
 * crée pas de doublon.
 */
async function completer(envelopeId: string, pole: DomainePole): Promise<number> {
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

/** L'enveloppe visée, si elle est bien du pôle — le droit de la gérer (`canManageEnvelope`) se vérifie dans chaque geste. */
async function enveloppeDuPole(envelopeId: string | null, pole: DomainePole) {
  if (!envelopeId) return null;
  const env = await prisma.budgetEnvelope.findUnique({
    where: { id: envelopeId },
    select: { id: true, name: true, domaine: true, periodStart: true, periodEnd: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true },
  });
  return env && poleDe(env) === pole ? env : null;
}

/** COMPLÉTER LES CATÉGORIES D'OFFICE d'une enveloppe Regulatory (BV 25 % / 75 %) ou Operations (masse salariale, par BU). */
export async function completerCategoriesPole(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pole = poleDuFormulaire(formData);
  if (pole !== "REGULATORY" && pole !== "OPERATIONS") return { ok: false, error: "Pôle inconnu." };
  const env = await enveloppeDuPole(fdStr(formData, "envelopeId"), pole);
  if (!env || !canManageEnvelope(user, env)) return refus(pole);
  const crees = await completer(env.id, pole);
  if (crees > 0) await recordAudit({ actorId: user.id, action: "UPDATE", module: DOMAINES[pole].titre, entityId: env.id, summary: `Enveloppe « ${env.name} » : ${crees} catégorie(s) ajoutée(s)` });
  revalider(pole);
  return { ok: true, message: crees > 0 ? `${crees} catégorie(s) ajoutée(s).` : "Rien à ajouter : les catégories sont déjà là." };
}

/**
 * RÉALLOUER (Budget Marketing, Direction 10/2026) — déplacer un montant d'une catégorie de tête à une autre de la MÊME
 * enveloppe : ce que l'une cède, l'autre le reçoit, l'enveloppe ne bouge pas. Le motif est obligatoire et reste dans
 * l'historique du budget (journal d'audit de l'enveloppe, champ « reallocation »). Gardé par le droit de gérer le contenu
 * de l'enveloppe (`canManageEnvelope` : Super Admin, délégués, « Modifier » du budget du pôle — la Direction Marketing).
 * La cession est CONDITIONNELLE : lue et écrite dans la même instruction, deux réallocations simultanées ne font jamais
 * passer une allocation sous zéro.
 */
export async function reallouerCategorie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const sourceId = fdStr(formData, "sourceId");
  const cibleId = fdStr(formData, "cibleId");
  const montant = fdNum(formData, "montant");
  const motif = fdStr(formData, "motif")?.trim() ?? null;
  const [source, cible] = await Promise.all([
    sourceId ? prisma.budgetCategoryLine.findUnique({ where: { id: sourceId }, select: { id: true, name: true, envelopeId: true, parentId: true, allocated: true } }) : null,
    cibleId ? prisma.budgetCategoryLine.findUnique({ where: { id: cibleId }, select: { id: true, name: true, envelopeId: true, parentId: true } }) : null,
  ]);
  const refusSaisie = refusReallocation({
    sourceId, cibleId, montant, motif,
    source: source ? { envelopeId: source.envelopeId, parentId: source.parentId, alloue: Number(source.allocated) } : null,
    cible: cible ? { envelopeId: cible.envelopeId, parentId: cible.parentId } : null,
  });
  if (refusSaisie || !source || !cible || montant == null || !motif) return { ok: false, error: refusSaisie ?? "Saisie incomplète." };
  const env = await prisma.budgetEnvelope.findUnique({
    where: { id: source.envelopeId },
    select: { id: true, name: true, domaine: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true },
  });
  const pole = env ? poleDe(env) : null;
  if (!env || !pole) return { ok: false, error: "Enveloppe introuvable." };
  if (!canManageEnvelope(user, env)) return refus(pole);

  const fait = await prisma.$transaction(async (tx) => {
    const cede = await tx.budgetCategoryLine.updateMany({ where: { id: source.id, allocated: { gte: montant } }, data: { allocated: { decrement: montant } } });
    if (cede.count === 0) return false;
    await tx.budgetCategoryLine.update({ where: { id: cible.id }, data: { allocated: { increment: montant } } });
    return true;
  });
  if (!fait) return { ok: false, error: "L'allocation de la catégorie qui cède a changé entre-temps : rechargez et recommencez." };
  const somme = `${Math.round(montant).toLocaleString("fr-FR")} DZD`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: DOMAINES[pole].titre, entityType: "BUDGET", entityId: env.id, field: "reallocation",
    oldValue: `${source.name} → ${cible.name}`, newValue: String(montant),
    summary: `Réallocation de ${somme} : « ${source.name} » → « ${cible.name} » — motif : ${motif.slice(0, 500)}`,
  });
  revalider(pole);
  return { ok: true, message: `${somme} réalloués à « ${cible.name} ».` };
}

function natureDuFormulaire(formData: FormData): NatureBv | null {
  const n = fdStr(formData, "nature");
  return n === "25" || n === "75" ? n : null;
}

async function categorieBv(envelopeId: string, nature: NatureBv): Promise<string | null> {
  const c = await prisma.budgetCategoryLine.findFirst({ where: { envelopeId, cle: CLE_DE_LA_NATURE[nature], parentId: null }, select: { id: true } });
  return c?.id ?? null;
}

/**
 * SAISIR UN BV PAYÉ HORS CIRCUIT — un bon de versement réglé sans passer par une demande de BV (historique, paiement
 * direct). Une ligne budgétaire de la catégorie BV 25 % ou 75 %, liée au dossier ; « payé le » est sa date.
 */
export async function saisirBvManuel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const env = await enveloppeDuPole(fdStr(formData, "envelopeId"), "REGULATORY");
  if (!env || !canManageEnvelope(user, env)) return refus("REGULATORY");
  const nature = natureDuFormulaire(formData);
  if (!nature) return { ok: false, error: "Choisissez le BV : 25 % ou 75 %." };
  const productId = fdStr(formData, "productId");
  if (!productId) return { ok: false, error: "Choisissez le dossier." };
  const dossier = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { id: true, reference: true, dci: true } });
  if (!dossier) return { ok: false, error: "Dossier introuvable." };
  const montant = fdNum(formData, "amount");
  if (montant == null || montant <= 0) return { ok: false, error: "Montant invalide." };
  const payeLe = fdDate(formData, "date") ?? new Date();
  const categoryId = await categorieBv(env.id, nature);
  if (!categoryId) return { ok: false, error: `L'enveloppe n'a pas de catégorie « BV ${nature} % » : ajoutez les catégories d'office.` };
  const reference = fdStr(formData, "reference") ?? `BV ${nature} % — ${dossier.reference} ${dossier.dci}`;

  await prisma.budgetExpenseLine.create({ data: { categoryId, reference, amount: montant, date: payeLe, notes: fdStr(formData, "notes"), regulatoryProductId: dossier.id, createdById: user.id } });
  await recordAudit({ actorId: user.id, action: "CREATE", module: DOMAINES.REGULATORY.titre, entityType: "REGULATORY_PRODUCT", entityId: dossier.id, summary: `BV ${nature} % saisi (${montant.toLocaleString("fr-FR")} DZD) dans « ${env.name} »` });
  revalider("REGULATORY");
  return { ok: true };
}

/**
 * RANGER UN BV DANS L'ENVELOPPE — l'ordre d'un BV DEMANDÉ y est rangé (il s'y imputera à son règlement) ; l'écriture
 * d'un BV PAYÉ y est ré-imputée. La catégorie suit la nature lue sur l'ordre (25 % ou 75 %), jamais un choix libre.
 */
export async function imputerBv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const env = await enveloppeDuPole(fdStr(formData, "envelopeId"), "REGULATORY");
  if (!env || !canManageEnvelope(user, env)) return refus("REGULATORY");
  const orderId = fdStr(formData, "orderId");
  if (!orderId) return { ok: false, error: "Ordre manquant." };
  const ordre = await prisma.expenseOrder.findUnique({ where: { id: orderId }, select: { id: true, reference: true, label: true, status: true, sourceType: true, transactionId: true } });
  if (!ordre || ordre.sourceType !== "REGULATORY_PRODUCT") return { ok: false, error: "Ce n'est pas un BV de dossier." };
  const nature = natureDuLibelle(ordre.label);
  if (!nature) return { ok: false, error: "Ce BV ne dit pas sa part (25 % ou 75 %) : rangez-le depuis l'onglet Dépenses." };
  const categoryId = await categorieBv(env.id, nature);
  if (!categoryId) return { ok: false, error: `L'enveloppe n'a pas de catégorie « BV ${nature} % » : ajoutez les catégories d'office.` };

  if (ordre.status === "PAID") {
    if (!ordre.transactionId) return { ok: false, error: "Ce BV payé n'a pas d'écriture à ranger." };
    await prisma.financeTransaction.update({ where: { id: ordre.transactionId }, data: { budgetCategoryId: categoryId } });
  } else if (ordre.status === "PENDING" || ordre.status === "REVISION_REQUESTED") {
    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { budgetCategoryId: categoryId } });
  } else {
    return { ok: false, error: "Cet ordre est annulé." };
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: DOMAINES.REGULATORY.titre, entityType: "EXPENSE_ORDER", entityId: ordre.id, summary: `${ordre.reference} rangé dans « ${env.name} » (BV ${nature} %)` });
  revalider("REGULATORY");
  return { ok: true };
}
