"use server";

import { Prisma, type UserRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, anyRoleFilter } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { monthLabel, canEditRep } from "@/lib/sfe";
import { fdStr, fdCase, type ActionResult } from "@/lib/actions/types";
import { lireCouverture } from "@/lib/annuaires/services";
import { CHEMINS_SPECIALITES } from "@/lib/annuaires/specialites";
import { canAttachBuDepartment, buDepartmentName, buDepartmentCode } from "@/lib/sfe/bu-department";
import { GRANULARITES, GRANULARITE_LABELS, JOURS_AVANT_ECHEANCE_MAX, estGranularite } from "@/lib/sfe/tournee";
import { ROLES_QUI_TRANCHENT } from "@/lib/personnes/referents-gamme";
import { DOSSIERS_PROPOSABLES_BU } from "@/lib/sfe/produits-bu";
import { ensureProduitDuDossier } from "@/lib/products/canonique";
import { enSerie } from "@/lib/refs";
import { specialitesDemandees, ecrireSpecialitesBu, resumeSpecialitesBu } from "@/lib/sfe/specialites-bu";
import { estBuHospitaliere, nomDuTerritoire } from "@/lib/sfe/territoire-kam";
import { canonicalWilaya } from "@/lib/medical/wilaya";
import { reposerWilayaCode } from "@/lib/lieux/rattachement-prisma";

const MODULE = "SALES_PLANNING" as const;
/**
 * LE MONTAGE (BU, KAM, produits, secteurs, paramètres) est le module « Business Units » (Direction, 08/10) : ses gestes
 * se gardent par CE droit. Les prévisions et les affectations restent à la Force de vente (`MODULE`).
 */
const BU_MODULE = "BUSINESS_UNITS" as const;
const PATH = "/planning";
/** L'écran où se monte une force de vente : une BU, son superviseur, ses KAM, ses produits. */
const BU_PATH = "/business-units";
/** Les paramètres SFE et la maille des plans de tournée — l'onglet « Paramètres » du module Business Units. */
const PARAMETRES_PATH = "/business-units/parametres";

function num(fd: FormData, key: string): number | null {
  const v = fd.get(key);
  if (v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Canal produit (Ville / Hôpital / les deux) — défaut BOTH si non renseigné. */
function parseChannel(v: string | null): "RETAIL" | "HOSPITAL" | "BOTH" {
  return v === "RETAIL" || v === "HOSPITAL" || v === "BOTH" ? v : "BOTH";
}

/** Récupère (ou crée) le cycle mensuel donné. */
export async function ensureCycle(year: number, month: number): Promise<{ id: string } | null> {
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  const existing = await prisma.promoCycle.findUnique({ where: { year_month: { year, month } }, select: { id: true } });
  if (existing) return existing;
  return prisma.promoCycle.create({ data: { year, month, label: monthLabel(year, month) }, select: { id: true } });
}

// ─────────────────────────── Business Units (franchises) ───────────────────────────
export async function createBusinessUnit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de la BU est obligatoire." };
  // LES SPÉCIALITÉS se vérifient AVANT d'écrire quoi que ce soit (§118.183) : une BU créée puis refusée
  // sur ses spécialités resterait en base, à moitié montée, sans que personne l'ait voulue.
  const voulues = await specialitesDemandees(formData.getAll("specialtyIds").map(String), fdStr(formData, "principaleId"));
  if (!voulues.ok) return { ok: false, error: voulues.error };
  // LE DÉPARTEMENT de la BU dans l'organigramme — demandé dès la création (il se règle aussi à l'étape d'identité).
  const departmentId = fdStr(formData, "departmentId") || null;
  if (departmentId && !(await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } }))) {
    return { ok: false, error: "Ce département n'existe plus — rechargez l'écran." };
  }
  const created = await prisma.$transaction(async (tx) => {
    const bu = await tx.businessUnit.create({
    data: {
      name,
      departmentId,
      code: fdStr(formData, "code") ?? undefined,
      color: fdStr(formData, "color") ?? undefined,
      companyId: fdStr(formData, "companyId") || null,
      headId: fdStr(formData, "headId") || null,
      // LES DEUX RÉPONSES QU'ON DONNE EN CRÉANT UNE BU : qui la supervise, et sur quel terrain
      // elle opère. Les demander plus tard, c'est les laisser vides.
      supervisorId: fdStr(formData, "supervisorId") || null,
      channel: parseChannel(fdStr(formData, "channel")),
    },
    select: { id: true },
    });
    const ecrit = await ecrireSpecialitesBu(tx, user.id, bu.id, voulues.ids, voulues.principaleId);
    return { id: bu.id, ecrit };
  });
  const specialites = await resumeSpecialitesBu(created.ecrit, voulues.principaleId);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: created.id,
    summary: `BU « ${name} »${specialites ? ` — spécialités : ${specialites}` : ""}`,
  });
  revalidatePath(BU_PATH, "layout");
  if (voulues.ids.length) for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  return { ok: true, id: created.id };
}

export async function updateBusinessUnit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "BU introuvable." };
  // CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c, §118.183) : l'écran envoie tout, mais
  // une op ou un formulaire partiel n'envoie que ce qui change — et l'ancienne écriture EFFAÇAIT le code,
  // la couleur, l'entité, le chef et le superviseur à chaque fois. Les clés se lisent EN LITTÉRAL, pour
  // que la fiche de l'action les dise. Un nom porté VIDE ne s'écrit pas : une BU garde toujours un nom.
  const nom = fdStr(formData, "name");
  // LE DÉPARTEMENT DE LA BU (l'organigramme, seule source — Direction 10/2026) : choisi à l'étape d'identité.
  const departmentId = formData.has("departmentId") ? fdStr(formData, "departmentId") || null : undefined;
  if (departmentId && !(await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } }))) {
    return { ok: false, error: "Ce département n'existe plus — rechargez l'écran." };
  }
  await prisma.businessUnit.update({
    where: { id },
    data: {
      ...(nom ? { name: nom } : {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
      ...(formData.has("code") ? { code: fdStr(formData, "code") } : {}),
      ...(formData.has("color") ? { color: fdStr(formData, "color") } : {}),
      ...(formData.has("companyId") ? { companyId: fdStr(formData, "companyId") || null } : {}),
      ...(formData.has("headId") ? { headId: fdStr(formData, "headId") || null } : {}),
      ...(formData.has("supervisorId") ? { supervisorId: fdStr(formData, "supervisorId") || null } : {}),
      ...(formData.has("channel") ? { channel: parseChannel(fdStr(formData, "channel")) } : {}),
      // ABSENT = inchangé ; « on » / « off » tranchent (§118.172). L'écran n'envoyait QUE « on » :
      // décocher « Active » ne faisait rien, et une gamme ne se désactivait jamais.
      isActive: fdCase(formData, "isActive"),
    },
  });
  // L'HISTOIRE D'UNE BU (§118.181) : sa modification n'était pas auditée — un superviseur changé,
  // un canal réglé, une gamme désactivée ne laissaient aucune trace.
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: id, summary: "BU modifiée" });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

/**
 * LES SPÉCIALITÉS QU'UNE BU VISE — l'ensemble complet, remplacé d'un geste (§118.183).
 *
 * La garde est celle de l'identité de la BU : changer ce qu'elle vise, c'est la modifier. Le directeur
 * des opérations la règle dès que la console lui ouvre la Force de vente en écriture — c'est une
 * CONFIGURATION de rôle, pas une règle de ce code.
 *
 * En série par BU : deux enregistrements simultanés de la même BU se succèdent au lieu de se croiser —
 * croisés, l'index partiel « une principale par BU » refuserait le second en erreur brute.
 */
export async function enregistrerSpecialitesBu(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId");
  if (!businessUnitId) return { ok: false, error: "BU introuvable." };
  const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { id: true, name: true } });
  if (!bu) return { ok: false, error: "Cette BU n'existe plus — rechargez l'écran." };
  const voulues = await specialitesDemandees(formData.getAll("specialtyIds").map(String), fdStr(formData, "principaleId"));
  if (!voulues.ok) return { ok: false, error: voulues.error };
  const ecrit = await enSerie(`bu-specialites:${bu.id}`, () =>
    prisma.$transaction((tx) => ecrireSpecialitesBu(tx, user.id, bu.id, voulues.ids, voulues.principaleId)));
  const resume = await resumeSpecialitesBu(ecrit, voulues.principaleId);
  if (resume) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: bu.id,
      summary: `Spécialités de la BU « ${bu.name} » — ${resume}`,
    });
  }
  revalidatePath(BU_PATH, "layout");
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  return { ok: true, message: resume ? undefined : "Rien n'a changé." };
}

/**
 * OUVRIR LE BUDGET D'UNE GAMME — en lui donnant son sous-département.
 *
 * ── POURQUOI UN DÉPARTEMENT ─────────────────────────────────────────────────────────────────
 *
 * Une BU a un budget Ad&Pro et une masse salariale. Ce sont exactement les deux choses qu'un
 * DÉPARTEMENT porte déjà, avec ses enveloppes, ses dépenses, ses demandes de budget, sa caisse
 * d'avance, ses salariés, ses droits et ses écrans. Lui donner ses propres colonnes aurait créé
 * un second mécanisme à côté de celui qui marche — et deux réponses à « combien la gamme a-t-elle
 * dépensé ? » (§17 : pas de second registre).
 *
 * ── UN GESTE EXPLICITE, PAS UN EFFET DE BORD DE LA CRÉATION ─────────────────────────────────
 *
 * Créer le département automatiquement à chaque nouvelle BU remplirait l'arbre de départements
 * vides pour des gammes qu'on essaie, qu'on renomme et qu'on supprime la semaine suivante. On
 * ouvre le budget quand on décide qu'il y en a un.
 *
 * Le PARENT est la Direction commerciale : une gamme se range SOUS elle, pas à côté des Finances.
 * S'il n'existe pas, le refus le DIT et nomme l'écran qui le crée.
 */
export async function openBusinessUnitBudget(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Business Unit introuvable." };
  const bu = await prisma.businessUnit.findUnique({
    where: { id },
    select: { id: true, name: true, code: true, companyId: true, departmentId: true },
  });
  if (!bu) return { ok: false, error: "Business Unit introuvable." };

  // LE PARENT : la Direction commerciale de la MÊME entité quand la BU en porte une — une gamme
  // d'Adventum ne se range pas sous la direction commerciale de Pharmagène.
  const parent = await prisma.department.findFirst({
    where: {
      ...(bu.companyId ? { companyId: bu.companyId } : {}),
      OR: [
        { name: { contains: "commercial", mode: "insensitive" } },
        { code: { contains: "COMMERCIAL", mode: "insensitive" } },
      ],
      // On ne se range pas sous une BU : c'est la Direction commerciale qu'on cherche, pas une
      // gamme sœur — sans ce filtre, l'arbre s'emboîterait sur lui-même.
      businessUnits: { none: {} },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const verdict = canAttachBuDepartment({
    businessUnitName: bu.name,
    parentDepartmentId: parent?.id ?? null,
    alreadyAttached: Boolean(bu.departmentId),
  });
  if (!verdict.ok) return { ok: false, error: verdict.reason ?? "Rattachement impossible." };

  const dep = await prisma.department.create({
    data: {
      name: buDepartmentName(bu.name),
      code: buDepartmentCode(bu),
      companyId: bu.companyId,
      parentId: parent!.id,
      description: `Sous-département de la Direction commerciale — budget Ad&Pro et masse salariale de la Business Unit « ${bu.name} ».`,
    },
    select: { id: true },
  });
  await prisma.businessUnit.update({ where: { id }, data: { departmentId: dep.id } });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: bu.id,
    summary: `Budget ouvert pour la BU « ${bu.name} » — sous-département ${buDepartmentName(bu.name)}`,
  });
  revalidatePath(BU_PATH, "layout");
  revalidatePath("/budgets");
  return { ok: true, id: dep.id, message: `Budget ouvert. La gamme « ${bu.name} » a désormais son enveloppe et sa masse salariale dans Budgets.` };
}

export async function deleteBusinessUnit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "BU introuvable." };
  const bu = await prisma.businessUnit.findUnique({
    where: { id },
    select: { name: true, _count: { select: { products: true, reps: true } } },
  });
  if (!bu) return { ok: false, error: "BU introuvable." };
  // ON REFUSE PLUTÔT QUE DE DÉTACHER EN SILENCE. Supprimer une BU qui porte encore des KAM et
  // des produits les laisserait orphelins — sans superviseur, sans canal, invisibles au cockpit,
  // et sans que personne ait vu passer la perte.
  if (bu._count.reps > 0 || bu._count.products > 0) {
    const quoi = [
      bu._count.reps > 0 ? `${bu._count.reps} KAM` : null,
      bu._count.products > 0 ? `${bu._count.products} produit(s)` : null,
    ].filter(Boolean).join(" et ");
    return { ok: false, error: `La BU « ${bu.name} » porte encore ${quoi}. Déplacez-les d'abord, ou désactivez la BU.` };
  }
  await prisma.businessUnit.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: id, summary: `BU « ${bu.name} » supprimée` });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

// ─────────────────────────── Produits promus ───────────────────────────
export async function createPromoProduct(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId") || null;

  // LE PRODUIT PROMU VIENT DU DOSSIER RÉGLEMENTAIRE. Le saisir au clavier créait un second
  // référentiel de produits, qui divergeait du premier au premier changement de nom — et rendait
  // impossible de remonter du terrain au dossier. On reprend donc le nom et la référence du
  // dossier ; le nom reste modifiable ensuite (une marque commerciale n'est pas une DCI).
  const regulatoryProductId = fdStr(formData, "regulatoryProductId");
  let name = fdStr(formData, "name");
  let code = fdStr(formData, "code");
  // LE PRODUIT CANONIQUE DU DOSSIER (§118.178) : c'est lui qu'une visite rapporte. Sans lui, le
  // produit ajouté à la BU ne pouvait figurer dans AUCUN rapport — refusé à chaque visite.
  let productId: string | null = null;
  if (regulatoryProductId) {
    // La clause de la LISTE de l'écran : un dossier du pipeline, deviné, n'entre pas au catalogue.
    const dossier = await prisma.regulatoryProduct.findFirst({
      where: { AND: [{ id: regulatoryProductId }, DOSSIERS_PROPOSABLES_BU] },
      select: { reference: true, dci: true, brandName: true, productId: true },
    });
    if (!dossier) return { ok: false, error: "Ce dossier Regulatory n'existe pas, ou n'est pas encore ouvert au catalogue promotionnel." };
    name = name || dossier.brandName || dossier.dci;
    code = code || dossier.reference;
    productId = dossier.productId;
    if (!productId) {
      // Produit = dossier : un dossier sans produit (d'avant ce lot) reçoit le sien ici.
      const lien = await ensureProduitDuDossier(regulatoryProductId, { acteurId: user.id }).catch(() => null);
      productId = lien && "produitId" in lien ? lien.produitId : null;
    }
  }
  if (!name) return { ok: false, error: "Choisissez un dossier Regulatory, ou donnez un nom de produit." };

  // LE CANAL SUIT LA BU quand le formulaire ne le dit pas : c'est la franchise qui décide du
  // terrain, et redemander la même réponse à chaque produit est le genre de saisie qu'on ne fait
  // qu'une fois — mal.
  let channel = parseChannel(fdStr(formData, "channel"));
  if (!formData.has("channel") && businessUnitId) {
    const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { channel: true } });
    if (bu) channel = bu.channel;
  }

  await prisma.promoProduct.create({
    data: {
      name, code: code ?? undefined, channel, businessUnitId,
      managerId: fdStr(formData, "managerId") || null,
      regulatoryProductId: regulatoryProductId || null,
      productId,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Force de vente", summary: `Produit « ${name} »${regulatoryProductId ? " (depuis son dossier Regulatory)" : ""}` });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

export async function updatePromoProduct(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Produit introuvable." };
  // CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c, §118.178). « Rattacher un produit
  // existant » n'envoie que l'identifiant et la BU : l'ancienne écriture effaçait au passage le
  // code, le référent Direction Marketing, et remettait le canal à « Ville + Hôpital ». Chaque clé
  // se lit en littéral — passée par une variable, l'action deviendrait illisible à la dérivation
  // des contrats.
  await prisma.promoProduct.update({
    where: { id },
    data: {
      name: fdStr(formData, "name") ?? undefined,
      ...(formData.has("code") ? { code: fdStr(formData, "code") } : {}),
      ...(formData.has("channel") ? { channel: parseChannel(fdStr(formData, "channel")) } : {}),
      ...(formData.has("businessUnitId") ? { businessUnitId: fdStr(formData, "businessUnitId") || null } : {}),
      ...(formData.has("managerId") ? { managerId: fdStr(formData, "managerId") || null } : {}),
      // ABSENT = inchangé ; « on » / « off » tranchent (§118.172). L'écran n'envoyait QUE « on » :
      // décocher « Actif » ne faisait rien, et un produit ne se désactivait jamais.
      isActive: fdCase(formData, "isActive"),
    },
  });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

export async function deletePromoProduct(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Produit introuvable." };
  await prisma.promoProduct.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Force de vente", summary: "Produit supprimé" });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

// ─────────────────────────── Prévision par produit ───────────────────────────
export async function saveForecast(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const cycleId = fdStr(formData, "cycleId");
  const productId = fdStr(formData, "productId");
  if (!cycleId || !productId) return { ok: false, error: "Paramètres manquants." };
  const data = {
    targetFte: num(formData, "targetFte") ?? 0,
    coverageTargetPct: num(formData, "coverageTargetPct"),
    plannedVisits: num(formData, "plannedVisits"),
    budget: num(formData, "budget"),
    note: fdStr(formData, "note"),
    updatedById: user.id,
  };
  await prisma.productForecast.upsert({
    where: { cycleId_productId: { cycleId, productId } },
    create: { cycleId, productId, ...data },
    update: data,
  });
  revalidatePath(PATH);
  return { ok: true };
}

// ─────────────────────────── Paramètres SFE (100% configurables) ───────────────────────────
export async function saveSfeSettings(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const positionWeights: Record<string, number> = {
    "1": num(formData, "p1") ?? 1, "2": num(formData, "p2") ?? 0.5, "3": num(formData, "p3") ?? 0.25,
  };
  const capacity = {
    daysPerMonth: num(formData, "daysPerMonth") ?? 20,
    visitsPerDay: num(formData, "visitsPerDay") ?? 7,
    fieldPct: num(formData, "fieldPct") ?? 80,
  };
  const frequencyByTier: Record<string, number> = {
    VERY_HIGH: num(formData, "freq_VERY_HIGH") ?? 3,
    HIGH: num(formData, "freq_HIGH") ?? 2,
    MEDIUM: num(formData, "freq_MEDIUM") ?? 1,
    LOW: num(formData, "freq_LOW") ?? 1,
    VERY_LOW: num(formData, "freq_VERY_LOW") ?? 0,
  };
  await prisma.sfeSettings.upsert({
    where: { id: "global" },
    create: { id: "global", positionWeights, capacity, frequencyByTier, updatedById: user.id },
    update: { positionWeights, capacity, frequencyByTier, updatedById: user.id },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Force de vente", summary: "Paramètres SFE mis à jour" });
  revalidatePath(PARAMETRES_PATH);
  return { ok: true };
}

// ─────────────────────────── Planification de tournée (Super Admin) ───────────────────────────
/**
 * LA MAILLE ET LE DÉLAI DE LA PLANIFICATION DE TOURNÉE — réservés au Super Admin.
 *
 * La demande le dit en ces termes : « de base c'est mensuel, mais un super admin peut choisir
 * trimestrielle, semestrielle ou hebdomadaire ». Le réglage était LU — par l'action qui ouvre un
 * plan, par l'écran du KAM qui annonçait « réglée par le Super Admin » — et ÉCRIT NULLE PART :
 * `saveSfeSettings` ne touche pas `tourPlanning`, et aucun formulaire ne le portait. Une promesse
 * d'écran (§118.45), lue par tout le monde et tenue par personne.
 *
 * Une action À PART de `saveSfeSettings`, parce que les deux n'ont pas la même porte : les
 * paramètres SFE sont à qui a le module en écriture (la Direction comprise) ; la maille est au
 * seul Super Admin, et la fondre dans l'autre l'aurait ouverte à la Direction en silence.
 *
 * L'upsert ne touche QUE `tourPlanning` : poids, capacité et fréquences restent ce que
 * `saveSfeSettings` en a fait, et réciproquement — deux actions sur une même ligne, chacune sur
 * ses colonnes, aucune n'efface l'autre.
 */
export async function saveTourPlanningSettings(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") {
    return { ok: false, error: "La maille de planification est réservée au Super Admin — demandez-lui de la régler (Business Units › Paramètres)." };
  }
  const granularity = fdStr(formData, "granularity") ?? "";
  if (!estGranularite(granularity)) {
    return {
      ok: false,
      error: `Maille inconnue « ${granularity} » — valeurs admises : ${GRANULARITES.map((g) => `${g} (${GRANULARITE_LABELS[g].toLowerCase()})`).join(", ")}.`,
    };
  }
  const jours = num(formData, "submissionLeadDays");
  if (jours === null || !Number.isInteger(jours) || jours < 0 || jours > JOURS_AVANT_ECHEANCE_MAX) {
    // LE REFUS NOMME LA BORNE (§118.30) ; on ne tronque pas en silence — écrire 90 quand
    // l'administrateur a tapé 900 enregistrerait une valeur qu'il n'a pas choisie (§118.16).
    return {
      ok: false,
      error: `Le délai de soumission se compte en jours entiers, de 0 à ${JOURS_AVANT_ECHEANCE_MAX}, avant la fin du mois qui précède la période (15 par défaut).`,
    };
  }
  const tourPlanning = { granularity, submissionLeadDays: jours };
  await prisma.sfeSettings.upsert({
    where: { id: "global" },
    create: { id: "global", tourPlanning, updatedById: user.id },
    update: { tourPlanning, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Force de vente",
    summary: `Planification de tournée : maille ${GRANULARITE_LABELS[granularity].toLowerCase()}, échéance ${jours} j avant la fin du mois précédent`,
  });
  revalidatePath(PARAMETRES_PATH);
  // Les plans à venir se préparent à la nouvelle maille : l'écran du KAM l'annonce.
  revalidatePath("/medical/plan-de-tournee");
  return { ok: true };
}

// ─────────────────────────── Profil KAM (configuration individuelle) ───────────────────────────
export async function saveRepProfile(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const repId = fdStr(formData, "repId");
  if (!repId) return { ok: false, error: "KAM introuvable." };
  // CE QUE LE FORMULAIRE NE PORTE PAS NE CHANGE PAS (§118.172, §118.152c). L'upsert réécrivait
  // toutes les colonnes : « Rattacher un KAM » n'envoie que la BU, donc un KAM retiré de sa BU puis
  // rattaché perdait capacités, ETP, séniorité, région et note — remis à « valeur globale » et
  // « 1 ETP » sans un mot. Et la ligne d'un KAM n'envoie pas la note : chaque correction de
  // capacité l'effaçait. L'op d'Adam rejouait l'existant pour s'en protéger (« FUSION ») ; c'est
  // l'action qui doit le tenir, sinon chaque appelant doit y penser.
  const arrondi = (v: number | null) => (v != null ? Math.round(v) : null);
  const actif = fdCase(formData, "isActive");
  const data = {
    ...(formData.has("businessUnitId") ? { businessUnitId: fdStr(formData, "businessUnitId") || null } : {}),
    ...(formData.has("region") ? { region: fdStr(formData, "region") } : {}),
    ...(formData.has("capDaysPerMonth") ? { capDaysPerMonth: arrondi(num(formData, "capDaysPerMonth")) } : {}),
    ...(formData.has("capVisitsPerDay") ? { capVisitsPerDay: arrondi(num(formData, "capVisitsPerDay")) } : {}),
    ...(formData.has("capFieldPct") ? { capFieldPct: arrondi(num(formData, "capFieldPct")) } : {}),
    ...(formData.has("fteBudget") ? { fteBudget: num(formData, "fteBudget") ?? 1 } : {}),
    ...(formData.has("seniority") ? { seniority: fdStr(formData, "seniority") } : {}),
    ...(actif !== undefined ? { isActive: actif } : {}),
    ...(formData.has("note") ? { note: fdStr(formData, "note") } : {}),
  };
  // UN KAM QUI CHANGE DE BU QUITTE LES SECTEURS DE L'ANCIENNE (§118.184 — audit 360°, S15) : ses
  // affectations restaient en base, et leurs praticiens dans son panel. Retirées dans la MÊME transaction
  // que le rattachement — un KAM ne passe pas par un état où il couvre deux BU.
  const nouvelleBu = "businessUnitId" in data ? data.businessUnitId : undefined;
  const { retires, rendu } = await prisma.$transaction(async (tx) => {
    await tx.salesRepProfile.upsert({ where: { repId }, create: { repId, ...data }, update: data });
    if (nouvelleBu === undefined) return { retires: 0, rendu: false };
    const r = await tx.salesSectorRep.deleteMany({
      where: { repId, ...(nouvelleBu ? { sector: { businessUnitId: { not: nouvelleBu } } } : {}) },
    });
    // SON TERRITOIRE PROPRE LUI EST RENDU quand il revient dans une BU où il en avait un (04/10/2026).
    // Quitter la BU lui retire l'affectation (ci-dessus) mais garde le territoire en sommeil : retiré
    // par erreur puis rattaché, il ne doit pas perdre le choix d'établissements qu'on avait fait pour
    // lui. Le lien se recrée dans la MÊME transaction — un KAM ne passe pas par un état où son
    // territoire existe sans le couvrir.
    let rendu = false;
    if (nouvelleBu) {
      const territoire = await tx.salesSector.findUnique({
        where: { businessUnitId_repId: { businessUnitId: nouvelleBu, repId } },
        select: { id: true, isActive: true },
      });
      if (territoire?.isActive) {
        const c = await tx.salesSectorRep.createMany({ data: [{ sectorId: territoire.id, repId }], skipDuplicates: true });
        rendu = c.count > 0;
      }
    }
    return { retires: r.count, rendu };
  });
  revalidatePath(BU_PATH, "layout");
  const phrases = [
    retires > 0 ? `${retires} affectation(s) à un secteur de son ancienne BU lui sont retirées : son panel suit sa nouvelle BU.` : null,
    rendu ? "Son territoire dans cette BU lui est rendu, tel qu'il était." : null,
  ].filter(Boolean);
  return phrases.length > 0 ? { ok: true, message: phrases.join(" ") } : { ok: true };
}

export async function deleteRepProfile(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const repId = fdStr(formData, "repId");
  if (!repId) return { ok: false, error: "KAM introuvable." };
  // Retiré de la force de vente, il quitte aussi ses secteurs (§118.184 — S15), dans la même transaction.
  await prisma.$transaction([
    prisma.salesSectorRep.deleteMany({ where: { repId } }),
    prisma.salesRepProfile.deleteMany({ where: { repId } }),
  ]);
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

// ─────────────────────────── Secteurs (territoires nommés d'une BU) ───────────────────────────

/**
 * LE SECTEUR — « Est », « Oranais », « Alger » : une sélection d'établissements qui porte un nom,
 * et les KAM qui la couvrent.
 *
 * ── CRÉER ET MODIFIER SONT DEUX ACTIONS, PAS UN UPSERT ──────────────────────────────────────
 *
 * L'identité d'un secteur change de nature selon le geste : à la CRÉATION c'est « cette BU + ce
 * nom », à la MODIFICATION c'est son identifiant. Un `saveSector` unique aurait donc deux champs
 * obligatoires dont un seul l'est à la fois — et `actions/contrat.ts`, qui DÉRIVE la fiche depuis
 * la source, ne peut pas lire cette nuance : il aurait annoncé les deux obligatoires, et
 * « renomme le secteur Est » se serait fait refuser pour une BU qu'on n'avait pas à redire
 * (§118.87 : une liste plausible mais fausse est pire qu'un refus). C'est aussi la convention de
 * tout ce fichier (`create/updateBusinessUnit`, `create/updatePromoProduct`).
 *
 * ── LES TROIS PARTS PARTENT ENSEMBLE (nom, établissements, KAM) ──────────────────────────────
 *
 * Un secteur créé dont l'enregistrement des établissements échoue est un NOM SANS TERRITOIRE :
 * le KAM qu'on y affecte a un panel vide, et rien ne le dit. D'où la transaction.
 *
 * ── LES LISTES SONT REMPLACÉES, PAS FUSIONNÉES ──────────────────────────────────────────────
 *
 * L'écran envoie la sélection COMPLÈTE : décocher un hôpital doit le RETIRER. Fusionner ferait un
 * secteur qui ne peut que grandir.
 */
export async function createSector(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId");
  const name = fdStr(formData, "name");
  if (!businessUnitId) return { ok: false, error: "Le secteur doit appartenir à une Business Unit." };
  if (!name) return { ok: false, error: "Le nom du secteur est obligatoire (« Est », « Oranais »…)." };
  const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { id: true } });
  if (!bu) return { ok: false, error: "Business Unit introuvable." };
  return ecrireSecteur(user.id, null, businessUnitId, name, formData);
}

export async function updateSector(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id) return { ok: false, error: "Identifiant du secteur manquant." };
  if (!name) return { ok: false, error: "Le nom du secteur est obligatoire (« Est », « Oranais »…)." };
  const cible = await prisma.salesSector.findUnique({ where: { id }, select: { id: true, businessUnitId: true, repId: true } });
  if (!cible) return { ok: false, error: "Secteur introuvable." };
  // LE TERRITOIRE D'UN KAM N'EST PAS UN SECTEUR PARTAGÉ : il se règle sur la ligne de SON KAM, qui
  // y est le seul affecté. Le modifier d'ici permettrait d'y affecter un autre KAM, ou de le renommer
  // en secteur « Est » — deux vérités pour un même territoire (§118.5).
  if (cible.repId) return { ok: false, error: REFUS_TERRITOIRE_PAR_SECTEUR };
  return ecrireSecteur(user.id, cible.id, cible.businessUnitId, name, formData);
}

/** Le remède, nommé : le territoire d'un KAM se règle sur sa ligne (§118.30). */
const REFUS_TERRITOIRE_PAR_SECTEUR =
  "Ce secteur est le territoire propre d'un KAM : il se règle sur sa ligne, dans « KAM de la BU » (bouton « Territoire »).";

/**
 * UN NOM QUE SEUL UN SECTEUR RETIRÉ OCCUPE EST LIBRE (Direction, 08/10 : « ça me dit qu'un territoire Centre existe déjà,
 * alors que ce n'est pas vrai »). Les secteurs PARTAGÉS d'avant (« Centre », « Est »…) ont été repris dans les territoires
 * des KAM puis DÉSACTIVÉS, jamais supprimés (migration `20270106093000_territoire_kam`) : invisibles partout, ils gardaient
 * leur nom et la contrainte d'unicité `(businessUnitId, name)` refusait ce nom au territoire qui le voulait. On renomme
 * l'ancien en « Centre (ancien) » — son historique reste entier — et le nom revient à qui le choisit. Un secteur ACTIF du
 * même nom, lui, reste un vrai homonyme : le refus qui suit le nomme.
 */
async function libererNomRetire(businessUnitId: string, nom: string, saufId: string | null): Promise<void> {
  const retires = await prisma.salesSector.findMany({
    where: { businessUnitId, isActive: false, name: { equals: nom, mode: "insensitive" }, ...(saufId ? { id: { not: saufId } } : {}) },
    select: { id: true, name: true },
  });
  for (const r of retires) {
    for (let n = 1; n < 50; n++) {
      const candidat = `${r.name} (ancien${n > 1 ? ` ${n}` : ""})`.slice(0, NOM_SECTEUR_MAX);
      const pris = await prisma.salesSector.findFirst({
        where: { businessUnitId, name: { equals: candidat, mode: "insensitive" } },
        select: { id: true },
      });
      if (pris) continue;
      await prisma.salesSector.update({ where: { id: r.id }, data: { name: candidat } });
      break;
    }
  }
}

/**
 * LE CORPS COMMUN. Non exporté : un fichier `"use server"` n'exporte que des fonctions
 * asynchrones appelables à distance, et ceci n'en est pas une — c'est la part que les deux gestes
 * partagent, et l'écrire deux fois la ferait diverger au premier réglage (§118.5).
 */
async function ecrireSecteur(
  actorId: string, sectorId: string | null, businessUnitId: string, name: string, formData: FormData,
  /**
   * LE TERRITOIRE PROPRE D'UN KAM (04/10/2026) : son KAM est le seul affecté (`repIds` imposé, le
   * formulaire n'en dit rien) et la ligne porte `repId`. Le reste — établissements, couverture des
   * services, vérifications, transaction — est le MÊME corps que pour un secteur partagé : une règle
   * de couverture écrite deux fois divergerait au premier réglage (§118.5).
   */
  territoireDe?: string,
): Promise<ActionResult> {
  // Les identifiants sont VÉRIFIÉS en base avant d'être écrits : un lien vers un établissement
  // supprimé entre l'ouverture de l'écran et l'enregistrement partirait en violation de clé
  // étrangère — une erreur technique là où la vérité est « cet hôpital n'existe plus ».
  const institutionIds = [...new Set(formData.getAll("institutionIds").map(String).filter(Boolean))];
  const repIds = territoireDe ? [territoireDe] : [...new Set(formData.getAll("repIds").map(String).filter(Boolean))];

  await libererNomRetire(businessUnitId, name, sectorId);
  const [institutions, reps, homonyme, dejaCouverts] = await Promise.all([
    institutionIds.length
      ? prisma.medicalInstitution.findMany({ where: { id: { in: institutionIds } }, select: { id: true, name: true, isActive: true } })
      : Promise.resolve([] as { id: string; name: string; isActive: boolean }[]),
    // UN KAM DE CETTE BU (§118.184 — S15) : l'écran ne propose que les KAM rattachés à la BU ; une requête
    // forgée y affectait n'importe quel compte, qui recevait alors un territoire d'une autre équipe.
    repIds.length
      ? prisma.salesRepProfile.findMany({ where: { repId: { in: repIds }, businessUnitId }, select: { repId: true } })
      : Promise.resolve([] as { repId: string }[]),
    // UN SEUL SECTEUR « Est » PAR BU. La contrainte d'unicité le tient déjà ; on la lit d'abord
    // pour rendre une phrase plutôt qu'un code Prisma.
    prisma.salesSector.findFirst({
      where: { businessUnitId, name: { equals: name, mode: "insensitive" }, ...(sectorId ? { id: { not: sectorId } } : {}) },
      select: { id: true },
    }),
    // CE QUE LE SECTEUR COUVRE DÉJÀ : un établissement désactivé depuis y reste (le retirer en silence
    // à l'enregistrement retirerait des médecins du panel sans que personne l'ait décidé).
    sectorId
      ? prisma.salesSectorInstitution.findMany({ where: { sectorId }, select: { institutionId: true } })
      : Promise.resolve([] as { institutionId: string }[]),
  ]);
  if (institutions.length !== institutionIds.length) {
    return { ok: false, error: `${institutionIds.length - institutions.length} établissement(s) sélectionné(s) n'existent plus dans l'annuaire — rechargez l'écran.` };
  }
  // UN ÉTABLISSEMENT DÉSACTIVÉ NE S'AJOUTE PLUS — l'écran ne le propose pas ; une requête forgée,
  // si. Il RESTE quand le secteur le couvrait déjà (§118.172).
  const couvertsAvant = new Set(dejaCouverts.map((d) => d.institutionId));
  const inactifsAjoutes = institutions.filter((i) => !i.isActive && !couvertsAvant.has(i.id));
  if (inactifsAjoutes.length > 0) {
    const noms = inactifsAjoutes.map((i) => `« ${i.name} »`).join(", ");
    return { ok: false, error: `${noms} : désactivé dans l'annuaire, on ne l'ajoute pas à un territoire. Réactivez-le d'abord dans Annuaires › Établissements.` };
  }
  if (reps.length !== repIds.length) {
    return { ok: false, error: `${repIds.length - reps.length} KAM sélectionné(s) ne sont pas (ou plus) rattachés à cette BU — rattachez-les d'abord à la BU, ou rechargez l'écran.` };
  }
  if (homonyme) return { ok: false, error: `Un secteur « ${name} » existe déjà dans cette BU.` };

  // CE QUE LE SECTEUR COUVRE DE CHAQUE ÉTABLISSEMENT (§118.172) — tous ses services, ou certains.
  // `null` = le formulaire n'en dit rien (une op d'Adam, un appel qui ne touche qu'au nom) : chaque
  // établissement DÉJÀ couvert garde sa couverture, un nouveau les prend tous. Un champ absent ne
  // doit pas élargir en silence un territoire qu'on avait restreint (§118.152c).
  const couv = lireCouverture(formData.get("couverture"));
  if (!couv.ok) return { ok: false, error: couv.error };
  const restreints = couv.parEtablissement
    ? new Map([...couv.parEtablissement].filter(([id]) => institutionIds.includes(id)))
    : null;
  if (restreints && restreints.size > 0) {
    // « AUCUN SERVICE » n'est pas un choix qu'on fait exprès : c'est « tous » qu'on a oublié de
    // cocher, ou un établissement qu'on voulait retirer. On le dit plutôt que de deviner.
    const vides = [...restreints].filter(([, ids]) => ids.length === 0).map(([id]) => id);
    if (vides.length > 0) {
      const noms = await prisma.medicalInstitution.findMany({ where: { id: { in: vides } }, select: { name: true } });
      return { ok: false, error: `Aucun service choisi pour ${noms.map((n) => `« ${n.name} »`).join(", ")} : cochez au moins un service, ou « Tous les services ».` };
    }
    // UN SERVICE N'EXISTE QUE DANS SON ÉTABLISSEMENT — un écran ignore ce qu'une requête forgée
    // envoie, c'est ici que la règle se tient.
    const demandes = [...restreints].flatMap(([institutionId, ids]) => ids.map((serviceId) => ({ institutionId, serviceId })));
    const connus = await prisma.medicalInstitutionService.findMany({
      where: { id: { in: [...new Set(demandes.map((d) => d.serviceId))] } },
      select: { id: true, institutionId: true },
    });
    const deQui = new Map(connus.map((c) => [c.id, c.institutionId]));
    if (demandes.some((d) => deQui.get(d.serviceId) !== d.institutionId)) {
      return { ok: false, error: "Un service choisi n'existe plus, ou n'appartient pas à son établissement — rechargez l'écran." };
    }
  }

  // LES CHAMPS QUE LE FORMULAIRE NE PORTE PAS NE CHANGENT PAS. L'écran n'a ni couleur ni
  // interrupteur d'activité : la couleur était remise à `null` et le secteur RÉACTIVÉ à chaque
  // enregistrement — le défaut du témoin caché, par son autre face (§118.172).
  const actif = fdCase(formData, "isActive");
  const data = {
    name,
    ...(formData.has("city") ? { city: fdStr(formData, "city") } : {}),
    ...(formData.has("wilayaPivot") ? { wilayaPivot: canonicalWilaya(fdStr(formData, "wilayaPivot")) } : {}),
    ...(formData.has("color") ? { color: fdStr(formData, "color") } : {}),
    ...(actif !== undefined ? { isActive: actif } : {}),
  };

  const ecrit = await prisma.$transaction(async (tx) => {
    const secteur = sectorId
      ? await tx.salesSector.update({ where: { id: sectorId }, data, select: { id: true } })
      : await tx.salesSector.create({
        data: { ...data, businessUnitId, createdById: actorId, ...(territoireDe ? { repId: territoireDe } : {}) },
        select: { id: true },
      });
    // RETIRER CE QUI N'EST PLUS COCHÉ. Une sélection VIDE retire tout, et c'est bien ce que
    // Prisma fait : `notIn: []` a été MESURÉ — il supprime la ligne (un `NOT IN` vide est vrai
    // pour tout le monde). Une première version portait une sentinelle `["__aucun__"]` en
    // affirmant l'inverse ; le sabotage qui la retirait est passé au vert, et c'est comme ça
    // qu'on apprend qu'une justification n'avait jamais été vérifiée. On garde la forme simple
    // et le fait mesuré à côté : une redondance qui repose sur une affirmation fausse coûte plus
    // qu'elle ne protège (§118.107).
    await tx.salesSectorInstitution.deleteMany({
      where: { sectorId: secteur.id, institutionId: { notIn: institutionIds } },
    });
    await tx.salesSectorRep.deleteMany({
      where: { sectorId: secteur.id, repId: { notIn: repIds } },
    });
    if (institutionIds.length) {
      await tx.salesSectorInstitution.createMany({
        data: institutionIds.map((institutionId) => ({ sectorId: secteur.id, institutionId })),
        skipDuplicates: true,
      });
    }
    // LA COUVERTURE, seulement quand le formulaire la dit. Un établissement sans entrée couvre
    // TOUS ses services ; une entrée le restreint à ceux qu'elle liste — et ce que la restriction
    // ne liste plus en sort.
    if (restreints) {
      const liens = await tx.salesSectorInstitution.findMany({
        where: { sectorId: secteur.id },
        select: { id: true, institutionId: true },
      });
      for (const lien of liens) {
        const choisis = restreints.get(lien.institutionId);
        await tx.salesSectorInstitution.update({ where: { id: lien.id }, data: { tousLesServices: !choisis } });
        await tx.salesSectorInstitutionService.deleteMany({
          where: { sectorInstitutionId: lien.id, ...(choisis ? { serviceId: { notIn: choisis } } : {}) },
        });
        if (choisis?.length) {
          await tx.salesSectorInstitutionService.createMany({
            data: choisis.map((serviceId) => ({ sectorInstitutionId: lien.id, serviceId })),
            skipDuplicates: true,
          });
        }
      }
    }
    if (repIds.length) {
      await tx.salesSectorRep.createMany({
        data: repIds.map((repId) => ({ sectorId: secteur.id, repId })),
        skipDuplicates: true,
      });
    }
    return secteur.id;
  });
  // DOUBLE ÉCRITURE DES LIEUX (refonte V2-D), après la transaction : la wilaya pivot (ou la ville) pose le code.
  if (formData.has("city") || formData.has("wilayaPivot") || !sectorId) await reposerWilayaCode("SalesSector", ecrit);

  await recordAudit({
    actorId, action: sectorId ? "UPDATE" : "CREATE", module: "Force de vente", entityType: "SALES_SECTOR", entityId: ecrit,
    summary: `${territoireDe ? "Territoire" : "Secteur"} « ${name} » — ${institutionIds.length} établissement(s)${restreints && restreints.size > 0 ? ` dont ${restreints.size} limité(s) à certains services` : ""}, ${repIds.length} KAM`,
  });
  revalidatePath(BU_PATH, "layout");
  return { ok: true, id: ecrit };
}

/**
 * SUPPRIMER UN SECTEUR. Les liens partent en cascade (ils n'ont plus d'objet) ; les
 * ÉTABLISSEMENTS et les COMPTES ne bougent pas — on retire un découpage, pas un annuaire.
 */
export async function deleteSector(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const secteur = await prisma.salesSector.findUnique({
    where: { id },
    select: { name: true, repId: true, _count: { select: { reps: true } } },
  });
  if (!secteur) return { ok: false, error: "Secteur introuvable." };
  // Le territoire d'un KAM se VIDE depuis sa ligne (on décoche ses établissements) ; il ne se
  // supprime pas d'ici, où rien ne dit à qui il appartient.
  if (secteur.repId) return { ok: false, error: REFUS_TERRITOIRE_PAR_SECTEUR };
  await prisma.salesSector.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Force de vente", entityType: "SALES_SECTOR", entityId: id,
    // Le nombre de KAM qui PERDENT leur territoire est ce qu'on veut relire dans l'audit : c'est
    // la conséquence, pas la ligne supprimée.
    summary: `Secteur « ${secteur.name} » supprimé — ${secteur._count.reps} KAM sans territoire`,
  });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

// ─────────────────────────── Territoire d'un KAM (BU hospitalière) ───────────────────────────

/**
 * LE TERRITOIRE D'UN KAM — choisi SUR SA LIGNE, dans « KAM de la BU » (04/10/2026).
 *
 * « Dans le secteur de chaque KAM, on doit pouvoir sélectionner un ou des services d'un ou de
 * plusieurs établissements hospitaliers de l'annuaire, dans le cas où la BU est hospitalière. »
 *
 * Le territoire est un `SalesSector` propre au KAM (`repId`), qui porte sa ligne `SalesSectorRep` :
 * le panel (`clausePanelDuKam`) et la portée des stocks le lisent sans changer. Le corps d'écriture
 * est celui des secteurs (`ecrireSecteur`) : mêmes vérifications, même transaction, même règle de
 * couverture (§118.172) — tous les services d'un établissement, ou certains ; « aucun service » est
 * refusé en nommant l'établissement ; un service d'un autre établissement est refusé ; un
 * établissement désactivé ne s'ajoute pas (il reste s'il y était) ; un formulaire qui ne porte pas
 * la couverture ne la touche pas (§118.152c). La liste des établissements, elle, est toujours
 * COMPLÈTE : décocher retire, et une sélection vide vide le territoire.
 *
 * Refusé : une BU de VILLE (pas d'hôpital à cocher — le secteur y reste un texte sur la ligne), un
 * KAM qui n'est pas rattaché à cette BU (une requête forgée lui donnerait un territoire d'une autre
 * équipe, §118.184).
 *
 * UN SEUL TERRITOIRE PAR KAM ET PAR BU (`@@unique([businessUnitId, repId])`). Deux premiers
 * enregistrements simultanés en créeraient deux : ils passent un par un (`enSerie`), et le second
 * MET À JOUR celui que le premier a créé ; entre deux processus, la contrainte d'unicité refuse le
 * second, qui le DIT au lieu d'une erreur de base.
 */
export async function enregistrerTerritoireKam(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId");
  const repId = fdStr(formData, "repId");
  if (!businessUnitId) return { ok: false, error: "Le territoire doit appartenir à une Business Unit." };
  if (!repId) return { ok: false, error: "KAM introuvable." };
  const [bu, profil, kam] = await Promise.all([
    prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { id: true, channel: true } }),
    prisma.salesRepProfile.findFirst({ where: { repId, businessUnitId }, select: { repId: true } }),
    prisma.user.findUnique({ where: { id: repId }, select: { name: true } }),
  ]);
  if (!bu) return { ok: false, error: "Business Unit introuvable." };
  if (!estBuHospitaliere(String(bu.channel))) {
    return { ok: false, error: REFUS_BU_DE_VILLE };
  }
  if (!profil || !kam) {
    return { ok: false, error: "Ce KAM n'est pas (ou plus) rattaché à cette BU — rattachez-le d'abord, ou rechargez l'écran." };
  }
  try {
    return await enSerie(`territoire-kam:${businessUnitId}:${repId}`, async () => {
      const existant = await prisma.salesSector.findUnique({
        where: { businessUnitId_repId: { businessUnitId, repId } },
        select: { id: true, name: true },
      });
      // LE NOM : celui que le panneau envoie (Direction, 08/10 : « permets de nommer chaque territoire ») ; sinon celui
      // du territoire s'il existe déjà ; sinon « Territoire — <KAM> », suffixé quand ce nom est pris dans la BU (un
      // ancien secteur, un homonyme) — la règle de la migration. Un nom choisi déjà pris dans la BU est REFUSÉ par le
      // corps commun (`ecrireSecteur`), en le nommant.
      const choisi = nomDeSecteur(formData);
      if (choisi && !choisi.ok) return { ok: false as const, error: choisi.error };
      let nom = choisi?.nom ?? existant?.name;
      if (!nom) {
        const base = nomDuTerritoire(kam.name, repId, false);
        const pris = await prisma.salesSector.findFirst({
          where: { businessUnitId, name: { equals: base, mode: "insensitive" } },
          select: { id: true },
        });
        nom = nomDuTerritoire(kam.name, repId, Boolean(pris));
      }
      return ecrireSecteur(user.id, existant?.id ?? null, businessUnitId, nom, formData, repId);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Le territoire de ce KAM vient d'être enregistré par ailleurs — rechargez l'écran, puis recommencez." };
    }
    throw e;
  }
}

/**
 * LA WILAYA PIVOT D'UN KAM (Direction, 08/10) : « pour chaque KAM, mettre la wilaya pivot avec un menu déroulant, utilisée
 * pour le In/Out de la segmentation : une visite dans la wilaya pivot = In, en dehors = Out ».
 *
 * Un geste À PART du territoire : il n'écrit QUE la wilaya (vide = on la retire), jamais la couverture — passer par
 * `enregistrerTerritoireKam` sans cocher d'établissements viderait le panel du KAM. Le territoire propre du KAM est créé
 * (vide, au nom habituel) quand il n'existe pas encore : on peut désigner la wilaya avant de choisir les établissements.
 */
export async function definirWilayaPivotKam(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId");
  const repId = fdStr(formData, "repId");
  const brute = fdStr(formData, "wilayaPivot");
  if (!businessUnitId) return { ok: false, error: "Le territoire doit appartenir à une Business Unit." };
  if (!repId) return { ok: false, error: "KAM introuvable." };
  // LA LISTE FERMÉE : une wilaya du référentiel, ou rien. Jamais un texte deviné.
  const wilaya = brute ? canonicalWilaya(brute) : null;
  if (brute && !wilaya) return { ok: false, error: `« ${brute} » n'est pas une wilaya du référentiel — choisissez-la dans le menu.` };
  const [profil, kam] = await Promise.all([
    prisma.salesRepProfile.findFirst({ where: { repId, businessUnitId }, select: { repId: true } }),
    prisma.user.findUnique({ where: { id: repId }, select: { name: true } }),
  ]);
  if (!profil || !kam) {
    return { ok: false, error: "Ce KAM n'est pas (ou plus) rattaché à cette BU — rattachez-le d'abord, ou rechargez l'écran." };
  }
  try {
    const id = await enSerie(`territoire-kam:${businessUnitId}:${repId}`, async () => {
      const existant = await prisma.salesSector.findUnique({
        where: { businessUnitId_repId: { businessUnitId, repId } },
        select: { id: true, wilayaPivot: true },
      });
      if (existant) {
        if (existant.wilayaPivot !== wilaya) await prisma.salesSector.update({ where: { id: existant.id }, data: { wilayaPivot: wilaya } });
        return existant.id;
      }
      if (!wilaya) return null;
      const base = nomDuTerritoire(kam.name, repId, false);
      const pris = await prisma.salesSector.findFirst({
        where: { businessUnitId, name: { equals: base, mode: "insensitive" } },
        select: { id: true },
      });
      const cree = await prisma.salesSector.create({
        data: { businessUnitId, name: nomDuTerritoire(kam.name, repId, Boolean(pris)), repId, wilayaPivot: wilaya, createdById: user.id },
        select: { id: true },
      });
      await prisma.salesSectorRep.createMany({ data: [{ sectorId: cree.id, repId }], skipDuplicates: true });
      return cree.id;
    });
    if (id) await reposerWilayaCode("SalesSector", id); // double écriture des lieux (refonte V2-D)
    if (id) {
      await recordAudit({
        actorId: user.id, action: "UPDATE", module: "Force de vente", entityType: "SALES_SECTOR", entityId: id,
        summary: `Wilaya pivot de ${kam.name} : ${wilaya ?? "retirée"} (In / Out de la segmentation)`,
      });
    }
    revalidatePath(BU_PATH, "layout");
    revalidatePath("/segmentation");
    return { ok: true, id: id ?? undefined };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Le territoire de ce KAM vient d'être enregistré par ailleurs — rechargez l'écran, puis recommencez." };
    }
    throw e;
  }
}

/** Le refus d'une BU de ville nomme les DEUX remèdes : rien à cocher ici, ou changer son terrain. */
const REFUS_BU_DE_VILLE =
  "Cette BU est une gamme de ville : il n'y a pas d'établissement à choisir — le secteur du KAM se saisit en texte sur sa ligne. "
  + "Passez la BU en terrain « Hospitalière » ou « les deux » pour choisir des établissements.";

/** La longueur d'un nom de secteur : il s'affiche dans une cellule de tableau et sur une carte. */
const NOM_SECTEUR_MAX = 80;

/**
 * LE NOM DE SECTEUR QU'UN FORMULAIRE ENVOIE — `null` s'il n'en dit rien (le nom ne change pas), sinon le nom nettoyé
 * (espaces repliés) ou le refus qui dit pourquoi. Non exportée : un fichier `"use server"` n'exporte que des actions.
 */
function nomDeSecteur(formData: FormData): { ok: true; nom: string } | { ok: false; error: string } | null {
  if (!formData.has("name")) return null;
  const nom = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
  if (!nom) return null;
  if (nom.length > NOM_SECTEUR_MAX) return { ok: false, error: `Le nom du territoire tient en ${NOM_SECTEUR_MAX} caractères au plus.` };
  return { ok: true, nom };
}

/**
 * NOMMER UN TERRITOIRE (Direction, 08/10 : « permets de nommer chaque territoire ») — le territoire propre d'un KAM naît
 * « Territoire — <KAM> » ; on le renomme ici, sur sa ligne (Business Units › Secteurs) ou dans le tableau de la Force de
 * vente › Territoires. Le NOM SEUL change : ni ses établissements, ni ses services, ni son KAM — l'action d'écriture du
 * territoire REMPLACE la sélection, et un renommage qui passerait par elle viderait le panel.
 *
 * Le droit est celui qui règle les secteurs (module « Business Units », Modifier). Un seul nom par BU (insensible à la
 * casse, comme la contrainte d'unicité) : un homonyme est refusé en le nommant, et une course entre deux renommages est
 * dite au lieu d'une erreur de base. Audité : le nom d'avant et le nouveau.
 */
export async function renommerSecteur(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant du territoire manquant." };
  const choisi = nomDeSecteur(formData);
  if (!choisi) return { ok: false, error: "Le nom du territoire est obligatoire." };
  if (!choisi.ok) return { ok: false, error: choisi.error };
  const nom = choisi.nom;
  const secteur = await prisma.salesSector.findUnique({ where: { id }, select: { id: true, name: true, businessUnitId: true, repId: true } });
  if (!secteur) return { ok: false, error: "Territoire introuvable — rechargez l'écran." };
  if (secteur.name === nom) return { ok: true, id: secteur.id };
  await libererNomRetire(secteur.businessUnitId, nom, secteur.id);
  const homonyme = await prisma.salesSector.findFirst({
    where: { businessUnitId: secteur.businessUnitId, name: { equals: nom, mode: "insensitive" }, id: { not: secteur.id } },
    select: { id: true },
  });
  if (homonyme) return { ok: false, error: `Un territoire « ${nom} » existe déjà dans cette BU : choisissez un autre nom.` };
  try {
    await prisma.salesSector.update({ where: { id: secteur.id }, data: { name: nom } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: `Un territoire « ${nom} » vient d'être créé dans cette BU : choisissez un autre nom.` };
    }
    throw e;
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Business Units", entityType: "SALES_SECTOR", entityId: secteur.id,
    summary: `${secteur.repId ? "Territoire" : "Secteur"} renommé : « ${secteur.name} » → « ${nom} »`,
  });
  revalidatePath(BU_PATH, "layout");
  revalidatePath(`${PATH}/territoires`);
  revalidatePath("/segmentation", "layout");
  return { ok: true, id: secteur.id };
}

// ─────────────────────────── Affectations (matrice KAM × produit) ───────────────────────────
export async function saveAssignment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cycleId = fdStr(formData, "cycleId");
  const repId = fdStr(formData, "repId");
  const productId = fdStr(formData, "productId");
  if (!cycleId || !repId || !productId) return { ok: false, error: "Paramètres manquants." };
  if (!(await canEditRep(user, repId))) return { ok: false, error: "Non autorisé sur ce KAM." };
  const position = Math.min(3, Math.max(1, Math.round(num(formData, "position") ?? 1)));
  const plannedVisits = Math.max(0, Math.round(num(formData, "plannedVisits") ?? 0));
  const note = fdStr(formData, "note");
  // ── ZÉRO VISITE N'EST PLUS UNE SUPPRESSION ────────────────────────────────────────────────
  //
  // Cette action retirait l'affectation dès que les visites tombaient à 0 sans note — « nettoyage
  // de la matrice ». C'était le défaut rapporté : « on ne voit pas le produit quand on l'ajoute au
  // KAM ». On ajoutait un produit, on choisissait son rang P1/P2/P3, l'écran enregistrait avec
  // zéro visite encore saisie… et l'action SUPPRIMAIT la ligne qu'on venait de créer, en
  // répondant « ok ». Rien ne s'affichait, rien ne le disait.
  //
  // Une affectation à zéro visite est un ÉTAT LÉGITIME : ce KAM détaille ce produit, les visites
  // restent à planifier. Et pour retirer une ligne, il y a un bouton qui ne fait que cela
  // (`deleteAssignment`) — un geste explicite, au lieu d'un effet de bord d'un champ vidé.
  const data = { position, plannedVisits, note, updatedById: user.id };
  await prisma.promotionAssignment.upsert({
    where: { cycleId_repId_productId: { cycleId, repId, productId } },
    create: { cycleId, repId, productId, ...data },
    update: data,
  });
  revalidatePath(`${PATH}/produits`);
  return { ok: true };
}

export async function deleteAssignment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const repId = fdStr(formData, "repId");
  const cycleId = fdStr(formData, "cycleId");
  const productId = fdStr(formData, "productId");
  if (!cycleId || !repId || !productId) return { ok: false, error: "Paramètres manquants." };
  if (!(await canEditRep(user, repId))) return { ok: false, error: "Non autorisé sur ce KAM." };
  await prisma.promotionAssignment.deleteMany({ where: { cycleId, repId, productId } });
  revalidatePath(`${PATH}/produits`);
  return { ok: true };
}

/** Duplique les affectations d'un cycle précédent vers le cycle courant (KAM sous ma portée). */
export async function carryForwardAssignments(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const toCycleId = fdStr(formData, "toCycleId");
  const fromYear = num(formData, "fromYear");
  const fromMonth = num(formData, "fromMonth");
  if (!toCycleId || fromYear == null || fromMonth == null) return { ok: false, error: "Paramètres manquants." };
  const from = await prisma.promoCycle.findUnique({ where: { year_month: { year: Math.round(fromYear), month: Math.round(fromMonth) } }, select: { id: true } });
  if (!from) return { ok: false, error: "Aucun cycle source trouvé." };
  const src = await prisma.promotionAssignment.findMany({ where: { cycleId: from.id } });
  let copied = 0;
  for (const a of src) {
    await prisma.promotionAssignment.upsert({
      where: { cycleId_repId_productId: { cycleId: toCycleId, repId: a.repId, productId: a.productId } },
      create: { cycleId: toCycleId, repId: a.repId, productId: a.productId, position: a.position, plannedVisits: a.plannedVisits, note: a.note, updatedById: user.id },
      update: {},
    });
    copied++;
  }
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Force de vente", summary: `Report de ${copied} affectation(s)` });
  revalidatePath(`${PATH}/produits`);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LES RÉFÉRENTS DIRECTION MARKETING D'UNE GAMME (22/09/2026)
//
// « Chaque BU aura son ou ses référents de la direction marketing depuis la configuration des
// BU, mais le directeur du département marketing recevra également l'accès et la notif ».
//
// CE QUE CES DEUX GESTES FONT : ils CIBLENT la notification des demandes Ad & Pro de la gamme.
// Ils n'ACCORDENT rien — le pouvoir de trancher reste gouverné par le rôle de l'étape, et l'on
// n'accepte que des personnes qui le portent DÉJÀ. Une désignation posée depuis un écran de
// configuration commerciale qui ouvrirait un pouvoir d'arbitrage serait une porte de permission
// à côté de la porte gardée (`lib/personnes/referents-gamme.ts` porte la raison complète).
// ═══════════════════════════════════════════════════════════════════════════════════════════

export async function addBuMarketingReferent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const businessUnitId = fdStr(formData, "businessUnitId");
  const userId = fdStr(formData, "userId");
  if (!businessUnitId) return { ok: false, error: "Le référent appartient à une Business Unit." };
  if (!userId) return { ok: false, error: "Indiquez la personne à désigner comme référente." };
  const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { id: true, name: true } });
  if (!bu) return { ok: false, error: "Business Unit introuvable." };
  // LA PERSONNE DOIT PORTER LE RÔLE, et le refus NOMME le remède : sans le rôle, elle serait
  // prévenue et ne pourrait rien trancher — une attente sans pouvoir, que l'écran de
  // configuration commerciale ne doit pas pouvoir fabriquer (§118.30).
  const cible = await prisma.user.findFirst({
    where: { id: userId, isActive: true, ...anyRoleFilter([...ROLES_QUI_TRANCHENT] as UserRole[]) },
    select: { id: true, name: true },
  });
  if (!cible) {
    return {
      ok: false,
      error: "Un référent doit porter le rôle Direction Marketing : cette désignation cible la notification, "
        + "elle n'accorde aucun droit. Attribuez d'abord le rôle depuis Administration › Comptes.",
    };
  }
  // Un double clic ne doit pas la faire notifier deux fois : la contrainte d'unicité le dit en
  // base, `skipDuplicates` le rend silencieux plutôt qu'une erreur technique.
  const { count } = await prisma.businessUnitMarketingReferent.createMany({
    data: [{ businessUnitId, userId }],
    skipDuplicates: true,
  });
  if (count === 0) return { ok: true }; // déjà référente — le geste est idempotent, pas en échec
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: businessUnitId,
    summary: `Référent Direction Marketing ajouté — ${cible.name} sur la gamme ${bu.name}`,
  });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}

export async function removeBuMarketingReferent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, BU_MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant de la désignation manquant." };
  const ligne = await prisma.businessUnitMarketingReferent.findUnique({
    where: { id },
    select: { id: true, businessUnitId: true, businessUnit: { select: { name: true } }, user: { select: { name: true } } },
  });
  if (!ligne) return { ok: true }; // déjà retirée : le geste est idempotent
  await prisma.businessUnitMarketingReferent.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Force de vente", entityType: "BUSINESS_UNIT", entityId: ligne.businessUnitId,
    summary: `Référent Direction Marketing retiré — ${ligne.user.name} de la gamme ${ligne.businessUnit.name}`,
  });
  revalidatePath(BU_PATH, "layout");
  return { ok: true };
}
