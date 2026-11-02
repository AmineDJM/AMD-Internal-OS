import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { platformScope } from "@/lib/company";
import { chargerTableauKpi } from "@/lib/kpi/service";
import { consommationMoyenne } from "@/lib/stocks/pch-central";
import { decalerMois } from "@/lib/ventes-pch/calculs";
import { chargerRapportsTerrain } from "@/lib/voix-terrain/rapports";
import { voixDuTerrain } from "@/lib/voix-terrain-luna";
import type { VoixTerrain } from "@/lib/voix-terrain/pur";
import type { LigneDelegue } from "@/lib/queries/force-de-vente";
import {
  chevauche, relevesHopitaux, scoreEquipe, septJours, signaleUneRupture, statutDuJour, trierSemaine, villeDuJour, visitesDuJour,
  type EvenementSemaine, type LigneReleve, type SignalementRupture, type StatutDuJour,
} from "@/lib/cockpit-operations/terrain";
import { sansBloquer } from "@/lib/journal";

/**
 * COCKPIT OPÉRATIONS · LE TERRAIN — les lectures ajoutées par la maquette validée (10/2026) : l'équipe aujourd'hui
 * (plans, missions, congés, visites, rapports, couverture, KPI), les remontées du terrain (Luna, 7 jours), les stocks
 * relevés dans les hôpitaux, la semaine (missions, livraisons PCH, coachings), les ruptures signalées dans les rapports.
 * Les calculs sont purs (`cockpit-operations/terrain.ts`). Chaque bloc n'est lu que si la personne voit son écran.
 */

const JOUR = 86_400_000;

export interface LigneEquipe {
  repId: string;
  nom: string;
  jour: StatutDuJour;
  visites: { prevues: number; realisees: number };
  rapportsEnRetard: number;
  /** Couverture H·A·B à fréquence (%) — null sans cible. */
  couverture: number | null;
  /** Score KPI de la période — null si non noté ou non visible. */
  kpi: number | null;
}

export interface TerrainOperations {
  equipe: LigneEquipe[];
  visites: { prevues: number; realisees: number };
  kpi: { ouvert: boolean; score: number | null; notes: number };
  semaine: EvenementSemaine[];
}

const debutDuJour = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Les noms des congrès et événements d'une liste de missions. */
async function nomsDesMissions(m: readonly { entityType: string; entityId: string }[]): Promise<Map<string, string>> {
  const ids = (t: string) => m.filter((x) => x.entityType === t).map((x) => x.entityId);
  const [cn, ci, ev] = await Promise.all([
    ids("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ids("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ids("EVENT").length ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  return new Map([
    ...cn.map((x) => [`CONGRESS_NATIONAL:${x.id}`, `congrès ${x.name}`] as const),
    ...ci.map((x) => [`CONGRESS_INTERNATIONAL:${x.id}`, `congrès ${x.name}`] as const),
    ...ev.map((x) => [`EVENT:${x.id}`, x.name] as const),
  ]);
}

/**
 * L'ÉQUIPE AUJOURD'HUI ET SA SEMAINE — à partir des lignes du pilotage de la Force de vente (déjà bornées à la portée
 * et à la BU) : où est chacun (congé, mission, terrain), ses visites du jour selon le plan, ses rapports en retard, sa
 * couverture, son score KPI ; et la semaine (missions, coachings).
 */
export async function chargerEquipeDuJour(user: SessionUser, lignes: readonly LigneDelegue[], maintenant: Date): Promise<TerrainOperations> {
  const repIds = lignes.map((l) => l.repId);
  const auj = debutDuJour(maintenant), demain = new Date(auj.getTime() + JOUR);
  const semaine = septJours(maintenant);
  const voitKpi = userCan(user, "KPI", "VIEW");
  if (repIds.length === 0) return { equipe: [], visites: { prevues: 0, realisees: 0 }, kpi: { ouvert: voitKpi, score: null, notes: 0 }, semaine: [] };

  const [visites, conges, missions, coachings, kpi] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: { delegateId: { in: repIds }, date: { gte: auj, lt: demain } },
      select: { delegateId: true, status: true, tourPlanId: true, doctor: { select: { wilaya: true, city: true, institutionRef: { select: { wilaya: true, city: true } } } } },
    }),
    prisma.leaveRequest.findMany({
      where: { status: "APPROVED", startDate: { lt: demain }, endDate: { gte: auj }, employee: { userId: { in: repIds } } },
      select: { type: true, employee: { select: { userId: true } } },
    }),
    prisma.missionAssignment.findMany({
      where: { userId: { in: repIds }, archivedAt: null, response: { not: "DECLINEE" }, dateDepart: { lt: semaine.fin }, OR: [{ dateRetour: { gte: auj } }, { dateRetour: null, dateDepart: { gte: auj } }] },
      select: { userId: true, entityType: true, entityId: true, ville: true, dateDepart: true, dateRetour: true },
    }),
    prisma.coachingSheet.findMany({
      where: { collaboratorId: { in: repIds }, status: "DRAFT", visitDate: { gte: auj, lt: semaine.fin } },
      select: { collaboratorId: true, visitDate: true, manager: { select: { name: true } } },
    }),
    voitKpi ? chargerTableauKpi(user).catch(sansBloquer("cockpit-operations-terrain.chargerEquipeDuJour.chargerTableauKpi", null)) : Promise.resolve(null),
  ]);
  const noms = await nomsDesMissions(missions.map((m) => ({ entityType: String(m.entityType), entityId: m.entityId })));
  const libelleMission = (m: (typeof missions)[number]) => noms.get(`${m.entityType}:${m.entityId}`) ?? "mission";
  const scoreDe = new Map((kpi?.lignes ?? []).map((l) => [l.userId, l.score]));

  const equipe: LigneEquipe[] = lignes.map((l) => {
    const v = visites.filter((x) => x.delegateId === l.repId);
    const vj = visitesDuJour(v.map((x) => ({ statut: String(x.status), planifiee: x.tourPlanId !== null })));
    const conge = conges.find((c) => c.employee.userId === l.repId);
    const mission = missions.find((m) => m.userId === l.repId && chevauche(m.dateDepart, m.dateRetour, { debut: auj, fin: demain }));
    return {
      repId: l.repId, nom: l.nom,
      jour: statutDuJour({
        conge: conge ? { libelle: String(conge.type) === "SICK" ? "maladie" : "congé" } : null,
        mission: mission ? { libelle: libelleMission(mission), ville: mission.ville } : null,
        visitesPrevues: vj.prevues,
        ville: villeDuJour(v.filter((x) => x.tourPlanId !== null).map((x) => x.doctor?.institutionRef?.city ?? x.doctor?.city ?? x.doctor?.institutionRef?.wilaya ?? x.doctor?.wilaya ?? null)),
      }),
      visites: vj,
      rapportsEnRetard: l.rapportsEnRetard,
      couverture: l.couverture.pct,
      kpi: scoreDe.get(l.repId) ?? null,
    };
  });

  const nomDe = new Map(lignes.map((l) => [l.repId, l.nom]));
  const jourCourt = (d: Date) => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });
  const evenements: EvenementSemaine[] = [];
  for (const m of missions) {
    if (!m.dateDepart) continue;
    evenements.push({
      cle: `mission:${m.userId}:${m.entityId}`, ton: "v",
      titre: libelleMission(m).replace(/^congrès/, "Congrès") + (m.ville ? ` — ${m.ville}` : ""),
      detail: `${(nomDe.get(m.userId) ?? "").split(" ")[0]} · ${m.dateDepart.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}${m.dateRetour ? ` → ${m.dateRetour.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}` : ""}`,
      le: m.dateDepart,
    });
  }
  if (coachings.length) {
    evenements.push({
      cle: "coachings", ton: "ok",
      titre: `${coachings.length} coaching${coachings.length > 1 ? "s" : ""} planifié${coachings.length > 1 ? "s" : ""}`,
      detail: [...new Set(coachings.map((c) => `${(nomDe.get(c.collaboratorId) ?? "").split(" ")[0]} · ${jourCourt(c.visitDate)}`))].slice(0, 3).join(", "),
      le: coachings.map((c) => c.visitDate).sort((a, b) => a.getTime() - b.getTime())[0],
    });
  }
  const totalVisites = equipe.reduce((s, e) => ({ prevues: s.prevues + e.visites.prevues, realisees: s.realisees + e.visites.realisees }), { prevues: 0, realisees: 0 });
  const k = scoreEquipe(equipe.map((e) => e.kpi));
  return { equipe, visites: totalVisites, kpi: { ouvert: voitKpi, ...k }, semaine: trierSemaine(evenements) };
}

/** LES LIVRAISONS PCH ATTENDUES dans les 7 jours (BL prévus, pas encore livrés), bornées aux produits de la BU. */
export async function livraisonsDeLaSemaine(produitsDeLaBu: ReadonlySet<string> | null, maintenant: Date): Promise<EvenementSemaine[]> {
  const s = septJours(maintenant);
  const l = await prisma.pchDelivery.findMany({
    where: { deliveredAt: null, expectedAt: { gte: s.debut, lt: s.fin } },
    orderBy: { expectedAt: "asc" }, take: 30,
    select: {
      id: true, expectedAt: true,
      order: { select: { reference: true, tenderId: true, orderLines: { select: { contractLine: { select: { productId: true } }, tenderLine: { select: { productId: true } } } } } },
    },
  });
  return l
    .filter((d) => !produitsDeLaBu || d.order.orderLines.some((x) => { const p = x.contractLine?.productId ?? x.tenderLine?.productId; return !!p && produitsDeLaBu.has(p); }))
    .map((d) => ({
      cle: `livraison:${d.id}`, ton: "i" as const,
      titre: `Livraison BC ${d.order.reference ?? "sans n°"}`,
      detail: `prévue ${d.expectedAt!.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" })}`,
      le: d.expectedAt!,
    }));
}

/** LES REMONTÉES DU TERRAIN : 7 jours de rapports — toutes les BU, ou celle choisie (ses produits, ses KAM). */
export async function remonteesDuTerrain(buId: string | null, produitsDeLaBu: ReadonlySet<string> | null, userId: string, maintenant: Date): Promise<VoixTerrain> {
  let perimetre: { productIds: string[]; delegateIds: string[] } | null = null;
  if (buId) {
    const delegues = await prisma.salesRepProfile.findMany({ where: { businessUnitId: buId, isActive: true }, select: { repId: true } });
    perimetre = { productIds: [...(produitsDeLaBu ?? [])], delegateIds: delegues.map((d) => d.repId) };
  }
  const rapports = await chargerRapportsTerrain({ depuis: new Date(maintenant.getTime() - 7 * JOUR), perimetre });
  return voixDuTerrain({ perimetre: `ops:${buId ?? "all"}`, jours: 7, rapports, userId, maintenant });
}

/** LES RUPTURES SIGNALÉES dans les comptes rendus des 14 derniers jours (hôpital × produit de la visite). */
export async function rupturesSignalees(produitsDeLaBu: ReadonlySet<string> | null, maintenant: Date): Promise<SignalementRupture[]> {
  const v = await prisma.medicalVisit.findMany({
    where: { status: "COMPLETED", report: { not: null }, date: { gte: new Date(maintenant.getTime() - 14 * JOUR) } },
    orderBy: { date: "desc" }, take: 400,
    select: {
      date: true, report: true,
      delegate: { select: { name: true } },
      doctor: { select: { institution: true, institutionId: true, institutionRef: { select: { name: true } } } },
      productLinks: { select: { productId: true, product: { select: { canonicalName: true } } } },
    },
  });
  const out: SignalementRupture[] = [];
  for (const x of v) {
    if (!signaleUneRupture(x.report)) continue;
    const etab = x.doctor?.institutionRef?.name ?? x.doctor?.institution ?? null;
    if (!etab) continue;
    for (const p of x.productLinks) {
      if (produitsDeLaBu && !produitsDeLaBu.has(p.productId)) continue;
      out.push({ etablissementCle: x.doctor?.institutionId ?? etab, etablissement: etab, productId: p.productId, produit: p.product.canonicalName, delegue: x.delegate?.name ?? null, date: x.date });
    }
  }
  return out;
}

/**
 * LES STOCKS RELEVÉS DANS LES HÔPITAUX : le dernier relevé de chaque hôpital × produit (dossier), et les mois qu'il
 * couvre au rythme de CET hôpital (moyenne des 3 derniers mois complets servis par les DR).
 */
export async function stocksReleves(
  user: SessionUser,
  produits: readonly { id: string; label: string; buId: string | null }[],
  canon: ReadonlyMap<string, string | null>,
  buId: string | null,
  maintenant: Date,
): Promise<LigneReleve[]> {
  const dossiers = [...new Set(produits.filter((p) => !buId || p.buId === buId).map((p) => p.id))];
  if (dossiers.length === 0) return [];
  const portee = await platformScope(user.id);
  const releves = await prisma.stockSnapshot.findMany({
    where: { AND: [portee, { scope: "HOSPITAL", productId: { in: dossiers } }] },
    orderBy: { date: "desc" }, distinct: ["productId", "annexId"], take: 300,
    select: { productId: true, annexId: true, quantity: true, date: true, annex: { select: { name: true, institutionId: true } } },
  });
  const courant = maintenant.toISOString().slice(0, 7);
  const institutions = [...new Set(releves.flatMap((r) => (r.annex?.institutionId ? [r.annex.institutionId] : [])))];
  const canoniques = [...new Set(dossiers.map((d) => canon.get(d)).filter((x): x is string => !!x))];
  const ventes = institutions.length && canoniques.length
    ? await prisma.pchVenteLigne.groupBy({
        by: ["institutionId", "productId", "mois"],
        where: { institutionId: { in: institutions }, productId: { in: canoniques }, mois: { gte: new Date(`${decalerMois(courant, -6)}-01T00:00:00Z`) } },
        _sum: { qteLivree: true },
      })
    : [];
  const label = new Map(produits.map((p) => [p.id, p.label]));
  return relevesHopitaux(releves.map((r) => {
    const p = canon.get(r.productId) ?? null;
    const serie = ventes.filter((x) => x.institutionId === r.annex?.institutionId && x.productId === p).map((x) => ({ mois: x.mois.toISOString().slice(0, 7), livre: x._sum.qteLivree ?? 0 }));
    return {
      cle: `${r.annexId ?? "-"}:${r.productId}`, hopital: r.annex?.name ?? "Hôpital", produit: label.get(r.productId) ?? "Produit",
      quantite: r.quantity, date: r.date, conso: p && r.annex?.institutionId ? consommationMoyenne(serie, courant) : null,
    };
  }), maintenant);
}
