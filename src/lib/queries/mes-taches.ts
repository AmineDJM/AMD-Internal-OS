import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasGlobalView, userCan, type Module, type SessionUser } from "@/lib/rbac";
import { MODULE_LABELS, NAVIGATION, WORKSPACE_TABS } from "@/lib/labels";
import { visibleTabs } from "@/lib/nav-tabs";
import { sourceCaption, sourceHref, sourceLabel } from "@/lib/links/source-link";
import {
  canAttach, canComment, canDoWork, canRespond, clauseTachesVisibles, isRequest, peutRelancer,
  refusAnnulationDemande, relanceOuverte, STATUTS_REATTRIBUABLES,
} from "@/lib/tasks/request-flow";
import {
  A_VERIFIER_JOURS, REFUS_VISIBLE_JOURS, TERMINEES_JOURS, TERMINEES_PAR_PAGE, ONGLET_TACHES_HREF,
  compteOnglet, compterVues, deQui, echeanceLisible, etatChezQui, etatCourt, etatDemande, nomCourt,
  rangerTache, trierParEcheance,
  type CompteursTaches, type GesteDemande, type TonEcheance, type TonEtat, type VueTaches,
} from "@/lib/tasks/onglet-taches";
import type { ModuleTab } from "@/components/shared/module-tabs";
import type { TaskCommentItem } from "@/app/(app)/mon-espace/taches/[id]/comments";
import type { DocItem } from "@/components/documents/document-list";
import { invitationsMissionAAccepter, ordresMissionAValider, MARCHE_N1_MISSIONS, type InvitationMissionDTO, type OrdreAValiderDTO } from "@/lib/queries/missions";

/**
 * L'ONGLET « TÂCHES » DE MON ESPACE — la lecture (Direction, 07/10).
 *
 * Une lecture des tâches OUVERTES de la personne (son cercle : `clauseTachesVisibles`, la même que la
 * fiche et la recherche), rangée par la règle pure `rangerTache` ; « Terminées » se lit à part, paginée.
 * Chaque ligne porte ses DROITS calculés ici, avec les règles de `request-flow.ts` que les actions
 * rejouent : un bouton ne décide de rien, mais il ne propose pas ce que l'action refuserait.
 */

const OUVERTS = ["REQUESTED", "TODO", "IN_PROGRESS"] as const;
const JOUR_MS = 86_400_000;

export interface LigneTache {
  id: string;
  titre: string;
  description: string | null;
  status: string;
  priorite: string;
  echeance: string | null;
  echeanceTexte: string;
  echeanceTon: TonEcheance;
  termineeLe: string | null;
  /** « Automatique », « moi », « Brahim R. » — et le nom entier pour le panneau. */
  de: string;
  deNom: string | null;
  /** Chez qui (le responsable), court et entier. */
  a: string;
  aNom: string | null;
  /** La petite ligne sous le titre : l'objet source, l'état. */
  contexte: string | null;
  ou: { libelle: string; href: string | null } | null;
  etatChezQui: string;
  etat: { libelle: string; ton: TonEtat; geste: GesteDemande };
  commentaires: number;
  cercle: string | null;
  adresse: string | null;
  compteRendu: string | null;
  estDemande: boolean;
  // ── Les droits de la personne qui regarde ──
  peutCocher: boolean;
  peutRouvrir: boolean;
  peutRepondre: boolean;
  peutTravailler: boolean;
  peutJoindre: boolean;
  peutCommenter: boolean;
  peutDemarrer: boolean;
  peutAnnuler: boolean;
  peutSupprimer: boolean;
  peutReattribuer: boolean;
  relance: { ok: boolean; raison: string | null; rang: number } | null;
}

export interface DetailTache { fil: TaskCommentItem[]; pieces: DocItem[] }

/**
 * CE QUI ATTEND MA RÉPONSE SANS ÊTRE UNE TÂCHE — rangé sous « À accepter » avec les demandes de tâches, mais
 * d'un TYPE À PART (jamais un `Task` déguisé : ni échéance, ni fil, ni panneau de travail, et la réponse passe par
 * les actions des missions, pas par `respondTaskRequest`). Deux sortes : l'invitation à une mission
 * (Je confirme / Je décline) et l'ordre de mission de mon équipe à valider comme N+1 (Valider / Refuser).
 * Mes missions les montre toujours ; ici elles ne sont qu'un second chemin vers le même geste.
 */
export type LigneMissionAAccepter =
  | { type: "INVITATION_MISSION"; cle: string; invitation: InvitationMissionDTO }
  | { type: "ORDRE_MISSION_N1"; cle: string; ordre: OrdreAValiderDTO };

export interface OngletTaches {
  vue: VueTaches;
  aAccepter: LigneTache[];
  /** Invitations à une mission et ordres de mission à valider (N+1) — des lignes typées, distinctes des tâches. */
  aAccepterMissions: LigneMissionAAccepter[];
  lignes: LigneTache[];
  compteurs: CompteursTaches;
  compteOnglet: number;
  details: Record<string, DetailTache>;
  pagination: { page: number; pages: number; total: number } | null;
  personnes: { id: string; name: string }[];
}

const inclure = {
  createdBy: { select: { name: true } },
  assignedTo: { select: { name: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskInclude;
type TacheLue = Prisma.TaskGetPayload<{ include: typeof inclure }>;

/** La page d'un module, quand la personne peut l'ouvrir — sinon pas de lien (une porte fermée n'est pas un lien). */
function lienModule(user: SessionUser, m: string | null): { libelle: string; href: string | null } | null {
  if (!m) return null;
  const connu = m in MODULE_LABELS;
  const libelle = connu ? MODULE_LABELS[m as Module] : m;
  if (!connu || !userCan(user, m as Module, "VIEW")) return { libelle, href: null };
  return { libelle, href: NAVIGATION.find((n) => n.module === m)?.href ?? null };
}

function enLigne(t: TacheLue, user: SessionUser, now: Date, noms: Map<string, string>, vue: VueTaches | "a-accepter"): LigneTache {
  const me = user.id;
  const global = hasGlobalView(user.role);
  const demande = isRequest(t);
  const close = t.status === "DONE" || t.status === "CANCELLED" || t.status === "DECLINED";
  const ech = echeanceLisible(t.dueDate, now, close);
  const travaille = canDoWork(t, me);
  const source = t.relatedEntityType ? { libelle: sourceLabel(t.relatedEntityType), href: sourceHref(t.relatedEntityType, t.relatedEntityId) } : null;
  const module = lienModule(user, t.module);
  const ou = module ? { libelle: module.libelle, href: source?.href ?? module.href } : source;
  const chezQui = etatChezQui(t, me, { assigne: t.assignedTo?.name, createur: t.createdBy?.name });
  const contexte = vue === "partagees"
    ? chezQui
    : [sourceCaption(t.relatedEntityType), t.status !== "TODO" && t.status !== "REQUESTED" ? etatCourt(t.status) : null]
      .filter(Boolean).join(" · ") || null;
  const cercleNoms = (ids: string[]) => ids.map((id) => noms.get(id)).filter((n): n is string => Boolean(n));
  const p = cercleNoms(t.participantIds), r = cercleNoms(t.readerIds);
  const cercle = [p.length ? `Participants : ${p.join(", ")}` : null, r.length ? `Lecture : ${r.join(", ")}` : null].filter(Boolean).join(" · ") || null;
  const demandeur = t.createdById === me && Boolean(t.assignedToId) && t.assignedToId !== me;
  const verdict = demandeur && relanceOuverte(t) ? peutRelancer(t, me, now.getTime()) : null;
  const annulable = refusAnnulationDemande(t, me) === null;
  return {
    id: t.id,
    titre: t.title,
    description: t.description,
    status: t.status,
    priorite: t.priority,
    echeance: t.dueDate ? t.dueDate.toISOString() : null,
    echeanceTexte: ech.texte,
    echeanceTon: ech.ton,
    termineeLe: t.status === "DONE" ? (t.completedAt ?? t.updatedAt).toISOString() : t.status === "CANCELLED" ? t.updatedAt.toISOString() : null,
    de: deQui(t, me, t.createdBy?.name),
    deNom: t.createdBy?.name ?? null,
    a: !t.assignedToId ? "—" : t.assignedToId === me ? "moi" : nomCourt(t.assignedTo?.name),
    aNom: t.assignedTo?.name ?? null,
    contexte,
    ou,
    etatChezQui: chezQui,
    etat: etatDemande(t, now),
    commentaires: t._count.comments,
    cercle,
    adresse: t.address,
    compteRendu: t.completionNote,
    estDemande: demande,
    peutCocher: travaille && (t.status === "TODO" || t.status === "IN_PROGRESS"),
    peutRouvrir: travaille && t.status === "DONE",
    peutRepondre: canRespond(t, me),
    peutTravailler: travaille,
    peutJoindre: canAttach(t, me),
    peutCommenter: canComment(t, me, global),
    peutDemarrer: travaille && !demande && t.status === "TODO",
    peutAnnuler: annulable,
    peutSupprimer: user.role === "SUPER_ADMIN" || (t.createdById === me && !annulable),
    peutReattribuer: demandeur && (STATUTS_REATTRIBUABLES as readonly string[]).includes(t.status),
    relance: verdict ? { ok: verdict.ok, raison: verdict.ok ? null : verdict.raison, rang: t.nudgeCount ?? 0 } : null,
  };
}

/** Le fil et les pièces des lignes affichées — préchargés : le panneau s'ouvre sans attendre. */
async function lireDetails(ids: string[], me: string): Promise<Record<string, DetailTache>> {
  if (ids.length === 0) return {};
  const [comments, docs] = await Promise.all([
    prisma.taskComment.findMany({
      where: { taskId: { in: ids } },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
      take: 3000,
    }),
    prisma.document.findMany({
      where: { entityType: "TASK", entityId: { in: ids } },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
  ]);
  const out: Record<string, DetailTache> = Object.fromEntries(ids.map((id) => [id, { fil: [], pieces: [] }]));
  for (const c of comments) {
    out[c.taskId]?.fil.push({
      id: c.id, author: c.author?.name ?? "Compte supprimé", body: c.body,
      createdAt: c.createdAt.toISOString(), mine: c.authorId === me,
    });
  }
  for (const d of docs) {
    out[d.entityId]?.pieces.push({
      id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
      confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
      createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
    });
  }
  return out;
}

/**
 * CE QUI M'ATTEND — le chiffre de l'onglet : à accepter + à faire. Même périmètre que `rangerTache`
 * (« a-accepter » + « a-faire ») ; un test rejoue les deux sur le même décor.
 */
export function clauseQuiMAttendent(userId: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { assignedToId: userId, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } },
      { assignedToId: null, createdById: userId, status: { in: ["TODO", "IN_PROGRESS"] } },
    ],
  };
}

export async function compteTachesQuiMAttendent(userId: string): Promise<number> {
  return prisma.task.count({ where: clauseQuiMAttendent(userId) });
}

/** Les onglets de « Mon espace », l'onglet « Tâches » portant son compteur. */
export async function ongletsEspace(user: SessionUser, compte?: number): Promise<ModuleTab[]> {
  const [tabs, n, missions] = await Promise.all([
    visibleTabs(user, WORKSPACE_TABS),
    compte ?? compteTachesQuiMAttendent(user.id).catch(() => 0),
    // « Mes missions » compte ce qui attend un geste : mes invitations et les ordres de mission à valider (N+1).
    Promise.all([
      prisma.missionAssignment.count({ where: { userId: user.id, archivedAt: null, response: "INVITEE" } }),
      prisma.hrDocumentRequest.count({ where: MARCHE_N1_MISSIONS(user.id) }),
    ]).then(([a, b]) => a + b).catch(() => 0),
  ]);
  return tabs.map((t) => (t.href === ONGLET_TACHES_HREF ? { ...t, compte: n } : t.href === "/mon-espace/missions" && missions > 0 ? { ...t, compte: missions } : t));
}

/** Les tâches terminées de la personne : faites, ou annulées, depuis 30 jours — hors « à vérifier ». */
export function clauseTerminees(userId: string, now: Date): Prisma.TaskWhereInput {
  const depuis = new Date(now.getTime() - TERMINEES_JOURS * JOUR_MS);
  return {
    AND: [
      { OR: [{ assignedToId: userId }, { createdById: userId }, { participantIds: { has: userId } }] },
      { OR: [{ status: "DONE", completedAt: { gte: depuis } }, { status: "CANCELLED", updatedAt: { gte: depuis } }] },
      // Une demande rendue reste « à vérifier » dans « Demandées » une semaine : elle n'est pas deux fois à l'écran.
      { NOT: { createdById: userId, assignedToId: { not: userId }, status: "DONE", requestedAt: { not: null }, completedAt: { gte: new Date(now.getTime() - A_VERIFIER_JOURS * JOUR_MS) } } },
    ],
  };
}

export async function lireOngletTaches(user: SessionUser, vue: VueTaches, page = 1): Promise<OngletTaches> {
  const now = new Date();
  const me = user.id;
  const refusDepuis = new Date(now.getTime() - REFUS_VISIBLE_JOURS * JOUR_MS);
  const verifDepuis = new Date(now.getTime() - A_VERIFIER_JOURS * JOUR_MS);

  const [ouvertes, personnes, invitations, ordresN1] = await Promise.all([
    prisma.task.findMany({
      where: {
        AND: [
          clauseTachesVisibles(me, false),
          {
            OR: [
              { status: { in: [...OUVERTS] } },
              { status: "DECLINED", createdById: me, OR: [{ respondedAt: { gte: refusDepuis } }, { respondedAt: null, updatedAt: { gte: refusDepuis } }] },
              { status: "DONE", createdById: me, completedAt: { gte: verifDepuis } },
            ],
          },
        ],
      },
      include: inclure,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: 400,
    }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Une lecture manquée des missions ne doit pas vider l'onglet des tâches : elles restent sur « Mes missions ».
    invitationsMissionAAccepter(me).catch(() => [] as InvitationMissionDTO[]),
    ordresMissionAValider(me).catch(() => [] as OrdreAValiderDTO[]),
  ]);
  const aAccepterMissions: LigneMissionAAccepter[] = [
    ...ordresN1.map((ordre): LigneMissionAAccepter => ({ type: "ORDRE_MISSION_N1", cle: `om-${ordre.requestId}`, ordre })),
    ...invitations.map((invitation): LigneMissionAAccepter => ({ type: "INVITATION_MISSION", cle: `inv-${invitation.id}`, invitation })),
  ];
  const noms = new Map(personnes.map((p) => [p.id, p.name]));

  const ranges = ouvertes.map((t) => ({ t, r: rangerTache(t, me, now.getTime()) }));
  const compteurs = compterVues(ouvertes, me, now.getTime());
  const aAccepter = trierParEcheance(ranges.filter((x) => x.r === "a-accepter").map((x) => x.t)).map((t) => enLigne(t, user, now, noms, "a-accepter"));

  let lignes: LigneTache[];
  let pagination: OngletTaches["pagination"] = null;
  if (vue === "terminees") {
    const where = clauseTerminees(me, now);
    const total = await prisma.task.count({ where });
    const pages = Math.max(1, Math.ceil(total / TERMINEES_PAR_PAGE));
    const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    const faites = await prisma.task.findMany({
      where, include: inclure, orderBy: [{ updatedAt: "desc" }],
      skip: (p - 1) * TERMINEES_PAR_PAGE, take: TERMINEES_PAR_PAGE,
    });
    lignes = faites.map((t) => enLigne(t, user, now, noms, vue));
    pagination = { page: p, pages, total };
  } else {
    lignes = trierParEcheance(ranges.filter((x) => x.r === vue).map((x) => x.t)).map((t) => enLigne(t, user, now, noms, vue));
  }

  const details = await lireDetails([...aAccepter, ...lignes].map((l) => l.id), me);
  return {
    vue, aAccepter, aAccepterMissions, lignes, compteurs, compteOnglet: compteOnglet(compteurs), details, pagination,
    personnes: personnes.filter((p) => p.id !== me),
  };
}
