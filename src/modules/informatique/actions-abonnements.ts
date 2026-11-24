"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { getAppSettings } from "@/lib/settings";
import { deposerPieceDeModule, validateUpload } from "@/lib/storage";
import { actionReversible } from "@/lib/effets/reversible";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { estDevise, estPeriodicite, lireDate, lireMontant } from "@/modules/informatique/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ABONNEMENTS & LICENCES DU DÉPARTEMENT INFORMATIQUE (24/11/2026) — enregistrer, modifier, résilier.
 *
 * DROITS : la clé « Abonnements & licences » (`INFORMATIQUE_ABONNEMENTS`) — créer, modifier ; par défaut le Super Admin et le
 * responsable du département Informatique. Une fiche ne se tient que dans une société permise à la personne.
 * Saisie réelle, rien de préchargé ; le contrat ou la facture se joint (`IT_SUBSCRIPTION`).
 * RÉVERSIBLE : chaque action est un geste du journal des effets (déclarations `metiers.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = "/informatique/abonnements";
const MODULE_AUDIT = "Informatique";

async function societePermise(userId: string, companyId: string): Promise<boolean> {
  return (await getMyCompanies(userId)).some((c) => c.id === companyId);
}

/** La ligne budgétaire choisie existe-t-elle, dans une enveloppe de la MÊME société ? */
async function ligneBudgetValide(categoryId: string, companyId: string): Promise<boolean> {
  const c = await prisma.budgetCategoryLine.findUnique({ where: { id: categoryId }, select: { envelope: { select: { companyId: true } } } });
  return !!c && c.envelope.companyId === companyId;
}

/** Les champs du formulaire — `erreur` dit le premier champ manquant ou illisible, et son remède. */
function lireChamps(formData: FormData, creation: boolean) {
  const data: Record<string, unknown> = {};
  const fournisseur = fdStr(formData, "fournisseur");
  const objet = fdStr(formData, "objet");
  if (creation && !fournisseur) return { erreur: "Le fournisseur est obligatoire (OpenAI, Anthropic, Microsoft…)." } as const;
  if (creation && !objet) return { erreur: "L'objet est obligatoire : ce que couvre l'abonnement." } as const;
  if (fournisseur) data.fournisseur = fournisseur.slice(0, 120);
  if (objet) data.objet = objet.slice(0, 250);
  const periodicite = fdStr(formData, "periodicite");
  if (periodicite && !estPeriodicite(periodicite)) return { erreur: "Périodicité inconnue : mensuelle ou annuelle." } as const;
  if (periodicite) data.periodicite = periodicite;
  const devise = fdStr(formData, "devise");
  if (devise && !estDevise(devise)) return { erreur: "Devise inconnue : DZD, USD ou EUR." } as const;
  if (devise) data.devise = devise;
  const montant = lireMontant(fdStr(formData, "montant"));
  if (montant === "illisible") return { erreur: "Le montant est illisible : un nombre positif, par exemple 20 ou 4 500,50." } as const;
  if (creation && montant === null) return { erreur: "Le montant est obligatoire (dans la devise de la facture)." } as const;
  if (montant !== null) data.montant = montant;
  if (formData.has("echeance")) {
    const echeance = lireDate(fdStr(formData, "echeance"));
    if (echeance === "illisible") return { erreur: "L'échéance est illisible (attendu : AAAA-MM-JJ)." } as const;
    data.echeance = echeance;
  }
  const rappel = fdNum(formData, "rappelJours");
  if (rappel !== null) data.rappelJours = Math.max(0, Math.min(365, Math.round(rappel)));
  if (formData.has("notes")) data.notes = fdStr(formData, "notes");
  if (formData.has("budgetCategoryId")) data.budgetCategoryId = fdStr(formData, "budgetCategoryId");
  return { data } as const;
}

/** Joint la pièce (contrat, facture) si le formulaire en porte une ; rend le refus de dépôt, sinon `null`. */
async function joindrePiece(formData: FormData, abonnementId: string, userId: string): Promise<string | null> {
  const fichier = formData.get("piece");
  if (!(fichier instanceof File) || fichier.size === 0) return null;
  const refus = validateUpload(fichier.name, fichier.size, (await getAppSettings()).maxUploadMb);
  if (refus) return refus;
  await deposerPieceDeModule(fichier, { entityType: "IT_SUBSCRIPTION", entityId: abonnementId, category: "OTHER", confidentiality: "INTERNAL", uploadedById: userId, journal: "informatique-abonnement" });
  return null;
}

export async function creerAbonnement(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-abonnements-actions:creerAbonnement", "Abonnement enregistré", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_ABONNEMENTS", "CREATE")) return { ok: false, error: "Non autorisé : enregistrer un abonnement demande le droit de créer dans « Abonnements & licences »." };
    const companyId = fdStr(formData, "companyId");
    if (!companyId) return { ok: false, error: "Choisissez la société qui paie l'abonnement." };
    if (!(await societePermise(user.id, companyId))) return { ok: false, error: "Cette société ne vous est pas ouverte : choisissez l'une des vôtres." };
    const lu = lireChamps(formData, true);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    const ligne = lu.data.budgetCategoryId as string | null | undefined;
    if (ligne && !(await ligneBudgetValide(ligne, companyId))) return { ok: false, error: "Cette ligne budgétaire n'appartient pas au budget de la société choisie." };
    const cree = await prisma.abonnementInformatique.create({
      data: {
        ...(lu.data as object), companyId, fournisseur: lu.data.fournisseur as string, objet: lu.data.objet as string,
        montant: lu.data.montant as number, createdById: user.id,
      },
      select: { id: true, fournisseur: true, objet: true },
    });
    const refus = await joindrePiece(formData, cree.id, user.id);
    await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityId: cree.id, summary: `Abonnement « ${cree.fournisseur} — ${cree.objet} » enregistré` });
    revalidatePath(PATH);
    return refus
      ? { ok: true, id: cree.id, message: `Abonnement enregistré, mais la pièce est refusée : ${refus}` }
      : { ok: true, id: cree.id, message: `Abonnement ${cree.fournisseur} enregistré.` };
  });
}

export async function modifierAbonnement(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-abonnements-actions:modifierAbonnement", "Abonnement modifié", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_ABONNEMENTS", "UPDATE")) return { ok: false, error: "Non autorisé : modifier un abonnement demande le droit de modifier « Abonnements & licences »." };
    const id = fdStr(formData, "id");
    const avant = id ? await prisma.abonnementInformatique.findUnique({ where: { id }, select: { id: true, companyId: true, fournisseur: true, objet: true } }) : null;
    if (!avant || !(await societePermise(user.id, avant.companyId))) return { ok: false, error: "Abonnement introuvable." };
    const lu = lireChamps(formData, false);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    const ligne = lu.data.budgetCategoryId as string | null | undefined;
    if (ligne && !(await ligneBudgetValide(ligne, avant.companyId))) return { ok: false, error: "Cette ligne budgétaire n'appartient pas au budget de la société de l'abonnement." };
    const aPiece = formData.get("piece") instanceof File && (formData.get("piece") as File).size > 0;
    if (!Object.keys(lu.data).length && !aPiece) return { ok: false, error: "Aucun champ à modifier." };
    if (Object.keys(lu.data).length) await prisma.abonnementInformatique.update({ where: { id: avant.id }, data: lu.data as object });
    const refus = await joindrePiece(formData, avant.id, user.id);
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityId: avant.id, summary: `Abonnement « ${avant.fournisseur} — ${avant.objet} » modifié (${[...Object.keys(lu.data), ...(aPiece ? ["pièce"] : [])].join(", ")})` });
    revalidatePath(PATH);
    return refus ? { ok: false, error: `La pièce est refusée : ${refus}` } : { ok: true, id: avant.id, message: "Abonnement mis à jour." };
  });
}

/** Résilier : l'abonnement sort des rappels et du coût courant ; il reste au registre. Transition conditionnelle. */
export async function resilierAbonnement(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-abonnements-actions:resilierAbonnement", "Abonnement résilié", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_ABONNEMENTS", "UPDATE")) return { ok: false, error: "Non autorisé : résilier un abonnement demande le droit de modifier « Abonnements & licences »." };
    const id = fdStr(formData, "id");
    const a = id ? await prisma.abonnementInformatique.findUnique({ where: { id }, select: { id: true, companyId: true, fournisseur: true, objet: true } }) : null;
    if (!a || !(await societePermise(user.id, a.companyId))) return { ok: false, error: "Abonnement introuvable." };
    const r = await prisma.abonnementInformatique.updateMany({ where: { id: a.id, statut: "ACTIF" }, data: { statut: "RESILIE" } });
    if (r.count === 0) return { ok: true, message: "Cet abonnement est déjà résilié." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityId: a.id, summary: `Abonnement « ${a.fournisseur} — ${a.objet} » résilié` });
    revalidatePath(PATH);
    return { ok: true, id: a.id, message: "Abonnement résilié." };
  });
}
