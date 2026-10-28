"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { importerConsommation, confirmerCorrespondance, ignorerLigne, validerImport, annulerImport, type ResultatAnalyse } from "@/modules/consommation/api";

/**
 * CONSUMPTION INTELLIGENCE — les gestes : importer (analyse, rien ne compte encore), confirmer une correspondance
 * (mémorisée), écarter une ligne, VALIDER (les lignes OK comptent), annuler, régler l'affinité d'un produit.
 * Chaque geste est tracé au journal d'audit.
 */

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const MODULE = "CONSUMPTION";
const CHEMIN = "/consommation";

async function exiger(action: "UPLOAD" | "UPDATE" | "VALIDATE") {
  const user = await requireUser();
  return { user, refus: userCan(user, MODULE, action) ? null : "Action non autorisée sur la consommation (Administration › Accès)." };
}

export async function importerFichierConsommation(fd: FormData): Promise<ResultatAnalyse> {
  const { user, refus } = await exiger("UPLOAD");
  if (refus) return { ok: false, error: refus };
  const f = fd.get("fichier");
  if (!f || typeof f === "string") return { ok: false, error: "Choisissez un fichier." };
  try {
    const r = await importerConsommation(user.id, Buffer.from(await f.arrayBuffer()), f.name || "consommation.xlsx");
    if (r.ok) {
      await recordAudit({ actorId: user.id, action: "IMPORT", module: MODULE, entityId: r.importId, summary: `Consommation importée « ${f.name} » : ${r.lignes} ligne(s), ${r.ok_} sûre(s), ${r.aRevoir} à revoir, ${r.doublons} doublon(s).` });
      revalidatePath(CHEMIN);
    }
    return r;
  } catch (e) {
    return { ok: false, error: `Lecture du fichier impossible : ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function confirmerCorrespondanceConso(input: { importId: string; nature: "ETABLISSEMENT" | "PRODUIT"; brut: string; cibleId: string }): Promise<R<{ lignes: number }>> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  if (input.nature !== "ETABLISSEMENT" && input.nature !== "PRODUIT") return { ok: false, error: "Nature inconnue." };
  const r = await confirmerCorrespondance(user.id, input.importId, input.nature, input.brut, input.cibleId);
  if (r.ok) {
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: input.importId, field: input.nature === "ETABLISSEMENT" ? "etablissement" : "produit", oldValue: input.brut, newValue: input.cibleId, summary: `Correspondance confirmée et mémorisée : « ${input.brut} » (${r.lignes} ligne(s)).` });
    revalidatePath(`${CHEMIN}/${input.importId}`);
  }
  return r;
}

export async function ignorerLigneConso(importId: string, ligneId: string): Promise<R> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  const l = await prisma.consommationLigne.findFirst({ where: { id: ligneId, importId, import: { statut: "EN_REVUE" } }, select: { id: true, ligneSource: true } });
  if (!l) return { ok: false, error: "Ligne introuvable, ou import plus en revue." };
  await ignorerLigne(ligneId);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: importId, summary: `Ligne ${l.ligneSource} écartée (gardée, marquée « ignorée »).` });
  revalidatePath(`${CHEMIN}/${importId}`);
  return { ok: true };
}

export async function validerImportConso(importId: string): Promise<R<{ comptees: number; exclues: number }>> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const r = await validerImport(user.id, importId);
  if (r.ok) {
    await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE, entityId: importId, summary: `Import de consommation validé : ${r.comptees} ligne(s) comptée(s), ${r.exclues} exclue(s).` });
    revalidatePath(CHEMIN);
    revalidatePath("/segmentation");
  }
  return r;
}

export async function annulerImportConso(importId: string): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  await annulerImport(importId);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: importId, summary: "Import de consommation annulé : ses lignes ne comptent plus (gardées)." });
  revalidatePath(CHEMIN);
  revalidatePath("/segmentation");
  return { ok: true };
}

/** RÉGLER L'AFFINITÉ D'UN PRODUIT : le panier du marché (produits et/ou molécules) et la période. */
export async function enregistrerAffiniteConfig(input: { productId: string; productIds: string[]; molecules: string; periode: string; debut: string; fin: string }): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const periodes = ["MOIS", "ROLLING_3M", "ROLLING_6M", "ROLLING_12M", "PERSONNALISEE"];
  if (!periodes.includes(input.periode)) return { ok: false, error: "Période inconnue." };
  const produit = await prisma.product.findUnique({ where: { id: input.productId }, select: { canonicalName: true } });
  if (!produit) return { ok: false, error: "Produit introuvable." };
  const molecules = input.molecules.split(/[,;\n]/).map((m) => m.trim()).filter(Boolean);
  const productIds = [...new Set(input.productIds.filter((p) => p && p !== input.productId))];
  if (productIds.length === 0 && molecules.length === 0) return { ok: false, error: "Le marché (dénominateur) est vide : choisissez des produits ou des molécules." };
  const debut = input.periode === "PERSONNALISEE" && input.debut ? new Date(`${input.debut}T00:00:00Z`) : null;
  const fin = input.periode === "PERSONNALISEE" && input.fin ? new Date(`${input.fin}T00:00:00Z`) : null;
  if (input.periode === "PERSONNALISEE" && (!debut || !fin || debut > fin)) return { ok: false, error: "Période personnalisée incomplète." };
  const data = { panier: { productIds, molecules }, periode: input.periode, debut, fin, updatedById: user.id };
  await prisma.affiniteConfig.upsert({ where: { productId: input.productId }, update: data, create: { productId: input.productId, ...data } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "affinite", newValue: JSON.stringify({ productIds, molecules, periode: input.periode }), summary: `Affinité de ${produit.canonicalName} réglée (marché : ${productIds.length} produit(s), ${molecules.length} molécule(s) ; ${input.periode}).` });
  revalidatePath(`${CHEMIN}/affinite`);
  revalidatePath("/segmentation");
  return { ok: true };
}
