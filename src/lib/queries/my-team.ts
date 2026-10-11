import { prisma } from "@/lib/prisma";
import { loadReportingLine } from "@/lib/departments";
import { subtreeOf, flattenTree, type TeamTreeNode } from "@/lib/hr/team-tree";
import { toNumber } from "@/lib/utils";
import { getAppSettings } from "@/lib/settings";
import type { Module, SessionUser } from "@/lib/rbac";
import { recruitmentScope } from "@/lib/recruitment/access";
import { canDecideStep, CONTRACT_LABEL, type RecruitmentContract, type RecruitmentStage } from "@/lib/recruitment/request-flow";
import { STATUT_PLAN_LABELS, clausePlansADecider, type StatutPlan } from "@/lib/sfe/tournee";
import { lienDeLigne, type LienDeLigne } from "@/lib/queries/lien-ouvrable";
import { lienFormation } from "@/lib/chemins/formations";
import { MARCHE_N1_MISSIONS } from "@/lib/queries/missions";
import {
  aujourdhuiAlger, chevauchementsDe, couvreLeJour, jourDuConge, minuitUtc, periodesCommunes,
  type AbsenceDEquipe, type PeriodeCommune,
} from "@/lib/hr/absences";

/**
 * MON ÉQUIPE — ce qu'un encadrant a réellement besoin de voir sur ses N-1.
 *
 * ── CE QUE CET ÉCRAN N'EST PAS ──────────────────────────────────────────────────────────────
 *
 * Ce n'est pas un mini-module RH. Un encadrant n'administre pas les fiches, ne fixe pas les
 * salaires et n'ouvre pas les dossiers médicaux : cela reste aux ressources humaines, et le
 * copier ici en ferait une seconde porte sur des données qu'on a cloisonnées exprès.
 *
 * C'est l'écran de trois questions, et de trois seulement :
 *
 *   1. **QUI est dans mon équipe** — la liste, telle que la hiérarchie la définit vraiment ;
 *   2. **QU'EST-CE QUI M'ATTEND** — congés, achats, formations, plans de tournée, marches de
 *      recrutement (§118.196, lot E3 — audit 360°, M10) : ce qui dort chez moi et bloque
 *      quelqu'un. C'était éparpillé dans autant d'écrans qu'il y a de circuits, et l'on
 *      découvrait une demande de congé vieille de six jours en cherchant autre chose ;
 *   3. **QUI EST LÀ** — au JOUR d'Alger, le dernier jour d'un congé compris (M21), et les jours
 *      où deux personnes d'une même équipe manquent ensemble (M19) : c'est la seule donnée qui
 *      change un planning.
 *
 * ── L'ÉQUIPE SE DÉDUIT, ELLE NE SE DÉCLARE PAS ──────────────────────────────────────────────
 *
 * `directReportsOf` définit mon équipe comme « ceux dont la cascade dit que je suis le N+1 » —
 * la MÊME fonction qui route les demandes. Les deux ne peuvent donc pas diverger : personne
 * n'apparaît dans mon équipe sans que ses demandes m'arrivent, et réciproquement.
 *
 * ── L'ÉQUIPE DESCEND JUSQU'EN BAS ; CE QUI M'ATTEND SUIT SON CIRCUIT ────────────────────────
 *
 * Deux portées, et les confondre serait une faute dans les deux sens :
 *
 *   • **QUI EST SOUS MOI** — tout l'arbre (`subtreeOf`), N-1, N-2, jusqu'en bas. Pour un
 *     directeur, s'arrêter au premier rang, c'était quatre cartes qui cachaient quarante
 *     personnes : celles qui font le travail sont toutes au deuxième rang.
 *   • **CE QUI ATTEND MA DÉCISION** — ce que SON circuit m'adresse, et rien d'autre. Un congé,
 *     un achat, une formation s'arrêtent à la marche du N+1 : ils ne m'attendent que pour mes
 *     DIRECTS — le congé d'un N-2 est routé vers SON N+1, et le faire apparaître ici me ferait
 *     attendre une décision que je n'ai pas à prendre. Une chaîne de recrutement, elle, passe
 *     par CHAQUE échelon, et un plan de tournée escaladé monte au N+2 : ceux-là peuvent
 *     m'attendre plus bas. `TeamMember.pending` compte les lignes de la file, et rien d'autre.
 *
 * ── UNE LIGNE N'EST UN LIEN QUE SI SA PAGE S'OUVRE ──────────────────────────────────────────
 *
 * Chaque ligne mène à l'écran où l'on tranche ; la garde de cet écran est rejouée ici
 * (`lienDeLigne`). Module hors service (masqué, retiré) : la ligne ne s'affiche pas — rien ne
 * s'y tranche plus. Module non ouvert à ce compte : la ligne RESTE, sans lien, et dit qui peut
 * l'ouvrir — une décision qui attend quelqu'un ne disparaît pas en silence, et un lien vers une
 * page qui le refusera n'est pas un geste (§118.83).
 */

export interface TeamMember {
  employeeId: string;
  userId: string | null;
  fullName: string;
  /** 1 = N-1, 2 = N-2, … — le rang tel qu'un humain le compte. */
  depth: number;
  /** Son N+1 DANS MON ARBRE (null au premier rang : c'est moi). */
  managerEmployeeId: string | null;
  /** Le rôle applicatif — c'est lui qui décide QUELS indicateurs existent pour cette personne. */
  role: string | null;
  position: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  hiredAt: string | null;
  /** Fin de contrat proche — l'échéance qu'un encadrant doit anticiper, pas la RH seule. */
  contractEnd: string | null;
  /** Absent AUJOURD'HUI — au jour d'Alger, le dernier jour d'un congé accordé compris (M21). */
  absentToday: boolean;
  /** Prochaine absence accordée à venir — les DATES ; le type (maladie…) ne part plus vers le navigateur (§118.184). */
  nextLeave: { start: string; end: string } | null;
  /** Les lignes de « À décider » qui le concernent — la carte et la liste disent le même nombre (§118.51). */
  pending: number;
}

/** Une absence de la même équipe qui partage au moins un jour avec un congé à signer (M19). */
export interface ChevauchementDeConge {
  nom: string;
  /** « AAAA-MM-JJ », inclus. */
  debut: string;
  /** « AAAA-MM-JJ », inclus. */
  fin: string;
  enAttente: boolean;
}

export interface TeamPending {
  id: string;
  kind: "LEAVE" | "PURCHASE" | "TRAINING" | "RECRUITMENT" | "TOUR_PLAN" | "MISSION_ORDER";
  /** La fiche concernée — c'est elle qui porte le « N à décider » de sa carte. */
  employeeId: string | null;
  who: string;
  title: string;
  detail: string | null;
  amount: number | null;
  createdAt: string;
  /** Échéance quand le circuit en porte une (dates de congé, de formation, prise de poste). */
  deadline: string | null;
  /** L'écran où l'on tranche — PRÉSENT seulement si sa garde laisse entrer cette personne. */
  href: string | null;
  /** Pourquoi il n'y a pas de lien, et qui peut le lever. */
  sansLien: string | null;
  /** Pour un congé : les absences de la même équipe qui partagent un jour avec lui (M19). */
  chevauchements: ChevauchementDeConge[];
  /** Pour un congé : la décision depuis Mon Équipe, et la trace de la marche remontée (Direction, 06/10). */
  conge?: CongeADecider;
}

/** Un congé à décider depuis Mon Équipe : à moi ou en attente plus haut, et ce qui a été remonté / redescendu. */
export interface CongeADecider {
  leaveId: string;
  aMoi: boolean;
  attendDe: string | null;
  trace: { de: string; a: string; note: string | null; decision: "APPROVED" | "REJECTED" | null; noteDecision: string | null; le: string; decideLe: string | null }[];
}

/** Une période où deux personnes au moins d'une même équipe manquent ensemble, et le nom de cette équipe. */
export interface ChevauchementDEquipe extends PeriodeCommune {
  equipe: string;
}

export interface MyTeam {
  /** La fiche employé de l'encadrant — absente, il n'a pas d'équipe à montrer. */
  selfEmployeeId: string | null;
  /** TOUT le monde sous moi, à plat mais DANS L'ORDRE DE L'ARBRE (un chef, puis ses gens). */
  members: TeamMember[];
  /** Le nombre de N-1 directs — le premier rang, celui dont les demandes m'arrivent. */
  directCount: number;
  /** Jusqu'où descend la chaîne : 1 = personne n'encadre personne sous moi. */
  depth: number;
  pending: TeamPending[];
  /** Les absences qui se chevauchent dans une même équipe, sur les 30 prochains jours (M19). */
  chevauchements: ChevauchementDEquipe[];
  /** Ce qui n'est pas montré au-delà de la coupe — COMPTÉ, jamais tu (§118.60). */
  chevauchementsNonMontres: number;
}

/** Un mois devant soi : l'horizon d'un planning d'équipe. */
const FENETRE_CHEVAUCHEMENTS_JOURS = 30;
/** Au-delà, on compte. */
const CHEVAUCHEMENTS_MONTRES = 12;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Une équipe vide — une liste NEUVE à chaque appel, jamais un tableau partagé entre deux lecteurs. */
const vide = (selfEmployeeId: string | null): MyTeam => ({
  selfEmployeeId, members: [], directCount: 0, depth: 0, pending: [], chevauchements: [], chevauchementsNonMontres: 0,
});

/**
 * L'ÉQUIPE ET SA FILE, en une passe.
 *
 * Tout est borné à mon arbre : un encadrant ne voit ni les congés des autres services, ni les
 * demandes qu'il n'a pas à trancher. Le cloisonnement ne vient pas d'un droit de module — il
 * vient de la hiérarchie elle-même, et c'est ce qui le rend juste sans réglage. Le recrutement
 * garde en plus SA portée (`recruitmentScope`), composée en `AND` : la file ne montre rien que
 * la liste du module ne montrerait pas.
 *
 * `maintenant` s'injecte (un banc juge un jour fixe, jamais « maintenant + n heures ») ; « aujourd'hui »
 * se lit à Alger.
 */
export async function getMyTeam(user: SessionUser, opts: { maintenant?: Date } = {}): Promise<MyTeam> {
  const me = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!me) return vide(null);

  const { employees, departments } = await loadReportingLine();
  const arbre = subtreeOf(me.id, employees, departments);
  const tous = flattenTree(arbre);
  if (tous.length === 0) return vide(me.id);

  // L'ARBRE POUR MONTRER, LE PREMIER RANG POUR LES CIRCUITS QUI S'Y ARRÊTENT — deux portées, jamais confondues.
  const directs = arbre.map((n) => n.employeeId);
  const directSet = new Set(directs);

  const employeeIds = tous.map((n) => n.employeeId);
  // Les congés, achats et formations ne se lisent QUE pour mes directs : ils ne sont routés vers moi que là.
  const userIds = arbre.map((n) => n.userId).filter((v): v is string => Boolean(v));
  // Une chaîne de recrutement et un plan escaladé peuvent m'attendre à toute profondeur.
  const userIdsArbre = tous.map((n) => n.userId).filter((v): v is string => Boolean(v));
  const maintenant = opts.maintenant ?? new Date();
  // M21 — LE JOUR D'ALGER : un congé fini « le 12 » est écrit à minuit UTC ; le comparer à l'instant présent le
  // faisait finir avant l'aube du 12, et la personne redevenait présente le matin de son dernier jour d'absence.
  const aujourdhui = aujourdhuiAlger(maintenant);

  const [fiches, conges, achats, formations, recrutements, plans, reglages] = await Promise.all([
    prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true, fullName: true, userId: true, position: true, email: true, phone: true,
        hireDate: true, contractEnd: true, department: true,
        // Le RÔLE APPLICATIF, pas l'intitulé de poste : c'est lui qui dit quels indicateurs
        // existent pour cette personne (`jobOf`). Un intitulé libre obligerait à deviner.
        user: { select: { role: true } },
      },
      orderBy: { fullName: "asc" },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        OR: [
          // Accordés OU en instruction, pas encore finis À ALGER : qui est là, et ce qui se chevauche (M19).
          { status: { in: ["APPROVED", "PENDING"] }, endDate: { gte: minuitUtc(aujourdhui) } },
          // Ce qui attend MA signature, même daté du passé : une demande oubliée attend toujours.
          { status: "PENDING", stage: "MANAGER", employeeId: { in: directs } },
          // Une marche REMONTÉE jusqu'à moi (« demander à son N+1 », Direction 06/10), à toute profondeur de mon arbre.
          { status: "PENDING", stage: "MANAGER", currentApproverId: user.id },
        ],
      },
      // Pas le TYPE (maladie, maternité…) : un encadrant a besoin de savoir qui manque, pas pourquoi (§118.184).
      select: {
        id: true, employeeId: true, startDate: true, endDate: true, days: true,
        reason: true, status: true, stage: true, createdAt: true, currentApproverId: true,
        escalations: { orderBy: { order: "asc" }, select: { order: true, fromUserId: true, toUserId: true, note: true, decision: true, decisionNote: true, askedAt: true, decidedAt: true } },
      },
      orderBy: { startDate: "asc" },
    }),
    // Les demandes d'achat de mon équipe qui attendent MA validation — la MIENNE, pas une autre
    // (audit 360°, I13) : une demande passée à l'étape suivante gardait une approbation en attente
    // au nom de quelqu'un d'autre, restait listée ici, et « Traiter » menait à une page refusée.
    prisma.administrativeRequest.findMany({
      where: {
        type: "PURCHASE", deletedAt: null, requesterId: { in: userIds },
        approvals: { some: { status: "PENDING", validatorId: user.id } },
      },
      select: {
        id: true, reference: true, title: true, requesterId: true, createdAt: true, fields: true,
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    // Les demandes de formation arrêtées à la marche du responsable.
    prisma.training.findMany({
      where: { requesterId: { in: userIds }, status: "PENDING", stage: "MANAGER" },
      select: { id: true, reference: true, title: true, requesterId: true, amount: true, startDate: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    // M10 — LA MARCHE DE RECRUTEMENT QUI M'ATTEND, pour quelqu'un de mon arbre. La portée EXISTANTE du
    // recrutement est composée en `AND` (§118.133) : rien que la liste du module ne montrerait pas. Elle est
    // REDONDANTE aujourd'hui — une marche en attente qui me nomme implique `approvals.some({ approverId: moi })`,
    // et la portée vaut `{}` pour les RH et le sommet — : elle reste pour que la file ne puisse jamais montrer PLUS
    // que la liste si la portée se resserre un jour (§118.140). Pas de `take` : « je suis une marche en attente »
    // borne déjà la lecture, et une coupe suivie d'un filtre en mémoire tairait ses propres lignes (§118.60).
    prisma.recruitmentRequest.findMany({
      where: {
        AND: [
          recruitmentScope(user),
          { stage: "CHAIN" as const, requesterId: { in: userIdsArbre } },
          { approvals: { some: { approverId: user.id, status: "PENDING" as const } } },
        ],
      },
      select: {
        id: true, reference: true, position: true, headcount: true, contractType: true, requesterId: true,
        startDate: true, createdAt: true, stage: true,
        approvals: { select: { order: true, approverId: true, status: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    // LES PLANS DE TOURNÉE QUI M'ATTENDENT — la file « à décider » des plans (`clausePlansADecider`, lot E2), celle
    // de « Mon espace » et de la page du plan, bornée à mon arbre. Deux copies de la même file finiraient par ne
    // plus lister la même chose (§118.5). L'intérim n'est pas lu ici : Mon Équipe est MON arbre, et ce qui attend
    // l'absent que je remplace se lit dans « Mon espace ».
    prisma.tourPlan.findMany({
      where: { AND: [clausePlansADecider(user.id, []), { repId: { in: userIdsArbre } }] },
      select: { id: true, repId: true, status: true, periodStart: true, periodEnd: true, submittedAt: true, createdAt: true },
      orderBy: { submittedAt: "asc" },
    }),
    getAppSettings(),
  ]);

  const nomParEmploye = new Map(fiches.map((f) => [f.id, f.fullName]));
  const nomParUser = new Map(fiches.filter((f) => f.userId).map((f) => [f.userId as string, f.fullName]));
  const employeParUser = new Map(fiches.filter((f) => f.userId).map((f) => [f.userId as string, f.id]));
  // L'ÉQUIPE d'une personne, au sens des chevauchements : son N+1 dans mon arbre (null = mes N-1).
  const groupeDe = new Map(tous.map((n) => [n.employeeId, n.managerEmployeeId] as const));
  const lien = (module: Module, href: string): LienDeLigne | null =>
    lienDeLigne(user, module, href, reglages.hiddenModules);

  const absences: AbsenceDEquipe[] = conges.map((c) => ({
    leaveId: c.id,
    employeeId: c.employeeId,
    nom: nomParEmploye.get(c.employeeId) ?? "—",
    debut: jourDuConge(c.startDate),
    fin: jourDuConge(c.endDate),
    enAttente: c.status === "PENDING",
    groupe: groupeDe.get(c.employeeId) ?? null,
  }));
  const absenceDe = new Map(absences.map((a) => [a.leaveId, a]));

  // Le congé se signe dans MON ESPACE, où chaque encadrant a le bloc « Congés qui attendent votre signature » —
  // `/rh/conges` est l'écran des RH, refusé à un N+1 sans le module (I13).
  const lienConge = lien("WORKSPACE", "/mon-espace#conges-a-signer");
  // LES NOMS DE LA TRACE d'une marche remontée (qui a demandé l'avis de qui).
  const gensDesEscalades = [...new Set(conges.flatMap((c) => [c.currentApproverId, ...c.escalations.flatMap((e) => [e.fromUserId, e.toUserId])]).filter((v): v is string => Boolean(v)))];
  const nomsEscalade = new Map((gensDesEscalades.length > 0
    ? await prisma.user.findMany({ where: { id: { in: gensDesEscalades } }, select: { id: true, name: true } })
    : []).map((u) => [u.id, u.name]));
  const lignesConges: TeamPending[] = lienConge === null ? [] : conges
    .filter((c) => c.status === "PENDING" && c.stage === "MANAGER" && (directSet.has(c.employeeId) || c.currentApproverId === user.id))
    .map((c) => {
      const absence = absenceDe.get(c.id);
      return {
        id: `leave-${c.id}`,
        kind: "LEAVE" as const,
        employeeId: c.employeeId,
        who: nomParEmploye.get(c.employeeId) ?? "—",
        title: `Congé — ${toNumber(c.days)} jour(s)`,
        detail: c.reason,
        amount: null,
        createdAt: c.createdAt.toISOString(),
        deadline: c.startDate.toISOString(),
        ...lienConge,
        conge: {
          leaveId: c.id,
          // Je tranche si la marche est à moi : remontée jusqu'à moi, ou jamais remontée (je suis le N+1).
          aMoi: c.currentApproverId ? c.currentApproverId === user.id : true,
          attendDe: c.currentApproverId && c.currentApproverId !== user.id ? nomsEscalade.get(c.currentApproverId) ?? "—" : null,
          trace: c.escalations.map((e) => ({
            de: nomsEscalade.get(e.fromUserId) ?? "—", a: nomsEscalade.get(e.toUserId) ?? "—", note: e.note,
            decision: e.decision === "APPROVED" || e.decision === "REJECTED" ? e.decision : null, noteDecision: e.decisionNote,
            le: e.askedAt.toISOString(), decideLe: e.decidedAt?.toISOString() ?? null,
          })),
        },
        // M19 — CE QUI MANQUERA EN MÊME TEMPS dans la même équipe : la question qu'on se pose avant de signer.
        chevauchements: absence
          ? chevauchementsDe(absence, absences).map((a) => ({ nom: a.nom, debut: a.debut, fin: a.fin, enAttente: a.enAttente }))
          : [],
      };
    });

  const lignesAchats: TeamPending[] = achats.flatMap((a) => {
    const l = lien("ADMIN_REQUESTS", `/demandes/${a.id}`);
    if (!l) return [];
    const champs = (a.fields as Record<string, unknown> | null) ?? {};
    return [{
      id: `purchase-${a.id}`,
      kind: "PURCHASE" as const,
      employeeId: employeParUser.get(a.requesterId ?? "") ?? null,
      who: nomParUser.get(a.requesterId ?? "") ?? "—",
      title: a.title,
      detail: a.reference,
      amount: typeof champs.estimatedTotal === "number" ? champs.estimatedTotal : null,
      createdAt: a.createdAt.toISOString(),
      deadline: null,
      ...l,
      chevauchements: [],
    }];
  });

  // `/formations` n'a d'autre garde que la session : son lien s'ouvre pour qui a ouvert cet écran.
  const lignesFormations: TeamPending[] = formations.map((f) => ({
    id: `training-${f.id}`,
    kind: "TRAINING" as const,
    employeeId: employeParUser.get(f.requesterId ?? "") ?? null,
    who: nomParUser.get(f.requesterId ?? "") ?? "—",
    title: f.title,
    detail: f.reference,
    amount: toNumber(f.amount) || null,
    createdAt: f.createdAt.toISOString(),
    deadline: iso(f.startDate),
    // La ligne de CETTE formation, dépliée (`?formation=`), pas la liste de toutes.
    href: lienFormation(f.id),
    sansLien: null,
    chevauchements: [],
  }));

  const lignesRecrutement: TeamPending[] = recrutements
    // MON TOUR, et seulement le mien — la règle de la fiche (`canDecideStep`) SANS la dérogation du sommet : le
    // PDG PEUT trancher à toute marche, mais une marche ne l'ATTEND que quand c'est la sienne.
    .filter((r) => canDecideStep(r.stage as RecruitmentStage, r.approvals, { userId: user.id, isTop: false }).ok)
    .flatMap((r) => {
      const l = lien("RECRUITMENT", `/recrutement/${r.id}`);
      if (!l) return [];
      const marche = [...r.approvals].sort((a, b) => a.order - b.order).find((a) => a.status === "PENDING");
      const contrat = CONTRACT_LABEL[r.contractType as RecruitmentContract] ?? r.contractType;
      return [{
        id: `recruitment-${r.id}`,
        kind: "RECRUITMENT" as const,
        employeeId: employeParUser.get(r.requesterId) ?? null,
        who: nomParUser.get(r.requesterId) ?? "—",
        title: `${r.position} — ${r.headcount} poste(s), ${contrat}`,
        detail: `${r.reference}${marche ? ` · marche ${marche.order}/${r.approvals.length}` : ""}`,
        amount: null,
        createdAt: r.createdAt.toISOString(),
        deadline: iso(r.startDate),
        ...l,
        chevauchements: [],
      }];
    });

  const lignesPlans: TeamPending[] = plans.flatMap((p) => {
    const l = lien("MEDICAL", `/medical/plan-de-tournee?plan=${p.id}`);
    if (!l) return [];
    return [{
      id: `tourplan-${p.id}`,
      kind: "TOUR_PLAN" as const,
      employeeId: employeParUser.get(p.repId) ?? null,
      who: nomParUser.get(p.repId) ?? "—",
      // La MÊME lecture des dates que la page du plan (`toLocaleDateString("fr-FR")`) — une seule façon de les dire.
      title: `Plan de tournée du ${p.periodStart.toLocaleDateString("fr-FR")} au ${p.periodEnd.toLocaleDateString("fr-FR")}`,
      detail: STATUT_PLAN_LABELS[p.status as StatutPlan] ?? p.status,
      amount: null,
      createdAt: (p.submittedAt ?? p.createdAt).toISOString(),
      deadline: null,
      ...l,
      chevauchements: [],
    }];
  });

  // LES ORDRES DE MISSION À VALIDER (missions Ad & Pro, 10/2026) — la marche du N+1 avant les RH, adressée à MOI.
  // Ils se tranchent dans « Mon espace › Mes missions », où la ligne porte les boutons.
  const ordresOm = await prisma.hrDocumentRequest.findMany({
    // + les notes de frais des missions de l'équipe (clôture), même marche N+1 (Direction, 10/2026).
    where: MARCHE_N1_MISSIONS(user.id),
    // La NATURE se lit au mois de la note de frais, pas au `type` (confidentialité RH : le type ne se lit pas ici).
    select: { id: true, expenseMonth: true, expenseAmount: true, employeeId: true, details: true, createdAt: true, omPrefill: true, employee: { select: { fullName: true } } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const lienOm = lien("WORKSPACE", "/mon-espace/missions#a-valider");
  const lignesOm: TeamPending[] = lienOm === null ? [] : ordresOm.map((o) => {
    const depart = (o.omPrefill as { datesDepart?: unknown } | null)?.datesDepart;
    const premier = Array.isArray(depart) && typeof depart[0] === "string" ? new Date(depart[0]).toISOString() : null;
    return {
      id: `mission-order-${o.id}`,
      kind: "MISSION_ORDER" as const,
      employeeId: o.employeeId,
      who: o.employee.fullName,
      title: o.expenseMonth ? "Note de frais de mission" : "Ordre de mission",
      detail: o.details,
      amount: o.expenseMonth && o.expenseAmount != null ? Number(o.expenseAmount) : null,
      createdAt: o.createdAt.toISOString(),
      deadline: premier,
      ...lienOm,
      chevauchements: [],
    };
  });

  // La plus ANCIENNE en tête : c'est elle qui fait attendre quelqu'un depuis le plus longtemps.
  const pending = [...lignesConges, ...lignesAchats, ...lignesFormations, ...lignesRecrutement, ...lignesPlans, ...lignesOm]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // LA CARTE COMPTE LES LIGNES DE LA FILE, et rien d'autre (§118.51) : un congé, un achat, une formation ne
  // m'attendent que pour mes directs (leur requête le borne) ; une marche de recrutement ou un plan escaladé
  // peuvent m'attendre plus bas, et la carte de la personne concernée le dit.
  const aDeciderPar = new Map<string, number>();
  for (const p of pending) if (p.employeeId) aDeciderPar.set(p.employeeId, (aDeciderPar.get(p.employeeId) ?? 0) + 1);

  const parEmploye = new Map(fiches.map((f) => [f.id, f]));

  // L'ORDRE EST CELUI DE L'ARBRE, pas l'ordre alphabétique : un chef, puis ses gens, puis le
  // chef suivant. C'est ce qui permet à la page de dessiner la hiérarchie avec une simple
  // indentation, sans refaire la descente — et c'est le seul ordre qui répond à la question
  // que l'écran sert : « par qui passe-t-on pour lui parler ? »
  const members: TeamMember[] = tous.flatMap((n: TeamTreeNode) => {
    const f = parEmploye.get(n.employeeId);
    // Une fiche désactivée entre deux lectures : on la saute plutôt que d'inventer une ligne.
    if (!f) return [];
    // Les absences ACCORDÉES, déjà triées par premier jour (la requête l'ordonne).
    const siennes = absences.filter((a) => !a.enAttente && a.employeeId === f.id);
    const enCours = siennes.find((a) => couvreLeJour(a, aujourdhui));
    const aVenir = siennes.find((a) => a.debut > aujourdhui);
    return [{
      employeeId: f.id,
      userId: f.userId,
      fullName: f.fullName,
      depth: n.depth,
      managerEmployeeId: n.managerEmployeeId,
      role: f.user?.role ?? null,
      position: f.position,
      department: f.department,
      email: f.email,
      phone: f.phone,
      hiredAt: iso(f.hireDate),
      contractEnd: iso(f.contractEnd),
      absentToday: Boolean(enCours),
      nextLeave: aVenir ? { start: minuitUtc(aVenir.debut).toISOString(), end: minuitUtc(aVenir.fin).toISOString() } : null,
      pending: aDeciderPar.get(f.id) ?? 0,
    }];
  });

  // M19 — LES JOURS OÙ UNE ÉQUIPE MANQUE DE DEUX PERSONNES À LA FOIS, sur un mois devant soi. Une équipe est
  // nommée par son chef dans mon arbre ; mes propres N-1 forment la mienne.
  const nomDeLEquipe = (groupe: string | null) => (groupe === null ? "Vos N-1" : `Équipe de ${nomParEmploye.get(groupe) ?? "—"}`);
  const toutes = periodesCommunes(absences, aujourdhui, FENETRE_CHEVAUCHEMENTS_JOURS)
    .map((p) => ({ ...p, equipe: nomDeLEquipe(p.groupe) }));
  const chevauchements = toutes.slice(0, CHEVAUCHEMENTS_MONTRES);

  const depth = members.reduce((max, m) => Math.max(max, m.depth), 0);
  return {
    selfEmployeeId: me.id,
    members,
    directCount: arbre.length,
    depth,
    pending,
    chevauchements,
    chevauchementsNonMontres: toutes.length - chevauchements.length,
  };
}
