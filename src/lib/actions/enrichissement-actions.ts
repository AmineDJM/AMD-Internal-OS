"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { peutTrancher } from "@/lib/enrichissement/a-confirmer";
import { confirmerFaitPropose, rejeterFaitPropose, trancherConflitDeFait } from "@/lib/enrichissement/confirmation";
import { traiterLaFile } from "@/lib/enrichissement/traitement";

/**
 * LES GESTES DE L'ENRICHISSEMENT (refonte, lot V2-A).
 *
 *  - Super Admin : ouvrir / fermer l'interrupteur, lancer un passage de la file, relancer les tâches en échec.
 *  - Responsable du fait (celui qui a déposé la pièce, ou le Super Admin — `peutTrancher`) : confirmer,
 *    rejeter un fait proposé, trancher un conflit. Chaque geste est audité ; rien n'est effacé.
 */

export type IssueGeste = { ok: boolean; message: string };

const CHEMINS = ["/admin/refonte-donnees", "/a-confirmer"];
const revalider = () => CHEMINS.forEach((p) => revalidatePath(p));

async function superAdmin() {
  const user = await requireUser();
  return user.role === "SUPER_ADMIN" ? user : null;
}

export async function basculerEnrichissement(actif: boolean): Promise<IssueGeste> {
  const user = await superAdmin();
  if (!user) return { ok: false, message: "Réservé au Super Admin." };
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", enrichissementActif: actif, updatedById: user.id },
    update: { enrichissementActif: actif, updatedById: user.id },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Refonte des données", field: "enrichissementActif", newValue: String(actif), summary: `Enrichissement des fiches ${actif ? "ouvert" : "fermé"}.` });
  revalider();
  return { ok: true, message: actif ? "Enrichissement ouvert : les dépôts partent en file." : "Enrichissement fermé : plus rien n'est mis en file ni traité." };
}

export async function lancerPassageEnrichissement(): Promise<IssueGeste> {
  const user = await superAdmin();
  if (!user) return { ok: false, message: "Réservé au Super Admin." };
  const b = await traiterLaFile({ max: 25 });
  if (!b.actif) return { ok: false, message: "L'enrichissement est fermé." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Refonte des données", summary: `Passage d'enrichissement lancé : ${b.prises} tâche(s), ${b.faites} faite(s), ${b.ignorees} ignorée(s), ${b.reportees} reportée(s), ${b.echecs} en échec.` });
  revalider();
  return { ok: true, message: `${b.prises} tâche(s) prise(s) : ${b.faites} faite(s), ${b.ignorees} ignorée(s), ${b.reportees} reportée(s), ${b.echecs} en échec.` };
}

export async function relancerTachesEnEchec(): Promise<IssueGeste> {
  const user = await superAdmin();
  if (!user) return { ok: false, message: "Réservé au Super Admin." };
  const { count } = await prisma.tacheEnrichissement.updateMany({ where: { statut: "ECHEC" }, data: { statut: "A_FAIRE", tentatives: 0, prochainEssaiLe: new Date() } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Refonte des données", summary: `${count} tâche(s) d'enrichissement en échec relancée(s).` });
  revalider();
  return { ok: true, message: `${count} tâche(s) relancée(s).` };
}

/** Le dépositaire de la pièce d'où vient un fait — la porte des gestes humains. */
async function porteDuFait(faitId: string) {
  const user = await requireUser();
  const f = await prisma.faitPropose.findUnique({ where: { id: faitId }, select: { attribut: true, extraction: { select: { piece: { select: { deposeeParId: true } } } } } });
  if (!f) return { user, refus: "Fait introuvable." };
  if (!peutTrancher({ userId: user.id, superAdmin: user.role === "SUPER_ADMIN" }, { deposeParId: f.extraction.piece.deposeeParId })) return { user, refus: "Non autorisé." };
  return { user, refus: null, attribut: f.attribut };
}

export async function confirmerFait(faitId: string): Promise<IssueGeste> {
  const p = await porteDuFait(faitId);
  if (p.refus) return { ok: false, message: p.refus };
  const r = await confirmerFaitPropose(faitId, { parId: p.user.id, decision: "CONFIRME", raison: "Confirmé à la main." });
  if (r.ok) {
    await recordAudit({ actorId: p.user.id, action: "VALIDATE", module: "Enrichissement", summary: `Fait « ${p.attribut} » confirmé (${faitId}).` });
    revalider();
  }
  return r;
}

export async function rejeterFait(faitId: string, motif: string | null): Promise<IssueGeste> {
  const p = await porteDuFait(faitId);
  if (p.refus) return { ok: false, message: p.refus };
  const r = await rejeterFaitPropose(faitId, { parId: p.user.id, motif });
  if (r.ok) {
    await recordAudit({ actorId: p.user.id, action: "REFUSE", module: "Enrichissement", summary: `Fait « ${p.attribut} » rejeté (${faitId}).` });
    revalider();
  }
  return r;
}

export async function trancherConflit(conflitId: string, choix: "GARDER" | "REMPLACER", commentaire: string | null): Promise<IssueGeste> {
  if (choix !== "GARDER" && choix !== "REMPLACER") return { ok: false, message: "Choix inconnu." };
  const c = await prisma.conflitDeFait.findUnique({ where: { id: conflitId }, select: { faitProposeId: true, attribut: true } });
  if (!c) return { ok: false, message: "Conflit introuvable." };
  const p = await porteDuFait(c.faitProposeId);
  if (p.refus) return { ok: false, message: p.refus };
  const r = await trancherConflitDeFait(conflitId, { parId: p.user.id, choix, commentaire });
  if (r.ok) {
    await recordAudit({ actorId: p.user.id, action: "VALIDATE", module: "Enrichissement", summary: `Conflit sur « ${c.attribut} » tranché : ${choix === "REMPLACER" ? "valeur de la pièce retenue" : "valeur de la fiche gardée"}.` });
    revalider();
  }
  return r;
}
