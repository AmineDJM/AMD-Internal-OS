import { prisma } from "@/lib/prisma";
import { algiersYmd } from "@/lib/calendar-tz";
import { getAppSettings } from "@/lib/settings";
import { userCan, type SessionUser } from "@/lib/rbac";
import { CONTRACT_TYPE, LEAVE_TYPE } from "@/lib/labels";
import { natureDeLAbsence, voitLeTypeDesAbsences } from "@/lib/hr/confidentialite";
import { jobOf, type TeamJob, aujourdhuiAlger, jourDuConge, minuitUtc, plusJours } from "@/modules/rh/partage";
import { DEFAULT_THRESHOLDS } from "@/lib/sfe-alerts";
import { panelsDesKams } from "@/lib/queries/panel-kam";
import { peutOuvrirModule } from "@/lib/queries/lien-ouvrable";
import { viewsAllReports } from "@/lib/queries/field-reports";
import { toNumber } from "@/lib/utils";
import type { MyTeam } from "@/lib/queries/my-team";

/**
 * MON ÉQUIPE — LA VUE D'ENSEMBLE, LE TABLEAU ET LE CALENDRIER (maquette validée, Direction 07/10).
 *
 * Ce module ne redéfinit PAS l'équipe : il part de `getMyTeam` (la cascade hiérarchique, la même qui route
 * les demandes) et lit, pour ces seules personnes, ce que l'écran affiche. Tout vient de la base — aucun
 * chiffre n'est estimé :
 *  · aujourd'hui / calendrier : congés (accordés, et en attente en clair), missions (assignations aux
 *    congrès et événements, dates et ville de l'événement), formations (participations et demandes accordées) ;
 *  · activité 30 j : visites réalisées et couverture du panel (mêmes définitions que le cockpit SFE :
 *    praticiens distincts vus / panel `clausePanelDuKam`) pour le terrain ; tâches terminées pour les autres ;
 *  · alertes : fin de contrat, fin de période d'essai, solde de congés, visites sans compte rendu, anniversaire.
 *
 * Ce qui n'en sort JAMAIS : salaire, année de naissance (seul le jour et le mois servent à l'anniversaire), et la
 * NATURE d'une absence pour un encadrant (§118.184) : il lit « Congé » (annuel, sans solde, récupération) ou « Absent »
 * (maladie, maternité, événement familial, autre) — qui manque, pas pourquoi. Seul qui gère les RH
 * (`voitLeTypeDesAbsences`) reçoit le type précis, dans `libelle`.
 */

/** `ABSENCE` : toute absence qui n'est pas un congé « ordinaire » (maladie, maternité…) — dite « Absent », sans sa nature. */
export type GenreEvenement = "CONGE" | "ABSENCE" | "MISSION" | "FORMATION";
export type TonAlerte = "danger" | "warning" | "info" | "success";

export interface EvenementEquipe {
  employeeId: string;
  genre: GenreEvenement;
  /** « AAAA-MM-JJ », inclus. */
  debut: string;
  /** « AAAA-MM-JJ », inclus. */
  fin: string;
  /** Mission : la ville (ou l'événement) ; formation : son intitulé. */
  libelle: string | null;
  /** Congé encore en instruction. */
  enAttente: boolean;
}

export interface AlerteEquipe {
  employeeId: string;
  genre: "CONTRAT" | "ESSAI" | "SOLDE" | "RAPPORTS" | "ANNIVERSAIRE";
  ton: TonAlerte;
  /** Le libellé court du tableau (« contrat 12 j »). */
  court: string;
  /** La phrase de « À surveiller ». */
  texte: string;
  /** Plus petit = plus grave. */
  rang: number;
}

export interface LigneEquipe {
  employeeId: string;
  userId: string | null;
  nom: string;
  depth: number;
  direct: boolean;
  /** Son N+1 dans mon arbre (null au premier rang). */
  nPlus1: string | null;
  poste: string | null;
  /** BU pour un KAM, sinon le département. */
  rattachement: string | null;
  metier: TeamJob;
  depuis: string | null;
  aujourdhui: { genre: "PRESENT" | GenreEvenement; jusquAu: string | null; libelle: string | null };
  /** Terrain : visites et couverture sur 30 j ; ailleurs : tâches terminées sur 30 j. */
  activite: { type: "VISITES"; visites: number; couverture: number | null } | { type: "TACHES"; faites: number } | null;
  taches: { ouvertes: number; enRetard: number };
  solde: number;
  prisAnnee: number;
  prochainConge: { debut: string; fin: string } | null;
  alertes: AlerteEquipe[];
  /** Terrain, mois en cours : visites réalisées / prévues, couverture, sans compte rendu. */
  terrainMois: { faites: number; prevues: number; couverture: number | null; sansRapport: number } | null;
  enCours: {
    plansEnAttente: number;
    ordresMission: number;
    formations: { titre: string; debut: string }[];
  };
  contrat: { type: string | null; debut: string | null; fin: string | null; finEssai: string | null };
  aDecider: number;
}

export interface JourCalendrier {
  jour: string;
  num: number;
  /** 0 = dimanche … 6 = samedi. */
  dow: number;
  weekend: boolean;
}

export interface ApercuEquipe {
  aujourdhui: string;
  semaine: JourCalendrier[];
  mois: { cle: string; libelle: string; jours: JourCalendrier[]; precedent: string; suivant: string };
  lignes: LigneEquipe[];
  evenements: EvenementEquipe[];
  /** Anniversaires qui tombent dans la semaine ou le mois affichés — la DATE de cette année, rien d'autre. */
  anniversaires: { employeeId: string; jour: string }[];
  /** Couverture du panel de l'équipe terrain — null si personne n'a de panel. */
  couverture: { mois: number; moisPrecedent: number | null; objectif: number } | null;
  droits: { messagerie: boolean; taches: boolean; recrutement: boolean; rapports: boolean };
}

const JOURS_COURTS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);
const dowDe = (jour: string) => minuitUtc(jour).getUTCDay();
const jourCal = (jour: string): JourCalendrier => {
  const dow = dowDe(jour);
  return { jour, num: Number(jour.slice(8, 10)), dow, weekend: dow === 5 || dow === 6 };
};
const ecartJours = (de: string, a: string) => Math.round((minuitUtc(a).getTime() - minuitUtc(de).getTime()) / 86_400_000);
const moisValide = (m: string | undefined | null): m is string => Boolean(m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m));
const decalerMois = (cle: string, n: number) => {
  const [a, m] = cle.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const joursDuMois = (cle: string): string[] => {
  const [a, m] = cle.split("-").map(Number);
  const n = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${cle}-${String(i + 1).padStart(2, "0")}`);
};
const TACHE_OUVERTE = ["REQUESTED", "TODO", "IN_PROGRESS"] as const;
const TACHE_EN_COURS = ["TODO", "IN_PROGRESS"] as const;

/**
 * La semaine de travail algérienne — du DIMANCHE au JEUDI. Un vendredi ou un samedi, c'est la semaine qui vient.
 */
export function semaineOuvree(aujourdhui: string): string[] {
  const dow = dowDe(aujourdhui);
  const dimanche = dow === 5 ? plusJours(aujourdhui, 2) : dow === 6 ? plusJours(aujourdhui, 1) : plusJours(aujourdhui, -dow);
  return Array.from({ length: 5 }, (_, i) => plusJours(dimanche, i));
}

export async function getMyTeamOverview(
  user: SessionUser,
  team: MyTeam,
  opts: { mois?: string | null; maintenant?: Date } = {},
): Promise<ApercuEquipe> {
  const maintenant = opts.maintenant ?? new Date();
  const aujourdhui = aujourdhuiAlger(maintenant);
  const semaine = semaineOuvree(aujourdhui);
  const moisCourant = aujourdhui.slice(0, 7);
  const cleMois = moisValide(opts.mois) ? opts.mois : moisCourant;
  const jours = joursDuMois(cleMois);
  const libelleMois = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(minuitUtc(jours[0]));

  const { hiddenModules } = await getAppSettings();
  const droits = {
    messagerie: peutOuvrirModule(user, "MESSAGING", hiddenModules),
    taches: userCan(user, "WORKSPACE", "CREATE"),
    // Le bouton « Demander un recrutement » rejoue la garde de l'écran visé, module masqué compris.
    recrutement: userCan(user, "RECRUITMENT", "CREATE") && peutOuvrirModule(user, "RECRUITMENT", hiddenModules),
    // « Voir ses rapports » ouvre la liste des Rapports terrain filtrée sur ce délégué : la liste ne laisse choisir
    // un délégué qu'à qui voit les rapports de tous (`viewsAllReports`) — le lien ne se propose pas à qui n'y verrait rien de plus.
    rapports: peutOuvrirModule(user, "FIELD_REPORTS", hiddenModules) && viewsAllReports(user),
  };

  const base: Omit<ApercuEquipe, "lignes" | "evenements" | "anniversaires" | "couverture"> = {
    aujourdhui,
    semaine: semaine.map(jourCal),
    mois: { cle: cleMois, libelle: libelleMois, jours: jours.map(jourCal), precedent: decalerMois(cleMois, -1), suivant: decalerMois(cleMois, 1) },
    droits,
  };
  if (team.members.length === 0) return { ...base, lignes: [], evenements: [], anniversaires: [], couverture: null };

  // LA PLAGE LUE : le mois affiché ∪ la semaine ∪ aujourd'hui.
  const plageDebut = [jours[0], semaine[0], aujourdhui].sort()[0];
  const plageFin = [jours[jours.length - 1], semaine[4], aujourdhui].sort()[2];
  const dPlageDebut = minuitUtc(plageDebut);
  const dPlageFinExcl = minuitUtc(plusJours(plageFin, 1));

  const employeeIds = team.members.map((m) => m.employeeId);
  const userIds = team.members.map((m) => m.userId).filter((v): v is string => Boolean(v));
  const metierDe = new Map(team.members.map((m) => [m.employeeId, jobOf(m.role)]));
  const repIds = team.members.filter((m) => m.userId && metierDe.get(m.employeeId) === "FIELD").map((m) => m.userId as string);

  const debutMois = minuitUtc(`${moisCourant}-01`);
  const debutMoisPrecedent = minuitUtc(`${decalerMois(moisCourant, -1)}-01`);
  const finMoisExcl = minuitUtc(`${decalerMois(moisCourant, 1)}-01`);
  const il30 = new Date(maintenant.getTime() - 30 * 86_400_000);
  const debutVisites = il30 < debutMoisPrecedent ? il30 : debutMoisPrecedent;
  const debutAnnee = minuitUtc(`${aujourdhui.slice(0, 4)}-01-01`);
  // Une formation commencée jusqu'à 90 j avant la plage peut encore la couvrir ; au-delà d'un an, « à venir » n'informe plus.
  const debutFormations = new Date(dPlageDebut.getTime() - 90 * 86_400_000);
  const finFormations = new Date(Math.max(dPlageFinExcl.getTime(), maintenant.getTime() + 366 * 86_400_000));

  const [
    fiches, conges, prisAnnee, tachesOuvertes, tachesRetard, tachesFaites, plans, ordres, assignations,
    participations, formationsDemandees, visites, panels, profils,
  ] = await Promise.all([
    prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true, contractType: true, contractStart: true, contractEnd: true, hireDate: true,
        trialEnd: true, trialRenewed: true, trialRenewalEnd: true, leaveBalanceDays: true, birthDate: true,
      },
    }),
    // Le TYPE est lu ici pour n'en garder que la NATURE (« Congé » / « Absent ») — il ne part jamais tel quel (§118.184).
    prisma.leaveRequest.findMany({
      where: { employeeId: { in: employeeIds }, status: { in: ["APPROVED", "PENDING"] }, startDate: { lt: dPlageFinExcl }, endDate: { gte: dPlageDebut } },
      select: { employeeId: true, startDate: true, endDate: true, status: true, type: true },
    }),
    prisma.leaveRequest.groupBy({
      by: ["employeeId"],
      where: { employeeId: { in: employeeIds }, status: "APPROVED", startDate: { gte: debutAnnee } },
      _sum: { days: true },
    }),
    userIds.length ? prisma.task.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: userIds }, status: { in: [...TACHE_OUVERTE] } }, _count: { _all: true } }) : [],
    userIds.length ? prisma.task.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: userIds }, status: { in: [...TACHE_EN_COURS] }, dueDate: { lt: maintenant } }, _count: { _all: true } }) : [],
    userIds.length ? prisma.task.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: userIds }, status: "DONE", completedAt: { gte: il30 } }, _count: { _all: true } }) : [],
    repIds.length ? prisma.tourPlan.groupBy({ by: ["repId"], where: { repId: { in: repIds }, status: { in: ["SUBMITTED", "ESCALATED"] } }, _count: { _all: true } }) : [],
    userIds.length ? prisma.missionAssignment.groupBy({ by: ["userId"], where: { userId: { in: userIds }, orderStatus: "REQUESTED", archivedAt: null }, _count: { _all: true } }) : [],
    // Missions Ad & Pro (10/2026) : ni retirées ni déclinées ; leurs PROPRES dates priment (le sponsoring n'en a pas d'autres).
    userIds.length
      ? prisma.missionAssignment.findMany({
          where: { userId: { in: userIds }, archivedAt: null, response: { not: "DECLINEE" } },
          select: { userId: true, entityType: true, entityId: true, dateDepart: true, dateRetour: true, ville: true, response: true },
        })
      : [],
    userIds.length
      ? prisma.trainingParticipant.findMany({
          where: { userId: { in: userIds }, state: { not: "DECLINED" }, training: { status: { in: ["APPROVED", "DONE"] }, startDate: { gte: debutFormations, lt: finFormations } } },
          select: { userId: true, training: { select: { id: true, title: true, startDate: true, endDate: true } } },
        })
      : [],
    userIds.length
      ? prisma.training.findMany({
          where: { requesterId: { in: userIds }, status: { in: ["APPROVED", "DONE"] }, startDate: { gte: debutFormations, lt: finFormations } },
          select: { id: true, requesterId: true, title: true, startDate: true, endDate: true },
        })
      : [],
    repIds.length
      ? prisma.medicalVisit.findMany({
          where: { delegateId: { in: repIds }, date: { gte: debutVisites, lt: finMoisExcl }, status: { not: "CANCELLED" } },
          select: { delegateId: true, doctorId: true, status: true, date: true, report: true },
        })
      : [],
    repIds.length ? panelsDesKams(repIds) : new Map<string, { id: string }[]>(),
    repIds.length
      ? prisma.salesRepProfile.findMany({ where: { repId: { in: repIds } }, select: { repId: true, businessUnit: { select: { name: true } } } })
      : [],
  ]);

  const ficheDe = new Map(fiches.map((f) => [f.id, f]));
  const employeDeUser = new Map(team.members.filter((m) => m.userId).map((m) => [m.userId as string, m.employeeId]));
  const compte = <T extends { _count: { _all: number } }>(rows: T[], cle: (r: T) => string | null) =>
    new Map(rows.map((r) => [cle(r) ?? "", r._count._all]));
  const ouvertesDe = compte(tachesOuvertes, (r) => r.assignedToId);
  const retardDe = compte(tachesRetard, (r) => r.assignedToId);
  const faitesDe = compte(tachesFaites, (r) => r.assignedToId);
  const plansDe = compte(plans, (r) => r.repId);
  const ordresDe = compte(ordres, (r) => r.userId);
  const prisDe = new Map(prisAnnee.map((r) => [r.employeeId, toNumber(r._sum.days) || 0]));
  const buDe = new Map(profils.map((p) => [p.repId, p.businessUnit?.name ?? null]));

  // ── LES ÉVÉNEMENTS DE LA PLAGE ──────────────────────────────────────────────────────────────
  const typePrecis = voitLeTypeDesAbsences(user);
  const evenements: EvenementEquipe[] = conges.map((c) => ({
    employeeId: c.employeeId, genre: natureDeLAbsence(c.type),
    // Le type précis (« Maladie »…) ne part que vers qui gère les RH ; pour tous les autres, `libelle` reste vide.
    debut: jourDuConge(c.startDate), fin: jourDuConge(c.endDate), libelle: typePrecis ? LEAVE_TYPE[c.type] ?? null : null, enAttente: c.status === "PENDING",
  }));

  // Missions : les dates PROPRES à la mission (reprises de la demande, modifiables — Direction 10/2026), sinon celles
  // de la demande. Le sponsoring n'a de dates que celles de la mission. Une demande annulée ou refusée n'emmène personne ;
  // une invitation sans réponse se montre « en attente ».
  const idsPar = (t: string) => [...new Set(assignations.filter((a) => a.entityType === t).map((a) => a.entityId))];
  const [evts, cn, ci, spo] = await Promise.all([
    idsPar("EVENT").length
      ? prisma.event.findMany({ where: { id: { in: idsPar("EVENT") }, status: { not: "CANCELLED" } }, select: { id: true, name: true, city: true, startDate: true, endDate: true } })
      : [],
    idsPar("CONGRESS_NATIONAL").length
      ? prisma.congressNational.findMany({ where: { id: { in: idsPar("CONGRESS_NATIONAL") }, status: { not: "CANCELLED" } }, select: { id: true, name: true, city: true, date: true, endDate: true } })
      : [],
    idsPar("CONGRESS_INTERNATIONAL").length
      ? prisma.congressInternational.findMany({ where: { id: { in: idsPar("CONGRESS_INTERNATIONAL") }, status: { not: "CANCELLED" } }, select: { id: true, name: true, city: true, startDate: true, endDate: true } })
      : [],
    idsPar("SPONSORING").length
      ? prisma.sponsoringRequest.findMany({ where: { id: { in: idsPar("SPONSORING") }, status: { not: "REFUSED" } }, select: { id: true, institution: true, city: true } })
      : [],
  ]);
  const parentMission = new Map<string, { debut: Date | null; fin: Date | null; libelle: string }>();
  for (const e of evts) parentMission.set(`EVENT:${e.id}`, { debut: e.startDate, fin: e.endDate ?? e.startDate, libelle: e.city || e.name });
  for (const e of cn) parentMission.set(`CONGRESS_NATIONAL:${e.id}`, { debut: e.date, fin: e.endDate ?? e.date, libelle: e.city || e.name });
  for (const e of ci) parentMission.set(`CONGRESS_INTERNATIONAL:${e.id}`, { debut: e.startDate, fin: e.endDate ?? e.startDate, libelle: e.city || e.name });
  for (const s of spo) parentMission.set(`SPONSORING:${s.id}`, { debut: null, fin: null, libelle: s.city || s.institution });
  for (const a of assignations) {
    const p = parentMission.get(`${a.entityType}:${a.entityId}`);
    const emp = employeDeUser.get(a.userId);
    const debutDate = a.dateDepart ?? p?.debut ?? null;
    if (!p || !emp || !debutDate) continue;
    const debut = algiersYmd(debutDate);
    const finBrute = algiersYmd(a.dateRetour ?? p.fin ?? debutDate);
    const fin = finBrute < debut ? debut : finBrute;
    if (fin < plageDebut || debut > plageFin) continue;
    evenements.push({ employeeId: emp, genre: "MISSION", debut, fin, libelle: a.ville || p.libelle, enAttente: a.response === "INVITEE" });
  }

  // Formations : participations (hors refus) et demandes accordées — une seule fois par personne et par formation.
  const formationsVues = new Set<string>();
  const formationsAVenir = new Map<string, { titre: string; debut: string }[]>();
  const ajouterFormation = (userId: string | null, t: { id: string; title: string; startDate: Date | null; endDate: Date | null }) => {
    const emp = userId ? employeDeUser.get(userId) : undefined;
    if (!emp || !t.startDate || formationsVues.has(`${emp}:${t.id}`)) return;
    formationsVues.add(`${emp}:${t.id}`);
    const debut = algiersYmd(t.startDate);
    const finBrute = algiersYmd(t.endDate ?? t.startDate);
    const fin = finBrute < debut ? debut : finBrute;
    if (debut > aujourdhui) {
      const l = formationsAVenir.get(emp) ?? [];
      l.push({ titre: t.title, debut });
      formationsAVenir.set(emp, l);
    }
    if (fin >= plageDebut && debut <= plageFin) evenements.push({ employeeId: emp, genre: "FORMATION", debut, fin, libelle: t.title, enAttente: false });
  };
  for (const p of participations) ajouterFormation(p.userId, p.training);
  for (const t of formationsDemandees) ajouterFormation(t.requesterId, t);

  // ── LE TERRAIN : visites, couverture, comptes rendus ────────────────────────────────────────
  const finMoisPrecedentExcl = debutMois;
  const terrain = new Map<string, { faitesMois: number; prevuesMois: number; vusMois: Set<string>; vusPrec: Set<string>; faites30: number; vus30: Set<string>; sansRapportMois: number; sansRapport30: number }>();
  for (const id of repIds) terrain.set(id, { faitesMois: 0, prevuesMois: 0, vusMois: new Set(), vusPrec: new Set(), faites30: 0, vus30: new Set(), sansRapportMois: 0, sansRapport30: 0 });
  for (const v of visites) {
    const t = v.delegateId ? terrain.get(v.delegateId) : undefined;
    if (!t) continue;
    const fait = v.status === "COMPLETED";
    const sansRapport = fait && !(v.report ?? "").trim();
    if (v.date >= debutMois && v.date < finMoisExcl) {
      t.prevuesMois++;
      if (fait) { t.faitesMois++; if (v.doctorId) t.vusMois.add(v.doctorId); if (sansRapport) t.sansRapportMois++; }
    } else if (fait && v.date >= debutMoisPrecedent && v.date < finMoisPrecedentExcl && v.doctorId) {
      t.vusPrec.add(v.doctorId);
    }
    if (fait && v.date >= il30 && v.date <= maintenant) {
      t.faites30++;
      if (v.doctorId) t.vus30.add(v.doctorId);
      if (sansRapport) t.sansRapport30++;
    }
  }
  const panelDe = (repId: string) => panels.get(repId)?.length ?? 0;
  const panelTotal = repIds.reduce((s, r) => s + panelDe(r), 0);
  const couverture = panelTotal > 0
    ? {
        mois: pct(repIds.reduce((s, r) => s + (terrain.get(r)?.vusMois.size ?? 0), 0), panelTotal) ?? 0,
        moisPrecedent: pct(repIds.reduce((s, r) => s + (terrain.get(r)?.vusPrec.size ?? 0), 0), panelTotal),
        objectif: DEFAULT_THRESHOLDS.coveragePct,
      }
    : null;

  // ── LES ANNIVERSAIRES de la plage (jour et mois seulement) ──────────────────────────────────
  const anniversaires: { employeeId: string; jour: string }[] = [];
  const annees = [...new Set([plageDebut.slice(0, 4), plageFin.slice(0, 4)])];
  for (const f of fiches) {
    if (!f.birthDate) continue;
    const mmjj = f.birthDate.toISOString().slice(5, 10);
    for (const a of annees) {
      const jour = `${a}-${mmjj}`;
      if (jour >= plageDebut && jour <= plageFin) anniversaires.push({ employeeId: f.id, jour });
    }
  }

  // ── LES LIGNES ─────────────────────────────────────────────────────────────────────────────
  const nomDe = new Map(team.members.map((m) => [m.employeeId, m.fullName]));
  const priorite: Record<GenreEvenement, number> = { CONGE: 0, ABSENCE: 0, MISSION: 1, FORMATION: 2 };
  const lignes: LigneEquipe[] = team.members.map((m) => {
    const f = ficheDe.get(m.employeeId);
    const metier = metierDe.get(m.employeeId) ?? "GENERIC";
    const t = m.userId ? terrain.get(m.userId) : undefined;
    const duJour = evenements
      .filter((e) => e.employeeId === m.employeeId && !e.enAttente && e.debut <= aujourdhui && aujourdhui <= e.fin)
      .sort((a, b) => priorite[a.genre] - priorite[b.genre])[0];

    const alertes: AlerteEquipe[] = [];
    const finContrat = f?.contractEnd ? jourDuConge(f.contractEnd) : null;
    if (finContrat) {
      const j = ecartJours(aujourdhui, finContrat);
      if (j <= 60) alertes.push({
        employeeId: m.employeeId, genre: "CONTRAT", ton: j <= 15 ? "danger" : "warning", rang: j <= 15 ? 0 : 2,
        court: j < 0 ? "contrat échu" : `contrat ${j} j`,
        texte: j < 0 ? `Contrat échu depuis ${-j} j` : `Fin de contrat dans ${j} j`,
      });
    }
    const finEssaiBrute = f ? (f.trialRenewed && f.trialRenewalEnd ? f.trialRenewalEnd : f.trialEnd) : null;
    const finEssai = finEssaiBrute ? jourDuConge(finEssaiBrute) : null;
    if (finEssai) {
      const j = ecartJours(aujourdhui, finEssai);
      if (j >= 0 && j <= 30) alertes.push({
        employeeId: m.employeeId, genre: "ESSAI", ton: j <= 7 ? "danger" : "warning", rang: j <= 7 ? 1 : 3,
        court: `essai ${j} j`, texte: `Fin de période d'essai dans ${j} j`,
      });
    }
    const solde = f ? toNumber(f.leaveBalanceDays) : 0;
    if (solde > 30) alertes.push({
      employeeId: m.employeeId, genre: "SOLDE", ton: "warning", rang: 4,
      court: `solde ${solde} j`, texte: `${solde} j de congés — au-delà de 30 j : planifier`,
    });
    if (t && t.sansRapport30 > 0) alertes.push({
      employeeId: m.employeeId, genre: "RAPPORTS", ton: "info", rang: 5,
      court: `${t.sansRapport30} sans rapport`, texte: `${t.sansRapport30} visite(s) sans compte rendu (30 j)`,
    });
    const anniv = anniversaires.find((a) => a.employeeId === m.employeeId && semaine.includes(a.jour));
    if (anniv) alertes.push({
      employeeId: m.employeeId, genre: "ANNIVERSAIRE", ton: "success", rang: 6,
      court: "anniversaire", texte: `Anniversaire ${JOURS_COURTS[dowDe(anniv.jour)]} ${Number(anniv.jour.slice(8, 10))}`,
    });
    alertes.sort((a, b) => a.rang - b.rang);

    return {
      employeeId: m.employeeId,
      userId: m.userId,
      nom: m.fullName,
      depth: m.depth,
      direct: m.depth === 1,
      nPlus1: m.managerEmployeeId ? nomDe.get(m.managerEmployeeId) ?? null : null,
      poste: m.position,
      rattachement: (m.userId ? buDe.get(m.userId) : null) ?? m.department,
      metier,
      depuis: m.hiredAt,
      aujourdhui: duJour
        ? { genre: duJour.genre, jusquAu: duJour.fin, libelle: duJour.libelle }
        : { genre: "PRESENT", jusquAu: null, libelle: null },
      activite: t
        ? { type: "VISITES", visites: t.faites30, couverture: pct(t.vus30.size, panelDe(m.userId as string)) }
        : m.userId ? { type: "TACHES", faites: faitesDe.get(m.userId) ?? 0 } : null,
      taches: { ouvertes: m.userId ? ouvertesDe.get(m.userId) ?? 0 : 0, enRetard: m.userId ? retardDe.get(m.userId) ?? 0 : 0 },
      solde,
      prisAnnee: prisDe.get(m.employeeId) ?? 0,
      prochainConge: m.nextLeave ? { debut: jourDuConge(new Date(m.nextLeave.start)), fin: jourDuConge(new Date(m.nextLeave.end)) } : null,
      alertes,
      terrainMois: t
        ? { faites: t.faitesMois, prevues: t.prevuesMois, couverture: pct(t.vusMois.size, panelDe(m.userId as string)), sansRapport: t.sansRapportMois }
        : null,
      enCours: {
        plansEnAttente: m.userId ? plansDe.get(m.userId) ?? 0 : 0,
        ordresMission: m.userId ? ordresDe.get(m.userId) ?? 0 : 0,
        formations: (formationsAVenir.get(m.employeeId) ?? []).sort((a, b) => a.debut.localeCompare(b.debut)).slice(0, 3),
      },
      contrat: {
        type: f?.contractType ? CONTRACT_TYPE[f.contractType] ?? f.contractType : null,
        debut: f?.contractStart ? jourDuConge(f.contractStart) : f?.hireDate ? jourDuConge(f.hireDate) : null,
        fin: finContrat,
        finEssai: finEssai && finEssai >= aujourdhui ? finEssai : null,
      },
      aDecider: m.pending,
    };
  });

  return { ...base, lignes, evenements, anniversaires, couverture };
}
