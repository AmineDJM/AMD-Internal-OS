import type { Prisma, AdminRequestStatus, AdminRequestType } from "@prisma/client";
import { scopeAdminRequests, hasGlobalView, isTopManagement, userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { auNomDeQui, standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { clauseDemandesSecretariatVisibles } from "@/lib/queries/visibilite-listes";
import { interditSurSaPropreDemande } from "@/lib/secretariat/decision-approbation";
import { statutAffiche } from "@/lib/secretariat/traitement";

const REQ_INCLUDE = {
  requester: { select: { name: true } },
  assignedTo: { select: { name: true } },
  validator: { select: { name: true } },
} as const;

/** Les statuts qui ne demandent plus rien au secrétariat. */
const TERMINAUX: AdminRequestStatus[] = ["DONE", "CANCELLED"];
/** Une limite OPÉRATIONNELLE (§118.2) : au-delà, la page le dit — elle ne se tait jamais. */
const PLAFOND_OUVERTES = 1000;
const DERNIERES_TERMINEES = 100;

/**
 * LE BUREAU DU SECRÉTARIAT — toutes les demandes OUVERTES, et les dernières terminées.
 *
 * La liste chargeait les 200 demandes les plus RÉCENTES, terminées comprises, et les filtres de
 * colonne ne s'appliquaient qu'à ces 200 lignes (audit 360°, I10) : une demande ouverte ancienne
 * disparaissait de toutes les vues qu'elle pouvait atteindre, et l'écran affichait « N / 200 »
 * comme un compte. On charge désormais CE QUI EST À TRAITER en entier (jusqu'à la limite, dite), et
 * les dernières terminées pour mémoire — avec les TOTAUX réels, que l'écran affiche (§118.60).
 */
export async function getRequestList(user: SessionUser, filters: { status?: string; type?: string }) {
  // Cloisonnement par entité : la vue « Adventum » ne montre que les demandes d'Adventum.
  const and: Prisma.AdministrativeRequestWhereInput[] = [await clauseDemandesSecretariatVisibles(user)];
  if (filters.type) and.push({ type: filters.type as AdminRequestType });
  if (filters.status) {
    const where = { AND: [...and, { status: filters.status as AdminRequestStatus }] };
    const [rows, total] = await Promise.all([
      prisma.administrativeRequest.findMany({ where, include: REQ_INCLUDE, orderBy: [{ createdAt: "desc" }], take: PLAFOND_OUVERTES }),
      prisma.administrativeRequest.count({ where }),
    ]);
    return { rows, ouvertes: total, terminees: 0, terminesMontrees: 0, coupe: total > rows.length };
  }
  const ouvertesWhere = { AND: [...and, { status: { notIn: TERMINAUX } }] };
  const termineesWhere = { AND: [...and, { status: { in: TERMINAUX } }] };
  const [ouvertes, nbOuvertes, terminees, nbTerminees] = await Promise.all([
    prisma.administrativeRequest.findMany({ where: ouvertesWhere, include: REQ_INCLUDE, orderBy: [{ createdAt: "desc" }], take: PLAFOND_OUVERTES }),
    prisma.administrativeRequest.count({ where: ouvertesWhere }),
    prisma.administrativeRequest.findMany({ where: termineesWhere, include: REQ_INCLUDE, orderBy: [{ createdAt: "desc" }], take: DERNIERES_TERMINEES }),
    prisma.administrativeRequest.count({ where: termineesWhere }),
  ]);
  return {
    rows: [...ouvertes, ...terminees],
    ouvertes: nbOuvertes,
    terminees: nbTerminees,
    terminesMontrees: terminees.length,
    coupe: nbOuvertes > ouvertes.length,
  };
}

export async function getAssistantData(user: SessionUser) {
  const now = new Date();
  const scope = scopeAdminRequests(user);
  const requests = await prisma.administrativeRequest.findMany({ where: scope, include: REQ_INCLUDE, orderBy: { createdAt: "desc" }, take: 300 });
  const terminal = ["DONE", "CANCELLED"];
  // Une étape retirée (en attente d'un tiers, d'un document, bloquée à la main) se lit « En cours » (10/2026).
  const open = requests.filter((r) => !terminal.includes(r.status)).map((r) => ({ ...r, status: statutAffiche(r.status, r.blockedReason) as AdminRequestStatus }));
  const stats = {
    nouvelles: open.filter((r) => r.status === "NEW").length,
    enCours: open.filter((r) => r.status === "IN_PROGRESS").length,
    urgentes: open.filter((r) => r.priority === "HIGH" || r.priority === "CRITICAL").length,
    enRetard: open.filter((r) => r.deadline && r.deadline < now).length,
    attenteValidation: open.filter((r) => r.status === "AWAITING_VALIDATION").length,
    attentePaiement: open.filter((r) => r.status === "AWAITING_PAYMENT").length,
    ouvertes: open.length,
  };
  return { requests, open, stats };
}

/** Corbeille : demandes supprimées (soft delete) — réservé aux gestionnaires. */
export async function getDeletedRequests(user: SessionUser) {
  if (!(hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE"))) return [];
  const rows = await prisma.administrativeRequest.findMany({
    where: { deletedAt: { not: null } },
    include: REQ_INCLUDE,
    orderBy: { deletedAt: "desc" },
    take: 200,
  });
  // Résolution du nom de l'auteur de la suppression (pas de relation dédiée).
  const actorIds = [...new Set(rows.map((r) => r.deletedById).filter((v): v is string => Boolean(v)))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(actors.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, deletedByName: r.deletedById ? nameById.get(r.deletedById) ?? null : null }));
}

export async function getApprovals(user: SessionUser) {
  const manager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "VALIDATE");
  // L'INTÉRIMAIRE voit les validations adressées à l'absent qu'il remplace (I18) — jamais celles de
  // ses propres demandes, que la porte de décision lui refuserait.
  const auNom = manager ? null : await auNomDeQui(user.id);
  const absents = auNom?.absents.map((a) => a.userId) ?? [];
  // ON NE TRANCHE PAS SA PROPRE DEMANDE (lot E5) — la règle de l'action (`interditSurSaPropreDemande`) : la liste
  // ne la propose plus, pour ne pas offrir un bouton que l'action refuserait (§118.83). Le sommet garde la main.
  const pasLaSienne: Prisma.AdminApprovalWhereInput = interditSurSaPropreDemande({ estDemandeur: true, sommet: isTopManagement(user) })
    ? { NOT: { request: { requesterId: user.id } } }
    : {};
  const where: Prisma.AdminApprovalWhereInput = manager
    ? { AND: [{ status: "PENDING" }, pasLaSienne] }
    : {
        AND: [
          { status: "PENDING" },
          {
            OR: [
              { validatorId: user.id },
              ...(absents.length ? [{ validatorId: { in: absents }, NOT: { request: { requesterId: user.id } } }] : []),
            ],
          },
          pasLaSienne,
        ],
      };
  const lignes = await prisma.adminApproval.findMany({
    where,
    include: { request: { select: { id: true, reference: true, title: true, type: true, fields: true } } },
    orderBy: { createdAt: "asc" },
  });
  return lignes.map((l) => ({ ...l, pourLeCompteDe: auNom?.nomDe(l.validatorId) ?? null }));
}

export async function getDriverMissions(user: SessionUser) {
  const manager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  const where: Prisma.DriverMissionWhereInput = manager ? {} : { assignedToId: user.id };
  return prisma.driverMission.findMany({
    where,
    include: {
      request: { select: { id: true, reference: true } },
      assignedTo: { select: { name: true } },
      stops: { orderBy: { position: "asc" } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

/** Pièces jointes des courses (Documents rattachés DRIVER_MISSION), groupées par mission. */
export async function getMissionAttachments(missionIds: string[]) {
  if (missionIds.length === 0) return new Map<string, { id: string; name: string; sizeBytes: number | null }[]>();
  const docs = await prisma.document.findMany({
    where: { entityType: "DRIVER_MISSION", entityId: { in: missionIds } },
    select: { id: true, name: true, sizeBytes: true, entityId: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map<string, { id: string; name: string; sizeBytes: number | null }[]>();
  for (const d of docs) {
    if (!d.entityId) continue;
    const list = map.get(d.entityId) ?? [];
    list.push({ id: d.id, name: d.name, sizeBytes: d.sizeBytes });
    map.set(d.entityId, list);
  }
  return map;
}

/**
 * QUI LIT UNE DEMANDE AU SECRÉTARIAT — la clause de la FICHE (`/demandes/[id]`), lue aussi par les gestes
 * qui s'y attachent (§118.184 — audit 360°, S12).
 *
 * Mesuré par l'audit : `addRequestComment` ne vérifiait RIEN. N'importe quel compte, avec l'identifiant
 * d'une demande, y écrivait un commentaire — et le demandeur ou la personne chargée recevait une
 * notification signée de quelqu'un qui n'avait jamais vu la demande. La fiche, elle, a toujours lu deux
 * entrées : la portée du module, et le validateur d'une PIÈCE (« on ne valide pas une facture hors de son
 * contexte » : il voit la demande entière, même hors de son périmètre). Une seule écriture de cette règle,
 * sinon le commentaire s'ouvrirait à quelqu'un que la fiche refuse — ou l'inverse (§118.5).
 */
export async function clauseDemandeLisible(user: SessionUser, requestId: string): Promise<Prisma.AdministrativeRequestWhereInput> {
  const validateurDePiece = (await prisma.validationRequest.count({
    where: { entityType: "ADMIN_REQUEST", entityId: requestId, documentId: { not: null }, steps: { some: { validatorId: user.id } } },
  })) > 0;
  // L'INTÉRIMAIRE ouvre la demande qui attend la validation de l'absent qu'il remplace (I18) : la
  // liste la lui montre, la porte de décision l'accepte — la fiche ne peut pas la lui refuser.
  const absents = await standInForUserIds(user.id);
  const base = validateurDePiece ? { deletedAt: null } : scopeAdminRequests(user);
  const interim = absents.length
    ? { deletedAt: null, NOT: { requesterId: user.id }, approvals: { some: { status: "PENDING" as const, validatorId: { in: absents } } } }
    : null;
  // Les clauses se COMPOSENT en `AND` (§118.133) : `scopeAdminRequests` rend `{ id: "__none__" }` sans le
  // module, et un étalement après `id` aurait remplacé l'identifiant visé.
  return { AND: [{ id: requestId }, interim ? { OR: [base, interim] } : base] };
}
