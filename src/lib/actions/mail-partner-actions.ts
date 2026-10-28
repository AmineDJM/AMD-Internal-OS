"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES PARTENAIRES DU REGISTRE DES COURRIERS — la liste que tient l'assistante de direction.
 *
 * Fournisseur, administration, client, prestataire : ce que le pli concerne à l'extérieur. La
 * liste appartient au MODULE COURRIERS et à personne d'autre — les fournisseurs du Regulatory
 * sont des fabricants pharmaceutiques référencés dans des dossiers d'enregistrement, et les
 * mêler ferait de l'assistante quelqu'un qui peut supprimer un fabricant d'AMM en rangeant son
 * courrier.
 *
 * Qui tient la liste : qui peut écrire au registre (`MAIL_REGISTER` / UPDATE) — l'assistante de
 * direction, la Direction, le Super Admin. C'est le même geste que d'enregistrer un courrier :
 * demander un droit de plus n'aurait servi qu'à bloquer la personne qui s'en sert.
 */

const PATH = "/courriers";

/** Crée un partenaire. Le nom fait foi : deux « SARL Untel » ne se distingueraient pas. */
export async function createMailPartner(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom du partenaire est obligatoire." };
  const dup = await prisma.mailPartner.findUnique({ where: { name }, select: { id: true, isActive: true } });
  if (dup) {
    // Réactiver plutôt que refuser : un partenaire désactivé qu'on ressaisit, c'est
    // qu'on retravaille avec lui — le message « existe déjà » n'aiderait personne.
    if (!dup.isActive) {
      await prisma.mailPartner.update({ where: { id: dup.id }, data: { isActive: true } });
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Courriers", summary: `Partenaire réactivé : ${name}` });
      revalidatePath(PATH);
      return { ok: true, id: dup.id, message: `« ${name} » était désactivé — il est réactivé.` };
    }
    return { ok: false, error: `« ${name} » figure déjà dans la liste.` };
  }

  const created = await prisma.mailPartner.create({
    data: {
      name,
      kind: fdStr(formData, "kind") || null,
      contact: fdStr(formData, "contact") || null,
      notes: fdStr(formData, "notes") || null,
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Courriers", summary: `Partenaire ajouté : ${name}` });
  revalidatePath(PATH);
  return { ok: true, id: created.id };
}

/** Modifie un partenaire (nom, nature, contact, notes) ou le désactive. */
export async function updateMailPartner(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Partenaire introuvable." };
  const existing = await prisma.mailPartner.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return { ok: false, error: "Partenaire introuvable." };

  const name = fdStr(formData, "name") || existing.name;
  if (name !== existing.name) {
    const dup = await prisma.mailPartner.findFirst({ where: { name, id: { not: id } }, select: { id: true } });
    if (dup) return { ok: false, error: `« ${name} » figure déjà dans la liste.` };
  }
  const activeRaw = formData.get("isActive");

  await prisma.mailPartner.update({
    where: { id },
    data: {
      name,
      kind: fdStr(formData, "kind") || null,
      contact: fdStr(formData, "contact") || null,
      notes: fdStr(formData, "notes") || null,
      ...(activeRaw != null ? { isActive: activeRaw === "on" || activeRaw === "true" || activeRaw === "1" } : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Courriers",
    summary: `Partenaire modifié : ${existing.name}${name !== existing.name ? ` → ${name}` : ""}`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Supprime un partenaire. Les COURRIERS qui le citaient restent, sans partenaire (`SET NULL`) :
 * un pli enregistré est un fait, il ne s'efface pas parce qu'on nettoie une liste. Quand des
 * courriers y renvoient, on propose plutôt la désactivation — elle le sort des menus sans
 * effacer le lien de ceux qui l'ont déjà.
 */
export async function deleteMailPartner(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Partenaire introuvable." };
  const existing = await prisma.mailPartner.findUnique({
    where: { id },
    select: { name: true, _count: { select: { entries: true } } },
  });
  if (!existing) return { ok: false, error: "Partenaire introuvable." };

  if (existing._count.entries > 0) {
    return {
      ok: false,
      error: `${existing._count.entries} courrier(s) citent « ${existing.name} ». Désactivez-le : il quitte les menus sans effacer le lien des plis déjà enregistrés.`,
    };
  }

  await prisma.mailPartner.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Courriers", summary: `Partenaire supprimé : ${existing.name}` });
  revalidatePath(PATH);
  return { ok: true };
}
