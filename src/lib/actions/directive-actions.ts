"use server";

import { revalidatePath } from "next/cache";
import type { DirectiveStatus, Priority, UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { referenceDeSerie } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { getAppSettings } from "@/lib/settings";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import {
  canPublishDirectives, publishesImmediately, validateAudience, isRecipient,
  PUBLISHER_ROLES, type DirectiveAudience,
} from "@/lib/directives/audience";
import { canIssueDirective } from "@/lib/directives/access";
import {
  sendDirective, attachDirectiveFiles, resolveRecipientIds, companyIdsOf, scopeOf,
} from "@/lib/directives/recipients";
import { rejouerNotifications } from "@/lib/notifications/ecrire";
import { sansBloquer } from "@/lib/journal";

const PATH = "/directives";
const STATUSES: DirectiveStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "DONE", "ARCHIVED"];
const AUDIENCES: DirectiveAudience[] = ["USERS", "ROLE", "COMPANY", "ALL"];

/** La personne, telle que les modules purs de `lib/directives/` l'attendent. */
function person(user: SessionUser, companyIds: string[] = []) {
  return { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, companyIds };
}

/** Les réglages d'accès du module, posés par le Super Admin (Administration › Réglages). */
async function directiveAccess() {
  const s = await getAppSettings().catch(sansBloquer("directive-actions.directiveAccess.getAppSettings", null));
  return {
    directiveReaderRoles: s?.directiveReaderRoles ?? [],
    directiveReaderUserIds: s?.directiveReaderUserIds ?? [],
    directiveIssuerRoles: s?.directiveIssuerRoles ?? [],
    directiveIssuerUserIds: s?.directiveIssuerUserIds ?? [],
  };
}

/** Qui PILOTE le module : la Direction, un admin global, ou un accès accordé nommément. */
async function canManage(user: SessionUser): Promise<boolean> {
  if (hasGlobalView(user.role)) return true;
  return canIssueDirective(person(user), await directiveAccess(), userCan(user, "DIRECTIVES", "CREATE"));
}

type DirectiveLike = {
  fromId: string | null;
  audience: DirectiveAudience;
  targetUserIds: string[];
  targetRole: UserRole | null;
  companyId: string | null;
};

/** Destinataire (quelle que soit la portée), émetteur, ou Direction : peut suivre + échanger. */
async function canParticipate(user: SessionUser, d: DirectiveLike): Promise<boolean> {
  if (d.fromId === user.id) return true;
  if (await canManage(user)) return true;
  return isRecipient(person(user, await companyIdsOf(user.id)), scopeOf(d));
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
  revalidatePath("/mon-travail");
}

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "Directive", prefixe: "DIR", annee: year,
    existantes: async () => (await prisma.directive.findMany({ where: { reference: { startsWith: `DIR-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

// ───────────── Création : on RÉDIGE ici, on ne publie pas ─────────────

/**
 * ÉMETTRE une directive.
 *
 * Rien ne part à ce stade si l'auteur n'est pas la direction générale : la note entre en
 * `PENDING_APPROVAL` et attend une signature. Notifier d'abord et valider ensuite serait
 * l'ordre inverse de ce qu'on veut — une note lue ne se rattrape pas.
 */
export async function createDirective(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(await canManage(user))) return { ok: false, error: "Vous n'êtes pas autorisé à émettre une directive." };

  const title = fdStr(formData, "title");
  const body = fdStr(formData, "body");
  if (!title || !body) return { ok: false, error: "Le titre et le contenu sont obligatoires." };

  // Plusieurs destinataires : le formulaire poste autant de champs `targetUserIds` que de
  // personnes cochées ; on accepte aussi une liste séparée par des virgules (import, API) et le
  // `targetUserId` d'AVANT les portées multiples — Adam et les intégrations le postent encore,
  // et casser leurs appels pour un changement de nom de champ serait gratuit.
  const targetUserIds = [...new Set(
    [...formData.getAll("targetUserIds"), ...formData.getAll("targetUserId")]
      .flatMap((v) => String(v).split(","))
      .map((s) => s.trim())
      .filter(Boolean),
  )];
  const targetRole = (fdStr(formData, "targetRole") as UserRole | null) ?? null;
  const companyId = fdStr(formData, "companyId");

  // Portée : explicite si le formulaire la donne, DÉDUITE sinon de ce qui est rempli — une
  // personne nommée prime sur un rôle, comme avant.
  const audience: DirectiveAudience = (fdStr(formData, "audience") as DirectiveAudience | null)
    ?? (targetUserIds.length ? "USERS" : targetRole ? "ROLE" : companyId ? "COMPANY" : "USERS");
  if (!AUDIENCES.includes(audience)) return { ok: false, error: "Portée de diffusion inconnue." };

  const scope = { audience, targetUserIds, targetRole, companyId: companyId ?? null };
  const manque = validateAudience(scope);
  if (manque) return { ok: false, error: manque };

  const auteur = person(user);
  const publieDirect = publishesImmediately(auteur);
  const now = new Date();
  const reference = await nextRef();

  const created = await prisma.directive.create({
    data: {
      reference, title, body,
      priority: (fdStr(formData, "priority") as Priority) ?? "MEDIUM",
      dueDate: fdDate(formData, "dueDate"),
      audience,
      targetUserIds,
      // Cache dénormalisé qui porte la relation d'affichage (cf. schema.prisma).
      targetUserId: audience === "USERS" ? (targetUserIds[0] ?? null) : null,
      targetRole: audience === "ROLE" ? targetRole : null,
      companyId: audience === "COMPANY" ? companyId : null,
      popup: fdStr(formData, "popup") === "on" || fdStr(formData, "popup") === "true",
      fromId: user.id,
      publication: publieDirect ? "PUBLISHED" : "PENDING_APPROVAL",
      submittedAt: now,
      ...(publieDirect ? { approvedById: user.id, approvedAt: now, publishedAt: now } : {}),
    },
  });

  // La PIÈCE JOINTE part avec la note : elle doit exister avant la première notification,
  // sinon le premier lecteur ouvre une directive dont le document « arrive dans un instant ».
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) {
    const err = await attachDirectiveFiles(created.id, files, user.id);
    if (err) return { ok: false, error: err };
  }

  if (publieDirect) {
    const sent = await sendDirective({ ...created, targetRole: created.targetRole as string | null });
    await prisma.directive.update({
      where: { id: created.id },
      data: { sendCount: 1, lastSentAt: now },
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Directives", entityType: "DIRECTIVE", entityId: created.id,
      summary: `Directive ${reference} publiée — ${title} (${sent} destinataire·s)`,
    });
  } else {
    // Le valideur doit savoir qu'on attend sa signature — sans quoi la note dort.
    await notifyRoles(PUBLISHER_ROLES as unknown as UserRole[], {
      type: "GENERIC", title: "Directive à valider",
      body: `${reference} — ${title} (de ${user.name})`, link: `${PATH}/${created.id}`,
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Directives", entityType: "DIRECTIVE", entityId: created.id,
      summary: `Directive ${reference} soumise à validation — ${title}`,
    });
  }

  revalidate(created.id);
  return { ok: true, id: created.id };
}

// ───────────── Publication : la signature de la direction générale ─────────────

/**
 * PUBLIER — accorder la diffusion, et l'exécuter dans le même geste.
 *
 * Séparer « approuver » et « envoyer » laisserait des notes approuvées que personne n'a reçues :
 * l'accord EST l'envoi.
 */
export async function publishDirective(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canPublishDirectives(person(user))) {
    return { ok: false, error: "Seule la direction générale (ou le Super Admin) publie une directive." };
  }
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Directive introuvable." };

  const d = await prisma.directive.findUnique({ where: { id } });
  if (!d) return { ok: false, error: "Directive introuvable." };
  if (d.publication === "PUBLISHED") return { ok: false, error: "Cette directive est déjà publiée." };

  const manque = validateAudience({
    audience: d.audience, targetUserIds: d.targetUserIds,
    targetRole: d.targetRole as string | null, companyId: d.companyId,
  });
  if (manque) return { ok: false, error: manque };

  const now = new Date();
  const sent = await sendDirective({ ...d, targetRole: d.targetRole as string | null });
  await prisma.directive.update({
    where: { id },
    data: {
      publication: "PUBLISHED", approvedById: user.id, approvedAt: now, publishedAt: now,
      decisionNote: fdStr(formData, "note"), sendCount: { increment: 1 }, lastSentAt: now,
    },
  });

  if (d.fromId && d.fromId !== user.id) {
    await notifyUser({
      userId: d.fromId, type: "GENERIC", title: "Directive publiée",
      body: `${d.reference} — ${d.title} · ${sent} destinataire·s`, link: `${PATH}/${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Directives", entityType: "DIRECTIVE", entityId: id,
    field: "publication", newValue: "PUBLISHED",
    summary: `Directive ${d.reference} publiée à ${sent} destinataire·s`,
  });
  revalidate(id);
  return { ok: true };
}

/** REFUSER — la note ne part pas, et son auteur apprend POURQUOI. */
export async function rejectDirective(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canPublishDirectives(person(user))) {
    return { ok: false, error: "Seule la direction générale (ou le Super Admin) se prononce sur une directive." };
  }
  const id = fdStr(formData, "id");
  const note = fdStr(formData, "note");
  if (!id) return { ok: false, error: "Directive introuvable." };
  if (!note) return { ok: false, error: "Dites pourquoi : un refus sans motif ne se corrige pas." };

  const d = await prisma.directive.findUnique({ where: { id } });
  if (!d) return { ok: false, error: "Directive introuvable." };
  if (d.publication === "PUBLISHED") {
    return { ok: false, error: "Cette directive est déjà partie : elle ne peut plus être refusée." };
  }

  await prisma.directive.update({
    where: { id },
    data: { publication: "REJECTED", approvedById: user.id, approvedAt: new Date(), decisionNote: note },
  });
  if (d.fromId && d.fromId !== user.id) {
    await notifyUser({
      userId: d.fromId, type: "GENERIC", title: "Directive refusée",
      body: `${d.reference} — ${note}`, link: `${PATH}/${id}`,
    });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Directives", entityType: "DIRECTIVE", entityId: id,
    field: "publication", newValue: "REJECTED", summary: `Directive ${d.reference} refusée — ${note}`,
  });
  revalidate(id);
  return { ok: true };
}

/**
 * RENVOYER — la même note, à la même portée, une fois de plus.
 *
 * Une note non lue se rappelle. Le compteur monte : sans lui, on renvoie trois fois en croyant
 * renvoyer une première fois, et le destinataire reçoit trois pop-up identiques sans que
 * personne ne s'en aperçoive.
 */
export async function resendDirective(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Directive introuvable." };

  const d = await prisma.directive.findUnique({ where: { id } });
  if (!d) return { ok: false, error: "Directive introuvable." };
  // Renvoyer, c'est diffuser : le droit est celui de la publication, ou celui de l'émetteur.
  if (!canPublishDirectives(person(user)) && d.fromId !== user.id) {
    return { ok: false, error: "Seuls l'émetteur et la direction générale peuvent renvoyer une directive." };
  }
  if (d.publication !== "PUBLISHED") {
    return { ok: false, error: "Une directive non publiée ne se renvoie pas — faites-la d'abord valider." };
  }

  const sent = await sendDirective({ ...d, targetRole: d.targetRole as string | null }, { relance: true });
  await prisma.directive.update({
    where: { id },
    data: { sendCount: { increment: 1 }, lastSentAt: new Date() },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Directives", entityType: "DIRECTIVE", entityId: id,
    summary: `Directive ${d.reference} renvoyée à ${sent} destinataire·s (envoi n°${d.sendCount + 1})`,
  });
  revalidate(id);
  return { ok: true, message: `Renvoyée à ${sent} personne·s.` };
}

// ───────────── Changement de statut (destinataire ou Direction) ─────────────

export async function updateDirectiveStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as DirectiveStatus | null;
  if (!id || !status || !STATUSES.includes(status)) return { ok: false, error: "Statut invalide." };

  const d = await prisma.directive.findUnique({ where: { id } });
  if (!d) return { ok: false, error: "Directive introuvable." };
  if (!(await canParticipate(user, d))) return { ok: false, error: "Non autorisé." };
  // TANT QU'ELLE N'EST PAS PARTIE, elle n'a pas de destinataire : « accuser réception » d'une
  // note que personne n'a reçue n'a aucun sens, et laisserait croire qu'elle a circulé.
  // Seuls l'auteur et la Direction peuvent encore la manipuler (pour l'archiver, par exemple).
  if (d.publication !== "PUBLISHED" && d.fromId !== user.id && !(await canManage(user))) {
    return { ok: false, error: "Cette directive n'est pas encore publiée." };
  }
  // L'archivage est réservé à la Direction.
  if (status === "ARCHIVED" && !(await canManage(user))) return { ok: false, error: "Seule la Direction peut archiver." };

  await prisma.directive.update({
    where: { id },
    data: {
      status,
      ...(status === "ACKNOWLEDGED" && !d.acknowledgedAt ? { acknowledgedAt: new Date(), acknowledgedById: user.id } : {}),
    },
  });
  // Informe l'émetteur de l'avancement (sauf si c'est lui qui agit).
  if (d.fromId && d.fromId !== user.id) {
    await notifyUser({ userId: d.fromId, type: "GENERIC", title: "Directive — avancement", body: `${d.reference} — ${d.title}`, link: `${PATH}/${id}` });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Directives", entityType: "DIRECTIVE", entityId: id, summary: `Statut → ${status} (${d.reference})` });
  revalidate(id);
  return { ok: true };
}

export async function archiveDirective(formData: FormData): Promise<ActionResult> {
  const fd = new FormData();
  fd.set("id", fdStr(formData, "id") ?? "");
  fd.set("status", "ARCHIVED");
  return updateDirectiveStatus(fd);
}

// ───────────── Fil d'échange (retour des équipes ↔ Direction) ─────────────

export async function postDirectiveMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = fdStr(formData, "body");
  if (!id || !body) return { ok: false, error: "Message vide." };

  const d = await prisma.directive.findUnique({ where: { id } });
  if (!d) return { ok: false, error: "Directive introuvable." };
  if (!(await canParticipate(user, d))) return { ok: false, error: "Non autorisé." };
  // Même règle que pour le statut : on ne discute pas d'une note qui n'est pas encore partie.
  if (d.publication !== "PUBLISHED" && d.fromId !== user.id && !(await canManage(user))) {
    return { ok: false, error: "Cette directive n'est pas encore publiée." };
  }

  await prisma.directiveMessage.create({ data: { directiveId: id, authorId: user.id, body } });

  // Notifie l'autre partie. Sur une diffusion large, seul l'ÉMETTEUR est prévenu d'une réponse :
  // renvoyer chaque message à deux cents personnes transformerait la note en liste de diffusion.
  if (user.id === d.fromId) {
    const ids = (await resolveRecipientIds({
      audience: d.audience, targetUserIds: d.targetUserIds,
      targetRole: d.targetRole as string | null, companyId: d.companyId,
    })).filter((uid) => uid !== user.id);
    // Une réponse de la Direction se pousse à la personne quand la note est nominative ;
    // au-delà, elle vit dans le fil, que chacun retrouve depuis la directive.
    if (ids.length > 0 && ids.length <= 5) {
      const lignes = ids.map((userId) => ({
        userId, type: "GENERIC" as const, title: "Directive — message",
        body: `${d.reference} — ${d.title}`, link: `${PATH}/${id}`,
      }));
      try {
        await prisma.notification.createMany({ data: lignes });
      } catch (err) {
        await rejouerNotifications(lignes, err);
      }
    }
  } else if (d.fromId) {
    await notifyUser({ userId: d.fromId, type: "GENERIC", title: "Directive — réponse", body: `${d.reference} — ${d.title}`, link: `${PATH}/${id}` });
  }
  revalidate(id);
  return { ok: true };
}
