"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { annulerFusionOrganisation, ecarter, fusionner, RefusFusionOrganisation, MODULE_JOURNAL_REFONTE } from "@/modules/referentiels/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES ORGANISATIONS — les gestes HUMAINS de la refonte (lot V2-C) :
 *
 *   • trancher une proposition de doublon : fusionner (en choisissant la fiche conservée), ou écarter ;
 *   • défaire une fusion (rien n'a été effacé, elle se défait sans perte) ;
 *   • ouvrir ou fermer la double écriture des organisations.
 *
 * Super Admin SEUL, en attendant la décision de la Direction sur « qui tranche une fusion »
 * (`refonte-donnees-et-monolithe-modulaire.md` §6, décision 2). Chaque geste est audité avec les noms.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const REFUS: ActionResult = { ok: false, error: "Réservé au Super Admin." };

async function superAdmin() {
  const user = await requireUser();
  return user.role === "SUPER_ADMIN" ? user : null;
}

function revalider(...ids: string[]) {
  revalidatePath("/admin/refonte-donnees");
  revalidatePath("/admin/refonte-donnees/organisations");
  for (const id of ids) revalidatePath(`/organisations/${id}`);
}

const refus = (e: unknown): ActionResult => {
  if (e instanceof RefusFusionOrganisation) return { ok: false, error: e.message };
  throw e;
};

export async function fusionnerOrganisations(fd: FormData): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return REFUS;
  const propositionId = fdStr(fd, "propositionId");
  const survivanteId = fdStr(fd, "survivanteId");
  if (!propositionId || !survivanteId) return { ok: false, error: "Proposition ou fiche conservée manquante." };
  try {
    const f = await fusionner(propositionId, survivanteId, user.id);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "fusion-organisation",
      oldValue: f.absorbee.id, newValue: f.survivante.id,
      summary: `Organisation « ${f.absorbee.raisonSociale} » fusionnée dans « ${f.survivante.raisonSociale} »`,
    });
    revalider(f.absorbee.id, f.survivante.id);
    return { ok: true, id: f.survivante.id };
  } catch (e) {
    return refus(e);
  }
}

export async function ecarterDoublonOrganisation(fd: FormData): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return REFUS;
  const propositionId = fdStr(fd, "propositionId");
  if (!propositionId) return { ok: false, error: "Proposition manquante." };
  try {
    const { a, b } = await ecarter(propositionId, user.id);
    await recordAudit({
      actorId: user.id, action: "REFUSE", module: MODULE_JOURNAL_REFONTE, field: "doublon-organisation",
      oldValue: a, newValue: b, summary: "Proposition de doublon d'organisations écartée : ce ne sont pas les mêmes",
    });
    revalider(a, b);
    return { ok: true };
  } catch (e) {
    return refus(e);
  }
}

export async function defaireFusionOrganisation(fd: FormData): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return REFUS;
  const organisationId = fdStr(fd, "organisationId");
  if (!organisationId) return { ok: false, error: "Organisation manquante." };
  try {
    const o = await annulerFusionOrganisation(organisationId);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "fusion-organisation",
      oldValue: o.survivanteId, newValue: null, summary: `Fusion défaite : « ${o.raisonSociale} » redevient une fiche à part`,
    });
    revalider(o.id, o.survivanteId);
    return { ok: true };
  } catch (e) {
    return refus(e);
  }
}

export async function reglerDoubleEcritureOrganisations(fd: FormData): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return REFUS;
  const actif = fdStr(fd, "actif") === "1";
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", doubleEcritureOrganisations: actif, updatedById: user.id },
    update: { doubleEcritureOrganisations: actif, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "double-ecriture-organisations",
    newValue: actif ? "ouverte" : "fermée",
    summary: `Double écriture des organisations ${actif ? "ouverte" : "fermée"}`,
  });
  revalider();
  return { ok: true };
}
