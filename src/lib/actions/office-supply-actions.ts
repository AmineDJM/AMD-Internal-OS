"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { SUPPLY_CATEGORY, SUPPLY_UNIT } from "@/lib/labels";
import {
  normalizeArticle, articleKey, needsRewrite, describeRewrite, type ArticleFields,
} from "@/lib/general-means/catalog-normalize";

const DENIED: ActionResult = { ok: false, error: "Non autorisé." };

/** Les listes fermées de la plateforme — passées au normalisateur, jamais recopiées. */
const LABELS = { category: SUPPLY_CATEGORY, unit: SUPPLY_UNIT };

/** Lit le formulaire ET l'uniformise : le catalogue n'accepte qu'une seule écriture. */
function readArticle(formData: FormData): ArticleFields {
  return normalizeArticle({
    name: fdStr(formData, "name") ?? "",
    category: fdStr(formData, "category"),
    unit: fdStr(formData, "unit"),
    reference: fdStr(formData, "reference"),
    supplierHint: fdStr(formData, "supplierHint"),
  }, LABELS);
}

const REVALIDATE = ["/demandes", "/moyens-generaux"];
const refresh = () => { for (const p of REVALIDATE) revalidatePath(p); };

/**
 * Le catalogue est maintenu par les gestionnaires du Bureau du secrétariat — ET par ceux des
 * moyens généraux. C'est le MÊME catalogue vu de deux endroits : il alimente les demandes
 * d'achat d'un côté, le détail des tickets de caisse de l'autre. En tenir deux reviendrait à
 * comparer des consommations qui ne parlent pas des mêmes articles.
 */
function canManageCatalog(user: SessionUser): boolean {
  return hasGlobalView(user.role)
    || userCan(user, "ADMIN_REQUESTS", "UPDATE")
    || userCan(user, "GENERAL_MEANS", "UPDATE");
}

export async function createSupplyArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCatalog(user)) return DENIED;
  const a = readArticle(formData);
  if (!a.name) return { ok: false, error: "Le nom de l'article est obligatoire." };

  // LE DOUBLON EST REFUSÉ — c'est le vrai bénéfice d'une écriture uniforme. On compare sur la
  // CLÉ (sans casse, sans accent, sans ponctuation) : « RAMETTE A4 » et « ramette-a4 » sont le
  // même article, et en créer un second éclate la consommation entre deux lignes.
  const key = articleKey(a.name);
  const existing = await prisma.officeSupplyArticle.findMany({ select: { id: true, name: true, active: true } });
  const clash = existing.find((e) => articleKey(e.name) === key);
  if (clash) {
    return {
      ok: false,
      error: clash.active
        ? `« ${clash.name} » est déjà au catalogue — utilisez-le plutôt que d'en créer un second.`
        : `« ${clash.name} » existe au catalogue mais est désactivé : réactivez-le plutôt que d'en créer un second.`,
    };
  }

  const created = await prisma.officeSupplyArticle.create({
    data: {
      name: a.name,
      category: a.category,
      unit: a.unit,
      reference: a.reference,
      estimatedPrice: fdNum(formData, "estimatedPrice") ?? undefined,
      supplierHint: a.supplierHint,
      notes: fdStr(formData, "notes"),
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Bureau du secrétariat", entityType: "OFFICE_SUPPLY_ARTICLE", entityId: created.id, summary: `Article « ${a.name} » ajouté au catalogue` });
  revalidatePath("/demandes");
  revalidatePath("/moyens-generaux");
  return { ok: true, id: created.id };
}

export async function updateSupplyArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCatalog(user)) return DENIED;
  const id = fdStr(formData, "id");
  const a = readArticle(formData);
  if (!id || !a.name) return { ok: false, error: "Nom requis." };

  // Renommer sur un libellé déjà pris fusionnerait deux articles sans le dire.
  const key = articleKey(a.name);
  const others = await prisma.officeSupplyArticle.findMany({
    where: { id: { not: id } }, select: { name: true },
  });
  if (others.some((o) => articleKey(o.name) === key)) {
    return { ok: false, error: `« ${a.name} » désigne déjà un autre article du catalogue.` };
  }

  await prisma.officeSupplyArticle.update({
    where: { id },
    data: {
      name: a.name,
      category: a.category,
      unit: a.unit,
      reference: a.reference,
      estimatedPrice: fdNum(formData, "estimatedPrice") ?? null,
      supplierHint: a.supplierHint,
      notes: fdStr(formData, "notes"),
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "OFFICE_SUPPLY_ARTICLE", entityId: id, summary: `Article « ${a.name} » modifié` });
  revalidatePath("/demandes");
  revalidatePath("/moyens-generaux");
  return { ok: true, id };
}

/** Active / désactive un article (un article retiré n'apparaît plus dans le menu). */
export async function toggleSupplyArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCatalog(user)) return DENIED;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const a = await prisma.officeSupplyArticle.findUnique({ where: { id }, select: { active: true, name: true } });
  if (!a) return { ok: false, error: "Article introuvable." };
  await prisma.officeSupplyArticle.update({ where: { id }, data: { active: !a.active } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "OFFICE_SUPPLY_ARTICLE", entityId: id, summary: `Article « ${a.name} » ${a.active ? "désactivé" : "réactivé"}` });
  revalidatePath("/demandes");
  revalidatePath("/moyens-generaux");
  return { ok: true };
}

// ───────────────────────────── Uniformiser l'existant ─────────────────────────────

export interface CatalogRewrite {
  id: string;
  name: string;
  /** Ce qui changera, champ par champ — « Libellé : ramette a4 → Ramette A4 ». */
  changes: string[];
}

/**
 * CE QUI SERAIT RÉÉCRIT — lecture seule, rien n'est touché.
 *
 * Le catalogue existant n'est PAS normalisé en silence. Réécrire des libellés que des gens
 * reconnaissent est un geste visible : ils doivent le voir venir, et pouvoir le refuser. On
 * montre donc d'abord, on applique ensuite — et jamais l'inverse.
 */
export async function previewCatalogNormalization(): Promise<{ ok: boolean; error?: string; rewrites: CatalogRewrite[]; total: number }> {
  const user = await requireUser();
  if (!canManageCatalog(user)) return { ok: false, error: "Non autorisé.", rewrites: [], total: 0 };

  const rows = await prisma.officeSupplyArticle.findMany({
    select: { id: true, name: true, category: true, unit: true, reference: true, supplierHint: true },
    orderBy: { name: "asc" },
  });
  const rewrites: CatalogRewrite[] = [];
  for (const r of rows) {
    const after = normalizeArticle(r, LABELS);
    if (needsRewrite(r, after)) rewrites.push({ id: r.id, name: r.name, changes: describeRewrite(r, after) });
  }
  return { ok: true, rewrites, total: rows.length };
}

/**
 * APPLIQUE l'uniformisation à tout le catalogue — sur clic explicite, jamais automatiquement.
 *
 * Les DOUBLONS ne sont pas fusionnés : deux lignes qui deviennent le même libellé restent deux
 * lignes, et l'on dit lesquelles. Fusionner reviendrait à choisir laquelle des deux garde ses
 * achats, son prix et sa référence — un arbitrage qui appartient à celui qui tient le catalogue,
 * pas à un traitement de masse.
 */
export async function applyCatalogNormalization(): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCatalog(user)) return DENIED;

  const rows = await prisma.officeSupplyArticle.findMany({
    select: { id: true, name: true, category: true, unit: true, reference: true, supplierHint: true },
  });
  let changed = 0;
  const seen = new Map<string, string>();
  const collisions: string[] = [];

  for (const r of rows) {
    const after = normalizeArticle(r, LABELS);
    const key = articleKey(after.name);
    const first = seen.get(key);
    if (first && first !== r.id) collisions.push(after.name);
    else seen.set(key, r.id);

    if (!needsRewrite(r, after)) continue;
    await prisma.officeSupplyArticle.update({
      where: { id: r.id },
      data: { name: after.name, category: after.category, unit: after.unit, reference: after.reference, supplierHint: after.supplierHint },
    });
    changed += 1;
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat",
    summary: `Catalogue d'articles uniformisé — ${changed} article(s) réécrit(s) sur ${rows.length}`
      + (collisions.length > 0 ? ` ; ${collisions.length} doublon(s) apparu(s), non fusionné(s) : ${[...new Set(collisions)].join(", ")}` : ""),
  });
  refresh();

  if (changed === 0) return { ok: true, message: "Le catalogue est déjà uniforme — rien à réécrire." };
  const dup = [...new Set(collisions)];
  return {
    ok: true,
    message: `${changed} article(s) réécrit(s).`
      + (dup.length > 0
        ? ` ${dup.length} libellé(s) désignent désormais deux lignes — à fusionner à la main : ${dup.join(", ")}.`
        : ""),
  };
}
