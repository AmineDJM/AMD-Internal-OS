"use server";

import { revalidatePath } from "next/cache";
import type { RegCaseOutcome } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regAudit } from "../audit";
import { ingestCaseArchive, ingestCaseFile } from "./ingest-case";
import type { FileIngestResult } from "../corpus/import-formats";
import { sansBloquer } from "@/lib/journal";

/**
 * MODULE « ENTRAÎNEMENT IA » — actions serveur, SUPER ADMIN UNIQUEMENT.
 *
 * Chaque étude de cas déposée ici rend l'analyseur meilleur au prochain dossier : ses extraits
 * sont injectés comme PRÉCÉDENTS dans toutes les analyses (voies immédiate et différée), avec
 * l'issue réelle prononcée par l'ANPP et la leçon retenue. C'est de l'apprentissage par
 * l'exemple — pas un ré-entraînement du modèle : la connaissance reste DANS NOTRE BASE,
 * citée mot à mot, retirable à tout instant.
 */

interface Result { ok: boolean; error?: string; id?: string }

const OUTCOMES: RegCaseOutcome[] = ["ACCEPTED", "ACCEPTED_WITH_RESERVES", "REJECTED", "UNKNOWN"];
const str = (fd: FormData, k: string) => { const v = fd.get(k); return v ? String(v).trim() : null; };
const PATH = "/regulatory/enregistrement/entrainement";

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé à l'administrateur." };
  return { ok: true, userId: user.id };
}

export async function createCaseStudy(formData: FormData): Promise<Result> {
  const g = await guard();
  if (!g.ok) return g;
  const title = str(formData, "title");
  if (!title) return { ok: false, error: "Le titre de l'étude de cas est obligatoire (produit + année, par exemple)." };
  const outcomeRaw = str(formData, "outcome") as RegCaseOutcome | null;

  const cs = await prisma.regulatoryCaseStudy.create({
    data: {
      title: title.slice(0, 200),
      productName: str(formData, "productName"),
      outcome: outcomeRaw && OUTCOMES.includes(outcomeRaw) ? outcomeRaw : "UNKNOWN",
      lesson: str(formData, "lesson"),
      createdById: g.userId,
    },
    select: { id: true },
  });
  await regAudit({ actorId: g.userId, action: "TRAINING_CASE_CREATED", detail: `Étude de cas « ${title} » créée (entraînement IA).` }).catch(sansBloquer("training-actions.createCaseStudy.regAudit"));
  revalidatePath(PATH);
  return { ok: true, id: cs.id };
}

export async function updateCaseStudy(formData: FormData): Promise<Result> {
  const g = await guard();
  if (!g.ok) return g;
  const caseId = str(formData, "caseId");
  if (!caseId) return { ok: false, error: "Étude de cas manquante." };
  const outcomeRaw = str(formData, "outcome") as RegCaseOutcome | null;
  const existing = await prisma.regulatoryCaseStudy.findUnique({ where: { id: caseId }, select: { id: true, title: true } });
  if (!existing) return { ok: false, error: "Étude de cas introuvable." };

  await prisma.regulatoryCaseStudy.update({
    where: { id: caseId },
    data: {
      ...(outcomeRaw && OUTCOMES.includes(outcomeRaw) ? { outcome: outcomeRaw } : {}),
      lesson: str(formData, "lesson"),
    },
  });
  await regAudit({ actorId: g.userId, action: "TRAINING_CASE_UPDATED", detail: `Étude de cas « ${existing.title} » mise à jour (issue/leçon).` }).catch(sansBloquer("training-actions.updateCaseStudy.regAudit"));
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteCaseStudy(formData: FormData): Promise<Result> {
  const g = await guard();
  if (!g.ok) return g;
  const caseId = str(formData, "caseId");
  if (!caseId) return { ok: false, error: "Étude de cas manquante." };
  const existing = await prisma.regulatoryCaseStudy.findUnique({ where: { id: caseId }, select: { id: true, title: true } });
  if (!existing) return { ok: false, error: "Étude de cas introuvable." };

  await prisma.regulatoryCaseStudy.delete({ where: { id: caseId } }); // documents en cascade
  await regAudit({ actorId: g.userId, action: "TRAINING_CASE_DELETED", detail: `Étude de cas « ${existing.title} » supprimée — ses précédents ne seront plus injectés.` }).catch(sansBloquer("training-actions.deleteCaseStudy.regAudit"));
  revalidatePath(PATH);
  return { ok: true };
}

/** Un fichier à la fois — mêmes raisons que le corpus (mémoire bornée, verdict par fichier). */
export async function importCaseFileAction(formData: FormData): Promise<FileIngestResult & { children?: FileIngestResult[] }> {
  const g = await guard();
  if (!g.ok) return { filename: "", status: "FAILED", error: g.error };
  const caseId = str(formData, "caseId");
  const file = formData.get("file");
  if (!caseId) return { filename: "", status: "FAILED", error: "Étude de cas manquante." };
  if (!(file instanceof File) || file.size === 0) return { filename: String(formData.get("filename") ?? ""), status: "FAILED", error: "Fichier vide ou absent." };
  const cs = await prisma.regulatoryCaseStudy.findUnique({ where: { id: caseId }, select: { id: true, title: true } });
  if (!cs) return { filename: file.name, status: "FAILED", error: "Étude de cas introuvable." };

  const buffer = Buffer.from(await file.arrayBuffer());

  // UNE ARCHIVE ZIP = le dossier du produit passé déposé TEL QUEL. Elle est dézippée côté
  // serveur (inspection sécurisée) et chaque pièce est ingérée une à une — verdict par pièce.
  if (/\.zip$/i.test(file.name)) {
    const children = await ingestCaseArchive({ caseId: cs.id, filename: file.name, buffer });
    const ingested = children.filter((c) => c.status === "INGESTED").length;
    const unchanged = children.filter((c) => c.status === "UNCHANGED").length;
    const failed = children.length - ingested - unchanged;
    if (ingested > 0) {
      await regAudit({
        actorId: g.userId, action: "TRAINING_DOC_INGESTED",
        detail: `Entraînement IA : archive « ${file.name} » dépliée dans « ${cs.title} » — ${ingested} pièce(s) ingérée(s), ${unchanged} déjà connue(s), ${failed} refusée(s).`,
      }).catch(sansBloquer("training-actions.importCaseFileAction.regAudit"));
      revalidatePath(PATH);
    }
    return {
      filename: file.name,
      status: ingested > 0 ? "INGESTED" : unchanged > 0 ? "UNCHANGED" : "FAILED",
      sections: children.reduce((n, c) => n + (c.sections ?? 0), 0),
      error: failed > 0 ? `${failed} pièce(s) refusée(s) — détail ci-dessous.` : undefined,
      children,
    };
  }

  const res = await ingestCaseFile({ caseId: cs.id, filename: file.name, buffer });
  if (res.status === "INGESTED") {
    await regAudit({
      actorId: g.userId, action: "TRAINING_DOC_INGESTED",
      detail: `Entraînement IA : pièce « ${res.filename} » ajoutée à « ${cs.title} » (${res.sections ?? 0} section(s) CTD repérée(s)).`,
    }).catch(sansBloquer("training-actions.importCaseFileAction.regAudit"));
    revalidatePath(PATH);
  }
  return res;
}
