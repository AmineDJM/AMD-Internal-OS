/**
 * Accès par enregistrement — le MODULE qui possède une entité : la table `ENTITY_MODULE` et sa lecture
 * par ligne (`moduleDeLEntite`, `modulesDesEntites` : le pôle d'un contrat de consulting se lit en base).
 * Réexporté par la porte `lib/entity-access`.
 */

import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MODULE_DU_POLE, poleDe } from "@/lib/lecteurs/consulting";
import type { Module } from "@/lib/rbac";

/** Maps a polymorphic entity type to its owning module. */
export const ENTITY_MODULE: Record<EntityType, Module> = {
  REGULATORY_PRODUCT: "REGULATORY",
  // Le produit canonique se tient au catalogue Regulatory ; sa VISIBILITÉ, elle, suit ses dossiers
  // (`clauseProduitsVisibles`, branche dédiée plus bas).
  PRODUCT: "REGULATORY",
  REGULATORY_STEP: "REGULATORY",
  SPONSORING: "SPONSORING",
  BUDGET: "BUDGETS",
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL",
  CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
  SALE: "SALES",
  LOGISTICS: "LOGISTICS",
  DOCTOR: "MEDICAL",
  VISIT: "MEDICAL",
  DELEGATE_PLAN: "MEDICAL",
  BD_OPPORTUNITY: "BUSINESS_DEVELOPMENT",
  BD_PROJECT: "BD_PROJECTS",
  FINANCE_TRANSACTION: "FINANCES",
  EMPLOYEE: "EMPLOYEES",
  COMPANY: "LEGAL",
  PAYROLL: "FINANCES",
  LEAVE_REQUEST: "HR_REQUESTS",
  TASK: "WORKSPACE",
  SALARY_ADVANCE: "RH",
  EXPENSE_ORDER: "FINANCES",
  INVOICE: "FINANCES",
  DRIVE_NODE: "DRIVE",
  ADMIN_REQUEST: "ADMIN_REQUESTS",
  DRIVER_MISSION: "ADMIN_REQUESTS",
  FEEDBACK: "WORKSPACE",
  VALIDATION_REQUEST: "VALIDATIONS",
  SUPPLIER: "REGULATORY",
  MEDICAL_INFO_DECLARATION: "MEDICAL_INFO",
  DIRECTIVE: "DIRECTIVES",
  SUPPORT_REQUEST: "SUPPORT",
  DOSSIER: "DOSSIERS",
  PROMO_MATERIAL: "PROMO_MATERIAL",
  CONSULTING_CONTRACT: "CONSULTING",
  PCH_ORDER: "PCH",
  AD_PRO_OTHER: "AD_PRO_OTHER",
  AD_PRO_ITEM: "SPONSORING",
  // Une demande de pièce n'appartient à aucun module : elle appartient à ses deux
  // interlocuteurs. Le repli sur « Mon espace » ne sert que si le contrôle nominatif
  // ci-dessous ne s'applique pas.
  DOCUMENT_REQUEST: "WORKSPACE",
  // Une demande de paiement s'instruit aux FINANCES. Le module n'est toutefois qu'un repli :
  // l'accès réel est nominatif (demandeur / destinataire / Finances), résolu plus bas — sans
  // quoi celui qui fait payer une facture aurait besoin du grand livre pour joindre sa pièce.
  PAYMENT_REQUEST: "FINANCES",
  HR_REQUEST: "HR_REQUESTS",
  EVENT: "EVENTS",
  // Polymorphe : l'accès réel est résolu spécifiquement (assigné ou entité parente).
  MISSION_ASSIGNMENT: "WORKSPACE",
  OFFICE_SUPPLY_ARTICLE: "ADMIN_REQUESTS",
  PCH_TENDER: "PCH",
  // Justificatif d'une dépense imputée à un budget départemental.
  DEPARTMENT_EXPENSE: "BUDGETS",
  // Un courrier du registre : c'est le module Courriers qui en gouverne les pièces jointes.
  MAIL_ENTRY: "MAIL_REGISTER",
  // Un engagement de la société (contrat, bon de commande, assurance) et ses pièces.
  LEGAL_DOCUMENT: "LEGAL",
  // La demande de recrutement (fiche de poste) et les candidats (CV). Le module n'est qu'un
  // repli : l'accès réel est nominatif — demandeur, validateurs de la chaîne, RH — et résolu
  // plus bas. Un CV est une donnée personnelle : le module seul ne doit pas suffire à l'ouvrir.
  RECRUITMENT_REQUEST: "RECRUITMENT",
  RECRUITMENT_CANDIDATE: "RECRUITMENT",
  // LES TYPES D'AUDIT DU GRAPHE (§118.181) — ils nomment l'objet d'une ligne d'historique, et rien
  // d'autre : aucune pièce jointe, aucun commentaire ne s'y accroche. `canAccessEntity` les REFUSE
  // explicitement plus bas ; le module n'est là que parce que la table est exhaustive.
  BUSINESS_UNIT: "SALES_PLANNING",
  TOUR_PLAN: "MEDICAL",
  SALES_SECTOR: "SALES_PLANNING",
  INSTITUTION: "MEDICAL",
  SPECIALTY: "MEDICAL",
  // Une formation relève des RH — mais la personne qui la DEMANDE n'a pas le module : sa porte est
  // la règle de la liste (`clauseFormationsVisibles`), lue plus bas AVANT le droit de module.
  TRAINING: "TRAINING",
  // Un cas de pharmacovigilance : l'accès réel est nominatif (déclarant, participants, qui reçoit les cas), résolu
  // plus bas par `accesAuCasPv`.
  PHARMACOVIGILANCE_CASE: "PHARMACOVIGILANCE",
  // Valeur d'énumération héritée du module « Retours & réclamations », retiré le 09/10 (table conservée) : plus de porte
  // métier, seul le Super Admin (module ADMIN) y accède. La table est exhaustive, d'où cette entrée.
  RECLAMATION: "ADMIN",
  // Un relevé du stock PCH central (identifié par la date du mail) : la chaîne d'approvisionnement, `accesAuReleveStockPch`.
  STOCK_PCH_RELEVE: "STOCKS",
};

/**
 * LE MODULE QUI GARDE UN ENREGISTREMENT — celui de `ENTITY_MODULE`, sauf quand il dépend de la LIGNE.
 *
 * Un CONTRAT DE CONSULTING n'a pas de module fixe : son PÔLE dit lequel le garde (§118.150).
 * Lire `CONSULTING` en dur laisserait la promotion ouvrir le contrat d'un consultant passé aux
 * RH — sa rémunération comprise — et fermerait ce même contrat aux RH qui le suivent : la porte
 * ouverte à côté de la porte fermée (§118.71). L'imputation budgétaire automatique d'un paiement
 * lit la même réponse : un consultant RH se paie sur une enveloppe RH, pas sur celle d'Ad & Pro.
 */
export async function moduleDeLEntite(entityType: EntityType, entityId: string): Promise<Module> {
  return (await modulesDesEntites([{ entityType, entityId }])).get(`${entityType}:${entityId}`) ?? ENTITY_MODULE[entityType];
}

/**
 * LA MÊME RÉPONSE, EN LOT — clé `TYPE:id`. Un écran de cent paiements fait UNE lecture des pôles,
 * jamais cent (§118.102b) ; et c'est la même fonction que l'action serveur, sans quoi l'écran
 * proposerait un classement que le serveur ne ferait pas.
 */
export async function modulesDesEntites(
  entites: readonly { entityType: EntityType; entityId: string }[],
): Promise<Map<string, Module>> {
  const res = new Map<string, Module>();
  const contrats = entites.filter((e) => e.entityType === "CONSULTING_CONTRACT").map((e) => e.entityId);
  // L'échec de cette lecture n'est PAS avalé : retomber sur le défaut du schéma (Ad & Pro) ouvrirait
  // à la promotion, sur une simple panne de lecture, le contrat qu'on vient de confier aux RH. Une
  // garde ne se trompe que dans le sens qui ferme — l'erreur remonte, et l'appelant refuse (§118.150).
  const poles = contrats.length
    ? await prisma.consultingContract
        .findMany({ where: { id: { in: [...new Set(contrats)] } }, select: { id: true, pole: true } })
    : [];
  const poleDuContrat = new Map(poles.map((c) => [c.id, poleDe(c.pole)]));
  for (const e of entites) {
    res.set(
      `${e.entityType}:${e.entityId}`,
      e.entityType === "CONSULTING_CONTRACT" ? MODULE_DU_POLE[poleDuContrat.get(e.entityId) ?? "AD_PRO"] : ENTITY_MODULE[e.entityType],
    );
  }
  return res;
}
