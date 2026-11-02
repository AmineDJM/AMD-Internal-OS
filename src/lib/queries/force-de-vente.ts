import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { chargerLiensAdPro } from "@/modules/ad-pro/api";
import { getSfeConfig, type RepScope } from "@/lib/sfe";
import { panelsDesKams, kamsQuiCouvrent } from "@/lib/queries/panel-kam";
import { loadTourneeDirection } from "@/lib/queries/tour-schedule";
import { chargerSegmentations, indexerLettres, type SegmentationBu } from "@/lib/segmentation/lettres-service";
import { requisDuPraticien } from "@/lib/segmentation/lettre-requise";
import { grilleDuSecteur, type Lettre, type Statut } from "@/lib/segmentation/regles";
import { PROPOSITION, chargeDe, contactsDe, matriceDe, type Ton } from "@/lib/segmentation/charge";
import {
  jourDuCycle, attenduAuJour, realiseRequis, couvertureAFrequence, trierParRetard, cyclesSansVisite, aVoirEnPriorite,
  etatPlan, coachingEnRetard, horsPanelParSecteur, moisPrecedent, type PraticienSuivi, type EtatPlan, type CibleAVoir,
} from "@/lib/force-de-vente/calculs";

/**
 * FORCE DE VENTE — l'outil du superviseur et de la Direction (Direction, 07/10). Façade de lecture : le pilotage par
 * BU, les territoires, les produits par délégué, la fiche d'un délégué. Tout se lit dans ce qui existe — annuaire,
 * segmentation, visites, plans de tournée, coaching, Ad & Pro. Rien ne se ressaisit.
 *
 * LE REQUIS est UN seul nombre : la lettre de segmentation de chaque praticien du panel et sa fréquence (lettre ×
 * In/Out × secteur), stratégie de la BU du délégué d'abord ; le palier de potentiel seulement pour un praticien rangé
 * dans aucune stratégie (`requisDuPraticien`). Les calculs sont dans `lib/force-de-vente/calculs.ts` (purs, testés).
 */

const ROLES_KAM = ["MEDICAL_DELEGATE", "NATIONAL_SALES"] as const;

export interface BuVisible { id: string; nom: string; couleur: string | null }

/** Les BU que la portée montre : toutes (portée entière), celles qu'on supervise, ou celle du KAM. */
export async function busDuPerimetre(scope: RepScope, userId: string): Promise<BuVisible[]> {
  const where = scope.mode === "all"
    ? { isActive: true }
    : scope.mode === "team"
      ? { id: { in: scope.buIds } }
      : { id: { in: (await prisma.salesRepProfile.findMany({ where: { repId: userId }, select: { businessUnitId: true } })).flatMap((p) => (p.businessUnitId ? [p.businessUnitId] : [])) } };
  const bus = await prisma.businessUnit.findMany({ where, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, color: true } });
  return bus.map((b) => ({ id: b.id, nom: b.name, couleur: b.color }));
}

export interface KamDuPerimetre {
  repId: string;
  nom: string;
  buId: string | null;
  buNom: string | null;
  secteurNom: string | null;
}

/** Les délégués de la portée (comptes actifs, rôle terrain), bornés à la BU choisie. */
export async function kamsDuPerimetre(scope: RepScope, buId: string | null): Promise<KamDuPerimetre[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter([...ROLES_KAM]), ...(scope.repIds ? { id: { in: scope.repIds } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const ids = users.map((u) => u.id);
  const [profils, secteurs] = await Promise.all([
    prisma.salesRepProfile.findMany({ where: { repId: { in: ids } }, select: { repId: true, businessUnitId: true, businessUnit: { select: { name: true } } } }),
    prisma.salesSector.findMany({
      where: { isActive: true, OR: [{ repId: { in: ids } }, { reps: { some: { repId: { in: ids } } } }] },
      orderBy: { name: "asc" },
      select: { name: true, repId: true, businessUnitId: true, reps: { select: { repId: true } } },
    }),
  ]);
  const profil = new Map(profils.map((p) => [p.repId, p]));
  return users
    .map((u) => {
      const p = profil.get(u.id);
      const s = secteurs.find((x) => x.businessUnitId === p?.businessUnitId && (x.repId === u.id || x.reps.some((r) => r.repId === u.id)));
      return { repId: u.id, nom: u.name, buId: p?.businessUnitId ?? null, buNom: p?.businessUnit?.name ?? null, secteurNom: s?.name ?? null };
    })
    .filter((k) => !buId || k.buId === buId);
}

// ───────────────────────────────────────── LE PILOTAGE ─────────────────────────────────────────

export interface LigneDelegue extends KamDuPerimetre {
  couverture: { cibles: number; vues: number; pct: number | null };
  realise: number;
  requis: number;
  attendu: number;
  plan: { etat: EtatPlan; planId: string | null; enRetard: boolean };
  rapportsEnRetard: number;
  /** Taux réalisé ÷ requis des 6 derniers cycles (le dernier = le cycle en cours, calculé en direct). */
  tendance: (number | null)[];
}

export interface Pilotage {
  jour: number;
  total: number;
  tuiles: {
    couverture: { pct: number | null; cibles: number; vues: number; delta: number | null };
    contacts: { realise: number; requis: number; attendu: number };
    plans: { valides: number; total: number; aValider: number };
    rapports: { enRetard: number; delegues: number };
  };
  lignes: LigneDelegue[];
  aTraiter: {
    plansAValider: { repId: string; nom: string; planId: string | null }[];
    ciblesNonVues: { total: number; decideurs: number };
    secteursVacants: { id: string; nom: string; buId: string; buNom: string; cibles: number; enA: number }[];
    coachingsEnRetard: { repId: string; nom: string; dernier: Date | null }[];
  };
  /** Les praticiens de chaque panel, pour la fiche d'un délégué (sans relire la base). */
  panels: Map<string, PraticienPanel[]>;
  segmentations: SegmentationBu[];
}

export interface PraticienPanel extends PraticienSuivi {
  nom: string;
  lieu: string | null;
  statut: Statut | null;
  derniereVisite: Date | null;
}

const debutMois = (y: number, m: number) => new Date(y, m - 1, 1);

/** Visites TERMINÉES par (délégué, praticien) sur une fenêtre. */
async function visitesParPaire(repIds: readonly string[], debut: Date, fin: Date): Promise<Map<string, number>> {
  if (repIds.length === 0) return new Map();
  const g = await prisma.medicalVisit.groupBy({
    by: ["delegateId", "doctorId"],
    where: { delegateId: { in: [...repIds] }, status: "COMPLETED", date: { gte: debut, lt: fin } },
    _count: { _all: true },
  });
  return new Map(g.filter((x) => x.delegateId && x.doctorId).map((x) => [`${x.delegateId}::${x.doctorId}`, x._count._all]));
}

export async function chargerPilotage(input: {
  scope: RepScope;
  userId: string;
  buId: string | null;
  year: number;
  month: number;
  maintenant?: Date;
}): Promise<Pilotage> {
  const { scope, buId, year, month } = input;
  const maintenant = input.maintenant ?? new Date();
  const debut = debutMois(year, month), fin = debutMois(year, month + 1);
  const prec = moisPrecedent(year, month);
  const { jour, total } = jourDuCycle(year, month, maintenant);

  const [config, kams] = await Promise.all([getSfeConfig(), kamsDuPerimetre(scope, buId)]);
  const repIds = kams.map((k) => k.repId);
  const [panels, segmentations] = await Promise.all([panelsDesKams(repIds), chargerSegmentations()]);
  const lettres = indexerLettres(segmentations);
  const doctorIds = [...new Set([...panels.values()].flat().map((d) => d.id))];

  const [ceMois, moisAvant, docs, dernieres, tournees, plans, historique, coachings] = await Promise.all([
    visitesParPaire(repIds, debut, fin),
    visitesParPaire(repIds, debutMois(prec.y, prec.m), debut),
    prisma.medicalDoctor.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, name: true, institution: true, institutionRef: { select: { name: true } } },
    }),
    doctorIds.length
      ? prisma.medicalVisit.groupBy({ by: ["doctorId"], where: { doctorId: { in: doctorIds }, status: "COMPLETED" }, _max: { date: true } })
      : Promise.resolve([]),
    loadTourneeDirection(repIds, debut, new Date(year, month, 0, 23, 59, 59, 999), maintenant),
    prisma.tourPlan.findMany({
      where: { repId: { in: repIds }, periodStart: { lt: fin }, periodEnd: { gte: debut } },
      orderBy: { periodStart: "desc" },
      select: { id: true, repId: true },
    }),
    prisma.salesRepMonthlyKpi.findMany({
      where: { repId: { in: repIds }, OR: Array.from({ length: 5 }, (_, i) => { const d = new Date(year, month - 2 - i, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; }) },
      select: { repId: true, year: true, month: true, realVisits: true, requiredVisits: true },
    }),
    scope.mode === "self" ? Promise.resolve([]) : prisma.coachingSheet.groupBy({ by: ["collaboratorId"], where: { collaboratorId: { in: repIds } }, _max: { visitDate: true } }),
  ]);
  const docParId = new Map(docs.map((d) => [d.id, d]));
  const derniere = new Map(dernieres.map((g) => [g.doctorId ?? "", g._max.date ?? null]));
  const tourneeDe = new Map(tournees.lignes.map((l) => [l.repId, l]));
  const planDe = new Map<string, string>();
  for (const p of plans) if (!planDe.has(p.repId)) planDe.set(p.repId, p.id);

  const lignes: LigneDelegue[] = [];
  const panelsSuivis = new Map<string, PraticienPanel[]>();
  let cibles = 0, vues = 0, ciblesAvant = 0, vuesAvant = 0;
  const ciblesHA = new Map<string, Statut | null>();
  for (const k of kams) {
    const praticiens: PraticienPanel[] = (panels.get(k.repId) ?? []).map((d) => {
      const r = requisDuPraticien(lettres.get(d.id), k.buId, d.potential, config.frequencyByTier);
      const doc = docParId.get(d.id);
      return {
        doctorId: d.id, lettre: r.lettre, requis: r.visites, faites: ceMois.get(`${k.repId}::${d.id}`) ?? 0,
        nom: doc?.name ?? "Praticien", lieu: doc?.institutionRef?.name ?? doc?.institution ?? null,
        statut: r.statut, derniereVisite: derniere.get(d.id) ?? null,
      };
    });
    panelsSuivis.set(k.repId, praticiens);
    const cov = couvertureAFrequence(praticiens);
    const covAvant = couvertureAFrequence(praticiens.map((p) => ({ ...p, faites: moisAvant.get(`${k.repId}::${p.doctorId}`) ?? 0 })));
    cibles += cov.cibles; vues += cov.vues; ciblesAvant += covAvant.cibles; vuesAvant += covAvant.vues;
    for (const p of praticiens) {
      if ((p.lettre === "H" || p.lettre === "A") && (cyclesSansVisite(p.derniereVisite, year, month) ?? Infinity) >= 2) ciblesHA.set(p.doctorId, p.statut);
    }
    const rr = realiseRequis(praticiens);
    const t = tourneeDe.get(k.repId);
    const hist = historique.filter((h) => h.repId === k.repId);
    const tendance = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(year, month - 6 + i, 1);
      const h = hist.find((x) => x.year === d.getFullYear() && x.month === d.getMonth() + 1);
      return h && h.requiredVisits > 0 ? Math.min(1, h.realVisits / h.requiredVisits) : null;
    });
    lignes.push({
      ...k,
      couverture: cov,
      realise: rr.realise,
      requis: Math.round(rr.requis),
      attendu: attenduAuJour(rr.requis, jour, total),
      plan: { etat: etatPlan(t?.statutPlan ?? null), planId: planDe.get(k.repId) ?? null, enRetard: t?.retard.enRetard ?? false },
      rapportsEnRetard: t?.avancement.perdues ?? 0,
      tendance: [...tendance, rr.requis > 0 ? Math.min(1, rr.realise / rr.requis) : null],
    });
  }
  const triees = trierParRetard(lignes);

  // ── À TRAITER ─────────────────────────────────────────────────────────────────────────────
  const plansAValider = triees.filter((l) => l.plan.etat === "A_VALIDER").map((l) => ({ repId: l.repId, nom: l.nom, planId: l.plan.planId }));
  const secteursVacants = scope.mode === "self" ? [] : await secteursSansDelegue(scope, buId, segmentations);
  const dernierCoaching = new Map((coachings as { collaboratorId: string; _max: { visitDate: Date | null } }[]).map((c) => [c.collaboratorId, c._max.visitDate]));
  const coachingsEnRetard = scope.mode === "self" ? [] : kams
    .filter((k) => coachingEnRetard(dernierCoaching.get(k.repId) ?? null, maintenant))
    .map((k) => ({ repId: k.repId, nom: k.nom, dernier: dernierCoaching.get(k.repId) ?? null }));

  const sommes = triees.reduce((s, l) => ({ realise: s.realise + l.realise, requis: s.requis + l.requis }), { realise: 0, requis: 0 });
  const pct = cibles ? Math.round((vues / cibles) * 100) : null;
  const pctAvant = ciblesAvant ? Math.round((vuesAvant / ciblesAvant) * 100) : null;
  return {
    jour, total,
    tuiles: {
      couverture: { pct, cibles, vues, delta: pct !== null && pctAvant !== null ? pct - pctAvant : null },
      contacts: { realise: sommes.realise, requis: sommes.requis, attendu: attenduAuJour(sommes.requis, jour, total) },
      plans: { valides: triees.filter((l) => l.plan.etat === "VALIDE").length, total: triees.length, aValider: plansAValider.length },
      rapports: { enRetard: triees.reduce((s, l) => s + l.rapportsEnRetard, 0), delegues: triees.filter((l) => l.rapportsEnRetard > 0).length },
    },
    lignes: triees,
    aTraiter: {
      plansAValider,
      ciblesNonVues: { total: ciblesHA.size, decideurs: [...ciblesHA.values()].filter((s) => s === "DECIDEUR").length },
      secteursVacants,
      coachingsEnRetard,
    },
    panels: panelsSuivis,
    segmentations,
  };
}

/** Les secteurs ACTIFS sans délégué actif, et ce qu'ils laissent sans suivi (cibles de la segmentation, dont en A). */
async function secteursSansDelegue(scope: RepScope, buId: string | null, segmentations: readonly SegmentationBu[]) {
  const buIds = buId ? [buId] : scope.mode === "team" ? scope.buIds : null;
  const secteurs = await prisma.salesSector.findMany({
    where: {
      isActive: true, ...(buIds ? { businessUnitId: { in: buIds } } : {}),
      NOT: { OR: [{ rep: { isActive: true } }, { reps: { some: { rep: { isActive: true } } } }] },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, businessUnitId: true, businessUnit: { select: { name: true } } },
  });
  return secteurs.map((s) => {
    const lignes = segmentations.find((x) => x.buId === s.businessUnitId)?.lignes.filter((l) => l.secteurId === s.id) ?? [];
    const lettres = lignes.map((l) => l.resultat?.lettre ?? null);
    return {
      id: s.id, nom: s.name, buId: s.businessUnitId, buNom: s.businessUnit.name,
      cibles: lettres.filter((l) => l !== null && l !== "NC" && l !== "NA").length,
      enA: lettres.filter((l) => l === "A").length,
    };
  });
}

// ─────────────────────────────────────── LA FICHE D'UN DÉLÉGUÉ ───────────────────────────────────────

export interface FicheDelegue {
  ligne: LigneDelegue;
  superviseur: string | null;
  parLettre: { lettre: "H" | "A" | "B" | "C" | "D"; cibles: number; vues: number }[];
  aVoir: CibleAVoir[];
  adPro: { id: string; nom: string; nature: string; date: Date | null; medecins: number; h: number }[];
  messagesCeCycle: number;
  dernierCoaching: Date | null;
}

/** La fiche d'un délégué — lue sur le pilotage déjà chargé, plus ce qui n'y est pas (Ad & Pro, messages, coaching). */
export async function chargerFicheDelegue(pilotage: Pilotage, repId: string, year: number, month: number): Promise<FicheDelegue | null> {
  const ligne = pilotage.lignes.find((l) => l.repId === repId);
  if (!ligne) return null;
  const praticiens = pilotage.panels.get(repId) ?? [];
  const ids = praticiens.map((p) => p.doctorId);
  const ilYA12Mois = new Date(year - 1, month - 1, 1);
  const [bu, beneficiaires, messages, coaching] = await Promise.all([
    ligne.buId ? prisma.businessUnit.findUnique({ where: { id: ligne.buId }, select: { supervisorId: true } }) : Promise.resolve(null),
    ids.length
      ? prisma.careBeneficiary.findMany({
        where: {
          doctorId: { in: ids }, status: { notIn: ["REJECTED", "WITHDRAWN"] },
          OR: [{ congressNational: { date: { gte: ilYA12Mois } } }, { congressInternational: { startDate: { gte: ilYA12Mois } } }],
        },
        select: {
          doctorId: true,
          congressNational: { select: { id: true, name: true, date: true } },
          congressInternational: { select: { id: true, name: true, startDate: true } },
        },
      })
      : Promise.resolve([]),
    prisma.medicalVisitMessage.count({ where: { visit: { delegateId: repId, status: "COMPLETED", date: { gte: debutMois(year, month), lt: debutMois(year, month + 1) } } } }),
    prisma.coachingSheet.findFirst({ where: { collaboratorId: repId }, orderBy: { visitDate: "desc" }, select: { visitDate: true } }),
  ]);
  const superviseur = bu?.supervisorId ? (await prisma.user.findUnique({ where: { id: bu.supervisorId }, select: { name: true } }))?.name ?? null : null;

  const lettreDe = new Map(praticiens.map((p) => [p.doctorId, p.lettre]));
  const parCongres = new Map<string, { id: string; nom: string; nature: string; date: Date | null; medecins: Set<string>; h: Set<string> }>();
  for (const b of beneficiaires) {
    const c = b.congressNational ?? b.congressInternational;
    if (!c || !b.doctorId) continue;
    const nature = b.congressNational ? "Congrès national" : "Congrès international";
    const date = b.congressNational?.date ?? b.congressInternational?.startDate ?? null;
    const cur = parCongres.get(c.id) ?? { id: c.id, nom: c.name, nature, date, medecins: new Set<string>(), h: new Set<string>() };
    cur.medecins.add(b.doctorId);
    if (lettreDe.get(b.doctorId) === "H") cur.h.add(b.doctorId);
    parCongres.set(c.id, cur);
  }

  return {
    ligne,
    superviseur,
    parLettre: (["H", "A", "B", "C", "D"] as const).map((lettre) => {
      const c = praticiens.filter((p) => p.lettre === lettre && p.requis > 0);
      return { lettre, cibles: c.length, vues: c.filter((p) => p.faites >= p.requis).length };
    }),
    aVoir: aVoirEnPriorite(praticiens.flatMap((p) => (p.lettre === "H" || p.lettre === "A"
      ? [{ doctorId: p.doctorId, nom: p.nom, lieu: p.lieu, lettre: p.lettre as Lettre, statut: p.statut, cycles: cyclesSansVisite(p.derniereVisite, year, month) }]
      : []))),
    adPro: [...parCongres.values()]
      .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
      .slice(0, 4)
      .map((c) => ({ id: c.id, nom: c.nom, nature: c.nature, date: c.date, medecins: c.medecins.size, h: c.h.size })),
    messagesCeCycle: messages,
    dernierCoaching: coaching?.visitDate ?? null,
  };
}

// ─────────────────────────────────── LE PRATICIEN VU PAR LA FORCE DE VENTE ───────────────────────────────────

export interface FdvDuPraticien {
  lettres: { buNom: string; strategieId: string; lettre: Lettre; statut: Statut | null; visites: number }[];
  kams: { id: string; nom: string }[];
  derniereVisite: { date: Date; delegue: string | null } | null;
  /** Les messages portés lors de ses 3 dernières visites terminées (titres distincts). */
  messages: string[];
  adPro: { id: string; nom: string; nature: string; date: Date | null }[];
}

/**
 * LA FICHE D'UN PRATICIEN, CÔTÉ FORCE DE VENTE (Direction, 07/10 — « Annuaires branchés ») : sa lettre et son statut dans
 * chaque stratégie, son délégué (rattaché, ou KAM dont le panel le couvre), sa dernière visite, les messages reçus, et ce
 * qu'il a reçu en Ad & Pro (prises en charge de congrès, 12 mois). L'appelant a déjà vérifié qu'il voit ce praticien.
 */
export async function chargerFdvDuPraticien(doctorId: string, maintenant = new Date()): Promise<FdvDuPraticien> {
  const ilYA12Mois = new Date(maintenant.getFullYear() - 1, maintenant.getMonth(), maintenant.getDate());
  const [segmentations, doc, couverts, visites, beneficiaires, liens] = await Promise.all([
    chargerSegmentations({ doctorIds: [doctorId] }),
    prisma.medicalDoctor.findUnique({ where: { id: doctorId }, select: { delegate: { select: { id: true, name: true, isActive: true } } } }),
    kamsQuiCouvrent([doctorId]),
    prisma.medicalVisit.findMany({
      where: { doctorId, status: "COMPLETED" }, orderBy: { date: "desc" }, take: 3,
      select: { date: true, delegate: { select: { name: true } }, messageLinks: { select: { message: { select: { title: true } } } } },
    }),
    prisma.careBeneficiary.findMany({
      where: {
        doctorId, status: { notIn: ["REJECTED", "WITHDRAWN"] },
        OR: [{ congressNational: { date: { gte: ilYA12Mois } } }, { congressInternational: { startDate: { gte: ilYA12Mois } } }],
      },
      select: { congressNational: { select: { id: true, name: true, date: true } }, congressInternational: { select: { id: true, name: true, startDate: true } } },
    }),
    // LES MÉDECINS CONCERNÉS reliés à l'annuaire (Direction, 08/10) : sponsoring, événement, matériel, autres demandes — et les congrès.
    chargerLiensAdPro([doctorId], ilYA12Mois),
  ]);
  const kams = new Map<string, string>();
  if (doc?.delegate?.isActive) kams.set(doc.delegate.id, doc.delegate.name);
  for (const k of couverts.get(doctorId) ?? []) kams.set(k.id, k.name);
  return {
    lettres: segmentations.flatMap((s) => s.lignes.filter((l) => l.doctorId === doctorId && l.resultat).map((l) => ({
      buNom: s.buNom, strategieId: s.strategie.id, lettre: l.resultat!.lettre, statut: l.statut, visites: l.resultat!.visites,
    }))),
    kams: [...kams].map(([id, nom]) => ({ id, nom })),
    derniereVisite: visites[0] ? { date: visites[0].date, delegue: visites[0].delegate?.name ?? null } : null,
    messages: [...new Set(visites.flatMap((v) => v.messageLinks.map((m) => m.message.title)))],
    adPro: [
      ...beneficiaires.flatMap((b) => {
        if (b.congressNational) return [{ id: b.congressNational.id, nom: b.congressNational.name, nature: "Congrès national", date: b.congressNational.date }];
        if (b.congressInternational) return [{ id: b.congressInternational.id, nom: b.congressInternational.name, nature: "Congrès international", date: b.congressInternational.startDate }];
        return [];
      }),
      // Une demande déjà lue par les prises en charge n'est pas comptée deux fois.
      ...liens
        .filter((l) => !beneficiaires.some((b) => (l.nature === "CONGRESS_NATIONAL" ? b.congressNational?.id : l.nature === "CONGRESS_INTERNATIONAL" ? b.congressInternational?.id : null) === l.entityId))
        .map((l) => ({ id: l.entityId, nom: l.nom, nature: l.natureLibelle, date: l.date as Date | null })),
    ],
  };
}

// ───────────────────────────────────────── LES TERRITOIRES ─────────────────────────────────────────

export interface LigneSecteur {
  id: string;
  nom: string;
  delegues: { id: string; nom: string }[];
  etablissements: number;
  panel: Record<"H" | "A" | "B" | "C" | "D", number>;
  charge: { parJour: number; cap: number; taux: number; ton: Ton } | null;
  horsPanel: { doctorId: string; nom: string; lieu: string | null; lettre: Lettre; statut: Statut | null }[];
}

export interface TerritoiresBu { buId: string; buNom: string; segmentee: boolean; secteurs: LigneSecteur[] }

/**
 * Les secteurs de chaque BU de la portée : délégué (ou vacant), établissements, panel par lettre (la segmentation du
 * secteur), CHARGE face à la capacité (la règle et les valeurs de l'écran Segmentation : `matriceDe`, `contactsDe`,
 * `chargeDe`), et les cibles H ou A HORS PANEL — classées dans le secteur mais qu'aucun panel de KAM ne contient.
 */
export async function chargerTerritoires(scope: RepScope, userId: string, buId: string | null): Promise<TerritoiresBu[]> {
  const bus = (await busDuPerimetre(scope, userId)).filter((b) => !buId || b.id === buId);
  if (bus.length === 0) return [];
  const [secteurs, segmentations] = await Promise.all([
    prisma.salesSector.findMany({
      where: {
        isActive: true, businessUnitId: { in: bus.map((b) => b.id) },
        ...(scope.mode === "self" ? { OR: [{ repId: userId }, { reps: { some: { repId: userId } } }] } : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, businessUnitId: true,
        rep: { select: { id: true, name: true, isActive: true } },
        reps: { select: { rep: { select: { id: true, name: true, isActive: true } } } },
        _count: { select: { institutions: true } },
      },
    }),
    chargerSegmentations({ buIds: bus.map((b) => b.id) }),
  ]);

  // HORS PANEL : les H et A rangés dans un secteur, sans délégué rattaché ni KAM dont le panel les couvre.
  const candidats = segmentations.flatMap((s) => s.lignes.filter((l) => l.secteurId && (l.resultat?.lettre === "H" || l.resultat?.lettre === "A")));
  const ids = [...new Set(candidats.map((l) => l.doctorId))];
  const [couverts, rattaches] = await Promise.all([
    kamsQuiCouvrent(ids),
    prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: { id: true, delegateId: true, delegate: { select: { isActive: true } } } }),
  ]);
  const dansUnPanel = new Set<string>([
    ...ids.filter((id) => (couverts.get(id) ?? []).length > 0),
    ...rattaches.filter((d) => d.delegateId && d.delegate?.isActive).map((d) => d.id),
  ]);

  return bus.map((b) => {
    const seg = segmentations.find((s) => s.buId === b.id) ?? null;
    const regles = seg?.strategie.regle?.regles ?? null;
    const capacite = regles?.capacite ?? PROPOSITION.capacite;
    const lignes = seg?.lignes ?? [];
    const hors = horsPanelParSecteur(lignes.map((l) => ({ doctorId: l.doctorId, lettre: l.resultat?.lettre ?? null, secteurId: l.secteurId })), dansUnPanel);
    return {
      buId: b.id, buNom: b.nom, segmentee: !!seg,
      secteurs: secteurs.filter((s) => s.businessUnitId === b.id).map((s) => {
        const delegues = new Map<string, string>();
        if (s.rep?.isActive) delegues.set(s.rep.id, s.rep.name);
        for (const r of s.reps) if (r.rep.isActive) delegues.set(r.rep.id, r.rep.name);
        const duSecteur = lignes.filter((l) => l.secteurId === s.id);
        const lettres = duSecteur.map((l) => l.resultat?.lettre ?? null);
        const panel = { H: 0, A: 0, B: 0, C: 0, D: 0 };
        for (const l of lettres) if (l === "H" || l === "A" || l === "B" || l === "C" || l === "D") panel[l]++;
        let charge: LigneSecteur["charge"] = null;
        if (seg && delegues.size > 0) {
          const grille = regles?.grille ? grilleDuSecteur(regles.grille, s.id) : { ...PROPOSITION.grille };
          const contacts = contactsDe(matriceDe(duSecteur.map((l) => ({ lettre: l.resultat?.lettre ?? "NA", inOut: l.inOut }))), grille).total;
          const c = chargeDe(contacts, capacite, delegues.size);
          charge = { parJour: c.parJour, cap: capacite.contactsParJour, taux: c.taux, ton: c.ton };
        }
        const horsIds = new Set(hors.get(s.id) ?? []);
        return {
          id: s.id, nom: s.name,
          delegues: [...delegues].map(([id, nom]) => ({ id, nom })),
          etablissements: s._count.institutions,
          panel, charge,
          horsPanel: duSecteur.filter((l) => horsIds.has(l.doctorId)).map((l) => ({
            doctorId: l.doctorId, nom: l.nom, lieu: l.etablissement, lettre: l.resultat!.lettre, statut: l.statut,
          })),
        };
      }),
    };
  });
}
