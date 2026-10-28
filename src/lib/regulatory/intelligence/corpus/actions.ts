"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regCan } from "../access";
import { regAudit } from "../audit";
import { splitIntoSections } from "./import";
import { ingestCorpusFile, type FileIngestResult } from "./ingest-file";
import { searchCorpus, type Citation } from "./rag";
import { regulatoryKnowledgeDigest } from "@/lib/regulatory/anpp-knowledge";
import { sansBloquer } from "@/lib/journal";

/**
 * Administration du CORPUS réglementaire versionné (G3). **Super Admin / corpus.manage.**
 * Import → sections (RAG), approbation, activation (ACTIVE = fait foi), retrait — tracés.
 */

interface Result { ok: boolean; error?: string; id?: string }

const str = (fd: FormData, k: string) => { const v = fd.get(k); return v ? String(v).trim() : null; };

// Le corpus est RÉSERVÉ AU SUPER ADMIN : il fait foi pour les analyses de toutes les entités —
// c'est un acte d'administration, pas une permission de module.
function canManage(user: { role: string }): boolean {
  return user.role === "SUPER_ADMIN";
}

export async function createCorpusSourceVersion(formData: FormData): Promise<Result> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé à l'administration du corpus." };

  const authority = str(formData, "authority") ?? "ANPP";
  const jurisdiction = str(formData, "jurisdiction") ?? "DZ";
  const code = str(formData, "code");
  const title = str(formData, "title");
  const version = str(formData, "version") ?? "1.0";
  const text = str(formData, "text");
  const sourceUrl = str(formData, "sourceUrl");
  if (!code || !title || !text) return { ok: false, error: "Code, titre et texte sont obligatoires." };

  const sections = splitIntoSections(text);
  if (sections.length === 0) return { ok: false, error: "Aucune section détectée dans le texte." };
  const hash = createHash("sha256").update(text).digest("hex");

  const source = await prisma.regulatorySource.create({
    data: { authority, jurisdiction, code, title, sourceUrl: sourceUrl || null, createdById: user.id },
    select: { id: true },
  });
  const sv = await prisma.regulatorySourceVersion.create({
    data: { sourceId: source.id, version, status: "DRAFT", hash, originalText: text.slice(0, 500_000) },
    select: { id: true },
  });
  await prisma.regulatorySourceSection.createMany({
    data: sections.map((s) => ({ sourceVersionId: sv.id, path: s.path, heading: s.heading, text: s.text, ordinal: s.ordinal })),
  });
  await regAudit({ actorId: user.id, action: "CORPUS_IMPORTED", detail: `Source « ${code} » v${version} importée (${sections.length} sections).` });
  revalidatePath("/admin/regulatory-corpus");
  return { ok: true, id: sv.id };
}

/**
 * IMPORT D'UN FICHIER dans le corpus — **un fichier par appel**, et c'est délibéré.
 *
 * Envoyer cinquante PDF dans une seule requête, c'est cinquante documents en mémoire au même
 * instant, une requête de plusieurs centaines de mégaoctets, et un « échec » global si l'un
 * d'eux se passe mal — sans savoir lequel. Un fichier par appel donne exactement l'inverse : la
 * mémoire ne dépend jamais du nombre de fichiers, un fichier fautif n'emporte pas les autres, et
 * l'écran peut dire, pour CHACUN, ce qui lui est arrivé.
 *
 * Le client enchaîne les appels avec une petite concurrence (voir `corpus-import.tsx`).
 */
export async function importCorpusFileAction(formData: FormData): Promise<FileIngestResult> {
  const user = await requireUser();
  if (!canManage(user)) return { filename: "", status: "FAILED", error: "Réservé à l'administration du corpus." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { filename: String(formData.get("filename") ?? ""), status: "FAILED", error: "Fichier vide ou absent." };
  }

  const res = await ingestCorpusFile({
    filename: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
    authority: str(formData, "authority"),
    jurisdiction: str(formData, "jurisdiction"),
    category: str(formData, "category"),
    language: str(formData, "language"),
    userId: user.id,
  });

  // On ne trace QUE ce qui change l'état du corpus : un doublon n'est pas un événement, et un
  // journal saturé de « rien n'a changé » cesse d'être lu.
  if (res.status === "INGESTED") {
    await regAudit({
      actorId: user.id, action: "CORPUS_IMPORTED",
      detail: `Texte importé : « ${res.filename} » — ${res.sections ?? 0} section(s), ${res.chars ?? 0} caractères. ACTIF : utilisé par toutes les analyses dès maintenant.`,
    }).catch(sansBloquer("corpus-actions.importCorpusFileAction.regAudit"));
    revalidatePath("/regulatory/enregistrement/corpus");
  }
  return res;
}

export async function setCorpusVersionStatus(formData: FormData): Promise<Result> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé à l'administration du corpus." };
  const sourceVersionId = str(formData, "sourceVersionId");
  const status = str(formData, "status"); // DRAFT | ACTIVE | RETIRED
  const note = str(formData, "note");
  if (!sourceVersionId || !status || !["DRAFT", "ACTIVE", "RETIRED"].includes(status)) return { ok: false, error: "Paramètres invalides." };

  const sv = await prisma.regulatorySourceVersion.findUnique({ where: { id: sourceVersionId }, select: { id: true, sourceId: true, version: true, source: { select: { code: true } } } });
  if (!sv) return { ok: false, error: "Version introuvable." };

  // Activer une version retire les autres versions ACTIVE de la même source.
  if (status === "ACTIVE") {
    await prisma.regulatorySourceVersion.updateMany({ where: { sourceId: sv.sourceId, status: "ACTIVE", id: { not: sourceVersionId } }, data: { status: "RETIRED" } });
  }
  await prisma.regulatorySourceVersion.update({
    where: { id: sourceVersionId },
    data: { status: status as "DRAFT" | "ACTIVE" | "RETIRED", approvedById: status === "ACTIVE" ? user.id : undefined, approvedAt: status === "ACTIVE" ? new Date() : undefined },
  });
  await prisma.regulatoryCorpusApproval.create({
    data: { sourceVersionId, approverId: user.id, decision: status === "ACTIVE" ? "ACTIVATED" : status === "RETIRED" ? "RETIRED" : "DRAFT", note: note ?? null },
  });
  await regAudit({ actorId: user.id, action: `CORPUS_${status}`, detail: `Source « ${sv.source.code} » v${sv.version} → ${status}.` });
  revalidatePath("/admin/regulatory-corpus");
  return { ok: true };
}

/** Recherche RAG de test (admin) — renvoie des citations du corpus actif. */
export async function searchCorpusAction(formData: FormData): Promise<{ ok: boolean; citations: Citation[] }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, citations: [] };
  const q = str(formData, "q") ?? "";
  return { ok: true, citations: await searchCorpus(q, { limit: 8 }) };
}

/** Amorce le corpus avec le référentiel ANPP (legacy anpp-knowledge) — idempotent. */
export async function seedAnppCorpus(): Promise<Result> {
  const user = await requireUser();
  if (!canManage(user)) return { ok: false, error: "Réservé à l'administration du corpus." };

  const code = "ANPP — Référentiel intégré (legacy)";
  const existing = await prisma.regulatorySource.findFirst({ where: { code }, select: { id: true } });
  if (existing) return { ok: false, error: "Le corpus ANPP de base est déjà importé." };

  const text = regulatoryKnowledgeDigest();
  const sections = splitIntoSections(text);
  const hash = createHash("sha256").update(text).digest("hex");

  const source = await prisma.regulatorySource.create({ data: { authority: "ANPP", jurisdiction: "DZ", code, title: "Référentiel réglementaire ANPP (Algérie) — base intégrée", language: "fr", createdById: user.id }, select: { id: true } });
  const sv = await prisma.regulatorySourceVersion.create({ data: { sourceId: source.id, version: "1.0", status: "ACTIVE", hash, originalText: text.slice(0, 500_000), approvedById: user.id, approvedAt: new Date() }, select: { id: true } });
  await prisma.regulatorySourceSection.createMany({ data: sections.map((s) => ({ sourceVersionId: sv.id, path: s.path, heading: s.heading, text: s.text, ordinal: s.ordinal })) });
  await prisma.regulatoryCorpusApproval.create({ data: { sourceVersionId: sv.id, approverId: user.id, decision: "ACTIVATED", note: "Amorçage du référentiel ANPP intégré." } });
  await regAudit({ actorId: user.id, action: "CORPUS_SEEDED", detail: `Corpus ANPP amorcé (${sections.length} sections, ACTIVE).` });
  revalidatePath("/admin/regulatory-corpus");
  return { ok: true, id: sv.id };
}
