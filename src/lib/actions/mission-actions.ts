"use server";

import { revalidatePath } from "next/cache";
import type { EntityType, MissionRole, Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { rolesWithModule } from "@/lib/rbac";
import { getManagerOf, getManagementChain } from "@/lib/departments";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { refusRetraitOrdreMission, refusAnnulationDemandeRh } from "@/lib/annulations/regles";
import { requestHrDocument } from "@/modules/rh/actions-documents";
import { createRequest } from "@/lib/actions/admin-request-actions";
import { demanderMateriel } from "@/lib/actions/promo-stock-actions";
import { MES_MISSIONS, PARENT_TYPES, parentPath, parentMission, rolesDe, organisateursDe } from "@/lib/missions-equipe/serveur";
import { assurerImputationEquipe, categorieEquipePour, categorieEquipeValide } from "@/lib/missions-equipe/imputation-serveur";
import {
  refusReponse, peutRelancerInvitation, retraitSouple, refusAjoutEtape, etatOrdreMission, peutDemanderOrdre,
  peutRetirerOrdre, marcheInitiale, refusDecisionN1, noteFraisOuverte, jourIso, objetOrdreMission,
  refusMontantFrais, demandeRelancable, SOUS_TYPE_SECRETARIAT, LIBELLE_ETAPE,
  type HrStatut, type GateN1, type ReponseMission,
} from "@/lib/missions-equipe/etat";
import {
  lireFiche, ficheStockee, etapeParticipation, estArbitre, coteDe, refusProposition, refusDecision, natureNouvelleVersion,
  peutDemanderOmParticipation, datesConvenues, destinationConvenue, hebergementPourOm, peutDeposerReservation,
  peutChoisirBudgetMission, lireLigneFrais, tauxMission, totalFrais, manquesCloture, refusModifFrais, refusDecisionN1NoteFrais,
  moisNoteFrais, rapportRedige, versionLite, MODE_TRANSPORT_LIBELLE, NATURE_FRAIS_LIBELLE, TRAJETS_BILLET,
  type Cote, type NatureFrais,
} from "@/lib/missions-equipe/participation";
import { lireDetailsTrajets } from "@/modules/ad-pro/partage";
import { persistUploadedDocument } from "@/lib/documents";
import { lienMission, LIEN_MISSIONS_A_VALIDER } from "@/lib/chemins/espace";
import { toNumber } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MISSIONS AD & PRO RELIÉES AU PROFIL (Direction, 10/2026).
 *
 * Assigner = INVITER : la personne confirme ou décline (motif). Une mission confirmée se vit dans
 * « Mon espace › Mes missions » : l'ordre de mission (circuit RH unique, précédé du N+1), et — SEULEMENT
 * si la personne les ajoute — transport et hébergement (demande au secrétariat), matériel promotionnel
 * (demande au magasin), note de frais (demande RH). Chaque demande part dans SON circuit réel, reliée à
 * l'assignation ; rien n'est recopié ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MISSION_ROLES: MissionRole[] = ["ACCOMPAGNANT", "DELEGATE_REFERENCE"];

function revalider(entityType: EntityType, entityId: string): void {
  revalidatePath(parentPath(entityType, entityId));
  revalidatePath(MES_MISSIONS);
  revalidatePath(`${MES_MISSIONS}/[id]`, "page");
  revalidatePath("/missions");
}

const dates = (d: Date | null, f: Date | null) =>
  d ? ` · ${d.toLocaleDateString("fr-FR")}${f && f.getTime() !== d.getTime() ? ` → ${f.toLocaleDateString("fr-FR")}` : ""}` : "";

/**
 * INVITER — créer l'assignation, ou rouvrir celle d'une personne qui avait décliné ou été retirée
 * (une seule ligne par personne et par demande). On ne s'invite pas soi-même : on se confirme.
 */
async function inviter(
  actor: { id: string; name: string },
  entityType: EntityType, entityId: string, userId: string, role: MissionRole,
  opts: { note: string | null; dateDepart: Date | null; dateRetour: Date | null; ville: string | null },
): Promise<ActionResult> {
  const parent = await parentMission(entityType, entityId);
  const dateDepart = opts.dateDepart ?? parent.debut;
  const dateRetour = opts.dateRetour ?? parent.fin;
  const ville = opts.ville ?? parent.ville;
  const soi = userId === actor.id;
  const response: ReponseMission = soi ? "CONFIRMEE" : "INVITEE";
  const existante = await prisma.missionAssignment.findUnique({
    where: { entityType_entityId_userId: { entityType, entityId, userId } },
    select: { id: true, archivedAt: true, response: true },
  });
  if (existante && !existante.archivedAt && existante.response !== "DECLINEE") {
    return { ok: false, error: "Cette personne fait déjà partie de l'équipe." };
  }
  const data = {
    role, note: opts.note, createdById: actor.id, response, respondedAt: soi ? new Date() : null, declineReason: null,
    dateDepart, dateRetour, ville, lastNudgeAt: null, nudgeCount: 0, archivedAt: null, archivedById: null,
  };
  const a = existante
    ? await prisma.missionAssignment.update({ where: { id: existante.id }, data: { ...data, createdAt: new Date() }, select: { id: true } })
    : await prisma.missionAssignment.create({ data: { entityType, entityId, userId, ...data }, select: { id: true } });
  if (!soi) {
    // UNE DEMANDE DE PARTICIPATION (Direction, 10/2026) : la personne répond par sa fiche — ou décline.
    // Une personne réinvitée repart d'une fiche vierge : seules comptent les versions postérieures à l'invitation
    // (`createdAt` remis à maintenant) — celles d'avant restent en base, en histoire.
    if (existante) {
      await prisma.missionAssignment.update({ where: { id: existante.id }, data: { accordVersionId: null, accordAt: null } });
    }
    await notifyUser({
      userId, type: "ASSIGNMENT",
      title: role === "DELEGATE_REFERENCE" ? "Demande de participation — délégué de référence" : "Demande de participation — accompagnant",
      body: `${parent.label}${ville ? ` · ${ville}` : ""}${dates(dateDepart, dateRetour)} — par ${actor.name}. Remplissez votre fiche ou déclinez.`,
      link: lienMission(a.id),
    }).catch(sansBloquer("mission-actions.inviter.notifyUser"));
  }
  // LES FRAIS DE L'ÉQUIPE VONT AU BUDGET OPERATIONS & SALES (Direction, 10/2026) : l'imputation par défaut est posée dès
  // l'invitation — enveloppe de l'année ouverte d'office, catégorie « Frais de déplacement terrain » ; la Direction la change.
  await assurerImputationEquipe(a.id, actor.id, parent.debut);
  await recordAudit({ actorId: actor.id, action: "CREATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Invitation (${role}) sur ${parent.label}` });
  return { ok: true, id: a.id };
}

/** Inviter un accompagnant ou un délégué de référence (organisateur de la demande). */
export async function assignMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  const userId = fdStr(formData, "userId");
  if (!entityType || !PARENT_TYPES.includes(entityType) || !entityId || !userId) return { ok: false, error: "Paramètres manquants." };
  if (!(await canAccessEntity(user, entityType, entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const cible = await prisma.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true } });
  if (!cible) return { ok: false, error: "Cette personne n'est plus active." };

  const roleRaw = fdStr(formData, "role") as MissionRole | null;
  const role: MissionRole = roleRaw && MISSION_ROLES.includes(roleRaw) ? roleRaw : "ACCOMPAGNANT";
  const r = await inviter(user, entityType, entityId, userId, role, {
    note: fdStr(formData, "note"), dateDepart: fdDate(formData, "dateDepart"), dateRetour: fdDate(formData, "dateRetour"), ville: fdStr(formData, "ville"),
  });
  revalider(entityType, entityId);
  return r;
}

async function chargerAssignation(id: string | null) {
  if (!id) return null;
  return prisma.missionAssignment.findUnique({ where: { id } });
}

/** « Je confirme » / « Je décline » — la personne invitée ; décliner porte un motif et prévient l'organisateur. */
export async function repondreMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Mission introuvable." };
  const decision = fdStr(formData, "decision") === "DECLINER" ? "DECLINER" : "CONFIRMER";
  const motif = fdStr(formData, "motif");
  const refus = refusReponse(a, user.id, decision, motif);
  if (refus) return { ok: false, error: refus };
  // UNE DEMANDE DE PARTICIPATION SE RÉPOND PAR LA FICHE (Direction, 10/2026) : « Je confirme » sans fiche ne vaut plus.
  if (decision === "CONFIRMER" && a.response === "INVITEE") {
    return { ok: false, error: "Répondez par votre fiche de participation (dates, transport, hébergement)." };
  }

  const response: ReponseMission = decision === "CONFIRMER" ? "CONFIRMEE" : "DECLINEE";
  const pris = await prisma.missionAssignment.updateMany({
    where: { id: a.id, response: a.response, archivedAt: null },
    data: { response, respondedAt: new Date(), declineReason: decision === "DECLINER" ? motif : null },
  });
  if (pris.count === 0) return { ok: false, error: "La mission vient de changer — rechargez la page." };
  const parent = await parentMission(a.entityType, a.entityId);
  if (a.createdById && a.createdById !== user.id) {
    await notifyUser({
      userId: a.createdById, type: "GENERIC",
      title: decision === "CONFIRMER" ? "Mission confirmée" : "Mission déclinée",
      body: decision === "CONFIRMER" ? `${user.name} — ${parent.label}` : `${user.name} — ${parent.label} : « ${motif} ». Remplacez-le depuis la demande.`,
      link: parentPath(a.entityType, a.entityId),
    }).catch(sansBloquer("mission-actions.repondreMission.notifyUser"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id,
    field: "response", oldValue: a.response, newValue: response,
    summary: decision === "CONFIRMER" ? `Mission confirmée — ${parent.label}` : `Mission déclinée — ${parent.label} (${motif})`,
  });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: decision === "CONFIRMER" ? "Mission confirmée." : "Mission déclinée : l'organisateur est prévenu." };
}

/** Relancer une invitation sans réponse (organisateur) — la règle des tâches : quatre heures entre deux. */
export async function relancerMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Mission introuvable." };
  if (!(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const v = peutRelancerInvitation(a);
  if (!v.ok) return { ok: false, error: v.raison };
  const rang = a.nudgeCount + 1;
  await prisma.missionAssignment.update({ where: { id: a.id }, data: { lastNudgeAt: new Date(), nudgeCount: rang } });
  const parent = await parentMission(a.entityType, a.entityId);
  await notifyUser({
    userId: a.userId, type: "ASSIGNMENT",
    title: rang <= 1 ? "Relance — invitation à une mission" : `Relance (${rang}ᵉ) — invitation à une mission`,
    body: `${parent.label} — ${user.name} attend votre fiche de participation.`, link: lienMission(a.id),
    push: { requireInteraction: true },
  }).catch(sansBloquer("mission-actions.relancerMission.notifyUser"));
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, field: "relance", newValue: String(rang), summary: `Relance ${rang} — ${parent.label}` });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Relance envoyée." };
}

/** Les traces qui interdisent l'effacement : pièces, fil, demandes reliées. */
async function tracesDe(id: string) {
  const [documents, commentaires, rh, secretariat, materiel, versions, frais] = await Promise.all([
    prisma.document.count({ where: { entityType: "MISSION_ASSIGNMENT", entityId: id } }),
    prisma.comment.count({ where: { entityType: "MISSION_ASSIGNMENT", entityId: id } }),
    prisma.hrDocumentRequest.count({ where: { missionAssignmentId: id } }),
    prisma.administrativeRequest.count({ where: { linkedEntityType: "MISSION_ASSIGNMENT", linkedEntityId: id } }),
    prisma.promoStockRequest.count({ where: { missionAssignmentId: id } }),
    // Une fiche envoyée ou une dépense saisie est une trace : la négociation et les frais restent, archivés.
    prisma.missionParticipationVersion.count({ where: { assignmentId: id } }),
    prisma.missionExpenseLine.count({ where: { assignmentId: id } }),
  ]);
  return { documents, commentaires, demandes: rh + secretariat + materiel + versions + frais };
}

/** Retirer sans effacer ce qui a eu lieu : archive si traces, effacement sinon. */
async function retirer(a: { id: string; userId: string; entityType: EntityType; entityId: string }, actor: { id: string; name: string }, motif: string): Promise<"archivee" | "effacee"> {
  const souple = retraitSouple(await tracesDe(a.id));
  if (souple) {
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { archivedAt: new Date(), archivedById: actor.id } });
  } else {
    await prisma.missionAssignment.delete({ where: { id: a.id } });
  }
  const parent = await parentMission(a.entityType, a.entityId);
  if (a.userId !== actor.id) {
    await notifyUser({ userId: a.userId, type: "GENERIC", title: "Mission retirée", body: `${parent.label} — ${motif}`, link: MES_MISSIONS }).catch(sansBloquer("mission-actions.retirer.notifyUser"));
  }
  await recordAudit({ actorId: actor.id, action: souple ? "UPDATE" : "DELETE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Mission retirée (${souple ? "archivée" : "effacée"}) — ${parent.label}` });
  return souple ? "archivee" : "effacee";
}

/** Retirer une personne de l'équipe (organisateur) — archivée si elle porte des pièces ou des demandes. */
export async function removeMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Assignation introuvable." };
  if (!(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const r = await retirer(a, user, `${user.name} vous a retiré de l'équipe.`);
  revalider(a.entityType, a.entityId);
  return { ok: true, message: r === "archivee" ? "Retiré — la mission est archivée avec ses pièces et ses demandes." : "Retiré de l'équipe." };
}

/** Remplacer une personne (typiquement après un refus) : l'ancienne sort, la nouvelle est invitée au même rôle. */
export async function remplacerMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  const userId = fdStr(formData, "userId");
  if (!a) return { ok: false, error: "Assignation introuvable." };
  if (!userId) return { ok: false, error: "Choisissez la personne qui remplace." };
  if (userId === a.userId) return { ok: false, error: "Choisissez une autre personne." };
  if (!(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const cible = await prisma.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true } });
  if (!cible) return { ok: false, error: "Cette personne n'est plus active." };
  const r = await inviter(user, a.entityType, a.entityId, userId, a.role, { note: a.note, dateDepart: a.dateDepart, dateRetour: a.dateRetour, ville: a.ville });
  if (!r.ok) return r;
  await retirer(a, user, "vous êtes remplacé dans l'équipe.");
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Remplacement envoyé : la nouvelle personne est invitée." };
}

/** Dates et ville de la mission — l'organisateur, ou la personne elle-même. */
export async function modifierMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Mission introuvable." };
  if (a.userId !== user.id && !(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const dateDepart = fdDate(formData, "dateDepart");
  const dateRetour = fdDate(formData, "dateRetour");
  if (dateDepart && dateRetour && dateRetour < dateDepart) return { ok: false, error: "Le retour précède le départ." };
  await prisma.missionAssignment.update({ where: { id: a.id }, data: { dateDepart, dateRetour, ville: fdStr(formData, "ville") } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: "Dates / ville de la mission modifiées" });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Mission mise à jour." };
}

/** « ⋯ › Ajouter » — une étape facultative que la personne choisit de demander. */
export async function ajouterEtapeMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Mission introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne en mission ajoute ses étapes." };
  const etape = fdStr(formData, "etape");
  const refus = refusAjoutEtape(a, etape);
  if (refus) return { ok: false, error: refus };
  if (!a.etapes.includes(etape!)) {
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { etapes: { push: etape! } } });
  }
  revalidatePath(MES_MISSIONS);
  return { ok: true };
}

/** Retirer une étape ajoutée par erreur — tant qu'aucune demande n'y est partie. */
export async function retirerEtapeMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Mission introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne en mission retire ses étapes." };
  const etape = fdStr(formData, "etape");
  await prisma.missionAssignment.update({ where: { id: a.id }, data: { etapes: a.etapes.filter((e) => e !== etape) } });
  revalidatePath(MES_MISSIONS);
  return { ok: true };
}

// ─────────────────────────────── L'ordre de mission (N+1 → RH) ───────────────────────────────

async function dernierOrdre(assignmentId: string) {
  return prisma.hrDocumentRequest.findFirst({
    where: { missionAssignmentId: assignmentId, type: "MISSION_ORDER" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, managerGate: true, managerUserId: true },
  });
}

/**
 * « Demander l'ordre de mission » — UNE demande RH (MISSION_ORDER), pré-remplie depuis la mission,
 * qui monte d'abord au N+1 (organigramme) puis aux RH, où le générateur existant produit le PDF.
 */
export async function requestMissionOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Assignation introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne assignée peut demander un ordre de mission." };
  if (a.response !== "CONFIRMEE") return { ok: false, error: "La participation doit d'abord être convenue (accord trouvé)." };
  const precedent = await dernierOrdre(a.id);
  const etat = etatOrdreMission(precedent ? { status: precedent.status as HrStatut, managerGate: (precedent.managerGate ?? null) as GateN1 | null } : null, a.orderStatus);
  if (!peutDemanderOrdre(etat)) return { ok: false, error: etat === "EMIS" ? "L'ordre de mission est déjà émis." : "Un ordre de mission est déjà en cours." };

  const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true, fullName: true } });
  if (!employee) return { ok: false, error: "Aucun dossier RH n'est lié à votre compte : les RH ne peuvent pas établir l'ordre. Contactez-les." };
  const manager = await getManagerOf(employee.id).catch(sansBloquer("mission-actions.requestMissionOrder.getManagerOf", null));
  const marche = marcheInitiale(manager?.userId ?? null, user.id);

  const parent = await parentMission(a.entityType, a.entityId);
  // L'ACCORD FAIT FOI (Direction, 10/2026) : l'ordre part pré-rempli avec les dates, la destination, le transport
  // et l'hébergement convenus. Une mission d'avant la fiche garde ses dates propres.
  const convenue = a.accordVersionId
    ? ficheStockee((await prisma.missionParticipationVersion.findUnique({ where: { id: a.accordVersionId }, select: { contenu: true } }))?.contenu ?? null)
    : null;
  const datesAccord = convenue ? datesConvenues(convenue) : null;
  const depart = datesAccord?.depart ? new Date(`${datesAccord.depart}T00:00:00.000Z`) : a.dateDepart ?? parent.debut;
  const retour = datesAccord?.retour ? new Date(`${datesAccord.retour}T00:00:00.000Z`) : a.dateRetour ?? parent.fin;
  const ville = convenue ? destinationConvenue(convenue, a.ville ?? parent.ville) : a.ville ?? parent.ville;
  const omPrefill = {
    libelle: parent.label,
    objet: objetOrdreMission(a.role, parent.label),
    destination: ville ?? "",
    datesDepart: depart ? [jourIso(depart)] : [],
    datesRetour: retour ? [jourIso(retour)] : [],
    ...(convenue ? { transport: MODE_TRANSPORT_LIBELLE[convenue.transport.mode], hebergement: hebergementPourOm(convenue) } : {}),
  } satisfies Prisma.InputJsonObject;

  const created = await prisma.hrDocumentRequest.create({
    data: {
      employeeId: employee.id, type: "MISSION_ORDER", status: "PENDING",
      details: `Mission — ${parent.label}${ville ? ` · ${ville}` : ""}${dates(depart, retour)}`,
      missionAssignmentId: a.id, managerGate: marche.gate, managerUserId: marche.gate ? manager?.userId ?? null : null,
      omPrefill,
    },
    select: { id: true },
  });
  await prisma.missionAssignment.update({ where: { id: a.id }, data: { orderStatus: "REQUESTED", requestedAt: new Date() } });

  if (marche.gate === "PENDING" && manager?.userId) {
    await notifyUser({ userId: manager.userId, type: "GENERIC", title: "Ordre de mission à valider (votre équipe)", body: `${employee.fullName} — ${parent.label}${dates(depart, retour)}`, link: LIEN_MISSIONS_A_VALIDER }).catch(sansBloquer("mission-actions.requestMissionOrder.notifyUser"));
  } else {
    await notifyRoles(rolesWithModule("HR_REQUESTS", "UPDATE"), { type: "GENERIC", title: "Ordre de mission à établir", body: `${employee.fullName} — ${parent.label}`, link: `/rh/demandes?demande=${created.id}` }).catch(sansBloquer("mission-actions.requestMissionOrder.notifyRoles"));
  }
  await recordAudit({ actorId: user.id, action: "CREATE", module: "RH", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Ordre de mission demandé — ${parent.label}${marche.gate ? " (N+1 puis RH)" : " (directement aux RH)"}` });
  revalider(a.entityType, a.entityId);
  revalidatePath("/mon-dossier");
  revalidatePath("/rh/demandes");
  return { ok: true, id: created.id, message: marche.message };
}

/**
 * RETIRER SA DEMANDE D'ORDRE DE MISSION (décision du 04/10) — tant que les RH ne l'ont pas produite :
 * la demande RH liée est annulée. Une demande d'avant le circuit (simple marqueur) revient à « aucun ».
 */
export async function retirerDemandeOrdreMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Assignation introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne assignée retire sa demande d'ordre de mission." };
  const req = await dernierOrdre(a.id);
  if (req) {
    const etat = etatOrdreMission({ status: req.status as HrStatut, managerGate: (req.managerGate ?? null) as GateN1 | null }, a.orderStatus);
    if (!peutRetirerOrdre(etat)) return { ok: false, error: etat === "EMIS" ? "L'ordre de mission a déjà été émis : il ne se retire plus d'ici." : "Aucun ordre de mission n'est en cours." };
    const refus = refusAnnulationDemandeRh(req.status);
    if (refus) return { ok: false, error: refus };
    const pris = await prisma.hrDocumentRequest.updateMany({ where: { id: req.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, data: { status: "CANCELLED", hrNote: "Retirée par le salarié depuis « Mes missions »." } });
    if (pris.count === 0) return { ok: false, error: "L'ordre de mission vient d'être traité — rechargez la page." };
    if (req.managerGate === "PENDING" && req.managerUserId) {
      await notifyUser({ userId: req.managerUserId, type: "GENERIC", title: "Ordre de mission retiré", body: `${user.name} a retiré sa demande : plus rien à valider.`, link: MES_MISSIONS }).catch(sansBloquer("mission-actions.retirerDemandeOrdreMission.notifyUser"));
    }
  } else {
    const refus = refusRetraitOrdreMission(a.orderStatus);
    if (refus) return { ok: false, error: refus };
  }
  await prisma.missionAssignment.updateMany({ where: { id: a.id, orderStatus: "REQUESTED" }, data: { orderStatus: "NONE", requestedAt: null } });
  const parent = await parentMission(a.entityType, a.entityId);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id,
    field: "orderStatus", oldValue: "REQUESTED", newValue: "NONE",
    summary: `Demande d'ordre de mission retirée — ${parent.label}`,
  });
  revalider(a.entityType, a.entityId);
  revalidatePath("/rh/demandes");
  return { ok: true, message: "Demande d'ordre de mission retirée." };
}

/**
 * LA MARCHE DU N+1 — valider (l'ordre part aux RH) ou refuser (motif ; la personne est prévenue).
 * Le N+1 enregistré, ou toute personne au-dessus dans la chaîne ACTUELLE (mutation, départ).
 */
export async function deciderOrdreMissionN1(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "requestId");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    select: { id: true, type: true, status: true, managerGate: true, managerUserId: true, employeeId: true, missionAssignmentId: true, details: true, employee: { select: { fullName: true, userId: true } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  let estN1 = req.managerUserId === user.id;
  if (!estN1) {
    const chaine = await getManagementChain(req.employeeId).catch(sansBloquer("mission-actions.deciderOrdreMissionN1.getManagementChain", []));
    estN1 = chaine.some((m) => m.userId === user.id) && req.employee.userId !== user.id;
  }
  const decision = fdStr(formData, "decision") === "REFUSER" ? "REFUSER" : "VALIDER";
  const motif = fdStr(formData, "motif");
  // LA NOTE DE FRAIS D'UNE MISSION DE L'ÉQUIPE suit la même marche (Direction, 10/2026) : N+1, puis RH.
  const noteFrais = req.type === "EXPENSE_REPORT";
  const refus = noteFrais
    ? refusDecisionN1NoteFrais({ type: req.type, status: req.status, managerGate: req.managerGate ?? null, missionAssignmentId: req.missionAssignmentId }, estN1, decision, motif)
    : refusDecisionN1({ type: req.type, status: req.status as HrStatut, managerGate: (req.managerGate ?? null) as GateN1 | null }, estN1, decision, motif);
  if (refus) return { ok: false, error: refus };
  const quoi = noteFrais ? "Note de frais de mission" : "Ordre de mission";

  const pris = await prisma.hrDocumentRequest.updateMany({
    where: { id, managerGate: "PENDING", status: "PENDING" },
    data: decision === "VALIDER"
      ? { managerGate: "APPROVED", managerDecidedAt: new Date(), managerNote: motif }
      : { managerGate: "REJECTED", managerDecidedAt: new Date(), managerNote: motif, status: "REJECTED" },
  });
  if (pris.count === 0) return { ok: false, error: `${quoi} vient d'être traité(e) — rechargez la page.` };
  if (decision === "REFUSER" && req.missionAssignmentId) {
    if (noteFrais) {
      // Refusée : la mission se rouvre — la personne corrige ses dépenses et clôture de nouveau.
      await prisma.missionAssignment.updateMany({ where: { id: req.missionAssignmentId, noteFraisRequestId: id }, data: { clotureLe: null, clotureParId: null } });
    } else {
      await prisma.missionAssignment.updateMany({ where: { id: req.missionAssignmentId, orderStatus: "REQUESTED" }, data: { orderStatus: "NONE" } });
    }
  }
  if (req.employee.userId) {
    await notifyUser({
      userId: req.employee.userId, type: "GENERIC",
      title: `${quoi} ${decision === "VALIDER" ? "validé(e)" : "refusé(e)"} par votre N+1`,
      body: decision === "VALIDER" ? "Elle part aux RH." : noteFrais ? `Motif : ${motif} — corrigez vos dépenses et clôturez de nouveau.` : `Motif : ${motif}`,
      link: req.missionAssignmentId ? lienMission(req.missionAssignmentId, noteFrais ? "frais" : undefined) : MES_MISSIONS,
    }).catch(sansBloquer("mission-actions.deciderOrdreMissionN1.notifyUser"));
  }
  if (decision === "VALIDER") {
    await notifyRoles(rolesWithModule("HR_REQUESTS", "UPDATE"), {
      type: "GENERIC", title: noteFrais ? "Note de frais de mission à traiter" : "Ordre de mission à établir",
      body: `${req.employee.fullName} — validé par le N+1`, link: `/rh/demandes?demande=${id}`,
    }).catch(sansBloquer("mission-actions.deciderOrdreMissionN1.notifyRoles"));
  }
  await recordAudit({
    actorId: user.id, action: decision === "VALIDER" ? "VALIDATE" : "REFUSE", module: "RH", entityType: "EMPLOYEE", entityId: req.employeeId,
    summary: `${quoi} ${decision === "VALIDER" ? "validé(e)" : "refusé(e)"} par le N+1 — ${req.employee.fullName}${motif ? ` (${motif})` : ""}`,
  });
  revalidatePath(MES_MISSIONS);
  revalidatePath(`${MES_MISSIONS}/[id]`, "page");
  revalidatePath("/mon-equipe");
  revalidatePath("/rh/demandes");
  return { ok: true, message: decision === "VALIDER" ? "Validé : la demande part aux RH." : "Refusé : la personne est prévenue." };
}

/**
 * Le responsable émet l'ordre de mission À L'ANCIENNE (simple marqueur) — gardé pour l'assistant et les
 * missions d'avant le circuit RH ; l'écran ne le propose plus (l'ordre se produit chez les RH).
 */
export async function issueMissionOrder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Assignation introuvable." };
  if (!(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };

  await prisma.missionAssignment.update({ where: { id: a.id }, data: { orderStatus: "ISSUED", issuedAt: new Date(), issuedById: user.id } });
  const parent = await parentMission(a.entityType, a.entityId);
  if (a.userId !== user.id) {
    await notifyUser({ userId: a.userId, type: "ASSIGNMENT", title: "Ordre de mission émis", body: parent.label, link: MES_MISSIONS });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Ordre de mission émis — ${parent.label}` });
  revalider(a.entityType, a.entityId);
  return { ok: true };
}

// ─────────────────────────────── Les étapes facultatives, dans leurs circuits ───────────────────────────────

/** Une mission confirmée, la sienne, active — la porte de toutes les étapes. */
async function maMissionConfirmee(id: string | null, userId: string) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  if (a.userId !== userId) return { erreur: "Seule la personne en mission fait ses demandes." } as const;
  if (a.response !== "CONFIRMEE") return { erreur: "Confirmez d'abord la mission." } as const;
  return { a } as const;
}

/**
 * TRANSPORT / HÉBERGEMENT — une demande « Déplacement / Hôtel / Billet » au Bureau du secrétariat, la
 * personne concernée étant celle en mission, reliée à l'assignation (pré-remplie : ville, dates).
 */
export async function demanderLogistiqueMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const m = await maMissionConfirmee(fdStr(formData, "id"), user.id);
  if ("erreur" in m) return { ok: false, error: m.erreur };
  const a = m.a;
  const etape = fdStr(formData, "etape") === "HEBERGEMENT" ? "HEBERGEMENT" : "TRANSPORT";
  const deja = await prisma.administrativeRequest.findFirst({
    where: { linkedEntityType: "MISSION_ASSIGNMENT", linkedEntityId: a.id, subtype: SOUS_TYPE_SECRETARIAT[etape], deletedAt: null },
    orderBy: { createdAt: "desc" }, select: { status: true },
  });
  if (deja && !demandeRelancable(deja.status)) return { ok: false, error: `Une demande de ${LIBELLE_ETAPE[etape].toLowerCase()} est déjà en cours.` };

  const parent = await parentMission(a.entityType, a.entityId);
  const ville = fdStr(formData, "ville") ?? a.ville ?? parent.ville;
  const fd = new FormData();
  fd.set("type", "TRAVEL");
  fd.set("title", `${LIBELLE_ETAPE[etape]} — ${parent.label}${ville ? ` (${ville})` : ""}`);
  fd.set("description", [fdStr(formData, "details"), `Mission Ad & Pro : ${parent.label}.`].filter(Boolean).join("\n"));
  fd.set("concernedUserId", user.id);
  const depart = fdStr(formData, "dateDepart") ?? jourIso(a.dateDepart ?? parent.debut);
  const retour = fdStr(formData, "dateRetour") ?? jourIso(a.dateRetour ?? parent.fin);
  if (depart) { fd.set("f_dateDepart", depart); fd.set("deadline", depart); }
  if (retour) fd.set("f_dateRetour", retour);
  if (etape === "TRANSPORT") {
    fd.set("f_billet", "oui"); fd.set("f_hotel", "non");
    const villeDepart = fdStr(formData, "villeDepart");
    if (villeDepart) fd.set("f_villeDepart", villeDepart);
    if (ville) fd.set("f_villeArrivee", ville);
  } else {
    fd.set("f_billet", "non"); fd.set("f_hotel", "oui");
    if (ville) fd.set("f_villeArrivee", ville);
    const nuits = fdNum(formData, "nbNuits");
    if (nuits != null) fd.set("f_nbNuits", String(nuits));
    const pref = fdStr(formData, "hotelPref");
    if (pref) fd.set("f_hotelPref", pref);
  }
  const r = await createRequest(undefined, fd);
  if (!r.ok || !r.id) return r;
  await prisma.administrativeRequest.update({
    where: { id: r.id },
    data: { linkedEntityType: "MISSION_ASSIGNMENT", linkedEntityId: a.id, subtype: SOUS_TYPE_SECRETARIAT[etape] },
  });
  if (!a.etapes.includes(etape)) await prisma.missionAssignment.update({ where: { id: a.id }, data: { etapes: { push: etape } } });
  revalider(a.entityType, a.entityId);
  return { ok: true, id: r.id, message: `${LIBELLE_ETAPE[etape]} demandé au secrétariat.` };
}

/** MATÉRIEL PROMOTIONNEL — une demande au magasin (la même que « Demander » du stock), reliée à la mission. */
export async function demanderMaterielMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const m = await maMissionConfirmee(fdStr(formData, "id"), user.id);
  if ("erreur" in m) return { ok: false, error: m.erreur };
  const a = m.a;
  const parent = await parentMission(a.entityType, a.entityId);
  const fd = new FormData();
  fd.set("itemId", fdStr(formData, "itemId") ?? "");
  fd.set("quantite", fdStr(formData, "quantite") ?? "");
  fd.set("note", [fdStr(formData, "note"), `Mission : ${parent.label}`].filter(Boolean).join(" — "));
  const r = await demanderMateriel(fd);
  if (!r.ok || !r.id) return r;
  await prisma.promoStockRequest.update({ where: { id: r.id }, data: { missionAssignmentId: a.id } });
  if (!a.etapes.includes("MATERIEL")) await prisma.missionAssignment.update({ where: { id: a.id }, data: { etapes: { push: "MATERIEL" } } });
  revalider(a.entityType, a.entityId);
  return { ok: true, id: r.id, message: "Demande envoyée au magasin." };
}

/** NOTE DE FRAIS — la demande RH habituelle (mois, montant, justificatif), reliée à la mission, après le retour. */
export async function deposerNoteFraisMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const m = await maMissionConfirmee(fdStr(formData, "id"), user.id);
  if ("erreur" in m) return { ok: false, error: m.erreur };
  const a = m.a;
  const parent = await parentMission(a.entityType, a.entityId);
  if (!noteFraisOuverte(a.dateRetour ?? parent.fin, a.dateDepart ?? parent.debut)) {
    return { ok: false, error: "La note de frais se dépose après la mission (à partir du jour du retour)." };
  }
  const fd = new FormData();
  fd.set("type", "EXPENSE_REPORT");
  fd.set("expenseMonth", fdStr(formData, "expenseMonth") ?? "");
  fd.set("expenseAmount", fdStr(formData, "expenseAmount") ?? "");
  fd.set("details", [fdStr(formData, "details"), `Mission : ${parent.label}`].filter(Boolean).join(" — "));
  for (const f of formData.getAll("files")) if (f instanceof File && f.size > 0) fd.append("files", f);
  const r = await requestHrDocument(fd);
  if (!r.ok || !r.id) return r;
  await prisma.hrDocumentRequest.update({ where: { id: r.id }, data: { missionAssignmentId: a.id } });
  // La note de frais compte au budget Operations & Sales par l'imputation du membre (posée par défaut si elle manque).
  await assurerImputationEquipe(a.id, user.id, parent.debut);
  if (!a.etapes.includes("NOTE_FRAIS")) await prisma.missionAssignment.update({ where: { id: a.id }, data: { etapes: { push: "NOTE_FRAIS" } } });
  revalider(a.entityType, a.entityId);
  return { ok: true, id: r.id, message: "Note de frais déposée aux RH." };
}

// ─────────────────────────────── La clôture : frais de l'équipe au budget ───────────────────────────────

/**
 * « Frais de l'équipe Adventum » — à la clôture, l'organisateur reporte À LA MAIN le montant exact du transport ou de
 * l'hébergement d'un membre et l'intègre au BUDGET OPERATIONS & SALES (Direction, 10/2026 : « ici le budget à imputer,
 * ce n'est pas Ad & Pro, c'est Operations & Sales ») : une ligne de dépense dans la catégorie choisie (à défaut
 * l'imputation du membre, à défaut « Frais de déplacement terrain » de l'enveloppe de l'année, ouverte d'office). Plus
 * de poste Ad & Pro : ceux créés avant restent où ils sont. Rien d'automatique : sans ce geste, rien n'est imputé.
 */
export async function integrerFraisEquipe(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Mission introuvable." };
  if (!(await canAccessEntity(user, a.entityType, a.entityId, "UPDATE"))) return { ok: false, error: "Action non autorisée." };
  const etape = fdStr(formData, "etape") === "HEBERGEMENT" ? "HEBERGEMENT" : "TRANSPORT";
  const deja = etape === "TRANSPORT" ? a.transportPosteId : a.hebergementPosteId;
  if (deja) {
    // Une ligne (ou un ancien poste Ad & Pro) supprimée depuis le budget ne bloque plus : les frais se réintègrent.
    const [ligne, poste] = await Promise.all([
      prisma.budgetExpenseLine.findUnique({ where: { id: deja }, select: { id: true } }),
      prisma.adProItem.findUnique({ where: { id: deja }, select: { id: true } }),
    ]);
    if (ligne || poste) return { ok: false, error: "Ces frais sont déjà intégrés au budget." };
  }
  const montant = fdNum(formData, "montant");
  const refus = refusMontantFrais(montant);
  if (refus || montant == null) return { ok: false, error: refus ?? "Montant invalide." };

  const parent = await parentMission(a.entityType, a.entityId);
  const cible = await categorieEquipePour(a, user.id, parent.debut, fdStr(formData, "budgetCategoryId"));
  if (!cible.ok) return { ok: false, error: cible.error };
  const personne = await prisma.user.findUnique({ where: { id: a.userId }, select: { name: true } });
  const demande = await prisma.administrativeRequest.findFirst({
    where: { linkedEntityType: "MISSION_ASSIGNMENT", linkedEntityId: a.id, subtype: SOUS_TYPE_SECRETARIAT[etape], deletedAt: null },
    orderBy: { createdAt: "desc" }, select: { reference: true },
  });
  // La dépense se date par la mission (retour, sinon départ) : elle tombe dans l'année de l'enveloppe qui la porte.
  const date = a.dateRetour ?? a.dateDepart ?? parent.fin ?? parent.debut ?? new Date();
  const ligne = await prisma.budgetExpenseLine.create({
    data: {
      categoryId: cible.id,
      reference: `${LIBELLE_ETAPE[etape]} — ${personne?.name ?? "membre"} (équipe Adventum) — ${parent.label}`.slice(0, 250),
      amount: montant,
      date,
      notes: `Frais de l'équipe Adventum, montant exact saisi à la clôture${demande ? ` — demande ${demande.reference}` : ""}. Mission : ${lienMission(a.id)}`,
      createdById: user.id,
    },
    select: { id: true },
  });
  await prisma.missionAssignment.update({ where: { id: a.id }, data: etape === "TRANSPORT" ? { transportPosteId: ligne.id } : { hebergementPosteId: ligne.id } });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Frais de l'équipe intégrés au budget ${cible.libelle} — ${LIBELLE_ETAPE[etape]} ${personne?.name ?? ""} : ${montant} DZD` });
  revalider(a.entityType, a.entityId);
  revalidatePath("/budget-operations");
  revalidatePath("/budget-operations/depenses");
  return { ok: true, id: ligne.id, message: `Intégré au budget ${cible.libelle}.` };
}

/** Discussion sur l'assignation : la personne assignée et les responsables peuvent échanger. */
export async function addMissionComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "assignmentId");
  const body = fdStr(formData, "body");
  if (!id || !body) return { ok: false, error: "Commentaire vide." };
  if (!(await canAccessEntity(user, "MISSION_ASSIGNMENT", id, "VIEW"))) return { ok: false, error: "Action non autorisée." };

  await prisma.comment.create({ data: { entityType: "MISSION_ASSIGNMENT", entityId: id, body, authorId: user.id } });
  const a = await prisma.missionAssignment.findUnique({ where: { id }, select: { entityType: true, entityId: true, userId: true, createdById: true } });
  if (a) {
    // LE FIL RESTE OUVERT DE L'INVITATION À LA CLÔTURE : l'autre partie est prévenue, sur la mission même.
    const parent = await parentMission(a.entityType, a.entityId);
    const destinataires = new Set([a.userId, ...organisateursDe(a, parent)]);
    destinataires.delete(user.id);
    for (const d of destinataires) {
      await notifyUser({ userId: d, type: "GENERIC", title: `Commentaire — ${parent.label}`, body: `${user.name} : ${body.slice(0, 120)}`, link: lienMission(id, "fil") }).catch(sansBloquer("mission-actions.addMissionComment.notifyUser"));
    }
    revalider(a.entityType, a.entityId);
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LA DEMANDE DE PARTICIPATION, LA MISSION ET SA CLÔTURE (Direction, 10/2026) — règles dans
// `missions-equipe/participation.ts`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

type Assignation = NonNullable<Awaited<ReturnType<typeof chargerAssignation>>>;

/** Les versions de l'invitation EN COURS (une réinvitation repart à zéro), de la plus ancienne à la plus récente. */
async function versionsCourantes(a: { id: string; createdAt: Date }) {
  return prisma.missionParticipationVersion.findMany({
    where: { assignmentId: a.id, createdAt: { gte: a.createdAt } },
    orderBy: { numero: "asc" },
  });
}

/** Le contexte d'une participation pour l'acteur : demande parente, organisateurs, son côté, l'état. */
async function contexteParticipation(a: Assignation, user: { id: string; role: string; secondaryRole?: string | null }) {
  const parent = await parentMission(a.entityType, a.entityId);
  const organisateurs = organisateursDe(a, parent);
  const roles = rolesDe(user);
  const arbitre = estArbitre({ id: user.id, roles }, organisateurs);
  const cote = coteDe(user.id, a.userId, arbitre);
  const versions = await versionsCourantes(a);
  const derniere = versions.length ? versions[versions.length - 1]! : null;
  const etape = etapeParticipation(a, derniere ? versionLite(derniere) : null);
  return { parent, organisateurs, roles, arbitre, cote, versions, derniere, etape };
}

/** Prévenir l'autre côté : la personne, ou les organisateurs (hors soi). */
async function prevenirAutreCote(a: Assignation, cote: Cote, acteurId: string, organisateurs: string[], titre: string, corps: string, ancre?: "fil") {
  const cibles = cote === "PERSONNE" ? organisateurs : [a.userId];
  for (const c of new Set(cibles)) {
    if (c === acteurId) continue;
    await notifyUser({ userId: c, type: "ASSIGNMENT", title: titre, body: corps, link: lienMission(a.id, ancre) }).catch(sansBloquer("mission-actions.prevenirAutreCote.notifyUser"));
  }
}

/**
 * ENVOYER SA FICHE / « MODIFIER ET CONTRE-PROPOSER » — une nouvelle VERSION de la fiche. La personne ouvre ;
 * ensuite seul le côté qui a la balle propose. La version en attente qu'elle remplace est marquée REMPLACÉE ;
 * après un accord (ordre de mission pas encore demandé), proposer rouvre la discussion.
 */
export async function proposerParticipation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Participation introuvable." };
  const ctx = await contexteParticipation(a, user);
  const om = await dernierOrdre(a.id);
  const etatOm = etatOrdreMission(om ? { status: om.status as HrStatut, managerGate: (om.managerGate ?? null) as GateN1 | null } : null, a.orderStatus);
  // Après l'accord, la discussion se rouvre tant que l'ordre de mission n'est ni en cours ni émis.
  const refus = refusProposition(ctx.etape, ctx.cote, peutDemanderOrdre(etatOm));
  if (refus) return { ok: false, error: refus };
  // Champ par champ, nommés en clair : le contrat des actions (Adam, §118) les lit dans la source.
  const lu = lireFiche({
    presenceDu: fdStr(formData, "presenceDu"), presenceAu: fdStr(formData, "presenceAu"),
    transportMode: fdStr(formData, "transportMode"), transportDepart: fdStr(formData, "transportDepart"),
    transportArrivee: fdStr(formData, "transportArrivee"), transportAller: fdStr(formData, "transportAller"),
    transportRetour: fdStr(formData, "transportRetour"), transportReservation: fdStr(formData, "transportReservation"),
    transportPrecisions: fdStr(formData, "transportPrecisions"), hebergementChoix: fdStr(formData, "hebergementChoix"),
    hebergementHotel: fdStr(formData, "hebergementHotel"), hebergementNuits: fdStr(formData, "hebergementNuits"),
    hebergementEstimation: fdStr(formData, "hebergementEstimation"), commentaire: fdStr(formData, "commentaire"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const motif = fdStr(formData, "motif");
  const cote = ctx.cote!;
  const numero = (await prisma.missionParticipationVersion.count({ where: { assignmentId: a.id } })) + 1;
  const nature = natureNouvelleVersion(ctx.versions.length);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.missionParticipationVersion.updateMany({ where: { assignmentId: a.id, statut: "EN_ATTENTE" }, data: { statut: "REMPLACEE", decideParId: user.id, decideLe: new Date() } });
      await tx.missionParticipationVersion.create({
        data: { assignmentId: a.id, numero, auteurId: user.id, cote, nature, contenu: lu.fiche as unknown as Prisma.InputJsonObject, motif },
      });
      if (ctx.etape === "ACCORD") {
        await tx.missionAssignment.update({ where: { id: a.id }, data: { accordVersionId: null, accordAt: null, response: "INVITEE" } });
      }
    });
  } catch {
    return { ok: false, error: "La participation vient de changer — rechargez la page." };
  }
  const qui = cote === "PERSONNE" ? user.name : `${user.name} (Adventum)`;
  await prevenirAutreCote(a, cote, user.id, ctx.organisateurs,
    nature === "PROPOSITION" ? "Fiche de participation reçue" : "Contre-proposition reçue",
    `${ctx.parent.label} — ${qui}${motif ? ` : « ${motif} »` : ""}. À vous de répondre.`);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Participation — version ${numero} (${nature === "PROPOSITION" ? "proposition" : "contre-proposition"}) par ${qui}` });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: nature === "PROPOSITION" ? "Fiche envoyée à l'organisateur." : "Contre-proposition envoyée." };
}

/** ACCEPTER / REFUSER la dernière version — le côté qui a la balle. L'accord ouvre l'ordre de mission. */
export async function deciderParticipation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a) return { ok: false, error: "Participation introuvable." };
  const ctx = await contexteParticipation(a, user);
  const decision = fdStr(formData, "decision") === "REFUSER" ? "REFUSER" : "ACCEPTER";
  const motif = fdStr(formData, "motif");
  const refus = refusDecision(ctx.etape, ctx.derniere ? versionLite(ctx.derniere) : null, ctx.cote, decision, motif);
  if (refus) return { ok: false, error: refus };
  const v = ctx.derniere!;
  const pris = await prisma.missionParticipationVersion.updateMany({
    where: { id: v.id, statut: "EN_ATTENTE" },
    data: { statut: decision === "ACCEPTER" ? "ACCEPTEE" : "REFUSEE", decideParId: user.id, decideLe: new Date(), motifDecision: motif },
  });
  if (pris.count === 0) return { ok: false, error: "La participation vient de changer — rechargez la page." };
  if (decision === "ACCEPTER") {
    const fiche = ficheStockee(v.contenu);
    const d = fiche ? datesConvenues(fiche) : null;
    await prisma.missionAssignment.update({
      where: { id: a.id },
      data: {
        accordVersionId: v.id, accordAt: new Date(), response: "CONFIRMEE", respondedAt: new Date(), declineReason: null,
        ...(d?.depart ? { dateDepart: new Date(`${d.depart}T00:00:00.000Z`) } : {}),
        ...(d?.retour ? { dateRetour: new Date(`${d.retour}T00:00:00.000Z`) } : {}),
        ...(fiche?.transport.arrivee ? { ville: fiche.transport.arrivee } : {}),
      },
    });
  }
  await prevenirAutreCote(a, ctx.cote!, user.id, ctx.organisateurs,
    decision === "ACCEPTER" ? "Accord trouvé — participation" : "Proposition refusée",
    decision === "ACCEPTER"
      ? `${ctx.parent.label} — version ${v.numero} acceptée par ${user.name}. L'ordre de mission peut être demandé.`
      : `${ctx.parent.label} — ${user.name} : « ${motif} ». Modifiez et reproposez.`);
  await recordAudit({
    actorId: user.id, action: decision === "ACCEPTER" ? "VALIDATE" : "REFUSE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id,
    summary: `Participation — version ${v.numero} ${decision === "ACCEPTER" ? "acceptée (accord)" : `refusée (${motif})`} par ${user.name}`,
  });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: decision === "ACCEPTER" ? "Accord trouvé : l'ordre de mission peut être demandé." : "Refus envoyé : l'autre partie peut reproposer." };
}

/** La porte des dépôts de la plateforme (billet, hôtel) : assistante de direction, organisateurs, Direction Marketing, Super Admin. */
async function porteReservation(id: string | null, user: { id: string; role: string; secondaryRole?: string | null }) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  const parent = await parentMission(a.entityType, a.entityId);
  if (!peutDeposerReservation({ id: user.id, roles: rolesDe(user) }, organisateursDe(a, parent))) {
    return { erreur: "Le billet émis et la confirmation d'hôtel se déposent par l'assistante de direction, l'organisateur, la Direction Marketing ou le Super Admin." } as const;
  }
  return { a, parent } as const;
}

async function deposerPiece(userId: string, assignmentId: string, f: FormDataEntryValue | null, stepKey: "BILLET" | "HOTEL" | "FRAIS"): Promise<{ ok: true; id: string | undefined } | { ok: false; error: string }> {
  if (!(f instanceof File) || f.size === 0) return { ok: true, id: undefined };
  const r = await persistUploadedDocument(userId, { entityType: "MISSION_ASSIGNMENT", entityId: assignmentId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey, file: f });
  if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le fichier n'a pas pu être enregistré." };
  return { ok: true, id: r.documentId };
}

/**
 * LE BILLET ÉMIS d'un membre de l'équipe (Adventum réserve) — l'e-billet, le PNR et, pour l'aller puis le retour,
 * le n° de vol / train et les heures : la même structure que le billet émis d'une fiche voyageur.
 */
export async function enregistrerBilletMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const p = await porteReservation(fdStr(formData, "id"), user);
  if ("erreur" in p) return { ok: false, error: p.erreur };
  const { a, parent } = p;
  let billetTrajets: Prisma.InputJsonValue | undefined;
  if (formData.has("legDetails")) {
    const lus = lireDetailsTrajets(fdStr(formData, "legDetails") ?? "", TRAJETS_BILLET.length);
    if (!lus.ok) return { ok: false, error: lus.error };
    billetTrajets = lus.details as unknown as Prisma.InputJsonValue;
  }
  const billetReference = formData.has("billetReference") ? (fdStr(formData, "billetReference")?.slice(0, 60) ?? null) : undefined;
  const piece = await deposerPiece(user.id, a.id, formData.get("file"), "BILLET");
  if (!piece.ok) return { ok: false, error: piece.error };
  if (billetTrajets === undefined && billetReference === undefined && !piece.id) return { ok: false, error: "Rien à enregistrer." };
  await prisma.missionAssignment.update({
    where: { id: a.id },
    data: {
      ...(billetTrajets !== undefined ? { billetTrajets } : {}),
      ...(billetReference !== undefined ? { billetReference } : {}),
      ...(piece.id ? { billetDocumentId: piece.id } : {}),
      billetDeposeParId: user.id, billetDeposeLe: new Date(),
    },
  });
  if (a.userId !== user.id && piece.id) {
    await notifyUser({ userId: a.userId, type: "ASSIGNMENT", title: "Votre billet est émis", body: parent.label, link: lienMission(a.id, "reservation") }).catch(sansBloquer("mission-actions.enregistrerBilletMission.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Billet émis ${piece.id ? "déposé" : "mis à jour"}${billetReference ? ` (PNR ${billetReference})` : ""} — ${parent.label}` });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Billet émis enregistré." };
}

/** LA CONFIRMATION D'HÔTEL d'un membre de l'équipe — le voucher, le nom de l'hôtel, le n° de confirmation. */
export async function enregistrerHotelMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const p = await porteReservation(fdStr(formData, "id"), user);
  if ("erreur" in p) return { ok: false, error: p.erreur };
  const { a, parent } = p;
  const hotelNom = formData.has("hotelNom") ? (fdStr(formData, "hotelNom")?.slice(0, 120) ?? null) : undefined;
  const hotelConfirmation = formData.has("hotelConfirmation") ? (fdStr(formData, "hotelConfirmation")?.slice(0, 60) ?? null) : undefined;
  const piece = await deposerPiece(user.id, a.id, formData.get("file"), "HOTEL");
  if (!piece.ok) return { ok: false, error: piece.error };
  if (hotelNom === undefined && hotelConfirmation === undefined && !piece.id) return { ok: false, error: "Rien à enregistrer." };
  await prisma.missionAssignment.update({
    where: { id: a.id },
    data: {
      ...(hotelNom !== undefined ? { hotelNom } : {}),
      ...(hotelConfirmation !== undefined ? { hotelConfirmation } : {}),
      ...(piece.id ? { hotelDocumentId: piece.id } : {}),
      hotelDeposeParId: user.id, hotelDeposeLe: new Date(),
    },
  });
  if (a.userId !== user.id && (piece.id || hotelConfirmation)) {
    await notifyUser({ userId: a.userId, type: "ASSIGNMENT", title: "Votre hôtel est confirmé", body: `${parent.label}${hotelNom ? ` — ${hotelNom}` : ""}`, link: lienMission(a.id, "reservation") }).catch(sansBloquer("mission-actions.enregistrerHotelMission.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Confirmation d'hôtel ${piece.id ? "déposée" : "mise à jour"}${hotelConfirmation ? ` (n° ${hotelConfirmation})` : ""} — ${parent.label}` });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Confirmation d'hôtel enregistrée." };
}

/**
 * L'IMPUTATION des frais de mission d'un membre — au budget OPERATIONS & SALES (Direction, 10/2026), dans la catégorie
 * choisie par la Direction Marketing ou la Direction des opérations. Une catégorie Ad & Pro (ou la masse salariale) est
 * refusée ; « par défaut » remet la catégorie par défaut de l'enveloppe de l'année.
 */
export async function choisirBudgetMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Mission introuvable." };
  if (!peutChoisirBudgetMission(rolesDe(user))) return { ok: false, error: "L'imputation des frais de mission se choisit par la Direction Marketing ou la Direction des opérations." };
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  let libelle: string;
  if (budgetCategoryId) {
    const v = await categorieEquipeValide(budgetCategoryId);
    if (!v.ok) return { ok: false, error: v.error };
    libelle = v.libelle;
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { budgetCategoryId, budgetChoisiParId: user.id, budgetChoisiLe: new Date() } });
  } else {
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { budgetCategoryId: null, budgetChoisiParId: null, budgetChoisiLe: null } });
    const parent = await parentMission(a.entityType, a.entityId);
    const defaut = await assurerImputationEquipe(a.id, user.id, parent.debut);
    const v = defaut ? await categorieEquipeValide(defaut) : null;
    libelle = v?.ok ? `${v.libelle} (par défaut)` : "à poser";
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, field: "budgetCategoryId", newValue: budgetCategoryId ?? "", summary: `Imputation des frais de mission : ${libelle}` });
  revalider(a.entityType, a.entityId);
  revalidatePath("/budget-operations");
  return { ok: true, message: `Imputé à ${libelle}.` };
}

/** La porte des dépenses : la personne, sa mission ouverte (OM émis), pas encore clôturée. */
async function porteFrais(id: string | null, userId: string) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  const om = await dernierOrdre(a.id);
  const etatOm = etatOrdreMission(om ? { status: om.status as HrStatut, managerGate: (om.managerGate ?? null) as GateN1 | null } : null, a.orderStatus);
  const refus = refusModifFrais({ cloturee: Boolean(a.clotureLe), omEmis: etatOm === "EMIS" }, a.userId === userId);
  if (refus) return { erreur: refus } as const;
  return { a, etatOm } as const;
}

/** AJOUTER UNE DÉPENSE — date, nature, détail, montant (USD à l'international hors billet), justificatif. */
export async function ajouterFraisMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const p = await porteFrais(fdStr(formData, "id"), user.id);
  if ("erreur" in p) return { ok: false, error: p.erreur };
  const { a } = p;
  const parent = await parentMission(a.entityType, a.entityId);
  const taux = tauxMission(parent.international, parent.taux);
  const lu = lireLigneFrais({ date: fdStr(formData, "date"), nature: fdStr(formData, "nature"), detail: fdStr(formData, "detail"), montant: fdStr(formData, "montant") }, parent.international, taux);
  if (!lu.ok) return { ok: false, error: lu.error };
  const piece = await deposerPiece(user.id, a.id, formData.get("file"), "FRAIS");
  if (!piece.ok) return { ok: false, error: piece.error };
  const l = lu.ligne;
  const cree = await prisma.missionExpenseLine.create({
    data: {
      assignmentId: a.id, date: new Date(`${l.date}T00:00:00.000Z`), nature: l.nature, detail: l.detail,
      amount: l.montant, currency: l.devise, amountDzd: l.montantDzd, documentId: piece.id ?? null, createdById: user.id,
    },
    select: { id: true },
  });
  revalider(a.entityType, a.entityId);
  return { ok: true, id: cree.id, message: "Dépense ajoutée." };
}

/** JOINDRE (ou remplacer) LE JUSTIFICATIF d'une dépense. */
export async function joindreJustificatifFrais(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ligne = await prisma.missionExpenseLine.findUnique({ where: { id: fdStr(formData, "ligneId") ?? "" }, select: { id: true, assignmentId: true } });
  if (!ligne) return { ok: false, error: "Dépense introuvable." };
  const p = await porteFrais(ligne.assignmentId, user.id);
  if ("erreur" in p) return { ok: false, error: p.erreur };
  const piece = await deposerPiece(user.id, ligne.assignmentId, formData.get("file"), "FRAIS");
  if (!piece.ok) return { ok: false, error: piece.error };
  if (!piece.id) return { ok: false, error: "Choisissez le justificatif." };
  await prisma.missionExpenseLine.update({ where: { id: ligne.id }, data: { documentId: piece.id } });
  revalider(p.a.entityType, p.a.entityId);
  return { ok: true, message: "Justificatif joint." };
}

/** RETIRER UNE DÉPENSE saisie par erreur — avant la clôture ; son justificatif reste dans les pièces de la mission. */
export async function retirerFraisMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ligne = await prisma.missionExpenseLine.findUnique({ where: { id: fdStr(formData, "ligneId") ?? "" }, select: { id: true, assignmentId: true, nature: true, amount: true, currency: true } });
  if (!ligne) return { ok: false, error: "Dépense introuvable." };
  const p = await porteFrais(ligne.assignmentId, user.id);
  if ("erreur" in p) return { ok: false, error: p.erreur };
  await prisma.missionExpenseLine.delete({ where: { id: ligne.id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: ligne.assignmentId, summary: `Dépense retirée — ${NATURE_FRAIS_LIBELLE[ligne.nature as NatureFrais] ?? ligne.nature} ${toNumber(ligne.amount)} ${ligne.currency}` });
  revalider(p.a.entityType, p.a.entityId);
  return { ok: true, message: "Dépense retirée." };
}

/** LE RAPPORT DE MISSION — déroulé, médecins rencontrés, retombées, suites à donner. */
export async function enregistrerRapportMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Mission introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne en mission rédige son rapport." };
  if (a.clotureLe) return { ok: false, error: "La mission est clôturée : le rapport est parti." };
  const court = (v: string | null) => v?.slice(0, 5000) ?? null;
  await prisma.missionAssignment.update({
    where: { id: a.id },
    data: {
      rapportDeroule: court(fdStr(formData, "deroule")), rapportMedecins: court(fdStr(formData, "medecins")),
      rapportRetombees: court(fdStr(formData, "retombees")), rapportSuites: court(fdStr(formData, "suites")), rapportLe: new Date(),
    },
  });
  revalider(a.entityType, a.entityId);
  return { ok: true, message: "Rapport enregistré." };
}

/**
 * CLÔTURER LA MISSION — les dépenses partent en UNE note de frais (demande RH `EXPENSE_REPORT`, montant DZD au taux
 * figé de la demande, justificatifs liés) qui monte au N+1 puis aux RH ; le rapport part à l'organisateur.
 */
export async function cloturerMission(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const a = await chargerAssignation(fdStr(formData, "id"));
  if (!a || a.archivedAt) return { ok: false, error: "Mission introuvable." };
  if (a.userId !== user.id) return { ok: false, error: "Seule la personne en mission la clôture." };
  const parent = await parentMission(a.entityType, a.entityId);
  const om = await dernierOrdre(a.id);
  const etatOm = etatOrdreMission(om ? { status: om.status as HrStatut, managerGate: (om.managerGate ?? null) as GateN1 | null } : null, a.orderStatus);
  const lignes = await prisma.missionExpenseLine.findMany({ where: { assignmentId: a.id }, orderBy: { date: "asc" } });
  const rapport = { deroule: a.rapportDeroule, medecins: a.rapportMedecins, retombees: a.rapportRetombees, suites: a.rapportSuites };
  const manques = manquesCloture({
    cloturee: Boolean(a.clotureLe), omEmis: etatOm === "EMIS", terminee: noteFraisOuverte(a.dateRetour ?? parent.fin, a.dateDepart ?? parent.debut),
    rapport, lignes: lignes.map((l) => ({ justificatif: Boolean(l.documentId) })),
  });
  if (manques.length) return { ok: false, error: manques.join(" ") };

  let noteFraisRequestId: string | null = null;
  let message = "Mission clôturée : le rapport est parti à l'organisateur.";
  if (lignes.length > 0) {
    const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true, fullName: true } });
    if (!employee) return { ok: false, error: "Aucun dossier RH n'est lié à votre compte : les RH ne peuvent pas traiter la note de frais. Contactez-les." };
    const taux = tauxMission(parent.international, parent.taux);
    const lues = lignes.map((l) => ({ montant: toNumber(l.amount), devise: l.currency === "USD" ? "USD" as const : "DZD" as const }));
    const total = totalFrais(lues, taux);
    if (total.totalDzd == null || total.totalDzd <= 0) return { ok: false, error: "Le total des dépenses n'a pas pu être converti en DZD." };
    // La note de frais compte au budget Operations & Sales par l'imputation du membre (posée par défaut si elle manque).
    const imputation = await assurerImputationEquipe(a.id, user.id, parent.debut);
    const budget = imputation ? await categorieEquipeValide(imputation) : null;
    const details = [
      `Mission — ${parent.label}${a.ville ? ` · ${a.ville}` : ""}${dates(a.dateDepart, a.dateRetour)}`,
      ...lignes.map((l) => `• ${jourIso(l.date)} — ${NATURE_FRAIS_LIBELLE[l.nature as NatureFrais] ?? l.nature}${l.detail ? ` (${l.detail})` : ""} : ${toNumber(l.amount).toLocaleString("fr-FR")} ${l.currency}${l.currency === "USD" && l.amountDzd != null ? ` = ${toNumber(l.amountDzd).toLocaleString("fr-FR")} DZD` : ""}${l.documentId ? ` — justificatif /api/documents/${l.documentId}` : ""}`),
      parent.international ? `Taux : 1 USD = ${taux} DZD (figé sur la demande).` : null,
      `Total : ${total.totalDzd.toLocaleString("fr-FR")} DZD${total.usd > 0 ? ` (dont ${total.usd.toLocaleString("fr-FR")} USD)` : ""}.`,
      budget?.ok ? `Imputation (budget Operations & Sales) : ${budget.libelle}.` : "Imputation : budget Operations & Sales, catégorie à choisir.",
      `Mission : ${lienMission(a.id, "frais")}`,
    ].filter(Boolean).join("\n");
    const manager = await getManagerOf(employee.id).catch(sansBloquer("mission-actions.cloturerMission.getManagerOf", null));
    const marche = marcheInitiale(manager?.userId ?? null, user.id);
    const retour = jourIso(a.dateRetour ?? parent.fin) || null;
    const cree = await prisma.hrDocumentRequest.create({
      data: {
        employeeId: employee.id, type: "EXPENSE_REPORT", status: "PENDING", details,
        expenseMonth: moisNoteFrais(retour, new Date().toISOString().slice(0, 10)), expenseAmount: total.totalDzd,
        missionAssignmentId: a.id, managerGate: marche.gate, managerUserId: marche.gate ? manager?.userId ?? null : null,
      },
      select: { id: true },
    });
    noteFraisRequestId = cree.id;
    if (marche.gate === "PENDING" && manager?.userId) {
      await notifyUser({ userId: manager.userId, type: "GENERIC", title: "Note de frais de mission à valider (votre équipe)", body: `${employee.fullName} — ${parent.label} : ${total.totalDzd.toLocaleString("fr-FR")} DZD`, link: LIEN_MISSIONS_A_VALIDER }).catch(sansBloquer("mission-actions.cloturerMission.notifyUser"));
      message = "Mission clôturée : la note de frais part à votre N+1 puis aux RH, le rapport à l'organisateur.";
    } else {
      await notifyRoles(rolesWithModule("HR_REQUESTS", "UPDATE"), { type: "GENERIC", title: "Note de frais de mission à traiter", body: `${employee.fullName} — ${parent.label}`, link: `/rh/demandes?demande=${cree.id}` }).catch(sansBloquer("mission-actions.cloturerMission.notifyRoles"));
      message = "Mission clôturée : la note de frais part aux RH (aucun N+1 rattaché), le rapport à l'organisateur.";
    }
  }
  const pris = await prisma.missionAssignment.updateMany({
    where: { id: a.id, clotureLe: null },
    data: { clotureLe: new Date(), clotureParId: user.id, ...(noteFraisRequestId ? { noteFraisRequestId } : {}) },
  });
  if (pris.count === 0) return { ok: false, error: "La mission vient d'être clôturée — rechargez la page." };
  for (const o of new Set(organisateursDe(a, parent))) {
    if (o === user.id) continue;
    await notifyUser({ userId: o, type: "GENERIC", title: `Rapport de mission — ${user.name}`, body: `${parent.label}${rapportRedige(rapport) ? ` : ${(rapport.deroule ?? "").slice(0, 100)}` : ""}`, link: lienMission(a.id, "rapport") }).catch(sansBloquer("mission-actions.cloturerMission.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Mission clôturée — ${parent.label}${noteFraisRequestId ? " (note de frais au circuit N+1 / RH)" : " (sans dépense)"}` });
  revalider(a.entityType, a.entityId);
  revalidatePath("/rh/demandes");
  revalidatePath("/mon-dossier");
  return { ok: true, message };
}
