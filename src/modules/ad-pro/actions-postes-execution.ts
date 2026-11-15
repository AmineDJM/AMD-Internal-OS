"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac/roles";
import { prisma } from "@/lib/prisma";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { persistUploadedDocument } from "@/lib/documents";
import { validateAttachments } from "@/lib/attach-files";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { conformiteParDefaut, voieAgencePossible, lireStatutConformite } from "./domaine/parcours-agence";
import { PARENTS, revalidate, audit, loadItem, REFUS_HISTORIQUE, peutTrancherSur, canEditItems } from "./infra/postes/commun";
import { ETAPE_BAT, ETAPE_RECEPTION } from "./infra/requetes/agence";

/**
 * POSTES AD & PRO — LE PARCOURS AGENCE, DE LA VOIE À LA RÉCEPTION (Direction, 15/11/2026) : choisir comment un poste se paie
 * (par une agence, ou directement), envoyer le BC signé à l'agence, faire contrôler le BAT par l'information médicale,
 * signer le PV de réception. La facture et le paiement suivent le chemin d'avant (`demanderPaiementPoste`), gardés par la
 * réception (`refusAvantReception`).
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

async function chargerPoste(user: SessionUser, id: string | null) {
  if (!id) return { error: "Poste non précisé." } as const;
  const found = await loadItem(id, user);
  if (!found) return { error: "Poste introuvable." } as const;
  if (found.historique) return { error: REFUS_HISTORIQUE } as const;
  const info = await PARENTS[found.owner.parent].load(found.owner.id);
  if (!info) return { error: "Opération introuvable." } as const;
  const exec = await prisma.adProExecutionPoste.findUnique({ where: { itemId: id } });
  return { ...found, info, exec } as const;
}

/**
 * COMMENT CE POSTE SE PAIE — « par une agence » (prospection, BC signé, réception) ou « directement » (pro forma ou facture,
 * sans BC) ; et s'il passe par le contrôle de conformité. Se choisit tant que rien n'est engagé : ni prospection, ni BC,
 * ni paiement. La Direction Marketing, ou qui édite les postes de la demande.
 */
export async function choisirVoiePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await chargerPoste(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, exec } = c;
  const mk = (await peutTrancherSur(user, owner)).marketing;
  if (!mk && !canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const voie = fdStr(formData, "voie");
  if (voie !== "AGENCE" && voie !== "DIRECT") return { ok: false, error: "Choisissez « Par une agence » ou « Directement »." };
  if (voie === "AGENCE" && !voieAgencePossible(item.kind)) return { ok: false, error: "Cette nature de poste a son propre chemin : elle ne passe pas par la prospection d'agences." };
  if (exec?.prospectionDemandeeAt && voie !== item.voie) return { ok: false, error: "La prospection est lancée : la voie de ce poste ne change plus." };
  if (item.orderStage !== "NONE" || item.expenseOrderId) return { ok: false, error: "Un bon de commande ou un paiement est déjà en cours : la voie ne change plus." };
  const conformite = voie === "AGENCE"
    ? (formData.has("conformiteChoisie") ? fdStr(formData, "conformite") === "oui" : conformiteParDefaut(item.kind))
    : false;
  if (formData.has("conformiteChoisie") && !mk && conformite !== conformiteParDefaut(item.kind)) {
    return { ok: false, error: "Le contrôle de conformité se change par la Direction Marketing." };
  }
  await prisma.adProItem.update({ where: { id: item.id }, data: { voie, conformiteRequise: conformite, updatedById: user.id } });
  await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » : payé ${voie === "AGENCE" ? `par une agence${conformite ? ", avec contrôle de conformité" : ""}` : "directement, sans bon de commande"}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: item.id, message: voie === "AGENCE" ? "Ce poste passera par une agence." : "Ce poste se paiera directement, sans bon de commande." };
}

/** ENVOYER LE BC SIGNÉ À L'AGENCE — la Direction Marketing (le PDF scellé se télécharge depuis la case « Bon de commande »). */
export async function marquerBcEnvoye(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await chargerPoste(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, exec } = c;
  if (!(await peutTrancherSur(user, owner)).marketing) return { ok: false, error: "Le BC part à l'agence par la Direction Marketing." };
  if (!exec?.agenceRetenueAt) return { ok: false, error: "L'agence n'est pas encore choisie." };
  const lien = await prisma.adProItemPiece.findFirst({ where: { itemId: item.id, nature: "BON_DE_COMMANDE", legalDocument: { status: { not: "CANCELLED" } } }, orderBy: { createdAt: "desc" }, select: { legalDocumentId: true } });
  const etat = lien ? await etatDuBC(lien.legalDocumentId) : null;
  if (etat?.etape !== "SIGNE") return { ok: false, error: "Le BC n'est pas encore signé par les Finances : il part à l'agence une fois signé et cacheté." };
  const pris = await prisma.adProExecutionPoste.updateMany({ where: { itemId: item.id, bcEnvoyeAt: null }, data: { bcEnvoyeAt: new Date(), bcEnvoyeParId: user.id } });
  if (pris.count === 0) return { ok: false, error: "Le BC est déjà marqué envoyé." };
  await audit(user, owner.parent, owner.id, "UPDATE", `BC ${etat.reference ?? ""} du poste « ${item.label} » envoyé à l'agence.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: item.id, message: item.conformiteRequise ? "BC envoyé. Prochaine étape : transmettre le BAT à l'information médicale." : "BC envoyé. Prochaine étape : la réception." };
}

/** TRANSMETTRE LE BAT À L'INFORMATION MÉDICALE — la Direction Marketing dépose le BAT de l'agence (PDF ou image). */
export async function envoyerBatConformite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await chargerPoste(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  if (!(await peutTrancherSur(user, owner)).marketing) return { ok: false, error: "Le BAT se transmet par la Direction Marketing." };
  if (!item.conformiteRequise) return { ok: false, error: "Ce poste ne passe pas par le contrôle de conformité." };
  if (!exec?.bcEnvoyeAt) return { ok: false, error: "Le BC n'est pas encore parti à l'agence." };
  const statut = lireStatutConformite(exec.conformiteStatut);
  if (statut === "EN_CONTROLE") return { ok: false, error: "Un BAT est déjà en contrôle chez l'information médicale." };
  if (statut === "CONFORME") return { ok: false, error: "Ce poste est déjà déclaré conforme." };
  const fichiers = formData.getAll("bat").filter((v): v is File => v instanceof File && v.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Joignez le BAT de l'agence (PDF ou image)." };
  const refusFichier = await validateAttachments(fichiers);
  if (refusFichier) return { ok: false, error: refusFichier };
  for (const f of fichiers) {
    const r = await persistUploadedDocument(user.id, { entityType: "AD_PRO_ITEM", entityId: item.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: ETAPE_BAT, file: f });
    if (!r.ok) return { ok: false, error: r.error ?? "Le BAT n'a pas pu être enregistré." };
  }
  await prisma.adProExecutionPoste.update({ where: { itemId: item.id }, data: { conformiteStatut: "EN_CONTROLE", conformiteDemandeeAt: new Date(), conformiteDemandeeParId: user.id, conformiteNote: null } });
  await notifyRoles(["MEDICAL_INFO_PHARMACIST"], {
    type: "VALIDATION_REQUIRED", title: "BAT à contrôler", body: `${info.ref} — « ${item.label} » : conformité à vérifier avant impression.`,
    link: lienPosteAdPro(owner.parent, owner.id, item.id),
  }).catch(sansBloquer("ad-pro.envoyerBatConformite.notifyRoles"));
  await audit(user, owner.parent, owner.id, "UPDATE", `BAT du poste « ${item.label} » transmis à l'information médicale pour contrôle de conformité.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/information-medicale/conformite");
  return { ok: true, id: item.id, message: "BAT transmis à l'information médicale." };
}

const estInfoMed = (user: SessionUser) => hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN");

/** DÉCIDER DE LA CONFORMITÉ — l'information médicale : conforme, ou non conforme avec ce qu'il faut corriger. */
export async function deciderConformitePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!estInfoMed(user)) return { ok: false, error: "La conformité se décide par l'information médicale." };
  const c = await chargerPoste(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  const decision = fdStr(formData, "decision");
  const note = fdStr(formData, "note");
  if (decision !== "CONFORME" && decision !== "NON_CONFORME") return { ok: false, error: "Décision inconnue." };
  if (decision === "NON_CONFORME" && !note) return { ok: false, error: "Dites ce qu'il faut corriger : l'agence reprendra le BAT d'après vous." };
  const pris = await prisma.adProExecutionPoste.updateMany({
    where: { itemId: item.id, conformiteStatut: "EN_CONTROLE" },
    data: { conformiteStatut: decision, conformiteDecideeAt: new Date(), conformiteParId: user.id, conformiteNote: note },
  });
  if (pris.count === 0) return { ok: false, error: "Aucun BAT n'attend de contrôle sur ce poste." };
  const qui = exec?.conformiteDemandeeParId;
  if (qui) {
    await notifyUser({
      userId: qui, type: "GENERIC", title: decision === "CONFORME" ? "BAT conforme" : "BAT non conforme",
      body: `${info.ref} — « ${item.label} »${note ? ` : ${note}` : ""}`, link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro.deciderConformitePoste.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Conformité du poste « ${item.label} » : ${decision === "CONFORME" ? "conforme" : `non conforme — ${note}`}.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/information-medicale/conformite");
  return { ok: true, id: item.id, message: decision === "CONFORME" ? "Déclaré conforme : l'impression peut partir." : "Déclaré non conforme : la Direction Marketing fait corriger le BAT." };
}

/** SIGNER LE PV DE RÉCEPTION — la Direction Marketing ou le demandeur présent sur place ; avec ou sans réserve, photos possibles. */
export async function signerReceptionPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await chargerPoste(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  const mk = (await peutTrancherSur(user, owner)).marketing;
  if (!mk && info.requesterId !== user.id) return { ok: false, error: "La réception se signe par la Direction Marketing ou par le demandeur présent sur place." };
  if (!exec?.bcEnvoyeAt) return { ok: false, error: "Le BC n'est pas encore parti à l'agence." };
  if (item.conformiteRequise && lireStatutConformite(exec.conformiteStatut) !== "CONFORME") return { ok: false, error: "La conformité n'est pas encore validée par l'information médicale." };
  if (exec.receptionAt) return { ok: false, error: "La réception est déjà signée." };
  const note = fdStr(formData, "note");
  const reserve = fdStr(formData, "reserve") === "oui";
  if (reserve && !note) return { ok: false, error: "Décrivez la réserve (quantité manquante, article abîmé…) : la facture n'en portera que le reçu." };
  const photos = formData.getAll("photos").filter((v): v is File => v instanceof File && v.size > 0);
  if (photos.length > 0) {
    const refusFichier = await validateAttachments(photos);
    if (refusFichier) return { ok: false, error: refusFichier };
    for (const f of photos) {
      const r = await persistUploadedDocument(user.id, { entityType: "AD_PRO_ITEM", entityId: item.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: ETAPE_RECEPTION, file: f });
      if (!r.ok) return { ok: false, error: r.error ?? "Une photo n'a pas pu être enregistrée." };
    }
  }
  const pris = await prisma.adProExecutionPoste.updateMany({ where: { itemId: item.id, receptionAt: null }, data: { receptionAt: new Date(), receptionParId: user.id, receptionNote: note, receptionReserve: reserve } });
  if (pris.count === 0) return { ok: false, error: "La réception vient d'être signée." };
  await audit(user, owner.parent, owner.id, "UPDATE", `PV de réception du poste « ${item.label} » signé${reserve ? ` avec réserve — ${note}` : ""}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: item.id, message: reserve ? "Réception signée avec réserve. La facture peut être déposée." : "Réception signée. La facture de l'agence peut être déposée." };
}
