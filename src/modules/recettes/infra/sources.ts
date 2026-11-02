import { prisma } from "@/lib/prisma";
import { empreinte, type EtapePlanRecette } from "../domaine/contenu";
import { formeDuPlan, type DossierObserve, type EtapeDefinie, type EvenementDossier, type IssueDossier, type NatureEvenement, type TravailReussi } from "../domaine/extraction";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CIRCUITS RÉELS, LUS OÙ ILS SONT ÉCRITS (J10, décision 0028) — aucune table de plus, aucune donnée inventée.
 *
 *   • les circuits Ad & Pro : `WorkflowInstance` + `WorkflowStepEvent` (+ la DÉFINITION : rôles et seuils réglés) ;
 *   • les validations génériques : `ValidationRequest` / `ValidationStep`, par module ;
 *   • le recrutement : `RecruitmentRequest` / `RecruitmentApproval` ;
 *   • les travaux de l'assistant qui ont RÉUSSI (J2) : `Mission` `kind = TRAVAIL`, `COMPLETED`, plan au carnet ;
 *   • les formes de missions d'Adam VALIDÉES : `MissionPlanPattern` `statut = VALIDATED`.
 *
 * Les pièces : `PieceLien` (sujet ENTITE) → `Piece.nature`. Les acteurs : leur RÔLE (`User.role`), jamais leur nom —
 * une recette dit « le Directeur Général valide », pas « Karim a validé ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface CircuitLu {
  circuit: string;
  dossiers: DossierObserve[];
  definition: EtapeDefinie[] | null;
}

const MOIS = 30 * 86_400_000;
const num = (v: { toNumber(): number } | number | null | undefined): number | null => (v === null || v === undefined ? null : typeof v === "number" ? v : v.toNumber());

async function rolesDe(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniques = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniques.length) return new Map();
  const us = await prisma.user.findMany({ where: { id: { in: uniques } }, select: { id: true, role: true } });
  return new Map(us.map((u) => [u.id, u.role]));
}

async function piecesDe(entites: readonly string[]): Promise<Map<string, string[]>> {
  if (!entites.length) return new Map();
  const liens = await prisma.pieceLien.findMany({
    where: { sujetType: "ENTITE", sujetId: { in: [...new Set(entites)] } },
    select: { sujetId: true, piece: { select: { nature: true } } },
  });
  const out = new Map<string, string[]>();
  for (const l of liens) if (l.piece.nature) out.set(l.sujetId, [...(out.get(l.sujetId) ?? []), l.piece.nature]);
  return out;
}

const NATURE_WF: Record<string, NatureEvenement> = {
  CREATE: "debut", APPROVE: "avance", OPINION_AGAINST: "avance", AUTO_SKIP: "auto", SKIP: "auto", AUTO_APPROVE_REQUESTER: "auto",
  RETURN: "renvoi", RESUBMIT: "resoumission", REJECT: "refus", CANCEL: "fin",
};
const ISSUE_WF: Record<string, IssueDossier> = { APPROVED: "ACCEPTE", REJECTED: "REFUSE", CANCELLED: "ANNULE" };

async function circuitsAdPro(depuis: Date, jusque: Date): Promise<CircuitLu[]> {
  const [definitions, instances] = await Promise.all([
    prisma.workflowDefinition.findMany({ select: { category: true, steps: { orderBy: { position: "asc" }, select: { slug: true, title: true, actorRoles: true, autoSkipMaxAmount: true } } } }),
    prisma.workflowInstance.findMany({
      where: { createdAt: { gte: depuis, lte: jusque } },
      select: {
        id: true, entityId: true, category: true, status: true, amount: true, createdAt: true, updatedAt: true,
        events: { orderBy: { createdAt: "asc" }, select: { stepSlug: true, stepTitle: true, action: true, actorId: true, note: true, createdAt: true } },
      },
    }),
  ]);
  const roles = await rolesDe(instances.flatMap((i) => i.events.map((e) => e.actorId)));
  const pieces = await piecesDe(instances.map((i) => i.entityId));
  const parCategorie = new Map<string, DossierObserve[]>();
  for (const i of instances) {
    const issue = ISSUE_WF[i.status] ?? "EN_COURS";
    const fin = issue === "EN_COURS" ? null : i.events[i.events.length - 1]?.createdAt ?? i.updatedAt;
    parCategorie.set(i.category, [...(parCategorie.get(i.category) ?? []), {
      id: i.id, debut: i.createdAt, fin, issue, montant: num(i.amount), pieces: pieces.get(i.entityId) ?? [],
      evenements: i.events.map((e) => ({
        quand: e.createdAt, etape: e.stepSlug, libelle: e.stepTitle, nature: NATURE_WF[e.action] ?? "autre", role: roles.get(e.actorId) ?? null, note: e.note,
      })),
    }]);
  }
  return [...parCategorie.entries()].map(([categorie, dossiers]) => {
    const def = definitions.find((d) => d.category === categorie);
    return {
      circuit: `WF:${categorie}`, dossiers,
      definition: def ? def.steps.map((s) => ({ cle: s.slug, libelle: s.title, roles: s.actorRoles, seuilAutoMax: num(s.autoSkipMaxAmount) })) : null,
    };
  });
}

const ISSUE_VAL: Record<string, IssueDossier> = { APPROVED: "ACCEPTE", REJECTED: "REFUSE", CANCELLED: "ANNULE" };
const NATURE_VAL: Record<string, NatureEvenement> = { APPROVED: "avance", REJECTED: "refus", CHANGES_REQUESTED: "renvoi" };

async function circuitsValidations(depuis: Date, jusque: Date): Promise<CircuitLu[]> {
  const reqs = await prisma.validationRequest.findMany({
    where: { createdAt: { gte: depuis, lte: jusque } },
    select: {
      id: true, module: true, status: true, mode: true, amount: true, entityId: true, createdAt: true, decidedAt: true, updatedAt: true,
      steps: { orderBy: { order: "asc" }, select: { order: true, status: true, decidedAt: true, reason: true, validator: { select: { role: true } } } },
    },
  });
  const pieces = await piecesDe(reqs.map((r) => r.entityId).filter((x): x is string => !!x));
  const parModule = new Map<string, DossierObserve[]>();
  for (const r of reqs) {
    const issue = ISSUE_VAL[r.status] ?? "EN_COURS";
    const decides = r.steps.filter((s) => s.decidedAt && NATURE_VAL[s.status]);
    const evenements = (r.mode === "SEQUENTIAL" ? decides : decides.slice(-1)).map((s) => ({
      quand: s.decidedAt!, etape: r.mode === "SEQUENTIAL" ? `n${s.order}` : "parallele",
      libelle: r.mode === "SEQUENTIAL" ? `Niveau ${s.order}` : "Validateurs (en parallèle)",
      nature: NATURE_VAL[s.status], role: s.validator?.role ?? null, note: s.reason,
    }));
    parModule.set(r.module, [...(parModule.get(r.module) ?? []), {
      id: r.id, debut: r.createdAt, fin: issue === "EN_COURS" ? null : r.decidedAt ?? r.updatedAt, issue, montant: num(r.amount),
      pieces: r.entityId ? pieces.get(r.entityId) ?? [] : [], evenements,
    }]);
  }
  return [...parModule.entries()].map(([module, dossiers]) => ({ circuit: `VAL:${module}`, dossiers, definition: null }));
}

const EN_CHAINE = new Set(["CHAIN", "HR_REVIEW", "INFO_REQUESTED", "RETURNED"]);

async function circuitRecrutement(depuis: Date, jusque: Date): Promise<CircuitLu[]> {
  const reqs = await prisma.recruitmentRequest.findMany({
    where: { createdAt: { gte: depuis, lte: jusque } },
    select: {
      id: true, stage: true, createdAt: true, closedAt: true, returnedAt: true, returnNote: true, updatedAt: true,
      approvals: { orderBy: { order: "asc" }, select: { order: true, status: true, decidedAt: true, reason: true, approver: { select: { role: true } } } },
    },
  });
  if (!reqs.length) return [];
  const pieces = await piecesDe(reqs.map((r) => r.id));
  const dossiers: DossierObserve[] = reqs.map((r) => {
    const evenements: EvenementDossier[] = r.approvals.filter((a) => a.decidedAt && (a.status === "APPROVED" || a.status === "REJECTED")).map((a) => ({
      quand: a.decidedAt!, etape: `n${a.order}`, libelle: `Validation niveau ${a.order}`, nature: (a.status === "APPROVED" ? "avance" : "refus") as NatureEvenement,
      role: a.approver?.role ?? null, note: a.reason,
    }));
    if (r.returnedAt) evenements.push({ quand: r.returnedAt, etape: "rh", libelle: "Revue RH", nature: "renvoi", role: null, note: r.returnNote });
    const issue: IssueDossier = EN_CHAINE.has(r.stage) ? "EN_COURS" : r.stage === "REJECTED" ? "REFUSE" : r.stage === "CANCELLED" ? "ANNULE" : "ACCEPTE";
    const derniere = evenements.map((e) => e.quand).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return { id: r.id, debut: r.createdAt, fin: issue === "EN_COURS" ? null : issue === "ACCEPTE" ? derniere : r.closedAt ?? derniere, issue, montant: null, pieces: pieces.get(r.id) ?? [], evenements };
  });
  return [{ circuit: "REC", dossiers, definition: null }];
}

const lireEtapesPlan = (plan: unknown): EtapePlanRecette[] | null => {
  const etapes = plan && typeof plan === "object" ? (plan as { etapes?: unknown }).etapes : null;
  return Array.isArray(etapes) && etapes.length ? (etapes as EtapePlanRecette[]) : null;
};

/** Les travaux de l'assistant qui ont réussi (J2), regroupés par FORME de plan. */
export async function travauxReussis(depuis: Date, jusque: Date): Promise<Map<string, TravailReussi[]>> {
  const missions = await prisma.mission.findMany({
    where: { kind: "TRAVAIL", status: "COMPLETED", createdAt: { gte: depuis, lte: jusque } },
    select: { id: true, title: true, createdAt: true, updatedAt: true, carnet: true },
  });
  const out = new Map<string, TravailReussi[]>();
  for (const m of missions) {
    const etapes = lireEtapesPlan((m.carnet as { plan?: unknown } | null)?.plan);
    if (!etapes) continue;
    const cle = `TRAVAIL:${empreinte(formeDuPlan(etapes))}`;
    out.set(cle, [...(out.get(cle) ?? []), { id: m.id, titre: m.title, debut: m.createdAt, fin: m.updatedAt, etapes }]);
  }
  return out;
}

/** Les formes de missions d'Adam VALIDÉES (répétées) — `MissionPlanPattern`. */
export async function formesValidees(depuis: Date, jusque: Date) {
  const lignes = await prisma.missionPlanPattern.findMany({ where: { statut: "VALIDATED", updatedAt: { gte: depuis, lte: jusque } }, select: { signature: true, profil: true, forme: true, succes: true, createdAt: true, updatedAt: true } });
  return lignes.map((l) => ({
    circuit: `FORME:${l.signature}`, profil: l.profil, succes: l.succes, depuis: l.createdAt, jusque: l.updatedAt,
    forme: Array.isArray(l.forme) ? l.forme.map(String) : [],
  }));
}

export const FENETRE_MOIS = 24;

/** Tous les circuits ERP des 24 derniers mois (jusqu'à `maintenant`). Chaque source est tolérante aux pannes : une source en échec ne cache pas les autres. */
export async function lireCircuits(maintenant = new Date()): Promise<CircuitLu[]> {
  const depuis = new Date(maintenant.getTime() - FENETRE_MOIS * MOIS);
  const jusque = maintenant;
  const garde = (p: Promise<CircuitLu[]>, nom: string) => p.catch((e) => { console.error(`[recettes] ${nom}`, e); return [] as CircuitLu[]; });
  const lots = await Promise.all([garde(circuitsAdPro(depuis, jusque), "ad-pro"), garde(circuitsValidations(depuis, jusque), "validations"), garde(circuitRecrutement(depuis, jusque), "recrutement")]);
  return lots.flat();
}
