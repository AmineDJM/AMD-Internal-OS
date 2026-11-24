"use server";

import { revalidatePath } from "next/cache";
import type { MarketResearchStatus, PlayerStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { getRecommendations, normText, queryTokens, allTokensIn, type RecRow } from "@/lib/market/engine";
import { DEFAULT_RESEARCH_SOURCES } from "@/lib/queries/market-research";
import { resolveProductId } from "@/lib/products/resolve";
import { sansBloquer } from "@/lib/journal";

const MODULE = "BUSINESS_DEVELOPMENT" as const;
const BASE = "/business-development/etudes";

/**
 * NOTRE PRODUIT, quand la molécule saisie le désigne CERTAINEMENT (lien L10, lot « mémoire ») — sinon `null` : une ligne
 * d'étude parle le plus souvent du marché (concurrents, molécules), et une ambiguïté ne se tranche pas en silence. Jamais
 * bloquant : une résolution en panne laisse la ligne sans produit.
 */
const produitCertain = (mention: string | null | undefined): Promise<string | null> =>
  mention?.trim() ? resolveProductId(mention).catch(sansBloquer("market-research-actions.resolveProductId", null)) : Promise.resolve(null);

function num(fd: FormData, key: string): number | null {
  const v = fd.get(key);
  if (v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────── Étude ───────────────────────────
export async function createMarketResearch(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Le titre de l'étude est obligatoire." };
  const research = await prisma.marketResearch.create({ data: { title, notes: fdStr(formData, "notes"), sources: fdStr(formData, "sources") || DEFAULT_RESEARCH_SOURCES, createdById: user.id } });

  // Molécules initiales (une par ligne) → une ligne de tableau par molécule.
  const molecules = (fdStr(formData, "molecules") ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (molecules.length) {
    await prisma.marketResearchRow.createMany({
      data: await Promise.all(molecules.map(async (product, i) => ({ researchId: research.id, product, productId: await produitCertain(product), sortOrder: i }))),
    });
  }
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Business Development", summary: `Étude de marché « ${title} »` });
  revalidatePath(BASE);
  return { ok: true, id: research.id };
}

export async function updateMarketResearch(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Étude introuvable." };
  await prisma.marketResearch.update({
    where: { id },
    data: {
      title: fdStr(formData, "title") ?? undefined,
      status: (fdStr(formData, "status") as MarketResearchStatus) ?? undefined,
      notes: fdStr(formData, "notes"),
      sources: fdStr(formData, "sources"),
    },
  });
  revalidatePath(`${BASE}/${id}`);
  revalidatePath(BASE);
  return { ok: true };
}

/** Participants (collaborateurs) d'une étude de marché. */
export async function setMarketResearchParticipants(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Étude introuvable." };
  const participantIds = formData.getAll("participantIds").map(String).filter(Boolean);
  await prisma.marketResearch.update({ where: { id }, data: { participantIds } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Business Development", summary: `Participants de l'étude — ${participantIds.length}` });
  revalidatePath(`${BASE}/${id}`);
  return { ok: true };
}

export async function deleteMarketResearch(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Étude introuvable." };
  await prisma.marketResearch.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Business Development", summary: "Étude de marché supprimée" });
  revalidatePath(BASE);
  return { ok: true };
}

// ─────────────────────────── Lignes (produits / molécules) ───────────────────────────
export async function addResearchRow(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const researchId = fdStr(formData, "researchId");
  if (!researchId) return { ok: false, error: "Étude introuvable." };
  const count = await prisma.marketResearchRow.count({ where: { researchId } });
  const product = fdStr(formData, "product");
  const row = await prisma.marketResearchRow.create({
    data: { researchId, product: product || "Nouveau produit", productId: await produitCertain(product), sortOrder: count },
  });
  revalidatePath(`${BASE}/${researchId}`);
  return { ok: true, id: row.id };
}

export async function updateResearchRow(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const researchId = fdStr(formData, "researchId");
  if (!id) return { ok: false, error: "Ligne introuvable." };
  const product = fdStr(formData, "product");
  await prisma.marketResearchRow.update({
    where: { id },
    data: {
      therapeuticClass: fdStr(formData, "therapeuticClass"),
      product: product ?? undefined,
      // La molécule change : le rattachement suit (jamais un produit d'avant sur un texte nouveau).
      ...(product ? { productId: await produitCertain(product) } : {}),
      marketVolume: num(formData, "marketVolume"),
      marketValueUsd: num(formData, "marketValueUsd"),
      avgPricePerBoxUsd: num(formData, "avgPricePerBoxUsd"),
      comment: fdStr(formData, "comment"),
    },
  });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true };
}

export async function deleteResearchRow(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const researchId = fdStr(formData, "researchId");
  if (!id) return { ok: false, error: "Ligne introuvable." };
  await prisma.marketResearchRow.delete({ where: { id } });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true };
}

// ─────────────────────────── Acteurs du marché ───────────────────────────
export async function addResearchPlayer(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const rowId = fdStr(formData, "rowId");
  const researchId = fdStr(formData, "researchId");
  if (!rowId) return { ok: false, error: "Ligne introuvable." };
  const count = await prisma.marketResearchPlayer.count({ where: { rowId } });
  const player = await prisma.marketResearchPlayer.create({
    data: { rowId, rank: count + 1, name: fdStr(formData, "name") || `Acteur ${count + 1}` },
  });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true, id: player.id };
}

export async function updateResearchPlayer(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const researchId = fdStr(formData, "researchId");
  if (!id) return { ok: false, error: "Acteur introuvable." };
  const statusRaw = fdStr(formData, "status");
  await prisma.marketResearchPlayer.update({
    where: { id },
    data: {
      name: fdStr(formData, "name") ?? undefined,
      marketShareValue: num(formData, "marketShareValue"),
      status: statusRaw === "IMPORT" || statusRaw === "MANUFACTURING" ? (statusRaw as PlayerStatus) : null,
    },
  });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true };
}

export async function deleteResearchPlayer(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const researchId = fdStr(formData, "researchId");
  if (!id) return { ok: false, error: "Acteur introuvable." };
  await prisma.marketResearchPlayer.delete({ where: { id } });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true };
}

// ─────────────────────── Pré-remplissage depuis l'intelligence marché (Pharmatool) ───────────────────────
/**
 * Rapproche le produit de la ligne d'une DCI de l'intelligence marché (IQVIA + PCH + Nomenclature)
 * et remplit automatiquement : marché (volume/valeur), prix moyen, et les acteurs (fabricants locaux
 * → Fabrication, importateurs → Importation) avec l'état d'enregistrement à la nomenclature.
 */
export async function prefillResearchRow(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const researchId = fdStr(formData, "researchId");
  if (!id) return { ok: false, error: "Ligne introuvable." };
  const row = await prisma.marketResearchRow.findUnique({ where: { id }, include: { players: { select: { id: true } } } });
  if (!row) return { ok: false, error: "Ligne introuvable." };

  const recs = getRecommendations();
  const q = normText(row.product);
  const qt = queryTokens(q);
  let best: RecRow | undefined = recs.find((r) => r.key === q);
  if (!best && qt.length) {
    const cands = recs.filter((r) => allTokensIn(r.key, qt) || (r.key && allTokensIn(q, queryTokens(r.key))));
    best = cands.sort((a, b) => b.valueUsd - a.valueUsd)[0];
  }
  if (!best) return { ok: false, error: "Aucune correspondance marché trouvée pour ce produit." };

  const avg = best.volume > 0 ? Math.round((best.valueUsd / best.volume) * 100) / 100 : null;
  await prisma.marketResearchRow.update({
    where: { id },
    data: {
      marketVolume: best.volume ? Math.round(best.volume) : null,
      marketValueUsd: best.valueUsd ? Math.round(best.valueUsd) : null,
      avgPricePerBoxUsd: avg,
      comment: row.comment || `Nomenclature : ${best.nomLines} ligne(s) · ${best.manufacturers} fabricant(s) / ${best.importers} importateur(s) · ${best.recommendation}`,
    },
  });

  // Acteurs à partir des laboratoires détectés — uniquement si la ligne n'en a pas encore.
  if (row.players.length === 0) {
    const mfg = best.mfgLabs.split(";").map((s) => s.trim()).filter(Boolean);
    const imp = best.impLabs.split(";").map((s) => s.trim()).filter(Boolean);
    let rank = 1;
    const data = [
      ...mfg.map((name) => ({ rowId: id, rank: rank++, name, status: "MANUFACTURING" as const })),
      ...imp.map((name) => ({ rowId: id, rank: rank++, name, status: "IMPORT" as const })),
    ];
    if (data.length) await prisma.marketResearchPlayer.createMany({ data });
  }

  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Business Development", summary: `Pré-remplissage marché — ${row.product}` });
  if (researchId) revalidatePath(`${BASE}/${researchId}`);
  return { ok: true };
}
