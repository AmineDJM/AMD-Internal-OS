import { prisma } from "@/lib/prisma";
import { clausePanelDuKam } from "@/lib/rbac";
import { getSfeConfig } from "@/lib/sfe";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { requisDuPanel, requisDuPraticien } from "@/lib/segmentation/lettre-requise";
import {
  buildTournee, carriedProducts, monthProgress,
  type CarriedProduct, type MonthProgress, type PanelDoctor, type TourneeItem,
} from "@/lib/sfe-day";

/**
 * « MA JOURNÉE » — tout ce que l'écran du KAM affiche, en une requête.
 *
 * L'écran ne calcule RIEN : il rend ce que ce module lui donne. Les règles (qui voir, dans quel
 * ordre, quels produits pré-cocher) vivent dans `lib/sfe-day.ts`, pur et testé — ici on ne fait
 * que lire la base et les appliquer. C'est ce qui permet à Adam de proposer exactement la même
 * tournée que l'écran, sans en réécrire la logique une seconde fois.
 */

export interface MyFieldDay {
  /** La tournée proposée du jour — les praticiens en retard de fréquence, les plus utiles d'abord. */
  tournee: TourneeItem[];
  /** Le panel COMPLET, pour saisir une visite hors tournée (le terrain improvise, et c'est normal). */
  panel: { id: string; name: string; specialty: string | null; institution: string | null; wilaya: string | null; derniereVisite: Date | null }[];
  /** Les produits que CE KAM porte CE mois-ci, dans l'ordre de la mallette. */
  produits: CarriedProduct[];
  /** Sa ligne de chiffres du mois. */
  progress: MonthProgress;
  /** Ses dernières visites saisies — la preuve que sa saisie est arrivée quelque part. */
  recentes: { id: string; date: Date; doctorName: string; produits: string[] }[];
  /** Le panel est-il vide ? (l'écran le DIT au lieu d'afficher une page blanche) */
  panelVide: boolean;
  /** Aucune affectation de produit ce cycle ? (même raison) */
  sansAffectation: boolean;
  /**
   * LA FRÉQUENCE DE CHAQUE PRATICIEN DU PANEL, ce mois — « n / m visites ce mois » en tête de la feuille de visite
   * (11/2026). Le même requis que la tournée proposée (`requisDuPraticien`) : jamais un second calcul.
   */
  frequences: { doctorId: string; faites: number; attendues: number; lettre: string | null }[];
}

export async function loadMyFieldDay(userId: string, today = new Date()): Promise<MyFieldDay> {
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 1);

  const [config, cycle, doctors, visitsThisMonth, recentes] = await Promise.all([
    getSfeConfig(),
    prisma.promoCycle.findUnique({ where: { year_month: { year, month } }, select: { id: true } }),
    // LE PANEL ENTIER — secteur ∪ rattachement (§118.179) : la tournée proposée ici et le plan de
    // tournée lisent la même clause, sinon un praticien planifié n'apparaîtrait pas le jour venu.
    prisma.medicalDoctor.findMany({
      where: clausePanelDuKam(userId),
      select: {
        id: true, name: true, potential: true, specialty: true, institution: true, wilaya: true,
        lastVisit: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.medicalVisit.findMany({
      where: { delegateId: userId, status: "COMPLETED", date: { gte: monthStart, lt: monthEnd } },
      select: { doctorId: true },
    }),
    prisma.medicalVisit.findMany({
      where: { delegateId: userId, status: "COMPLETED" },
      select: {
        id: true, date: true,
        doctor: { select: { name: true } },
        productLinks: { select: { product: { select: { canonicalName: true } } } },
      },
      orderBy: { date: "desc" },
      take: 5,
    }),
  ]);

  // Les affectations du cycle : ce que ce KAM porte, avec sa position de détail.
  const assignments = cycle
    ? await prisma.promotionAssignment.findMany({
        where: { cycleId: cycle.id, repId: userId },
        select: { position: true, product: { select: { name: true, productId: true } } },
      })
    : [];

  const visitsByDoctor = new Map<string, number>();
  for (const v of visitsThisMonth) {
    if (!v.doctorId) continue;
    visitsByDoctor.set(v.doctorId, (visitsByDoctor.get(v.doctorId) ?? 0) + 1);
  }

  // LA LETTRE PARTOUT (Direction, 07/10) : chaque praticien du panel porte sa lettre de segmentation et les visites
  // qu'elle demande (stratégie de la BU du KAM d'abord, le palier de potentiel pour un praticien hors de toute
  // stratégie). La tournée proposée et la cible du mois lisent CE requis — le seul.
  const [lettres, profil] = await Promise.all([
    lettresDesPraticiens(doctors.map((d) => d.id)),
    prisma.salesRepProfile.findUnique({ where: { repId: userId }, select: { businessUnitId: true } }),
  ]);
  const buId = profil?.businessUnitId ?? null;

  const panelDoctors: PanelDoctor[] = doctors.map((d) => {
    const r = requisDuPraticien(lettres.get(d.id), buId, String(d.potential), config.frequencyByTier);
    return {
      id: d.id, name: d.name, potential: String(d.potential), lettre: r.lettre, requis: r.visites,
      specialty: d.specialty, institution: d.institution, wilaya: d.wilaya,
      lastVisitAt: d.lastVisit,
      visitsThisMonth: visitsByDoctor.get(d.id) ?? 0,
    };
  });

  // LA CIBLE DU MOIS = LE REQUIS DE LA SEGMENTATION — Σ des visites que demande chaque praticien du panel. Les visites
  // prévues des affectations ne priment plus : c'était le quatrième « prévu » concurrent, et le pilotage ne le lit pas.
  const target = Math.round(requisDuPanel(panelDoctors, lettres, buId, config.frequencyByTier));

  // Le produit CANONIQUE est la cible du lien de visite : un produit promu sans produit
  // canonique ne peut pas être coché (on ne saurait pas quoi relier) — on l'écarte plutôt que
  // d'offrir une case qui échouerait à l'enregistrement.
  const produits = carriedProducts(
    assignments
      .filter((a) => a.product.productId)
      .map((a) => ({ productId: a.product.productId!, name: a.product.name, position: a.position })),
    config,
  );

  return {
    tournee: buildTournee(panelDoctors, config, today),
    panel: doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty, institution: d.institution, wilaya: d.wilaya, derniereVisite: d.lastVisit })),
    produits,
    progress: monthProgress({
      done: visitsThisMonth.length,
      target,
      panelSize: doctors.length,
      covered: new Set(visitsThisMonth.map((v) => v.doctorId).filter(Boolean)).size,
      today,
    }),
    recentes: recentes.map((v) => ({
      id: v.id, date: v.date,
      doctorName: v.doctor?.name ?? "Praticien",
      produits: v.productLinks.map((l) => l.product.canonicalName),
    })),
    panelVide: doctors.length === 0,
    sansAffectation: assignments.length === 0,
    frequences: panelDoctors.map((d) => ({
      doctorId: d.id, faites: d.visitsThisMonth, attendues: d.requis !== undefined ? Math.ceil(d.requis) : config.frequencyByTier[d.potential] ?? 0,
      lettre: d.lettre ?? null,
    })),
  };
}
