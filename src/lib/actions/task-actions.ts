"use server";

import { revalidatePath } from "next/cache";
import type { Priority, TaskStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import {
  canRespond, canDoWork, canComment, declineSummary, peutRelancer, relanceTitre,
  ACCEPTED_STATUS, DECLINED_STATUS, refusAnnulationDemande, STATUTS_ANNULABLES,
  refusReattribution, STATUTS_REATTRIBUABLES,
} from "@/lib/tasks/request-flow";
import { createTaskRecord } from "@/lib/tasks/create-core";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { rejouerNotifications } from "@/lib/notifications/ecrire";
import { CHEMIN_TACHES, lienTache, vueTachePour } from "@/lib/chemins/espace";
import { sansBloquer } from "@/lib/journal";

/**
 * CRÉER UNE TÂCHE — et le destinataire décide de ce que ce geste veut dire.
 *
 * Une seule porte, là où il y en avait deux. « Nouvelle tâche » assignait sans rien demander,
 * « Demander une tâche » ouvrait le circuit : personne ne devinait laquelle prendre, et l'on
 * choisissait presque toujours la première. La tâche atterrissait chez l'autre sans qu'il l'ait
 * acceptée, sans endroit où déposer son travail, et le demandeur n'apprenait jamais si elle
 * serait faite.
 *
 * Désormais : **pour soi, une to-do** — personne n'accepte ce qu'il s'impose. **Pour quelqu'un
 * d'autre, une DEMANDE** — statut `REQUESTED`, notification en **pop-up** (une demande qui attend
 * votre réponse doit interrompre, sinon elle dort dans la cloche derrière quarante autres), et le
 * dossier complet : accepter / refuser, pièces, fil d'échange, validation du travail.
 */
export async function createTask(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Non autorisé." };

  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "L'intitulé est obligatoire." };

  const assignedToId = fdStr(formData, "assignedToId") ?? user.id;

  // Les pièces sont contrôlées AVANT toute écriture : créer la tâche puis refuser le fichier
  // laisserait une demande incomplète et un formulaire perdu.
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const refused = await validateAttachments(files);
  if (refused) return { ok: false, error: refused };

  // Participants (peuvent agir) et lecteurs (voient seulement), fixés à la création. Le
  // responsable et le créateur ont déjà accès : on les retire de ces listes. Un participant
  // l'emporte sur un lecteur si quelqu'un figure dans les deux.
  const clean = (field: string): string[] =>
    [...new Set(formData.getAll(field).map(String).filter(Boolean))]
      .filter((id) => id !== assignedToId && id !== user.id);
  const participantIds = clean("participantIds");
  const readerIds = clean("readerIds").filter((id) => !participantIds.includes(id));

  // Le CŒUR canonique (statut/`requestedAt` selon le mode, notifications pop-up/cloche, audit)
  // est partagé avec l'assistant : `lib/tasks/create-core.ts` — une seule logique du circuit.
  const created = await createTaskRecord(user.id, {
    title,
    description: fdStr(formData, "description"),
    assignedToId,
    participantIds,
    readerIds,
    dueDate: fdDate(formData, "dueDate"),
    priority: (fdStr(formData, "priority") as Priority) ?? "MEDIUM",
    module: fdStr(formData, "module"),
    // Course / livraison : adresse (lien Maps) + durée estimée (détection de retard).
    address: fdStr(formData, "address"),
    expectedMinutes: fdNum(formData, "expectedMinutes"),
  });

  // Une écriture qui échoue n'est plus perdue en silence (audit du 04/10, constat 8) : la tâche
  // existe — la refaire en ferait deux —, le manque est dit dans la réponse et dans la cloche.
  const attached = files.length > 0
    ? await attachFiles({ files, entityType: "TASK", entityId: created.id, uploadedById: user.id })
    : { saved: 0 };

  revalidatePath("/mon-espace");
  return { ok: true, id: created.id, ...(attached.error ? { message: `Tâche créée. ${attached.error}` } : {}) };
}

/**
 * Change a task's status. Allowed for its assignee, its creator, a participant, or a global view —
 * NOT the hierarchical manager: opening a team's tasks to its N+1 is a decision of the Direction
 * (audit 360°, D1 — §118.196, lot E3).
 */
export async function updateTaskStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "WORKSPACE", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as TaskStatus;
  if (!id || !status) return { ok: false, error: "Paramètres manquants." };

  const task = await prisma.task.findUnique({ where: { id }, select: { assignedToId: true, createdById: true, participantIds: true, title: true } });
  if (!task) return { ok: false, error: "Tâche introuvable." };

  // Le responsable, le créateur, un PARTICIPANT (pas un simple lecteur) ou une VUE GLOBALE peuvent agir — pas le
  // N+1 hiérarchique : le lui ouvrir est une décision de la Direction (D1), pas une ligne de code.
  const allowed = task.assignedToId === user.id || task.createdById === user.id
    || task.participantIds.includes(user.id) || hasGlobalView(user.role);
  if (!allowed) return { ok: false, error: "Non autorisé." };

  await prisma.task.update({
    where: { id },
    data: { status, completedAt: status === "DONE" ? new Date() : null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK",
    entityId: id, field: "status", newValue: status, summary: `Tâche « ${task.title} » → ${status}`,
  });
  revalidatePath("/mon-espace");
  return { ok: true };
}

/**
 * SUPPRIMER UNE TÂCHE — le geste de rangement qui manquait : une to-do créée en double, un
 * intitulé de test, une tâche devenue sans objet restaient à l'écran pour toujours (« terminée »
 * n'est pas « disparue »).
 *
 * QUI : le CRÉATEUR de la tâche (c'est sa saisie) ou le Super Admin. L'assigné d'une tâche
 * créée par un autre ne la supprime pas : sa voie est le refus (avec motif) ou le travail —
 * supprimer la demande d'autrui en silence ferait disparaître ce qu'on attend de lui.
 * Les pièces et le fil de la tâche partent avec elle : ce sont les siens, pas des archives.
 */
export async function deleteTask(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };

  const task = await prisma.task.findUnique({ where: { id }, select: { createdById: true, title: true, assignedToId: true, status: true } });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (task.createdById !== user.id && user.role !== "SUPER_ADMIN") {
    return { ok: false, error: "Seul le créateur de la tâche (ou un administrateur) peut la supprimer — refusez-la plutôt si elle vous a été demandée." };
  }
  // UNE DEMANDE ENCORE OUVERTE CHEZ QUELQU'UN D'AUTRE S'ANNULE, ELLE NE S'EFFACE PAS (décision du
  // 04/10) : la supprimer ferait disparaître sans un mot ce que l'autre a peut-être commencé.
  if (user.role !== "SUPER_ADMIN" && refusAnnulationDemande(task, user.id) === null) {
    return { ok: false, error: "Cette demande est encore ouverte chez son destinataire : annulez-la plutôt — il en sera prévenu, et le fil reste." };
  }

  // Les fichiers du stockage sont libérés APRÈS la suppression en base (best-effort) : un blob
  // orphelin est un déchet, une ligne orpheline serait un bug.
  const docs = await prisma.document.findMany({ where: { entityType: "TASK", entityId: id }, select: { fileKey: true } });
  await prisma.$transaction([
    prisma.document.deleteMany({ where: { entityType: "TASK", entityId: id } }),
    prisma.comment.deleteMany({ where: { entityType: "TASK", entityId: id } }),
    prisma.task.delete({ where: { id } }),
  ]);
  const { deleteFileByKey } = await import("@/lib/storage");
  for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(sansBloquer("task-actions.deleteTask.deleteFileByKey"));

  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Espace de travail", entityType: "TASK",
    entityId: id, summary: `Tâche « ${task.title} » supprimée`,
  });
  revalidatePath("/mon-espace");
  return { ok: true };
}

/** Démarre une tâche « course / déplacement » : horodate le départ (et passe en cours). */
export async function startTask(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };
  const task = await prisma.task.findUnique({ where: { id }, select: { assignedToId: true, createdById: true, participantIds: true, title: true, startedAt: true } });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (!(task.assignedToId === user.id || task.createdById === user.id || task.participantIds.includes(user.id) || hasGlobalView(user.role))) return { ok: false, error: "Non autorisé." };
  await prisma.task.update({ where: { id }, data: { startedAt: task.startedAt ?? new Date(), status: "IN_PROGRESS" } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id, summary: `Départ — « ${task.title} »` });
  revalidatePath("/mon-espace");
  return { ok: true };
}

/**
 * Demande de tâche à un collègue — conservée comme PORTE D'ENTRÉE (un message qu'on transforme
 * en tâche, un appel d'API), mais ce n'est plus un circuit à part : `createTask` reconnaît seul
 * qu'un destinataire différent de soi fait une demande. Deux chemins de code pour la même règle
 * auraient divergé à la première correction.
 *
 * Elle EXIGE un destinataire, là où `createTask` retombe sur soi-même : demander une tâche à
 * personne n'a pas de sens, et se la « demander » à soi non plus.
 */
export async function requestTask(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const assignedToId = fdStr(formData, "assignedToId");
  if (!assignedToId || assignedToId === user.id) return { ok: false, error: "Choisissez le destinataire de la demande." };
  return createTask(undefined, formData);
}

/**
 * ÉCRIRE DANS LE FIL D'UNE TÂCHE.
 *
 * Un commentaire n'est pas une décision : il ne change ni le statut, ni l'échéance, ni qui fait
 * quoi. C'est pourquoi tout le cercle peut en écrire un, lecteurs compris — on les a nommés parce
 * qu'ils connaissent le sujet, et les renvoyer vers la messagerie séparerait l'information de la
 * tâche qu'elle concerne.
 *
 * Le fil ne se modifie ni ne s'efface : c'est la trace de l'échange, pas un brouillon. Une
 * précision qui remplacerait discrètement la question à laquelle l'autre a répondu rendrait le
 * fil illisible trois semaines plus tard.
 */
export async function addTaskComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = (formData.get("body") ? String(formData.get("body")) : "").trim().slice(0, 4000);
  if (!id) return { ok: false, error: "Tâche introuvable." };
  if (!body) return { ok: false, error: "Le message est vide." };

  const task = await prisma.task.findUnique({
    where: { id },
    select: { assignedToId: true, createdById: true, participantIds: true, readerIds: true, title: true, status: true, requestedAt: true },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (!canComment(task, user.id, hasGlobalView(user.role))) return { ok: false, error: "Non autorisé." };

  await prisma.taskComment.create({ data: { taskId: id, authorId: user.id, body } });

  // Prévenir LE CERCLE, sauf soi-même : un fil dont personne n'apprend l'existence n'est pas un
  // fil, c'est un carnet. Cloche simple — un échange n'interrompt pas, seule une demande le fait.
  const circle = [...new Set([
    task.assignedToId, task.createdById, ...task.participantIds, ...task.readerIds,
  ].filter((x): x is string => Boolean(x) && x !== user.id))];
  if (circle.length) {
    const lignes = circle.map((userId) => ({
      userId, type: "GENERIC" as const,
      title: `${user.name} a commenté une tâche`,
      body: `${task.title} — ${body.slice(0, 120)}`,
      link: lienTache(id, vueTachePour(userId, task)),
    }));
    try {
      await prisma.notification.createMany({ data: lignes });
    } catch (err) {
      await rejouerNotifications(lignes, err);
    }
  }

  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true };
}

/**
 * Le destinataire ACCEPTE ou REFUSE une demande de tâche.
 *
 * Accepter fait passer directement **en cours** : accepter, c'est prendre en charge. Un
 * passage par « à faire » obligerait à un second clic qui n'apprend rien à personne — et
 * c'est exactement l'étape intermédiaire qu'on supprime ici.
 *
 * Refuser accepte un motif, FACULTATIF. Le rendre obligatoire ne produit pas de meilleures
 * raisons : il produit des « non » et des « pas dispo ».
 */
export async function respondTaskRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const accept = fdStr(formData, "accept") === "1";
  if (!id) return { ok: false, error: "Tâche introuvable." };
  const task = await prisma.task.findUnique({ where: { id }, select: { assignedToId: true, createdById: true, title: true, status: true, requestedAt: true } });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (!canRespond({ ...task, status: task.status }, user.id)) {
    return { ok: false, error: task.status === "REQUESTED" ? "Seul le destinataire peut répondre." : "Cette demande a déjà été traitée." };
  }

  const reason = accept ? null : fdStr(formData, "reason");
  const status = accept ? ACCEPTED_STATUS : DECLINED_STATUS;
  await prisma.task.update({
    where: { id },
    data: { status, respondedAt: new Date(), declineReason: reason, ...(accept ? { startedAt: new Date() } : {}) },
  });
  if (task.createdById) {
    await prisma.notification.create({
      data: {
        userId: task.createdById, type: "GENERIC",
        title: accept ? "Demande de tâche acceptée" : "Demande de tâche refusée",
        body: accept ? task.title : `${task.title} — ${declineSummary(reason)}`,
        link: lienTache(id, "demandees"),
      },
    }).catch(sansBloquer("task-actions.respondTaskRequest.notification"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    field: "status", newValue: status,
    summary: accept ? `Demande acceptée — « ${task.title} »` : `Demande refusée — « ${task.title} » · ${declineSummary(reason)}`,
  });
  revalidatePath("/mon-espace");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true };
}

/**
 * VALIDER SON TRAVAIL — le dernier geste de celui qui a fait la chose demandée.
 *
 * Toujours modifiable : on valide en fin de journée, on retrouve une pièce le lendemain. Si
 * valider fermait la porte, la pièce partirait par message et le dossier resterait faux. Le
 * même bouton sert donc à valider puis à mettre à jour, et le demandeur est prévenu à chaque
 * fois — c'est ce qui rend la modification honnête plutôt que discrète.
 */
export async function submitTaskWork(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };
  const task = await prisma.task.findUnique({
    where: { id },
    select: { assignedToId: true, createdById: true, participantIds: true, title: true, status: true, requestedAt: true },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (!canDoWork(task, user.id)) return { ok: false, error: "Seule la personne chargée de la tâche valide son travail." };

  const again = task.status === "DONE";
  await prisma.task.update({
    where: { id },
    data: { status: "DONE", completedAt: again ? undefined : new Date(), completionNote: fdStr(formData, "note") },
  });
  if (task.createdById && task.createdById !== user.id) {
    await prisma.notification.create({
      data: {
        userId: task.createdById, type: "GENERIC",
        title: again ? "Travail mis à jour" : "Travail terminé",
        body: task.title, link: lienTache(id, "demandees"),
      },
    }).catch(sansBloquer("task-actions.submitTaskWork.notification"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    summary: `${again ? "Travail mis à jour" : "Travail validé"} — « ${task.title} »`,
  });
  revalidatePath("/mon-espace");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true };
}

/** Rouvrir son travail : la validation n'est pas une porte qui claque. */
export async function reopenTaskWork(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };
  const task = await prisma.task.findUnique({
    where: { id },
    select: { assignedToId: true, createdById: true, participantIds: true, title: true, status: true, requestedAt: true },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  if (!canDoWork(task, user.id)) return { ok: false, error: "Non autorisé." };

  await prisma.task.update({ where: { id }, data: { status: "IN_PROGRESS", completedAt: null } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    summary: `Travail rouvert — « ${task.title} »`,
  });
  revalidatePath("/mon-espace");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true };
}

/**
 * RELANCER quelqu'un sur une demande qu'on lui a faite.
 *
 * Ce que le geste produit, et pourquoi chacun des trois :
 *
 * 1. **Une notification qui INTERROMPT** — la même que la demande elle-même. Une relance
 *    déposée dans la cloche derrière quarante autres n'est pas une relance.
 * 2. **Une ligne dans le fil de la tâche** — la relance devient une trace lisible par les deux
 *    parties. Sans elle, on relance trois fois et personne ne peut dire combien de fois.
 * 3. **Le compteur** — pour dire « 3ᵉ relance » sans le recompter, et pour tenir le délai.
 *
 * La règle (qui, quand) est PURE et partagée avec l'écran : `peutRelancer`. Le serveur la
 * rejoue — un bouton ne décide de rien — et rend le MOTIF du refus, que le bouton affiche.
 */
export async function relanceTaskRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };

  const task = await prisma.task.findUnique({
    where: { id },
    select: {
      title: true, status: true, requestedAt: true, assignedToId: true, createdById: true,
      lastNudgeAt: true, nudgeCount: true, dueDate: true,
    },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };

  const verdict = peutRelancer(task, user.id);
  if (!verdict.ok) return { ok: false, error: verdict.raison };

  const rang = (task.nudgeCount ?? 0) + 1;
  const enAttenteDeReponse = task.status === "REQUESTED";
  const corps = enAttenteDeReponse
    ? `${task.title} — ${user.name} attend toujours votre réponse (accepter ou refuser).`
    : `${task.title} — ${user.name} attend toujours ce travail.`;

  await prisma.task.update({ where: { id }, data: { lastNudgeAt: new Date(), nudgeCount: rang } });

  if (task.assignedToId) {
    await prisma.notification.create({
      data: {
        userId: task.assignedToId, type: "ASSIGNMENT",
        title: relanceTitre(rang), body: corps,
        link: lienTache(id),
        // Elle INTERROMPT : c'est le sens même d'une relance. La demande initiale interrompt
        // déjà ; une relance qui, elle, ne le ferait pas serait plus faible que ce qu'elle
        // rappelle.
        popup: true,
      },
    }).catch(sansBloquer("task-actions.relanceTaskRequest.notification"));
  }

  // La relance s'écrit DANS la tâche. Un rappel qui part par message vit ailleurs que ce
  // qu'il concerne : trois semaines plus tard, personne ne peut dire s'il a été fait.
  await prisma.taskComment.create({
    data: {
      taskId: id, authorId: user.id,
      body: rang <= 1 ? "Relance — cette demande attend toujours." : `Relance (${rang}ᵉ) — cette demande attend toujours.`,
    },
  }).catch(sansBloquer("task-actions.relanceTaskRequest.taskComment"));

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    field: "relance", newValue: String(rang),
    summary: `Relance ${rang} — « ${task.title} »`,
  });

  revalidatePath("/mon-espace");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true };
}

/**
 * ANNULER UNE DEMANDE DE TÂCHE (décision de la Direction, 04/10) — le demandeur clôt ce qu'il a
 * demandé tant que l'autre ne l'a pas exécuté. Motif FACULTATIF (renoncer ne se justifie pas plus
 * que refuser), assigné prévenu, fil gardé. Écriture CONDITIONNELLE : un travail validé pendant le
 * clic ne se fait pas annuler, et deux clics n'annulent qu'une fois.
 */
export async function annulerDemandeTache(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Tâche introuvable." };
  const motif = fdStr(formData, "motif");

  const task = await prisma.task.findUnique({
    where: { id },
    select: { title: true, status: true, assignedToId: true, createdById: true, requestedAt: true },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  const refus = refusAnnulationDemande(task, user.id);
  if (refus) return { ok: false, error: refus };

  const pris = await prisma.task.updateMany({
    where: { id, createdById: user.id, status: { in: [...STATUTS_ANNULABLES] } },
    data: { status: "CANCELLED", completedAt: null },
  });
  if (pris.count === 0) {
    const apres = await prisma.task.findUnique({ where: { id }, select: { status: true, createdById: true, assignedToId: true } });
    return { ok: false, error: (apres && refusAnnulationDemande(apres, user.id)) ?? "Cette demande vient de changer — rechargez la page." };
  }

  await prisma.taskComment.create({
    data: { taskId: id, authorId: user.id, body: motif ? `Demande annulée par son demandeur — ${motif}` : "Demande annulée par son demandeur." },
  }).catch(sansBloquer("task-actions.annulerDemandeTache.taskComment"));
  if (task.assignedToId) {
    await prisma.notification.create({
      data: {
        userId: task.assignedToId, type: "ASSIGNMENT",
        title: "Demande annulée",
        body: `${user.name} a annulé « ${task.title} »${motif ? ` — ${motif}` : ""}. Vous n'avez plus à la traiter.`,
        link: lienTache(id),
      },
    }).catch(sansBloquer("task-actions.annulerDemandeTache.notification"));
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    field: "status", oldValue: task.status, newValue: "CANCELLED",
    summary: `Demande « ${task.title} » annulée par son demandeur${motif ? ` — ${motif}` : ""}`,
  });
  revalidatePath("/mon-espace");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true, id, message: "Demande annulée — la personne est prévenue." };
}

/**
 * RÉATTRIBUER UNE DEMANDE (Direction, 07/10) — refusée ou restée sans réponse, elle part chez quelqu'un
 * d'autre au lieu d'être recréée à la main. La nouvelle personne reçoit une DEMANDE (pop-up : elle
 * attend sa réponse) ; l'ancienne, si elle n'avait pas encore répondu, apprend qu'elle n'a plus à le
 * faire. Le fil garde la trace. Écriture CONDITIONNELLE : une acceptation pendant le clic l'emporte.
 */
export async function reattribuerDemandeTache(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const nouveauId = fdStr(formData, "assignedToId");
  if (!id) return { ok: false, error: "Tâche introuvable." };

  const task = await prisma.task.findUnique({
    where: { id },
    select: { title: true, status: true, assignedToId: true, createdById: true, requestedAt: true, participantIds: true, readerIds: true, assignedTo: { select: { name: true } } },
  });
  if (!task) return { ok: false, error: "Tâche introuvable." };
  const refus = refusReattribution(task, user.id, nouveauId);
  if (refus) return { ok: false, error: refus };
  const nouveau = await prisma.user.findFirst({ where: { id: nouveauId!, isActive: true }, select: { id: true, name: true } });
  if (!nouveau) return { ok: false, error: "Cette personne n'est pas (ou plus) active." };

  const pris = await prisma.task.updateMany({
    where: { id, createdById: user.id, status: { in: [...STATUTS_REATTRIBUABLES] } },
    data: {
      assignedToId: nouveau.id, status: "REQUESTED", requestedAt: new Date(), respondedAt: null,
      declineReason: null, lastNudgeAt: null, nudgeCount: 0, startedAt: null,
      // La nouvelle personne est RESPONSABLE : elle ne figure plus parmi les participants ou les lecteurs.
      participantIds: task.participantIds.filter((p) => p !== nouveau.id),
      readerIds: task.readerIds.filter((p) => p !== nouveau.id),
    },
  });
  if (pris.count === 0) return { ok: false, error: "Cette demande vient de changer — rechargez la page." };

  const ancien = task.assignedTo?.name ?? null;
  await prisma.taskComment.create({
    data: { taskId: id, authorId: user.id, body: `Demande réattribuée à ${nouveau.name}${ancien ? ` (auparavant : ${ancien})` : ""}.` },
  }).catch(sansBloquer("task-actions.reattribuerDemandeTache.taskComment"));
  const lignes = [
    { userId: nouveau.id, type: "ASSIGNMENT" as const, title: "Demande de tâche", body: task.title, link: lienTache(id), popup: true },
    // L'ancien destinataire ne voit plus la tâche : on le mène à SES tâches, pas à une fiche fermée.
    ...(task.status === "REQUESTED" && task.assignedToId && task.assignedToId !== nouveau.id
      ? [{ userId: task.assignedToId, type: "ASSIGNMENT" as const, title: "Demande réattribuée", body: `${task.title} — vous n'avez plus à la traiter.`, link: CHEMIN_TACHES, popup: false }]
      : []),
  ];
  try {
    await prisma.notification.createMany({ data: lignes });
  } catch (err) {
    await rejouerNotifications(lignes, err);
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Espace de travail", entityType: "TASK", entityId: id,
    field: "assignedToId", oldValue: task.assignedToId ?? undefined, newValue: nouveau.id,
    summary: `Demande « ${task.title} » réattribuée à ${nouveau.name}`,
  });
  revalidatePath("/mon-espace/taches");
  revalidatePath(`/mon-espace/taches/${id}`);
  return { ok: true, id, message: `Demande envoyée à ${nouveau.name}.` };
}
