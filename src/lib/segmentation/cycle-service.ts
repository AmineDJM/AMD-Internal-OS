import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clausePanelDuKam } from "@/lib/rbac";
import { getSfeConfig } from "@/lib/sfe";
import { chargerStrategie, chargerFaits } from "./service";
import { segmenterPraticien, type ContexteSegmentation } from "./moteur";
import { capaciteKam, finDuCycle, avancement, DUREES, type CapaciteKam, type Duree, type PraticienFige, type AvancementKam } from "./cycle";
import type { Regles } from "./regles";
import { sansBloquer } from "@/lib/journal";

/**
 * LES CYCLES, côté base : OUVRIR (figer règles, contexte, résultats, couverture KAM et capacité), lire l'avancement
 * (visites terminées dans la fenêtre du cycle, lues dans la Promotion médicale — jamais ressaisies), CLORE (figer
 * le réalisé). Un cycle clos ne se recalcule plus : il dit ce qui s'est passé avec les règles de l'époque.
 */

export interface Instantane {
  produits: { productId: string; rang: number; nom: string }[];
  regles: Regles;
  contexte: ContexteSegmentation;
  praticiens: PraticienFige[];
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);

export async function ouvrirCycle(auteurId: string, strategieId: string, input: { debut: string; duree: string; fin?: string | null; libelle?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!(DUREES as readonly string[]).includes(input.duree)) return { ok: false, error: "Durée inconnue." };
  const debut = d(input.debut);
  if (Number.isNaN(debut.getTime())) return { ok: false, error: "Date de début illisible." };
  const fin = finDuCycle(debut, input.duree as Duree, input.fin ? d(input.fin) : null);
  if (!fin) return { ok: false, error: "Fin de cycle manquante ou avant le début." };
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  if (!s.regle?.regles) return { ok: false, error: "Publiez d'abord des règles valides : un cycle fige une version de règles." };
  const chevauche = await prisma.segmentationCycle.findFirst({ where: { strategieId, statut: "OUVERT", debut: { lte: fin }, fin: { gte: debut } }, select: { libelle: true } });
  if (chevauche) return { ok: false, error: `Le cycle « ${chevauche.libelle} » est ouvert sur ces dates : clôturez-le d'abord.` };

  const { faits, lignes } = await chargerFaits(strategieId);
  const maintenant = new Date();
  const ids = lignes.map((l) => l.doctorId);
  // LA COUVERTURE : pour chaque KAM de la BU, les praticiens du panel qu'il couvre (secteur ∪ rattachement).
  const reps = await prisma.salesRepProfile.findMany({ where: { businessUnitId: s.businessUnit.id, isActive: true }, select: { repId: true, capVisitsPerDay: true, capFieldPct: true } });
  const kamsDe = new Map<string, string[]>();
  for (const r of reps) {
    const couverts = await prisma.medicalDoctor.findMany({ where: { AND: [clausePanelDuKam(r.repId), { id: { in: ids } }] }, select: { id: true } });
    for (const c of couverts) kamsDe.set(c.id, [...(kamsDe.get(c.id) ?? []), r.repId]);
  }
  const praticiens: PraticienFige[] = lignes.map((l, i) => {
    const r = segmenterPraticien(faits[i], s.regle!.regles!, maintenant, s.contexte);
    return { doctorId: l.doctorId, nom: l.nom, h: r.h, cible: r.cible, affichage: r.affichage, priorite: r.priorite, visites: r.visites, pourquoiVisites: r.pourquoiVisites, kamIds: kamsDe.get(l.doctorId) ?? [] };
  });
  // LA CAPACITÉ de chaque KAM : jours ouvrés du cycle, part terrain et visites/jour (sa surcharge, sinon le réglage
  // global de la force de vente), moins ses congés APPROUVÉS — lus dans les RH, pas ressaisis.
  const cfg = await getSfeConfig();
  const conges = await prisma.leaveRequest.findMany({
    where: { status: "APPROVED", startDate: { lte: fin }, endDate: { gte: debut }, employee: { userId: { in: reps.map((r) => r.repId) } } },
    select: { startDate: true, endDate: true, employee: { select: { userId: true } } },
  });
  const capacite: Record<string, CapaciteKam> = {};
  for (const r of reps) {
    capacite[r.repId] = capaciteKam(r.repId, { debut, fin }, {
      visitesParJour: r.capVisitsPerDay ?? cfg.capacity.visitsPerDay,
      partTerrainPct: r.capFieldPct ?? cfg.capacity.fieldPct,
      absences: conges.filter((c) => c.employee.userId === r.repId).map((c) => ({ debut: c.startDate, fin: c.endDate })),
    });
  }
  const instantane: Instantane = { produits: s.produits.map(({ productId, rang, nom }) => ({ productId, rang, nom })), regles: s.regle.regles, contexte: s.contexte, praticiens };
  const promo = await prisma.promoCycle.findUnique({ where: { year_month: { year: debut.getUTCFullYear(), month: debut.getUTCMonth() + 1 } }, select: { id: true } }).catch(sansBloquer("cycle-service.ouvrirCycle.promoCycle", null));
  const c = await prisma.segmentationCycle.create({
    data: {
      strategieId, libelle: input.libelle?.trim() || `Cycle du ${debut.toLocaleDateString("fr-FR", { timeZone: "UTC" })}`, duree: input.duree, debut, fin, regleVersion: s.regle.version,
      instantane: instantane as unknown as Prisma.InputJsonValue, capacite: capacite as unknown as Prisma.InputJsonValue, promoCycleId: promo?.id ?? null, ouvertParId: auteurId,
    },
    select: { id: true },
  });
  return { ok: true, id: c.id };
}

/** Les visites TERMINÉES de chaque praticien dans la fenêtre du cycle. */
async function visitesRealisees(debut: Date, fin: Date, doctorIds: string[]): Promise<Record<string, number>> {
  if (doctorIds.length === 0) return {};
  const finExclue = new Date(fin.getTime() + 86_400_000);
  const g = await prisma.medicalVisit.groupBy({ by: ["doctorId"], where: { status: "COMPLETED", date: { gte: debut, lt: finExclue }, doctorId: { in: doctorIds } }, _count: { _all: true } });
  return Object.fromEntries(g.filter((x) => x.doctorId).map((x) => [x.doctorId!, x._count._all]));
}

export interface CycleCharge {
  id: string; libelle: string; duree: string; debut: Date; fin: Date; statut: string; regleVersion: number;
  instantane: Instantane;
  capacite: Record<string, CapaciteKam>;
  realisees: Record<string, number>;
  parKam: (AvancementKam & { nom: string; explicationCapacite: string | null })[];
  total: { requis: number; realise: number; restant: number };
}

export async function chargerCycle(id: string): Promise<CycleCharge | null> {
  const c = await prisma.segmentationCycle.findUnique({ where: { id } });
  if (!c) return null;
  const instantane = c.instantane as unknown as Instantane;
  const capacite = c.capacite as unknown as Record<string, CapaciteKam>;
  const realisees = c.statut === "CLOS" && c.realise ? (c.realise as Record<string, number>) : await visitesRealisees(c.debut, c.fin, instantane.praticiens.map((p) => p.doctorId));
  const { parKam, total } = avancement(instantane.praticiens, realisees, Object.fromEntries(Object.entries(capacite).map(([k, v]) => [k, v.reelle])));
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: parKam.map((k) => k.repId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    id: c.id, libelle: c.libelle, duree: c.duree, debut: c.debut, fin: c.fin, statut: c.statut, regleVersion: c.regleVersion,
    instantane, capacite, realisees, total,
    parKam: parKam.map((k) => ({ ...k, nom: noms.get(k.repId) ?? k.repId, explicationCapacite: capacite[k.repId]?.explication ?? null })),
  };
}

export async function cloreCycle(auteurId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await prisma.segmentationCycle.findUnique({ where: { id }, select: { statut: true, debut: true, fin: true, instantane: true } });
  if (!c) return { ok: false, error: "Cycle introuvable." };
  if (c.statut === "CLOS") return { ok: false, error: "Ce cycle est déjà clos." };
  const inst = c.instantane as unknown as Instantane;
  const realise = await visitesRealisees(c.debut, c.fin, inst.praticiens.map((p) => p.doctorId));
  await prisma.segmentationCycle.update({ where: { id }, data: { statut: "CLOS", realise, closLe: new Date(), closParId: auteurId } });
  return { ok: true };
}
