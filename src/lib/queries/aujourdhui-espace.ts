import { prisma } from "@/lib/prisma";
import type { Module, SessionUser } from "@/lib/rbac";
import { getActionCenter } from "@/lib/queries/action-center";
import { isOutstanding } from "@/lib/doc-request";
import { getAppSettings } from "@/lib/settings";
import { peutOuvrirModule } from "@/lib/queries/lien-ouvrable";
import { algiersYmd } from "@/lib/calendar-tz";
import { aujourdhuiAlger, minuitUtc, plusJours, jobOf } from "@/modules/rh/partage";
import { getMyTeam } from "@/lib/queries/my-team";
import { getMyTeamOverview, semaineOuvree } from "@/lib/queries/my-team-overview";
import { getTeamMemberKpis } from "@/lib/queries/team-kpis";
import { peutRelancer } from "@/lib/tasks/request-flow";
import { ROLE_LABELS } from "@/lib/labels";
import {
  calculerSemaine, composerEquipe, composerRaccourcis, composerTuiles, jourDeReferenceDeLaSemaine, METIERS,
  phraseJournee, regrouperFile, rolesDe, totaux,
  type ElementFile, type Fragment, type Lot, type MembreEncart, type MembreLu, type Mesures, type Semaine, type Tuile,
} from "@/lib/espace/aujourdhui";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — CE QUE LA PAGE LIT (Direction, 14/10/2026 ; règles PURES : `espace/aujourdhui.ts`).
 *
 * Aucune file neuve : la source est le centre d'actions (`getActionCenter`, déjà filtré par les droits
 * de la personne, une ligne par objet) et les pièces qu'on lui demande — exactement ce que l'ancien
 * « Mon espace » listait à plat. Ce module y ajoute :
 *   · les chiffres du MÉTIER que la file ne porte pas, lus là où ils existent déjà (compteurs du métier
 *     `getTeamMemberKpis` pour soi-même, paiements réglés par soi cette semaine) ;
 *   · « Ma semaine » — les GESTES DATÉS de la personne : décision d'une validation (`decidedAt`), d'un
 *     achat (`AdminApproval.decidedAt`), d'un congé (marche N+1 / RH / DG), d'une étape Ad & Pro
 *     (`WorkflowStepEvent`), paiement réglé (`paidDate`), déclaration validée, tâche terminée ;
 *   · l'encart « Mon équipe » pour un N+1 (`getMyTeam` → `getMyTeamOverview`), avec, par personne, la
 *     tâche que JE lui ai demandée et que la règle de relance (`peutRelancer`) laisse relancer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Aujourdhui {
  metiers: string[];
  phrase: Fragment[];
  tuiles: Tuile[];
  lots: Lot[];
  ouverts: number;
  enRetard: number;
  semaine: Semaine;
  equipe: { membres: MembreEncart[]; personnesEnRetard: number; retards: number; directs: number } | null;
  raccourcis: { label: string; href: string }[];
  /** Les pièces que J'attends des autres — une ligne de suivi, pas une action. */
  piecesEnAttente: number;
  /** Les congés à signer, tels que le centre les a lus (la page les rend dans leur bloc). */
  conges: Awaited<ReturnType<typeof getActionCenter>>["conges"];
}

/** Minuit d'Alger (UTC+1, sans heure d'été) d'un jour « AAAA-MM-JJ », en instant UTC. */
const minuitAlger = (jour: string) => new Date(minuitUtc(jour).getTime() - 3_600_000);

/** Les GESTES DATÉS de la personne depuis `depuis` — un instant par geste, de toutes les sources. */
async function gestesDatesDepuis(userId: string, depuis: Date): Promise<Date[]> {
  const T = 600;
  const [validations, achats, paiements, taches, pharmacien, direction, n1, rh, dg, etapes] = await Promise.all([
    prisma.validationStep.findMany({ where: { validatorId: userId, decidedAt: { gte: depuis }, status: { not: "PENDING" } }, select: { decidedAt: true }, take: T }),
    prisma.adminApproval.findMany({ where: { decidedById: userId, decidedAt: { gte: depuis } }, select: { decidedAt: true }, take: T }),
    prisma.expenseOrder.findMany({ where: { paidById: userId, status: "PAID", paidDate: { gte: depuis } }, select: { paidDate: true }, take: T }),
    prisma.task.findMany({ where: { assignedToId: userId, status: "DONE", completedAt: { gte: depuis } }, select: { completedAt: true }, take: T }),
    prisma.medicalInfoDeclaration.findMany({ where: { pharmacistValidatedById: userId, pharmacistValidatedAt: { gte: depuis } }, select: { pharmacistValidatedAt: true }, take: T }),
    prisma.medicalInfoDeclaration.findMany({ where: { validatedById: userId, validatedAt: { gte: depuis } }, select: { validatedAt: true }, take: T }),
    prisma.leaveRequest.findMany({ where: { managerDecidedById: userId, managerDecidedAt: { gte: depuis } }, select: { managerDecidedAt: true }, take: T }),
    prisma.leaveRequest.findMany({ where: { hrDecidedById: userId, hrDecidedAt: { gte: depuis } }, select: { hrDecidedAt: true }, take: T }),
    prisma.leaveRequest.findMany({ where: { dgDecidedById: userId, dgDecidedAt: { gte: depuis } }, select: { dgDecidedAt: true }, take: T }),
    prisma.workflowStepEvent.findMany({ where: { actorId: userId, action: { in: ["APPROVE", "REJECT", "REFUSE", "RETURN"] }, createdAt: { gte: depuis } }, select: { createdAt: true }, take: T }),
  ]);
  const dates: (Date | null)[] = [
    ...validations.map((x) => x.decidedAt), ...achats.map((x) => x.decidedAt), ...paiements.map((x) => x.paidDate),
    ...taches.map((x) => x.completedAt), ...pharmacien.map((x) => x.pharmacistValidatedAt), ...direction.map((x) => x.validatedAt),
    ...n1.map((x) => x.managerDecidedAt), ...rh.map((x) => x.hrDecidedAt), ...dg.map((x) => x.dgDecidedAt), ...etapes.map((x) => x.createdAt),
  ];
  return dates.filter((d): d is Date => d instanceof Date);
}

/** Les compteurs du métier, pour soi-même — la MÊME lecture que la carte d'un collaborateur dans Mon Équipe. */
async function mesuresDuMetier(user: SessionUser, nom: string, roles: string[], employeeId: string | null): Promise<Mesures> {
  const m: Mesures = {};
  if (!employeeId) return m;
  const metiers = [...new Set(roles.map((r) => jobOf(r)))].filter((j) => j === "FIELD" || j === "MEDICAL_INFO" || j === "COORDINATION");
  for (const job of metiers) {
    const role = roles.find((r) => jobOf(r) === job) ?? null;
    const k = await getTeamMemberKpis(employeeId, nom, user.id, role).catch(sansBloquer("aujourdhui-espace.mesuresDuMetier.getTeamMemberKpis", null));
    if (!k) continue;
    const v = (cle: string) => {
      const x = k.job_.find((y) => y.cle === cle);
      const n = x ? Number(x.value) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    if (job === "FIELD") {
      m.visites30 = v("visitsDone30");
      m.visitesPlanifiees = v("visitsPlanned");
      m.medecins = v("doctors");
      m.crManquants = v("visitsWithoutReport");
    } else if (job === "MEDICAL_INFO") {
      m.declValidees30 = v("validated30");
    } else {
      m.courses30 = v("runsDone30");
      m.coursesRetard30 = v("runsLate30");
      m.coursesOuvertes = v("runsOpen");
    }
  }
  return m;
}

export async function chargerAujourdhui(
  user: SessionUser,
  opts: { maintenant?: Date; nom?: string; employeeId?: string | null; tachesOuvertes?: number; tachesRetard?: number; rappels?: number } = {},
): Promise<Aujourdhui> {
  const now = opts.maintenant ?? new Date();
  const roles = rolesDe(user.role, user.secondaryRole);

  const aujourdhui = aujourdhuiAlger(now);
  const semaine = semaineOuvree(jourDeReferenceDeLaSemaine(aujourdhui));
  const semainePrecedente = semaineOuvree(plusJours(semaine[0], -7));
  const debutMois = `${aujourdhui.slice(0, 7)}-01`;
  const depuis = minuitAlger([semainePrecedente[0], debutMois].sort()[0]);
  const veutReglesSemaine = roles.some((r) => METIERS[r]?.tuiles.includes("regles_semaine"));

  const [centre, pieces, gestes, metier, settings, team, regles] = await Promise.all([
    getActionCenter(user),
    prisma.documentRequest.findMany({
      where: { OR: [{ askedToId: user.id }, { askedById: user.id }] },
      orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, label: true, reference: true, status: true, dueDate: true, createdAt: true, askedToId: true, askedById: true, askedBy: { select: { name: true } } },
    }),
    gestesDatesDepuis(user.id, depuis),
    mesuresDuMetier(user, opts.nom ?? "", roles, opts.employeeId ?? null),
    getAppSettings(),
    getMyTeam(user, { maintenant: now }).catch(sansBloquer("aujourdhui-espace.chargerAujourdhui.getMyTeam", null)),
    veutReglesSemaine
      ? prisma.expenseOrder.aggregate({
          where: { paidById: user.id, status: "PAID", paidDate: { gte: minuitAlger(semaine[0]) } },
          _count: { _all: true }, _sum: { amount: true },
        })
      : null,
  ]);

  // LA FILE : le centre d'actions, plus les pièces qu'on ME demande (l'ancienne section « Pièces demandées »).
  const piecesADeposer: ElementFile[] = pieces
    .filter((r) => r.askedToId === user.id && isOutstanding(r.status))
    .map((r) => ({
      key: `piece-${r.id}`, objet: `DOCUMENT_REQUEST:${r.id}`, title: r.label,
      subtitle: `${r.reference} · demandée par ${r.askedBy.name}`, module: "Pièces", href: `/pieces/${r.id}`,
      kind: "request", deadline: r.dueDate?.toISOString() ?? null, depuis: r.createdAt.toISOString(), owner: "",
      statusLabel: "À déposer",
    }));
  const piecesEnAttente = pieces.filter((r) => r.askedById === user.id && isOutstanding(r.status)).length;
  const lots = regrouperFile([...centre.items, ...piecesADeposer], now);
  const { ouverts, enRetard } = totaux(lots);

  // L'ÉQUIPE — pour un N+1 seulement (des directs dans l'organigramme).
  let equipe: Aujourdhui["equipe"] = null;
  const mesures: Mesures = {
    ...metier,
    tachesOuvertes: opts.tachesOuvertes ?? null,
    tachesRetard: opts.tachesRetard ?? null,
    rappels: opts.rappels ?? null,
    reglesSemaine: regles ? { n: regles._count._all, montant: Number(regles._sum.amount ?? 0) } : null,
  };
  if (team && team.directCount > 0) {
    const apercu = await getMyTeamOverview(user, team, { maintenant: now }).catch(sansBloquer("aujourdhui-espace.chargerAujourdhui.getMyTeamOverview", null));
    if (apercu) {
      const directs = apercu.lignes.filter((l) => l.direct);
      const userIds = directs.map((l) => l.userId).filter((x): x is string => Boolean(x));
      const demandees = userIds.length
        ? await prisma.task.findMany({
            where: { createdById: user.id, assignedToId: { in: userIds }, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] }, dueDate: { lt: now } },
            select: { id: true, status: true, requestedAt: true, assignedToId: true, createdById: true, lastNudgeAt: true, nudgeCount: true },
            orderBy: { dueDate: "asc" }, take: 200,
          })
        : [];
      const employeDuCompte = new Map(directs.filter((l) => l.userId).map((l) => [l.userId as string, l.employeeId]));
      const relances = new Map<string, string>();
      for (const t of demandees) {
        const emp = t.assignedToId ? employeDuCompte.get(t.assignedToId) : undefined;
        if (!emp || relances.has(emp)) continue;
        if (peutRelancer(t, user.id, now.getTime()).ok) relances.set(emp, t.id);
      }
      const membres: MembreLu[] = directs.map((l) => ({
        employeeId: l.employeeId, nom: l.nom, poste: l.poste, direct: l.direct,
        aujourdhui: l.aujourdhui.genre, ouvertes: l.taches.ouvertes, enRetard: l.taches.enRetard, aDecider: l.aDecider,
        alerte: [...l.alertes].sort((a, b) => a.rang - b.rang)[0]?.court ?? null,
        sansRapport: l.terrainMois?.sansRapport ?? null,
      }));
      equipe = composerEquipe(membres, relances);
      const sansRapport = directs.some((l) => l.terrainMois) ? directs.reduce((s, l) => s + (l.terrainMois?.sansRapport ?? 0), 0) : null;
      mesures.equipe = {
        directs: equipe.directs, retards: equipe.retards, sansRapport,
        couverture: apercu.couverture ? { mois: apercu.couverture.mois, objectif: apercu.couverture.objectif } : null,
      };
    }
  }

  // MA SEMAINE — sur les gestes datés.
  const jours = gestes.map((d) => algiersYmd(d));
  const ensemblePrecedente = new Set(semainePrecedente);
  const calc = calculerSemaine({
    semaine, aujourdhui, joursDesGestes: jours, reste: ouverts,
    semainePrecedente: jours.filter((j) => ensemblePrecedente.has(j)).length,
    mois: jours.filter((j) => j >= debutMois && j <= aujourdhui).length,
  });

  const { hiddenModules } = settings;
  return {
    metiers: roles.map((r) => ROLE_LABELS[r] ?? r),
    phrase: phraseJournee(lots),
    tuiles: composerTuiles(roles, lots, mesures),
    lots, ouverts, enRetard,
    semaine: calc,
    equipe,
    raccourcis: composerRaccourcis(roles, (m) => peutOuvrirModule(user, m as Module, hiddenModules)),
    piecesEnAttente,
    conges: centre.conges,
  };
}
