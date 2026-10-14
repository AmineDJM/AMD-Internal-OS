/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRÉ-VALIDATION D'UN BON DE COMMANDE — la règle, pure (Direction, 10/2026).
 *
 * « Dans Demandes de validations, l'objet à valider peut être un bon de commande : on l'importe depuis Legal, depuis
 * son ordinateur, ou on le compose sur place. Un validateur principal, d'autres au besoin. Une fois qu'ils ont
 * accepté, le demandeur demande la validation FINALE — ce qu'on a fait avant n'était que la pré-validation. La
 * validation finale va au centre de validation des bons de commande, puis, acceptée, au module Bons de commande. »
 *
 * ── CE QUE LA PRÉ-VALIDATION EST, ET CE QU'ELLE N'EST PAS ───────────────────────────────────
 *
 * Elle n'est PAS une seconde porte : la porte d'un BC reste celle de son centre (`regle.ts`, `aiguillage.ts`), et elle
 * seule fait passer le BC à la signature. La pré-validation est un AVIS demandé par le demandeur à des personnes de son
 * choix, AVANT que le centre ne voie le BC. Pendant qu'elle court, le BC est RETENU : l'aiguillage ne l'adresse à aucun
 * centre (sinon le centre le validerait avant ceux à qui l'on demande leur avis, et la pré-validation ne servirait à
 * rien). La validation finale lève la retenue et rend la main à l'aiguillage ordinaire — même centre, même seuil,
 * même signature qu'un BC émis ailleurs.
 *
 * Module PUR, sans aucun import : lu par les actions, par l'écran et testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature d'objet d'une demande de validation qui pré-valide un BC — distincte de la porte du centre (`OBJET_BC`). */
export const OBJET_PREVALIDATION_BC = "PREVALIDATION_BC";

/** D'où vient le BC qu'on soumet. */
export const SOURCES_BC = ["LEGAL", "ORDINATEUR", "COMPOSER"] as const;
export type SourceBC = (typeof SOURCES_BC)[number];

export const LIBELLE_SOURCE_BC: Record<SourceBC, string> = {
  LEGAL: "Importer depuis Legal",
  ORDINATEUR: "Importer depuis mon ordinateur",
  COMPOSER: "Composer ici",
};

export function lireSourceBC(v: string | null | undefined): SourceBC | null {
  return v && (SOURCES_BC as readonly string[]).includes(v) ? (v as SourceBC) : null;
}

/** Ce qu'il faut savoir d'un BC pour décider s'il peut être soumis à une pré-validation. */
export interface BCASoumettre {
  kind: string;
  status: string;
  /** Signé par les Finances. */
  signe: boolean;
  /** L'état de sa porte au centre — `null` s'il n'en a pas. */
  porte: "EN_ATTENTE" | "VALIDE" | "REFUSE" | "A_REVOIR" | null;
  /** La demande de validation qui le retient déjà, s'il y en a une. */
  retenuPar: string | null;
}

/**
 * CE BC PEUT-IL ÊTRE SOUMIS À UNE PRÉ-VALIDATION ? — `null` = oui, sinon le motif (§118.30 : il nomme ce qui bloque).
 *
 * Ce qu'un centre a déjà DÉCIDÉ ne se re-soumet pas par la bande : un BC validé, refusé ou signé a dépassé le stade où
 * l'on demande un avis. Un BC qui ATTEND son centre, lui, peut encore être pré-validé : sa porte en attente est retirée
 * (personne ne l'a encore vue), et la validation finale la reposera.
 */
export function refusSoumissionBC(bc: BCASoumettre, demandeId?: string | null): string | null {
  if (bc.kind !== "PURCHASE_ORDER") return "Cette pièce n'est pas un bon de commande.";
  if (bc.status === "CANCELLED") return "Ce bon de commande est annulé.";
  if (bc.signe) return "Ce bon de commande est déjà signé : il n'y a plus d'avis à demander.";
  if (bc.porte === "VALIDE") return "Ce bon de commande est déjà validé par son centre : il attend la signature, pas un avis.";
  if (bc.porte === "REFUSE") return "Ce bon de commande a été refusé par son centre : une pré-validation ne contourne pas un refus.";
  if (bc.retenuPar && bc.retenuPar !== demandeId) return "Ce bon de commande est déjà soumis à une autre demande de validation.";
  return null;
}

/** Ce qu'il faut savoir pour proposer la validation finale. */
export interface EtatPrevalidation {
  /** Statut de la demande de validation (PENDING, APPROVED, REJECTED, CHANGES_REQUESTED, CANCELLED). */
  statut: string;
  demandeurId: string;
  /** Le BC est-il encore retenu par CETTE demande ? Faux une fois la validation finale demandée. */
  retenu: boolean;
}

/**
 * LE DEMANDEUR PEUT-IL DEMANDER LA VALIDATION FINALE ? — `null` = oui, sinon le motif.
 *
 * Trois conditions, et elles sont lues CÔTÉ SERVEUR par l'action comme par le bouton de l'écran : c'est le demandeur
 * qui la demande (le Super Admin aussi, pour débloquer), tous les validateurs ont accepté, et le BC n'est pas déjà parti.
 */
export function refusValidationFinale(e: EtatPrevalidation, acteur: { id: string; role: string }): string | null {
  if (acteur.id !== e.demandeurId && acteur.role !== "SUPER_ADMIN") return "Seul le demandeur demande la validation finale.";
  if (!e.retenu) return "La validation finale a déjà été demandée.";
  switch (e.statut) {
    case "APPROVED": return null;
    case "PENDING": return "Tous les validateurs n'ont pas encore accepté.";
    case "REJECTED": return "La pré-validation a été refusée : corrigez et resoumettez avant de demander la validation finale.";
    case "CHANGES_REQUESTED": return "Une modification a été demandée : resoumettez avant de demander la validation finale.";
    default: return "Cette demande n'est plus active.";
  }
}

/** La phrase d'un BC retenu par sa pré-validation — dite à l'émission et sur sa fiche. */
export const PHRASE_PREVALIDATION =
  "Ce bon de commande est en pré-validation (Demandes de validations) : il partira au centre de validation quand le demandeur demandera la validation finale. Ne l'envoyez pas au fournisseur avant.";

/** Lit une liste de validateurs : les identifiants non vides, sans doublon, dans l'ordre (le premier est le principal). */
export function validateursDuFormulaire(valeurs: readonly unknown[]): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const v of valeurs) {
    const id = typeof v === "string" ? v.trim() : "";
    if (id && !vus.has(id)) { vus.add(id); out.push(id); }
  }
  return out;
}
