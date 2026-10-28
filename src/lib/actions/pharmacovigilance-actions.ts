"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { rolesWithModule, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { buildRef, createWithRetry } from "@/lib/refs";
import { persistUploadedDocument } from "@/lib/documents";
import { getAppSettings } from "@/lib/settings";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN, lienCasPvKam } from "@/lib/chemins/rapports-terrain";
import { instruitLesCasPv, lecteurPv, signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import {
  PREFIXE_REFERENCE_PV, STATUT_PV, estGravitePv, estStatutPv, lecteurDuCasPv, lireAgePv, refusEnquetePv, refusTransitionPv,
} from "@/lib/pharmacovigilance/regles";
import { sansBloquer } from "@/lib/journal";

/**
 * PHARMACOVIGILANCE — actions serveur (Direction, 06/10).
 *
 * Le KAM SIGNALE un cas depuis son planning (Promotion médicale) ; Regulatory le reçoit, l'instruit, ouvre au besoin une enquête
 * approfondie et ajoute des personnes à l'échange. Chaque action relit le cas et sa règle (`lecteurDuCasPv`) : un
 * identifiant deviné ne suffit jamais.
 */

const MODULE_AUDIT = "Pharmacovigilance";
const lienRegulatory = (id: string) => `/regulatory/pharmacovigilance/${id}`;
const lienKam = lienCasPvKam;

function revaliderCas(id?: string): void {
  revalidatePath("/regulatory/pharmacovigilance");
  revalidatePath(CHEMIN_PV_KAM);
  revalidatePath(CHEMIN_RAPPORTS_TERRAIN);
  if (id) {
    revalidatePath(lienRegulatory(id));
    revalidatePath(lienKam(id));
  }
}

async function prochaineReference(): Promise<string> {
  const annee = new Date().getFullYear();
  const existantes = await prisma.pharmacovigilanceCase.findMany({
    where: { reference: { startsWith: `${PREFIXE_REFERENCE_PV}-${annee}-` } },
    select: { reference: true },
  });
  return buildRef(PREFIXE_REFERENCE_PV, annee, existantes.map((r) => r.reference));
}

/** Le cas, lu pour une personne — `null` quand il n'existe pas OU qu'elle ne le lit pas (même réponse). */
async function casLisible(user: SessionUser, caseId: string | null) {
  if (!caseId) return null;
  const cas = await prisma.pharmacovigilanceCase.findUnique({
    where: { id: caseId },
    select: {
      id: true, reference: true, status: true, reporterId: true, productLabel: true, institutionName: true,
      investigationOpenedById: true, closedById: true, participants: { select: { userId: true } },
    },
  });
  if (!cas || !lecteurDuCasPv(lecteurPv(user), cas)) return null;
  return cas;
}

/** Ceux qui suivent un cas : le déclarant, les participants, et qui l'a instruit (enquête, clôture, échange). */
async function suiveursDuCas(cas: { id: string; reporterId: string; investigationOpenedById: string | null; closedById: string | null; participants: { userId: string }[] }): Promise<string[]> {
  const auteurs = await prisma.comment.findMany({
    where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, authorId: { not: null } },
    select: { authorId: true }, distinct: ["authorId"],
  });
  return [...new Set([
    cas.reporterId, ...cas.participants.map((p) => p.userId),
    ...(cas.investigationOpenedById ? [cas.investigationOpenedById] : []), ...(cas.closedById ? [cas.closedById] : []),
    ...auteurs.map((a) => a.authorId).filter((x): x is string => Boolean(x)),
  ])];
}

/** Le lien qu'on envoie : le KAM retrouve son cas dans les Rapports terrain, les autres dans Regulatory. */
const lienPour = (destinataire: string, cas: { id: string; reporterId: string }) => (destinataire === cas.reporterId ? lienKam(cas.id) : lienRegulatory(cas.id));

/**
 * SIGNALER UN CAS — le KAM, depuis les Rapports terrain : le produit (catalogue des BU, ou saisi), l'établissement
 * (annuaire, ou saisi), la date, ce qui s'est passé ; gravité, patient (âge, sexe) et pièces jointes facultatifs.
 */
export async function signalerCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!signaleDesCasPv(user)) return { ok: false, error: "Vous n'avez pas le droit de signaler un cas de pharmacovigilance." };

  // LE PRODUIT : un produit des Business Units, sinon le nom saisi.
  const promoProductId = fdStr(formData, "promoProductId");
  const produitSaisi = fdStr(formData, "produitAutre");
  let productLabel: string | null = null;
  let productId: string | null = null;
  if (promoProductId) {
    const p = await prisma.promoProduct.findFirst({ where: { id: promoProductId, isActive: true }, select: { name: true, productId: true } });
    if (!p) return { ok: false, error: "Ce produit n'est plus au catalogue : rechargez le formulaire." };
    productLabel = p.name;
    productId = p.productId;
  } else if (produitSaisi) {
    productLabel = produitSaisi.slice(0, 200);
  }
  if (!productLabel) return { ok: false, error: "Indiquez le produit concerné." };

  // L'ÉTABLISSEMENT : l'annuaire, sinon le nom saisi.
  const institutionId = fdStr(formData, "institutionId");
  const etablissementSaisi = fdStr(formData, "etablissementAutre");
  let institutionName: string | null = null;
  if (institutionId) {
    const e = await prisma.medicalInstitution.findUnique({ where: { id: institutionId }, select: { name: true } });
    if (!e) return { ok: false, error: "Cet établissement n'existe plus dans l'annuaire : rechargez le formulaire." };
    institutionName = e.name;
  } else if (etablissementSaisi) {
    institutionName = etablissementSaisi.slice(0, 200);
  }
  if (!institutionName) return { ok: false, error: "Indiquez l'hôpital ou l'établissement concerné." };

  const occurredOn = fdDate(formData, "occurredOn");
  if (!occurredOn) return { ok: false, error: "Indiquez la date de survenue." };
  if (occurredOn.getTime() > Date.now() + 24 * 3600 * 1000) return { ok: false, error: "La date de survenue ne peut pas être dans le futur." };
  const description = fdStr(formData, "description");
  if (!description || description.length < 10) return { ok: false, error: "Décrivez ce qui s'est passé (au moins quelques mots)." };

  const gravite = fdStr(formData, "severity");
  const sexe = fdStr(formData, "patientSex");
  const ageBrut = fdStr(formData, "patientAge");
  const patientAge = lireAgePv(ageBrut);
  if (ageBrut && patientAge === null) return { ok: false, error: "L'âge du patient doit être un nombre entre 0 et 120." };

  const cree = await createWithRetry(async () => prisma.pharmacovigilanceCase.create({
    data: {
      reference: await prochaineReference(),
      reporterId: user.id,
      promoProductId: promoProductId ?? null,
      productId,
      productLabel,
      institutionId: institutionId ?? null,
      institutionName,
      doctorName: fdStr(formData, "doctorName")?.slice(0, 200) ?? null,
      occurredOn,
      description: description.slice(0, 10000),
      patientAge,
      patientSex: sexe === "F" || sexe === "M" ? sexe : null,
      severity: estGravitePv(gravite) ? gravite : null,
    },
    select: { id: true, reference: true },
  }));

  // LES PIÈCES (photos, comptes rendus) : un fichier refusé ne défait pas le signalement — il est dit.
  const fichiers = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const echecs: string[] = [];
  if (fichiers.length) {
    const maxUploadMb = (await getAppSettings()).maxUploadMb;
    for (const file of fichiers) {
      const r = await persistUploadedDocument(user.id, {
        entityType: "PHARMACOVIGILANCE_CASE", entityId: cree.id, category: file.type.startsWith("image/") ? "PHOTO" : "SUPPORTING_DOC",
        confidentiality: "CONFIDENTIAL", stepKey: null, file, maxUploadMb,
      });
      if (!r.ok) echecs.push(`${file.name} : ${r.error ?? "échec"}`);
    }
  }

  await notifyRoles(rolesWithModule("PHARMACOVIGILANCE", "UPDATE"), {
    type: "GENERIC", title: `Cas de pharmacovigilance signalé — ${cree.reference}`,
    body: `${productLabel} · ${institutionName} (${user.name})`, link: lienRegulatory(cree.id),
  }).catch(sansBloquer("pharmacovigilance-actions.signalerCasPv.notifyRoles"));
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cree.id,
    summary: `Cas ${cree.reference} signalé — ${productLabel} · ${institutionName}`,
  });
  revaliderCas(cree.id);
  return {
    ok: true, id: cree.id,
    ...(echecs.length ? { message: `Cas ${cree.reference} signalé, mais ${echecs.length} pièce(s) n'ont pas pu être jointes : ${echecs.join(" ; ")}` } : { message: `Cas ${cree.reference} signalé à Regulatory.` }),
  };
}

/** L'ÉCHANGE DU CAS — le KAM, Regulatory et les personnes ajoutées ; chacun des suiveurs est prévenu, sauf l'auteur. */
export async function commenterCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const body = fdStr(formData, "body");
  if (!body) return { ok: false, error: "Message vide." };
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };

  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: body.slice(0, 10000), authorId: user.id } });
  const suiveurs = (await suiveursDuCas(cas)).filter((u) => u !== user.id);
  for (const uid of suiveurs) {
    await notifyUser({ userId: uid, type: "GENERIC", title: `${cas.reference} — nouveau message`, body: `${user.name} : ${body.slice(0, 80)}`, link: lienPour(uid, cas) }).catch(sansBloquer("pharmacovigilance-actions.commenterCasPv.notifyUser"));
  }
  // PERSONNE DE REGULATORY NE SUIT ENCORE LE CAS : le message du KAM ne doit pas tomber dans le vide.
  const instructeurSuit = suiveurs.some((u) => u !== cas.reporterId && !cas.participants.some((p) => p.userId === u));
  if (!instruitLesCasPv(user) && !instructeurSuit) {
    await notifyRoles(rolesWithModule("PHARMACOVIGILANCE", "UPDATE"), {
      type: "GENERIC", title: `${cas.reference} — nouveau message`, body: `${user.name} : ${body.slice(0, 80)}`, link: lienRegulatory(cas.id),
    }).catch(sansBloquer("pharmacovigilance-actions.commenterCasPv.notifyRoles"));
  }
  revaliderCas(cas.id);
  return { ok: true };
}

/** CHANGER LE STATUT — prendre en analyse, clore (avec sa note), rouvrir. Réservé à qui instruit. */
export async function changerStatutCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const statut = fdStr(formData, "status");
  const note = fdStr(formData, "note");
  if (!estStatutPv(statut)) return { ok: false, error: "Statut inconnu." };
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory instruit un cas de pharmacovigilance." };
  const de = cas.status;
  const refus = refusTransitionPv(de, statut, note);
  if (refus) return { ok: false, error: refus };

  await prisma.pharmacovigilanceCase.update({
    where: { id: cas.id },
    data: statut === "CLOS"
      ? { status: statut, closedAt: new Date(), closedById: user.id, closingNote: note }
      : de === "CLOS"
        ? { status: statut, closedAt: null, closedById: null }
        : { status: statut },
  });
  const trace = `Statut : ${STATUT_PV[de].label} → ${STATUT_PV[statut].label}.${note ? `\n${note}` : ""}`;
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: trace, authorId: user.id } });
  for (const uid of (await suiveursDuCas(cas)).filter((u) => u !== user.id)) {
    await notifyUser({ userId: uid, type: "GENERIC", title: `${cas.reference} — ${STATUT_PV[statut].label}`, body: note ? note.slice(0, 120) : `${cas.productLabel} · ${cas.institutionName}`, link: lienPour(uid, cas) }).catch(sansBloquer("pharmacovigilance-actions.changerStatutCasPv.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: statut === "CLOS" ? "VALIDATE" : "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id,
    summary: `Cas ${cas.reference} : ${STATUT_PV[de].label} → ${STATUT_PV[statut].label}`,
  });
  revaliderCas(cas.id);
  return { ok: true };
}

/**
 * OUVRIR UNE ENQUÊTE APPROFONDIE — Regulatory demande des informations complémentaires : le cas passe « Enquête »,
 * la demande s'écrit dans l'échange et le KAM est prévenu de ce qu'on attend de lui.
 */
export async function ouvrirEnquetePv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const infos = fdStr(formData, "requestedInfo");
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory ouvre une enquête approfondie." };
  const refus = refusEnquetePv(cas.status, infos);
  if (refus || !infos) return { ok: false, error: refus ?? "Précisez les informations demandées." };

  await prisma.pharmacovigilanceCase.update({
    where: { id: cas.id },
    data: { status: "ENQUETE", investigationOpenedAt: new Date(), investigationOpenedById: user.id, requestedInfo: infos.slice(0, 10000) },
  });
  await prisma.comment.create({
    data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: `Enquête approfondie ouverte — informations complémentaires demandées :\n${infos}`, authorId: user.id },
  });
  await notifyUser({
    userId: cas.reporterId, type: "VALIDATION_REQUIRED", title: `${cas.reference} — informations complémentaires demandées`,
    body: infos.slice(0, 160), link: lienKam(cas.id),
  }).catch(sansBloquer("pharmacovigilance-actions.ouvrirEnquetePv.notifyUser"));
  for (const p of cas.participants) {
    if (p.userId === user.id || p.userId === cas.reporterId) continue;
    await notifyUser({ userId: p.userId, type: "GENERIC", title: `${cas.reference} — enquête approfondie ouverte`, body: infos.slice(0, 120), link: lienRegulatory(cas.id) }).catch(sansBloquer("pharmacovigilance-actions.ouvrirEnquetePv.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id,
    summary: `Enquête approfondie ouverte sur ${cas.reference}`,
  });
  revaliderCas(cas.id);
  return { ok: true };
}

/** AJOUTER DES PERSONNES À L'ÉCHANGE — elles lisent le cas et y prennent part. Réservé à qui instruit. */
export async function ajouterParticipantsPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const ids = [...new Set(formData.getAll("userId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Choisissez au moins une personne." };
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory ajoute des personnes à l'échange." };
  const deja = new Set([cas.reporterId, ...cas.participants.map((p) => p.userId)]);
  const actifs = await prisma.user.findMany({ where: { id: { in: ids.filter((x) => !deja.has(x)) }, isActive: true }, select: { id: true, name: true } });
  if (actifs.length === 0) return { ok: false, error: "Ces personnes suivent déjà le cas." };
  await prisma.pharmacovigilanceParticipant.createMany({ data: actifs.map((u) => ({ caseId: cas.id, userId: u.id, addedById: user.id })), skipDuplicates: true });
  const noms = actifs.map((u) => u.name).join(", ");
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: `A ajouté à l'échange : ${noms}.`, authorId: user.id } });
  for (const u of actifs) {
    await notifyUser({ userId: u.id, type: "GENERIC", title: `Ajouté à un cas de pharmacovigilance`, body: `${cas.reference} — ${cas.productLabel} · ${cas.institutionName}`, link: lienRegulatory(cas.id) }).catch(sansBloquer("pharmacovigilance-actions.ajouterParticipantsPv.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, summary: `Participants ajoutés à ${cas.reference} : ${noms}` });
  revaliderCas(cas.id);
  return { ok: true, message: `${noms} ${actifs.length > 1 ? "participent" : "participe"} désormais à l'échange.` };
}

/** RETIRER UNE PERSONNE — par qui instruit, ou par elle-même (se retirer). */
export async function retirerParticipantPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const userId = fdStr(formData, "userId");
  if (!userId) return { ok: false, error: "Participant introuvable." };
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (userId !== user.id && !instruitLesCasPv(user)) return { ok: false, error: "Non autorisé." };
  const r = await prisma.pharmacovigilanceParticipant.deleteMany({ where: { caseId: cas.id, userId } });
  if (r.count === 0) return { ok: false, error: "Cette personne ne participe pas à l'échange." };
  const nom = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "—";
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: userId === user.id ? "S'est retiré de l'échange." : `A retiré de l'échange : ${nom}.`, authorId: user.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, summary: `Participant retiré de ${cas.reference} : ${nom}` });
  revaliderCas(cas.id);
  return { ok: true };
}
