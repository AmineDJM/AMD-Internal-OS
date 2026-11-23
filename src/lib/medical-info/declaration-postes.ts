import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { EVENT_SOURCES } from "@/lib/medical-info/circuits";
import { loadEntity } from "@/lib/workflow/engine/entites";
import { PARENT_COLONNE, type AdProParent } from "@/lib/chemins/ad-pro";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCLARATION À L'INFORMATION MÉDICALE S'OUVRE QUAND TOUS LES POSTES SONT VALIDÉS (Direction, 19/11/2026).
 *
 * « L'information médicale ne doit pas commencer tant qu'Assia n'a pas validé tous les postes et les devis ; la
 * déclaration commence quand tous les postes sont validés, et ils sont déclarés tous ensemble : aucun poste n'est
 * déclaré plus tard. »
 *
 * Jusqu'ici, le dossier `DIM-…` naissait à la pré-validation, avant le moindre poste. Désormais :
 *   • la pré-validation n'ouvre plus rien (`emitFinancials`, moteur du circuit) ;
 *   • le dossier s'ouvre au moment où le DERNIER poste est validé — accordé par la Direction Marketing, et, pour un poste
 *     « agence », son agence choisie (le devis retenu) ; un poste refusé ne compte pas ;
 *   • une fois ouvert, plus aucun poste ne s'ajoute à la demande (`refusPosteApresDeclaration`) : tout ce qui se déclare
 *     l'est en une fois.
 *
 * Le contrôle de conformité du BAT, poste par poste, ne change pas : il suit son poste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PostesPourDeclaration {
  /** Les postes qui comptent (non refusés — un brouillon compte : il doit être soumis ou supprimé). */
  total: number;
  /** Ceux qui sont validés (accordés ; agence choisie pour un poste « agence »). */
  valides: number;
  /** Tous validés, et au moins un. */
  prets: boolean;
  /** Ce que portent les postes validés — le montant accordé, à défaut l'estimation. */
  montant: number;
  /** CE QUI BLOQUE ENCORE, dit en clair (« 1 poste en attente de la Direction Marketing »…) — vide quand tout est prêt. */
  blocages: string[];
  /** Les brouillons jamais soumis — ils RETIENNENT la déclaration, et « À venir » le dit. */
  brouillons: number;
}

const estSourceDeclaree = (type: string): type is AdProParent => EVENT_SOURCES.includes(type);

type PosteLu = { status: string; voie: string | null; amountGranted: unknown; amountEstimated: unknown; execution: { agenceRetenueAt: Date | null } | null };

const pl = (n: number, s: string, p: string) => `${n} ${n > 1 ? p : s}`;

/**
 * LA LECTURE DES POSTES — PURE. UN BROUILLON RETIENT LA DÉCLARATION (recette sponsoring, 23/11/2026) : une fois ouverte,
 * la déclaration ne prend plus de poste — un brouillon ignoré à l'ouverture deviendrait insoumissable (les postes d'un
 * sponsoring indirect naissent en brouillon de sa répartition). Il compte donc, et « À venir » dit au pharmacien ce qui
 * retient : « 1 poste en brouillon — à soumettre ou à supprimer ». Un refusé ne compte pas.
 */
export function lirePostesPourDeclaration(tous: readonly PosteLu[]): PostesPourDeclaration {
  const brouillons = tous.filter((p) => p.status === "DRAFT").length;
  const postes = tous.filter((p) => p.status !== "REJECTED");
  const sansAgence = (p: PosteLu) => p.status === "APPROVED" && p.voie === "AGENCE" && !p.execution?.agenceRetenueAt;
  const valides = postes.filter((p) => p.status === "APPROVED" && !sansAgence(p));
  const n = (f: (p: PosteLu) => boolean) => postes.filter(f).length;
  const blocages = [
    brouillons ? `${pl(brouillons, "poste", "postes")} en brouillon — à soumettre ou à supprimer` : null,
    n((p) => p.status === "PENDING") ? `${pl(n((p) => p.status === "PENDING"), "poste", "postes")} en attente de la Direction Marketing` : null,
    n((p) => p.status === "REVISION") ? `${pl(n((p) => p.status === "REVISION"), "poste", "postes")} à revoir par le demandeur` : null,
    n(sansAgence) ? `${pl(n(sansAgence), "poste « agence » sans agence choisie", "postes « agence » sans agence choisie")}` : null,
    postes.length === 0 ? "aucun poste" : null,
  ].filter((x): x is string => Boolean(x));
  return {
    total: postes.length,
    valides: valides.length,
    prets: postes.length > 0 && valides.length === postes.length,
    montant: Math.round(valides.reduce((t, p) => t + toNumber(p.amountGranted ?? p.amountEstimated ?? 0) * 100, 0)) / 100,
    blocages,
    brouillons,
  };
}

const CHOIX_POSTE = { status: true, voie: true, amountGranted: true, amountEstimated: true, execution: { select: { agenceRetenueAt: true } } } as const;

/** Où en sont les postes d'une demande, au regard de la déclaration. */
export async function postesPourDeclaration(type: EntityType | string, id: string): Promise<PostesPourDeclaration> {
  if (!estSourceDeclaree(type)) return lirePostesPourDeclaration([]);
  const postes = await prisma.adProItem.findMany({ where: { [PARENT_COLONNE[type]]: id }, select: CHOIX_POSTE });
  return lirePostesPourDeclaration(postes.map((p) => ({ ...p, status: String(p.status), voie: p.voie ? String(p.voie) : null })));
}

/**
 * « À VENIR » (23/11/2026) — les demandes ACCORDÉES dont la déclaration n'est pas encore ouverte, avec ce qui la retient :
 * le pharmacien voit venir son travail au lieu de le découvrir. Celles sans aucun poste ne sont pas listées, sauf si elles
 * s'ouvrent à la main (ancienne règle, ordre déjà parti). En lot : une requête par table.
 */
export async function declarationsAVenir(): Promise<{ type: AdProParent; id: string; postes: PostesPourDeclaration; ouvrable: boolean }[]> {
  const circuits = await prisma.workflowInstance.findMany({
    where: { entityType: { in: EVENT_SOURCES as EntityType[] }, status: "APPROVED" }, select: { entityType: true, entityId: true },
  });
  if (circuits.length === 0) return [];
  const ouvertes = new Set((await prisma.medicalInfoDeclaration.findMany({
    where: { sourceType: { in: EVENT_SOURCES as EntityType[] }, sourceId: { in: circuits.map((c) => c.entityId) } }, select: { sourceType: true, sourceId: true },
  })).map((d) => `${d.sourceType}:${d.sourceId}`));
  const attente = circuits.filter((c) => !ouvertes.has(`${c.entityType}:${c.entityId}`) && estSourceDeclaree(c.entityType));
  if (attente.length === 0) return [];
  const ids = attente.map((c) => c.entityId);
  const [postes, ordres] = await Promise.all([
    prisma.adProItem.findMany({
      where: { OR: (["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT"] as const).map((t) => ({ [PARENT_COLONNE[t]]: { in: ids } })) },
      select: { ...CHOIX_POSTE, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true },
    }),
    prisma.expenseOrder.findMany({ where: { sourceType: { in: EVENT_SOURCES as EntityType[] }, sourceId: { in: ids } }, select: { sourceType: true, sourceId: true } }),
  ]);
  const avecOrdre = new Set(ordres.map((o) => `${o.sourceType}:${o.sourceId}`));
  return attente.flatMap((c) => {
    const type = c.entityType as AdProParent;
    const siens = postes.filter((p) => p[PARENT_COLONNE[type] as "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId"] === c.entityId);
    const lus = lirePostesPourDeclaration(siens.map((p) => ({ ...p, status: String(p.status), voie: p.voie ? String(p.voie) : null })));
    // La règle de `declarationOuvrable` : tous validés — ou l'ancienne règle, sans poste, son ordre déjà parti.
    const ouvrable = lus.prets || (siens.length === 0 && avecOrdre.has(`${c.entityType}:${c.entityId}`));
    if (siens.length === 0 && !ouvrable) return [];
    return [{ type, id: c.entityId, postes: lus, ouvrable }];
  });
}

/**
 * LA DÉCLARATION PEUT-ELLE S'OUVRIR ? Tous les postes validés — ou une demande de l'ANCIENNE règle (montant global) : sans
 * poste, son ordre de dépense déjà parti ; elle n'aura jamais de postes à attendre, et le pharmacien l'ouvre à la main.
 */
export async function declarationOuvrable(type: EntityType | string, id: string): Promise<{ ouvrable: boolean; postes: PostesPourDeclaration }> {
  const postes = await postesPourDeclaration(type, id);
  if (postes.prets) return { ouvrable: true, postes };
  if (postes.total > 0 || !estSourceDeclaree(type)) return { ouvrable: false, postes };
  const ancienneRegle = await prisma.expenseOrder.count({ where: { sourceType: type as EntityType, sourceId: id } });
  return { ouvrable: ancienneRegle > 0, postes };
}

/**
 * OUVRIR LE DOSSIER SI LE DERNIER POSTE VIENT D'ÊTRE VALIDÉ — appelé après chaque changement de poste (décision, refus,
 * retrait, révision) et après le choix d'une agence. Idempotent : un dossier existant n'est pas rouvert ; une demande
 * dont le circuit n'est pas conclu (pré-validation) n'en ouvre pas. Rend l'identifiant du dossier ouvert, sinon `null`.
 */
export async function ouvrirDeclarationSiPostesValides(type: EntityType | string, id: string): Promise<string | null> {
  if (!estSourceDeclaree(type)) return null;
  const entite = type as EntityType;
  const existe = await prisma.medicalInfoDeclaration.findUnique({ where: { sourceType_sourceId: { sourceType: entite, sourceId: id } }, select: { id: true } });
  if (existe) return null;
  const circuit = await prisma.workflowInstance.findUnique({
    where: { entityType_entityId: { entityType: entite, entityId: id } }, select: { status: true, budgetCategoryId: true },
  });
  if (!circuit || circuit.status !== "APPROVED") return null;
  const postes = await postesPourDeclaration(type, id);
  if (!postes.prets) return null;
  const resume = await loadEntity(entite, id);
  if (!resume) return null;
  const decl = await createMedicalInfoDeclaration({
    sourceType: entite, sourceId: id, label: resume.label, beneficiary: resume.beneficiary,
    amount: postes.montant > 0 ? postes.montant : null, requesterId: resume.requesterId, budgetCategoryId: circuit.budgetCategoryId ?? null,
  });
  return decl.id;
}

/** Le dossier est ouvert : la demande ne prend plus de poste — ils sont déclarés ensemble, une fois. */
export async function refusPosteApresDeclaration(type: EntityType | string, id: string): Promise<string | null> {
  if (!estSourceDeclaree(type)) return null;
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: type as EntityType, sourceId: id } }, select: { reference: true },
  });
  return decl
    ? `Les postes de cette demande sont déclarés à l'information médicale (dossier ${decl.reference}) : ils l'ont été tous ensemble, et aucun poste ne s'y ajoute plus.`
    : null;
}
