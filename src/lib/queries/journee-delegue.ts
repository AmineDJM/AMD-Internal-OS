import { prisma } from "@/lib/prisma";
import { remisesDesVisites } from "@/lib/queries/promo-remises";
import { jour } from "@/lib/sfe/tournee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE « MA JOURNÉE » LIT EN PLUS DE L'EMPLOI DU TEMPS (11/2026) — en LECTURE seule.
 *
 *  · `planDuJour` : le plan de tournée qui couvre aujourd'hui, pour qu'un écran vide DISE pourquoi
 *    (« Préparer mon plan », « En attente de validation par X depuis n j ») au lieu d'afficher un vide ;
 *  · `dernieresVisites` : « La dernière fois » de la feuille de visite — date, produits présentés,
 *    messages, matériel remis, prochaine action — relu des visites déjà rapportées, jamais ressaisi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PlanDuJour {
  id: string;
  status: string;
  /** Qui doit trancher maintenant : le N+2 si le plan est escaladé, sinon le validateur. */
  chez: string | null;
  /** Depuis quand il attend (soumission, ou escalade). ISO. */
  depuis: string | null;
}

/** Le plan qui couvre aujourd'hui — le plus récent s'il y en a deux. */
export async function planDuJour(repId: string, maintenant: Date = new Date()): Promise<PlanDuJour | null> {
  const j = jour(maintenant);
  const p = await prisma.tourPlan.findFirst({
    where: { repId, periodStart: { lte: maintenant }, periodEnd: { gte: j } },
    orderBy: { periodStart: "desc" },
    select: {
      id: true, status: true, submittedAt: true, escalatedAt: true,
      reviewer: { select: { name: true } }, escalatedTo: { select: { name: true } },
    },
  });
  if (!p) return null;
  const escalade = p.status === "ESCALATED";
  return {
    id: p.id,
    status: p.status,
    chez: (escalade ? p.escalatedTo?.name : p.reviewer?.name) ?? null,
    depuis: (escalade ? p.escalatedAt ?? p.submittedAt : p.submittedAt)?.toISOString() ?? null,
  };
}

export interface DerniereVisite {
  visitId: string;
  doctorId: string;
  /** ISO. */
  date: string;
  produits: string[];
  messages: string[];
  /** Le matériel remis (net) et les supports présentés. */
  materiel: string[];
  suite: string | null;
}

/**
 * LES DEUX DERNIÈRES VISITES RAPPORTÉES de chaque praticien, par CE délégué — deux, parce que la feuille
 * d'une visite qu'on CORRIGE ne doit pas se citer elle-même comme « la dernière fois » : l'écran écarte
 * la visite ouverte et prend la suivante. Une lecture pour toute la liste du jour (§118.102b).
 */
export async function dernieresVisites(delegateId: string, doctorIds: readonly string[]): Promise<DerniereVisite[]> {
  const ids = [...new Set(doctorIds)];
  if (ids.length === 0) return [];
  const visites = await prisma.medicalVisit.findMany({
    where: { delegateId, doctorId: { in: ids }, status: "COMPLETED" },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    // Borne de lecture : quelques rapports par praticien suffisent à trouver les deux derniers.
    take: Math.min(600, ids.length * 6),
    select: {
      id: true, doctorId: true, date: true, followUpActions: true,
      productLinks: { select: { product: { select: { canonicalName: true } } } },
      messageLinks: { select: { message: { select: { title: true } } } },
    },
  });
  const parPraticien = new Map<string, typeof visites>();
  for (const v of visites) {
    if (!v.doctorId) continue;
    const l = parPraticien.get(v.doctorId) ?? [];
    if (l.length < 2) { l.push(v); parPraticien.set(v.doctorId, l); }
  }
  const retenues = [...parPraticien.values()].flat();
  const remises = await remisesDesVisites(retenues.map((v) => v.id));
  return retenues.map((v) => {
    const r = remises.get(v.id);
    return {
      visitId: v.id,
      doctorId: v.doctorId!,
      date: v.date.toISOString(),
      produits: v.productLinks.map((l) => l.product.canonicalName),
      messages: v.messageLinks.map((l) => l.message.title),
      materiel: [
        ...(r?.materiel ?? []).map((m) => `${m.quantite.toLocaleString("fr-FR")} ${m.libelle}`),
        ...(r?.numeriques ?? []).map((n) => `${n.libelle} (présenté)`),
      ],
      suite: v.followUpActions,
    };
  });
}
