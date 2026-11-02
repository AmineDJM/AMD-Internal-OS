"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "../access";
import { regAudit } from "../audit";
import { ingestReserveDocument } from "./library-ingest";
import { findSimilarReserves, reserveRisk, proposeRules } from "./library";

/**
 * BIBLIOTHÈQUE DES RÉSERVES ANPP — actions serveur.
 *
 * Toutes gardées par `regulatory.reserve.manage` et bornées à l'organisation. Toutes tracées
 * dans le journal d'audit du module : une réserve est une pièce réglementaire, on doit pouvoir
 * dire qui l'a importée, qui l'a corrigée et quand.
 *
 * ⚠️ La règle qui structure ce fichier : **aucune règle dérivée ne devient opposable sans
 * validation humaine explicite.** `validateDerivedRule` est le seul chemin qui fait passer une
 * proposition à l'état VALIDATED, et il exige un humain autorisé.
 */

interface Result { ok: boolean; error?: string; message?: string }

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 Mo : une lettre scannée reste raisonnable

async function guard(): Promise<{ ok: true; userId: string; companyId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!regCan(user, "regulatory.reserve.manage") && user.role !== "SUPER_ADMIN") return { ok: false, error: "Non autorisé." };
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return { ok: false, error: "Module non activé pour cette entité." };
  return { ok: true, userId: user.id, companyId };
}

const str = (fd: FormData, k: string): string | null => {
  const v = fd.get(k);
  const s = v ? String(v).trim() : "";
  return s.length > 0 ? s : null;
};

// ───────────────────────────── Import ─────────────────────────────

export interface ImportResult extends Result {
  batchId?: string;
  reserveCount?: number;
  duplicate?: boolean;
  costUsd?: number;
  method?: string;
}

/**
 * Importe une lettre de réserves (PDF, scan, Word, Excel, courriel exporté, texte).
 * Le fichier d'origine est conservé chiffré : la preuve doit rester vérifiable.
 */
export async function importReserveLetter(formData: FormData): Promise<ImportResult> {
  try {
    const g = await guard();
    if (!g.ok) return g;

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez le fichier de la lettre de réserves." };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "Fichier trop volumineux (40 Mo maximum)." };

    const res = await ingestReserveDocument({
      filename: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      createdById: g.userId,
      companyId: g.companyId,
      dossierId: str(formData, "dossierId"),
      sourceCycleId: str(formData, "cycleId"),
    });
    if (!res.ok) return { ok: false, error: res.error };

    await regAudit({
      companyId: g.companyId, actorId: g.userId, dossierId: str(formData, "dossierId"),
      action: "RESERVE_LIBRARY_IMPORT",
      detail: res.duplicate
        ? `Lettre « ${file.name} » déjà importée — aucun nouveau traitement.`
        : `Lettre « ${file.name} » importée (${res.reserveCount} réserve(s), lecture ${res.method}, ${(res.costUsd ?? 0).toFixed(4)} $).`,
    });

    revalidatePath("/regulatory/reserves");
    return {
      ok: true, batchId: res.batchId, reserveCount: res.reserveCount,
      duplicate: res.duplicate, costUsd: res.costUsd, method: res.method,
      message: res.duplicate
        ? "Cette lettre avait déjà été importée : rien n'a été recalculé."
        : `${res.reserveCount} réserve(s) extraite(s).`,
    };
  } catch (err) {
    console.error("[reserves] import impossible", err);
    return { ok: false, error: "Import impossible." };
  }
}

/**
 * Colle le texte d'une réserve reçue par courriel. Même chemin d'extraction, sans fichier —
 * parce qu'en pratique beaucoup de réserves arrivent dans le corps d'un message.
 */
export async function importReserveText(formData: FormData): Promise<ImportResult> {
  try {
    const g = await guard();
    if (!g.ok) return g;
    const text = str(formData, "text");
    if (!text || text.length < 40) return { ok: false, error: "Collez le texte de la lettre (40 caractères minimum)." };
    const label = str(formData, "label") ?? "Réserves (texte collé)";

    const res = await ingestReserveDocument({
      filename: `${label}.txt`,
      buffer: Buffer.from(text, "utf8"),
      createdById: g.userId,
      companyId: g.companyId,
      dossierId: str(formData, "dossierId"),
    });
    if (!res.ok) return { ok: false, error: res.error };

    await regAudit({
      companyId: g.companyId, actorId: g.userId,
      action: "RESERVE_LIBRARY_IMPORT",
      detail: `Texte de réserves importé (${res.reserveCount} réserve(s)).`,
    });
    revalidatePath("/regulatory/reserves");
    return { ok: true, batchId: res.batchId, reserveCount: res.reserveCount, duplicate: res.duplicate, costUsd: res.costUsd };
  } catch (err) {
    console.error("[reserves] import texte impossible", err);
    return { ok: false, error: "Import impossible." };
  }
}

// ───────────────────────────── Consultation ─────────────────────────────

/** Réserves similaires à un texte — les précédents, avec leur preuve. */
export async function similarReserves(text: string, filters?: { ctdModule?: string; ctdSection?: string; dci?: string; supplier?: string }) {
  const g = await guard();
  if (!g.ok) return [];
  return findSimilarReserves(text, filters ?? {});
}

/** Probabilité qu'une réserve de ce type revienne — une INDICATION, jamais une prédiction. */
export async function riskOfReserve(text: string, filters?: { ctdModule?: string; dci?: string; supplier?: string }) {
  const g = await guard();
  if (!g.ok) return null;
  return reserveRisk(text, filters ?? {});
}

// ───────────────────────────── Règles dérivées ─────────────────────────────

/**
 * Propose des règles à partir des réserves récurrentes — et les enregistre au statut PROPOSED,
 * c'est-à-dire **sans aucun effet**. Rien n'est opposable tant qu'un humain n'a pas validé.
 */
export async function refreshDerivedRules(): Promise<Result & { proposed?: number }> {
  try {
    const g = await guard();
    if (!g.ok) return g;

    const proposals = await proposeRules();
    let created = 0;
    for (const p of proposals) {
      // On ne repropose pas une règle déjà tranchée (validée ou rejetée) : le travail humain
      // ne doit pas être noyé sous des propositions répétées.
      const existing = await prisma.anppDerivedRule.findFirst({
        where: { category: p.category, ctdModule: p.ctdModule, ctdSection: p.ctdSection },
        select: { id: true, status: true },
      });
      if (existing) {
        if (existing.status === "PROPOSED") {
          await prisma.anppDerivedRule.update({
            where: { id: existing.id },
            data: { occurrences: p.occurrences, confidence: p.confidence, evidenceReserveIds: p.evidenceReserveIds, statement: p.statement },
          });
        }
        continue;
      }
      await prisma.anppDerivedRule.create({
        data: {
          title: p.title, statement: p.statement, ctdModule: p.ctdModule, ctdSection: p.ctdSection,
          category: p.category, severity: p.severity, evidenceReserveIds: p.evidenceReserveIds,
          occurrences: p.occurrences, confidence: p.confidence, status: "PROPOSED",
        },
      });
      created++;
    }

    await regAudit({
      companyId: g.companyId, actorId: g.userId,
      action: "RESERVE_RULES_PROPOSED",
      detail: `${created} nouvelle(s) règle(s) proposée(s) — aucune n'est active tant qu'elle n'est pas validée.`,
    });
    revalidatePath("/regulatory/reserves");
    return { ok: true, proposed: created, message: `${created} règle(s) proposée(s), en attente de votre validation.` };
  } catch (err) {
    console.error("[reserves] proposition de règles impossible", err);
    return { ok: false, error: "Proposition de règles impossible." };
  }
}
