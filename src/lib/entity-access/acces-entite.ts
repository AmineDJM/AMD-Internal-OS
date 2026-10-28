/**
 * Accès par enregistrement — LA garde : `canAccessEntity` (module + portée de ligne, entité par entité),
 * les pièces Legal (`accesAuxPiecesLegal`, en lot et par section — elles relisent la garde sur leur
 * parent, d'où le même fichier), la modération et l'échange sur un congé. Réexporté par `lib/entity-access`.
 */

import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere, entitePermisePourFiche } from "@/lib/company";
import { legalKindVisible, legalReaderWhere, legalViewScope, legalWriteAllowed } from "@/lib/lecteurs/legal";
import { canSee as canSeeTask, canAttach as canAttachTask } from "@/lib/tasks/request-flow";
import { recruitmentViewer } from "@/lib/recruitment/access";
import { isOwnBusiness } from "@/lib/ad-pro/attachments";
import { TYPES_ENTITE_AD_PRO } from "@/lib/ad-pro/unified";
import { sectionDeLaNature, type SectionPieces } from "@/lib/ad-pro/doc-categories";
import { porteLeRoleQuiTranche } from "@/lib/personnes/referents-gamme";
import { parentDuPoste, PARENT_ENTITE } from "@/lib/ad-pro-items";
import { poleDe } from "@/lib/lecteurs/consulting";
import { annuaireDuPraticien } from "@/lib/annuaires/acces";
import { getMyCompanies } from "@/lib/company";
import { peutOuvrirLeDossierPromo } from "@/lib/queries/promo-circuit";
import { projetsBdVisibles } from "@/lib/queries/bd";
import { clauseProduitsVisibles } from "@/lib/queries/produits-canoniques";
import { clauseRegulatoryVisible } from "@/lib/queries/regulatory-visibilite";
import { clauseBonsDeCommandePchVisibles, clauseFormationsVisibles, clauseMarchesPchVisibles } from "@/lib/queries/visibilite-listes";
import { isManagerOfUser, getManagementChain } from "@/lib/departments";
import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { tientPourLaSollicitee } from "@/lib/doc-request-interim";
import { canViewDeclaration } from "@/lib/queries/medical-info";
import { estDecideurInfoMed } from "@/lib/medical-info/decideur";
import { clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { accesAuCasPv } from "@/lib/pharmacovigilance/acces";
import { accesAuReleveStockPch } from "@/lib/queries/stock-pch";
import {
  userCan, hasGlobalView, isTopManagement, scopeMedicalDoctors, scopeMedicalVisits, scopeSales, scopeBusinessDevelopment, scopeSupport, scopeDossiers, type Action, type SessionUser,
  annuaireOuvertParConsole, moduleDuDossierRegulatory, hasRole,
} from "@/lib/rbac";
import { sitsOnPaymentCentre } from "@/lib/payments/authorization";
import { moduleDeLEntite } from "./modules";
import { AD_PRO_TYPES, adProStakeholders, dansLaPorteeAdPro, isRequestOwner, societeOuverteAdPro, trancheAdPro } from "./ad-pro";
import { GESTES_D_ECRITURE_DE_PIECE, lecteurDeLaDemandeDeValidation } from "./demande-validation";

/**
 * LES PIÈCES LEGAL qu'une personne peut ouvrir, alimenter ou gérer — EN LOT, par LA règle de la
 * porte unitaire (`canAccessEntity` n'en est que l'appel sur un seul identifiant).
 *
 * ── POURQUOI UNE LECTURE EN LOT ─────────────────────────────────────────────────────────────
 *
 * Les pièces liées d'une fiche Ad & Pro (§118.161) proposent, ligne par ligne, d'ouvrir les PDF
 * d'un devis, d'y en joindre un, de le renommer. Chaque bouton doit correspondre EXACTEMENT à ce
 * que le serveur acceptera — un bouton visible qui refuse ensuite fait chercher la panne au lieu
 * de faire demander le droit. Trente appels unitaires par ouverture de fiche feraient soixante
 * allers-retours (§118.102b) ; une seconde écriture de la règle à côté de la porte finirait par
 * diverger d'elle (§118.5). Il n'y en a donc qu'une, et la porte unitaire la lit.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 *  • La PORTE DE LA FICHE, par nature de pièce, PUIS la portée de la LIGNE : l'entité (les
 *    engagements d'une société ne se lisent pas depuis une autre) ET les lecteurs désignés —
 *    sans ces derniers, un document restreint resterait fermé à l'écran mais ses pièces se
 *    téléchargeraient encore par leur identifiant. Même porte que la liste Legal : un engagement
 *    sans entité y figure, ses pièces s'ouvrent donc aussi.
 *  • La porte de la fiche a TROIS entrées (`legalViewScope`) : Legal ouvre tout le registre, les
 *    Finances la chaîne d'achat (factures et bons de commande), le module « Bons de commande » les
 *    seuls bons de commande (§118.176). Cette fonction ne lisait que la première : la fiche d'une
 *    facture s'ouvrait aux Finances, lui proposait « Joindre » et listait ses fichiers — et le
 *    serveur refusait l'envoi comme le téléchargement. Un bouton offert puis refusé fait chercher
 *    une panne qui n'existe pas (§118.83). L'ÉCRITURE suit la même règle que la fiche
 *    (`legalWriteAllowed`) : Legal partout, les Finances sur la chaîne d'achat ; le module « Bons de
 *    commande » n'écrit rien — signer n'est pas modifier la pièce.
 *  • En LECTURE seulement, pour qui n'a PAS le module : les pièces nées d'un matériel
 *    promotionnel (`sourceType` PROMO_MATERIAL) s'ouvrent à qui ouvre le dossier (§118.152) — le
 *    demandeur qui a déposé la facture, l'assistante qui suit le dossier, le pharmacien qui
 *    instruit la demande de visa. Ce n'est pas une porte vers les contrats : seules les pièces
 *    nées de CE dossier passent, et les droits d'écriture restent ceux de Legal.
 *  • En LECTURE seulement, pour qui TRANCHE une demande Ad & Pro sans avoir Legal (§118.185 —
 *    audit 360°, DM-07) : les DEVIS, BONS DE COMMANDE et FACTURES nés d'une demande qu'elle peut
 *    ouvrir. La Direction Marketing fixe le budget, choisit la catégorie et clôture — sans pouvoir
 *    ouvrir les pièces qui chiffrent ce qu'elle arbitre, elle tranchait à l'aveugle ou sortait de
 *    la plateforme. Trois bornes, et chacune a son cas : la CHAÎNE D'ACHAT seulement (une
 *    convention d'orateur ou un contrat restent derrière Legal — un honoraire nominatif n'est pas
 *    une pièce d'arbitrage) ; une demande qu'elle OUVRE (la porte de la fiche — et pour qui
 *    tranche, la société du demandeur n'est pas une frontière, §118.184 : borner les pièces à SA
 *    société lui ferait trancher une demande dont elle ne peut pas lire les devis) ; les LECTEURS
 *    DÉSIGNÉS, comme partout — un devis restreint le reste. Le matériel
 *    promotionnel a sa propre règle, plus étroite (la directrice du dossier, lue sur
 *    l'organigramme) : il n'entre pas ici. Un contrat de consulting passé aux RH non plus (§118.150).
 *
 * ── CE QUE LA FICHE LEGAL N'OUVRE PAS ───────────────────────────────────────────────────────
 *
 * Les deux exceptions ouvrent la LECTURE DES FICHIERS d'une pièce, pas sa fiche `/legal/[id]`,
 * qui reste derrière les trois portes du registre. `accesAuxPiecesLegalDetaille` le dit pièce par
 * pièce (`horsFiche`) : un titre qui mène à une page refusée est un geste offert puis retiré
 * (§118.83), et l'écran le rend sans lien.
 */
export async function accesAuxPiecesLegal(
  user: SessionUser,
  ids: readonly string[],
  actions: readonly Action[],
): Promise<Map<Action, Set<string>>> {
  return (await accesAuxPiecesLegalDetaille(user, ids, actions)).droits;
}

/** Les sources Ad & Pro dont l'arbitre lit la chaîne d'achat — le registre, sans le matériel. */
const SOURCES_ARBITREES: readonly EntityType[] = [...TYPES_ENTITE_AD_PRO]
  .filter((t) => t !== "PROMO_MATERIAL") as EntityType[];
/** Les sections de pièces que l'arbitre lit : la chaîne d'achat, jamais les engagements. */
const SECTIONS_ARBITREES: ReadonlySet<SectionPieces> = new Set<SectionPieces>(["QUOTE", "PURCHASE_ORDER", "INVOICE"]);

export async function accesAuxPiecesLegalDetaille(
  user: SessionUser,
  ids: readonly string[],
  actions: readonly Action[],
): Promise<{ droits: Map<Action, Set<string>>; horsFiche: Set<string> }> {
  const res = new Map<Action, Set<string>>(actions.map((a) => [a, new Set<string>()]));
  const horsFiche = new Set<string>();
  const uniques = [...new Set(ids.filter(Boolean))];
  if (uniques.length === 0 || actions.length === 0) return { droits: res, horsFiche };
  const readerScope = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });

  // ─── LES EXCEPTIONS DE LECTURE — collectées à part : elles n'ouvrent pas la fiche Legal ─────
  const parException = new Set<string>();
  if (actions.includes("VIEW") && !userCan(user, "LEGAL", "VIEW")) {
    const pieces = await prisma.legalDocument.findMany({
      where: { id: { in: uniques }, sourceType: "PROMO_MATERIAL", sourceId: { not: null } },
      select: { id: true, sourceId: true },
    });
    if (pieces.length > 0) {
      const dossiers = await prisma.promoMaterial.findMany({
        where: { id: { in: [...new Set(pieces.map((p) => p.sourceId as string))] } },
        select: { id: true, requesterId: true, assistantId: true, requestValidatorId: true, marketingValidatorId: true, companyId: true },
      });
      const ouverts = new Set<string>();
      for (const pm of dossiers) if (await peutOuvrirLeDossierPromo(user, pm)) ouverts.add(pm.id);
      for (const p of pieces) if (p.sourceId && ouverts.has(p.sourceId)) parException.add(p.id);
    }

    // LES PIÈCES D'ACHAT D'UN POSTE AD & PRO (§118.204) — devis, BC, facture déposés SUR le poste. Qui
    // voit la demande voit ses pièces : le demandeur qui a déposé le devis, la Direction qui tranche.
    // La porte reste celle de la FICHE de la demande, une fois par demande.
    const liens = await prisma.adProItemPiece.findMany({
      where: { legalDocumentId: { in: uniques } },
      select: {
        legalDocumentId: true,
        item: { select: { sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true } },
      },
    });
    if (liens.length > 0) {
      const ouvertes = new Map<string, boolean>();
      for (const l of liens) {
        const parent = parentDuPoste(l.item);
        if (!parent) continue;
        const cle = `${parent.parent}:${parent.id}`;
        if (!ouvertes.has(cle)) ouvertes.set(cle, await canAccessEntity(user, PARENT_ENTITE[parent.parent], parent.id, "VIEW"));
        if (ouvertes.get(cle)) parException.add(l.legalDocumentId);
      }
    }

    // LES PIÈCES D'ACHAT D'UNE DEMANDE AU SECRÉTARIAT (devis natifs, 10/2026) — devis, BC, facture rangés au registre
    // pour une demande. « Le demandeur valide les références de chaque devis, puis génère le BC » : il doit les LIRE,
    // sans avoir Legal. La porte est celle de la FICHE de la demande (`clauseDemandeLisible` : sa portée du module, le
    // validateur d'une pièce, l'intérimaire) — une fois par demande ; les engagements (contrats) restent fermés.
    const achatsDemande = (await prisma.legalDocument.findMany({
      where: { id: { in: uniques }, sourceType: "ADMIN_REQUEST", sourceId: { not: null } },
      select: { id: true, kind: true, sourceId: true },
    })).filter((p) => SECTIONS_ARBITREES.has(sectionDeLaNature(String(p.kind))));
    if (achatsDemande.length > 0) {
      const lisibles = new Set<string>();
      for (const demandeId of new Set(achatsDemande.map((p) => p.sourceId as string))) {
        const n = await prisma.administrativeRequest.count({ where: await clauseDemandeLisible(user, demandeId) });
        if (n > 0) lisibles.add(demandeId);
      }
      for (const p of achatsDemande) if (lisibles.has(p.sourceId as string)) parException.add(p.id);
    }

    if (porteLeRoleQuiTranche(user)) {
      // La société de la PIÈCE n'est pas relue : c'est la porte de la FICHE qui décide, plus bas.
      const achats = (await prisma.legalDocument.findMany({
        where: {
          AND: [
            { id: { in: uniques }, sourceType: { in: [...SOURCES_ARBITREES] }, sourceId: { not: null } },
            ...(readerScope ? [readerScope] : []),
          ],
        },
        select: { id: true, kind: true, sourceType: true, sourceId: true },
      })).filter((p) => SECTIONS_ARBITREES.has(sectionDeLaNature(String(p.kind))));
      if (achats.length > 0) {
        // Un contrat de consulting passé aux RH n'est plus une demande Ad & Pro : son arbitre
        // n'est pas la Direction Marketing, et ses pièces ne passent pas par ici (§118.150).
        const contrats = [...new Set(achats.filter((p) => p.sourceType === "CONSULTING_CONTRACT").map((p) => p.sourceId as string))];
        const horsAdPro = new Set(contrats.length
          ? (await prisma.consultingContract.findMany({ where: { id: { in: contrats } }, select: { id: true, pole: true } }))
              .filter((c) => poleDe(c.pole) !== "AD_PRO").map((c) => c.id)
          : []);
        // LA PORTE DE LA FICHE, une fois par demande — une fiche porte presque toujours toutes les
        // pièces affichées, donc un seul appel en pratique.
        const sources = new Map<string, { type: EntityType; id: string }>();
        for (const p of achats) {
          if (p.sourceType === "CONSULTING_CONTRACT" && horsAdPro.has(p.sourceId as string)) continue;
          sources.set(`${p.sourceType}:${p.sourceId}`, { type: p.sourceType as EntityType, id: p.sourceId as string });
        }
        const ouvertes = new Set<string>();
        for (const [cle, s] of sources) if (await canAccessEntity(user, s.type, s.id, "VIEW")) ouvertes.add(cle);
        for (const p of achats) if (ouvertes.has(`${p.sourceType}:${p.sourceId}`)) parException.add(p.id);
      }
    }
  }

  // LA PORTE DE LA FICHE, par nature : les mêmes trois entrées que `/legal/[id]`.
  const portee = legalViewScope({
    onLegal: userCan(user, "LEGAL", "VIEW"),
    onFinances: userCan(user, "FINANCES", "VIEW"),
    onBonsDeCommande: userCan(user, "PURCHASE_ORDERS", "VIEW"),
  });
  const financesEcrivent = userCan(user, "FINANCES", "UPDATE");
  const permis = (a: Action, kind: string): boolean => {
    if (userCan(user, "LEGAL", a)) return true;
    if (a === "VIEW") return legalKindVisible(portee, kind);
    // Les gestes que la fiche offre à qui peut ÉCRIRE la pièce — joindre, renommer, retirer.
    if (GESTES_D_ECRITURE_DE_PIECE.includes(a)) return legalWriteAllowed({ onLegal: false, onFinances: financesEcrivent, kind });
    return false;
  };
  const candidates = actions.filter((a) =>
    userCan(user, "LEGAL", a)
    || (a === "VIEW" && portee !== "NONE")
    || (GESTES_D_ECRITURE_DE_PIECE.includes(a) && financesEcrivent));
  if (candidates.length > 0) {
    const dansLaPortee = await prisma.legalDocument.findMany({
      where: await companyScopedWhere(user.id, {
        AND: [{ id: { in: uniques } }, ...(readerScope ? [readerScope] : [])],
      }),
      select: { id: true, kind: true },
    });
    for (const d of dansLaPortee) for (const a of candidates) if (permis(a, String(d.kind))) res.get(a)!.add(d.id);
  }
  // Ce que seule une exception ouvre se LIT ici, mais sa fiche Legal reste fermée.
  if (parException.size > 0) {
    const vue = res.get("VIEW")!;
    for (const id of parException) if (!vue.has(id)) { horsFiche.add(id); vue.add(id); }
  }
  return { droits: res, horsFiche };
}

export async function canAccessEntity(
  user: SessionUser,
  entityType: EntityType,
  entityId: string,
  action: Action = "VIEW",
): Promise<boolean> {
  const module = await moduleDeLEntite(entityType, entityId);

  // DEMANDE DE PIÈCE : l'accès ne vient PAS du module de l'objet visé. Celui à qui l'on réclame
  // une facture n'a pas forcément accès au poste de dépense — et il ne doit pas y avoir accès
  // pour autant. Il vient du fil : on a demandé, ou on est celui à qui l'on demande.
  if (entityType === "DOCUMENT_REQUEST") {
    if (hasGlobalView(user.role)) return true;
    const r = await prisma.documentRequest.findUnique({
      where: { id: entityId }, select: { askedById: true, askedToId: true, status: true, entityType: true, kind: true },
    });
    if (!r) return false;
    if (r.askedById === user.id) return true;
    // Celui qui dépose ne peut plus toucher aux pièces une fois la demande close : sinon on ne
    // saurait plus laquelle a servi à la décision. L'INTÉRIMAIRE de l'assistante sollicitée pour le BC d'un
    // poste Ad & Pro dépose à sa place (`tientPourLaSollicitee` — audit Assistante de direction, 10/2026).
    if (r.askedToId !== user.id && !(await tientPourLaSollicitee(user.id, r))) return false;
    return action === "VIEW" || (r.status !== "ACCEPTED" && r.status !== "CANCELLED");
  }

  // LES PIÈCES D'UNE PROPOSITION DE LA CAMPAGNE BUDGÉTAIRE (10/2026) : la règle de la campagne, pas le module
  // Budgets — le responsable du pôle, les valideurs nommés, la vue de la Direction sur la campagne.
  if (entityType === "BUDGET") {
    const prop = await prisma.budgetProposal.findUnique({
      where: { id: entityId },
      select: { campaign: { select: { validatorIds: true } }, department: { select: { head: { select: { userId: true } }, deputy: { select: { userId: true } } } } },
    });
    if (prop) {
      const tient = prop.department?.head?.userId === user.id || prop.department?.deputy?.userId === user.id;
      if (user.role === "SUPER_ADMIN" || tient) return true;
      if (prop.campaign.validatorIds.includes(user.id)) return action === "VIEW";
      return action === "VIEW" && userCan(user, "BUDGET_CAMPAIGN", "VIEW") && user.access.modules.get("BUDGET_CAMPAIGN")?.scope === "ALL";
    }
  }

  // UNE DÉCLARATION D'INFORMATION MÉDICALE : la règle de SA FICHE (§118.184 — audit 360°, S12).
  //
  // Ce type tombait dans le `default` — le droit de module suffisait : tout porteur du module téléchargeait
  // les pièces de n'importe quelle déclaration (attestations, récépissés du ministère, pièces demandées à
  // un organisateur), alors que la fiche ne s'ouvre qu'au pharmacien en charge, à qui valide, à la vue
  // globale — et à la personne SOLLICITÉE pour une pièce, qui doit pouvoir relire ce qu'elle a déposé
  // (`canViewDeclaration`, la même fonction que la fiche : une seconde écriture divergerait, §118.5).
  // Joindre, renommer ou retirer une pièce reste à qui INSTRUIT ; la personne sollicitée dépose SA pièce
  // par son propre geste (`fulfillDocRequest`).
  if (entityType === "MEDICAL_INFO_DECLARATION") {
    const decl = await prisma.medicalInfoDeclaration.findUnique({
      where: { id: entityId },
      select: { pharmacistId: true, requests: { select: { targetUserId: true } }, slips: { select: { requestId: true } } },
    });
    if (!decl || !canViewDeclaration(user, decl)) return false;
    if (action === "VIEW") return true;
    return decl.pharmacistId === user.id || hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");
  }

  // UNE DEMANDE DE VALIDATION : la règle de SA FICHE (audit 360°, lot C3). Ce type tombait dans le
  // `default` — le droit de module suffisait : tout porteur du module téléchargeait, par l'identifiant,
  // la pièce jointe d'une demande qui ne le concernait pas (un contrat, une facture), alors que la
  // fiche `/validations/[id]` ne s'ouvre qu'au demandeur, aux validateurs et au Super Admin. Une
  // fonction pour les deux lecteurs (`lecteurDeLaDemandeDeValidation`) : deux écritures de « qui voit
  // cette demande » finiraient par répondre autrement (§118.5, §118.177).
  if (entityType === "VALIDATION_REQUEST") {
    const v = await prisma.validationRequest.findUnique({
      where: { id: entityId }, select: { requesterId: true, steps: { select: { validatorId: true } }, participants: { select: { userId: true } } },
    });
    return v ? lecteurDeLaDemandeDeValidation(user, v, action) : false;
  }

  // UN CAS DE PHARMACOVIGILANCE (Direction, 06/10) : la règle de SA FICHE, avant le droit de module — une personne
  // ajoutée à l'échange n'a pas forcément le module, et un KAM qui l'a ne lit que SES signalements.
  if (entityType === "PHARMACOVIGILANCE_CASE") return accesAuCasPv(user, entityId, action);
  // UN RELEVÉ DU STOCK PCH CENTRAL : la chaîne d'approvisionnement seule (un KAM ne lit pas la position de la PCH).
  if (entityType === "STOCK_PCH_RELEVE") return accesAuReleveStockPch(user, entityId, action);

  // POSTE DE DÉPENSE : l'accès ne vient PAS d'un module, il vient de SON OPÉRATION.
  //
  // Un poste n'existe pas tout seul — il est le stand d'un congrès, le traiteur d'un événement,
  // l'hôtellerie d'un sponsoring. Le rattacher à un module écrit à la main était une devinette,
  // et elle était FAUSSE : `ENTITY_MODULE` annonce `SPONSORING` pour tous les postes, or le
  // délégué médical et le manager promotion médicale — mesuré, les deux seuls rôles qui portent
  // `EVENTS` et `CONGRESS_NATIONAL` sans `SPONSORING` — sont précisément les auteurs typiques
  // d'un événement ou d'un congrès national. Le demandeur ne pouvait donc rien joindre ni
  // commenter sur le poste de SA propre demande, alors que l'opération, elle, lui est ouverte :
  // une porte fermée juste à côté d'une porte ouverte, sur la même chose (§118.71).
  //
  // On DÉLÈGUE, on ne recopie pas : la règle d'une opération Ad & Pro est déjà écrite plus bas
  // (parties prenantes, demandeur, droits de module) et la redire ici en ferait une seconde
  // vérité qui prendrait du retard au premier ajustement (§118.5).
  if (entityType === "AD_PRO_ITEM") {
    const poste = await prisma.adProItem.findUnique({
      where: { id: entityId },
      select: { sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true },
    });
    if (!poste) return false;
    const parent = parentDuPoste(poste);
    if (!parent) return false;
    return canAccessEntity(user, PARENT_ENTITE[parent.parent], parent.id, action);
  }

  // PROJET BD : son propre module, `BD_PROJECTS` (§118.163) — celui que le Super Admin règle dans
  // Administration › Accès. Market Intelligence, dont il vient, reste retiré. La ligne se lit dans
  // la MÊME clause que la liste (`projetsBdVisibles` : portée du module ∧ entité), sans quoi une
  // fiche s'ouvrirait sur un projet que la liste cache — ou l'inverse.
  // UN DOSSIER RÉGLEMENTAIRE : le geste se lit sur le module de SON écran (Direction, 08/10) — « Pipeline
  // réglementaire » s'il est verrouillé, Regulatory (suivi des dossiers) sinon —, puis la ligne dans LA MÊME RÈGLE
  // QUE LA LISTE (§118.184) : portée métier, gamme, ET entité, pour toutes les sociétés auxquelles la personne a
  // droit. (Le module de la ligne ne sert qu'à la garde : l'imputation budgétaire d'un BV reste sur Regulatory.)
  if (entityType === "REGULATORY_PRODUCT") {
    const dossier = await prisma.regulatoryProduct.findUnique({ where: { id: entityId }, select: { isLocked: true } });
    if (!dossier || !userCan(user, moduleDuDossierRegulatory(dossier), action)) return false;
    const found = await prisma.regulatoryProduct.findFirst({
      where: { AND: [{ id: entityId }, await clauseRegulatoryVisible(user, "fiche")] },
      select: { id: true },
    });
    return Boolean(found);
  }

  if (entityType === "BD_PROJECT") {
    if (!userCan(user, "BD_PROJECTS", action)) return false;
    const found = await prisma.bdProject.findFirst({
      where: { AND: [{ id: entityId }, await projetsBdVisibles(user)] }, select: { id: true },
    });
    return Boolean(found);
  }

  // DEMANDE DE PAIEMENT : l'accès ne vient PAS d'un module, mais du CERCLE du dossier.
  //
  // N'importe qui peut avoir à faire payer une facture — la Direction Marketing, une assistante, un
  // délégué — sans avoir la moindre raison de voir le grand livre ou la trésorerie. Exiger le
  // module Finances fermerait les pièces à ceux-là mêmes qui doivent les déposer ; exiger le
  // module de validation les fermerait à qui dépose sa première demande.
  //
  // La garde est donc le CERCLE du dossier — demandeur, destinataire, Finances — et elle ne
  // dépend PAS de l'écran où le dossier s'affiche. C'est ce qui lui a permis de traverser sans
  // dommage ses deux déménagements (Validations → Finances → Validations).
  // LES PIÈCES D'UN ORDRE DE DÉPENSE SE LISENT AU CENTRE DE PAIEMENT ET PAR LEUR DEMANDEUR.
  //
  // Le centre autorise une sortie d'argent : il doit pouvoir OUVRIR la proforma jointe à la demande
  // (un BV de dossier réglementaire, par exemple), même sans le module Finances — un siège nommé ne
  // l'a pas forcément. Le demandeur relit ce qu'il a joint. LECTURE SEULE, et pour un siège, dans
  // une société qu'il voit (la même portée que la file du centre). Sinon : la règle ordinaire.
  if (entityType === "EXPENSE_ORDER" && action === "VIEW") {
    const o = await prisma.expenseOrder.findUnique({ where: { id: entityId }, select: { requestedById: true, companyId: true } });
    if (o && o.requestedById === user.id) return true;
    if (o && sitsOnPaymentCentre(user) && (await entitePermisePourFiche(user.id, o.companyId))) return true;
  }

  if (entityType === "PAYMENT_REQUEST") {
    if (hasGlobalView(user.role)) return true;
    const r = await prisma.paymentRequest.findUnique({
      where: { id: entityId }, select: { requesterId: true, recipientId: true },
    });
    if (!r) return false;
    if (r.requesterId === user.id || r.recipientId === user.id) return true;
    return user.role === "FINANCE_BUDGET_MANAGER"
      || userCan(user, "FINANCES", "VALIDATE") || userCan(user, "FINANCES", "UPDATE");
  }

  // DIRECTIVE : la pièce jointe EST souvent la note (un PDF signé, un formulaire). Elle suit
  // donc exactement la note — même portée, même règle de publication. Le module seul ne suffit
  // pas : presque tout le monde a « Directives », et une note adressée aux salariés d'une entité
  // ne s'ouvre pas à ceux d'à côté.
  if (entityType === "DIRECTIVE") {
    if (hasGlobalView(user.role)) return true;
    const d = await prisma.directive.findUnique({
      where: { id: entityId },
      select: {
        audience: true, targetUserIds: true, targetUserId: true, targetRole: true,
        companyId: true, publication: true, fromId: true,
      },
    });
    if (!d) return false;
    if (d.fromId === user.id) return true;
    // Déposer une pièce reste l'affaire de l'émetteur et de la Direction : un destinataire
    // répond dans le fil, il n'ajoute pas de document à la note de service.
    if (action !== "VIEW") return userCan(user, "DIRECTIVES", "CREATE");
    if (d.publication !== "PUBLISHED") return userCan(user, "DIRECTIVES", "CREATE");
    const { isRecipient } = await import("@/lib/directives/audience");
    const { companyIdsOf } = await import("@/lib/directives/recipients");
    return isRecipient(
      { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, companyIds: await companyIdsOf(user.id) },
      {
        audience: d.audience,
        // Compat : les notes d'avant les portées multiples ne portent que `targetUserId`.
        targetUserIds: d.targetUserIds.length ? d.targetUserIds : (d.targetUserId ? [d.targetUserId] : []),
        targetRole: d.targetRole,
        companyId: d.companyId,
      },
    );
  }

  // Le DEMANDEUR d'une demande de sponsoring/congrès peut toujours consulter et
  // joindre des pièces à SA propre demande (devis, programme…), même si son rôle
  // n'a pas le droit UPLOAD du module.
  if (
    (action === "VIEW" || action === "UPLOAD") &&
    (entityType === "SPONSORING" || entityType === "CONGRESS_INTERNATIONAL" || entityType === "CONGRESS_NATIONAL" || entityType === "EVENT" || entityType === "AD_PRO_OTHER") &&
    (await isRequestOwner(user, entityType, entityId))
  ) {
    return true;
  }

  // JOINDRE UNE PIÈCE À UN DOSSIER Ad&Pro : QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE.
  //
  // « On veut associer une facture à l'événement, mais je n'arrive pas à joindre de PJ. » Le droit
  // `UPLOAD` du module était exigé, et lui seul : la Direction qui valide le dossier, le chef de
  // produit qui l'a analysé, l'assistante qui le suit ne pouvaient rien déposer dès que cette case
  // ne leur avait pas été cochée. Ils envoyaient donc la facture par mail, et le dossier restait
  // vide — c'est-à-dire exactement ce que l'ERP existe pour éviter.
  //
  // Joindre une pièce n'est pas un pouvoir : c'est le geste qui rend le dossier lisible. La règle
  // est la MÊME que celle des écrans (`ad-pro/attachments.ts`, pure et testée) : un bouton visible
  // qui refuse ensuite fait chercher la panne au lieu de faire demander le droit.
  if ((action === "UPLOAD" || action === "VIEW") && AD_PRO_TYPES.includes(entityType)) {
    const parties = await adProStakeholders(entityType, entityId);
    if (!parties) return false;
    if (isOwnBusiness(user.id, parties)) return true;
    // Le droit d'ÉCRIRE dans le module ouvre le dossier — DANS SA PORTÉE DE LIGNE (§118.153), et DANS
    // UNE SOCIÉTÉ QU'ON A LE DROIT DE VOIR (§118.184). Ce raccourci passait AVANT le contrôle de société
    // plus bas : un délégué lisait l'événement d'une autre société par son seul identifiant.
    if (
      (userCan(user, module, "UPDATE") || userCan(user, module, "VALIDATE")) &&
      (await societeOuverteAdPro(user, module, parties)) &&
      (await dansLaPorteeAdPro(user, entityType, entityId))
    ) return true;
  }

  // L'Assistante de Direction pilote le circuit Matériel promotionnel depuis les
  // Demandes administratives, SANS accès au module dédié : elle peut consulter,
  // joindre et gérer les pièces du dossier promo lié.
  if (entityType === "PROMO_MATERIAL" && hasRole(user, "DIRECTION_ASSISTANT")) {
    return true;
  }

  // L'Assistante de Direction tient le **bureau du secrétariat** : elle modère TOUTE
  // demande administrative (éditer/supprimer les messages, supprimer / renommer /
  // re-téléverser les pièces jointes), quel que soit le demandeur ou l'assignation.
  if (entityType === "ADMIN_REQUEST" && hasRole(user, "DIRECTION_ASSISTANT")) {
    return true;
  }

  // Information médicale : le pharmacien responsable (ou un manager info médicale)
  // qui instruit une déclaration peut CONSULTER les pièces de l'événement SOURCE
  // (congrès / sponsoring), même sans accès au module concerné.
  if (
    action === "VIEW" &&
    (entityType === "SPONSORING" || entityType === "CONGRESS_INTERNATIONAL" || entityType === "CONGRESS_NATIONAL" || entityType === "EVENT")
  ) {
    // Le DÉCIDEUR aussi (le Directeur des Opérations, `medical-info/decideur.ts`) : la fiche lui montre
    // les pièces de l'événement sur lequel il tranche — un lien qui lui répondrait « interdit » le
    // ferait décider sans les avoir lues.
    const decideur = estDecideurInfoMed(user) && userCan(user, "MEDICAL_INFO", "VIEW");
    const isMedManager = hasGlobalView(user.role) || user.role === "MEDICAL_INFO_PHARMACIST" || userCan(user, "MEDICAL_INFO", "VALIDATE") || decideur;
    if (isMedManager) {
      const decl = await prisma.medicalInfoDeclaration.findUnique({
        where: { sourceType_sourceId: { sourceType: entityType, sourceId: entityId } },
        select: { pharmacistId: true },
      });
      if (decl && (decl.pharmacistId === user.id || hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE") || decideur)) {
        return true;
      }
    }
  }

  // Demande RH : l'employé demandeur peut consulter et joindre des pièces à SA
  // demande (justificatif, arrêt maladie…), même sans droit sur le module RH.
  // UNE FORMATION (§118.184) — la règle de SA LISTE, pas une seconde écriture (§118.5) : la demandeuse,
  // les participants, son N+1, les RH et la vue globale ; plus la chaîne au-dessus du demandeur, qui
  // peut trancher (`deciderFor`) et doit donc pouvoir ouvrir les pièces sur lesquelles elle tranche.
  // Sans ce cas, les pièces d'une formation s'écrivaient sous DOSSIER et la porte cherchait un sujet
  // qui n'existe pas : personne ne rouvrait le devis joint (audit 360°, S4).
  if (entityType === "TRAINING") {
    const visible = await prisma.training.findFirst({
      where: { AND: [{ id: entityId }, await clauseFormationsVisibles(user)] },
      select: { id: true },
    });
    const t = await prisma.training.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    if (!t) return false;
    const dansLaChaine = !visible && t.requesterId && t.requesterId !== user.id
      ? await isManagerOfUser(user.id, t.requesterId)
      : false;
    if (!visible && !dansLaChaine) return false;
    if (action === "VIEW" || action === "UPLOAD") return true;
    // Renommer ou retirer une PIÈCE : qui porte la demande, les RH, la vue globale — pas un collègue
    // participant, ni le N+1 qui la tranche.
    return t.requesterId === user.id || hasGlobalView(user) || userCan(user, "TRAINING", "UPDATE") || userCan(user, "TRAINING", "VALIDATE");
  }

  if (entityType === "HR_REQUEST" && (action === "VIEW" || action === "UPLOAD" || action === "UPDATE")) {
    const req = await prisma.hrDocumentRequest.findUnique({ where: { id: entityId }, select: { employee: { select: { userId: true } } } });
    if (req?.employee?.userId === user.id) return true;
  }

  // Ordre de mission (accompagnant / délégué de référence) : la personne assignée
  // accède toujours à SON assignation (voir, joindre l'ordre de mission, discuter,
  // demander). Sinon on délègue à l'accès de l'entité parente (responsables) — VIEW
  // pour consulter, UPDATE pour émettre/gérer. La suppression passe par le parent.
  if (entityType === "MISSION_ASSIGNMENT") {
    const a = await prisma.missionAssignment.findUnique({
      where: { id: entityId },
      select: { userId: true, entityType: true, entityId: true },
    });
    if (!a) return false;
    if (a.userId === user.id) return action !== "DELETE";
    // LA MISSION D'UN MEMBRE DE L'ÉQUIPE (Direction, 10/2026) : la Direction Marketing et le Super Admin tranchent la
    // participation, l'assistante de direction y dépose billet et hôtel — ils voient la mission, son fil et ses pièces.
    if (action !== "DELETE" && (hasRole(user, "PRODUCT_MANAGER") || hasRole(user, "SUPER_ADMIN") || hasRole(user, "DIRECTION_ASSISTANT"))) return true;
    // Le N+1 qui valide l'ordre ou la note de frais, et les RH qui les traitent, lisent la mission (justificatifs compris).
    if (action === "VIEW") {
      const lie = await prisma.hrDocumentRequest.findFirst({ where: { missionAssignmentId: entityId, managerUserId: user.id }, select: { id: true } });
      if (lie) return true;
      if (userCan(user, "HR_REQUESTS", "VIEW") && (await prisma.hrDocumentRequest.count({ where: { missionAssignmentId: entityId } })) > 0) return true;
    }
    return canAccessEntity(user, a.entityType, a.entityId, action === "VIEW" ? "VIEW" : "UPDATE");
  }

  // ── L'ANNUAIRE OUVERT PAR LA CONSOLE (§118.147) ─────────────────────────────────────────
  //
  // Un praticien appartient à l'annuaire des médecins ou des pharmaciens, selon son GRADE. Quand
  // la console a ouvert cet annuaire à la personne, il lui est ouvert EN ENTIER, avec les gestes
  // cochés — sans le module de la Promotion médicale, dont la portée par délégué ne s'applique
  // donc pas ici. On ne lit la fiche que si une section est ouverte : pour tous les autres, ce
  // passage ne coûte rien.
  if (entityType === "DOCTOR" && (user.access.modules.get("DIRECTORIES")?.sections?.size ?? 0) > 0
    && (action === "VIEW" || action === "CREATE" || action === "UPDATE" || action === "DELETE")) {
    const fiche = await prisma.medicalDoctor.findUnique({ where: { id: entityId }, select: { title: true } });
    if (fiche && annuaireOuvertParConsole(user, annuaireDuPraticien(fiche.title), action)) return true;
  }

  // ── LES PIÈCES D'UN MATÉRIEL PROMOTIONNEL (§118.152) ─────────────────────────────────────
  //
  // Le bon de commande qu'un dossier du nouveau circuit a fait GÉNÉRER, et la facture qui en
  // découle, sont des pièces Legal rattachées au dossier (`sourceType` PROMO_MATERIAL). Leur
  // demandeur n'a pas le module Legal — c'est pourtant lui qui a déposé la facture et qui doit
  // pouvoir la rouvrir, comme l'assistante qui suit le dossier et le pharmacien qui instruit sa
  // demande de visa. On les ouvre en LECTURE à qui ouvre le dossier (la MÊME règle que la fiche),
  // et à rien de plus : ce n'est pas une porte vers les contrats — seules les pièces nées de CE
  // dossier passent ici, les droits d'écriture de Legal restent ceux de Legal.
  // LE DOSSIER LUI-MÊME, en LECTURE, pour les mêmes personnes que la fiche (§118.152) : le N+1 qui
  // valide la demande, la directrice marketing qui valide le devis, le pharmacien qui instruit le
  // visa n'ont pas forcément le module. La fiche leur est ouverte ; sans cette porte, ses pièces
  // (scans des devis, maquettes) et son fil de discussion leur répondaient « accès refusé » sur
  // l'écran même où on leur demande de décider.
  // Et pour qui A le module en « ses lignes » aussi (§118.153) : le National Sales demande pour
  // lui-même ET valide la demande de son KAM — le dossier du KAM n'est pas dans sa portée, et c'est
  // pourtant la fiche où on lui demande de trancher.
  if (entityType === "PROMO_MATERIAL" && action === "VIEW") {
    const pm = await prisma.promoMaterial.findUnique({
      where: { id: entityId },
      select: { id: true, requesterId: true, assistantId: true, requestValidatorId: true, marketingValidatorId: true, companyId: true },
    });
    if (pm && (await peutOuvrirLeDossierPromo(user, pm))) return true;
  }

  // UNE PIÈCE LEGAL — la règle vit dans `accesAuxPiecesLegal`, qui la sert aussi EN LOT : l'écran
  // qui liste les pièces liées d'une fiche (§118.161) doit montrer exactement ce que cette porte
  // laissera ouvrir, et deux écritures de la même règle finiraient par diverger (§118.5).
  if (entityType === "LEGAL_DOCUMENT") {
    return (await accesAuxPiecesLegal(user, [entityId], [action])).get(action)?.has(entityId) ?? false;
  }

  // UNE DÉPENSE DE TRÉSORERIE SE LIT AUSSI DEPUIS LES BUDGETS (Direction, 06/10) : la liste « à imputer » la montre à qui
  // voit les budgets — la partager pour demander si elle est payée ne doit pas exiger, en plus, le module Finances.
  if (entityType === "FINANCE_TRANSACTION" && action === "VIEW" && userCan(user, "BUDGETS", "VIEW")) return true;

  // JOINDRE UNE PIÈCE À SA TÂCHE (Direction, 06/10 : « un employé essaie d'uploader, ça ne veut pas ») : « Mon espace »
  // n'accorde pas le verbe UPLOAD (aucun rôle hors Super Admin ne l'a), si bien que la personne chargée d'une tâche se
  // voyait offrir « Joindre » puis refuser le dépôt, quel que soit le type choisi. Pour une tâche, c'est SON CERCLE qui
  // décide (la personne chargée, le demandeur — `canAttachTask`), sous le simple droit d'ouvrir « Mon espace ».
  if (entityType === "TASK" && (action === "UPLOAD" || action === "DELETE")) {
    if (!userCan(user, "WORKSPACE", "VIEW")) return false;
    const t = await prisma.task.findUnique({
      where: { id: entityId },
      select: { assignedToId: true, createdById: true, participantIds: true, readerIds: true, status: true, requestedAt: true },
    });
    if (!t) return false;
    if (hasGlobalView(user.role)) return true;
    return canSeeTask(t, user.id) && canAttachTask(t, user.id);
  }

  if (!userCan(user, module, action)) return false;

  // ── UN DOSSIER AD & PRO : SES SOCIÉTÉS, OU SES PARTIES PRENANTES (§118.184) ─────────────────────
  //
  // L'audit 360° l'a mesuré : un sponsoring ou un événement tombait dans le `default` plus bas — le droit
  // de module suffisait. Tout délégué (événements : CONTRIBUTE, donc UPDATE) modifiait l'événement d'un
  // collègue, budget et médecins compris, même d'une autre société et après la décision.
  //   - On n'ouvre que les dossiers des sociétés auxquelles on a DROIT (`societeOuverteAdPro`) — sauf
  //     à en être partie prenante, à le trancher, ou à superviser sa gamme.
  //   - ÉCRIRE dans le dossier d'un autre exige de le TRANCHER (VALIDATE — ce que CONTRIBUTE n'a pas) :
  //     contribuer veut dire écrire SES dossiers, pas ceux des collègues. Le superviseur de la gamme
  //     n'y gagne rien : il LIT ce qu'il tranche, sa décision passe par le circuit.
  // Joindre une pièce (UPLOAD) et lire (VIEW) ont leur raccourci plus haut, sous la même règle de société.
  if (AD_PRO_TYPES.includes(entityType)) {
    const parties = await adProStakeholders(entityType, entityId);
    if (!parties) return false;
    if (!(await societeOuverteAdPro(user, module, parties))) return false;
    const ecrit = action === "UPDATE" || action === "DELETE" || action === "VALIDATE";
    if (ecrit && !isOwnBusiness(user.id, parties) && !trancheAdPro(user, module)) return false;
  }

  switch (entityType) {
    // REGULATORY_PRODUCT : traité plus haut, avant le droit de module — il dépend du verrou de la ligne.
    case "PRODUCT": {
      // La clause du CATALOGUE, pas une seconde écriture : un produit se voit par ses dossiers.
      const found = await prisma.product.findFirst({
        where: { AND: [{ id: entityId }, await clauseProduitsVisibles(user)] },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "DOCTOR": {
      // Les clauses se COMPOSENT en `AND`, jamais par étalement (§118.133) : la portée d'un
      // délégué est désormais son PANEL (§118.179), et un étalement qui croiserait une clé `id`
      // remplacerait l'identifiant visé.
      const found = await prisma.medicalDoctor.findFirst({
        where: { AND: [{ id: entityId }, scopeMedicalDoctors(user)] },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "VISIT": {
      const found = await prisma.medicalVisit.findFirst({
        where: { id: entityId, ...scopeMedicalVisits(user) },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "SALE": {
      const found = await prisma.sale.findFirst({
        where: { id: entityId, ...scopeSales(user) },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "BD_OPPORTUNITY": {
      const found = await prisma.businessDevelopmentOpportunity.findFirst({
        where: { id: entityId, ...scopeBusinessDevelopment(user) },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "SUPPORT_REQUEST": {
      const found = await prisma.supportRequest.findFirst({
        where: { id: entityId, ...scopeSupport(user) },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "DOSSIER": {
      const found = await prisma.dossier.findFirst({
        where: { id: entityId, ...scopeDossiers(user) },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "PCH_TENDER": {
      // LA CLAUSE DE LA FICHE (§118.184 — audit 360°, S11) : ce type tombait dans le `default` — le droit
      // de module suffisait, et les pièces d'un marché d'une autre société se lisaient, se joignaient et
      // se supprimaient par son identifiant, comme la fiche elle-même s'ouvrait.
      const found = await prisma.pchTender.findFirst({
        where: { AND: [{ id: entityId }, await clauseMarchesPchVisibles(user.id, "fiche")] },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "PCH_ORDER": {
      // Un bon de commande de marché n'a pas d'entité propre : il hérite de celle de SON marché.
      const found = await prisma.pchOrder.findFirst({
        where: { AND: [{ id: entityId }, await clauseBonsDeCommandePchVisibles(user.id, "fiche")] },
        select: { id: true },
      });
      return Boolean(found);
    }
    case "MAIL_ENTRY": {
      // Le registre est CLOISONNÉ PAR ENTITÉ : avoir le module Courriers ne donne pas accès aux
      // plis d'une autre société du groupe. Sans ce contrôle, une pièce jointe se téléverserait
      // sur le courrier d'une entité voisine en devinant son identifiant.
      //
      // LA MÊME PORTE QUE L'ÉCRAN (`companyScopedWhere`), et c'est ce qui manquait : le filtre
      // STRICT refusait les plis SANS entité, si bien que le scan qu'on venait de joindre à son
      // propre courrier n'était plus téléchargeable par personne — « pièce jointe introuvable ».
      const found = await prisma.mailEntry.findFirst({
        where: await companyScopedWhere(user.id, { id: entityId }),
        select: { id: true },
      });
      return Boolean(found);
    }
    case "COMPANY": {
      // Les pièces d'identité d'une société ne se lisent QUE depuis son périmètre : le module
      // Legal ne donne pas accès aux statuts et au RIB de toutes les sociétés du groupe.
      const mine = await getMyCompanies(user.id);
      return mine.some((c) => c.id === entityId);
    }
    case "TASK": {
      // Une tâche appartient à SON CERCLE — la personne chargée, le demandeur, les participants,
      // les lecteurs — et non à tous ceux qui ont « Mon espace ». Sans ce contrôle, les pièces
      // déposées en réponse à une demande (devis, contrat, bulletin) se téléchargeraient en
      // devinant un identifiant, puisque tout le monde a le module.
      const t = await prisma.task.findUnique({
        where: { id: entityId },
        select: { assignedToId: true, createdById: true, participantIds: true, readerIds: true, status: true, requestedAt: true },
      });
      if (!t) return false;
      if (hasGlobalView(user.role)) return true;
      if (!canSeeTask(t, user.id)) return false;
      // Un LECTEUR regarde : il ne dépose ni ne supprime les pièces d'un travail qui n'est pas
      // le sien. Le demandeur, lui, complète sa propre demande.
      return action === "VIEW" || canAttachTask(t, user.id);
    }
    // LEGAL_DOCUMENT n'arrive jamais ici : il est rendu plus haut par `accesAuxPiecesLegal`.
    case "RECRUITMENT_REQUEST": {
      // Un CV et une fourchette de rémunération sont des données PERSONNELLES : avoir le module
      // ne suffit pas. Il faut être partie à la demande — l'avoir écrite, devoir la valider, ou
      // tenir les RH. Sans cette porte, la fiche de poste et les CV se téléchargeraient en
      // devinant un identifiant.
      return Boolean(await recruitmentViewer(user, entityId));
    }
    case "CONGRESS_INTERNATIONAL":
    case "CONGRESS_NATIONAL":
    case "PROMO_MATERIAL":
    case "SPONSORING":
    case "AD_PRO_OTHER":
      // Sans ces cas, le `default` ci-dessous ouvrait tout dossier à qui avait le module.
      return dansLaPorteeAdPro(user, entityType, entityId);
    case "RECRUITMENT_CANDIDATE": {
      // Le CV suit sa DEMANDE : les mêmes personnes, ni plus ni moins.
      const c = await prisma.recruitmentCandidate.findUnique({
        where: { id: entityId },
        select: { requestId: true },
      });
      return c ? Boolean(await recruitmentViewer(user, c.requestId)) : false;
    }
    case "BUSINESS_UNIT":
    case "TOUR_PLAN":
    case "SALES_SECTOR":
    case "INSTITUTION":
    case "SPECIALTY":
      // Des types d'AUDIT (§118.181), pas des portes. Les laisser tomber dans le `default` ouvrirait
      // à quiconque a le module le droit d'accrocher une pièce ou un commentaire au plan de tournée
      // d'un collègue, par un type forgé — la porte de §118.153g, rouverte par un ajout d'énumération.
      return false;
    default:
      // Modules without row-level scoping: module permission is sufficient.
      return true;
  }
}

/**
 * Peut-on **modérer** le contenu (commentaires, pièces jointes, messages) d'un objet ?
 * Règle unifiée : quiconque peut **éditer** l'objet parent — c'est-à-dire l'administrateur
 * (vue globale, périmètre ALL) ou son responsable/contributeur — peut nettoyer ce qui y a
 * été envoyé. L'auteur d'un élément garde toujours la main sur le sien (vérifié à part).
 */
export async function canModerateEntity(
  user: SessionUser,
  entityType: EntityType,
  entityId: string,
): Promise<boolean> {
  return canAccessEntity(user, entityType, entityId, "UPDATE");
}

/**
 * LA DISCUSSION D'UN CONGÉ (Direction, 07/10 : « ajoute une possibilité de discussion dans les congés ») — qui lit et
 * écrit le fil d'une demande de congé : ceux qui ouvrent déjà le congé (`canAccessEntity`, le module Demandes RH), le
 * SALARIÉ, son N+1 enregistré ou l'intérimaire de ce N+1, la chaîne au-dessus du salarié (la lecture de `leaveDecider`),
 * celui à qui la marche a été remontée et ceux qui l'ont remontée (`LeaveEscalation`), les RH qui tranchent et le sommet.
 *
 * Le FIL seulement : `canAccessEntity` n'est pas élargi, et les justificatifs d'un congé (un certificat médical) restent
 * à ceux qui les ouvraient déjà.
 */
export async function peutEchangerSurConge(user: SessionUser, leaveId: string): Promise<boolean> {
  const l = await prisma.leaveRequest.findUnique({
    where: { id: leaveId },
    select: {
      employeeId: true, managerId: true, currentApproverId: true,
      employee: { select: { userId: true } },
      escalations: { select: { fromUserId: true, toUserId: true } },
    },
  });
  if (!l) return false;
  if (l.employee.userId === user.id) return true;
  if (userCan(user, "HR_REQUESTS", "VALIDATE") || isTopManagement(user)) return true;
  if (l.currentApproverId === user.id) return true;
  if (l.escalations.some((e) => e.fromUserId === user.id || e.toUserId === user.id)) return true;
  if (l.managerId) {
    const n1 = await prisma.employee.findUnique({ where: { id: l.managerId }, select: { userId: true } });
    if (n1?.userId && (n1.userId === user.id || (await actsForUser(user.id, n1.userId)))) return true;
  }
  // La chaîne au-dessus du salarié — une lecture qui échoue n'ouvre rien (comme `leaveDecider`).
  let chaine: { userId: string | null }[] = [];
  try { chaine = await getManagementChain(l.employeeId); } catch { chaine = []; }
  if (chaine.some((m) => m.userId === user.id)) return true;
  return canAccessEntity(user, "LEAVE_REQUEST", leaveId, "VIEW");
}
