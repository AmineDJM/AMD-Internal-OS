"use server";

import type { RegLifecycleKind, RegLifecycleOperation } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "../access";
import { regAudit } from "../audit";
import { analyzeImpact, type ImpactResult } from "./impact";
import { sansBloquer } from "@/lib/journal";

/** Lifecycle réglementaire (G12). regulatory.dossier.analyse. Org-scopé. */

interface Result { ok: boolean; error?: string; impact?: ImpactResult }
const str = (fd: FormData, k: string) => { const v = fd.get(k); return v ? String(v).trim() : null; };
const KINDS = ["SUBMISSION", "SEQUENCE", "SUPPLEMENT", "MODIFICATION", "RENEWAL", "RESPONSE", "APPROVED", "WITHDRAWAL"];
const OPS = ["NEW", "REPLACE", "DELETE", "APPEND"];

async function guard(dossierId: string): Promise<{ ok: true; userId: string; companyId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!regCan(user, "regulatory.dossier.analyse") && user.role !== "SUPER_ADMIN") return { ok: false, error: "Non autorisé." };
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return { ok: false, error: "Module non activé." };
  if (!(await prisma.regulatoryDossier.findFirst({ where: { id: dossierId, companyId }, select: { id: true } }))) return { ok: false, error: "Dossier introuvable." };
  return { ok: true, userId: user.id, companyId };
}
const revalidate = (id: string) => revalidatePath(`/regulatory/enregistrement/analyse/${id}`);

export async function addLifecycleEvent(formData: FormData): Promise<Result> {
  const dossierId = str(formData, "dossierId");
  const kind = str(formData, "kind");
  const label = str(formData, "label");
  if (!dossierId || !kind || !KINDS.includes(kind) || !label) return { ok: false, error: "Paramètres invalides." };
  const g = await guard(dossierId);
  if (!g.ok) return g;

  const operation = str(formData, "operation");
  const seqStr = str(formData, "sequenceNo");
  const dateStr = str(formData, "effectiveDate");
  const sections = (str(formData, "sections") ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  // Analyse d'impact déterministe pour les modifications.
  let impact: ImpactResult | undefined;
  let note = str(formData, "note") ?? null;
  if (kind === "MODIFICATION" && sections.length > 0) {
    impact = analyzeImpact(sections);
    const impactNote = `Impact : sections à re-vérifier [${impact.affectedSections.join(", ") || "—"}] ; faits à re-confirmer [${impact.factsToReverify.join(", ") || "—"}].`;
    note = note ? `${note}\n${impactNote}` : impactNote;
  }

  await prisma.regulatoryLifecycleEvent.create({
    data: {
      dossierId, kind: kind as RegLifecycleKind, label,
      operation: operation && OPS.includes(operation) ? (operation as RegLifecycleOperation) : null,
      sequenceNo: seqStr && !isNaN(Number(seqStr)) ? Number(seqStr) : null,
      effectiveDate: dateStr ? new Date(dateStr) : null, note, createdById: g.userId,
    },
  });
  // Une version approuvée passe le dossier en MAINTAINED.
  if (kind === "APPROVED") await prisma.regulatoryDossier.update({ where: { id: dossierId }, data: { status: "MAINTAINED" } }).catch(sansBloquer("lifecycle-actions.addLifecycleEvent.regulatoryDossier"));
  await regAudit({ companyId: g.companyId, actorId: g.userId, dossierId, action: `LIFECYCLE_${kind}`, detail: `Événement lifecycle « ${label} »${operation ? ` (${operation})` : ""}.` });
  revalidate(dossierId);
  return { ok: true, impact };
}

export async function deleteLifecycleEvent(formData: FormData): Promise<Result> {
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Événement manquant." };
  const ev = await prisma.regulatoryLifecycleEvent.findUnique({ where: { id }, select: { dossierId: true } });
  if (!ev) return { ok: false, error: "Introuvable." };
  const g = await guard(ev.dossierId);
  if (!g.ok) return g;
  await prisma.regulatoryLifecycleEvent.delete({ where: { id } });
  revalidate(ev.dossierId);
  return { ok: true };
}

export async function addObligation(formData: FormData): Promise<Result> {
  const dossierId = str(formData, "dossierId");
  const label = str(formData, "label");
  if (!dossierId || !label) return { ok: false, error: "Libellé manquant." };
  const g = await guard(dossierId);
  if (!g.ok) return g;
  const dueStr = str(formData, "dueDate");
  await prisma.regulatoryObligation.create({
    data: { dossierId, label, certType: str(formData, "certType"), dueDate: dueStr ? new Date(dueStr) : null, note: str(formData, "note"), createdById: g.userId },
  });
  await regAudit({ companyId: g.companyId, actorId: g.userId, dossierId, action: "OBLIGATION_ADDED", detail: `Obligation « ${label} »${dueStr ? ` (échéance ${dueStr})` : ""}.` });
  revalidate(dossierId);
  return { ok: true };
}

export async function completeObligation(formData: FormData): Promise<Result> {
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Obligation manquante." };
  const ob = await prisma.regulatoryObligation.findUnique({ where: { id }, select: { dossierId: true } });
  if (!ob) return { ok: false, error: "Introuvable." };
  const g = await guard(ob.dossierId);
  if (!g.ok) return g;
  await prisma.regulatoryObligation.update({ where: { id }, data: { status: "DONE", completedAt: new Date() } });
  revalidate(ob.dossierId);
  return { ok: true };
}

export async function deleteObligation(formData: FormData): Promise<Result> {
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Obligation manquante." };
  const ob = await prisma.regulatoryObligation.findUnique({ where: { id }, select: { dossierId: true } });
  if (!ob) return { ok: false, error: "Introuvable." };
  const g = await guard(ob.dossierId);
  if (!g.ok) return g;
  await prisma.regulatoryObligation.delete({ where: { id } });
  revalidate(ob.dossierId);
  return { ok: true };
}
