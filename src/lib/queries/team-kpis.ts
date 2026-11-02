import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { clausePanelDuKam, hasGlobalView, regulatoryLockWhere, type Module, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { entitePermisePourFiche } from "@/lib/company";
import {
  managementChainOf, type DepartmentNodeLite, type EmployeeNode, avecLiens, commonKpis, jobKpis, jobOf,
  JOB_LABEL, NO_JOB_KPI_NOTE, type CommonCounts, type JobCounts, type LiensKpi, type TeamJob, type TeamKpi,
} from "@/modules/rh/partage";
import { accesAuPlan, type StatutPlan } from "@/lib/sfe/tournee";
import { peutOuvrirModule } from "@/lib/queries/lien-ouvrable";

/**
 * LES INDICATEURS D'UNE PERSONNE DE MON ÉQUIPE — chargés À LA DEMANDE, quand on ouvre sa carte.
 *
 * ── POURQUOI PAS AVEC LA LISTE ──────────────────────────────────────────────────────────────
 *
 * Un directeur peut avoir quarante personnes sous lui. Calculer sept compteurs pour chacune à
 * l'ouverture de l'écran, ce sont plusieurs centaines d'agrégats pour trois cartes qu'on
 * dépliera — et une page qui met dix secondes à s'afficher n'est plus consultée. On charge donc
 * au clic, ce qui est aussi la formulation de la demande : « en cliquant sur chacun, quelques
 * KPI doivent en sortir ».
 *
 * ── LE DROIT, ET IL NE VIENT PAS D'UN MODULE ────────────────────────────────────────────────
 *
 * Le contrôle d'accès de ces chiffres est la HIÉRARCHIE elle-même : je vois les indicateurs de
 * qui est sous moi, à n'importe quelle profondeur, et de personne d'autre. C'est l'action
 * serveur qui le vérifie (`teamMemberKpis`), depuis le même arbre que celui de l'écran — pas
 * l'écran, qui ne fait que ne pas proposer ce qui serait refusé (§118-7).
 *
 * ── LE CADENAS ET LES LIENS VIENNENT DE CELUI QUI REGARDE (§118.196, lot E3) ────────────────
 *
 * La hiérarchie dit QUI l'on peut regarder ; elle ne dit pas ce que l'on peut voir de plus que
 * ce que l'on voit ailleurs. Deux choses dépendent donc du lecteur, et de lui seul :
 *  · le CADENAS Regulatory (`regulatoryLockWhere`) — un dossier verrouillé au pipeline ne se
 *    compte que pour qui voit le pipeline : le NOMBRE dirait à un N+1 qu'il existe, ce que la
 *    liste Regulatory lui tait (§118.71 : la porte d'à côté) ;
 *  · les LIENS (audit 360°, M12) — un chiffre ne mène à un écran que si cet écran montre
 *    exactement ce qu'il compte, pour cette personne, et si SA garde laisse entrer le lecteur.
 * Sans lecteur, aucun lien et le cadenas FERMÉ : c'est le sens sûr pour un appelant qui
 * oublierait de dire qui regarde.
 */

/** QUI REGARDE — l'organigramme déjà chargé par l'action : la page du plan lit la chaîne du KAM, on la lit sur le même. */
export interface LecteurDesKpis {
  user: SessionUser;
  employees: readonly EmployeeNode[];
  departments: readonly DepartmentNodeLite[];
}

export interface TeamMemberKpis {
  employeeId: string;
  fullName: string;
  job: TeamJob;
  jobLabel: string;
  /** Charge et disponibilité — les mêmes pour tout le monde. */
  common: TeamKpi[];
  /** Ce que dit son métier. Vide quand il n'a pas de compteur propre : `note` l'explique. */
  job_: TeamKpi[];
  note: string | null;
}

const JOURS_30 = 30 * 24 * 60 * 60 * 1000;

export async function getTeamMemberKpis(
  employeeId: string,
  fullName: string,
  userId: string | null,
  role: string | null,
  lecteur?: LecteurDesKpis,
): Promise<TeamMemberKpis> {
  const job = jobOf(role);
  const now = new Date();
  const depuis30 = new Date(now.getTime() - JOURS_30);
  const debutAnnee = new Date(now.getFullYear(), 0, 1);
  // LE CADENAS PASSE AVANT LA HIÉRARCHIE (§118.80) : sans lecteur connu, il reste fermé.
  const verrou = regulatoryLockWhere(lecteur?.user ?? null);

  const [common, job_, liens] = await Promise.all([
    commonCountsOf(employeeId, userId, now, debutAnnee).then(commonKpis),
    jobCountsOf(job, userId, now, depuis30, verrou).then(jobKpis),
    lecteur ? liensDesKpis(lecteur, { employeeId, userId, job }) : Promise.resolve<LiensKpi>({}),
  ]);

  return {
    employeeId,
    fullName,
    job,
    jobLabel: JOB_LABEL[job],
    common: avecLiens(common, liens),
    job_: avecLiens(job_, liens),
    note: job_.length === 0 ? NO_JOB_KPI_NOTE : null,
  };
}

/**
 * LES CHIFFRES QUI ONT UN ÉCRAN (audit 360°, M12) — un lien n'existe que si l'écran montre EXACTEMENT ce que le
 * chiffre compte pour CETTE personne, et que SA garde laisse entrer celui qui regarde. Deux le peuvent aujourd'hui :
 *  · « Congés pris cette année » → la fiche du salarié, qui liste ses congés ; portes : le module RH, puis la
 *    société de la fiche (`entitePermisePourFiche`, §118.184) ;
 *  · « Médecins au portefeuille » → le plan de tournée du KAM, qui rend son panel par la MÊME clause
 *    (`loadPanelPlanifiable` → `clausePanelDuKam`, §118.179) ; portes : le module MEDICAL, puis `accesAuPlan`.
 * Les autres n'ont aucun écran par personne — les tâches d'un collaborateur (décision de la Direction, D1), les
 * dossiers et les déclarations (listes sans filtre par personne), les visites (plus de liste) : un chiffre sans lien
 * ne promet pas de geste qu'il n'a pas.
 */
async function liensDesKpis(l: LecteurDesKpis, c: { employeeId: string; userId: string | null; job: TeamJob }): Promise<LiensKpi> {
  const { hiddenModules } = await getAppSettings();
  const ouvre = (m: Module) => peutOuvrirModule(l.user, m, hiddenModules);
  const liens: LiensKpi = {};
  const [fiche, plan] = await Promise.all([
    ouvre("RH") ? prisma.employee.findUnique({ where: { id: c.employeeId }, select: { companyId: true } }) : null,
    c.job === "FIELD" && c.userId && ouvre("MEDICAL")
      ? prisma.tourPlan.findFirst({
          where: { repId: c.userId },
          orderBy: { periodStart: "desc" },
          select: { id: true, repId: true, reviewerId: true, escalatedToId: true, status: true },
        })
      : null,
  ]);
  if (fiche && (await entitePermisePourFiche(l.user.id, fiche.companyId))) liens.leaveDaysThisYear = `/rh/${c.employeeId}`;
  if (plan) {
    // LA RÈGLE DE LA PAGE (`accesAuPlan`), la chaîne du KAM lue sur l'organigramme déjà chargé — la même cascade que
    // `isManagerOfUser`, que la page appelle. L'intérim (`agitPour`) ne sert qu'à DÉCIDER : seul `voir` est lu ici.
    const chaineDuKam = managementChainOf(c.employeeId, l.employees, l.departments)
      .map((m) => m.userId)
      .filter((id): id is string => id != null);
    const acces = accesAuPlan({
      userId: l.user.id, vueGlobale: hasGlobalView(l.user), repId: plan.repId,
      reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan,
      chaineDuKam, agitPour: [],
    });
    if (acces.voir) liens.doctors = `/medical/plan-de-tournee?plan=${plan.id}`;
  }
  return liens;
}

/**
 * CE QUE PORTE N'IMPORTE QUI — charge de travail et instruction en cours.
 *
 * Sans compte utilisateur, une personne n'a ni tâche ni demande : seuls ses congés existent,
 * parce qu'ils se saisissent depuis sa FICHE. On rend donc des zéros honnêtes plutôt que de
 * masquer le bloc — un bloc absent se lit comme une panne.
 */
async function commonCountsOf(
  employeeId: string,
  userId: string | null,
  now: Date,
  debutAnnee: Date,
): Promise<CommonCounts> {
  const [taches, enRetard, congesPris, congesEnCours, formations, achats] = await Promise.all([
    userId
      ? prisma.task.count({ where: { assignedToId: userId, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } } })
      : 0,
    userId
      ? prisma.task.count({ where: { assignedToId: userId, status: { in: ["TODO", "IN_PROGRESS"] }, dueDate: { lt: now } } })
      : 0,
    prisma.leaveRequest.aggregate({
      where: { employeeId, status: "APPROVED", startDate: { gte: debutAnnee } },
      _sum: { days: true },
    }),
    prisma.leaveRequest.count({ where: { employeeId, status: "PENDING" } }),
    userId ? prisma.training.count({ where: { requesterId: userId, status: "PENDING" } }) : 0,
    userId
      ? prisma.administrativeRequest.count({
          where: { type: "PURCHASE", deletedAt: null, requesterId: userId, approvals: { some: { status: "PENDING" } } },
        })
      : 0,
  ]);

  return {
    openTasks: taches,
    overdueTasks: enRetard,
    leaveDaysThisYear: toNumber(congesPris._sum.days) || 0,
    openRequests: congesEnCours + formations + achats,
  };
}

/** Les compteurs du MÉTIER. Tous s'appuient sur le compte utilisateur : sans lui, rien à compter. */
async function jobCountsOf(
  job: TeamJob,
  userId: string | null,
  now: Date,
  depuis30: Date,
  verrou: Prisma.RegulatoryProductWhereInput,
): Promise<JobCounts> {
  if (!userId || job === "GENERIC") return { job: "GENERIC" };

  switch (job) {
    case "FIELD": {
      const [visitsDone30, visitsPlanned, doctors, visitsWithoutReport] = await Promise.all([
        prisma.medicalVisit.count({ where: { delegateId: userId, status: "COMPLETED", date: { gte: depuis30 } } }),
        prisma.medicalVisit.count({ where: { delegateId: userId, status: "PLANNED", date: { gte: now } } }),
        // « Médecins au portefeuille » : SON PANEL, secteur ∪ rattachement (§118.179).
        prisma.medicalDoctor.count({ where: clausePanelDuKam(userId) }),
        // « RÉALISÉE MAIS RIEN D'ÉCRIT » — une visite faite dont il ne reste rien pour celui
        // qui reprendra le médecin. Borné aux 30 derniers jours comme les visites elles-mêmes :
        // un compte rendu de l'an dernier ne se rattrape plus, et le compter ferait un chiffre
        // qui ne baisse jamais, donc un chiffre qu'on cesse de regarder.
        prisma.medicalVisit.count({
          where: {
            delegateId: userId, status: "COMPLETED", date: { gte: depuis30 },
            OR: [{ report: null }, { report: "" }],
          },
        }),
      ]);
      return { job: "FIELD", counts: { visitsDone30, visitsPlanned, doctors, visitsWithoutReport } };
    }

    case "REGULATORY": {
      // SES dossiers, sous le CADENAS du lecteur — composés en `AND`, jamais par étalement (§118.133).
      const sien: Prisma.RegulatoryProductWhereInput = {
        AND: [{ OR: [{ responsibleId: userId }, { assistantId: userId }] }, verrou],
      };
      const [dossiers, overdue, stepsInProgress] = await Promise.all([
        prisma.regulatoryProduct.count({ where: sien }),
        // « En retard » ne veut plus rien dire sur un dossier ARRIVÉ : une décision obtenue le
        // 3 mars pour une cible du 1er mars n'appelle aucune action, et la compter userait le
        // chiffre. On exclut donc les deux états terminaux.
        prisma.regulatoryProduct.count({
          where: { AND: [sien, { targetDate: { lt: now }, status: { notIn: ["DECISION_OBTAINED", "CLOSED"] } }] },
        }),
        prisma.regulatoryStep.count({ where: { status: "IN_PROGRESS", product: sien } }),
      ]);
      return { job: "REGULATORY", counts: { dossiers, overdue, stepsInProgress } };
    }

    case "MEDICAL_INFO": {
      const [awaiting, docsRequested, validated30] = await Promise.all([
        prisma.medicalInfoDeclaration.count({
          where: { pharmacistId: userId, status: { in: ["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"] } },
        }),
        prisma.medicalInfoDeclaration.count({ where: { pharmacistId: userId, status: "DOCS_REQUESTED" } }),
        prisma.medicalInfoDeclaration.count({
          where: { pharmacistValidatedById: userId, pharmacistValidatedAt: { gte: depuis30 } },
        }),
      ]);
      return { job: "MEDICAL_INFO", counts: { awaiting, docsRequested, validated30 } };
    }

    case "COORDINATION": {
      // Une COURSE est une tâche qui porte une adresse — c'est ce qui la distingue d'une tâche
      // de bureau, et c'est la définition que l'écran du coursier utilise déjà.
      const course = { assignedToId: userId, address: { not: null } } as const;
      const [terminees, ouvertes] = await Promise.all([
        prisma.task.findMany({
          where: { ...course, status: "DONE", completedAt: { gte: depuis30 } },
          select: { startedAt: true, completedAt: true, expectedMinutes: true },
        }),
        prisma.task.count({ where: { ...course, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } } }),
      ]);
      // LE RETARD NE SE DÉDUIT QUE DE CE QUI A ÉTÉ MESURÉ : sans départ enregistré ou sans durée
      // annoncée, la course n'est ni à l'heure ni en retard — elle est hors du compte.
      const runsLate30 = terminees.filter((t) =>
        t.startedAt && t.completedAt && t.expectedMinutes != null
        && (t.completedAt.getTime() - t.startedAt.getTime()) / 60000 > t.expectedMinutes,
      ).length;
      return { job: "COORDINATION", counts: { runsDone30: terminees.length, runsLate30, runsOpen: ouvertes } };
    }

    default:
      return { job: "GENERIC" };
  }
}
