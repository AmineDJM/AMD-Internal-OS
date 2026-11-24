import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import type { RepScope } from "@/lib/sfe";
import type { Pilotage, LigneDelegue } from "@/lib/queries/force-de-vente";
import { diagnostiquerPanelVide } from "@/lib/queries/tour-schedule";
import { clauseCasPvVisibles } from "@/lib/pharmacovigilance/acces";
import { equipeDuDelegue } from "@/lib/queries/equipe-delegue";
import { FENETRE_RELECTURE_JOURS, peutRelireRapport, trierARelire } from "@/lib/sfe/rapport-visite";
import type { RapportARelireFile } from "@/lib/force-de-vente/file-actions";
import type { CausePanelVide } from "@/lib/sfe/panel-diagnostic";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MON ÉQUIPE TERRAIN » — ce que la file d'actions du superviseur lit EN PLUS du pilotage (Visite médicale 11/2026).
 *
 * Le pilotage (`chargerPilotage`) porte déjà les plans à valider, les rapports en retard, les panels, le coaching : on
 * le RÉUTILISE, on ne le recalcule pas. Ce module ne lit que ce qu'il n'a pas — les rapports à relire (avec la lecture
 * de l'IA), la date de soumission d'un plan, la cause d'un panel vide, les signalements de pharmacovigilance en cours.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les rapports à relire affichés dans la file ; le compte, lui, est complet. */
export const RAPPORTS_DANS_LA_FILE = 8;
/** Au-delà, les rapports que l'IA n'a pas signalés se lisent par la liste des Rapports. */
const AUTRES_LUS = 60;

/**
 * L'ÉQUIPE DU SUPERVISEUR dans le pilotage — les délégués des BU qu'il supervise (portée « team » : tous ceux du
 * pilotage ; portée entière d'un superviseur qui configure aussi : ceux de SES BU), jamais lui-même.
 */
export function lignesDeLEquipe(lignes: readonly LigneDelegue[], scope: RepScope, userId: string): LigneDelegue[] {
  return lignes.filter((l) => l.repId !== userId && (scope.mode === "team" || (l.buId !== null && scope.buIds.includes(l.buId))));
}

export interface EquipeTerrain {
  aRelire: { total: number; lignes: RapportARelireFile[] };
  plansSoumis: { repId: string; nom: string; planId: string | null; soumisLe: Date | null }[];
  panelsVides: { repId: string; nom: string; buId: string | null; cause: CausePanelVide }[];
  casPv: { total: number; premierId: string | null };
}

export async function chargerEquipeTerrain(input: {
  user: SessionUser;
  lignes: readonly LigneDelegue[];
  aTraiter: Pilotage["aTraiter"];
  maintenant?: Date;
}): Promise<EquipeTerrain> {
  const maintenant = input.maintenant ?? new Date();
  const repIds = input.lignes.map((l) => l.repId);
  const equipe = new Set(repIds);
  const nomDe = new Map(input.lignes.map((l) => [l.repId, l.nom]));
  const depuis = new Date(maintenant.getTime() - FENETRE_RELECTURE_JOURS * 86_400_000);
  const aRelireOu = { delegateId: { in: repIds }, status: "COMPLETED" as const, report: { not: null }, reluLe: null, date: { gte: depuis } };
  const selection = {
    id: true, date: true, delegateId: true, pvIa: true, prioriteIa: true, pvIaRaison: true, pvIaExtrait: true, pvEcarteLe: true,
    doctor: { select: { name: true } },
  } as const;
  const plansIds = input.aTraiter.plansAValider.flatMap((p) => (p.planId ? [p.planId] : []));
  if (repIds.length === 0) return { aRelire: { total: 0, lignes: [] }, plansSoumis: [], panelsVides: [], casPv: { total: 0, premierId: null } };

  // TROIS LECTURES BORNÉES plutôt qu'une liste entière : les possibles cas de pharmacovigilance (tous — ils passent
  // devant), les rapports que l'IA a jugés sans cas (par sa priorité), ceux qu'elle n'a pas lus (les plus récents).
  const [total, signales, autres, nonLus, plans, cas] = await Promise.all([
    prisma.medicalVisit.count({ where: aRelireOu }),
    prisma.medicalVisit.findMany({ where: { ...aRelireOu, pvIa: { in: ["POSSIBLE", "PROBABLE"] } }, select: selection, take: 200 }),
    prisma.medicalVisit.findMany({
      where: { ...aRelireOu, pvIa: "AUCUN" }, orderBy: [{ prioriteIa: { sort: "desc", nulls: "last" } }, { date: "desc" }], select: selection, take: AUTRES_LUS,
    }),
    prisma.medicalVisit.findMany({ where: { ...aRelireOu, pvIa: null }, orderBy: { date: "desc" }, select: selection, take: AUTRES_LUS }),
    plansIds.length ? prisma.tourPlan.findMany({ where: { id: { in: plansIds } }, select: { id: true, submittedAt: true } }) : Promise.resolve([]),
    prisma.pharmacovigilanceCase.findMany({
      where: { AND: [clauseCasPvVisibles(input.user), { reporterId: { in: repIds }, status: { not: "CLOS" } }] },
      orderBy: { createdAt: "desc" }, select: { id: true }, take: 50,
    }),
  ]);

  const vus = new Set<string>();
  const candidats = [...signales, ...autres, ...nonLus].filter((v) => !vus.has(v.id) && Boolean(vus.add(v.id)));
  const tries = trierARelire(candidats).slice(0, RAPPORTS_DANS_LA_FILE);
  const soumis = new Map(plans.map((p) => [p.id, p.submittedAt]));

  // LA CAUSE D'UN PANEL VIDE : lue seulement pour les délégués concernés (le diagnostic coûte quelques lectures).
  const vides = input.lignes.filter((l) => l.panelVide);
  const causes = await Promise.all(vides.map((l) => diagnostiquerPanelVide(l.repId).catch(sansBloquer("equipe-terrain.diagnostiquerPanelVide", null))));

  return {
    aRelire: {
      total,
      lignes: tries.map((v) => ({
        visitId: v.id, date: v.date, delegue: (v.delegateId && nomDe.get(v.delegateId)) || "Délégué",
        praticien: v.doctor?.name ?? null, pvIa: v.pvIa, raison: v.pvIaRaison, extrait: v.pvIaExtrait,
        ecarteParLeDelegue: Boolean(v.pvEcarteLe),
      })),
    },
    plansSoumis: input.aTraiter.plansAValider
      .filter((p) => equipe.has(p.repId))
      .map((p) => ({ ...p, soumisLe: p.planId ? soumis.get(p.planId) ?? null : null })),
    panelsVides: vides.flatMap((l, i) => (causes[i] ? [{ repId: l.repId, nom: l.nom, buId: l.buId, cause: causes[i]!.cause }] : [])),
    casPv: { total: cas.length, premierId: cas[0]?.id ?? null },
  };
}

/** LE RAPPORT À RELIRE, ouvert par l'adresse (`?relire=`) — seulement s'il est dans la portée de la personne. */
export async function chargerRapportARelire(user: SessionUser, scope: RepScope, visitId: string) {
  const v = await prisma.medicalVisit.findUnique({
    where: { id: visitId },
    select: {
      id: true, date: true, status: true, delegateId: true, report: true, doctorFeedback: true, followUpActions: true,
      pvIa: true, pvIaRaison: true, pvIaExtrait: true, prioriteIa: true, reluLe: true, reluParId: true, reluCommentaire: true,
      pvEcarteLe: true,
      doctor: { select: { name: true, specialty: true } }, delegate: { select: { name: true } },
      productLinks: { select: { product: { select: { canonicalName: true } } } },
      messageLinks: { select: { message: { select: { title: true } } } },
      casPharmacovigilance: { select: { id: true, reference: true } },
    },
  });
  if (!v || !v.delegateId) return null;
  if (scope.repIds && !scope.repIds.includes(v.delegateId)) return null;
  const [equipe, relecteur] = await Promise.all([
    equipeDuDelegue(v.delegateId),
    v.reluParId ? prisma.user.findUnique({ where: { id: v.reluParId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  return {
    visite: v,
    relecteur: relecteur?.name ?? null,
    peutRelire: v.status === "COMPLETED" && !!v.report && !v.reluLe && peutRelireRapport({ userId: user.id, repId: v.delegateId, ...equipe }),
  };
}
