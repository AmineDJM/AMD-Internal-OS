import { prisma } from "@/lib/prisma";
import { clauseSalariesVisibles } from "@/lib/queries/visibilite-listes";
import { userCan, isTopManagement, type SessionUser } from "@/lib/rbac";
import { canDecideLeave, type LeaveStage } from "../../domaine/leave-workflow";
import { arriveeALaMarche } from "@/lib/approval-chain";
import { buildLeaveSheet } from "../../domaine/leave-sheet";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { clauseFileConges, fichesDesSignataires, salariesDontJeSuisLeN1 } from "../../domaine/file-conges";
import { loadReportingLine } from "@/lib/departments";
import { toNumber } from "@/lib/utils";
import { basisLabel } from "../../domaine/payroll-cost";
import { employeeCosts, workforceMass, massByCompany, massProvenance, massIsIncomplete } from "../../domaine/workforce-mass";
import { sansBloquer } from "@/lib/journal";

/** Personalised workspace data for the signed-in user ("Mon espace"). */
export async function getMyWorkspace(userId: string) {
  const [employee, myTasks, delegated, shared, myLeaves, myAdvances, activity] = await Promise.all([
    prisma.employee.findUnique({
      where: { userId },
      select: { id: true, leaveBalanceDays: true, contractType: true, contractEnd: true, position: true, department: true },
    }),
    prisma.task.findMany({
      where: {
        assignedToId: userId,
        OR: [
          { status: { in: ["TODO", "IN_PROGRESS"] } },
          // Une demande validée reste à portée un mois : le travail est TOUJOURS modifiable, et
          // une pièce retrouvée le lendemain doit pouvoir rejoindre son dossier. Sans cela, elle
          // repartirait par message et le dossier resterait faux.
          { status: "DONE", requestedAt: { not: null }, completedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        ],
      },
      orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
      take: 50,
    }),
    // Ce que J'AI demandé à quelqu'un, ou délégué. Les statuts REQUESTED / DECLINED / DONE en
    // font partie : sans eux, une demande qu'on vient d'envoyer n'apparaissait NULLE PART chez
    // son auteur — on ne savait ni qu'elle attendait, ni qu'elle avait été refusée.
    prisma.task.findMany({
      where: {
        createdById: userId, assignedToId: { not: userId },
        status: { in: ["REQUESTED", "TODO", "IN_PROGRESS", "DECLINED", "DONE"] },
      },
      include: { assignedTo: { select: { name: true } } },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }],
      take: 40,
    }),
    // Tâches PARTAGÉES avec moi : je participe ou j'ai un accès en lecture, sans en être le
    // responsable ni le créateur (ceux-là remontent déjà plus haut).
    prisma.task.findMany({
      where: {
        // REQUESTED en fait partie : une tâche assignée à quelqu'un d'AUTRE naît désormais en
        // attente de sa réponse. Sans ce statut, les participants et les lecteurs recevaient la
        // notification puis ne trouvaient la tâche nulle part — jusqu'à ce qu'elle soit acceptée.
        status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] },
        assignedToId: { not: userId },
        createdById: { not: userId },
        OR: [{ participantIds: { has: userId } }, { readerIds: { has: userId } }],
      },
      include: { assignedTo: { select: { name: true } } },
      orderBy: [{ dueDate: "asc" }],
      take: 30,
    }),
    prisma.leaveRequest.findMany({
      where: { employee: { userId } },
      orderBy: { startDate: "desc" },
      take: 12,
    }),
    prisma.salaryAdvance.findMany({
      where: { employee: { userId } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.activityLog.findMany({
      where: { userId, type: "PAGE_VIEW" },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const now = Date.now();
  // « Ouvertes » = ce qui reste à faire. Les demandes validées, gardées à portée pour rester
  // modifiables, ne sont plus du travail en attente et ne doivent pas gonfler le compteur.
  const openMyTasks = myTasks.filter((t) => t.status !== "DONE");
  const overdue = openMyTasks.filter((t) => t.dueDate && t.dueDate.getTime() < now).length;
  const pendingLeaves = myLeaves.filter((l) => l.status === "PENDING").length;
  const pendingAdvances = myAdvances.filter((a) => a.status === "PENDING").length;

  return {
    employee,
    myTasks,
    delegated,
    shared,
    myLeaves,
    myAdvances,
    activity,
    stats: {
      openTasks: openMyTasks.length,
      overdue,
      pendingLeaves,
      pendingAdvances,
      leaveBalance: employee ? toNumber(employee.leaveBalanceDays) : null,
    },
  };
}

/** Back-office HR data for the /rh page. */
export async function getRhData(userId: string) {
  const now = new Date();
  const in60 = new Date();
  in60.setDate(now.getDate() + 60);

  // LA MÊME PORTÉE pour les salariés ET pour leurs congés, leurs avances (audit 360°, S6) : les listes
  // de congés en attente, l'historique (« Maladie », « Maternité ») et les avances ignoraient la
  // société, et le lien « Traiter » ouvrait ensuite la fiche d'une autre société.
  const salaries = await clauseSalariesVisibles(userId);
  const [employees, pendingLeaves, recentLeaves, advances] = await Promise.all([
    prisma.employee.findMany({
      // Portée VALIDÉE contre les droits (le cookie est une demande, pas une autorisation).
      where: salaries,
      orderBy: [{ isActive: "desc" }, { fullName: "asc" }],
      include: { user: { select: { id: true, email: true } }, company: { select: { id: true, name: true, shortName: true, color: true } }, _count: { select: { leaveRequests: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: { status: "PENDING", employee: salaries },
      include: { employee: { select: { id: true, fullName: true } } },
      orderBy: { startDate: "asc" },
    }),
    prisma.leaveRequest.findMany({
      where: { status: { not: "PENDING" }, employee: salaries },
      include: { employee: { select: { fullName: true } } },
      orderBy: { decidedAt: "desc" },
      take: 15,
    }),
    prisma.salaryAdvance.findMany({
      where: { status: { in: ["PENDING", "APPROVED"] }, employee: salaries },
      include: { employee: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const active = employees.filter((e) => e.isActive);
  // MASSE SALARIALE — la PAIE fait foi dès qu'elle existe. La somme des salaires de BASE ignore
  // primes, retenues et arrivées/départs du mois : elle affichait un chiffre théorique à côté
  // d'un module Paie qui, lui, connaissait le vrai. On lit donc le mois de paie le plus récent
  // effectivement saisi (brut + primes − retenues) ; à défaut seulement, on retombe sur les
  // salaires de base, en le disant à l'écran.
  // LE COÛT EMPLOYEUR fait la masse, pas le brut : deux salariés au même brut ne coûtent pas la
  // même chose à la société, et c'est le décaissement réel qu'on oppose au budget. On lit les
  // LIGNES du dernier mois (et non une somme agrégée) pour que chacune retombe sur son brut si
  // son coût employeur n'a pas été saisi — les mois antérieurs au champ — et pour dire ensuite
  // sur quoi le total repose.
  const lastMonthAgg = await prisma.payrollEntry
    .groupBy({ by: ["year", "month"], orderBy: [{ year: "desc" }, { month: "desc" }], take: 1 })
    .catch(sansBloquer("hr.getRhData.payrollEntry", [] as { year: number; month: number }[]));
  const lastPayroll = lastMonthAgg[0] ?? null;
  // ── TOUTES LES LIGNES DU MOIS, PAS SEULEMENT LES POINTÉES ─────────────────────────────────
  //
  // On ne retenait ici que `status: "PAID"`. C'était le premier des trois chemins par lesquels la
  // masse salariale se retrouvait SOUS-ÉVALUÉE : un mois saisi mais pas encore pointé comptait
  // pour zéro, et une société dont quatre bulletins sur trente étaient marqués payés affichait la
  // masse salariale de quatre personnes.
  //
  // Le filtre protégeait contre un vrai risque — un paiement annulé qui continuerait de peser —
  // mais il protégeait la MAUVAISE GRANDEUR. La masse salariale est ce que l'effectif COÛTE, pas
  // ce qui est sorti de la banque : un bulletin en brouillon coûte déjà, le salaire est dû. Le
  // décaissement, lui, a son propre indicateur en trésorerie. Voir `hr/workforce-mass.ts`.
  const lastEntries = lastPayroll
    ? await prisma.payrollEntry
        .findMany({
          // SEULEMENT LES SALARIÉS DE LA PORTÉE. L'effectif était filtré par entité, la masse
          // salariale ne l'était pas : on lisait « 10 actifs » d'une société sous une masse
          // salariale du GROUPE ENTIER. Le total n'était pas faux, il répondait simplement à une
          // autre question que celle posée — le piège que ce fichier documente déjà deux fois.
          where: {
            year: lastPayroll.year, month: lastPayroll.month,
            employeeId: { in: employees.map((e) => e.id) },
          },
          select: { employeeId: true, employerCost: true, gross: true, bonuses: true, deductions: true },
        })
        .catch(sansBloquer("hr.getRhData.payrollEntry", []))
    : [];

  // ── UN SALARIÉ, UN COÛT, PERSONNE D'OUBLIÉ ────────────────────────────────────────────────
  //
  // Chaque salarié ACTIF est compté une fois : sa ligne de paie du mois si elle existe, sinon le
  // coût employeur de référence de sa fiche. C'est ce qui corrige les deux autres chemins de la
  // sous-estimation — le mois de référence lu à l'échelle de la PLATEFORME (une société dont la
  // paie n'était pas encore saisie tombait à zéro) et le repli sur les SALAIRES DE BASE, qui
  // retire d'un coup les primes et les charges patronales.
  const coutsParSalarie = employeeCosts(
    employees.map((e) => ({
      id: e.id, companyId: e.company?.id ?? null, isActive: e.isActive,
      employerCost: e.employerCost != null ? toNumber(e.employerCost) : null,
      grossSalary: e.grossSalary != null ? toNumber(e.grossSalary) : null,
      baseSalary: toNumber(e.baseSalary),
    })),
    lastEntries.map((e) => ({
      employeeId: e.employeeId,
      employerCost: e.employerCost != null ? toNumber(e.employerCost) : null,
      gross: toNumber(e.gross), bonuses: toNumber(e.bonuses), deductions: toNumber(e.deductions),
    })),
  );
  const mass = workforceMass(coutsParSalarie);
  const masseSalariale = mass.total;
  /**
   * D'OÙ VIENT LE CHIFFRE — le mois lu, la base, et la provenance salarié par salarié.
   *
   * Un total dont on ignore la provenance est un total qu'on finit par ne plus croire. On dit
   * donc combien de salariés viennent de la paie du mois, combien de leur fiche, et combien n'ont
   * aucun montant connu — ceux-là AMPUTENT le total, et c'est `masseSalarialePartielle` qui le
   * signale à l'écran.
   */
  const provenance = massProvenance(mass);
  const masseSalarialeSource = [
    ...(lastPayroll ? [`paie ${String(lastPayroll.month).padStart(2, "0")}/${lastPayroll.year}`] : []),
    basisLabel(mass.basis),
    ...(provenance ? [provenance] : []),
  ].join(" · ");
  const masseSalarialePartielle = massIsIncomplete(mass);
  const contractsExpiring = employees.filter(
    (e) => e.contractEnd && e.contractEnd >= now && e.contractEnd <= in60,
  );

  const deptMap = new Map<string, number>();
  for (const e of active) {
    const key = e.department || "Non affecté";
    deptMap.set(key, (deptMap.get(key) ?? 0) + 1);
  }
  const byDepartment = [...deptMap.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  // ── LA VENTILATION PAR ENTITÉ ─────────────────────────────────────────────────────────────
  //
  // POURQUOI ELLE EXISTE. En production, le PDG a demandé « il y a combien de salariés
  // Adventum ? » et s'est vu répondre un nombre — celui de la PLATEFORME ENTIÈRE. Sa correction,
  // mot pour mot : « Non faux, ça c'est tout ceux qui sont dans la plateforme toute entité
  // confondu. » Le total n'était pas faux ; c'est son PÉRIMÈTRE qui était tu.
  //
  // Un agrégat sans sa portée est un piège : il est juste, il se dit avec aplomb, et il répond à
  // une autre question que celle posée. On rend donc TOUJOURS la décomposition, à côté du total.
  // Elle ne coûte aucune requête supplémentaire — les employés et les lignes de paie sont déjà là.
  //
  // LA MASSE PAR ENTITÉ SE LIT SUR LES MÊMES COÛTS QUE LE TOTAL — un seul calcul, une seule
  // vérité. Deux calculs parallèles auraient fini par diverger sur le cas qu'on n'aurait corrigé
  // que d'un côté, et c'est précisément ce qui s'était produit : le total retombait sur les
  // lignes payées du mois, la ventilation sur les salaires de base par société.
  const masseParEntite = massByCompany(coutsParSalarie);
  const compMap = new Map<string, { id: string | null; label: string; fullName: string | null; total: number; active: number }>();
  for (const e of employees) {
    const id = e.company?.id ?? null;
    const key = id ?? "";
    const label = e.company ? (e.company.shortName || e.company.name) : "Non rattaché";
    const row = compMap.get(key) ?? { id, label, fullName: e.company?.name ?? null, total: 0, active: 0 };
    row.total += 1;
    if (e.isActive) row.active += 1;
    compMap.set(key, row);
  }
  const byCompany = [...compMap.values()]
    .map((c) => {
      const m = masseParEntite.get(c.id) ?? null;
      return {
        ...c,
        masseSalariale: m?.total ?? 0,
        // CE QUI MANQUE SE DIT ENTITÉ PAR ENTITÉ : un salarié sans montant connu ampute le
        // chiffre de SA société, et c'est là qu'il faut aller le corriger.
        masseProvenance: m ? massProvenance(m) : null,
        massePartielle: m ? massIsIncomplete(m) : false,
      };
    })
    .sort((a, b) => b.active - a.active || a.label.localeCompare(b.label, "fr"));

  return {
    employees,
    pendingLeaves,
    recentLeaves,
    advances,
    contractsExpiring,
    byDepartment,
    byCompany,
    stats: {
      total: employees.length,
      active: active.length,
      pending: pendingLeaves.length,
      expiring: contractsExpiring.length,
      advances: advances.filter((a) => a.status === "PENDING").length,
      masseSalariale,
      masseSalarialeSource,
      masseSalarialePartielle,
    },
  };
}

/** Une de MES demandes de congé, avec l'avancement réel de son circuit. */
export interface MyLeaveDTO {
  id: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  stage: LeaveStage;
  passed: { label: string; note: string | null }[];
  /** L'intérimaire désigné pour ce congé, et où en est sa validation par les RH. */
  standInId: string | null;
  standInName: string | null;
  standInStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  standInModules: string[];
  standInNote: string | null;
}

/**
 * MES CONGÉS — la source unique de « Mon espace » **et** de « Mon dossier RH ».
 *
 * Les deux écrans lisaient (ou n'affichaient pas) des choses différentes ; ils lisent
 * désormais ceci, et affichent donc la même chose — y compris l'étape en cours, qui est la
 * seule information que le salarié cherche vraiment quand il revient voir sa demande.
 */
export async function getMyLeaveRequests(userId: string): Promise<MyLeaveDTO[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: { employee: { userId } },
    orderBy: { startDate: "desc" },
    take: 20,
  });
  const names = new Map(
    (await prisma.user.findMany({
      where: { id: { in: rows.map((l) => l.standInId).filter((v): v is string => Boolean(v)) } },
      select: { id: true, name: true },
    })).map((u) => [u.id, u.name]),
  );
  return rows.map((l) => ({
    id: l.id,
    type: l.type,
    startDate: l.startDate.toISOString(),
    endDate: l.endDate.toISOString(),
    days: Number(l.days),
    status: l.status,
    stage: l.stage as LeaveStage,
    // L'intérim se lit SUR la demande de congé : c'est elle qui le porte, et c'est elle qui le
    // termine. Le nom est résolu en une requête pour tout le lot.
    standInId: l.standInId,
    standInName: l.standInId ? names.get(l.standInId) ?? null : null,
    standInStatus: l.standInStatus,
    standInModules: l.standInModules,
    standInNote: l.standInNote,
    passed: [
      l.managerDecidedAt ? { label: "Responsable (N+1)", note: l.managerNote } : null,
      l.hrDecidedAt ? { label: "Ressources humaines", note: l.hrNote } : null,
      l.dgDecidedAt ? { label: "Direction générale", note: l.dgNote } : null,
    ].filter((v): v is { label: string; note: string | null } => v !== null),
  }));
}

/** Une demande de congé telle que la voit celui qui doit la trancher. */
export interface LeaveToDecide {
  id: string;
  employeeId: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  stage: LeaveStage;
  /** Note laissée par la marche précédente — le contexte que le suivant n'a pas. */
  previousNote: string | null;
  previousStageLabel: string | null;
  /**
   * LA FICHE DE DEMANDE, telle que le formulaire papier la portait : nom, prénom, fonction,
   * date de recrutement, direction, date de la demande, jours, départ, reprise, téléphone,
   * intérim. Le valideur l'a SOUS LES YEUX au moment de signer — la chercher ailleurs, c'est
   * ce qui faisait décrocher le téléphone à chacune des trois marches.
   */
  sheet: { label: string; value: string }[];
  /** En intérim : le N+1 absent au nom de qui l'on signe ; `null` quand la marche est à moi (I18). */
  pourLeCompteDe: string | null;
  /**
   * DEPUIS QUAND LA DEMANDE ATTEND À SA MARCHE (ISO, lot E2 — audit 360°, 07-05) : son dépôt, l'accord du
   * N+1, celui des RH (`arriveeALaMarche`). La file la trie, la ligne le dit.
   */
  depuis: string;
}

/**
 * LES CONGÉS QUE **CETTE PERSONNE** DOIT TRANCHER MAINTENANT.
 *
 * Le circuit a trois marches (N+1 → RH → DG) et donc trois publics : un responsable d'équipe
 * n'a pas le module RH, et les RH n'ont pas à voir ce qui attend encore le responsable. On
 * résout donc la file par PERSONNE, pas par module — sinon la moitié des validateurs n'aurait
 * nulle part où signer.
 *
 * Une seule requête pour les demandes, une seule pour résoudre les responsables : la liste
 * s'affiche sur « Mon espace » de tout le monde, elle ne peut pas coûter N requêtes.
 */
export async function getLeavesToDecide(user: SessionUser): Promise<LeaveToDecide[]> {
  const isHr = userCan(user, "HR_REQUESTS", "VALIDATE");
  // MÊME prédicat que `leaveDecider` : la file de décision et le droit de trancher doivent
  // dire la même chose, sinon la demande apparaît à quelqu'un qui ne peut pas la signer
  // (ou l'inverse, plus grave : elle disparaît de la file de celui qui le peut).
  const isDg = isTopManagement(user);
  // LE N+1, OU SON INTÉRIMAIRE — la même lecture que `leaveDecider` (I18).
  const auNom = await auNomDeQui(user.id);
  // LE N+1 ENREGISTRÉ ET LE N+1 ACTUEL (§118.196, E1) : un salarié muté d'équipe envoyait sa
  // demande chez son ancien responsable, et le nouveau — que l'action accepte — ne la voyait nulle
  // part. Le filtre part dans la requête : lire d'abord les 200 premiers congés de toute la base,
  // puis filtrer, laissait tomber la demande d'un responsable hors de la fenêtre.
  const { employees, departments } = await loadReportingLine();
  const salariesRattaches = salariesDontJeSuisLeN1(auNom.ids, employees, departments);
  const clause = clauseFileConges({ isDg, isHr, fichesSignataires: fichesDesSignataires(auNom.ids, employees), salariesRattaches, signataires: [...auNom.ids] });
  if (!clause) return [];
  const rattaches = new Set(salariesRattaches);
  const pending = await prisma.leaveRequest.findMany({
    where: clause,
    include: {
      employee: {
        select: {
          id: true, fullName: true, userId: true,
          // La FICHE se lit de l'employé — jamais recopiée dans la demande (cf. `leave-sheet.ts`).
          position: true, hireDate: true, phone: true,
          department: true, departmentRef: { select: { name: true } },
        },
      },
    },
    orderBy: { startDate: "asc" },
    // Une borne de sécurité, plus un filtre : la requête ne rend que ce qui attend CETTE personne.
    take: 500,
  });
  if (pending.length === 0) return [];

  // Le nom des intérimaires désignés, résolu en UNE requête pour tout le lot.
  const standInNames = new Map(
    (await prisma.user.findMany({
      where: { id: { in: pending.map((l) => l.standInId).filter((v): v is string => !!v) } },
      select: { id: true, name: true },
    })).map((u) => [u.id, u.name]),
  );

  // Responsables enregistrés → comptes applicatifs, en UNE requête.
  const managerIds = [...new Set(pending.map((l) => l.managerId).filter((v): v is string => !!v))];
  const managers = managerIds.length
    ? await prisma.employee.findMany({ where: { id: { in: managerIds } }, select: { id: true, userId: true } })
    : [];
  const managerUserById = new Map(managers.map((m) => [m.id, m.userId]));

  const out: LeaveToDecide[] = [];
  for (const l of pending) {
    const managerUserId = l.managerId ? managerUserById.get(l.managerId) ?? null : null;
    const isManager = Boolean(managerUserId && auNom.ids.has(managerUserId)) || rattaches.has(l.employee.id);
    const allowed = canDecideLeave(
      { status: l.status, stage: l.stage as LeaveStage, requesterUserId: l.employee.userId },
      { id: user.id, isManager, isHr, isDg },
    );
    if (!allowed.ok) continue;

    // Ce que la marche précédente a écrit — le refus d'un N+1 ne remonte pas, mais son
    // accord, lui, porte souvent une réserve utile aux RH.
    const previous = l.stage === "HR"
      ? { note: l.managerNote, label: "Responsable (N+1)" }
      : l.stage === "DG"
        ? { note: l.hrNote ?? l.managerNote, label: l.hrNote ? "Ressources humaines" : "Responsable (N+1)" }
        : { note: null as string | null, label: null as string | null };

    out.push({
      id: l.id,
      employeeId: l.employee.id,
      employee: l.employee.fullName,
      type: l.type,
      startDate: l.startDate.toISOString(),
      endDate: l.endDate.toISOString(),
      days: Number(l.days),
      reason: l.reason,
      stage: l.stage as LeaveStage,
      previousNote: previous.note,
      previousStageLabel: previous.note ? previous.label : null,
      sheet: buildLeaveSheet(
        {
          fullName: l.employee.fullName,
          position: l.employee.position,
          hireDate: l.employee.hireDate,
          department: l.employee.departmentRef?.name ?? l.employee.department,
          phone: l.employee.phone,
        },
        {
          createdAt: l.createdAt, startDate: l.startDate, endDate: l.endDate, days: Number(l.days),
          phone: l.phone,
          standInName: l.standInId ? standInNames.get(l.standInId) ?? null : null,
          standInStatus: l.standInStatus,
        },
      ),
      // La marche du N+1 tranchée par son intérimaire se signe AU NOM de l'absent — l'écran le dit.
      pourLeCompteDe: l.stage === "MANAGER" && isManager && managerUserId !== user.id ? auNom.nomDe(managerUserId) : null,
      depuis: arriveeALaMarche(l.stage, { creeLe: l.createdAt, n1DecideLe: l.managerDecidedAt, rhDecideLe: l.hrDecidedAt }).toISOString(),
    });
  }
  return out;
}
