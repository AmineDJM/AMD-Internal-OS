"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasGlobalView, rolesWithModule, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { persistUploadedDocument } from "@/lib/documents";
import { getAppSettings } from "@/lib/settings";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN, lienCasPvKam } from "@/lib/chemins/rapports-terrain";
import { instruitLesCasPv, lecteurPv, signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import {
  PREFIXE_REFERENCE_PV, STATUT_PV, estGravitePv, estStatutPv, lecteurDuCasPv, lireAgePv, refusEnquetePv, refusTransitionPv,
  statutApresDemandeInfosPv, statutDeReouverturePv, type ContexteCasPv, type StatutPv,
} from "@/lib/pharmacovigilance/regles";
import {
  IMPUTABILITE_PV, echeanceDeclarationPv, jourFrPv, jourAlgerPv, lireOuiNonPv, refusAccusePv, refusDeclarationPv, refusDelaisPv,
  refusEvaluationPv, refusVisaPv, statutApresEvaluationPv, type ImputabilitePv,
} from "@/lib/pharmacovigilance/declaration";
import { lireReglagesPv, viseursPourLeCasPv } from "@/lib/pharmacovigilance/reglages";
import { informerDgCasGravePv } from "@/lib/pharmacovigilance/alertes";
import { sansBloquer } from "@/lib/journal";
import { encadrantDuDelegue } from "@/lib/queries/equipe-delegue";

/**
 * PHARMACOVIGILANCE — actions serveur (Direction, 06/10 ; déclaration à l'autorité, Super Admin 24/11/2026).
 *
 * Le KAM SIGNALE un cas depuis son planning (Visite médicale) ; Regulatory le reçoit, l'ÉVALUE, le DÉCLARE à l'autorité
 * (hors plateforme, puis enregistre la déclaration et sa pièce), en assure le suivi et le clôt ; le pharmacien
 * responsable désigné vise la déclaration. Chaque action relit le cas et sa règle (`lecteurDuCasPv`) : un identifiant
 * deviné ne suffit jamais. Chaque passage de statut est CONDITIONNEL (§118.151) : deux gestes croisés n'écrasent rien.
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
  return referenceDeSerie({
    modele: "PharmacovigilanceCase", prefixe: PREFIXE_REFERENCE_PV, annee,
    existantes: async () => (await prisma.pharmacovigilanceCase.findMany({
      where: { reference: { startsWith: `${PREFIXE_REFERENCE_PV}-${annee}-` } },
      select: { reference: true },
    })).map((r) => r.reference),
  });
}

/** Le cas, lu pour une personne — `null` quand il n'existe pas OU qu'elle ne le lit pas (même réponse). */
async function casLisible(user: SessionUser, caseId: string | null) {
  if (!caseId) return null;
  const cas = await prisma.pharmacovigilanceCase.findUnique({
    where: { id: caseId },
    select: {
      id: true, reference: true, status: true, reporterId: true, productLabel: true, institutionName: true,
      investigationOpenedById: true, closedById: true, participants: { select: { userId: true } },
      productId: true, promoProductId: true, severity: true, dateConnaissance: true, evalGrave: true, evalueLe: true, evalueParId: true,
      declareLe: true, visaPharmacienLe: true,
    },
  });
  if (!cas || !lecteurDuCasPv(lecteurPv(user), cas)) return null;
  return { ...cas, status: cas.status as StatutPv };
}

/** Ce que le changement de statut doit savoir du cas : déclaré, évalué, gravité, visa attendu et donné. */
async function contexteDuCas(cas: NonNullable<Awaited<ReturnType<typeof casLisible>>>): Promise<ContexteCasPv> {
  const viseurs = cas.declareLe ? await viseursPourLeCasPv(cas) : [];
  return {
    declare: cas.declareLe !== null, evalue: cas.evalueLe !== null, evalGrave: cas.evalGrave,
    visaRequis: viseurs.length > 0, vise: cas.visaPharmacienLe !== null,
  };
}

/** Le refus quand un autre geste a changé le cas entre la lecture et l'écriture. */
const CAS_DEJA_CHANGE = "Le cas vient de changer (un autre geste est passé) : rechargez la fiche.";

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

  // LA VISITE D'OÙ PART LE SIGNALEMENT (Visite médicale 11/2026) — relue ici : un identifiant posté ne rattache pas un cas
  // à la visite d'un autre délégué. Son encadrant (superviseur de BU, sinon N+1) entre dans l'échange : il relit ce rapport.
  const visitId = fdStr(formData, "visitId");
  let encadrantId: string | null = null;
  let visite: { delegateId: string | null; date: Date; pvIaExtrait: string | null } | null = null;
  if (visitId) {
    visite = await prisma.medicalVisit.findUnique({ where: { id: visitId }, select: { delegateId: true, date: true, pvIaExtrait: true } });
    if (!visite) return { ok: false, error: "Cette visite n'existe plus : signalez sans la rattacher, ou rouvrez le lien depuis le compte rendu." };
    if (visite.delegateId !== user.id && !hasGlobalView(user)) {
      return { ok: false, error: "Cette visite n'est pas la vôtre : on rattache un signalement à SA visite. Signalez sans rattacher." };
    }
    encadrantId = visite.delegateId ? await encadrantDuDelegue(visite.delegateId).catch(sansBloquer("pharmacovigilance-actions.signalerCasPv.encadrant", null)) : null;
  }

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
      visitId: visitId ?? null,
      occurredOn,
      description: description.slice(0, 10000),
      patientAge,
      patientSex: sexe === "F" || sexe === "M" ? sexe : null,
      severity: estGravitePv(gravite) ? gravite : null,
      // LE JOUR ZÉRO DU DÉLAI DE DÉCLARATION : la société sait dès la visite (le délégué y était), sinon au signalement.
      dateConnaissance: visite && visite.date.getTime() < Date.now() ? visite.date : new Date(),
      // LA CITATION DE L'IA, figée : le compte rendu corrigé l'efface sur la visite, le cas la garde.
      citationIa: visite?.pvIaExtrait ?? null,
    },
    select: { id: true, reference: true },
  }));
  if (encadrantId && encadrantId !== user.id) {
    await prisma.pharmacovigilanceParticipant.create({ data: { caseId: cree.id, userId: encadrantId, addedById: user.id } })
      .catch(sansBloquer("pharmacovigilance-actions.signalerCasPv.encadrant"));
  }

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
  // UN CAS SIGNALÉ GRAVE (ou décès) : le DG le sait tout de suite — une seule fois par cas.
  if (gravite === "GRAVE" || gravite === "DECES") {
    await informerDgCasGravePv({ id: cree.id, reference: cree.reference, productLabel, institutionName });
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cree.id,
    summary: `Cas ${cree.reference} signalé — ${productLabel} · ${institutionName}${visitId ? " (rattaché à sa visite)" : ""}`,
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

/**
 * CHANGER LE STATUT — passer en suivi après la déclaration, clore (avec sa note), rouvrir (là où le cas en était).
 * Réservé à qui instruit. Évaluer et déclarer ont leurs propres gestes.
 */
export async function changerStatutCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  const demande = fdStr(formData, "status");
  const note = fdStr(formData, "note");
  if (!estStatutPv(demande) && demande !== "ROUVRIR") return { ok: false, error: "Statut inconnu." };
  const cas = await casLisible(user, caseId);
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory instruit un cas de pharmacovigilance." };
  const de = cas.status;
  const ctx = await contexteDuCas(cas);
  // « Rouvrir » : le serveur décide où, d'après le cas lui-même.
  const statut: StatutPv = demande === "ROUVRIR" ? (de === "CLOS" ? statutDeReouverturePv(ctx) : de) : demande as StatutPv;
  const refus = refusTransitionPv(de, statut, note, ctx);
  if (refus) return { ok: false, error: refus };

  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, status: de },
    data: statut === "CLOS"
      ? { status: statut, closedAt: new Date(), closedById: user.id, closingNote: note }
      : de === "CLOS"
        ? { status: statut, closedAt: null, closedById: null }
        : { status: statut },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };
  const sansDeclaration = statut === "CLOS" && !ctx.declare ? " (sans déclaration à l'autorité)" : "";
  const trace = `Statut : ${STATUT_PV[de].label} → ${STATUT_PV[statut].label}${sansDeclaration}.${note ? `\n${note}` : ""}`;
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: trace, authorId: user.id } });
  for (const uid of (await suiveursDuCas(cas)).filter((u) => u !== user.id)) {
    await notifyUser({ userId: uid, type: "GENERIC", title: `${cas.reference} — ${STATUT_PV[statut].label}`, body: note ? note.slice(0, 120) : `${cas.productLabel} · ${cas.institutionName}`, link: lienPour(uid, cas) }).catch(sansBloquer("pharmacovigilance-actions.changerStatutCasPv.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: statut === "CLOS" ? "VALIDATE" : "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id,
    summary: `Cas ${cas.reference} : ${STATUT_PV[de].label} → ${STATUT_PV[statut].label}${sansDeclaration}`,
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

  // AVANT l'évaluation : enquête approfondie ; un cas évalué reste à déclarer (la demande ne suspend pas le délai) ;
  // après la déclaration : suivi.
  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, status: cas.status },
    data: { status: statutApresDemandeInfosPv(cas.status), investigationOpenedAt: new Date(), investigationOpenedById: user.id, requestedInfo: infos.slice(0, 10000) },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };
  await prisma.comment.create({
    data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: `${statutApresDemandeInfosPv(cas.status) === "ENQUETE" ? "Enquête approfondie ouverte" : "Informations complémentaires demandées"} — à fournir :\n${infos}`, authorId: user.id },
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

// ═══════════════════════ LA DÉCLARATION À L'AUTORITÉ (Super Admin, 24/11/2026) ═══════════════════════

const ouiNon = (b: boolean, oui: string, non: string) => (b ? oui : non);

/** Joindre une pièce au cas — un refus est rendu tel quel (le geste s'arrête avant d'écrire quoi que ce soit). */
async function joindrePiece(userId: string, caseId: string, file: File, category: "SUBMISSION_LETTER" | "SUPPORTING_DOC", stepKey: string) {
  return persistUploadedDocument(userId, {
    entityType: "PHARMACOVIGILANCE_CASE", entityId: caseId, category, confidentiality: "CONFIDENTIAL", stepKey, file,
    maxUploadMb: (await getAppSettings()).maxUploadMb,
  });
}

const fichier = (formData: FormData, cle: string): File | null => {
  const f = formData.get(cle);
  return f instanceof File && f.size > 0 ? f : null;
};

/**
 * ÉVALUER UN CAS — Regulatory arrête la gravité (grave / non grave), le caractère attendu ou inattendu, l'imputabilité,
 * et peut corriger la date de connaissance. L'échéance de déclaration en découle (`declaration.ts`) ; un cas grave est
 * porté à la connaissance du DG. Réévaluer reste possible tant que le cas n'est pas clos.
 */
export async function evaluerCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cas = await casLisible(user, fdStr(formData, "caseId"));
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory évalue un cas de pharmacovigilance." };
  const maintenant = new Date();
  const saisie = {
    grave: lireOuiNonPv(fdStr(formData, "grave")), attendu: lireOuiNonPv(fdStr(formData, "attendu")),
    imputabilite: fdStr(formData, "imputabilite"), dateConnaissance: fdDate(formData, "dateConnaissance"),
  };
  const refus = refusEvaluationPv(cas.status, saisie, maintenant);
  if (refus) return { ok: false, error: refus };
  const grave = saisie.grave!, attendu = saisie.attendu!, imputabilite = saisie.imputabilite as ImputabilitePv;
  const note = fdStr(formData, "note")?.slice(0, 10000) ?? null;
  const dateConnaissance = saisie.dateConnaissance ?? cas.dateConnaissance;

  // L'ÉCHÉANCE AVANT / APRÈS : si elle bouge, les paliers d'alerte repartent de zéro — la nouvelle date mérite d'être dite.
  const { delais } = await lireReglagesPv();
  const avant = echeanceDeclarationPv(cas, delais);
  const apres = echeanceDeclarationPv({ dateConnaissance, evalGrave: grave, severity: cas.severity }, delais);
  const vers = statutApresEvaluationPv(cas.status);
  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, status: cas.status },
    data: {
      status: vers, evalGrave: grave, evalAttendu: attendu, evalImputabilite: imputabilite, evalNote: note,
      evalueLe: maintenant, evalueParId: user.id, dateConnaissance,
      ...(avant.jour !== apres.jour ? { alertePalier: null, alertePalierLe: null } : {}),
    },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };

  const jugement = `${ouiNon(grave, "grave", "non grave")}, ${ouiNon(attendu, "attendu", "inattendu")}, imputabilité ${IMPUTABILITE_PV[imputabilite].toLowerCase()}`;
  const echeance = cas.declareLe ? "" : `\nÉchéance de déclaration à l'autorité : ${jourFrPv(apres.jour)} (${apres.delaiJours} jours après la connaissance du cas, le ${jourFrPv(jourAlgerPv(dateConnaissance))}).`;
  await prisma.comment.create({
    data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, body: `Évaluation : cas ${jugement}.${echeance}${note ? `\n${note}` : ""}`, authorId: user.id },
  });
  if (grave) await informerDgCasGravePv(cas, maintenant);
  for (const uid of (await suiveursDuCas(cas)).filter((u) => u !== user.id)) {
    await notifyUser({ userId: uid, type: "GENERIC", title: `${cas.reference} — évalué (${ouiNon(grave, "grave", "non grave")})`, body: `${cas.productLabel} · ${cas.institutionName}`, link: lienPour(uid, cas) })
      .catch(sansBloquer("pharmacovigilance-actions.evaluerCasPv.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id,
    summary: `Cas ${cas.reference} évalué : ${jugement}`,
  });
  revaliderCas(cas.id);
  return { ok: true, message: cas.declareLe ? "Évaluation enregistrée." : `Évaluation enregistrée — à déclarer avant le ${jourFrPv(apres.jour)}.` };
}

/**
 * ENREGISTRER LA DÉCLARATION À L'AUTORITÉ — faite HORS plateforme (aucune transmission électronique) : la date d'envoi,
 * la référence, la pièce (obligatoire) et, s'il est déjà là, l'accusé de réception. Le pharmacien responsable désigné
 * entre dans l'échange : c'est à lui de viser.
 */
export async function declarerCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cas = await casLisible(user, fdStr(formData, "caseId"));
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory enregistre la déclaration à l'autorité." };
  const maintenant = new Date();
  const piece = fichier(formData, "piece");
  const accuseFichier = fichier(formData, "accuseFichier");
  const saisie = {
    declareLe: fdDate(formData, "declareLe"), reference: fdStr(formData, "reference"), piece: piece !== null,
    accuseLe: fdDate(formData, "accuseLe"),
  };
  if (accuseFichier && !saisie.accuseLe) return { ok: false, error: "Indiquez la date de l'accusé de réception joint." };
  const refus = refusDeclarationPv({ status: cas.status, evalue: cas.evalueLe !== null, dateConnaissance: cas.dateConnaissance }, saisie, maintenant);
  if (refus) return { ok: false, error: refus };

  // LA PIÈCE D'ABORD : sans elle, rien ne s'enregistre (une déclaration sans preuve ne vaut pas mieux qu'aucune).
  const depot = await joindrePiece(user.id, cas.id, piece!, "SUBMISSION_LETTER", "PV_DECLARATION");
  if (!depot.ok) return { ok: false, error: `La pièce de la déclaration n'a pas pu être jointe : ${depot.error ?? "échec"}. Rien n'a été enregistré.` };
  const reference = saisie.reference!.slice(0, 200);
  const accuseReference = fdStr(formData, "accuseReference")?.slice(0, 200) ?? null;
  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, status: cas.status, declareLe: null },
    data: {
      status: "DECLARE", declareLe: saisie.declareLe, declarationReference: reference, declarationEnregistreeLe: maintenant, declareParId: user.id,
      ...(saisie.accuseLe ? { accuseLe: saisie.accuseLe, accuseReference } : {}),
    },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };
  const echecs: string[] = [];
  if (accuseFichier) {
    const r = await joindrePiece(user.id, cas.id, accuseFichier, "SUPPORTING_DOC", "PV_ACCUSE");
    if (!r.ok) echecs.push(`l'accusé n'a pas pu être joint (${r.error ?? "échec"})`);
  }

  // LE PHARMACIEN RESPONSABLE lit le cas et sa pièce : il entre dans l'échange, et il est prévenu du visa attendu.
  const viseurs = (await viseursPourLeCasPv(cas)).filter((u) => u !== cas.reporterId);
  if (viseurs.length) {
    await prisma.pharmacovigilanceParticipant.createMany({ data: viseurs.map((u) => ({ caseId: cas.id, userId: u, addedById: user.id })), skipDuplicates: true })
      .catch(sansBloquer("pharmacovigilance-actions.declarerCasPv.viseurs"));
  }
  const date = jourFrPv(jourAlgerPv(saisie.declareLe!));
  await prisma.comment.create({
    data: {
      entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, authorId: user.id,
      body: `Déclaré à l'autorité le ${date} — référence ${reference}.${saisie.accuseLe ? ` Accusé de réception du ${jourFrPv(jourAlgerPv(saisie.accuseLe))}${accuseReference ? ` (${accuseReference})` : ""}.` : ""}`,
    },
  });
  for (const uid of (await suiveursDuCas({ ...cas, participants: [...cas.participants, ...viseurs.map((userId) => ({ userId }))] })).filter((u) => u !== user.id)) {
    const vise = viseurs.includes(uid);
    await notifyUser({
      userId: uid, type: vise ? "VALIDATION_REQUIRED" : "GENERIC",
      title: vise ? `${cas.reference} — déclaration à viser` : `${cas.reference} — déclaré à l'autorité`,
      body: `Référence ${reference}, envoyée le ${date} · ${cas.productLabel}`, link: lienPour(uid, cas),
    }).catch(sansBloquer("pharmacovigilance-actions.declarerCasPv.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id,
    summary: `Cas ${cas.reference} déclaré à l'autorité le ${date} (réf. ${reference})`,
  });
  revaliderCas(cas.id);
  return { ok: true, message: echecs.length ? `Déclaration enregistrée, mais ${echecs.join(" ; ")}.` : "Déclaration enregistrée." };
}

/** L'ACCUSÉ DE RÉCEPTION de l'autorité, arrivé après la déclaration : sa date, sa référence, sa pièce (facultative). */
export async function enregistrerAccuseCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cas = await casLisible(user, fdStr(formData, "caseId"));
  if (!cas) return { ok: false, error: "Cas introuvable." };
  if (!instruitLesCasPv(user)) return { ok: false, error: "Seul Regulatory enregistre l'accusé de l'autorité." };
  const accuseLe = fdDate(formData, "accuseLe");
  const refus = refusAccusePv(cas, accuseLe, new Date());
  if (refus) return { ok: false, error: refus };
  const accuseFichier = fichier(formData, "accuseFichier");
  if (accuseFichier) {
    const r = await joindrePiece(user.id, cas.id, accuseFichier, "SUPPORTING_DOC", "PV_ACCUSE");
    if (!r.ok) return { ok: false, error: `L'accusé n'a pas pu être joint : ${r.error ?? "échec"}. Rien n'a été enregistré.` };
  }
  const accuseReference = fdStr(formData, "accuseReference")?.slice(0, 200) ?? null;
  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, declareLe: { not: null }, status: { in: ["DECLARE", "SUIVI"] } },
    data: { accuseLe, accuseReference },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };
  const date = jourFrPv(jourAlgerPv(accuseLe!));
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, authorId: user.id, body: `Accusé de réception de l'autorité du ${date}${accuseReference ? ` (${accuseReference})` : ""}.` } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, summary: `Accusé de réception enregistré sur ${cas.reference} (${date})` });
  revaliderCas(cas.id);
  return { ok: true, message: "Accusé enregistré." };
}

/**
 * LE VISA DU PHARMACIEN RESPONSABLE — désigné par le Super Admin pour la société du produit (`PvReglage`). Il vise la
 * déclaration enregistrée ; sans ce visa, un cas déclaré ne se clôt pas.
 */
export async function viserCasPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const caseId = fdStr(formData, "caseId");
  if (!caseId) return { ok: false, error: "Cas introuvable." };
  // Le pharmacien désigné vise SANS forcément lire tous les cas : son droit vient de la désignation, relue ici.
  const brut = await prisma.pharmacovigilanceCase.findUnique({
    where: { id: caseId },
    select: { id: true, reference: true, status: true, reporterId: true, productLabel: true, institutionName: true, productId: true, promoProductId: true, declareLe: true, visaPharmacienLe: true, investigationOpenedById: true, closedById: true, participants: { select: { userId: true } } },
  });
  if (!brut) return { ok: false, error: "Cas introuvable." };
  const cas = { ...brut, status: brut.status as StatutPv };
  const refus = refusVisaPv(cas, await viseursPourLeCasPv(cas), user.id);
  if (refus) return { ok: false, error: refus };
  const note = fdStr(formData, "note")?.slice(0, 2000) ?? null;
  const ecrit = await prisma.pharmacovigilanceCase.updateMany({
    where: { id: cas.id, visaPharmacienLe: null, declareLe: { not: null } },
    data: { visaPharmacienLe: new Date(), visaPharmacienParId: user.id, visaPharmacienNote: note },
  });
  if (ecrit.count === 0) return { ok: false, error: CAS_DEJA_CHANGE };
  await prisma.comment.create({ data: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, authorId: user.id, body: `Visa du pharmacien responsable sur la déclaration.${note ? `\n${note}` : ""}` } });
  for (const uid of (await suiveursDuCas(cas)).filter((u) => u !== user.id && u !== cas.reporterId)) {
    await notifyUser({ userId: uid, type: "GENERIC", title: `${cas.reference} — déclaration visée`, body: `Par ${user.name}`, link: lienRegulatory(cas.id) })
      .catch(sansBloquer("pharmacovigilance-actions.viserCasPv.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id, summary: `Déclaration du cas ${cas.reference} visée par le pharmacien responsable` });
  revaliderCas(cas.id);
  return { ok: true, message: "Déclaration visée." };
}

/**
 * LES RÉGLAGES DE LA PHARMACOVIGILANCE — Super Admin seul : les délais de déclaration (cas grave, non grave — À
 * CONFIRMER par le pharmacien responsable / la réglementation algérienne) et le pharmacien responsable désigné par
 * société (champs `designation` = « companyId:userId », vide = aucun).
 */
export async function modifierReglagesPv(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul le Super Admin règle les délais et les désignations de pharmacovigilance." };
  const entier = (cle: string) => { const s = fdStr(formData, cle); const n = s === null ? NaN : Number(s); return Number.isInteger(n) ? n : null; };
  const delais = { graveJours: entier("delaiGraveJours"), nonGraveJours: entier("delaiNonGraveJours") };
  const refus = refusDelaisPv(delais);
  if (refus) return { ok: false, error: refus };

  // Une désignation = « companyId:userId » (champ « designation », un par société désignée ; vide = aucune).
  const demandees: Record<string, string> = {};
  for (const v of formData.getAll("designation")) {
    if (typeof v !== "string" || !v.includes(":")) continue;
    const [societe, personne] = v.split(":");
    if (societe && personne) demandees[societe] = personne;
  }
  const [societes, personnes] = await Promise.all([
    prisma.company.findMany({ where: { id: { in: Object.keys(demandees) } }, select: { id: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(Object.values(demandees))] }, isActive: true }, select: { id: true } }),
  ]);
  const okSoc = new Set(societes.map((s) => s.id)), okPers = new Set(personnes.map((p) => p.id));
  const pharmaciens = Object.fromEntries(Object.entries(demandees).filter(([c, u]) => okSoc.has(c) && okPers.has(u)));
  if (Object.keys(pharmaciens).length !== Object.keys(demandees).length) {
    return { ok: false, error: "Une société ou une personne désignée n'existe plus (ou le compte est désactivé) : rechargez la page." };
  }
  const avant = await lireReglagesPv();
  await prisma.pvReglage.upsert({
    where: { id: "global" },
    create: { id: "global", delaiGraveJours: delais.graveJours!, delaiNonGraveJours: delais.nonGraveJours!, pharmaciensResponsables: pharmaciens, updatedById: user.id },
    update: { delaiGraveJours: delais.graveJours!, delaiNonGraveJours: delais.nonGraveJours!, pharmaciensResponsables: pharmaciens, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "PHARMACOVIGILANCE_CASE", entityId: "global",
    summary: `Réglages de pharmacovigilance : délais ${avant.delais.graveJours}/${avant.delais.nonGraveJours} → ${delais.graveJours}/${delais.nonGraveJours} jours (grave / non grave), ${Object.keys(pharmaciens).length} pharmacien(s) responsable(s) désigné(s)`,
  });
  revaliderCas();
  return { ok: true, message: "Réglages enregistrés." };
}
