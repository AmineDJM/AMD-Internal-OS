import { prisma } from "@/lib/prisma";
import { releaseBlob } from "@/lib/drive-storage";
import type { ArtifactSpec } from "./types";

/**
 * Le MANIFESTE — cœur de sûreté du Test Center (§9, §22).
 *
 * INVARIANT ABSOLU : on ne supprime JAMAIS une donnée par son nom ou son préfixe ; on ne
 * supprime QUE les enregistrements dont l'ID exact a été inscrit au manifeste par CE run.
 * Le nettoyage se fait en ordre INVERSE de dépendance, puis on VÉRIFIE que chaque ID a
 * bien disparu (re-requête base + stockage).
 */

// Suppresseurs typés par modèle Prisma. On n'ajoute un modèle ici QUE lorsqu'on sait le
// créer et le supprimer proprement — jamais de suppression « devinée ».
const DELETERS: Record<string, (id: string) => Promise<unknown>> = {
  user: (id) => prisma.user.delete({ where: { id } }),
};

// Vérificateurs d'existence (post-nettoyage) par modèle.
const EXISTS: Record<string, (id: string) => Promise<boolean>> = {
  user: async (id) => (await prisma.user.count({ where: { id } })) > 0,
};

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2025";
}

/** Inscrit une ressource créée au manifeste du run (à faire IMMÉDIATEMENT après création). */
export async function recordArtifact(testRunId: string, spec: ArtifactSpec): Promise<string> {
  const a = await prisma.testArtifact.create({
    data: {
      testRunId,
      resourceType: spec.resourceType,
      model: spec.model ?? null,
      recordId: spec.recordId,
      blobKey: spec.blobKey ?? null,
      dependsOn: spec.dependsOn ?? [],
      deleteMethod: spec.deleteMethod ?? "prisma",
    },
    select: { id: true },
  });
  return a.id;
}

async function deleteOne(model: string | null, recordId: string, deleteMethod: string, blobKey: string | null): Promise<string> {
  try {
    if (deleteMethod === "noop") return "noop";
    if (deleteMethod === "blob") {
      if (blobKey) await releaseBlob(blobKey);
      return "deleted";
    }
    if (!model || !DELETERS[model]) return `error: modèle non supprimable « ${model ?? "?"} » (suppression refusée par sécurité)`;
    await DELETERS[model](recordId);
    return "deleted";
  } catch (e) {
    if (isNotFound(e)) return "already-absent";
    return `error: ${(e as Error).message}`.slice(0, 200);
  }
}

export interface CleanupResult { attempted: number; deleted: number; errors: number; details: { recordId: string; result: string }[] }

/**
 * Nettoie toutes les ressources du run, en ordre inverse de dépendance (les ressources
 * dont dépendent d'autres sont supprimées EN DERNIER). N'agit que sur le manifeste du run.
 */
export async function cleanupRun(testRunId: string): Promise<CleanupResult> {
  const pending = await prisma.testArtifact.findMany({ where: { testRunId, deletedAt: null } });
  const byId = new Map(pending.map((a) => [a.id, a]));
  const remaining = new Set(pending.map((a) => a.id));
  const result: CleanupResult = { attempted: 0, deleted: 0, errors: 0, details: [] };

  while (remaining.size > 0) {
    // « Feuilles » : artefacts dont AUCUN autre artefact restant ne dépend.
    const dependedUpon = new Set<string>();
    for (const id of remaining) for (const dep of byId.get(id)!.dependsOn) if (remaining.has(dep)) dependedUpon.add(dep);
    let leaves = [...remaining].filter((id) => !dependedUpon.has(id));
    if (leaves.length === 0) leaves = [...remaining]; // cycle improbable → on force pour ne pas boucler

    for (const id of leaves) {
      const a = byId.get(id)!;
      const res = await deleteOne(a.model, a.recordId, a.deleteMethod, a.blobKey);
      await prisma.testArtifact.update({ where: { id }, data: { deletedAt: new Date(), cleanupResult: res } });
      result.attempted++;
      if (res.startsWith("error")) result.errors++; else result.deleted++;
      result.details.push({ recordId: a.recordId, result: res });
      remaining.delete(id);
    }
  }
  return result;
}

export interface VerifyResult { clean: boolean; checked: number; residuals: { model: string | null; recordId: string }[] }

/** Vérifie qu'AUCUNE ressource du run ne subsiste (re-requête réelle par ID). */
export async function verifyClean(testRunId: string): Promise<VerifyResult> {
  const artifacts = await prisma.testArtifact.findMany({ where: { testRunId } });
  const residuals: { model: string | null; recordId: string }[] = [];
  for (const a of artifacts) {
    if (a.deleteMethod === "noop") continue;
    if (a.deleteMethod === "blob") continue; // blobs vérifiés via ref-count côté storage
    const check = a.model ? EXISTS[a.model] : null;
    if (!check) { residuals.push({ model: a.model, recordId: a.recordId }); continue; } // modèle non vérifiable = suspect
    if (await check(a.recordId)) residuals.push({ model: a.model, recordId: a.recordId });
  }
  return { clean: residuals.length === 0, checked: artifacts.length, residuals };
}
