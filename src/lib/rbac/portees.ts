/**
 * RBAC — les PORTÉES DE LIGNES (clauses Prisma `where`) : Regulatory et son cadenas, panel du KAM,
 * praticiens, visites, ventes, congrès, sponsoring, Ad & Pro, BD, support, dossiers, directives,
 * information médicale, demandes administratives, matériel promotionnel. Réexporté par la porte `lib/rbac`.
 */

import type { EntityType, Prisma } from "@prisma/client";
import type { SessionUser } from "./acces";

// ─────────────────────── Row-level scoping (Prisma where) ───────────────────────

function grantsFor(user: SessionUser, entityType: EntityType): string[] {
  return [...(user.access.rowGrants.get(entityType) ?? [])];
}

/**
 * QUI VOIT LES DOSSIERS VERROUILLÉS — le Super Admin, et ceux à qui il a ouvert le pipeline.
 *
 * Le Super Admin est en dur : c'est lui qui distribue ces accès depuis la console, et un réglage
 * malheureux ne doit pas pouvoir l'enfermer dehors. Les autres viennent du réglage d'instance,
 * résolu par `getAccess` (voir `lib/regulatory/pipeline-access.ts`).
 */
export function seesLockedRegulatory(user: SessionUser): boolean {
  // DEUX CLÉS (Direction, 08/10) : la confidence (réglage nommé ou par rôle) ET le module « Pipeline réglementaire »
  // de la console. Fermer le module à quelqu'un ferme le pipeline PARTOUT — l'écran, la recherche, les sélecteurs,
  // l'assistant —, pas seulement l'entrée de menu : sinon la console mentirait.
  return user.role === "SUPER_ADMIN" || (user.access.pipelineView === true && user.access.modules.has("REGULATORY_PIPELINE"));
}

/** Qui tient le CADENAS : ouvrir un dossier, c'est le publier à toute l'entreprise. On n'ouvre pas ce qu'on ne voit
 *  pas : le module « Pipeline réglementaire » est requis aussi (Direction, 08/10). */
export function holdsRegulatoryLock(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || (user.access.pipelineManage === true && user.access.modules.has("REGULATORY_PIPELINE"));
}

/**
 * Le VERROU d'un dossier réglementaire passe AVANT tout le reste : ni la portée « toutes les
 * lignes », ni le fait d'en être responsable, ni une autorisation nominative ne l'ouvrent. Il ne
 * s'ouvre QUE par l'accès au pipeline, accordé nommément ou par rôle en Administration.
 *
 * Cette règle vit ici, dans la portée, et non dans l'écran Regulatory : un dossier caché du
 * tableau mais visible depuis la recherche, le sélecteur de produits des stocks ou l'assistant
 * ne serait pas caché du tout.
 */
function lockGate(user: SessionUser): Prisma.RegulatoryProductWhereInput | null {
  return seesLockedRegulatory(user) ? null : { isLocked: false };
}

/**
 * LE MODULE QUI GOUVERNE UN DOSSIER (Direction, 08/10) : un dossier VERROUILLÉ est au pipeline, un dossier ouvert au
 * suivi. Pur — la fiche, les gestes et la portée lisent la même règle (`modulesDesEntites`, `scopeRegulatory`).
 */
export function moduleDuDossierRegulatory(dossier: { isLocked: boolean }): "REGULATORY" | "REGULATORY_PIPELINE" {
  return dossier.isLocked ? "REGULATORY_PIPELINE" : "REGULATORY";
}

/** La portée NOMMÉE d'un module sur les dossiers — « ses lignes » : créés, portés, partagés, accordés. */
function porteeDossiers(user: SessionUser, module: "REGULATORY" | "REGULATORY_PIPELINE"): Prisma.RegulatoryProductWhereInput | null {
  const m = user.access.modules.get(module);
  if (!m) return null;
  if (m.scope === "ALL") return {};
  const ors: Prisma.RegulatoryProductWhereInput[] = [
    { createdById: user.id }, // le créateur voit toujours son propre dossier (sinon 404 après création)
    { responsibleId: user.id },
    { assistantId: user.id },
    { assignedUsers: { some: { id: user.id } } },
  ];
  const ids = grantsFor(user, "REGULATORY_PRODUCT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/**
 * LES DOSSIERS QU'UNE PERSONNE VOIT — deux moitiés depuis la scission (Direction, 08/10) : les dossiers OUVERTS par
 * le module Regulatory (suivi des dossiers), les dossiers VERROUILLÉS par le module « Pipeline réglementaire » ET la
 * confidence du pipeline (`lockGate`). Chaque moitié garde sa propre portée (« tout » ou « ses lignes »).
 */
export function scopeRegulatory(user: SessionUser): Prisma.RegulatoryProductWhereInput {
  const suivi = porteeDossiers(user, "REGULATORY");
  const pipeline = lockGate(user) ? null : porteeDossiers(user, "REGULATORY_PIPELINE");
  if (!suivi && !pipeline) return { id: "__none__" };
  // Les deux moitiés en « tout » : tout le portefeuille, sans clause (le cas du Super Admin et de la Direction).
  if (suivi && pipeline && Object.keys(suivi).length === 0 && Object.keys(pipeline).length === 0) return {};
  const moitie = (portee: Prisma.RegulatoryProductWhereInput, isLocked: boolean): Prisma.RegulatoryProductWhereInput =>
    Object.keys(portee).length === 0 ? { isLocked } : { AND: [portee, { isLocked }] };
  if (suivi && !pipeline) return moitie(suivi, false);
  if (pipeline && !suivi) return moitie(pipeline, true);
  return { OR: [moitie(suivi!, false), moitie(pipeline!, true)] };
}

/**
 * Le même verrou pour les lectures qui ne passent PAS par `scopeRegulatory` : sélecteur de
 * produits des stocks, rapprochement « notre produit » d'un appel d'offres PCH, compteurs du
 * tableau de bord. Elles n'ont pas de portée par ligne, mais elles nomment des produits — et
 * un nom qui apparaît suffit à révéler le portefeuille.
 */
export function regulatoryLockWhere(user: SessionUser | null): Prisma.RegulatoryProductWhereInput {
  return user && seesLockedRegulatory(user) ? {} : { isLocked: false };
}

/**
 * LE PANEL D'UN KAM — les praticiens qu'il couvre, en UNE clause (§118.179).
 *
 * Son SECTEUR d'abord : un secteur est une sélection d'établissements — entiers, ou certains de
 * leurs services (§118.172) — et les praticiens de ce qu'il couvre sont son territoire. Plus ceux
 * qui lui sont rattachés directement (`delegateId`) : un libéral n'a pas d'hôpital.
 *
 * Il y avait DEUX définitions. Le plan de tournée lisait secteur ∪ rattachement ; tout le reste —
 * Ma journée, la saisie d'une visite, la visite imprévue, le cockpit et ses alertes, la carte
 * d'équipe, l'accès à la fiche — le seul rattachement. Un KAM planifiait un praticien de son
 * secteur, puis ne le trouvait pas dans Ma journée, ne pouvait ni saisir la visite imprévue ni
 * ouvrir sa fiche, et le cockpit l'alertait « aucun praticien dans son panel » sur un secteur qui
 * en comptait quarante.
 *
 * Ce que la clause ne fait PAS : un établissement RESTREINT ne couvre que les services choisis, et
 * un praticien SANS service n'y entre pas (on ne devine pas son service, §118.34) ; un secteur
 * INACTIF ne couvre rien. Relationnelle et synchrone : elle se compose dans n'importe quelle
 * requête sans lecture préalable, et c'est elle — elle seule — que lisent les panels de plusieurs
 * KAM (`queries/panel-kam.ts`) : une seconde écriture de la règle en mémoire divergerait sur le
 * premier cas que personne n'a pensé à tester.
 */
export function clausePanelDuKam(repId: string): Prisma.MedicalDoctorWhereInput {
  // UN SECTEUR DE SA BU (§118.184 — audit 360°, S15) : retiré d'une BU ou passé dans une autre, un KAM
  // gardait ses affectations aux secteurs de l'ancienne — et leurs praticiens dans son panel (fiche,
  // modification, tournée). Le geste qui change la BU les retire désormais ; la règle de lecture ne compte
  // de toute façon que les secteurs de la BU où il est rattaché, pour qu'une ligne restée en base, par un
  // chemin qu'on n'a pas vu, n'ouvre rien.
  const secteurDuKam: Prisma.SalesSectorWhereInput = { isActive: true, reps: { some: { repId } }, businessUnit: { reps: { some: { repId } } } };
  return {
    OR: [
      { delegateId: repId },
      { institutionRef: { sectors: { some: { tousLesServices: true, sector: secteurDuKam } } } },
      { serviceRef: { secteurs: { some: { sectorInstitution: { tousLesServices: false, sector: secteurDuKam } } } } },
    ],
  };
}

/**
 * LES PRATICIENS QU'UNE PERSONNE VOIT ET TOUCHE dans l'annuaire de la Promotion médicale.
 *
 * Portée entière : tous. Portée « ses lignes » (le délégué) : SON PANEL — secteur ∪ rattachement
 * (§118.179) — plus ce qui lui est accordé ligne à ligne. C'est la règle du cahier des charges
 * (« CAM : son portefeuille + mises à jour terrain »), et c'est ce qui rend cohérents le plan de
 * tournée (qui propose les praticiens du secteur) et la fiche (qui doit s'ouvrir sur eux).
 * Le geste qui la retourne, si la Direction veut qu'un délégué ne MODIFIE que ses rattachés : dans
 * `canAccessEntity("DOCTOR")`, garder `{ delegateId }` pour les gestes autres que VIEW — et la
 * feuille de l'annuaire devra alors porter un drapeau « modifiable » par ligne.
 */
export function scopeMedicalDoctors(user: SessionUser): Prisma.MedicalDoctorWhereInput {
  const m = user.access.modules.get("MEDICAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalDoctorWhereInput[] = [clausePanelDuKam(user.id)];
  const ids = grantsFor(user, "DOCTOR");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeMedicalVisits(user: SessionUser): Prisma.MedicalVisitWhereInput {
  const m = user.access.modules.get("MEDICAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalVisitWhereInput[] = [{ delegateId: user.id }];
  const ids = grantsFor(user, "VISIT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeSales(user: SessionUser): Prisma.SaleWhereInput {
  const m = user.access.modules.get("SALES");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.SaleWhereInput[] = [{ salesUserId: user.id }];
  const ids = grantsFor(user, "SALE");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeBusinessDevelopment(user: SessionUser): Prisma.BusinessDevelopmentOpportunityWhereInput {
  const m = user.access.modules.get("BUSINESS_DEVELOPMENT");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.BusinessDevelopmentOpportunityWhereInput[] = [{ ownerId: user.id }];
  const ids = grantsFor(user, "BD_OPPORTUNITY");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/** Prises en charge Internationales : scope ALL voit tout ; sinon le demandeur + le chef
 *  de produit assigné (un délégué ne voit que ses propres demandes). */
export function scopeCongressIntl(user: SessionUser): Prisma.CongressInternationalWhereInput {
  const m = user.access.modules.get("CONGRESS_INTERNATIONAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/** Congrès / événements nationaux : même logique. */
export function scopeCongressNational(user: SessionUser): Prisma.CongressNationalWhereInput {
  const m = user.access.modules.get("CONGRESS_NATIONAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/**
 * SPONSORING (§118.185 — audit 360°, I4) : jusqu'ici, qui avait le module voyait tout — aucun rôle
 * n'avait de portée par ligne. Le délégué médical reçoit le module pour déposer SA demande : sa
 * portée ASSIGNÉE se lit ici, une fois, par la liste, la fiche, la recherche et la porte des pièces.
 */
export function scopeSponsoring(user: SessionUser): Prisma.SponsoringRequestWhereInput {
  const m = user.access.modules.get("SPONSORING");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/** Demandes « autre » Ad & Pro : portée ALL voit tout ; sinon ses demandes (le délégué, 27/10/2026). */
export function scopeAdProOther(user: SessionUser): Prisma.AdProOtherRequestWhereInput {
  const m = user.access.modules.get("AD_PRO_OTHER");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { requesterId: user.id };
}

/** Projets BD (Projet → Gamme → Produit) : scope ALL voit tout ; sinon le
 *  propriétaire du projet + les projets explicitement accordés (RowGrant). */
export function scopeBdProject(user: SessionUser): Prisma.BdProjectWhereInput {
  const m = user.access.modules.get("BD_PROJECTS");
  /**
   * LA PORTÉE SE LIT SUR LE MODULE `BD_PROJECTS` LUI-MÊME (§118.163) : sans le module, rien ;
   * avec, la portée que la console lui a donnée — tout le registre par défaut (`defaultScope`).
   *
   * Elle a longtemps été DÉDUITE de Regulatory, parce que le registre vivait sous
   * `BUSINESS_DEVELOPMENT`, un module retiré que `getAccess` n'accorde à personne : sans cette
   * déduction, la portée rendait « rien » à TOUT LE MONDE, et quatre lecteurs le payaient —
   * l'écran Projets, la porte par ligne, la liste déroulante « Projet » de Regulatory et la fiche
   * d'un projet (§118.61). Le module propre remplace la déduction : la console l'ouvre ou le ferme,
   * et le défaut reproduit exactement l'ancienne porte (qui voit Regulatory lit le registre).
   *
   * Le registre est une liste d'ÉTIQUETTES : ce qu'un projet contient (les dossiers) reste filtré
   * par `regulatoryVisibleWhere`, et l'ENTITÉ du projet se compose à part (`projetsBdVisibles`).
   */
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.BdProjectWhereInput[] = [{ ownerId: user.id }];
  const ids = grantsFor(user, "BD_PROJECT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/** Demandes de support : ALL voit tout ; sinon le demandeur, le destinataire (nommé ou
 *  par rôle visé) et le répondant assigné. */
export function scopeSupport(user: SessionUser): Prisma.SupportRequestWhereInput {
  const m = user.access.modules.get("SUPPORT");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { targetUserId: user.id }, { targetRole: user.role }, { assignedToId: user.id }] };
}

/** Dossiers de suivi : la Direction (scope ALL) voit tout ; sinon on ne voit que
 *  les dossiers créés, dont on est responsable, ou où l'on participe. */
export function scopeDossiers(user: SessionUser): Prisma.DossierWhereInput {
  const m = user.access.modules.get("DOSSIERS");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ createdById: user.id }, { assignedToId: user.id }, { participantIds: { has: user.id } }] };
}

/** Directives : la Direction (scope ALL) voit tout ; un employé ne voit que les
 *  directives qui le ciblent nommément ou qui visent son rôle. */
/**
 * LES DIRECTIVES QU'UNE PERSONNE VOIT.
 *
 * Quatre portées (voir `lib/directives/audience.ts`) et une règle qui prime sur toutes :
 * **une directive non publiée n'existe pour personne d'autre que son auteur**. Elle attend la
 * signature de la direction générale ; la faire apparaître dans la liste de ses destinataires
 * avant cet accord reviendrait à l'avoir diffusée.
 *
 * `companyIds` : les entités dont la personne relève (fiche employé). Non fourni — depuis un
 * appelant qui ne les connaît pas — les notes d'entité ne remontent tout simplement pas, plutôt
 * que de remonter celles d'une entité qui ne la regarde pas.
 */
export function scopeDirectives(user: SessionUser, companyIds: string[] = []): Prisma.DirectiveWhereInput {
  const m = user.access.modules.get("DIRECTIVES");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const destinataire: Prisma.DirectiveWhereInput[] = [
    { audience: "ALL" },
    { targetUserIds: { has: user.id } },
    { targetRole: user.role },
    ...(user.secondaryRole ? [{ targetRole: user.secondaryRole }] : []),
    ...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
    // Compat : les notes émises avant les portées multiples ne portent que `targetUserId`.
    { targetUserId: user.id },
  ];
  return {
    OR: [
      { fromId: user.id }, // sa propre note, à tout état — sinon il la croirait perdue
      { AND: [{ publication: "PUBLISHED" }, { OR: destinataire }] },
    ],
  };
}

/**
 * INFORMATION MÉDICALE — qui voit quelle déclaration.
 *
 * Portée ALL (le pharmacien responsable) : tout. Sinon, on voit ce qui nous concerne — et
 * « nous concerne » inclut LES DÉCLARATIONS QUE PERSONNE N'A ENCORE PRISES.
 *
 * Le trou, corrigé ici : une déclaration arrive « à déclarer » sans pharmacien assigné
 * (`pharmacistId` nul). Avec l'ancienne règle, celui qui a le droit de la VALIDER ne la voyait
 * pas dans son module — il ne la découvrait que par le raccourci de « Mon espace », c'est-à-dire
 * par accident. Un dossier que personne ne voit est un dossier que personne ne prend : c'est
 * exactement la panne silencieuse que ce module doit empêcher.
 */
export function scopeMedicalInfo(user: SessionUser): Prisma.MedicalInfoDeclarationWhereInput {
  const m = user.access.modules.get("MEDICAL_INFO");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalInfoDeclarationWhereInput[] = [
    { pharmacistId: user.id },
    { requests: { some: { targetUserId: user.id } } },
  ];
  // Qui peut VALIDER une déclaration doit voir celles qui attendent d'être prises en charge.
  if (m.actions.has("VALIDATE")) ors.push({ pharmacistId: null });
  return { OR: ors };
}

/** Admin requests scope: a manager (scope ALL) sees all; others see the ones they
 *  requested, are concerned by, are assigned to, or must validate. */
export function scopeAdminRequests(user: SessionUser): Prisma.AdministrativeRequestWhereInput {
  const m = user.access.modules.get("ADMIN_REQUESTS");
  if (!m) return { id: "__none__" };
  // Les demandes supprimées (soft delete traçable) sont masquées des vues normales.
  if (m.scope === "ALL") return { deletedAt: null };
  // Les PARTICIPANTS ajoutés par le demandeur (`fields.participantIds`, Direction 10/2026) lisent la demande.
  return {
    deletedAt: null,
    OR: [
      { requesterId: user.id }, { concernedUserId: user.id }, { assignedToId: user.id }, { validatorId: user.id },
      { fields: { path: ["participantIds"], array_contains: [user.id] } },
    ],
  };
}

/** Matériel promotionnel : scope ALL voit tout ; sinon l'initiateur Marketing et
 *  l'assistante de direction en charge. */
export function scopePromoMaterial(user: SessionUser): Prisma.PromoMaterialWhereInput {
  const m = user.access.modules.get("PROMO_MATERIAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { assistantId: user.id }] };
}
