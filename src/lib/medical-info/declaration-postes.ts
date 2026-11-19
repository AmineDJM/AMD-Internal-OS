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
  /** Les postes qui comptent (non refusés). */
  total: number;
  /** Ceux qui sont validés (accordés ; agence choisie pour un poste « agence »). */
  valides: number;
  /** Tous validés, et au moins un. */
  prets: boolean;
  /** Ce que portent les postes validés — le montant accordé, à défaut l'estimation. */
  montant: number;
}

const estSourceDeclaree = (type: string): type is AdProParent => EVENT_SOURCES.includes(type);

/** Où en sont les postes d'une demande, au regard de la déclaration. */
export async function postesPourDeclaration(type: EntityType | string, id: string): Promise<PostesPourDeclaration> {
  if (!estSourceDeclaree(type)) return { total: 0, valides: 0, prets: false, montant: 0 };
  const postes = await prisma.adProItem.findMany({
    where: { [PARENT_COLONNE[type]]: id, status: { not: "REJECTED" } },
    select: { status: true, voie: true, amountGranted: true, amountEstimated: true, execution: { select: { agenceRetenueAt: true } } },
  });
  const valide = (p: (typeof postes)[number]) => p.status === "APPROVED" && (p.voie !== "AGENCE" || Boolean(p.execution?.agenceRetenueAt));
  const valides = postes.filter(valide);
  return {
    total: postes.length,
    valides: valides.length,
    prets: postes.length > 0 && valides.length === postes.length,
    montant: Math.round(valides.reduce((t, p) => t + toNumber(p.amountGranted ?? p.amountEstimated ?? 0) * 100, 0)) / 100,
  };
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
