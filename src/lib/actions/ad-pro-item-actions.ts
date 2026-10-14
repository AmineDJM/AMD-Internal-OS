"use server";

import { deposerLettreDevis, phraseDepotLettre, societeDeLaLettre } from "@/lib/demande-devis-depot";
import { CHEMIN_STOCK_PROMO, lienStockPromo } from "@/lib/chemins/stock-promo";
import { lienPosteAdPro, lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { revalidatePath } from "next/cache";
import type { AdProItemKind, AdProItemOrderStage, AdProItemStatus, AdProItemBudgetKind, UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, anyRoleFilter, rolesWithModule, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { moneyEntityOf } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/lib/expense-orders";
import { canEmitOrder, canSubmitItem, canRequestPurchaseOrder, canRemoveItem, budgetKindLocked, ITEM_KINDS, ITEM_KIND_LABELS, PARENT_ENTITE, ITEM_STATUS_LABELS, REFUS_INDIRECT_NON_REPARTI, type AdProParent } from "@/lib/ad-pro-items";
import {
  PIECE_SECRETARIAT, NATURES_PIECE_SECRETARIAT, peutDemanderPiece, titrePiece, TITRE_BC_A_ETABLIR,
  type NaturePieceSecretariat,
} from "@/lib/ad-pro/pieces-secretariat";
import { buildRef, createWithRetry, enSerie } from "@/lib/refs";
import { montantDeLaDemande } from "@/lib/ad-pro/montant-demande";
import { fdStr, fdNum, fdCase, type ActionResult } from "@/lib/actions/types";
import { siegeAuCentreAdPro, REFUS_BC_CENTRE_AD_PRO } from "@/lib/ad-pro/centre";
import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC, motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { lireLaMarcheDuBC, notificationDuCentreBC, REFUS_MARCHE_PRISE } from "@/lib/ad-pro/marche-bc";
import { signalerSiASigner } from "@/lib/bons-de-commande/etat";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { etatPostesSponsoring } from "@/lib/ad-pro/cloture-sponsoring";
import { rendreAuMagasin, reserverPourEvenement, sousVerrous, type Tx } from "@/lib/promo/stock-ecriture";
import {
  faitDeStock, lireConfirmation, peutConfirmerMateriel, refusArgentSurPosteStock, refusChangementNature, refusReservation,
  REFUS_CONFIRMATION_MATERIEL, type Confirmation,
} from "@/lib/promo/reservations";
import { libelleArticleStock } from "@/lib/promo/stock";
import { familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import { articleDansMonPerimetre, gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { lireRepartition, libelleLigne, type LigneRepartition } from "@/lib/ad-pro/repartition";
import { ecrireRepartition, type PosteReparti } from "@/lib/ad-pro/repartition-ecriture";
import { STATUTS_EDITABLES, VERSEMENT_SANS_BC, LIBELLE_JUSTIFICATIF_DIRECT, facturePourPayer } from "@/lib/ad-pro/poste-etapes";
import {
  assistantesDeDirection, demanderBcAAssistante, demandesBCDesPostes, annulerDemandesPiecesDuPoste, rattacherPieceAuPoste, piecesDesPostes,
} from "@/lib/ad-pro/pieces-poste";
import { Prisma } from "@prisma/client";
import { validateAttachments } from "@/lib/attach-files";
import { readFileByKey } from "@/lib/storage";
import { resolveParties } from "@/lib/queries/company-contacts";
import { devisDesPostes } from "@/lib/queries/ad-pro-devis-poste";
import { ingererDevisDuPoste, phraseDeLecture } from "@/lib/pieces-lues/devis-poste-lecture";
import {
  refusChangementDeValidation, refusEditionDesLignes, refusGenerationBC, refusTauxDuDevis, type LigneDevisPoste,
} from "@/lib/ad-pro/devis-poste";
import { genererLesBCsDuPoste, phraseBilanGeneration, refusMontantDuPoste, tiersDuDevis, apercuDuBC, lignesDuBCDuDevis, type ApercuDuBC } from "@/lib/ad-pro-bc-devis";
import { MODES_PAIEMENT, type LigneCommerciale } from "@/lib/artifact/factory/commercial";
import {
  ETIQUETTE_BROUILLON, REFUS_VALIDATION_BROUILLON, brouillonNeuf, peutValiderLeBrouillon, signatureDesLignes, totalHtDesLignes,
  type BrouillonBc,
} from "@/lib/bons-de-commande/brouillon";
import { attachFormFiles, persistUploadedDocument } from "@/lib/documents";
import { saisieEffective, type ReferenceProchaine } from "@/lib/references/registre";
import { etatDuRegistre } from "@/lib/references/registre-serveur";
import { controlerFacture, refusDemandePaiementBC, TOLERANCE_DZD, type ControleFacture } from "@/lib/bons-de-commande/copie-signee";
import { lireFactureDuPoste } from "@/lib/ad-pro/facture-poste-lecture";
import { lignesDepuisListes, type ListesDeLignes } from "@/lib/artifact/factory/lignes-saisies";
import { apercuPourEcran, previsualiserRevision, reviserDocumentDrive, type ApercuPiece, type ModificationsDocument } from "@/platform/in-process/artifact/factory";
import {
  lireVoyageur, lireEtapes, nomComplet, ligneVoyageur, changementsVoyageur, porteDesVoyageurs, depassementDevisRetenus, refusRetraitReservation,
  type SaisieVoyageur, type VoyageurLu,
} from "@/lib/ad-pro/voyageurs";
import {
  lireHebergement, changementsHebergement, porteDesHebergements, refusChangementNatureFiches, type SaisieHebergement, type HebergementLu,
} from "@/lib/ad-pro/hebergements";
import { cloreSujetVivant, createDossierRecord, ecrireDansLeSujet } from "@/lib/dossiers-core";
import { gesteVisaPoste, memePrestataire, type EtatBcPoste, type GesteVisaPoste } from "@/lib/ad-pro/bc-poste";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { annulerDemandeSecretariat, prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { apercuSuppression } from "@/lib/admin-delete-registry";
import { annulerBcNonSigne, bcEtablisDuPoste, bcVivantsDesPostes, refusAnnulationBcDuPoste, refusBcEtabli } from "@/lib/ad-pro/bc-etablis";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import {
  droitsValidation, tempsEnAttente, rolesAPrevenir, opsFranchiALaSoumission, libelleTemps,
  type DroitsValidation, type Porteur,
} from "@/lib/ad-pro/validation-poste";

/**
 * POSTES D'UNE OPÉRATION AD & PRO — actions serveur, pour les QUATRE opérations du pôle :
 * sponsoring, prises en charge nationales et internationales, événements.
 *
 * **Chaque poste se valide INDÉPENDAMMENT.** C'est le changement de doctrine demandé par le
 * métier : consulting, traiteur, location de salle ne se décident pas ensemble, et la Direction
 * doit pouvoir accorder l'un, refuser l'autre et demander à revoir le budget du troisième —
 * autant de fois qu'il le faut (`AdProItemDecision` garde chaque tour). L'opération garde son
 * circuit d'ensemble ; les postes ont désormais le leur.
 *
 * Le poste dit AUSSI d'où vient son argent (`budgetKind`) : inclus dans l'enveloppe déjà
 * accordée, ou **rallonge** demandée en plus — sans quoi une rallonge assumée passerait pour un
 * dépassement subi.
 *
 * Chaîne complète, du besoin au paiement :
 *   devis (demande administrative) → pièces jointes → validation du poste (Direction) →
 *   choix du budget → demande d'émission du BC → visa Direction → émission par les Finances
 *   (ordre de dépense).
 *
 * Le **matériel promotionnel** reste à part : il POINTE vers un `PromoMaterial` suivant son
 * propre circuit (visa publicitaire, conformité, agence, BAT). On rattache, on ne recopie pas.
 *
 * **Un seul jeu d'actions pour les quatre modules.** Les différences réelles — où lit-on
 * l'enveloppe, quel statut vaut « accordé », quelle permission, quel chemin revalider — sont
 * rassemblées dans `PARENTS` : un seul endroit à compléter.
 */

interface ParentInfo {
  id: string;
  /** Ce qui identifie l'opération sur une pièce comptable. */
  ref: string;
  /** À qui l'argent va par défaut, quand le poste ne précise pas de bénéficiaire. */
  beneficiary: string;
  /** L'opération est-elle ACCORDÉE ? On n'engage pas une dépense avant. */
  decided: boolean;
  /**
   * Un poste ajouté MAINTENANT l'est-il APRÈS la décision sur l'argent ? Jusqu'ici c'était
   * `decided` : accordée, l'opération avait son montant, et tout poste de plus dépassait
   * l'enveloppe. Un sponsoring PRÉ-VALIDÉ (§118.151) est décidé — l'événement aura lieu, ses
   * postes engagent — sans avoir encore d'enveloppe : ajouter des postes y est l'étape même que
   * la Direction a décrite (« on passe aux ajouts de postes »), pas un ajout tardif. Le marquer
   * tardif afficherait un dépassement sur chaque poste que la procédure demande d'ajouter.
   */
  tardif: boolean;
  /**
   * CLÔTURÉE : la validation finale a arrêté ses postes, leurs montants et leurs budgets, et le
   * total accordé de la demande en est la somme (§118.151). Les réécrire en silence ferait
   * diverger ce total de ses postes. `closedByClosure` distingue la clôture (qui se rouvre) d'une
   * demande close par un transfert (qui vit désormais ailleurs).
   */
  clos: boolean;
  closedByClosure?: boolean;
  /**
   * REFUSÉE OU ANNULÉE (audit 360°, R24–R36) : ses postes restaient soumissibles, décidables, et leur
   * bon de commande demandable — le centre aurait visé ce que les Finances n'auraient jamais pu émettre.
   */
  refusee: boolean;
  /** Qui a demandé l'opération — prévenu des décisions prises sur ses postes. */
  requesterId?: string | null;
  /**
   * La société de l'opération — celle que porte toute pièce demandée pour un de ses postes. Sans
   * elle, la demande au secrétariat naissait sans société et n'apparaissait dans AUCUNE vue
   * cloisonnée du bureau (§118.154).
   */
  companyId?: string | null;
  /** Un sponsoring INDIRECT : les fiches par personne de ses postes sont facultatives (Direction, 06/10). */
  indirect?: boolean;
}

type AdProModule = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENTS";

interface ParentSpec {
  module: AdProModule;
  path: string;
  /** Colonne de rattachement du poste — une par opération, jamais de colonne polymorphe. */
  column: "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId";
  /** Charge ce dont les actions ont besoin, quel que soit le nom des colonnes. */
  load: (id: string) => Promise<ParentInfo | null>;
}

/*
 * Les statuts d'un SPONSORING qui le disent décidé, tardif ou clos vivent dans
 * `ad-pro/cloture-sponsoring.ts` (`etatPostesSponsoring`), lu AUSSI par l'écran : la page en
 * portait une copie écrite à la main, sans `PRE_VALIDATED`, et cachait donc « Émettre l'ordre »
 * sur chaque poste d'un sponsoring pré-validé pendant que cette action l'aurait accepté (§118.5).
 * `PRE_VALIDATED` y est « décidé » : la tenue est décidée, et c'est précisément là que les postes
 * passent par devis, BC et facture — laissé dehors, aucun poste ne pourrait être payé.
 */
const CONGRESS_DECIDED = ["APPROVED", "COMPLETED"];
/** Une demande de congrès ou d'événement refusée ou annulée : ses postes ne partent plus. */
const CONGRESS_FERME = ["REJECTED", "CANCELLED"];

const PARENTS: Record<AdProParent, ParentSpec> = {
  SPONSORING: {
    module: "SPONSORING",
    path: "/sponsoring",
    column: "sponsoringId",
    load: async (id) => {
      const r = await prisma.sponsoringRequest.findUnique({
        where: { id },
        select: { id: true, reference: true, institution: true, status: true, requesterId: true, closedAt: true, companyId: true, nature: true },
      });
      if (!r) return null;
      const etat = etatPostesSponsoring(r.status, r.closedAt);
      return {
        id: r.id, ref: r.reference, beneficiary: r.institution,
        decided: etat.decide, tardif: etat.tardif, clos: etat.clos, closedByClosure: etat.closParLaCloture,
        refusee: r.status === "REFUSED" || r.status === "CANCELLED",
        requesterId: r.requesterId, companyId: r.companyId, indirect: r.nature === "INDIRECT",
      };
    },
  },
  CONGRESS_NATIONAL: {
    module: "CONGRESS_NATIONAL",
    path: "/congress-national",
    column: "congressNationalId",
    load: async (id) => {
      const r = await prisma.congressNational.findUnique({
        where: { id },
        select: { id: true, name: true, hostInstitution: true, requestStatus: true, requesterId: true, companyId: true },
      });
      // Le congrès n'a pas de référence : son nom est ce qui l'identifie sur une pièce.
      if (!r) return null;
      const decided = CONGRESS_DECIDED.includes(r.requestStatus);
      return {
        id: r.id, ref: r.name, beneficiary: r.hostInstitution ?? r.name, decided, tardif: decided, clos: false,
        refusee: CONGRESS_FERME.includes(r.requestStatus), requesterId: r.requesterId, companyId: r.companyId,
      };
    },
  },
  CONGRESS_INTERNATIONAL: {
    module: "CONGRESS_INTERNATIONAL",
    path: "/congress-international",
    column: "congressInternationalId",
    load: async (id) => {
      const r = await prisma.congressInternational.findUnique({
        where: { id },
        select: { id: true, name: true, requestStatus: true, requesterId: true, companyId: true },
      });
      if (!r) return null;
      const decided = CONGRESS_DECIDED.includes(r.requestStatus);
      return {
        id: r.id, ref: r.name, beneficiary: r.name, decided, tardif: decided, clos: false,
        refusee: CONGRESS_FERME.includes(r.requestStatus), requesterId: r.requesterId, companyId: r.companyId,
      };
    },
  },
  EVENT: {
    module: "EVENTS",
    path: "/events",
    column: "eventId",
    load: async (id) => {
      const r = await prisma.event.findUnique({
        where: { id },
        select: { id: true, name: true, requestStatus: true, requesterId: true, status: true, companyId: true },
      });
      if (!r) return null;
      // Un événement peut être organisé SANS circuit de financement (requestStatus null) : il est
      // alors piloté directement, donc ses postes ne sont pas bloqués par une décision absente.
      const decided = r.requestStatus == null ? r.status !== "DRAFT" && r.status !== "CANCELLED" : CONGRESS_DECIDED.includes(r.requestStatus);
      const refusee = r.requestStatus == null ? r.status === "CANCELLED" : CONGRESS_FERME.includes(r.requestStatus);
      return { id: r.id, ref: r.name, beneficiary: r.name, decided, tardif: decided, clos: false, refusee, requesterId: r.requesterId, companyId: r.companyId };
    },
  },
};

const isParent = (v: string): v is AdProParent =>
  v === "SPONSORING" || v === "CONGRESS_NATIONAL" || v === "CONGRESS_INTERNATIONAL" || v === "EVENT";

interface ParentColumns {
  sponsoringId: string | null;
  congressNationalId: string | null;
  congressInternationalId: string | null;
  eventId: string | null;
}

/** Le parent d'un poste, déduit de la colonne renseignée (la base garantit qu'il y en a une). */
function parentOf(item: ParentColumns): { parent: AdProParent; id: string } | null {
  if (item.sponsoringId) return { parent: "SPONSORING", id: item.sponsoringId };
  if (item.congressNationalId) return { parent: "CONGRESS_NATIONAL", id: item.congressNationalId };
  if (item.congressInternationalId) return { parent: "CONGRESS_INTERNATIONAL", id: item.congressInternationalId };
  if (item.eventId) return { parent: "EVENT", id: item.eventId };
  return null;
}

function revalidate(parent: AdProParent, id: string) {
  const { path } = PARENTS[parent];
  revalidatePath(path);
  revalidatePath(`${path}/${id}`);
}

/**
 * Qui peut toucher aux postes.
 *
 * `CREATE`/`UPDATE` suffit pour DÉCRIRE les postes (le demandeur détaille son besoin), mais
 * l'affectation des montants et l'émission des ordres de dépense engagent l'argent : Direction.
 */
function canEditItems(user: SessionUser, parent: AdProParent): boolean {
  const m = PARENTS[parent].module;
  return userCan(user, m, "CREATE") || userCan(user, m, "UPDATE") || hasGlobalView(user);
}
function canAllocate(user: SessionUser, parent: AdProParent): boolean {
  return hasGlobalView(user) || userCan(user, PARENTS[parent].module, "VALIDATE");
}

/**
 * QUI DÉCIDE UN POSTE SE LIT SUR LA MATRICE, PAS SUR UNE LISTE ÉCRITE À LA MAIN (§118.200).
 *
 * `canAllocate` laisse décider la vue globale ET tout rôle qui VALIDE le module de la demande ; la
 * notification, elle, partait à « Direction + Super Admin » (et la Direction Marketing pour le seul
 * sponsoring). Sur un congrès, la Direction Marketing — qui valide ce module — décidait donc des
 * postes sans jamais en être prévenue : un billet d'avion ajouté hors budget restait bloqué chez
 * elle, en silence. Une seule lecture, la même que la porte.
 */
function valideursDuPoste(parent: AdProParent): UserRole[] {
  return [...new Set<UserRole>([...rolesWithModule(PARENTS[parent].module, "VALIDATE"), "DIRECTION", "SUPER_ADMIN"])];
}

/** Les rôles du DEMANDEUR de la demande — c'est lui qui décide qui tient le second temps (§118.204). */
async function demandeurDe(requesterId: string | null | undefined): Promise<Porteur | null> {
  if (!requesterId) return null;
  return prisma.user.findUnique({ where: { id: requesterId }, select: { role: true, secondaryRole: true } });
}

/**
 * CE QUE CETTE PERSONNE TRANCHE SUR LES POSTES D'ARGENT DE CETTE DEMANDE (§118.204) — la même règle que
 * l'écran (`droitsValidation`), lue sur le demandeur de la DEMANDE, jamais du poste.
 */
async function peutTrancherSur(user: SessionUser, owner: { parent: AdProParent; id: string }): Promise<DroitsValidation & { demandeur: Porteur | null }> {
  const info = await PARENTS[owner.parent].load(owner.id);
  const demandeur = await demandeurDe(info?.requesterId);
  return { ...droitsValidation(user, demandeur), demandeur };
}

/** Prévenir ceux qui tiennent un temps de validation — et le Super Admin, qui supplée. */
async function prevenirLeTemps(
  temps: "OPERATIONS" | "MARKETING", demandeur: Porteur | null, titre: string, corps: string, lien: string,
): Promise<void> {
  const roles = [...new Set([...rolesAPrevenir(temps, demandeur), "SUPER_ADMIN"])] as UserRole[];
  await notifyRoles(roles, { type: "VALIDATION_REQUIRED", title: titre, body: corps, link: lien }).catch(() => undefined);
}

async function audit(user: SessionUser, parent: AdProParent, id: string, action: "CREATE" | "UPDATE" | "DELETE", detail: string) {
  await recordAudit({
    actorId: user.id, module: PARENTS[parent].module, entityType: parent, entityId: id, action, summary: detail,
  }).catch(() => undefined);
}

/**
 * UNE OPÉRATION CLÔTURÉE ARRÊTE SES POSTES — et le refus nomme le geste qui rouvre (§118.151).
 *
 * La clôture a validé chaque poste, l'a rangé dans un budget, et a écrit leur somme comme montant
 * accordé de la demande. Ajouter, retirer, rechiffrer, redécider ou réimputer un poste ensuite
 * ferait diverger ce total de ses postes, en silence. Ce qui continue, en revanche, c'est
 * l'EXÉCUTION de ce qui a été validé : demande et visa du BC, émission, facture — sans quoi la
 * clôture laisserait en plan un poste accordé dont le BC n'était pas encore parti.
 *
 * Le refus nomme la réouverture quand elle existe, et seulement alors : une demande close par un
 * TRANSFERT vit désormais dans un autre module, et lui promettre un « Rouvrir » serait un remède
 * qui n'existe pas (§118.63).
 */
async function refusSiClos(parent: AdProParent, parentId: string, opts: { partir?: boolean } = {}): Promise<string | null> {
  const info = await PARENTS[parent].load(parentId);
  if (!info) return "Opération introuvable.";
  return refusPostesClos(info) ?? (opts.partir ? refusDemandeFermee(info) : null);
}

/**
 * UNE DEMANDE REFUSÉE OU ANNULÉE NE FAIT PLUS PARTIR SES POSTES (audit 360°, R24–R36) — ni soumission,
 * ni accord, ni bon de commande. Le centre aurait visé, et les Finances n'auraient jamais pu émettre :
 * l'opération n'est pas accordée. DÉCRIRE un poste reste possible : c'est préparer la suite. Le refus
 * nomme les deux chemins qui la relancent, sans en promettre un qui n'existerait pas pour cette nature.
 */
function refusDemandeFermee(info: ParentInfo): string | null {
  return info.refusee
    ? "La demande est refusée ou annulée : ses postes ne partent plus (ni soumission, ni accord, ni bon de commande) tant qu'elle n'est pas relancée — par un appel, ou une nouvelle demande, depuis sa fiche."
    : null;
}

/** La phrase du refus, pour un appelant qui tient déjà l'opération chargée. */
function refusPostesClos(info: ParentInfo): string | null {
  if (!info.clos) return null;
  return info.closedByClosure
    ? "Cette demande est clôturée : ses postes, leurs montants et leurs budgets sont arrêtés. "
      + "Pour corriger, la Direction Marketing la rouvre depuis sa fiche (« Rouvrir la demande »), puis la clôture à nouveau."
    : "Cette demande est close (transférée vers un autre module) : ses postes ne se modifient plus ici.";
}


/**
 * LE MONTANT DE LA DEMANDE SUIT SES RALLONGES ACCORDÉES (§118.138).
 *
 * Demande de la Direction : « une fois budget supplémentaire accordé, il doit être mis à jour
 * dans la demande, le montant ». Jusqu'ici, `decideAdProItem` écrivait `amountGranted` sur le
 * POSTE et la fiche de l'opération continuait d'afficher l'enveloppe d'origine : la rallonge
 * existait, était accordée, engagée, payée — et le total de la demande ne la portait pas.
 *
 * La BASE est le montant que le circuit a accordé (`WorkflowInstance.amount`), jamais le champ
 * affiché : celui-ci est ce qu'on écrit, et s'en servir comme base le ferait grossir à chaque
 * passage. Base inconnue ⇒ on ne touche à rien (une opération sans circuit de financement n'a
 * pas de montant de demande, et c'est une réponse, pas un trou à combler).
 *
 * Best-effort : une décision de poste ne doit pas échouer parce que la projection n'a pas pu
 * s'écrire. Ce qui compte — la décision et son montant — est déjà en base.
 */
async function reprojeterMontantDemande(parent: AdProParent, parentId: string): Promise<void> {
  try {
    const [instance, postes] = await Promise.all([
      prisma.workflowInstance.findUnique({
        where: { entityType_entityId: { entityType: parent, entityId: parentId } },
        select: { amount: true },
      }),
      prisma.adProItem.findMany({
        where: { [PARENTS[parent].column]: parentId },
        select: { budgetKind: true, status: true, amountGranted: true },
      }),
    ]);
    const total = montantDeLaDemande(
      instance?.amount != null ? toNumber(instance.amount) : null,
      postes.map((p) => ({
        budgetKind: p.budgetKind,
        status: p.status,
        amountGranted: p.amountGranted != null ? toNumber(p.amountGranted) : null,
      })),
    );
    if (total == null) return;
    // Le champ diffère selon l'opération — sponsoring et congrès/événements n'ont pas nommé la
    // même colonne. Une seule écriture, décidée ici, pour qu'elles ne puissent pas diverger.
    if (parent === "SPONSORING") {
      await prisma.sponsoringRequest.update({ where: { id: parentId }, data: { amountGranted: total } });
    } else if (parent === "CONGRESS_NATIONAL") {
      await prisma.congressNational.update({ where: { id: parentId }, data: { finalAmount: total } });
    } else if (parent === "CONGRESS_INTERNATIONAL") {
      await prisma.congressInternational.update({ where: { id: parentId }, data: { finalAmount: total } });
    } else {
      await prisma.event.update({ where: { id: parentId }, data: { finalAmount: total } });
    }
  } catch (err) {
    console.error("[ad-pro] montant de la demande non reprojeté (non bloquant)", err);
  }
}

/**
 * LA DEMANDE DOIT ÊTRE VISIBLE (§118.175) — la porte de LIGNE du parent, celle de sa fiche.
 *
 * Le droit d'écrire dans le MODULE ne suffit pas : un congrès a une portée « ses lignes », et un
 * délégué n'y voit que SES demandes — la liste et la fiche l'appliquent, la porte des pièces aussi
 * (§118.153). Les gestes sur les postes, eux, ne lisaient que le module : un identifiant forgé
 * faisait modifier, soumettre ou retirer les postes du congrès d'un collègue — et, par les gestes
 * de ce lot, y inscrire des voyageurs et ouvrir un sujet de réservation à son nom. Une porte gardée
 * à côté d'une porte ouverte (§118.71). Sponsoring et événements n'ont pas de portée de ligne (qui
 * a le module les voit tous, comme leur liste) : pour eux, rien ne change.
 *
 * La règle est CELLE de la fiche (`canAccessEntity`, VIEW), jamais une recopie : deux lectures de
 * « qui voit ce congrès » finiraient par diverger (§118.5). Elle n'accorde rien : le droit d'agir
 * reste celui de chaque geste (`canEditItems`, `canAllocate`…) ; elle n'ajoute que « on agit sur
 * une demande qu'on voit ».
 */
function demandeVisible(user: SessionUser, parent: AdProParent, parentId: string): Promise<boolean> {
  return canAccessEntity(user, PARENT_ENTITE[parent], parentId, "VIEW");
}

/**
 * Charge un poste avec son parent résolu — le point d'entrée de toutes les actions par `id`. Hors
 * de la portée de la personne, le poste est INTROUVABLE : la même phrase que l'absence, qui ne
 * confirme pas qu'il existe. L'acteur est un paramètre OBLIGATOIRE : un défaut rouvrirait la porte
 * en silence au prochain appelant qui l'oublierait (§118.127b).
 */
async function loadItem(id: string, user: SessionUser) {
  const item = await prisma.adProItem.findUnique({
    where: { id },
    select: {
      id: true, label: true, kind: true, supplier: true, amountGranted: true, amountEstimated: true,
      expenseOrderId: true, promoMaterialId: true, status: true, budgetKind: true,
      budgetCategoryId: true, orderStage: true, adminRequestId: true, orderRequestedById: true,
      orderRequestedAt: true, orderDirectionAt: true, orderVisaAmount: true, orderVisaSupplier: true,
      reservationDossierId: true, opsDecidedAt: true, orderNote: true, repartitionId: true,
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true,
    },
  });
  if (!item) return null;
  const owner = parentOf(item);
  if (!owner || !(await demandeVisible(user, owner.parent, owner.id))) return null;
  return { item, owner };
}

/**
 * LES FICHES PAR PERSONNE D'UN POSTE (Direction, 06/10) : ses voyageurs (billetterie) ou ses fiches
 * hôtellerie (hôtellerie). `undefined` hors de ces deux natures — la règle ne s'y applique pas.
 */
async function compterFichesPersonnes(item: { id: string; kind: AdProItemKind }): Promise<number | undefined> {
  if (porteDesVoyageurs(item.kind)) return prisma.adProVoyageur.count({ where: { itemId: item.id } });
  if (porteDesHebergements(item.kind)) return prisma.adProHebergement.count({ where: { itemId: item.id } });
  return undefined;
}

/**
 * LA PRISE EN CHARGE PASSE-T-ELLE PAR UN SPONSORING INDIRECT ? Un poste né de « Répartir par nature »
 * (`repartitionId`), ou ajouté directement sur un sponsoring de nature INDIRECT. Là, les fiches
 * hôtellerie et voyageur par personne ne sont pas obligatoires (Direction, 06/10).
 */
function priseEnChargeIndirecte(item: { repartitionId: string | null }, info: ParentInfo | null): boolean {
  return item.repartitionId != null || Boolean(info?.indirect);
}

// ───────────────────── Le bon de commande d'un poste : visa, pièces établies, secrétariat (§118.187) ─────────────────────

type PosteCharge = NonNullable<Awaited<ReturnType<typeof loadItem>>>["item"];

/** Ce que la règle du visa lit d'un poste chargé — les valeurs AVANT la modification en cours. */
function etatBcDe(item: PosteCharge): EtatBcPoste {
  return {
    etape: item.orderStage,
    viseParLeCentre: item.orderDirectionAt != null,
    montantVise: item.orderVisaAmount != null ? toNumber(item.orderVisaAmount) : null,
    fournisseurVise: item.orderVisaSupplier,
    montantAvant: item.amountGranted != null ? toNumber(item.amountGranted) : null,
    fournisseurAvant: item.supplier,
  };
}

/** Qui siège au centre de validation Ad & Pro, et qui émet — les rôles que la demande de BC prévient déjà. */
const SIEGES_CENTRE: UserRole[] = ["GENERAL_MANAGER", "SUPER_ADMIN"];
const FINANCES_BC: UserRole[] = ["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"];

/**
 * APPLIQUER LE GESTE DU VISA (`ad-pro/bc-poste.ts`) — une écriture CONDITIONNELLE sur l'étape lue :
 * un visa donné, une émission ou un retrait survenus entre la lecture et l'écriture ne se défont pas
 * en silence. Rend la phrase à ajouter au message de l'action, et se tait quand rien n'a bougé
 * (§118.32).
 */
async function appliquerGesteVisa(
  item: { id: string; label: string },
  geste: GesteVisaPoste,
  apres: { montant: number | null; fournisseur: string | null },
  ctx: { user: SessionUser; owner: { parent: AdProParent; id: string }; ref: string | null },
): Promise<string | null> {
  if (geste.geste === "RIEN") return null;
  const lien = lienPosteAdPro(ctx.owner.parent, ctx.owner.id, item.id);
  const cible = `${ctx.ref ?? ""} — « ${item.label} »${apres.montant != null ? ` (${apres.montant.toLocaleString("fr-FR")} DZD)` : ""}`;
  if (geste.geste === "ROUVRIR") {
    const r = await prisma.adProItem.updateMany({
      where: { id: item.id, orderStage: "DIRECTION_OK" },
      data: {
        orderStage: "REQUESTED", orderDirectionAt: null, orderDirectionById: null,
        orderDecisionNote: geste.motif, orderVisaAmount: null, orderVisaSupplier: null, updatedById: ctx.user.id,
      },
    });
    if (r.count === 0) return null;
    await notifyRoles(SIEGES_CENTRE, {
      type: "VALIDATION_REQUIRED", title: "Bon de commande à revoir", body: `${cible} — ${geste.motif}`, link: lienLigneCentreAdPro(item.id),
    }).catch(() => undefined);
    // Les Finances avaient reçu « à émettre » : sans ce message, l'ordre partirait sous l'ancien visa.
    await notifyRoles(FINANCES_BC, {
      type: "GENERIC", title: "Bon de commande renvoyé au centre — ne pas l'émettre", body: `${cible} — ${geste.motif}`, link: lien,
    }).catch(() => undefined);
    await audit(ctx.user, ctx.owner.parent, ctx.owner.id, "UPDATE", `Visa du bon de commande ROUVERT pour « ${item.label} » — ${geste.motif}`);
    revalidatePath("/centre-ad-pro");
    return `Le visa du bon de commande est rouvert : ${geste.motif} Le centre de validation Ad & Pro le revoit.`;
  }
  const r = await prisma.adProItem.updateMany({
    where: { id: item.id, orderStage: "REQUESTED" },
    data: {
      // Aucune EMPREINTE : aucun centre n'a rien vu, et la règle ne la lit que sur un BC VISÉ (§118.45 —
      // un état qu'aucun code ne lit n'a rien à faire en base).
      orderStage: "DIRECTION_OK", orderDirectionAt: null, orderDirectionById: null, orderDecisionNote: geste.motif,
      orderVisaAmount: null, orderVisaSupplier: null, updatedById: ctx.user.id,
    },
  });
  if (r.count === 0) return null;
  await notifyRoles(FINANCES_BC, {
    type: "VALIDATION_REQUIRED", title: "Bon de commande sous le seuil — à émettre", body: cible, link: lien,
  }).catch(() => undefined);
  await audit(ctx.user, ctx.owner.parent, ctx.owner.id, "UPDATE", `Bon de commande de « ${item.label} » passé sous le seuil — ${geste.motif}`);
  revalidatePath("/centre-ad-pro");
  return geste.motif;
}

/**
 * CLORE LES DEMANDES OUVERTES AU SECRÉTARIAT pour ce poste (audit 360°, R10) — devis, facture, « BC à
 * établir ». Elles survivaient au poste refusé, et à la demande de BC retirée : l'assistante continuait
 * de chercher un devis pour une dépense qui n'existait plus. (Un poste RETIRÉ, lui, les emporte dans
 * son lot de corbeille et les rend avec lui : les clore d'abord ferait revenir un poste dont la demande
 * de BC vit encore, avec un « BC à établir » annulé.) Chaque demande close porte son
 * motif dans sa discussion, et la personne qui la tenait est prévenue (à défaut, le bureau). Écriture
 * CONDITIONNELLE : une demande terminée entre-temps n'est pas rouverte en « annulée ».
 */
async function cloreDemandesSecretariat(
  itemId: string, motif: string, user: SessionUser, portee: "TOUTES" | "BC_A_ETABLIR",
): Promise<number> {
  const { closes } = await cloreDemandesAuBureau(itemId, motif, user, portee);
  // LA DEMANDE DE PIÈCE ENVOYÉE À L'ASSISTANTE (§118.204) suit le même sort : sans cela, elle déposerait
  // un BC pour un poste refusé ou une demande retirée. Elle est prévenue, motif à l'appui.
  const pieces = await annulerDemandesPiecesDuPoste(itemId, portee === "BC_A_ETABLIR" ? "BC" : "TOUTES");
  for (const p of pieces) {
    await notifyUser({ userId: p.askedToId, type: "GENERIC", title: "Demande de pièce annulée", body: motif, link: `/pieces/${p.id}` }).catch(() => undefined);
  }
  if (pieces.length > 0) revalidatePath("/pieces");
  return closes + pieces.length;
}

/**
 * LES DEMANDES AU BUREAU DU SECRÉTARIAT du poste (et elles seules) — par l'annulation commune. Rend le
 * nombre de demandes closes et la réserve d'une demande qui ne s'annule pas (paiement déjà réglé).
 */
async function cloreDemandesAuBureau(
  itemId: string, motif: string, user: SessionUser, portee: "TOUTES" | "BC_A_ETABLIR", cause = "avec son poste",
): Promise<{ closes: number; reserve: string | null }> {
  const ouvertes = await prisma.administrativeRequest.findMany({
    where: {
      linkedEntityType: "AD_PRO_ITEM", linkedEntityId: itemId, deletedAt: null,
      status: { notIn: ["DONE", "CANCELLED"] },
      ...(portee === "BC_A_ETABLIR" ? { type: "OTHER" as const, title: { startsWith: TITRE_BC_A_ETABLIR } } : {}),
    },
    select: { id: true },
  });
  // UNE annulation pour toutes les portes (`annulerDemandeSecretariat`) : la demande, ses validations
  // en attente, son paiement non réglé, la trace et l'assistante — la même chose que lorsque son
  // demandeur l'annule. Une demande dont le paiement est déjà réglé reste ouverte : elle se termine.
  let closes = 0;
  let reserve: string | null = null;
  for (const d of ouvertes) {
    const a = await annulerDemandeSecretariat(d.id, { acteurId: user.id, motif, cause });
    if (a.ok && a.annulee) closes += 1;
    else if (!a.ok) reserve = a.error;
  }
  if (closes > 0) revalidatePath("/demandes");
  return { closes, reserve };
}

/** « 2 demandes au secrétariat closes » — la phrase, une fois ; rien quand il n'y en avait pas. */
function phraseDemandesCloses(n: number): string {
  return n === 0 ? "" : ` ${n} demande${n > 1 ? "s" : ""} à l'assistante de direction ${n > 1 ? "closes" : "close"}, elle est prévenue.`;
}

// ───────────────────────────── Répartir un sponsoring indirect (§118.175) ─────────────────────────────

/** « imprimerie 400 000 DZD, hôtellerie 600 000 DZD » — la phrase de l'audit et du message, une fois. */
function resumeRepartition(lignes: readonly LigneRepartition[]): string {
  return lignes.map((l) => `${ITEM_KIND_LABELS[l.kind].toLowerCase()} ${l.montant.toLocaleString("fr-FR")} DZD`).join(", ");
}

/** Les lignes lues, prêtes à écrire : le libellé de chaque poste se compose ici, une fois. */
function postesRepartis(lignes: readonly LigneRepartition[]): PosteReparti[] {
  return lignes.map((l) => ({ kind: l.kind, label: libelleLigne(ITEM_KIND_LABELS[l.kind], l.precision), montant: l.montant, payeA: l.payeA }));
}

/**
 * RÉPARTIR PAR NATURE le poste « sponsoring indirect » créé avec la demande (§118.175).
 *
 * Tant qu'il n'est ni soumis ni accordé : la Direction ne s'est pas encore prononcée sur sa forme.
 * Une fois soumis, le répartir changerait sous ses yeux ce qu'elle est en train de décider. Et rien
 * ne se répartit quand un bon de commande ou un ordre de dépense est déjà parti : l'argent engagé
 * l'a été sur ce poste-là, tel qu'il était.
 */
export async function repartirPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.kind !== "INDIRECT_SUPPORT") return { ok: false, error: "Seul un sponsoring indirect se répartit par nature." };
  if (!STATUTS_EDITABLES.includes(item.status)) {
    return { ok: false, error: "Ce poste est déjà soumis ou accordé : sa forme ne change plus — la Direction s'est prononcée (ou se prononce) sur lui tel qu'il est." };
  }
  if (item.expenseOrderId || item.orderStage !== "NONE") {
    return { ok: false, error: "Un bon de commande ou un ordre de dépense est déjà parti sur ce poste : il ne se répartit plus." };
  }

  const lue = lireRepartition(fdStr(formData, "repartition"));
  if (!lue.ok) return { ok: false, error: lue.error };

  const avant = await prisma.adProItem.findUnique({ where: { id }, select: { label: true, notes: true, budgetKind: true, addedAfterDecision: true } });
  if (!avant) return { ok: false, error: "Poste introuvable." };
  try {
    await prisma.$transaction((tx) => ecrireRepartition(tx, {
      rattachement: { [PARENTS[owner.parent].column]: owner.id }, lignes: postesRepartis(lue.lignes), premierId: id, userId: user.id,
      base: { label: avant.label, notes: avant.notes, budgetKind: avant.budgetKind, addedAfterDecision: avant.addedAfterDecision },
    }));
  } catch (err) {
    console.error("[ad-pro-item] répartition impossible", err);
    return { ok: false, error: "La répartition n'a pas pu être enregistrée : rien n'a changé. Réessayez dans un instant." };
  }
  const estime = item.amountEstimated != null ? toNumber(item.amountEstimated) : null;
  // L'ÉCART SE DIT, il ne se refuse pas : le délégué peut avoir ajusté en répartissant. Le taire
  // laisserait croire que le total n'a pas bougé.
  const ecart = estime != null && Math.round(estime * 100) !== Math.round(lue.total * 100)
    ? ` Le poste d'origine portait ${estime.toLocaleString("fr-FR")} DZD.`
    : "";
  await audit(user, owner.parent, owner.id, "UPDATE",
    `« ${avant.label} » réparti en ${lue.lignes.length} poste(s) — ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.${ecart}`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Réparti en ${lue.lignes.length} poste(s) : ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.${ecart}` };
}

// ───────────────────────────── Ajouter / modifier / retirer ─────────────────────────────

export async function addAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const parentRaw = fdStr(formData, "parent") ?? "";
  if (!isParent(parentRaw)) return { ok: false, error: "Opération inconnue." };
  const parentId = fdStr(formData, "parentId");
  const label = fdStr(formData, "label");
  if (!parentId || !label) return { ok: false, error: "Le libellé du poste est obligatoire." };
  if (!canEditItems(user, parentRaw)) return { ok: false, error: "Non autorisé." };

  const info = await PARENTS[parentRaw].load(parentId);
  // Hors de la portée de la personne, la demande est introuvable — la même phrase que l'absence.
  if (!info || !(await demandeVisible(user, parentRaw, parentId))) return { ok: false, error: "Opération introuvable." };
  const clos = refusPostesClos(info);
  if (clos) return { ok: false, error: clos };

  const kind = (fdStr(formData, "kind") ?? "OTHER") as AdProItemKind;
  if (!(kind in ITEM_KIND_LABELS)) return { ok: false, error: "Nature de poste inconnue." };

  const amountEstimated = fdNum(formData, "amountEstimated");
  if (amountEstimated != null && amountEstimated < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  // UN POSTE « MATÉRIEL DU STOCK » NE PORTE PAS DE MONTANT (§118.167) : son matériel sort du
  // magasin, il ne s'achète pas. Un montant saisi y serait additionné au montant de la demande.
  const sansMontant = amountEstimated != null && amountEstimated > 0 ? refusArgentSurPosteStock(kind, "un montant") : null;
  if (sansMontant) return { ok: false, error: sansMontant };
  // « Ce poste est-il DANS le budget accordé, ou EN PLUS ? » — question posée dès l'ajout : sans
  // elle, une rallonge assumée serait lue comme un dépassement subi.
  const budgetKind = (fdStr(formData, "budgetKind") === "ADDITIONAL" ? "ADDITIONAL" : "INCLUDED") as AdProItemBudgetKind;

  // UN SPONSORING INDIRECT NAÎT RÉPARTI PAR NATURE (§118.175) — « 1 000 000 DZD répartis en
  // 400 000 d'imprimerie et 600 000 d'hôtellerie ». Il ne devient pas UN poste « sponsoring
  // indirect » qu'on ne pourrait payer qu'à un seul fournisseur : chaque nature devient un poste,
  // avec sa chaîne, et `repartitionId` les relie. Sans répartition, le refus nomme ce qui manque.
  if (kind === "INDIRECT_SUPPORT") {
    const lue = lireRepartition(fdStr(formData, "repartition"));
    if (!lue.ok) return { ok: false, error: lue.error };
    try {
      const ids = await prisma.$transaction((tx) => ecrireRepartition(tx, {
        rattachement: { [PARENTS[parentRaw].column]: parentId }, lignes: postesRepartis(lue.lignes), premierId: null, userId: user.id,
        base: { label, notes: fdStr(formData, "notes"), budgetKind, addedAfterDecision: info.tardif },
      }));
      await audit(user, parentRaw, parentId, "CREATE",
        `Sponsoring indirect « ${label} » réparti en ${lue.lignes.length} poste(s) — ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD${info.tardif ? " — APRÈS la décision définitive" : ""}.`);
      revalidate(parentRaw, parentId);
      return { ok: true, id: ids[0], message: `Sponsoring indirect réparti en ${lue.lignes.length} poste(s) : ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.` };
    } catch (err) {
      console.error("[ad-pro-item] répartition impossible", err);
      return { ok: false, error: "La répartition n'a pas pu être enregistrée : aucun poste n'a été créé. Réessayez dans un instant." };
    }
  }

  try {
    // Un poste ajouté APRÈS la décision est autorisé — c'est le choix retenu — mais il est
    // marqué. C'est ce marqueur qui expliquera un dépassement d'enveloppe à l'écran, au lieu
    // de laisser croire à une erreur de saisie.
    const late = info.tardif;
    const where = { [PARENTS[parentRaw].column]: parentId } as Record<string, string>;
    const last = await prisma.adProItem.findFirst({ where, orderBy: { position: "desc" }, select: { position: true } });

    const created = await prisma.adProItem.create({
      data: {
        ...where,
        kind,
        label,
        notes: fdStr(formData, "notes"),
        supplier: fdStr(formData, "supplier"),
        amountEstimated: kind === "STOCK_MATERIAL" ? null : amountEstimated ?? null,
        budgetKind,
        addedAfterDecision: late,
        position: (last?.position ?? 0) + 1,
        createdById: user.id,
        updatedById: user.id,
      },
      select: { id: true },
    });

    await audit(user, parentRaw, parentId, "CREATE",
      `Poste ajouté — ${ITEM_KIND_LABELS[kind]} « ${label} » (${budgetKind === "ADDITIONAL" ? "budget supplémentaire" : "inclus dans le budget accordé"})${late ? " — APRÈS la décision définitive" : ""}.`);
    // UN POSTE HORS BUDGET OU APRÈS LA DÉCISION SE DIT, EN LECTURE, À CEUX QUI DÉCIDENT (§118.200) :
    // il n'est pas encore à valider (la validation partira à sa soumission), mais il change ce que
    // la demande coûtera. Le dire seulement là : un poste inclus avant la décision est le détail
    // ordinaire du besoin, et une notification par ligne serait du bruit qu'on cesse de lire.
    if (budgetKind === "ADDITIONAL" || late) {
      await notifyRoles(valideursDuPoste(parentRaw), {
        type: "GENERIC",
        title: budgetKind === "ADDITIONAL" ? "Poste hors budget ajouté" : "Poste ajouté après la décision",
        body: `${info.ref} — ${ITEM_KIND_LABELS[kind]} « ${label} »${amountEstimated != null ? ` (${amountEstimated.toLocaleString("fr-FR")} DZD)` : ""} — pour information ; la validation vous parviendra à sa soumission.`,
        link: lienPosteAdPro(parentRaw, parentId, created.id),
      }).catch(() => undefined);
    }
    revalidate(parentRaw, parentId);
    return { ok: true, id: created.id };
  } catch (err) {
    console.error("[ad-pro-item] création impossible", err);
    return { ok: false, error: "Le poste n'a pas pu être ajouté. Réessayez dans un instant." };
  }
}

export async function updateAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  // Le montant affecté engage l'argent : il ne se modifie pas avec les mêmes droits que le libellé.
  const wantsAllocate = formData.get("amountGranted") !== null;
  // LE MONTANT ACCORDÉ se fixe au second temps de la validation (§118.204) : par qui le tient.
  if (wantsAllocate && !(await peutTrancherSur(user, owner)).marketing) {
    return { ok: false, error: "Le montant accordé se fixe par la Direction Marketing, qui valide le poste et choisit son budget." };
  }
  // Une pièce comptable a été émise sur ce montant : le changer en silence ferait diverger
  // l'opération et l'ordre de dépense. On refuse plutôt que de créer un écart invisible.
  if (wantsAllocate && item.expenseOrderId) {
    return { ok: false, error: "Un ordre de dépense a déjà été émis sur ce poste : son montant ne peut plus changer." };
  }

  const amountGranted = wantsAllocate ? fdNum(formData, "amountGranted") : undefined;
  if (amountGranted != null && amountGranted < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const amountEstimated = fdNum(formData, "amountEstimated");
  if (amountEstimated != null && amountEstimated < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };

  const label = fdStr(formData, "label");

  // LE BON DE COMMANDE EN COURS (§118.187). Retirer le montant d'un poste dont le BC est demandé ou
  // visé laisserait une demande sans chiffre au centre ou aux Finances : le refus nomme le geste qui
  // le précède. Et un prestataire ne change pas sous un ordre déjà émis à l'ancien : l'ordre s'annule
  // d'abord, puis se réémet — sinon l'ordre et le poste diraient deux bénéficiaires.
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  if (wantsAllocate && amountGranted == null && bcEnCours) {
    return { ok: false, error: "Une demande de bon de commande est en cours sur ce montant : retirez-la d'abord (« Annuler la demande de BC »), puis retirez le montant." };
  }
  const nouveauFournisseur = formData.has("supplier") ? fdStr(formData, "supplier") : item.supplier;
  if (item.expenseOrderId && !memePrestataire(nouveauFournisseur, item.supplier)) {
    return { ok: false, error: "Un ordre de dépense a déjà été émis pour ce poste : pour changer de prestataire, annulez d'abord l'ordre (« Annuler l'ordre émis »), puis réémettez-le." };
  }

  // CLÔTURÉE : ce qui DÉCRIT la dépense (libellé, précisions, fournisseur) se corrige encore — le
  // fournisseur sert au BC qui peut rester à émettre. Ce qui la CHIFFRE ou la QUALIFIE non : la
  // clôture a arrêté ces valeurs, et le total de la demande en est la somme.
  if (wantsAllocate || formData.has("amountEstimated") || fdStr(formData, "kind") || fdStr(formData, "budgetKind")) {
    const clos = await refusSiClos(owner.parent, owner.id);
    if (clos) return { ok: false, error: clos };
  }

  // NATURE et NATURE DE BUDGET — modifiables aussi, mais pas n'importe quand.
  // La nature (stand, prestation…) décrit la dépense : elle se corrige à tout moment.
  // La nature de BUDGET (inclus / rallonge) est ce sur quoi la Direction s'est prononcée :
  // une fois tranchée, la changer réécrirait sa décision.
  const kindRaw = fdStr(formData, "kind");
  const kind = kindRaw && (ITEM_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as AdProItemKind) : null;
  const budgetKindRaw = fdStr(formData, "budgetKind");
  const budgetKind = budgetKindRaw === "INCLUDED" || budgetKindRaw === "ADDITIONAL" ? budgetKindRaw : null;
  const budgetDecided = budgetKindLocked(item);

  // LA NATURE « MATÉRIEL DU STOCK » ne se gagne ni ne se perd hors d'un brouillon vierge
  // (§118.167) : elle change ce que le poste EST, pas seulement ce qu'il décrit.
  if (kind && kind !== item.kind) {
    const refus = refusChangementNature(item.kind, kind, {
      statut: item.status,
      lignesStock: await prisma.adProStockLine.count({ where: { itemId: id } }),
      argentEngage: item.amountEstimated != null || item.amountGranted != null || item.budgetCategoryId != null
        || item.expenseOrderId != null || item.orderStage !== "NONE" || item.adminRequestId != null || item.promoMaterialId != null,
    });
    if (refus) return { ok: false, error: refus };
    // LES FICHES PAR PERSONNE (Direction, 06/10) : une billetterie qui a des voyageurs, une hôtellerie
    // qui a des fiches ne changent pas de nature — les fiches deviendraient invisibles, sans être perdues.
    const [voyageurs, hebergements] = await Promise.all([
      prisma.adProVoyageur.count({ where: { itemId: id } }),
      prisma.adProHebergement.count({ where: { itemId: id } }),
    ]);
    const refusFiches = refusChangementNatureFiches(item.kind, kind, { voyageurs, hebergements });
    if (refusFiches) return { ok: false, error: refusFiches };
  }
  if ((wantsAllocate && amountGranted != null && amountGranted > 0) || (amountEstimated != null && amountEstimated > 0)) {
    const refus = refusArgentSurPosteStock(kind ?? item.kind, "un montant");
    if (refus) return { ok: false, error: refus };
  }

  try {
    await prisma.adProItem.update({
      where: { id },
      data: {
        ...(label ? { label } : {}),
        ...(kind ? { kind } : {}),
        ...(budgetKind && !budgetDecided ? { budgetKind } : {}),
        ...(formData.has("notes") ? { notes: fdStr(formData, "notes") } : {}),
        ...(formData.has("supplier") ? { supplier: fdStr(formData, "supplier") } : {}),
        ...(formData.has("amountEstimated") ? { amountEstimated: amountEstimated ?? null } : {}),
        ...(wantsAllocate ? { amountGranted: amountGranted ?? null } : {}),
        updatedById: user.id,
      },
    });
    await audit(user, owner.parent, owner.id, "UPDATE",
      wantsAllocate
        ? `Poste « ${label ?? item.label} » — montant affecté : ${amountGranted != null ? `${amountGranted.toLocaleString("fr-FR")} DZD` : "retiré"}.`
        : `Poste « ${label ?? item.label} » modifié.`);
    // MÊME PORTE QUE LA DÉCISION : le montant d'une rallonge accordée se corrige aussi ici, et
    // sa nature de budget peut encore changer tant qu'elle n'est pas tranchée. Laisser cette
    // porte-là sans reprojection, c'est la porte ouverte à côté de la porte gardée (§118.71).
    await reprojeterMontantDemande(owner.parent, owner.id);
    // LE VISA NE COUVRE QUE CE QU'IL A VU (§118.187, audit R05) : un montant relevé ou un prestataire
    // changé après le visa le rouvre ; un BC en attente que le montant fait passer sous le seuil part
    // aux Finances.
    let phraseVisa: string | null = null;
    if (bcEnCours) {
      const apres = {
        montant: wantsAllocate ? (amountGranted ?? null) : (item.amountGranted != null ? toNumber(item.amountGranted) : null),
        fournisseur: nouveauFournisseur,
      };
      const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
      if (geste.geste !== "RIEN") {
        const info = await PARENTS[owner.parent].load(owner.id);
        phraseVisa = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info?.ref ?? null });
      }
    }
    revalidate(owner.parent, owner.id);
    return phraseVisa ? { ok: true, id, message: `Poste modifié. ${phraseVisa}` } : { ok: true, id };
  } catch (err) {
    console.error("[ad-pro-item] mise à jour impossible", err);
    return { ok: false, error: "Le poste n'a pas pu être modifié." };
  }
}

export async function deleteAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  // LE MATÉRIEL DU STOCK (§118.167) : réservé, il est dehors et effacer le poste l'y laisserait ;
  // remis, abîmé ou perdu, le poste est la cause de ces sorties. La MÊME règle que la corbeille
  // (`faitDeStock`) — sinon une demande qu'elle refuse se viderait poste par poste (§118.71).
  const faitStock = (await prisma.adProStockLine.findMany({
    where: { itemId: id }, select: { statut: true, utilisee: true, abimee: true, perdue: true },
  })).map((l) => faitDeStock(l)).find((f) => f != null);
  if (faitStock) return { ok: false, error: `Ce poste ne se retire pas : ${faitStock}.` };

  // UN POSTE PAYÉ NE S'EFFACE PAS EN SILENCE — mais il doit pouvoir être retiré.
  //
  // Le refus pur et simple créait une impasse : un poste émis par erreur (mauvais fournisseur,
  // doublon) restait à l'écran pour toujours. On garde donc la protection pour les éditeurs
  // ordinaires, et on l'ouvre à la DIRECTION — celle qui a signé l'ordre est celle qui peut le
  // défaire. L'ordre de dépense est alors ANNULÉ, pas orphelin : la trace comptable subsiste,
  // marquée annulée, au lieu de pointer vers un poste disparu.
  const order = item.expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: item.expenseOrderId }, select: { status: true, reference: true } })
    : null;
  const removable = canRemoveItem(
    { expenseOrderId: item.expenseOrderId, expenseOrderStatus: order?.status ?? null },
    { canAllocate: canAllocate(user, owner.parent) },
  );
  if (!removable.ok) return { ok: false, error: removable.reason ?? "Ce poste ne peut pas être retiré." };
  // CE QUE LA CORBEILLE REFUSERAIT, lu AVANT d'annuler quoi que ce soit — une pièce signée par les
  // Finances, le paiement réglé d'une demande au secrétariat : sans cette lecture, l'ordre serait
  // annulé pour rien, et le poste resterait là (§118.53 : on lit l'empreinte avant d'écrire).
  const apercu = await apercuSuppression("AD_PRO_ITEM", id);
  if (apercu.refus) return { ok: false, error: apercu.refus };
  // Les demandes au secrétariat ENCORE OUVERTES partent avec le poste (le lot les emporte, et les rend
  // à la restauration) : l'assistante qui y travaillait doit l'apprendre — elle disparaît de sa liste.
  const ouvertes = await prisma.administrativeRequest.findMany({
    where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
    select: { reference: true, title: true, assignedToId: true },
  });
  // Et les demandes de PIÈCE ouvertes chez l'assistante (le BC à déposer, §118.204) : elle doit
  // l'apprendre aussi, sinon elle dépose un BC pour un poste qui n'existe plus.
  const piecesOuvertes = await prisma.documentRequest.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: id, status: { in: ["PENDING", "SUBMITTED", "DECLINED"] } },
    select: { id: true, reference: true, label: true, askedToId: true },
  });

  // 1) L'ORDRE ÉMIS S'ANNULE PAR L'ÉCRIVAIN COMMUN (§118.185) — conditionnel : un règlement survenu
  //    entre la lecture et l'annulation ne se défait pas, et le poste reste alors (il justifie un
  //    paiement réellement sorti). L'écriture d'avant était un `update` sec, qui pouvait marquer
  //    « annulé » un ordre que le centre venait de payer.
  let ordreAnnule: string | null = null;
  if (item.expenseOrderId) {
    const a = await annulerOrdreNonRegle(item.expenseOrderId, { acteurId: user.id, motif: `le poste « ${item.label} » a été retiré` });
    if (!a.ok) return { ok: false, error: a.error };
    ordreAnnule = a.reference;
    // Le poste QUITTE l'ordre annulé avant de partir à la corbeille, comme « Annuler l'ordre émis » :
    // restauré, il pointerait sinon vers un ordre annulé, « émis » pour toujours et impossible à réémettre.
    await prisma.adProItem.updateMany({
      where: { id, expenseOrderId: item.expenseOrderId },
      data: { expenseOrderId: null, orderStage: item.orderRequestedAt ? "DIRECTION_OK" : "NONE", updatedById: user.id },
    });
  }

  // 2) LE POSTE PART À LA CORBEILLE, EN LOT (§118.187, audit R11) — avec ses décisions, ses voyageurs,
  //    ses pièces, ses demandes au secrétariat et le BC non signé qu'elles ont fait naître, et il revient
  //    avec eux. « Retirer le poste » l'effaçait définitivement, et l'historique des décisions partait
  //    en cascade. Le matériel promotionnel rattaché n'est PAS supprimé : il a sa vie propre et son circuit.
  // LE RACCOURCI VERS LA DEMANDE DE DEVIS (`adminRequestId`) désigne une demande que le lot EMPORTE
  // comme branche du poste (son `linkedEntityId`) : la tête dépendrait de sa propre branche, et la
  // corbeille refusait (« ordre de recréation impossible »). Le raccourci est redondant avec le lien
  // canonique de la demande : on le vide avant le lot, et on le repose si le retrait échoue. Restauré,
  // le poste retrouve sa demande par le lien canonique.
  const raccourci = item.adminRequestId;
  if (raccourci) await prisma.adProItem.update({ where: { id }, data: { adminRequestId: null } });
  const r = await supprimerReversible("AD_PRO_ITEM", id, user.id,
    `Poste « ${item.label} » retiré${item.promoMaterialId ? " (le matériel promotionnel rattaché est conservé)" : ""}.`);
  if (!r.ok && raccourci) await prisma.adProItem.updateMany({ where: { id }, data: { adminRequestId: raccourci } }).catch(() => undefined);
  if (!r.ok) {
    return {
      ok: false,
      error: ordreAnnule
        ? `L'ordre ${ordreAnnule} a été annulé, mais le poste n'a pas pu être retiré : ${r.error ?? "erreur inconnue"}`
        : (r.error ?? "Le poste n'a pas pu être retiré."),
    };
  }
  await audit(user, owner.parent, owner.id, "DELETE",
    `Poste « ${item.label} » retiré (restaurable depuis la corbeille)${ordreAnnule ? ` — ordre de dépense ${ordreAnnule} annulé` : ""}${item.promoMaterialId ? " — le matériel promotionnel rattaché est conservé" : ""}.`);

  // 3) CE QUI TRAVAILLAIT POUR LUI (audit R10) : ses demandes au secrétariat sont parties AVEC lui —
  //    leur assistante l'apprend (la demande disparaît de sa liste, elle reviendrait avec le poste) —
  //    et le sujet de réservation d'une billetterie l'apprend aussi : l'assistante ne réserve plus des
  //    billets pour un poste qui n'existe plus. Les clore d'abord ferait revenir un poste dont la
  //    demande de BC vit encore, avec un « BC à établir » annulé (§118.141c) : le lot les garde telles
  //    qu'elles étaient.
  for (const d of ouvertes) {
    await prevenirLeSecretariat(d.assignedToId, {
      type: "GENERIC", title: "Demande au secrétariat retirée avec son poste",
      body: `${d.reference} — ${d.title} : le poste « ${item.label} » a été retiré (restaurable depuis la corbeille).`, link: "/demandes",
    }, user.id);
  }
  if (ouvertes.length > 0) revalidatePath("/demandes");
  for (const d of piecesOuvertes) {
    await notifyUser({
      userId: d.askedToId, type: "GENERIC", title: "Demande de pièce retirée avec son poste",
      body: `${d.reference} — ${d.label} : le poste « ${item.label} » a été retiré (restaurable depuis la corbeille).`, link: "/pieces",
    }).catch(() => undefined);
  }
  if (piecesOuvertes.length > 0) revalidatePath("/pieces");
  if (item.reservationDossierId) {
    await ecrireDansLeSujet({ dossierId: item.reservationDossierId, authorId: user.id, body: `${item.label} — poste retiré : la réservation n'a plus d'objet.` }).catch(() => false);
  }
  // Une rallonge accordée qu'on retire doit QUITTER le montant de la demande : sinon la fiche
  // porterait pour toujours un budget accordé à un poste qui n'existe plus.
  await reprojeterMontantDemande(owner.parent, owner.id);
  revalidate(owner.parent, owner.id);
  return {
    ok: true,
    message: `Poste retiré — restaurable depuis la corbeille${ordreAnnule ? ` ; l'ordre ${ordreAnnule} est annulé` : ""}.`
      + (ouvertes.length > 0 ? ` ${ouvertes.length} demande${ouvertes.length > 1 ? "s" : ""} au secrétariat ${ouvertes.length > 1 ? "sont parties" : "est partie"} avec lui, l'assistante prévenue.` : ""),
  };
}

// ───────────────────────────── Paiement ─────────────────────────────

/**
 * LES PIÈCES D'ACHAT D'UN POSTE (§118.204) — devis ou facture pro forma, puis bon de commande, puis
 * facture. Chaque pièce vit au registre Legal (une seule vérité, §17) et se RATTACHE au poste
 * (`AdProItemPiece`) ; un même devis peut couvrir deux, trois ou quatre postes de la même demande.
 * Ces pièces ne passent plus par le bloc « Pièces liées » de la fiche : elles sont SUR le poste.
 */

/** Charge plusieurs postes de la MÊME demande, sous la porte de la fiche ; `null` dès qu'un seul manque. */
async function postesDeLaMemeDemande(ids: readonly string[], user: SessionUser) {
  const charges = [];
  for (const pid of [...new Set(ids)]) {
    const f = await loadItem(pid, user);
    if (!f) return { error: "Un des postes est introuvable." } as const;
    charges.push(f);
  }
  const o = charges[0]?.owner;
  if (!o || charges.some((c) => c.owner.parent !== o.parent || c.owner.id !== o.id)) {
    return { error: "Un devis commun ne couvre que des postes de la même demande." } as const;
  }
  return { charges, owner: o } as const;
}

/**
 * DÉPOSER UN DEVIS (ou une facture pro forma) SUR UN OU PLUSIEURS POSTES. Le fichier est exigé : un
 * devis sans son document est un titre que personne ne peut vérifier. La pièce se juge AVANT d'écrire
 * quoi que ce soit (§118.196d) : un fichier refusé ne laisse pas un devis vide au registre.
 */
export async function ajouterDevisPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = [fdStr(formData, "id"), ...formData.getAll("autresPostes").map(String)].filter((x): x is string => Boolean(x));
  if (ids.length === 0) return { ok: false, error: "Poste non précisé." };
  const lot = await postesDeLaMemeDemande(ids, user);
  if ("error" in lot) return { ok: false, error: lot.error };
  const { charges, owner } = lot;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  for (const { item } of charges) {
    const refusStock = refusArgentSurPosteStock(item.kind, "un devis");
    if (refusStock) return { ok: false, error: refusStock };
    if (item.status === "REJECTED") return { ok: false, error: `Le poste « ${item.label} » est refusé : il ne reçoit plus de devis.` };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };

  const fichiers = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Joignez le devis (PDF, Word ou scan)." };
  const refusFichier = await validateAttachments(fichiers);
  if (refusFichier) return { ok: false, error: refusFichier };
  const montant = fdNum(formData, "montant");
  if (montant !== null && !(montant > 0)) return { ok: false, error: "Le montant du devis doit être positif." };
  const proforma = formData.get("proforma") === "on";
  const nature = proforma ? "Facture pro forma" : "Devis";
  const libelles = charges.map(({ item }) => item.label);

  const doc = await prisma.legalDocument.create({
    data: {
      title: `${nature} — ${libelles.join(", ")} (${info.ref})`,
      kind: "QUOTE",
      reference: fdStr(formData, "reference"),
      amount: montant,
      counterparty: fdStr(formData, "fournisseur") ?? charges[0].item.supplier ?? null,
      companyId: info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id)),
      sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
      createdById: user.id, updatedById: user.id,
      notes: `${nature} déposé${proforma ? "e" : ""} sur ${charges.length > 1 ? "les postes" : "le poste"} ${libelles.map((l) => `« ${l} »`).join(", ")}.`,
    },
    select: { id: true },
  });
  const joints = await attachFormFiles(user.id, "LEGAL_DOCUMENT", doc.id, formData);
  for (const { item } of charges) {
    await rattacherPieceAuPoste({ itemId: item.id, legalDocumentId: doc.id, nature: "DEVIS", acteurId: user.id });
  }
  // LA LECTURE À L'UPLOAD (§118.206) : « Luna doit directement, lors de l'ingestion des devis, les rendre
  // mangeables et consommables par la plateforme ». Le devis est déjà au poste : une lecture qui échoue ne fait
  // JAMAIS échouer le dépôt, mais elle se DIT (une absence de lignes sans cause se lirait comme un devis vide).
  const premier = fichiers[0];
  let lecture = "";
  if (premier && joints.failed.length < fichiers.length) {
    const ing = await ingererDevisDuPoste({ userId: user.id, legalDocumentId: doc.id, octets: Buffer.from(await premier.arrayBuffer()), nomFichier: premier.name });
    lecture = ing.ok ? ` ${phraseDeLecture(ing)}` : ` Lecture du devis impossible (${ing.raison}) — saisissez ses lignes depuis la carte du poste.`;
    // UN SEUL POSTE : les lignes bien lues sont validées d'office (voir la fonction). Un devis commun à
    // plusieurs postes se répartit à la main — on ne devine pas à quel poste va chaque ligne.
    if (ing.ok && charges.length === 1) {
      const nb = await validerAutomatiquementLesLignesLues(user.id, charges[0].item.id, doc.id).catch(() => 0);
      if (nb > 0) lecture = ` Devis lu : ${nb} ligne${nb > 1 ? "s" : ""} validée${nb > 1 ? "s" : ""} automatiquement.`;
    }
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `${nature} déposé sur ${libelles.map((l) => `« ${l} »`).join(", ")}${montant ? ` — ${montant.toLocaleString("fr-FR")} DZD` : ""}.`);
  revalidate(owner.parent, owner.id);
  const echec = joints.failed.length ? ` Échec sur : ${joints.failed.map((x) => x.name).join(", ")}.` : "";
  return { ok: true, id: doc.id, message: `${nature} déposé${proforma ? "e" : ""}${charges.length > 1 ? ` — commun à ${charges.length} postes` : ""}.${echec}${lecture}` };
}

/**
 * RETIRER UN DEVIS D'UN POSTE — il a été déposé au mauvais endroit. Le lien part ; une pièce qui ne
 * couvre plus AUCUN poste est annulée au registre (sans quoi elle resterait « devis » d'une demande pour
 * rien). Refusé quand un bon de commande ou une facture en découle : la chaîne ne se défait pas d'ici.
 */
export async function retirerDevisDuPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const pieceId = fdStr(formData, "pieceId");
  if (!id || !pieceId) return { ok: false, error: "Poste ou pièce non précisés." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const lien = await prisma.adProItemPiece.findFirst({ where: { itemId: id, legalDocumentId: pieceId, nature: "DEVIS" }, select: { id: true } });
  if (!lien) return { ok: false, error: "Ce devis n'est pas rattaché à ce poste." };
  const aval = await prisma.legalDocument.count({ where: { chainFromId: pieceId, status: { not: "CANCELLED" } } });
  if (aval > 0) return { ok: false, error: "Un bon de commande ou une facture découle de ce devis : il ne se retire plus du poste." };
  await prisma.adProItemPiece.delete({ where: { id: lien.id } });
  // LES LIGNES VALIDÉES POUR CE POSTE (§118.206) ne le restent pas : un devis qui ne couvre plus le poste ne fait
  // plus rien commander pour lui — la validation d'une ligne tient au lien du devis avec le poste.
  await prisma.adProDevisLigne.updateMany({
    where: { devis: { legalDocumentId: pieceId }, validatedItemId: id },
    data: { validatedItemId: null, validatedAt: null, validatedById: null },
  });
  const restants = await prisma.adProItemPiece.count({ where: { legalDocumentId: pieceId } });
  if (restants === 0) {
    await prisma.legalDocument.updateMany({ where: { id: pieceId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", updatedById: user.id } });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis retiré du poste « ${item.label} »${restants === 0 ? " — il ne couvrait plus aucun poste, il est annulé au registre" : ""}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: restants === 0 ? "Devis retiré et annulé (il ne couvrait plus aucun poste)." : "Devis retiré de ce poste." };
}

/**
 * DÉPOSER LA FACTURE ET DEMANDER LE PAIEMENT D'UN POSTE (§118.204). « Ils doivent uploader les
 * factures pour demander un paiement. Obligatoirement facture. » La facture est exigée, avec son
 * montant ; elle ne dépasse pas le montant accordé. Un poste avec bon de commande attend que les
 * Finances l'aient SIGNÉ ; un sponsoring direct (aide versée à l'association) n'a pas de BC.
 *
 * Remplace « Émettre le bon de commande » des Finances, qui créait un ordre de dépense et rien
 * d'autre : le paiement part maintenant de la FACTURE, rattachée à son BC, et passe par le centre de
 * paiement (§118.148).
 */
export async function demanderPaiementPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "une facture");
  if (refusStock) return { ok: false, error: refusStock };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };

  // L'ÉTAT D'ABORD (§118.18) — puis la facture.
  if (item.orderStage === "ISSUED" || item.expenseOrderId) {
    return { ok: false, error: item.expenseOrderId ? "Le paiement de ce poste a déjà été demandé." : "Une demande de paiement est déjà en cours pour ce poste : rouvrez la fiche." };
  }
  const montantAccorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  const check = canEmitOrder({ amountGranted: montantAccorde, expenseOrderId: item.expenseOrderId, status: item.status }, info.decided);
  if (!check.ok) return { ok: false, error: check.reason ?? "Paiement impossible." };
  if (!item.budgetCategoryId) return { ok: false, error: "La Direction Marketing n'a pas encore choisi le budget de ce poste." };
  const direct = VERSEMENT_SANS_BC.includes(item.kind);
  // UN POSTE À BON DE COMMANDE (Direction, 06/10) : la facture DÉPOSÉE et contrôlée par Luna contre le(s) BC signé(s)
  // fait la demande — une facture jointe ici est d'abord déposée, et passe le même contrôle.
  if (!direct) {
    const fichier = formData.getAll("attachment").find((v): v is File => v instanceof File && v.size > 0) ?? null;
    return payerLesFacturesDuPoste({
      user, item, owner, info, montantAccorde, fichier,
      montantSaisi: fdNum(formData, "montant"), reference: fdStr(formData, "reference"),
      bcIds: formData.getAll("bcId").map(String).filter(Boolean),
      argumentation: fdStr(formData, "argumentation"), confirme: fdCase(formData, "confirme") === true,
    });
  }
  const pieces = (await piecesDesPostes([id])).get(id);
  const bc = pieces?.bc ?? null;
  if (!direct) {
    if (!bc) return { ok: false, error: "Le bon de commande de ce poste n'est pas encore établi : la facture se dépose après lui." };
    if (bc.etape !== "SIGNE") return { ok: false, error: "Le bon de commande n'est pas encore signé par les Finances : la facture se dépose après la signature." };
  }

  const fichiers = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  // LA PIÈCE QU'ON EXIGE DÉPEND DE LA NATURE DU POSTE (Direction, 05/10) : un sponsoring INDIRECT
  // (devis → BC → facture) exige la facture ; un sponsoring DIRECT à l'association exige la
  // « Proforma / lettre de demande de sponsoring », et la facture n'est qu'une pièce de plus qu'on peut
  // joindre. La pro forma ou la lettre peut aussi être DÉJÀ sur le poste (déposée dans sa case) : elle
  // compte, il n'y a alors rien à rejoindre.
  const justificatifDejaLa = direct && (pieces?.devis ?? []).some((d) => !d.annulee && d.fichiers > 0);
  if (fichiers.length === 0 && !justificatifDejaLa) {
    return {
      ok: false,
      error: direct
        ? `Joignez la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} : elle est exigée pour demander le paiement d'un sponsoring direct (la facture, elle, est facultative).`
        : "Joignez la facture : elle est obligatoire pour demander le paiement.",
    };
  }
  const facturesFacultatives = direct ? formData.getAll("facture").filter((v): v is File => v instanceof File && v.size > 0) : [];
  const refusFichier = await validateAttachments([...fichiers, ...facturesFacultatives]);
  if (refusFichier) return { ok: false, error: refusFichier };
  const montant = fdNum(formData, "montant");
  const piece = direct ? LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr") : "facture";
  if (montant === null || !(montant > 0)) return { ok: false, error: `Indiquez le montant de la ${piece}.` };
  if (montantAccorde !== null && montant > montantAccorde) {
    return { ok: false, error: `La ${piece} (${montant.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
  }

  // LE DERNIER REMPART (§118.187) : ce qui part ne dépasse jamais ce que le centre a vu. Le montant ou
  // le prestataire ont pu changer par un chemin que rien n'a surveillé : on compare à l'empreinte du
  // visa, on rouvre le visa si elle est dépassée, et on refuse en disant pourquoi.
  if (item.orderStage === "DIRECTION_OK") {
    const apres = { montant: montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    if (geste.geste === "ROUVRIR") {
      const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info.ref });
      return { ok: false, error: `Paiement refusé — ${phrase ?? geste.motif}` };
    }
  }

  // LA PRISE (§118.187) : un poste à la fois — deux clics ne déposent pas deux factures.
  const etapeLue = item.orderStage;
  const prise = await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: null, status: "APPROVED", orderStage: etapeLue },
    data: { orderStage: "ISSUED", updatedById: user.id },
  });
  if (prise.count === 0) return { ok: false, error: "Ce poste vient de changer (paiement déjà demandé, ou sa décision a été revue) : rouvrez la fiche." };

  const piecesCreees: string[] = [];
  let factureId: string | null = null;
  let ordreNe = false;
  try {
    const amont = bc?.id ?? (pieces?.devis.filter((d) => !d.annulee).length === 1 ? pieces.devis.find((d) => !d.annulee)!.id : null);
    const companyId = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    let amontDeLaFacture = amont;
    // UN SPONSORING DIRECT : la pièce exigée est la pro forma / lettre de demande — un DEVIS au registre,
    // rattaché au poste dans la case des devis. Rien n'est créé quand elle est déjà sur le poste.
    if (direct && fichiers.length > 0) {
      const justificatif = await prisma.legalDocument.create({
        data: {
          title: `${LIBELLE_JUSTIFICATIF_DIRECT} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${info.ref})`,
          kind: "QUOTE",
          reference: fdStr(formData, "reference"),
          amount: montant,
          counterparty: item.supplier ?? info.beneficiary,
          companyId,
          sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
          createdById: user.id, updatedById: user.id,
          notes: `${LIBELLE_JUSTIFICATIF_DIRECT} du poste « ${item.label} » de ${info.ref}.`,
        },
        select: { id: true },
      });
      piecesCreees.push(justificatif.id);
      await attachFormFiles(user.id, "LEGAL_DOCUMENT", justificatif.id, formData);
      await rattacherPieceAuPoste({ itemId: id, legalDocumentId: justificatif.id, nature: "DEVIS", acteurId: user.id });
      amontDeLaFacture = justificatif.id;
    }
    // LA FACTURE : exigée pour tout poste qui n'est pas un versement à l'association ; facultative pour lui
    // (elle se joint si on l'a, sous le champ « facture »).
    if (!direct || facturesFacultatives.length > 0) {
      const facture = await prisma.legalDocument.create({
        data: {
          title: `Facture — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${info.ref})`,
          kind: "INVOICE", direction: "OUT",
          reference: direct ? null : fdStr(formData, "reference"),
          amount: montant,
          counterparty: item.supplier ?? info.beneficiary,
          companyId,
          sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
          chainFromId: amontDeLaFacture,
          createdById: user.id, updatedById: user.id,
          notes: `Facture du poste « ${item.label} » de ${info.ref}.`,
        },
        select: { id: true },
      });
      factureId = facture.id;
      piecesCreees.push(facture.id);
      await attachFormFiles(user.id, "LEGAL_DOCUMENT", facture.id, formData, direct ? "facture" : "attachment");
      await rattacherPieceAuPoste({ itemId: id, legalDocumentId: facture.id, nature: "FACTURE", acteurId: user.id });
    }

    const order = await createExpenseOrder({
      label: `${info.ref} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label}`,
      amount: montant,
      category: "EVENEMENT",
      beneficiary: item.supplier ?? info.beneficiary,
      sourceType: owner.parent === "EVENT" ? "EVENT" : owner.parent,
      sourceId: info.id,
      requestedById: user.id,
      budgetCategoryId: item.budgetCategoryId ?? null,
      // La facture n'est exigée avant le règlement que là où elle est la pièce du paiement.
      requiresInvoice: facturePourPayer(item.kind),
      notes: `Poste de l'opération ${info.ref} — ${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} jointe${factureId ? " ; facture jointe" : ""}` : "facture jointe"}.`,
    });
    ordreNe = true;
    await prisma.adProItem.update({ where: { id }, data: { expenseOrderId: order.id, orderStage: "ISSUED", updatedById: user.id } });
    if (factureId) await prisma.legalDocument.update({ where: { id: factureId }, data: { expenseOrderId: order.id } });
    await audit(user, owner.parent, owner.id, "UPDATE",
      `${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT} jointe` : "Facture déposée"} et paiement demandé pour le poste « ${item.label} » — ${montant.toLocaleString("fr-FR")} DZD (ordre ${order.reference}, au centre de paiement).`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/finances/paiements-a-faire");
    return {
      ok: true, id: order.id,
      message: `${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT} jointe` : "Facture déposée"} — paiement de ${montant.toLocaleString("fr-FR")} DZD demandé au centre de paiement (${order.reference}).`,
    };
  } catch (err) {
    console.error("[ad-pro-item] demande de paiement impossible", err);
    if (!ordreNe) {
      await prisma.adProItem.updateMany({ where: { id, expenseOrderId: null, orderStage: "ISSUED" }, data: { orderStage: etapeLue } }).catch(() => undefined);
      if (piecesCreees.length > 0) await prisma.legalDocument.updateMany({ where: { id: { in: piecesCreees } }, data: { status: "CANCELLED" } }).catch(() => undefined);
    }
    return { ok: false, error: "La demande de paiement n'a pas pu être enregistrée." };
  }
}

// ───────────────────────────── Le BC signé, la facture contrôlée, le paiement (Direction, 06/10) ─────────────────────────────

type PosteAvecOperation = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

/**
 * DÉPOSER LA FACTURE D'UN OU PLUSIEURS BC SIGNÉS — « une fois la facture reçue, Luna vérifie uniquement la cohérence avec
 * le bon de commande ». La facture se lit (Luna, sinon le moteur local), se compare aux BC qu'elle couvre
 * (`controlerFacture`), et le contrôle reste SUR la facture : la case paiement le relit. Un poste à plusieurs BC dépose
 * une facture par BC — ou une seule pour plusieurs, en les cochant.
 */
async function deposerFactureSurPoste(a: {
  user: SessionUser; poste: PosteAvecOperation; info: ParentInfo; fichier: File; montantSaisi: number | null; reference: string | null; bcIds: string[];
}): Promise<{ ok: true; factureId: string; controle: ControleFacture } | { ok: false; error: string }> {
  const { item, owner } = a.poste;
  const pieces = (await piecesDesPostes([item.id])).get(item.id);
  const bcs = pieces?.bcs ?? [];
  const couverts = new Set((pieces?.factures ?? []).filter((f) => !f.annulee).flatMap((f) => f.controle?.bcIds ?? []));
  const libres = bcs.filter((b) => b.etape === "SIGNE" && !couverts.has(b.id));
  const choisis = a.bcIds.length > 0 ? bcs.filter((b) => a.bcIds.includes(b.id)) : libres.length === 1 ? libres : [];
  if (bcs.length === 0) return { ok: false, error: "Ce poste n'a pas encore de bon de commande : la facture se dépose après lui." };
  if (choisis.length === 0) {
    return { ok: false, error: libres.length === 0 ? "Aucun bon de commande signé n'attend sa facture sur ce poste." : "Cochez le(s) bon(s) de commande que cette facture couvre." };
  }
  if (a.bcIds.length > 0 && choisis.length !== a.bcIds.length) return { ok: false, error: "Un bon de commande coché n'appartient pas à ce poste." };
  const nonSigne = choisis.find((b) => b.etape !== "SIGNE");
  if (nonSigne) return { ok: false, error: `Le bon de commande ${nonSigne.reference ?? nonSigne.titre} n'est pas encore signé : sa facture se dépose après la signature.` };
  const dejaFacture = choisis.find((b) => couverts.has(b.id));
  if (dejaFacture) return { ok: false, error: `Le bon de commande ${dejaFacture.reference ?? dejaFacture.titre} a déjà sa facture : annulez-la dans Legal pour en déposer une autre.` };
  const refusFichier = await validateAttachments([a.fichier]);
  if (refusFichier) return { ok: false, error: refusFichier };

  const octets = Buffer.from(await a.fichier.arrayBuffer());
  const lu = await lireFactureDuPoste({ userId: a.user.id, octets, nomFichier: a.fichier.name, montantSaisi: a.montantSaisi });
  const docs = await prisma.legalDocument.findMany({ where: { id: { in: choisis.map((b) => b.id) } }, select: { id: true, reference: true, amount: true, counterparty: true } });
  const controle = controlerFacture(lu, choisis.map((b) => {
    const d = docs.find((x) => x.id === b.id);
    return { id: b.id, reference: d?.reference ?? b.reference, montantTtc: d?.amount != null ? toNumber(d.amount) : b.montant, fournisseur: d?.counterparty ?? null };
  }));
  const companyId = a.info.companyId ?? (await moneyEntityOf(a.info.requesterId ?? a.user.id));
  const facture = await prisma.legalDocument.create({
    data: {
      title: `Facture — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${a.info.ref})`,
      kind: "INVOICE", direction: "OUT",
      reference: a.reference,
      amount: controle.montant,
      counterparty: docs[0]?.counterparty ?? item.supplier ?? a.info.beneficiary,
      companyId,
      sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
      chainFromId: choisis[0].id,
      custom: { facturePoste: { controle } } as unknown as Prisma.InputJsonValue,
      createdById: a.user.id, updatedById: a.user.id,
      notes: `Facture du poste « ${item.label} » de ${a.info.ref} — couvre ${choisis.map((b) => b.reference ?? b.titre).join(", ")}.`,
    },
    select: { id: true },
  });
  const depot = await persistUploadedDocument(a.user.id, {
    entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: a.fichier, buffer: octets,
  }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "Dépôt impossible.", documentId: undefined }));
  if (!depot.ok) {
    await prisma.legalDocument.update({ where: { id: facture.id }, data: { status: "CANCELLED" } }).catch(() => undefined);
    return { ok: false, error: `La facture n'a pas pu être enregistrée (${depot.error ?? "erreur"}).` };
  }
  await rattacherPieceAuPoste({ itemId: item.id, legalDocumentId: facture.id, nature: "FACTURE", acteurId: a.user.id });
  return { ok: true, factureId: facture.id, controle };
}

/** La phrase qui rend le contrôle d'une facture — cohérente, ou ses écarts et le geste qui reste. */
function phraseControleFacture(c: ControleFacture): string {
  return c.coherente
    ? `Luna la trouve cohérente avec le bon de commande${c.montant != null ? ` (${c.montant.toLocaleString("fr-FR")} DZD)` : ""} : la demande de paiement peut partir.`
    : `Incohérences avec le bon de commande : ${c.ecarts.join(" ")} Pour demander tout de même le paiement, argumentez et confirmez.`;
}

/**
 * DÉPOSER LA FACTURE D'UN POSTE À BON DE COMMANDE (Direction, 06/10) — la case « Facture » se débloque à la signature du
 * BC ; le fichier est lu, contrôlé contre le(s) BC, et le contrôle est dit. Le paiement se demande ensuite, depuis la
 * case paiement (`demanderPaiementPoste`).
 */
export async function deposerFacturePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (VERSEMENT_SANS_BC.includes(item.kind)) return { ok: false, error: "Un sponsoring direct n'a pas de bon de commande : sa pièce se joint à la demande de paiement." };
  if (item.expenseOrderId) return { ok: false, error: "Le paiement de ce poste est déjà demandé." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fichier = formData.getAll("attachment").find((v): v is File => v instanceof File && v.size > 0) ?? null;
  if (!fichier) return { ok: false, error: "Joignez la facture." };
  const r = await enSerie(filePoste(id), () => deposerFactureSurPoste({
    user, poste: found, info, fichier, montantSaisi: fdNum(formData, "montant"), reference: fdStr(formData, "reference"),
    bcIds: formData.getAll("bcId").map(String).filter(Boolean),
  }));
  if (!r.ok) return r;
  await audit(user, owner.parent, owner.id, "UPDATE", `Facture déposée pour le poste « ${item.label} » — ${r.controle.coherente ? "cohérente avec le bon de commande" : `écarts : ${r.controle.ecarts.join(" ")}`}`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: r.factureId, message: `Facture déposée. ${phraseControleFacture(r.controle)}` };
}

/**
 * LA DEMANDE DE PAIEMENT D'UN POSTE À BC, SUR SES FACTURES DÉPOSÉES. Tous les BC vivants signés et couverts ; une facture
 * incohérente exige l'argumentation ET la confirmation (`refusDemandePaiementBC`) ; le montant est celui des factures, et
 * ne dépasse jamais l'accordé.
 */
async function payerLesFacturesDuPoste(a: {
  user: SessionUser; item: PosteAvecOperation["item"]; owner: PosteAvecOperation["owner"]; info: ParentInfo; montantAccorde: number | null;
  fichier: File | null; montantSaisi: number | null; reference: string | null; bcIds: string[]; argumentation: string | null; confirme: boolean;
}): Promise<ActionResult> {
  const { user, item, owner, info } = a;
  const id = item.id;
  let deposee: string | null = null;
  const avant = (await piecesDesPostes([id])).get(id);
  // SANS FACTURE DÉPOSÉE, la facture se joint ICI — et ce qui la refuserait se dit AVANT de déposer quoi que ce soit
  // (§118.18) : un refus ne laisse ni facture ni ordre derrière lui.
  if (!(avant?.factures ?? []).some((f) => !f.annulee) || a.fichier) {
    if (!avant?.bc) return { ok: false, error: "Le bon de commande de ce poste n'est pas encore établi : la facture se dépose après lui." };
    if (avant.bc.etape !== "SIGNE") return { ok: false, error: "Le bon de commande n'est pas encore signé par les Finances : la facture se dépose après la signature." };
    if (!a.fichier) return { ok: false, error: "Joignez la facture : elle est obligatoire pour demander le paiement." };
    if (a.montantSaisi === null || !(a.montantSaisi > 0)) return { ok: false, error: "Indiquez le montant de la facture." };
    if (a.montantAccorde !== null && a.montantSaisi > a.montantAccorde) {
      return { ok: false, error: `La facture (${a.montantSaisi.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${a.montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
    }
  }
  if (a.fichier) {
    // Jointe à la demande, la facture couvre ce qui attend encore la sienne : tous les BC signés sans facture.
    const couverts = new Set((avant?.factures ?? []).filter((f) => !f.annulee).flatMap((f) => f.controle?.bcIds ?? []));
    const bcIds = a.bcIds.length > 0 ? a.bcIds : (avant?.bcs ?? []).filter((b) => b.etape === "SIGNE" && !couverts.has(b.id)).map((b) => b.id);
    const r = await enSerie(filePoste(id), () => deposerFactureSurPoste({
      user, poste: { item, owner } as PosteAvecOperation, info, fichier: a.fichier as File, montantSaisi: a.montantSaisi, reference: a.reference, bcIds,
    }));
    if (!r.ok) return r;
    deposee = `Facture déposée. ${phraseControleFacture(r.controle)}`;
  }
  const pieces = (await piecesDesPostes([id])).get(id);
  const factures = (pieces?.factures ?? []).filter((f) => !f.annulee);
  const refus = refusDemandePaiementBC({
    bcs: (pieces?.bcs ?? []).map((b) => ({ id: b.id, reference: b.reference, signe: b.etape === "SIGNE" })),
    factures, argumentation: a.argumentation, confirme: a.confirme,
  });
  if (refus) return { ok: false, error: deposee ? `${deposee} ${refus}` : refus };
  const montants = factures.map((f) => f.controle?.montant ?? f.montant);
  const montant = montants.every((m): m is number => m != null) ? Math.round(montants.reduce((s, m) => s + m * 100, 0)) / 100 : a.montantSaisi;
  if (montant === null || !(montant > 0)) return { ok: false, error: "Le montant de la facture ne se lit pas : indiquez-le." };
  if (a.montantAccorde !== null && montant > a.montantAccorde) {
    return { ok: false, error: `La facture (${montant.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${a.montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
  }
  const ecarts = factures.flatMap((f) => (f.controle && !f.controle.coherente ? f.controle.ecarts : []));
  const argument = ecarts.length > 0 ? a.argumentation?.trim() ?? null : null;

  // LE DERNIER REMPART (§118.187) : ce qui part ne dépasse jamais ce que le centre a vu.
  if (item.orderStage === "DIRECTION_OK") {
    const apres = { montant: a.montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    if (geste.geste === "ROUVRIR") {
      const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info.ref });
      return { ok: false, error: `Paiement refusé — ${phrase ?? geste.motif}` };
    }
  }
  // LA PRISE (§118.187) : un poste à la fois — deux clics ne demandent pas deux paiements.
  const etapeLue = item.orderStage;
  const prise = await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: null, status: "APPROVED", orderStage: etapeLue },
    data: { orderStage: "ISSUED", updatedById: user.id },
  });
  if (prise.count === 0) return { ok: false, error: "Ce poste vient de changer (paiement déjà demandé, ou sa décision a été revue) : rouvrez la fiche." };
  let ordreNe = false;
  try {
    const order = await createExpenseOrder({
      label: `${info.ref} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label}`,
      amount: montant,
      category: "EVENEMENT",
      beneficiary: item.supplier ?? info.beneficiary,
      sourceType: owner.parent === "EVENT" ? "EVENT" : owner.parent,
      sourceId: info.id,
      requestedById: user.id,
      budgetCategoryId: item.budgetCategoryId ?? null,
      requiresInvoice: facturePourPayer(item.kind),
      notes: `Poste de l'opération ${info.ref} — ${factures.length > 1 ? `${factures.length} factures jointes` : "facture jointe"}, contrôlée${factures.length > 1 ? "s" : ""} contre le bon de commande.`
        + (argument ? ` ÉCART ASSUMÉ par le demandeur : ${ecarts.join(" ")} Argumentation : « ${argument} ».` : ""),
    });
    ordreNe = true;
    await prisma.adProItem.update({ where: { id }, data: { expenseOrderId: order.id, orderStage: "ISSUED", updatedById: user.id } });
    await prisma.legalDocument.updateMany({ where: { id: { in: factures.map((f) => f.id) } }, data: { expenseOrderId: order.id } });
    await audit(user, owner.parent, owner.id, "UPDATE",
      `Paiement demandé pour le poste « ${item.label} » — ${montant.toLocaleString("fr-FR")} DZD (ordre ${order.reference}, au centre de paiement)${argument ? ` malgré l'écart avec le bon de commande — « ${argument} »` : ""}.`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/finances/paiements-a-faire");
    return {
      ok: true, id: order.id,
      message: `${deposee ? `${deposee} ` : ""}Paiement de ${montant.toLocaleString("fr-FR")} DZD demandé au centre de paiement (${order.reference}).`,
    };
  } catch (err) {
    console.error("[ad-pro-item] demande de paiement impossible", err);
    if (!ordreNe) await prisma.adProItem.updateMany({ where: { id, expenseOrderId: null, orderStage: "ISSUED" }, data: { orderStage: etapeLue } }).catch(() => undefined);
    return { ok: false, error: "La demande de paiement n'a pas pu être enregistrée." };
  }
}

/**
 * LE BC D'UN POSTE QU'ON PEUT MODIFIER — la porte de « Modifier le BC » et de son aperçu, une seule fois : le poste existe et
 * s'édite, son paiement n'est pas demandé, le BC lui est rattaché et n'est PAS SIGNÉ (un BC signé ne se modifie plus depuis
 * le poste : il se remplace avec les Finances).
 */
async function bcModifiableDuPoste(user: SessionUser, formData: FormData): Promise<
  | { ok: true; item: NonNullable<Awaited<ReturnType<typeof loadItem>>>["item"]; owner: NonNullable<Awaited<ReturnType<typeof loadItem>>>["owner"]; info: { ref: string }; legalDocumentId: string }
  | { ok: false; error: string }
> {
  const id = fdStr(formData, "id");
  const legalDocumentId = fdStr(formData, "legalDocumentId") ?? fdStr(formData, "revisionDe");
  if (!id || !legalDocumentId) return { ok: false, error: "Bon de commande non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.expenseOrderId) return { ok: false, error: "Le paiement de ce poste est déjà demandé : son bon de commande ne se modifie plus." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const lien = await prisma.adProItemPiece.findFirst({ where: { itemId: id, legalDocumentId, nature: "BON_DE_COMMANDE" }, select: { legalDocument: { select: { signedAt: true, reference: true } } } });
  if (!lien) return { ok: false, error: "Ce bon de commande n'est pas rattaché à ce poste." };
  if (lien.legalDocument.signedAt) return { ok: false, error: `Le bon de commande ${lien.legalDocument.reference ?? ""} est signé : il ne se modifie plus. Voyez avec les Finances pour le remplacer.` };
  return { ok: true, item, owner, info, legalDocumentId };
}

/**
 * CE QUE LE COMPOSEUR ENVOIE pour un BC de poste — les mêmes champs que la révision de la fiche Legal
 * (`fabrique-actions.ts`, `lireModifications`), relus ici parce que le contrat d'une action ne suit que ses délégués LOCAUX
 * (§118.87c). Une clé absente garde sa valeur ; présente et vide, elle l'efface.
 */
function lireModificationsDuBc(formData: FormData): ModificationsDocument {
  const champ = (cle: string): string | null => { const v = fdStr(formData, cle); return v && v.trim() ? v.trim() : null; };
  const pourcent = (cle: string): number | null => {
    const v = (fdStr(formData, cle) ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
    const n = v ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n / 100 : null;
  };
  const listes: ListesDeLignes = {
    designations: formData.getAll("ligneDesignation").map(String), details: formData.getAll("ligneDetails").map(String),
    quantites: formData.getAll("ligneQuantite").map(String), prix: formData.getAll("lignePrix").map(String),
    remises: formData.getAll("ligneRemise").map(String), tvas: formData.getAll("ligneTva").map(String), sections: formData.getAll("ligneSection").map(String),
  };
  const m: ModificationsDocument = {};
  if (listes.designations.length > 0) m.lignes = lignesDepuisListes(listes);
  if (formData.has("tiersNom")) {
    m.tiers = {
      nom: champ("tiersNom") ?? "",
      ...(formData.has("tiersAdresse") ? { adresse: champ("tiersAdresse") } : {}),
      ...(formData.has("tiersTelephone") ? { telephone: champ("tiersTelephone") } : {}),
      ...(formData.has("tiersEmail") ? { email: champ("tiersEmail") } : {}),
      ...(formData.has("tiersRc") ? { rc: champ("tiersRc") } : {}),
      ...(formData.has("tiersNif") ? { nif: champ("tiersNif") } : {}),
      ...(formData.has("tiersAi") ? { ai: champ("tiersAi") } : {}),
      ...(formData.has("tiersNis") ? { nis: champ("tiersNis") } : {}),
    };
  }
  if (formData.has("date")) m.date = champ("date");
  if (formData.has("objet")) m.objet = champ("objet");
  if (formData.has("notes")) m.notes = champ("notes");
  if (formData.has("referenceAmont")) m.referenceAmont = champ("referenceAmont");
  if (formData.has("referenceAmontDate")) m.referenceAmontDate = champ("referenceAmontDate");
  if (formData.has("conditionsPaiement")) m.conditionsPaiement = champ("conditionsPaiement");
  if (formData.has("modePaiement")) {
    const mode = fdStr(formData, "modePaiement");
    m.modePaiement = mode && (MODES_PAIEMENT as readonly string[]).includes(mode) ? (mode as (typeof MODES_PAIEMENT)[number]) : null;
  }
  if (formData.has("tvaDefaut")) m.tvaDefaut = pourcent("tvaDefaut");
  if (formData.has("remiseGlobale")) m.remiseGlobale = pourcent("remiseGlobale");
  if (formData.has("taxeLibelle")) {
    const libelles = formData.getAll("taxeLibelle").map(String);
    const taux = formData.getAll("taxeTaux").map(String);
    const taxes = libelles.map((libelle, i) => {
      const t = (taux[i] ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
      return { libelle: libelle.trim(), taux: t && Number.isFinite(Number(t)) ? Number(t) / 100 : Number.NaN };
    }).filter((t) => t.libelle || Number.isFinite(t.taux));
    m.taxes = taxes.length ? taxes : null;
  }
  if (formData.has("livraisonAdresse") || formData.has("livraisonDelai")) {
    m.livraison = {
      ...(formData.has("livraisonAdresse") ? { adresse: champ("livraisonAdresse") } : {}),
      ...(formData.has("livraisonDelai") ? { delai: champ("livraisonDelai") } : {}),
    };
  }
  if (formData.has("contactNom") || formData.has("contactTelephone")) {
    m.contact = {
      ...(formData.has("contactNom") ? { nom: champ("contactNom") } : {}),
      ...(formData.has("contactTelephone") ? { telephone: champ("contactTelephone") } : {}),
    };
  }
  if (formData.has("letterheadId")) m.letterheadId = champ("letterheadId");
  const coordonnees = fdStr(formData, "emetteurPersonnalise");
  if (coordonnees === "1") m.coordonneesEmetteur = { adresse: champ("emetteurAdresse"), telephone: champ("emetteurTelephone"), email: champ("emetteurEmail") };
  else if (coordonnees !== null) m.coordonneesEmetteur = null;
  if (fdStr(formData, "signatairePersonnalise") === "1") m.signataire = champ("signataireNom") ? { nom: champ("signataireNom") ?? "", qualite: champ("signataireQualite") } : null;
  if (formData.has("mentions")) m.mentions = (fdStr(formData, "mentions") ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return m;
}

/**
 * L'APERÇU DU BC MODIFIÉ, depuis le poste — la même composition que la modification (`previsualiserRevision`, à blanc),
 * sous la délégation du poste : le demandeur voit les totaux de SON bon de commande sans droit Legal. Rien n'est écrit.
 */
export async function previsualiserBcDuPoste(formData: FormData): Promise<ApercuPiece | { ok: false; error: string }> {
  const user = await requireUser();
  const lu = await bcModifiableDuPoste(user, formData);
  if (!lu.ok) return { ok: false, error: lu.error };
  const modifications = lireModificationsDuBc(formData);
  const r = await previsualiserRevision(user, { legalDocumentId: lu.legalDocumentId, modifications }, {
    delegation: `${lu.info.ref} — poste « ${lu.item.label} » : aperçu de son bon de commande par le demandeur du poste`,
  });
  if (!r.ok) return { ok: false, error: r.motif };
  return apercuPourEcran(r, true);
}

/**
 * MODIFIER LE BON DE COMMANDE GÉNÉRÉ, EN NATIF ET SANS LIMITE (Direction, 06/10) — tant qu'il n'est pas signé. Chaque
 * modification est une nouvelle VERSION du même BC (même numéro) : le Word et le PDF sont régénérés, la fiche suit, et le
 * BC se réaiguille (un montant relevé le renvoie à son centre). Le demandeur du poste le fait sans droit d'écriture
 * Legal : le poste qu'il porte est la délégation, nommée au journal.
 */
export async function modifierBcDuPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lu = await bcModifiableDuPoste(user, formData);
  if (!lu.ok) return { ok: false, error: lu.error };
  const { item, owner, info, legalDocumentId } = lu;
  // TOUT SE MODIFIE (Direction, 10/2026 — « chaque écriture et détail ») : le formulaire est celui du composeur de pièces,
  // lu champ par champ — ce qu'il ne porte pas garde sa valeur (§118.152).
  const modifications = lireModificationsDuBc(formData);
  if (Object.keys(modifications).length === 0) return { ok: false, error: "Rien à modifier : changez une ligne, le fournisseur, une date, une condition, la livraison, le contact, les notes ou les mentions." };
  const champ = (cle: string): string | null => { const v = fdStr(formData, cle); return v && v.trim() ? v.trim() : null; };
  const accorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  const ht = (modifications.lignes ?? []).filter((l) => !l.section).reduce((s, l) => s + l.quantite * l.prixUnitaire * (1 - (l.remise ?? 0)), 0);
  if (accorde !== null && Number.isFinite(ht) && ht > accorde + TOLERANCE_DZD) {
    return { ok: false, error: `Ces lignes font déjà ${Math.round(ht).toLocaleString("fr-FR")} DZD hors taxes, au-delà de l'accordé (${accorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
  }
  const vue = fdNum(formData, "versionVue");
  const r = await reviserDocumentDrive(user, {
    legalDocumentId, modifications, motif: champ("motif") ?? "Modifié depuis le poste Ad & Pro.",
    versionVue: vue !== null && Number.isInteger(vue) ? vue : null,
  }, { delegation: `${info.ref} — poste « ${item.label} » : son bon de commande, modifié par le demandeur du poste` });
  if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande ${r.reference} du poste « ${item.label} » modifié — version ${r.version}, ${r.totaux.totalTtc.toLocaleString("fr-FR")} DZD TTC.`);
  revalidate(owner.parent, owner.id);
  revalidatePath(`/legal/${legalDocumentId}`);
  revalidatePath(CHEMIN_BC_A_SIGNER);
  const depasse = accorde !== null && r.totaux.totalTtc > accorde + TOLERANCE_DZD
    ? ` Attention : ${r.totaux.totalTtc.toLocaleString("fr-FR")} DZD TTC dépasse l'accordé (${accorde.toLocaleString("fr-FR")} DZD) — le paiement ne pourra pas le dépasser.`
    : "";
  return {
    ok: true, id: legalDocumentId,
    message: `Bon de commande ${r.reference} modifié : version ${r.version}, Word et PDF régénérés.${r.reserveBonDeCommande ? ` ${r.reserveBonDeCommande}` : ""}${depasse}`,
  };
}

// ───────────────────────────── Matériel promotionnel ─────────────────────────────

/**
 * Rattache un matériel promotionnel EXISTANT à un poste.
 *
 * On ne recopie jamais son état ici : le matériel suit son propre circuit et l'opération en lit
 * l'avancement. Deux vérités sur le même objet finiraient toujours par diverger.
 */
export async function linkPromoMaterial(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  // Rattacher un dossier d'ACHAT ferait de ce poste un poste « Matériel promotionnel » (la nature
  // change ci-dessous) — et laisserait ses lignes de stock à une nature qui ne sait plus les rendre.
  const refusStock = refusArgentSurPosteStock(item.kind, "un dossier d'achat de matériel promotionnel");
  if (refusStock) return { ok: false, error: refusStock };

  const promoMaterialId = fdStr(formData, "promoMaterialId");
  if (promoMaterialId) {
    const pm = await prisma.promoMaterial.findUnique({ where: { id: promoMaterialId }, select: { reference: true } });
    if (!pm) return { ok: false, error: "Matériel promotionnel introuvable." };
    await prisma.adProItem.update({ where: { id }, data: { promoMaterialId, kind: "PROMO_MATERIAL", updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » rattaché au matériel ${pm.reference}.`);
  } else {
    await prisma.adProItem.update({ where: { id }, data: { promoMaterialId: null, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » détaché de son matériel promotionnel.`);
  }

  revalidate(owner.parent, owner.id);
  return { ok: true, id };
}

/** Les matériels promotionnels rattachables — pour le sélecteur, sans exposer tout le module. */
export async function promoMaterialOptions(): Promise<{ id: string; reference: string; title: string; status: string }[]> {
  const user = await requireUser();
  if (!canEditItems(user, "SPONSORING") && !canEditItems(user, "CONGRESS_NATIONAL")) return [];
  const rows = await prisma.promoMaterial.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, reference: true, title: true, status: true },
  });
  return rows.map((r) => ({ ...r, status: String(r.status) }));
}

// ───────────────────────── Validation du poste (Direction) ─────────────────────────

/** Trace une décision SANS écraser la précédente : le 3ᵉ tour ne doit pas effacer les deux refus. */
async function recordDecision(itemId: string, decision: AdProItemStatus, note: string | null, amount: number | null, byId: string) {
  await prisma.adProItemDecision.create({
    data: { itemId, decision, note, amount, byId },
  }).catch(() => undefined);
}

/**
 * SOUMET un poste à la Direction. Le demandeur décrit, chiffre, joint ses devis, puis envoie —
 * poste par poste. Un poste en « budget à revoir » se resoumet autant de fois qu'il le faut.
 */
export async function submitAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id, { partir: true });
  if (clos) return { ok: false, error: clos };

  const info = await PARENTS[owner.parent].load(owner.id);
  const check = canSubmitItem({
    status: item.status,
    amountEstimated: item.amountEstimated != null ? toNumber(item.amountEstimated) : null,
    amountGranted: item.amountGranted != null ? toNumber(item.amountGranted) : null,
    kind: item.kind,
    lignesStock: item.kind === "STOCK_MATERIAL" ? await prisma.adProStockLine.count({ where: { itemId: id } }) : 0,
    // UNE FICHE PAR PERSONNE (Direction, 06/10) — facultative dans un sponsoring indirect.
    fichesPersonnes: await compterFichesPersonnes(item),
    priseEnChargeIndirecte: priseEnChargeIndirecte(item, info),
  });
  if (!check.ok) return { ok: false, error: check.reason ?? "Soumission impossible." };

  const note = fdStr(formData, "note");
  const amount = item.amountGranted ?? item.amountEstimated;
  const corps = `${info?.ref ?? "Opération"} — ${ITEM_KIND_LABELS[item.kind]} « ${item.label} »${amount != null ? ` (${toNumber(amount).toLocaleString("fr-FR")} DZD)` : ""}`;
  const lien = lienPosteAdPro(owner.parent, owner.id, item.id);

  // LE MATÉRIEL DU STOCK garde sa décision UNIQUE (§118.167) : il n'engage pas d'argent.
  if (item.kind === "STOCK_MATERIAL") {
    await prisma.adProItem.update({
      where: { id },
      data: { status: "PENDING", submittedAt: new Date(), decisionNote: null, updatedById: user.id },
    });
    await recordDecision(id, "PENDING", note, amount != null ? toNumber(amount) : null, user.id);
    await notifyRoles(valideursDuPoste(owner.parent), { type: "VALIDATION_REQUIRED", title: "Poste à valider", body: corps, link: lien }).catch(() => undefined);
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » soumis à la Direction.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id };
  }

  // LA VALIDATION EN DEUX TEMPS (§118.204). Chaque soumission repart du PREMIER temps : un accord ne
  // couvre que ce qu'il a vu, et un poste resoumis après un refus ou une révision a changé. Sauf quand
  // la demande vient de la Direction des opérations — on ne lui fait pas valider sa propre demande :
  // le premier temps est franchi d'office, et la trace le dit.
  const demandeur = await demandeurDe(info?.requesterId);
  const opsDOffice = opsFranchiALaSoumission(demandeur);
  const maintenant = new Date();
  await prisma.adProItem.update({
    where: { id },
    data: {
      status: "PENDING", submittedAt: maintenant, decisionNote: null, updatedById: user.id,
      opsDecidedAt: opsDOffice ? maintenant : null,
      opsDecidedById: null,
      opsDecisionNote: opsDOffice ? "Demande de la Direction des opérations : premier temps franchi d'office." : null,
    },
  });
  await recordDecision(id, "PENDING", note, amount != null ? toNumber(amount) : null, user.id);
  const temps = opsDOffice ? "MARKETING" as const : "OPERATIONS" as const;
  await prevenirLeTemps(temps, demandeur, "Poste à valider", corps, lien);
  await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » soumis — en attente de ${libelleTemps(temps, demandeur)}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Poste soumis — en attente de ${libelleTemps(temps, demandeur)}.` };
}

/**
 * DÉCISION de la Direction sur UN poste : accorder, refuser, ou demander à revoir le budget.
 * La révision n'est pas une fin : elle rend la main au demandeur, qui corrige et resoumet — le
 * va-et-vient peut se répéter, chaque tour restant dans l'historique.
 */
export async function decideAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || !decision) return { ok: false, error: "Décision incomplète." };
  if (!["APPROVED", "REJECTED", "REVISION"].includes(decision)) return { ok: false, error: "Décision inconnue." };

  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  // QUI TRANCHE (§118.204). Un poste d'ARGENT se valide en deux temps — la Direction des opérations,
  // puis la Direction Marketing, qui fixe le montant et choisit le budget. Le matériel du stock garde
  // sa décision unique (il n'engage pas d'argent, §118.167).
  const argent = item.kind !== "STOCK_MATERIAL";
  const droits = argent ? await peutTrancherSur(user, owner) : null;
  const temps = argent ? tempsEnAttente(item) : null;
  // REVOIR UNE DÉCISION n'est pas décider à la place du circuit (§118.204). Un poste jamais soumis (ou
  // rendu au demandeur) ne s'accorde pas : il n'a vu aucun des deux temps. Un poste REFUSÉ par la
  // Direction des opérations au premier temps se revoit par ELLE — l'accorder de la Direction Marketing
  // sauterait le premier temps.
  const opsRevoit = argent && temps === null && item.status === "REJECTED" && !item.opsDecidedAt;
  // Refuser un brouillon reste possible (une demande refusée fait le ménage de ses postes) : seul
  // l'ACCORD exige les deux temps.
  if (argent && temps === null && decision === "APPROVED" && (item.status === "DRAFT" || item.status === "REVISION")) {
    return { ok: false, error: "Ce poste n'est pas soumis à la validation : le demandeur le soumet d'abord." };
  }
  if (!argent) {
    if (!canAllocate(user, owner.parent)) return { ok: false, error: "Seule la Direction décide d'un poste." };
  } else if (temps === "OPERATIONS") {
    if (!droits!.operations) return { ok: false, error: "Ce poste attend d'abord la validation de la Direction des opérations." };
  } else if (opsRevoit) {
    if (!droits!.operations) return { ok: false, error: "Ce poste a été refusé par la Direction des opérations : c'est elle qui revoit sa décision." };
  } else if (!droits!.marketing) {
    return {
      ok: false,
      error: temps === "MARKETING"
        ? `Ce poste attend la décision de ${libelleTemps("MARKETING", droits!.demandeur)}.`
        : `Seule ${libelleTemps("MARKETING", droits!.demandeur)} revoit la décision d'un poste.`,
    };
  }
  // Refuser ou renvoyer un poste d'une demande refusée reste possible : ces gestes ne paient rien.
  const clos = await refusSiClos(owner.parent, owner.id, { partir: decision === "APPROVED" });
  if (clos) return { ok: false, error: clos };
  // ÉMIS : la décision ne change plus — mais le refus nomme le geste qui la rouvre (§118.30) : l'ordre
  // s'annule tant qu'il n'est pas réglé, et la décision se revoit ensuite.
  if (item.status === "APPROVED" && (item.orderStage === "ISSUED" || item.expenseOrderId)) {
    return { ok: false, error: "Un ordre de dépense a été émis pour ce poste : annulez-le d'abord (« Annuler l'ordre émis »), puis revoyez la décision." };
  }
  // UN SPONSORING INDIRECT NON RÉPARTI NE S'ACCORDE PAS (§118.175). L'accorder d'un seul tenant
  // ouvrirait UN bon de commande, à UN fournisseur, pour l'imprimerie ET l'hôtellerie — exactement
  // ce que la répartition existe pour empêcher. Le refuser ou le renvoyer en révision reste
  // possible : ces gestes ne paient rien, et la révision est le chemin qui rouvre la répartition.
  if (item.kind === "INDIRECT_SUPPORT" && decision === "APPROVED") return { ok: false, error: REFUS_INDIRECT_NON_REPARTI };

  const note = fdStr(formData, "note");
  // UN REFUS OU UN RENVOI SANS MOTIF EST UNE IMPASSE (audit 360°, R24–R36) : le demandeur ne sait pas
  // quoi corriger. `=== null` et non `!note` : la dérivation des contrats lit `if (!v)` comme « champ
  // OBLIGATOIRE » pour toute l'action, et l'accord sans note deviendrait inappelable (§118.138).
  if (decision !== "APPROVED" && note === null) {
    return { ok: false, error: "Indiquez le motif : sans lui, le demandeur ne sait pas quoi corriger." };
  }
  // En accordant, la Direction peut arrêter le montant du poste (c'est le geste naturel :
  // « d'accord, mais pour 120 000 »). Sans montant saisi, l'estimation fait foi.
  const granted = fdNum(formData, "amountGranted");
  if (granted != null && granted < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const status = decision as AdProItemStatus;

  // ── PREMIER TEMPS ACCORDÉ (§118.204) : le statut ne bouge pas, le fait se pose sur le poste, et la
  // Direction Marketing est prévenue. CONDITIONNELLE : deux validations croisées n'en posent qu'une.
  if (argent && (temps === "OPERATIONS" || opsRevoit) && status === "APPROVED") {
    const pose = await prisma.adProItem.updateMany({
      where: { id, status: opsRevoit ? "REJECTED" : "PENDING", opsDecidedAt: null },
      data: {
        ...(opsRevoit ? { status: "PENDING" as const, decidedAt: null, decidedById: null, decisionNote: null } : {}),
        opsDecidedAt: new Date(), opsDecidedById: user.id, opsDecisionNote: note, updatedById: user.id,
      },
    });
    if (pose.count === 0) return { ok: false, error: "Ce poste vient de changer (déjà validé, ou sa décision a été prise) : rouvrez la fiche." };
    const montantVu = item.amountEstimated != null ? toNumber(item.amountEstimated) : null;
    await recordDecision(id, "PENDING", `Validé par la Direction des opérations${note ? ` — ${note}` : ""}`, montantVu, user.id);
    const info = await PARENTS[owner.parent].load(owner.id);
    await prevenirLeTemps(
      "MARKETING", droits!.demandeur, "Poste validé par la Direction des opérations — à décider",
      `${info?.ref ?? "Opération"} — ${ITEM_KIND_LABELS[item.kind]} « ${item.label} »${montantVu != null ? ` (${montantVu.toLocaleString("fr-FR")} DZD)` : ""} : montant et budget à fixer.`,
      lienPosteAdPro(owner.parent, owner.id, item.id),
    );
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » validé par la Direction des opérations${note ? ` — ${note}` : ""}.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: `Validé — transmis à ${libelleTemps("MARKETING", droits!.demandeur)}.` };
  }

  // ── SECOND TEMPS ACCORDÉ : le BUDGET est exigé (« elle sélectionne le budget »). Le choisir plus
  // tard était un geste à part qu'on oubliait : le poste restait accordé et impayable.
  let budgetCategoryId: string | null = item.budgetCategoryId;
  if (argent && status === "APPROVED") {
    const choisi = fdStr(formData, "budgetCategoryId");
    budgetCategoryId = choisi ?? item.budgetCategoryId;
    if (!budgetCategoryId) return { ok: false, error: "Choisissez le budget qui portera ce poste : la validation de la Direction Marketing le fixe en même temps que le montant." };
    if (choisi) {
      const cat = await prisma.budgetCategoryLine.findUnique({ where: { id: choisi }, select: { id: true } });
      if (!cat) return { ok: false, error: "Catégorie budgétaire introuvable." };
    }
  }

  // REVOIR UNE DÉCISION QUI AVAIT OUVERT UN BON DE COMMANDE (§118.187, audit R05/R12). Le poste quitte
  // l'accord : sa demande de BC — en attente au centre, ou visée — n'a plus d'objet et se retire avec
  // la décision. Sauf si un BC a DÉJÀ été établi dans Legal : il lit sa validation sur ce poste, et
  // le retirer le laisserait sans porte ; le refus le nomme.
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  const quitteLAccord = item.status === "APPROVED" && status !== "APPROVED";
  if (quitteLAccord && bcEnCours) {
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: refusBcEtabli(bcs, "revoyez la décision du poste") };
  }
  const montantAccorde = status === "APPROVED" && item.kind !== "STOCK_MATERIAL"
    ? (granted ?? (item.amountGranted != null ? toNumber(item.amountGranted) : null) ?? (item.amountEstimated != null ? toNumber(item.amountEstimated) : null))
    : null;
  if (argent && status === "APPROVED" && !(montantAccorde != null && montantAccorde > 0)) {
    return { ok: false, error: "Indiquez le montant accordé à ce poste." };
  }

  // `tx` et non un autre nom : la dérivation des contrats lit `prisma.X` et `tx.X` pour dire ce que
  // l'action écrit (§118.137) — un paramètre nommé autrement faisait disparaître le poste de la
  // carte de confirmation, et `id` ne désignait plus rien pour le chemin générique.
  //
  // CONDITIONNELLE (§118.187) : une émission qui passe entre la lecture et l'écriture ne se fait pas
  // défaire par une décision prise sur l'état d'avant — l'émission, elle, exige un poste accordé.
  const ecrireDecision = (tx: Tx | typeof prisma) => tx.adProItem.updateMany({
    // Le temps LU est exigé : une décision ne s'applique pas à un poste qui a changé de temps entre
    // la lecture et l'écriture (§118.204). Revoir une décision prise ne lit, lui, aucun temps.
    where: {
      id, expenseOrderId: null, orderStage: { not: "ISSUED" },
      ...(temps ? { status: "PENDING" as const, opsDecidedAt: temps === "MARKETING" ? { not: null } : null } : {}),
    },
    data: {
      status,
      decidedAt: new Date(),
      decidedById: user.id,
      decisionNote: note,
      ...(status === "APPROVED" && item.kind !== "STOCK_MATERIAL" ? { amountGranted: montantAccorde, budgetCategoryId } : {}),
      ...(quitteLAccord && bcEnCours
        ? {
            orderStage: "NONE" as const, orderDirectionAt: null, orderDirectionById: null,
            // La note du centre s'efface : elle s'afficherait, sous un accord futur, comme une parole
            // du centre sur une demande qui n'existe plus. Le motif vit à l'historique et à l'audit.
            orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null,
          }
        : {}),
      updatedById: user.id,
    },
  });
  if (item.kind === "STOCK_MATERIAL") {
    // LE MATÉRIEL DU STOCK SE RÉSERVE À L'ACCORD (§118.167) — dans la MÊME transaction que la
    // décision : un poste « accordé » dont le matériel n'a pas pu être réservé promettrait au
    // demandeur des kakémonos que le magasin n'a pas. Un refus ou une révision rend au magasin ce
    // qu'un accord précédent avait réservé.
    const r = await deciderMaterielStock(id, status, user.id, ecrireDecision);
    if (!r.ok) return { ok: false, error: r.error };
  } else {
    const r = await ecrireDecision(prisma);
    if (r.count === 0) return { ok: false, error: "Ce poste vient de changer (ordre émis, ou décision déjà prise) : rouvrez la fiche." };
  }
  await recordDecision(id, status, note, granted ?? (item.amountGranted != null ? toNumber(item.amountGranted) : null), user.id);
  // LA DEMANDE SUIT : une rallonge accordée (ou retirée) change le montant de l'opération.
  await reprojeterMontantDemande(owner.parent, owner.id);

  const info = await PARENTS[owner.parent].load(owner.id);
  const label = status === "APPROVED" ? "accordé" : status === "REJECTED" ? "refusé" : "à revoir (budget)";
  // CE QUE LA DÉCISION EMPORTE (audit 360°, R10) — un poste refusé ne garde pas l'assistante au
  // travail sur ses devis et factures ; un poste qui quitte l'accord retire son « BC à établir ». Le
  // sujet de réservation d'une billetterie apprend la décision : c'est là que l'assistante réserve.
  let suite = "";
  if (status === "REJECTED") {
    suite += phraseDemandesCloses(await cloreDemandesSecretariat(id, `le poste « ${item.label} » a été refusé par la Direction — ${note}`, user, "TOUTES"));
  } else if (quitteLAccord && bcEnCours) {
    suite += phraseDemandesCloses(await cloreDemandesSecretariat(id, `la décision du poste « ${item.label} » a été revue — la demande de bon de commande est retirée`, user, "BC_A_ETABLIR"));
  }
  if (status !== "APPROVED" && item.reservationDossierId) {
    suite += await signalerAuSujet(item, user.id, `poste ${label} par la Direction${note ? ` (« ${note} »)` : ""} : la réservation attend la suite.`);
  }
  // UN ACCORD REDONNÉ À UN AUTRE MONTANT, BC en cours : le visa ne couvre que ce qu'il a vu.
  if (status === "APPROVED" && bcEnCours && montantAccorde != null) {
    const apres = { montant: montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info?.ref ?? null });
    if (phrase) suite += ` ${phrase}`;
  }
  if (info?.requesterId && info.requesterId !== user.id) {
    await notifyUser({
      userId: info.requesterId,
      type: "GENERIC",
      title: `Poste ${label}`,
      body: `${info.ref} — « ${item.label} »${note ? ` : ${note}` : ""}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(() => undefined);
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » ${label}${note ? ` — ${note}` : ""}${quitteLAccord && bcEnCours ? " — demande de bon de commande retirée" : ""}.`);
  revalidate(owner.parent, owner.id);
  return suite ? { ok: true, id, message: `Poste ${label}.${suite}` } : { ok: true, id };
}

/** Choix du BUDGET qui portera un poste accordé (catégorie d'enveloppe) — « comme d'habitude ». */
export async function setAdProItemBudget(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  const refusStock = refusArgentSurPosteStock(item.kind, "un budget");
  // La NATURE d'abord : un poste du stock n'a jamais de budget, quel que soit qui le demande.
  if (refusStock) return { ok: false, error: refusStock };
  // LE BUDGET EST CHOISI PAR QUI TIENT LE SECOND TEMPS (§118.204) — la Direction Marketing, ou la
  // Direction des opérations quand la demande vient de la Direction Marketing.
  const droits = await peutTrancherSur(user, owner);
  if (!droits.marketing) return { ok: false, error: `Le budget d'un poste se choisit par ${libelleTemps("MARKETING", droits.demandeur)}.` };
  if (refusStock) return { ok: false, error: refusStock };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.status !== "APPROVED") return { ok: false, error: "Le poste doit d'abord être accordé." };

  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  if (budgetCategoryId) {
    const cat = await prisma.budgetCategoryLine.findUnique({
      where: { id: budgetCategoryId },
      select: { name: true, envelope: { select: { name: true } } },
    });
    if (!cat) return { ok: false, error: "Catégorie budgétaire introuvable." };
    await prisma.adProItem.update({ where: { id }, data: { budgetCategoryId, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » imputé au budget ${cat.envelope.name} › ${cat.name}.`);
  } else {
    await prisma.adProItem.update({ where: { id }, data: { budgetCategoryId: null, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » : imputation budgétaire retirée.`);
  }
  revalidate(owner.parent, owner.id);
  return { ok: true, id };
}

// ───────────────────────── Devis et facture : demandes au secrétariat ─────────────────────────

/** Les demandes de pièce OUVERTES d'un poste, lues par le lien CANONIQUE. */
async function piecesOuvertes(itemId: string): Promise<NaturePieceSecretariat[]> {
  const rows = await prisma.administrativeRequest.findMany({
    where: {
      linkedEntityType: "AD_PRO_ITEM", linkedEntityId: itemId, deletedAt: null,
      status: { notIn: ["DONE", "CANCELLED"] },
    },
    select: { type: true },
  });
  const types = new Set(rows.map((r) => String(r.type)));
  return NATURES_PIECE_SECRETARIAT.filter((n) => types.has(String(PIECE_SECRETARIAT[n].type)));
}

/**
 * DEMANDER UNE PIÈCE COMMERCIALE AU BUREAU DU SECRÉTARIAT — un seul écrivain, deux natures.
 *
 * « On peut demander un devis pas que un BC […] après le BC, une facture. » Le devis et la
 * facture sont la MÊME démarche — une demande au secrétariat, avec un message qui porte le
 * contenu et les références — et ce message est ce que le dirigeant a nommé le premier. Le
 * bon de commande, lui, garde son circuit : il ENGAGE, donc il porte un visa (§118.5).
 *
 * Le rattachement se fait par le lien CANONIQUE (`linkedEntityType` / `linkedEntityId`), pas par
 * une colonne dédiée : c'est lui que l'écran des demandes lit déjà pour savoir qu'une dépense
 * vient d'Ad & Pro et ne doit PAS être imputée une seconde fois au budget d'un département.
 * Mesuré : la demande de devis d'un poste ne le posait pas, donc l'assistante pouvait imputer
 * chez elle une dépense que l'enveloppe de l'opération porte déjà — un double comptage sans
 * aucune erreur visible.
 */
export async function demanderPieceSecretariat(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const brut = fdStr(formData, "nature") ?? "DEVIS";
  const nature = (NATURES_PIECE_SECRETARIAT as string[]).includes(brut)
    ? (brut as NaturePieceSecretariat)
    : null;
  if (!id) return { ok: false, error: "Poste non précisé." };
  if (!nature) return { ok: false, error: `Nature de pièce inconnue : ${brut}. Attendu : ${NATURES_PIECE_SECRETARIAT.join(", ")}.` };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un devis, un bon de commande ou une facture");
  if (refusStock) return { ok: false, error: refusStock };

  const garde = peutDemanderPiece(nature, {
    ouvertes: await piecesOuvertes(id),
    bcDemande: item.orderStage !== "NONE",
  });
  if (!garde.ok) return { ok: false, error: garde.raison };

  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const spec = PIECE_SECRETARIAT[nature];
  // LE MESSAGE DE LA PERSONNE EN TÊTE : c'est ce qu'elle a écrit, et ce que l'assistante lit en
  // premier. Les rappels du moteur (prestataire, enveloppe) viennent après, jamais à sa place.
  const note = fdStr(formData, "note");

  try {
    // La série DEM est PARTAGÉE avec le bureau du secrétariat, qui réessayait sous collision ; ce
    // chemin-ci non, et deux demandes à la même seconde faisaient échouer la seconde (§118.175).
    const request = await createWithRetry(async () => prisma.administrativeRequest.create({
      data: {
        reference: await nextAdminRequestRef(),
        type: spec.type,
        title: titrePiece(nature, `${ITEM_KIND_LABELS[item.kind]} : ${item.label}`, info.ref),
        description: [
          note,
          `Poste de l'opération ${info.ref}.`,
          item.supplier ? `Prestataire pressenti : ${item.supplier}.` : null,
          item.amountEstimated != null ? `Enveloppe estimée : ${toNumber(item.amountEstimated).toLocaleString("fr-FR")} DZD.` : null,
        ].filter(Boolean).join("\n"),
        priority: "HIGH",
        requesterId: user.id,
        // La société de l'OPÉRATION, sinon celle où travaille son demandeur (`moneyEntityOf`) : une
        // opération d'avant le rattachement a `companyId` nul, et sa pièce naîtrait invisible du
        // bureau du secrétariat, cloisonné par société (§118.154).
        companyId: info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id)),
        status: "NEW",
        linkedEntityType: "AD_PRO_ITEM",
        linkedEntityId: item.id,
      },
      select: { id: true, reference: true },
    }));
    // `adminRequestId` reste le RACCOURCI du devis (relation `AdProItemQuoteRequest`, posée
    // avant le lien canonique) : on ne le LIT plus nulle part, mais l'écrire garde le
    // `onDelete: SetNull` utile et évite une migration de colonne pour rien.
    if (nature === "DEVIS") {
      await prisma.adProItem.update({ where: { id }, data: { adminRequestId: request.id, updatedById: user.id } });
      // LA LETTRE DE DEMANDE DE DEVIS (Direction, 07/10) — rédigée par Luna, PDF et Word sur papier en-tête, posée sur le
      // poste (étape « Demande de devis ») et sur la demande au secrétariat. Son échec ne retient pas la demande.
      await deposerLettreDevis(user, [{ entityType: "AD_PRO_ITEM", entityId: item.id }, { entityType: "ADMIN_REQUEST", entityId: request.id }], {
        titre: item.label, brief: null, reference: info.ref, societeId: info.companyId ?? null,
        articles: [{ designation: `${ITEM_KIND_LABELS[item.kind]} — ${item.label}`, quantite: null, unite: null, prestations: [], precision: note ?? null, produits: [] }],
      }).catch(() => null);
    }
    await notifyRoles(["DIRECTION_ASSISTANT", "SUPER_ADMIN"], {
      type: "ASSIGNMENT",
      title: `Demande de ${spec.libelle.toLowerCase()}`,
      body: `${request.reference} — ${item.label} (${info.ref})`,
      link: `/demandes/${request.id}`,
    }).catch(() => undefined);
    await audit(user, owner.parent, owner.id, "UPDATE", `Demande de ${spec.libelle.toLowerCase()} ${request.reference} ouverte pour le poste « ${item.label} ».`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/demandes");
    return { ok: true, id: request.id };
  } catch (err) {
    console.error("[ad-pro-item] demande de pièce impossible", err);
    return { ok: false, error: `La demande de ${spec.libelle.toLowerCase()} n'a pas pu être créée.` };
  }
}

/**
 * GÉNÉRER LA LETTRE DE DEMANDE DE DEVIS D'UN POSTE (Direction, 07/10) — sans passer par le secrétariat : le demandeur
 * l'envoie lui-même à ses agences. Rédigée par Luna, sur le papier en-tête de la société de l'opération, en PDF et Word,
 * déposée sous l'étape « Demande de devis » du poste. La précision saisie (`note`) guide la rédaction.
 */
export async function genererDemandeDevisPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const note = fdStr(formData, "note");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un devis, un bon de commande ou une facture");
  if (refusStock) return { ok: false, error: refusStock };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const r = await deposerLettreDevis(user, [{ entityType: "AD_PRO_ITEM", entityId: item.id }], {
    titre: item.label, brief: null, reference: info.ref, societeId: info.companyId ?? null,
    // La référence NNN/DG/AAAA (registre commun) : préremplie avec le prochain numéro ; modifiée, elle est vérifiée puis attribuée.
    referenceChoisie: saisieEffective(fdStr(formData, "reference"), fdStr(formData, "referenceSuggeree")),
    articles: [{ designation: `${ITEM_KIND_LABELS[item.kind]} — ${item.label}`, quantite: null, unite: null, prestations: [], precision: note ?? null, produits: [] }],
  });
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de devis${r.referenceRegistre ? ` N° ${r.referenceRegistre}` : ""} générée pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: phraseDepotLettre(r) };
}

/**
 * LA RÉFÉRENCE QUE PORTERA LA LETTRE DE DEMANDE DE DEVIS D'UN POSTE (registre commun NNN/DG/AAAA, Direction 10/2026) — ce que
 * le champ « Référence » du formulaire préremplit : la société de l'opération (sinon celle du rédacteur, comme la lettre), si
 * elle tient le registre, et son prochain numéro — PRÉVU, rien n'est réservé. Lecture seule.
 */
export async function referenceDemandeDevisPoste(formData: FormData): Promise<ReferenceProchaine> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const info = await PARENTS[found.owner.parent].load(found.owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  return etatDuRegistre(await societeDeLaLettre(user, info.companyId ?? null));
}

/** Référence d'une demande administrative — même forme que le module (DEM-année-n). */
async function nextAdminRequestRef(): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await prisma.administrativeRequest.findMany({
    where: { reference: { startsWith: `DEM-${year}-` } },
    select: { reference: true },
  });
  return buildRef("DEM", year, rows.map((r) => r.reference));
}

/**
 * L'ASSISTANTE QUI ÉTABLIT LE BC (§118.204) — celle que le formulaire désigne, sinon la seule assistante
 * de direction active. Plusieurs et aucune choisie : on ne choisit pas à la place du demandeur (§118.34),
 * le refus le dit. Lue AVANT toute écriture : un refus ne laisse pas un poste « demandé » sans assistante.
 */
async function assistanteDuBC(formData: FormData): Promise<{ id: string; name: string } | { error: string }> {
  const actives = await assistantesDeDirection();
  if (actives.length === 0) return { error: "Aucune assistante de direction active : demandez à l'administration d'en désigner une avant de demander le bon de commande." };
  const voulue = fdStr(formData, "assistantId");
  if (voulue === null) {
    if (actives.length === 1) return actives[0];
    return { error: "Choisissez l'assistante de direction qui établira le bon de commande." };
  }
  const trouvee = actives.find((a) => a.id === voulue);
  return trouvee ?? { error: "Cette personne n'est pas une assistante de direction active." };
}

/** Envoie (ou met à jour) la demande de pièce « bon de commande » chez l'assistante, et la prévient. */
async function envoyerDemandeBC(i: {
  item: { id: string; kind: AdProItemKind; label: string; supplier: string | null };
  owner: { parent: AdProParent; id: string };
  ref: string; montant: number | null; assistante: { id: string; name: string }; demandeurId: string; note: string | null;
}): Promise<string> {
  const contexte = [
    i.note,
    `Poste de l'opération ${i.ref}.`,
    i.item.supplier ? `Prestataire : ${i.item.supplier}.` : null,
    i.montant != null ? `Montant accordé : ${i.montant.toLocaleString("fr-FR")} DZD.` : null,
  ].filter(Boolean).join("\n");
  const d = await demanderBcAAssistante({
    itemId: i.item.id, assistantId: i.assistante.id, demandeurId: i.demandeurId,
    libelle: `Bon de commande — ${ITEM_KIND_LABELS[i.item.kind]} : ${i.item.label} (${i.ref})`,
    note: contexte, lien: lienPosteAdPro(i.owner.parent, i.owner.id, i.item.id),
  });
  await prisma.adProItem.update({ where: { id: i.item.id }, data: { bcAssistantId: i.assistante.id } });
  await notifyUser({
    userId: i.assistante.id, type: "ASSIGNMENT",
    title: d.creee ? "Bon de commande à établir" : "Demande de bon de commande modifiée",
    body: `${i.ref} — « ${i.item.label} »${i.note ? ` : « ${i.note.slice(0, 160)} »` : ""}`,
    link: `/pieces/${d.id}`,
  }).catch(() => undefined);
  revalidatePath("/pieces");
  return d.id;
}

// ───────────────────────── Bon de commande : demande → assistante → centre → signature ─────────────────────────

/**
 * DEMANDER LE BON DE COMMANDE d'un poste accordé (§118.204). La demande part chez l'ASSISTANTE DE
 * DIRECTION comme une demande de pièce : elle y dépose le BC, le demandeur le vérifie, et la pièce
 * REVIENT sur le poste (`classerDansLegal` → `rattacherPieceAuPoste`). Au-dessus du seuil, le centre
 * Ad & Pro vise la demande en parallèle (§118.148) ; la signature des Finances suit la pièce.
 *
 * Jusqu'ici, « Émettre le bon de commande » créait un ordre de dépense et rien d'autre : le BC que
 * l'assistante rédigeait dans une demande au secrétariat ne revenait jamais au poste.
 */
export async function requestAdProItemOrder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un bon de commande");
  if (refusStock) return { ok: false, error: refusStock };
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { ok: false, error: `Un sponsoring direct n'a pas de bon de commande : joignez la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} puis demandez le paiement (la facture n'est pas exigée).` };
  }
  const demande = await PARENTS[owner.parent].load(owner.id);
  if (!demande) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(demande);
  if (fermee) return { ok: false, error: fermee };
  const note = fdStr(formData, "note");
  const montantAccorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;

  // UNE DEMANDE D'AVANT LA RÈGLE (§118.204) : le poste est déjà « demandé » ou visé, mais son BC a été
  // demandé au secrétariat et ne reviendra jamais. On ENVOIE la demande de pièce, sans toucher au visa.
  if (item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK") {
    const ouverte = (await demandesBCDesPostes([id])).get(id);
    if (ouverte) return { ok: false, error: `La demande de bon de commande est déjà chez ${ouverte.assistante ?? "l'assistante de direction"}.` };
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: "Le bon de commande de ce poste est déjà établi." };
    const assistante = await assistanteDuBC(formData);
    if ("error" in assistante) return { ok: false, error: assistante.error };
    await envoyerDemandeBC({ item, owner, ref: demande.ref, montant: montantAccorde, assistante, demandeurId: user.id, note: note ?? item.orderNote });
    // L'ANCIENNE DEMANDE « BC À ÉTABLIR » AU BUREAU DU SECRÉTARIAT (audit du 04/10, constat 21) : la
    // demande de pièce la REMPLACE. Laissée ouverte, l'assistante avait deux demandes pour le même BC, et
    // déposer dans l'ancienne ne revenait jamais au poste. Elle se clôt par l'annulation commune, avec la
    // trace qui dit par quoi elle est remplacée — APRÈS l'envoi : si l'envoi échoue, l'ancienne reste.
    const anciennes = await cloreDemandesAuBureau(
      id, `le bon de commande se demande désormais à ${assistante.name} comme une pièce, qui reviendra sur le poste`, user, "BC_A_ETABLIR",
      "au profit de la demande de pièce",
    );
    await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande envoyée à ${assistante.name} pour le poste « ${item.label} »${anciennes.closes > 0 ? ` — l'ancienne demande au secrétariat est close` : ""}.`);
    revalidate(owner.parent, owner.id);
    return {
      ok: true, id,
      message: `Demande envoyée à ${assistante.name}, qui déposera le bon de commande.`
        + (anciennes.closes > 0 ? ` L'ancienne demande « ${TITRE_BC_A_ETABLIR} » au secrétariat est close.` : "")
        + (anciennes.reserve ? ` Attention : ${anciennes.reserve}` : ""),
    };
  }

  const check = canRequestPurchaseOrder({
    status: item.status, amountGranted: montantAccorde, budgetCategoryId: item.budgetCategoryId, orderStage: item.orderStage,
  });
  if (!check.ok) return { ok: false, error: check.reason ?? "Demande impossible." };
  const assistante = await assistanteDuBC(formData);
  if ("error" in assistante) return { ok: false, error: assistante.error };

  // LA MARCHE (`lireLaMarcheDuBC`, la règle partagée avec la génération) : l'écriture et la notification restent ICI, dans le corps.
  const { sousLeSeuil, seuilBC, where, data } = await lireLaMarcheDuBC({ itemId: item.id, montantAccorde: montantAccorde as number, userId: user.id, note, assistantId: assistante.id });
  const posee = await prisma.adProItem.updateMany({ where, data });
  if (posee.count === 0) return { ok: false, error: REFUS_MARCHE_PRISE };
  if (!sousLeSeuil) {
    await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], notificationDuCentreBC({ id: item.id, ref: demande.ref, label: item.label, montantAccorde: montantAccorde as number })).catch(() => undefined);
  }
  await envoyerDemandeBC({ item, owner, ref: demande.ref, montant: montantAccorde, assistante, demandeurId: user.id, note });
  await audit(user, owner.parent, owner.id, "UPDATE", sousLeSeuil
    ? `Bon de commande demandé à ${assistante.name} pour le poste « ${item.label} » — ${motifSousLeSeuil(seuilBC)}`
    : `Bon de commande demandé à ${assistante.name} pour le poste « ${item.label} » — en validation au centre Ad & Pro.`);
  revalidate(owner.parent, owner.id);
  if (!sousLeSeuil) revalidatePath("/centre-ad-pro");
  return {
    ok: true, id,
    message: sousLeSeuil
      ? `Demande envoyée à ${assistante.name}, qui déposera le bon de commande. ${motifSousLeSeuil(seuilBC)}`
      : `Demande envoyée à ${assistante.name}, qui déposera le bon de commande — le centre de validation Ad & Pro le vise en parallèle.`,
  };
}

/**
 * VISA DU CENTRE DE VALIDATION AD & PRO sur la demande d'émission — puis les Finances émettent.
 * Deux marches, parce que ce sont deux responsabilités : le centre engage, les Finances paient.
 *
 * ── POURQUOI LE CENTRE, ET PLUS « LA DIRECTION » ─────────────────────────────────────────
 *
 * « Concernant les BC, ils doivent tous passer soit par le centre de validation Ad&Pro si la
 * demande est depuis Ad&Pro, soit par le centre de validation normal » (Direction, 09/2026). Le
 * visa était donné par quiconque avait la vue globale ou VALIDATE sur le module — la Direction
 * des opérations, la Direction Marketing : aucun centre ne voyait passer ces BC. Il revient aux
 * SIÈGES du centre (`siegeAuCentreAdPro`), et le centre les LIT (`queries/ad-pro-centre.ts`) :
 * décider depuis la fiche ou depuis le centre appelle la MÊME action, avec la même garde.
 *
 * La note de la Direction a son PROPRE champ. Elle vivait dans `orderNote`, où le demandeur
 * avait écrit le contenu du bon de commande et ses références : chaque visa l'EFFAÇAIT, et
 * personne ne s'en apercevait — mesuré, la colonne avait trois écrivains et aucun lecteur.
 * L'assistante devait donc redemander à la main ce que le circuit avait déjà transporté.
 */
export async function approveAdProItemOrder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision") ?? "APPROVE";
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!siegeAuCentreAdPro(user)) return { ok: false, error: REFUS_BC_CENTRE_AD_PRO };
  if (item.orderStage !== "REQUESTED") return { ok: false, error: "Aucune demande d'émission en attente sur ce poste." };

  const note = fdStr(formData, "note");
  // CE QUE LE CENTRE A LU (§118.187) : l'écran envoie le montant qu'il affichait. Un montant relevé
  // pendant la lecture serait visé sans avoir été vu — le refus le dit, avec les deux chiffres. Sans
  // ce champ (un appelant qui ne l'envoie pas), rien n'est comparé ici ; l'empreinte, elle, est
  // toujours posée sur la valeur LUE, par une écriture conditionnelle.
  const montantVu = fdNum(formData, "montantVu");
  const montantActuel = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  if (montantVu != null && montantActuel != null && montantVu !== montantActuel) {
    return {
      ok: false,
      error: `Le montant de ce poste a changé pendant que vous lisiez (${montantVu.toLocaleString("fr-FR")} → ${montantActuel.toLocaleString("fr-FR")} DZD) : relisez la demande avant de la viser.`,
    };
  }
  // Le PRESTATAIRE lu, de même : c'est à lui que l'argent partira. Un champ absent n'est pas comparé.
  if (formData.has("prestataireVu") && !memePrestataire(fdStr(formData, "prestataireVu"), item.supplier)) {
    return {
      ok: false,
      error: `Le prestataire de ce poste a changé pendant que vous lisiez (désormais : ${item.supplier?.trim() || "le bénéficiaire de l'opération"}) : relisez la demande avant de la viser.`,
    };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  const lien = lienPosteAdPro(owner.parent, owner.id, item.id);
  const cible =`${info?.ref ?? ""} — « ${item.label} » (${toNumber(item.amountGranted!).toLocaleString("fr-FR")} DZD)`;
  const changee = "Cette demande vient de changer (retirée, déjà décidée, ou son montant ou son prestataire a bougé) : rouvrez la fiche.";
  if (decision === "REFUSE") {
    // UN REFUS SANS MOTIF EST UNE IMPASSE pour le demandeur — la règle du centre, ici aussi.
    // `=== null` et non `!note` : la dérivation des contrats lit `if (!v)` comme « champ
    // OBLIGATOIRE » pour toute l'action, et le motif n'est exigé que pour un REFUS — l'approbation
    // sans note deviendrait inappelable par le chemin générique (§118.87c, §118.138).
    if (note === null) return { ok: false, error: "Indiquez le motif du refus : sans lui, le demandeur ne sait pas quoi corriger." };
    const refuse = await prisma.adProItem.updateMany({
      where: { id, orderStage: "REQUESTED" },
      data: { orderStage: "REFUSED", orderDecisionNote: note, updatedById: user.id },
    });
    if (refuse.count === 0) return { ok: false, error: changee };
    await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande REFUSÉ par le centre de validation Ad & Pro pour « ${item.label} » — ${note}.`);
    if (item.orderRequestedById) {
      await notifyUser({
        userId: item.orderRequestedById, type: "VALIDATION_REQUIRED",
        title: "Bon de commande refusé par le centre Ad & Pro", body: `${cible} — ${note}`, link: lien,
      }).catch(() => undefined);
    }
    revalidate(owner.parent, owner.id);
    revalidatePath("/centre-ad-pro");
    return { ok: true, id };
  }

  // L'EMPREINTE DU VISA (§118.187) : le montant et le prestataire LUS — et l'écriture n'aboutit que
  // s'ils n'ont pas bougé depuis. Deux sièges qui visent ensemble, ou un retrait qui passe pendant le
  // visa, ne s'appliquent pas deux fois.
  const vise = await prisma.adProItem.updateMany({
    where: { id, orderStage: "REQUESTED", amountGranted: item.amountGranted, supplier: item.supplier },
    data: {
      orderStage: "DIRECTION_OK", orderDirectionAt: new Date(), orderDirectionById: user.id, orderDecisionNote: note,
      orderVisaAmount: item.amountGranted, orderVisaSupplier: item.supplier, updatedById: user.id,
    },
  });
  if (vise.count === 0) return { ok: false, error: changee };
  await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Bon de commande validé — à émettre",
    body: cible,
    link: lien,
  }).catch(() => undefined);
  if (item.orderRequestedById) {
    await notifyUser({
      userId: item.orderRequestedById, type: "GENERIC",
      title: "Bon de commande validé par le centre Ad & Pro", body: `${cible} — transmis aux Finances.`, link: lien,
    }).catch(() => undefined);
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande validé par le centre de validation Ad & Pro pour « ${item.label} » — transmis aux Finances.`);
  // LA PIÈCE EXISTE PEUT-ÊTRE DÉJÀ (§118.149) : l'assistante l'a établie pendant que le centre
  // tranchait. Le visa du poste EST sa porte (`PorteBC.source = "POSTE"`) — elle passe donc
  // maintenant à la signature des Finances, qui doivent le savoir. Une pièce qui n'existe pas
  // encore les préviendra elle-même en naissant (l'aiguillage lit alors un poste validé).
  const piecesDuPoste = await prisma.adProItemPiece.findMany({
    where: { itemId: id, nature: "BON_DE_COMMANDE" },
    select: { legalDocumentId: true },
  }).catch(() => []);
  for (const p of piecesDuPoste) {
    if (p.legalDocumentId) await signalerSiASigner(p.legalDocumentId).catch(() => false);
  }
  revalidate(owner.parent, owner.id);
  revalidatePath("/centre-ad-pro");
  if (piecesDuPoste.length > 0) revalidatePath(CHEMIN_BC_A_SIGNER);
  return { ok: true, id };
}

// ───────────────────── Corriger le bon de commande d'un poste (§118.187, audit R06, R12) ─────────────────────

/** Un refus levé DANS une transaction pour l'annuler entière, rattrapé à sa sortie pour devenir une phrase. */
class RefusPoste extends Error {}

/** Qui touche à la demande de BC d'un poste : qui décrit les postes, ou qui les arbitre. */
function peutToucherDemandeBC(user: SessionUser, parent: AdProParent): boolean {
  return canEditItems(user, parent) || canAllocate(user, parent);
}

/**
 * RETIRER LA DEMANDE D'ÉMISSION DU BON DE COMMANDE — en attente au centre, ou visée, tant qu'aucun
 * ordre n'est parti. Une demande envoyée ne se retirait pas : la seule issue était de supprimer le
 * poste (audit R06). Le « BC à établir » de l'assistante se clôt avec elle, motif à l'appui.
 */
export async function retirerDemandeBC(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!peutToucherDemandeBC(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.orderStage === "ISSUED" || item.expenseOrderId) {
    return { ok: false, error: "Le bon de commande a déjà été émis : annulez l'ordre de dépense (« Annuler l'ordre émis ») tant qu'il n'est pas réglé." };
  }
  if (item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK") {
    return { ok: false, error: "Aucune demande de bon de commande n'est en cours sur ce poste." };
  }
  // UN GESTE UNIQUE (audit du 04/10, constat 36) : le BC établi par l'assistante mais NON signé n'engage
  // encore personne — il s'annule au registre AVEC la demande. Signé par les Finances, ou suivi d'une
  // facture, la demande est exécutée : le refus le nomme (la même règle que la carte, §118.83). Tout ce
  // qui refuse passe AVANT le motif (§118.18).
  const bcs = (await bcVivantsDesPostes([id])).get(id) ?? [];
  const refusBc = refusAnnulationBcDuPoste(bcs);
  if (refusBc) return { ok: false, error: refusBc };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi vous annulez la demande : le motif reste à l'historique, et l'assistante le lit." };

  // TOUT OU RIEN, SOUS CONDITION : chaque BC n'est annulé que s'il n'a pas été signé (ni touché) depuis la
  // lecture — la signature des Finances écrit sur `updatedAt` lu, et cette annulation le change : des deux
  // gestes simultanés, un seul passe. Le poste revient sans demande de BC dans la même transaction.
  const changee = "Cette demande vient de changer (visée, émise, signée ou déjà annulée) : rouvrez la fiche.";
  const annules: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      for (const bc of bcs) {
        const annule = await annulerBcNonSigne(tx, bc.id, `demande de bon de commande du poste « ${item.label} » annulée — ${motif}`, user.id);
        if (!annule) throw new RefusPoste(changee);
        annules.push(bc.nom);
      }
      const r = await tx.adProItem.updateMany({
        where: { id, orderStage: { in: ["REQUESTED", "DIRECTION_OK"] }, expenseOrderId: null },
        data: {
          orderStage: "NONE", orderDirectionAt: null, orderDirectionById: null,
          orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null, updatedById: user.id,
        },
      });
      if (r.count === 0) throw new RefusPoste(changee);
    });
  } catch (e) {
    if (e instanceof RefusPoste) return { ok: false, error: e.message };
    throw e;
  }
  // Un BC annulé n'a plus rien à faire valider : sa porte en attente quitte le centre — et son journal le dit.
  for (const bc of bcs) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: bc.id,
      field: "status", newValue: "CANCELLED", summary: `Bon de commande ${bc.nom} annulé avec la demande du poste « ${item.label} » — ${motif}`,
    });
    await aiguillerBC(bc.id, { acteurId: user.id }).catch(() => undefined);
  }
  if (bcs.length > 0) { revalidatePath("/legal"); revalidatePath(CHEMIN_BC_A_SIGNER); }

  const info = await PARENTS[owner.parent].load(owner.id);
  const closes = await cloreDemandesSecretariat(id, `la demande de bon de commande du poste « ${item.label} » a été annulée — ${motif}`, user, "BC_A_ETABLIR");
  // Les Finances avaient reçu « à émettre » : sans ce message, elles chercheraient un BC qui n'existe plus.
  if (item.orderStage === "DIRECTION_OK") {
    await notifyRoles(FINANCES_BC, {
      type: "GENERIC", title: "Bon de commande retiré — ne pas l'émettre",
      body: `${info?.ref ?? ""} — « ${item.label} » : ${motif}`, link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(() => undefined);
  }
  // LE DEMANDEUR, quand c'est quelqu'un d'autre qui annule (qui tranche) : c'est sa demande qui s'arrête.
  if (item.orderRequestedById && item.orderRequestedById !== user.id) {
    await notifyUser({
      userId: item.orderRequestedById, type: "GENERIC", title: "Demande de bon de commande annulée",
      body: `${info?.ref ?? ""} — « ${item.label} »${annules.length ? ` (BC ${annules.join(", ")} annulé)` : ""} : ${motif}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(() => undefined);
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande ANNULÉE pour le poste « ${item.label} »${annules.length ? ` — BC ${annules.join(", ")} annulé au registre` : ""} — ${motif}`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/centre-ad-pro");
  return { ok: true, id, message: `Demande de bon de commande annulée${annules.length ? ` — le bon de commande ${annules.join(", ")}, non signé, est annulé au registre` : ""}.${phraseDemandesCloses(closes)}` };
}

/**
 * MODIFIER LA DEMANDE D'ÉMISSION — son message : références, quantités, coordonnées du fournisseur
 * (audit R06 : « impossible de retirer ou d'ajouter des références »). Le message ne change pas ce que
 * le centre a visé — le montant et le prestataire, eux, passent par la règle du visa. Le « BC à
 * établir » de l'assistante reçoit le nouveau message, et elle est prévenue.
 */
export async function modifierDemandeBC(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const note = fdStr(formData, "note");
  if (!note) return { ok: false, error: "Écrivez le contenu de la demande : références, quantités, coordonnées du fournisseur." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!peutToucherDemandeBC(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK") {
    return { ok: false, error: item.orderStage === "ISSUED" ? "Le bon de commande a déjà été émis : son message ne se modifie plus." : "Aucune demande de bon de commande n'est en cours sur ce poste." };
  }
  const r = await prisma.adProItem.updateMany({
    where: { id, orderStage: { in: ["REQUESTED", "DIRECTION_OK"] } },
    data: { orderNote: note, updatedById: user.id },
  });
  if (r.count === 0) return { ok: false, error: "Cette demande vient de changer (émise ou retirée) : rouvrez la fiche." };

  const info = await PARENTS[owner.parent].load(owner.id);
  const montant = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  // LA DEMANDE DE PIÈCE OUVERTE reçoit le nouveau message, chez la MÊME assistante (§118.204). Sans
  // demande ouverte (une pièce déjà déposée, ou une demande d'avant la règle), seul le poste change.
  const ouverte = await prisma.documentRequest.findFirst({
    where: { entityType: "AD_PRO_ITEM", entityId: id, kind: "PURCHASE_ORDER", status: { in: ["PENDING", "SUBMITTED", "DECLINED"] } },
    select: { askedToId: true, askedTo: { select: { name: true } } },
  });
  if (ouverte) {
    await envoyerDemandeBC({
      item, owner, ref: info?.ref ?? "", montant, assistante: { id: ouverte.askedToId, name: ouverte.askedTo?.name ?? "l'assistante" },
      demandeurId: item.orderRequestedById ?? user.id, note,
    });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande modifiée pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: ouverte ? "Demande de bon de commande mise à jour — l'assistante de direction est prévenue." : "Demande de bon de commande mise à jour." };
}

/**
 * ANNULER L'ORDRE ÉMIS, POUR LE RÉÉMETTRE — tant qu'il n'est pas réglé (audit R06). Un ordre parti au
 * mauvais prestataire ou au mauvais montant n'avait qu'une issue : supprimer le poste. L'annulation
 * passe par l'écrivain commun (`annulerOrdreNonRegle`, conditionnel : un règlement survenu entre-temps
 * ne se défait pas). Le poste revient à l'étape d'avant l'émission : visé s'il avait une demande de BC
 * — le visa tient pour ce qu'il a vu, et la règle du visa jugera la réémission —, sinon sans BC.
 */
export async function annulerOrdrePoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi l'ordre est annulé : le motif reste à l'historique de l'ordre et du poste." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  // LE DEMANDEUR ANNULE SA DEMANDE DE PAIEMENT tant qu'elle n'est pas réglée (décision du 04/10 :
  // « on peut annuler sa demande tant qu'elle n'a pas été exécutée ») — les Finances et qui arbitre,
  // comme avant. Un ordre réglé ne se défait pas : l'écrivain commun le refuse.
  const isFinance = userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE");
  if (!isFinance && !canAllocate(user, owner.parent) && !canEditItems(user, owner.parent)) {
    return { ok: false, error: "Seuls le demandeur, les Finances, ou qui arbitre ce module, annulent une demande de paiement." };
  }
  if (!item.expenseOrderId) return { ok: false, error: "Aucun ordre de dépense n'a été émis pour ce poste." };

  const annulation = await annulerOrdreNonRegle(item.expenseOrderId, { acteurId: user.id, motif: `poste « ${item.label} » — ${motif}` });
  if (!annulation.ok) return { ok: false, error: annulation.error };
  // LA FACTURE QUI A DEMANDÉ CE PAIEMENT (§118.204) part avec lui : laissée active et liée à un ordre
  // annulé, la demande suivante en déposait une SECONDE, et le poste portait deux factures pour un
  // seul paiement. Elle reste lisible, annulée, sur le poste.
  const facturesAnnulees = await prisma.legalDocument.updateMany({
    where: { kind: "INVOICE", expenseOrderId: item.expenseOrderId, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", updatedById: user.id },
  });
  const etape: AdProItemOrderStage = item.orderRequestedAt ? "DIRECTION_OK" : "NONE";
  await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: item.expenseOrderId },
    data: { expenseOrderId: null, orderStage: etape, updatedById: user.id },
  });
  const info = await PARENTS[owner.parent].load(owner.id);
  const prevenir = item.orderRequestedById ?? info?.requesterId ?? null;
  if (prevenir && prevenir !== user.id) {
    await notifyUser({
      userId: prevenir, type: "GENERIC", title: "Ordre de dépense annulé",
      body: `${info?.ref ?? ""} — « ${item.label} »${annulation.reference ? ` (${annulation.reference})` : ""} : ${motif}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(() => undefined);
  }
  await audit(user, owner.parent, owner.id, "UPDATE",
    `Ordre de dépense ${annulation.reference ?? ""} ANNULÉ pour le poste « ${item.label} » — ${motif} (réémission possible).`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/finances/paiements-a-faire");
  return {
    ok: true, id,
    message: `Ordre ${annulation.reference ?? ""} annulé${facturesAnnulees.count > 0 ? ", sa facture aussi" : ""} — le paiement pourra être redemandé avec une facture${etape === "DIRECTION_OK" ? " ; le visa du centre tient pour le montant et le prestataire qu'il a vus" : ""}.`,
  };
}

/**
 * DEMANDER À REVOIR UN POSTE ACCORDÉ (audit R12) — le demandeur rend SON poste à la Direction, motif
 * à l'appui et, s'il le faut, une nouvelle estimation (« le montant accordé ne suffit pas »). C'est un
 * geste qui RÉDUIT : il retire l'accord de son propre poste et n'accorde rien ; la Direction re-décide,
 * l'accord d'hier reste à l'historique. Tant qu'aucun ordre n'est parti — et une demande de BC en
 * cours se retire avec lui, sauf BC déjà établi dans Legal.
 */
export async function demanderRevisionPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites à la Direction ce qui doit être revu : c'est ce qu'elle lira." };
  const estimation = fdNum(formData, "amountEstimated");
  if (estimation != null && estimation <= 0) return { ok: false, error: "La nouvelle estimation doit être un montant positif." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.status !== "APPROVED") {
    return { ok: false, error: "Seul un poste accordé se rend à la Direction : un poste en brouillon, refusé ou à revoir se modifie et se resoumet." };
  }
  if (item.expenseOrderId || item.orderStage === "ISSUED") {
    return { ok: false, error: "Un ordre de dépense a été émis pour ce poste : les Finances l'annulent d'abord (« Annuler l'ordre émis »), puis la révision se demande." };
  }
  if (item.kind === "STOCK_MATERIAL") {
    return { ok: false, error: "Le matériel du stock se revoit par la Direction (« Revoir la décision ») : sa réservation suit sa décision." };
  }
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  if (bcEnCours) {
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: refusBcEtabli(bcs, "demandez la révision") };
  }
  const r = await prisma.adProItem.updateMany({
    where: { id, status: "APPROVED", expenseOrderId: null, orderStage: { not: "ISSUED" } },
    data: {
      status: "PENDING", submittedAt: new Date(), decisionNote: null, amountGranted: null,
      // Rendu pour révision, le poste repasse par les DEUX temps : l'accord d'hier ne couvre pas la
      // nouvelle estimation (§118.204). Sauf demande de la Direction des opérations (franchi d'office).
      opsDecidedAt: opsFranchiALaSoumission(await demandeurDe((await PARENTS[owner.parent].load(owner.id))?.requesterId)) ? new Date() : null,
      opsDecidedById: null, opsDecisionNote: null,
      ...(estimation != null ? { amountEstimated: estimation } : {}),
      ...(bcEnCours
        ? { orderStage: "NONE" as const, orderDirectionAt: null, orderDirectionById: null, orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null }
        : {}),
      updatedById: user.id,
    },
  });
  if (r.count === 0) return { ok: false, error: "Ce poste vient de changer (émis, ou sa décision a été revue) : rouvrez la fiche." };
  const ancien = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  await recordDecision(id, "PENDING", `Révision demandée par le demandeur : ${motif}`, estimation ?? ancien, user.id);
  await reprojeterMontantDemande(owner.parent, owner.id);
  const closes = bcEnCours
    ? await cloreDemandesSecretariat(id, `le poste « ${item.label} » est rendu à la Direction pour révision — la demande de bon de commande est retirée`, user, "BC_A_ETABLIR")
    : 0;
  const info = await PARENTS[owner.parent].load(owner.id);
  const demandeur = await demandeurDe(info?.requesterId);
  await prevenirLeTemps(
    opsFranchiALaSoumission(demandeur) ? "MARKETING" : "OPERATIONS", demandeur, "Poste accordé — révision demandée",
    `${info?.ref ?? "Opération"} — « ${item.label} »${estimation != null ? ` (nouvelle estimation : ${estimation.toLocaleString("fr-FR")} DZD)` : ""} : ${motif}`,
    lienPosteAdPro(owner.parent, owner.id, item.id),
  );
  await audit(user, owner.parent, owner.id, "UPDATE",
    `Révision demandée sur le poste accordé « ${item.label} »${ancien != null ? ` (accordé ${ancien.toLocaleString("fr-FR")} DZD)` : ""} — ${motif}${bcEnCours ? " — demande de bon de commande retirée" : ""}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Poste rendu à la Direction pour révision.${phraseDemandesCloses(closes)}` };
}

// ─────────────────────── Le matériel du stock d'un événement (§118.167) ───────────────────────

/** Un poste « Matériel du stock » se compose tant qu'il n'est ni soumis ni accordé. */
const POSTE_STOCK_EDITABLE = new Set<AdProItemStatus>(["DRAFT", "REVISION", "REJECTED"]);

/** Le libellé lisible d'un article du stock (« Fiche posologique — Nivolex »). */
async function libellesArticles(ids: readonly string[]): Promise<Map<string, { libelle: string; famille: PromoFamille }>> {
  if (ids.length === 0) return new Map();
  const items = await prisma.promoStockItem.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      catalogue: { select: { nom: true, famille: true } },
      produits: { select: { product: { select: { canonicalName: true } } } },
    },
  });
  return new Map(items.map((it) => [it.id, {
    libelle: libelleArticleStock(it.catalogue.nom, it.produits.map((p) => p.product.canonicalName)),
    famille: it.catalogue.famille as PromoFamille,
  }]));
}

/**
 * LA DÉCISION D'UN POSTE « MATÉRIEL DU STOCK » — la réservation (ou sa restitution) et la décision
 * s'écrivent ENSEMBLE, sous le verrou de chaque article. Au-delà de ce que le magasin a de
 * distribuable, l'accord est refusé en entier, ligne nommée : rien n'est accordé, rien n'est réservé.
 */
async function deciderMaterielStock(
  itemId: string,
  status: AdProItemStatus,
  auteurId: string,
  ecrireDecision: (client: Tx) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lignes = await prisma.adProStockLine.findMany({
    where: { itemId },
    select: { id: true, stockItemId: true, quantite: true, statut: true },
  });
  if (lignes.some((l) => l.statut === "CONFIRMEE")) {
    return { ok: false, error: "Le matériel de ce poste a déjà été confirmé après l'événement : sa décision ne peut plus changer." };
  }
  if (status === "APPROVED" && lignes.length === 0) {
    return { ok: false, error: "Ce poste ne liste aucun article du stock : il n'y a rien à accorder." };
  }
  const libelles = await libellesArticles(lignes.map((l) => l.stockItemId));
  const motif = "Réservé pour l'événement (poste « Matériel du stock » accordé)";
  class Refus extends Error {}
  try {
    await sousVerrous(lignes.map((l) => l.stockItemId), async (tx) => {
      // RELIRE SOUS LE VERROU : un autre accord du même poste a pu passer entre-temps.
      const actuelles = await tx.adProStockLine.findMany({ where: { itemId }, select: { id: true, stockItemId: true, quantite: true, statut: true } });
      if (status === "APPROVED") {
        for (const l of actuelles.filter((x) => x.statut === "DEMANDEE")) {
          const q = toNumber(l.quantite);
          const r = await reserverPourEvenement(tx, l.stockItemId, { ligneId: l.id, quantite: q, motif, auteurId, maintenant: new Date() });
          if (!r.ok) throw new Refus(refusReservation(libelles.get(l.stockItemId)?.libelle ?? "Article", q, r.refus));
          await tx.adProStockLine.update({ where: { id: l.id }, data: { statut: "RESERVEE", reserveeLe: new Date(), reserveeParId: auteurId } });
        }
      } else {
        for (const l of actuelles.filter((x) => x.statut === "RESERVEE")) {
          await rendreAuMagasin(tx, l.stockItemId, { ligneId: l.id, quantite: toNumber(l.quantite), motif: `Poste ${status === "REJECTED" ? "refusé" : "à revoir"} : la réservation revient au magasin`, auteurId });
          await tx.adProStockLine.update({ where: { id: l.id }, data: { statut: "DEMANDEE", reserveeLe: null, reserveeParId: null } });
        }
      }
      await ecrireDecision(tx);
    });
  } catch (e) {
    if (e instanceof Refus) return { ok: false, error: e.message };
    throw e;
  }
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true };
}

/**
 * AJOUTER (OU REQUANTIFIER) UN ARTICLE DU STOCK SUR LE POSTE. Le demandeur pioche dans le MAGASIN
 * de la société de l'opération ; rien ne bouge au magasin avant l'accord. Une quantité à zéro
 * retire l'article. Un support numérique n'a pas de quantité : il ne se réserve pas.
 */
export async function ajouterArticleStockAuPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  const stockItemId = fdStr(formData, "stockItemId");
  if (!itemId || !stockItemId) return { ok: false, error: "Choisissez l'article du stock." };
  const quantite = fdNum(formData, "quantite");
  if (quantite == null || !Number.isFinite(quantite) || quantite < 0) return { ok: false, error: "Indiquez une quantité (0 pour retirer l'article)." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const clos = refusPostesClos(info);
  if (clos) return { ok: false, error: clos };
  if (item.kind !== "STOCK_MATERIAL") return { ok: false, error: "Ce poste n'est pas un poste « Matériel du stock »." };
  if (!POSTE_STOCK_EDITABLE.has(item.status)) {
    return { ok: false, error: item.status === "APPROVED"
      ? "Ce poste est accordé et son matériel réservé : sa liste ne change plus (la Direction peut le remettre « à revoir »)."
      : "Ce poste attend la décision de la Direction : sa liste ne change pas pendant ce temps." };
  }
  const article = await articleDansMonPerimetre(user.id, stockItemId);
  if (!article || !article.isActive) return { ok: false, error: "Article du stock introuvable ou archivé." };
  if (!familleQuantifiee(article.catalogue.famille as PromoFamille)) return { ok: false, error: "Un support numérique se présente, il ne se réserve pas." };
  if (info.companyId && article.companyId && article.companyId !== info.companyId) {
    return { ok: false, error: "Cet article appartient au magasin d'une autre société que celle de l'opération." };
  }
  const libelle = libelleArticleStock(article.catalogue.nom, article.produits.map((p) => p.product.canonicalName));
  if (quantite === 0) {
    await prisma.adProStockLine.deleteMany({ where: { itemId, stockItemId, statut: "DEMANDEE" } });
  } else {
    await prisma.adProStockLine.upsert({
      where: { itemId_stockItemId: { itemId, stockItemId } },
      create: { itemId, stockItemId, quantite, createdById: user.id },
      update: { quantite },
    });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", quantite === 0
    ? `Poste « ${item.label} » : « ${libelle} » retiré du matériel demandé.`
    : `Poste « ${item.label} » : ${quantite.toLocaleString("fr-FR")} « ${libelle} » demandé(s) au magasin.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: itemId };
}

/**
 * CONFIRMER LE MATÉRIEL APRÈS L'ÉVÉNEMENT (§118.167). Un consommable : combien ont été remis (le
 * reste revient). Un durable PRÊTÉ : combien sont rendus, abîmés, perdus — la somme doit faire le
 * compte réservé. Tout ce qui ne va pas est dit en une fois ; sinon le reste revient au magasin par
 * la même écriture, dans les lots d'où il était sorti, et la magasinière en est prévenue.
 *
 * Confirmer « 0 remis » avant l'événement est aussi la façon d'annuler une réservation.
 * Qui confirme : le demandeur (il a tenu l'événement), la gestionnaire du magasin (elle reçoit le
 * retour), la Direction qui décide des postes, ou le Super Admin.
 */
export async function confirmerMaterielStock(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (item.kind !== "STOCK_MATERIAL") return { ok: false, error: "Ce poste n'est pas un poste « Matériel du stock »." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const gestionnaires = await gestionnairesDuMagasin();
  const peut = peutConfirmerMateriel({
    superAdmin: user.role === "SUPER_ADMIN",
    estLeDemandeur: info.requesterId === user.id,
    gereLeMagasin: gestionnaires.includes(user.id),
    decideLesPostes: canAllocate(user, owner.parent),
  });
  if (!peut) return { ok: false, error: REFUS_CONFIRMATION_MATERIEL };

  const lignes = await prisma.adProStockLine.findMany({ where: { itemId, statut: "RESERVEE" }, select: { id: true, stockItemId: true, quantite: true } });
  if (lignes.length === 0) return { ok: false, error: "Aucun matériel réservé n'attend de confirmation sur ce poste." };
  const libelles = await libellesArticles(lignes.map((l) => l.stockItemId));
  const ids = formData.getAll("ligneId").map(String);
  const champ = (nom: string, i: number) => formData.getAll(nom)[i];
  const fautes: string[] = [];
  const decisions = new Map<string, Confirmation>();
  for (const l of lignes) {
    const i = ids.indexOf(l.id);
    const meta = libelles.get(l.stockItemId);
    const libelle = meta?.libelle ?? "Article";
    if (i < 0) { fautes.push(`« ${libelle} » : rien n'est déclaré`); continue; }
    const r = lireConfirmation(meta?.famille ?? "CONSOMMABLE", toNumber(l.quantite), {
      utilisee: champ("utilisee", i), rendue: champ("rendue", i), abimee: champ("abimee", i), perdue: champ("perdue", i),
    }, libelle);
    if (!r.ok) fautes.push(r.faute);
    else decisions.set(l.id, r.confirmation);
  }
  if (fautes.length) return { ok: false, error: `Confirmation à revoir : ${fautes.join(" ; ")}.` };

  const note = fdStr(formData, "note");
  let revenu = 0;
  const fait = await sousVerrous(lignes.map((l) => l.stockItemId), async (tx) => {
    // CONDITIONNEL : deux confirmations simultanées ne font revenir le reste qu'une fois.
    let n = 0;
    for (const l of lignes) {
      const c = decisions.get(l.id)!;
      const maj = await tx.adProStockLine.updateMany({
        where: { id: l.id, statut: "RESERVEE" },
        data: {
          statut: "CONFIRMEE", utilisee: c.utilisee, rendue: c.rendue, abimee: c.abimee, perdue: c.perdue,
          confirmeeLe: new Date(), confirmeeParId: user.id, note,
        },
      });
      if (maj.count === 0) continue;
      n += 1;
      revenu += await rendreAuMagasin(tx, l.stockItemId, { ligneId: l.id, quantite: c.retour, motif: `Retour de l'événement — ${info.ref}`, auteurId: user.id });
    }
    return n;
  });
  if (fait === 0) return { ok: false, error: "Ce matériel a déjà été confirmé entre-temps : rechargez la fiche." };

  if (revenu > 0) {
    for (const g of gestionnaires.filter((g) => g !== user.id)) {
      await notifyUser({
        userId: g, type: "GENERIC", title: "Matériel revenu d'un événement",
        body: `${info.ref} — ${revenu.toLocaleString("fr-FR")} unité(s) reviennent au magasin.`,
        link: lienStockPromo("magasin"),
      }).catch(() => undefined);
    }
  }
  const resume = [...decisions].map(([id, c]) => {
    const l = lignes.find((x) => x.id === id)!;
    const lib = libelles.get(l.stockItemId)?.libelle ?? "Article";
    return c.utilisee != null
      ? `${lib} : ${c.utilisee.toLocaleString("fr-FR")} remis, ${c.retour.toLocaleString("fr-FR")} revenu(s)`
      : `${lib} : ${c.rendue.toLocaleString("fr-FR")} rendu(s), ${(c.abimee ?? 0).toLocaleString("fr-FR")} abîmé(s), ${(c.perdue ?? 0).toLocaleString("fr-FR")} perdu(s)`;
  }).join(" ; ");
  await audit(user, owner.parent, owner.id, "UPDATE", `Matériel du stock confirmé — poste « ${item.label} » : ${resume}${note ? ` (${note})` : ""}.`);
  revalidate(owner.parent, owner.id);
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true, id: itemId, message: revenu > 0 ? `Matériel confirmé : ${revenu.toLocaleString("fr-FR")} unité(s) reviennent au magasin.` : "Matériel confirmé : rien ne revient au magasin." };
}

// ───────────────────────── Billetterie : voyageurs et réservation (§118.175) ─────────────────────────

/** Le poste « billetterie » d'un voyageur, avec son opération — le point d'entrée des actions par voyageur. */
async function chargerVoyageur(id: string, user: SessionUser) {
  const v = await prisma.adProVoyageur.findUnique({
    where: { id },
    select: { id: true, itemId: true, nom: true, prenom: true, segments: true, villeDepart: true, villeArrivee: true, dateDepart: true, dateRetour: true, notes: true, trajet: true, transport: true },
  });
  if (!v) return null;
  const found = await loadItem(v.itemId, user);
  return found ? { voyageur: v, ...found } : null;
}

/** Les étapes telles qu'elles sont en base — illisibles ou absentes, il n'y en a pas (jamais une étape devinée). */
function etapesEnBase(json: unknown) {
  const lues = lireEtapes(json);
  return lues.ok ? lues.etapes : [];
}

/** Ce que l'écriture d'un voyageur lu pose en base — les étapes en JSON. */
const donneesVoyageur = (v: VoyageurLu) => ({ ...v, segments: v.segments as unknown as import("@prisma/client").Prisma.InputJsonValue });

/** La ligne d'un voyageur telle qu'il est en base — ce que `changementsVoyageur` compare. */
const voyageurLu = (v: Omit<VoyageurLu, "segments" | "prenom"> & { prenom?: string | null; segments?: unknown }): VoyageurLu => ({
  nom: v.nom, prenom: v.prenom ?? null, segments: etapesEnBase(v.segments), villeDepart: v.villeDepart, villeArrivee: v.villeArrivee, dateDepart: v.dateDepart, dateRetour: v.dateRetour, notes: v.notes,
  trajet: v.trajet, transport: v.transport,
});

/**
 * UN CHANGEMENT APRÈS LA DEMANDE DE RÉSERVATION SE DIT DANS LE SUJET — « on modifie les dates
 * plus tard ». Sans cette ligne, l'assistante réserverait sur les dates d'avant, et la flexibilité
 * demandée se paierait en billets à changer. Rend la phrase à ajouter au message de l'action.
 */
async function signalerAuSujet(item: { id: string }, auteurId: string, corps: string): Promise<string> {
  const poste = await prisma.adProItem.findUnique({ where: { id: item.id }, select: { reservationDossierId: true, label: true } });
  if (!poste?.reservationDossierId) return "";
  const ecrit = await ecrireDansLeSujet({ dossierId: poste.reservationDossierId, authorId: auteurId, body: `${poste.label} — ${corps}` });
  return ecrit ? " L'assistante est prévenue dans le sujet de réservation." : " Le sujet de réservation n'existe plus : redemandez la réservation pour le rouvrir.";
}

/**
 * AJOUTER UN VOYAGEUR à un poste « billetterie ». Un NOM suffit : on prend en charge un médecin
 * avant de savoir quand il part. Ce n'est pas un arbitrage, c'est une précision d'exécution —
 * donc offert aussi sur une demande clôturée, comme le bon de commande.
 */
export async function ajouterVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » porte des voyageurs." };

  const lu = lireVoyageur({
    nom: fdStr(formData, "nom"), prenom: fdStr(formData, "prenom"), segments: fdStr(formData, "segments"), villeDepart: fdStr(formData, "villeDepart"), villeArrivee: fdStr(formData, "villeArrivee"),
    dateDepart: fdStr(formData, "dateDepart"), dateRetour: fdStr(formData, "dateRetour"), notes: fdStr(formData, "notes"),
    trajet: fdStr(formData, "trajet"), transport: fdStr(formData, "transport"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const last = await prisma.adProVoyageur.findFirst({ where: { itemId }, orderBy: { position: "desc" }, select: { position: true } });
  const cree = await prisma.adProVoyageur.create({
    data: { itemId, ...donneesVoyageur(lu.voyageur), position: (last?.position ?? 0) + 1, createdById: user.id, updatedById: user.id },
    select: { id: true },
  });
  // LE PASSEPORT ET LES AUTRES DOCUMENTS, JOINTS DÈS LA CRÉATION (Direction, 06/10) — rangés comme ceux qu'on joint
  // ensuite : des documents du poste, à l'étape du voyageur (`stepKey`), le passeport en pièce d'identité.
  const pieces: { file: File; category: "ID_DOCUMENT" | "SUPPORTING_DOC" }[] = [
    ...formData.getAll("passeport").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "ID_DOCUMENT" as const })),
    ...formData.getAll("documents").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "SUPPORTING_DOC" as const })),
  ];
  const echecs: string[] = [];
  let passeport = false;
  if (pieces.length > 0) {
    const refus = await validateAttachments(pieces.map((p) => p.file));
    if (refus) echecs.push(refus);
    else {
      for (const p of pieces) {
        const r = await persistUploadedDocument(user.id, {
          entityType: "AD_PRO_ITEM", entityId: itemId, category: p.category, confidentiality: "INTERNAL", stepKey: cree.id, file: p.file,
        }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
        if (r.ok) passeport ||= p.category === "ID_DOCUMENT";
        else echecs.push(`${p.file.name} : ${r.error ?? "dépôt impossible"}`);
      }
    }
  }
  const sujet = await signalerAuSujet(item, user.id, `voyageur ajouté :\n${ligneVoyageur({ ...lu.voyageur, passeport })}`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(lu.voyageur)} » ajouté au poste « ${item.label} »${pieces.length > 0 ? ` — ${pieces.length - echecs.length} document(s) joint(s)` : ""}.`);
  revalidate(owner.parent, owner.id);
  const joints = pieces.length - echecs.length;
  return {
    ok: true, id: cree.id,
    message: `Voyageur ajouté${joints > 0 ? ` avec ${joints} document${joints > 1 ? "s" : ""}${passeport ? " (passeport compris)" : ""}` : ""}.${echecs.length > 0 ? ` Non joint : ${echecs.join(" ; ")} — joignez-le depuis la ligne du voyageur.` : ""}${sujet}`,
  };
}

/**
 * MODIFIER UN VOYAGEUR — seules les clés PRÉSENTES s'écrivent (§118.152c) : corriger une date ne
 * doit pas effacer le trajet qu'un formulaire partiel n'a pas renvoyé.
 */
export async function modifierVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(id, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const saisie: SaisieVoyageur = {
    nom: formData.has("nom") ? fdStr(formData, "nom") : v.nom,
    prenom: formData.has("prenom") ? fdStr(formData, "prenom") : v.prenom,
    segments: formData.has("segments") ? fdStr(formData, "segments") : v.segments,
    villeDepart: formData.has("villeDepart") ? fdStr(formData, "villeDepart") : v.villeDepart,
    villeArrivee: formData.has("villeArrivee") ? fdStr(formData, "villeArrivee") : v.villeArrivee,
    dateDepart: formData.has("dateDepart") ? fdStr(formData, "dateDepart") : jour(v.dateDepart),
    dateRetour: formData.has("dateRetour") ? fdStr(formData, "dateRetour") : jour(v.dateRetour),
    notes: formData.has("notes") ? fdStr(formData, "notes") : v.notes,
    // Un trajet passé en ALLER SIMPLE vide la date de retour, même si le formulaire ne la porte pas.
    trajet: formData.has("trajet") ? fdStr(formData, "trajet") : v.trajet,
    transport: formData.has("transport") ? fdStr(formData, "transport") : v.transport,
  };
  const lu = lireVoyageur(saisie);
  if (!lu.ok) return { ok: false, error: lu.error };
  const changements = changementsVoyageur(voyageurLu(v), lu.voyageur);
  if (changements.length === 0) return { ok: true, id, message: "Rien n'a changé." };

  await prisma.adProVoyageur.update({ where: { id }, data: { ...donneesVoyageur(lu.voyageur), updatedById: user.id } });
  const sujet = await signalerAuSujet(item, user.id, `voyageur modifié — ${nomComplet(v)} : ${changements.join(" ; ")}`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(v)} » du poste « ${item.label} » modifié — ${changements.join(" ; ")}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Voyageur modifié.${sujet}` };
}

/**
 * RETIRER UN VOYAGEUR. Son passeport, s'il a été déposé, RESTE parmi les pièces du poste : une
 * pièce jointe ne s'efface pas en silence avec la ligne qui la désignait — elle se retire depuis
 * son aperçu, comme toute pièce.
 */
export async function retirerVoyageur(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(id, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  // SES DEVIS RESTENT DES DEVIS DU POSTE (§118.205) : seul le lien « pour ce voyageur » part avec lui.
  const devis = await prisma.adProVoyageurDevis.count({ where: { voyageurId: id } });
  await prisma.adProVoyageur.delete({ where: { id } });
  const sujet = await signalerAuSujet(item, user.id, `voyageur retiré : ${nomComplet(v)}.`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(v)} » retiré du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: `Voyageur retiré.${devis > 0 ? ` Son devis reste sur le poste (case « Devis / pro forma »).` : ""}${sujet}` };
}

// ───────────────────────── Hôtellerie : une fiche par personne logée (Direction, 06/10) ─────────────────────────

/** Le poste « hôtellerie » d'une fiche, avec son opération — le point d'entrée des actions par fiche. */
async function chargerHebergement(id: string, user: SessionUser) {
  const h = await prisma.adProHebergement.findUnique({
    where: { id },
    select: { id: true, itemId: true, nom: true, prenom: true, hotel: true, ville: true, dateArrivee: true, dateDepart: true, typeChambre: true, notes: true },
  });
  if (!h) return null;
  const found = await loadItem(h.itemId, user);
  return found ? { hebergement: h, ...found } : null;
}

const hebergementLu = (h: HebergementLu): HebergementLu => ({
  nom: h.nom, prenom: h.prenom, hotel: h.hotel, ville: h.ville, dateArrivee: h.dateArrivee, dateDepart: h.dateDepart, typeChambre: h.typeChambre, notes: h.notes,
});

/**
 * AJOUTER UNE FICHE HÔTELLERIE à un poste « hôtellerie » — « une fiche hôtellerie pour chaque
 * personne ». Un NOM suffit ; la pièce d'identité et les autres documents se joignent dès la
 * création, rangés comme ceux d'un voyageur (documents du poste, `stepKey` = la fiche). Offert
 * aussi sur une demande clôturée : c'est une précision d'exécution, pas un arbitrage.
 */
export async function ajouterHebergement(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesHebergements(item.kind)) return { ok: false, error: "Seul un poste « hôtellerie » porte des fiches hôtellerie." };

  const lu = lireHebergement({
    nom: fdStr(formData, "nom"), prenom: fdStr(formData, "prenom"), hotel: fdStr(formData, "hotel"), ville: fdStr(formData, "ville"),
    dateArrivee: fdStr(formData, "dateArrivee"), dateDepart: fdStr(formData, "dateDepart"), typeChambre: fdStr(formData, "typeChambre"), notes: fdStr(formData, "notes"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const last = await prisma.adProHebergement.findFirst({ where: { itemId }, orderBy: { position: "desc" }, select: { position: true } });
  const cree = await prisma.adProHebergement.create({
    data: { itemId, ...lu.hebergement, position: (last?.position ?? 0) + 1, createdById: user.id, updatedById: user.id },
    select: { id: true },
  });
  const pieces: { file: File; category: "ID_DOCUMENT" | "SUPPORTING_DOC" }[] = [
    ...formData.getAll("pieceIdentite").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "ID_DOCUMENT" as const })),
    ...formData.getAll("documents").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "SUPPORTING_DOC" as const })),
  ];
  const echecs: string[] = [];
  let piece = false;
  if (pieces.length > 0) {
    const refus = await validateAttachments(pieces.map((p) => p.file));
    if (refus) echecs.push(refus);
    else {
      for (const p of pieces) {
        const r = await persistUploadedDocument(user.id, {
          entityType: "AD_PRO_ITEM", entityId: itemId, category: p.category, confidentiality: "INTERNAL", stepKey: cree.id, file: p.file,
        }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
        if (r.ok) piece ||= p.category === "ID_DOCUMENT";
        else echecs.push(`${p.file.name} : ${r.error ?? "dépôt impossible"}`);
      }
    }
  }
  const joints = pieces.length - echecs.length;
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(lu.hebergement)} » ajoutée au poste « ${item.label} »${pieces.length > 0 ? ` — ${joints} document(s) joint(s)` : ""}.`);
  revalidate(owner.parent, owner.id);
  return {
    ok: true, id: cree.id,
    message: `Fiche hôtellerie ajoutée${joints > 0 ? ` avec ${joints} document${joints > 1 ? "s" : ""}${piece ? " (pièce d'identité comprise)" : ""}` : ""}.${echecs.length > 0 ? ` Non joint : ${echecs.join(" ; ")} — joignez-le depuis la fiche.` : ""}`,
  };
}

/** MODIFIER UNE FICHE HÔTELLERIE — seules les clés PRÉSENTES s'écrivent (§118.152c). */
export async function modifierHebergement(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche hôtellerie non précisée." };
  const found = await chargerHebergement(id, user);
  if (!found) return { ok: false, error: "Fiche hôtellerie introuvable." };
  const { hebergement: h, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  // SEULES LES CLÉS PRÉSENTES S'ÉCRIVENT (§118.152c) — chaque champ nommé en clair, pour que le contrat des actions le lise.
  const lu = lireHebergement({
    nom: formData.has("nom") ? fdStr(formData, "nom") : h.nom,
    prenom: formData.has("prenom") ? fdStr(formData, "prenom") : h.prenom,
    hotel: formData.has("hotel") ? fdStr(formData, "hotel") : h.hotel,
    ville: formData.has("ville") ? fdStr(formData, "ville") : h.ville,
    dateArrivee: formData.has("dateArrivee") ? fdStr(formData, "dateArrivee") : jour(h.dateArrivee),
    dateDepart: formData.has("dateDepart") ? fdStr(formData, "dateDepart") : jour(h.dateDepart),
    typeChambre: formData.has("typeChambre") ? fdStr(formData, "typeChambre") : h.typeChambre,
    notes: formData.has("notes") ? fdStr(formData, "notes") : h.notes,
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const changements = changementsHebergement(hebergementLu(h), lu.hebergement);
  if (changements.length === 0) return { ok: true, id, message: "Rien n'a changé." };

  await prisma.adProHebergement.update({ where: { id }, data: { ...lu.hebergement, updatedById: user.id } });
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(h)} » du poste « ${item.label} » modifiée — ${changements.join(" ; ")}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: "Fiche hôtellerie modifiée." };
}

/**
 * RETIRER UNE FICHE HÔTELLERIE. Sa pièce d'identité, si elle a été déposée, RESTE parmi les pièces
 * du poste — comme le passeport d'un voyageur retiré : elle se retire depuis son aperçu.
 */
export async function retirerHebergement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche hôtellerie non précisée." };
  const found = await chargerHebergement(id, user);
  if (!found) return { ok: false, error: "Fiche hôtellerie introuvable." };
  const { hebergement: h, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  await prisma.adProHebergement.delete({ where: { id } });
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(h)} » retirée du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: "Fiche hôtellerie retirée." };
}

/**
 * DEMANDER LA RÉSERVATION des billets d'un poste — « les demandes de réservation vont à
 * l'assistante de direction et ouvrent un sujet ».
 *
 * Le sujet est le lieu de l'échange (« l'Ibis est complet, je prends le Sofitel ? ») : il naît lié
 * à la DEMANDE, donc il remonte en bas de sa fiche, à l'endroit où le demandeur le suit. Une
 * seconde demande sur le même poste écrit dans le MÊME sujet, avec la liste à jour : deux sujets
 * pour les mêmes billets se contrediraient.
 *
 * Pas de garde sur l'accord du poste : pour obtenir un devis, l'agence a besoin des noms et des
 * dates. Mais la phrase DIT où en est le poste — réserver un billet que la Direction n'a pas
 * accordé engagerait la société sur une dépense que personne n'a décidée. Un poste REFUSÉ, lui,
 * ne se réserve pas.
 */
export async function demanderReservation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » se réserve." };
  if (item.status === "REJECTED") return { ok: false, error: "Ce poste a été refusé par la Direction : on ne réserve pas de billets pour lui." };

  const voyageurs = await prisma.adProVoyageur.findMany({ where: { itemId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  if (voyageurs.length === 0) return { ok: false, error: "Ajoutez au moins un voyageur (son nom suffit) avant de demander la réservation." };
  const piecesPasseport = await prisma.document.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: id, stepKey: { in: voyageurs.map((v) => v.id) } },
    select: { id: true, stepKey: true, category: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  // Le PASSEPORT est la pièce d'identité du voyageur ; ses autres documents (visa, assurance…) se listent à part.
  const passeports = new Set(piecesPasseport.filter((d) => String(d.category) === "ID_DOCUMENT").map((d) => d.stepKey));
  const lignes = voyageurs.map((v) => ligneVoyageur({ ...voyageurLu(v), passeport: passeports.has(v.id) }));
  // LE PASSEPORT, PAS SEULEMENT SA MENTION (audit 360°, I10) : « passeport joint » sans lien obligeait
  // l'assistante à le chercher là où elle n'entre pas. Le lien s'ouvre aux personnes du sujet
  // (`peutLirePasseportDuSujet`), et à elles seules parmi celles qui n'ont pas l'opération.
  const nomDuVoyageur = new Map(voyageurs.map((v) => [v.id, nomComplet(v)]));
  const liensPasseport = piecesPasseport.map((d) => `• ${nomDuVoyageur.get(d.stepKey ?? "") ?? "voyageur"} — ${String(d.category) === "ID_DOCUMENT" ? "passeport" : d.name} — /api/documents/${d.id}`);

  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const etat = item.status === "APPROVED"
    ? "Poste ACCORDÉ par la Direction — vous pouvez réserver."
    : `Poste pas encore accordé (${ITEM_STATUS_LABELS[item.status].label.toLowerCase()}) — préparez le devis ; ne réservez qu'après l'accord.`;
  const corps = [
    `Demande ${info.ref} — poste « ${item.label} ».`,
    etat,
    `Voyageurs (${voyageurs.length}) :`,
    ...lignes,
    ...(liensPasseport.length ? ["Passeports :", ...liensPasseport] : []),
    `Fiche de l'opération (demandeur) : ${PARENTS[owner.parent].path}/${owner.id}`,
  ].join("\n");

  const poste = await prisma.adProItem.findUnique({ where: { id }, select: { reservationDossierId: true } });
  if (poste?.reservationDossierId && await ecrireDansLeSujet({ dossierId: poste.reservationDossierId, authorId: user.id, body: `Demande de réservation mise à jour.\n${corps}` })) {
    await audit(user, owner.parent, owner.id, "UPDATE", `Réservation du poste « ${item.label} » redemandée (${voyageurs.length} voyageur(s)).`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id: poste.reservationDossierId, message: "Demande de réservation mise à jour dans le sujet ouvert — l'assistante de direction est prévenue." };
  }

  // L'ASSISTANTE DE DIRECTION : une seule active ⇒ elle en est responsable ; plusieurs ⇒ toutes
  // participantes, sans responsable désignée — en choisir une serait choisir à la place d'un
  // humain (§118.34). Aucune ⇒ la demande n'a personne à qui partir, et on le dit.
  const assistantes = await prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) },
    select: { id: true }, orderBy: { createdAt: "asc" },
  });
  if (assistantes.length === 0) {
    return { ok: false, error: "Aucune assistante de direction active : la demande de réservation n'a personne à qui partir (Administration › Comptes)." };
  }
  const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
  const sujet = await createDossierRecord({
    title: `Réservation billets — ${info.ref} · ${item.label}`,
    description: corps,
    category: "Billets",
    priority: "HIGH",
    assignedToId: seule,
    participantIds: [...(seule ? [] : assistantes.map((a) => a.id)), ...(info.requesterId ? [info.requesterId] : [])],
    sourceType: PARENT_ENTITE[owner.parent],
    sourceId: owner.id,
    companyId: info.companyId ?? null,
  }, user.id);
  await prisma.adProItem.update({ where: { id }, data: { reservationDossierId: sujet.id, updatedById: user.id } });
  await audit(user, owner.parent, owner.id, "UPDATE", `Réservation du poste « ${item.label} » demandée — sujet ${sujet.reference} (${voyageurs.length} voyageur(s)).`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/dossiers");
  return { ok: true, id: sujet.id, message: `Demande de réservation envoyée — sujet ${sujet.reference} ouvert pour l'assistante de direction.` };
}

/**
 * RETIRER LA DEMANDE DE RÉSERVATION des billets d'un poste (audit du 04/10, constat 37) — « on annule
 * sa demande tant que l'autre ne l'a pas exécutée ». Rien ne la retirait : le sujet restait ouvert chez
 * l'assistante, qui pouvait réserver des billets dont plus personne ne voulait. Exécutée quand le sujet
 * est clos ou que le BC des billets est demandé (`refusRetraitReservation`, la règle de la carte) ; tout
 * ce qui refuse passe AVANT le motif (§118.18).
 *
 * TOUT OU RIEN, SOUS CONDITION : le sujet n'est clos que s'il est encore vivant, et le poste ne lâche
 * son sujet que s'il le porte encore et qu'aucun BC n'a été demandé entre-temps. Le motif s'écrit DANS
 * le sujet — l'assistante (et chaque participant) est prévenue par lui. Les voyageurs restent : une
 * nouvelle demande ouvrira un nouveau sujet avec la liste à jour.
 */
export async function retirerReservation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » se réserve." };
  const poste = await prisma.adProItem.findUnique({ where: { id }, select: { reservationDossierId: true, orderStage: true } });
  const sujet = poste?.reservationDossierId
    ? await prisma.dossier.findUnique({ where: { id: poste.reservationDossierId }, select: { id: true, reference: true, status: true } })
    : null;
  const refus = refusRetraitReservation({ sujet: sujet ? String(sujet.status) : null, orderStage: String(poste?.orderStage ?? "NONE") });
  if (refus || !sujet) return { ok: false, error: refus ?? "Aucune demande de réservation n'est en cours pour ce poste." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi vous retirez la demande de réservation : c'est ce que lira l'assistante de direction." };

  const changee = "La réservation vient de changer (traitée, ou un bon de commande demandé) : rouvrez la fiche.";
  try {
    await prisma.$transaction(async (tx) => {
      if (!(await cloreSujetVivant(tx, sujet.id))) throw new RefusPoste(changee);
      const lache = await tx.adProItem.updateMany({
        where: { id, reservationDossierId: sujet.id, orderStage: { in: ["NONE", "REFUSED"] } },
        data: { reservationDossierId: null, updatedById: user.id },
      });
      if (lache.count === 0) throw new RefusPoste(changee);
    });
  } catch (e) {
    if (e instanceof RefusPoste) return { ok: false, error: e.message };
    throw e;
  }
  await ecrireDansLeSujet({ dossierId: sujet.id, authorId: user.id, body: `Demande de réservation RETIRÉE — « ${item.label} » : ${motif}. Ne réservez pas ces billets ; le sujet est clos.` });
  await audit(user, owner.parent, owner.id, "UPDATE", `Réservation du poste « ${item.label} » retirée — sujet ${sujet.reference} clos : ${motif}`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/dossiers");
  revalidatePath(`/dossiers/${sujet.id}`);
  return { ok: true, id, message: `Demande de réservation retirée — le sujet ${sujet.reference} est clos, l'assistante de direction est prévenue. Les voyageurs restent sur le poste.` };
}

// ───────────────────── Billetterie : le devis de chaque voyageur, puis le BC (§118.205) ─────────────────────
//
// « Pour chaque voyageur, on met le devis ou pro forma de l'agence ; si le demandeur valide une des pro
// forma ou un des devis, alors on demande à établir un BC, ensuite ça suit le process jusqu'à demander
// la facture » (Direction, 04/10). Pas de second circuit de pièces : le devis d'un voyageur EST un devis
// du poste (`ajouterDevisPoste`), et `AdProVoyageurDevis` dit seulement pour QUI il a été déposé et s'il
// est la proposition retenue. Le BC passe par la porte du poste (`requestAdProItemOrder`), inchangée.

/** Le prisma d'une contrainte d'unicité violée — l'index partiel « un retenu par voyageur ». */
const estConflitUnicite = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Le BC a été demandé pendant la validation : la transaction se défait. */
class ChoixPerdu extends Error {}

/** Les étapes du BC où le choix d'un devis compte encore : il n'est ni demandé, ni établi. */
const BC_PAS_ENCORE_DEMANDE: AdProItemOrderStage[] = ["NONE", "REFUSED"];

/**
 * DÉPOSER LE DEVIS OU LA PRO FORMA DE L'AGENCE POUR UN VOYAGEUR. Délègue à `ajouterDevisPoste` (le même
 * fichier exigé, les mêmes refus, la pièce au registre Legal), sans devis commun : celui-ci ne couvre que
 * son poste. Puis le lien « pour ce voyageur ». Si le voyageur a été retiré entre-temps, le devis reste
 * un devis du poste, et la phrase le dit.
 */
export async function ajouterDevisVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const voyageurId = fdStr(formData, "voyageurId");
  if (!voyageurId) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(voyageurId, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  formData.delete("autresPostes");
  formData.set("id", item.id);
  const depose = await ajouterDevisPoste(undefined, formData);
  if (!depose.ok || !depose.id) return depose;
  const piece = await prisma.adProItemPiece.findUnique({
    where: { itemId_legalDocumentId: { itemId: item.id, legalDocumentId: depose.id } }, select: { id: true },
  });
  const lie = piece
    ? await prisma.adProVoyageurDevis.create({ data: { voyageurId, pieceId: piece.id, createdById: user.id }, select: { id: true } }).catch(() => null)
    : null;
  revalidate(owner.parent, owner.id);
  if (!lie) {
    return { ok: false, error: `Le devis est déposé sur le poste, mais ${nomComplet(v)} vient d'être retiré des voyageurs : il reste un devis du poste.` };
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis déposé pour le voyageur « ${nomComplet(v)} » du poste « ${item.label} ».`);
  return { ok: true, id: depose.id, message: `${depose.message ?? "Devis déposé."} Pour ${nomComplet(v)} — validez-le quand il convient.` };
}

/** La phrase du dépassement, sur l'ensemble des devis retenus du poste (tous voyageurs). */
async function depassementDuPoste(itemId: string, accorde: unknown): Promise<string | null> {
  const retenus = await prisma.adProVoyageurDevis.findMany({
    where: { retenuLe: { not: null }, voyageur: { itemId }, piece: { legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } } },
    select: { piece: { select: { legalDocument: { select: { amount: true } } } } },
  });
  return depassementDevisRetenus(
    retenus.map((r) => (r.piece.legalDocument.amount != null ? toNumber(r.piece.legalDocument.amount) : null)),
    accorde != null ? toNumber(accorde) : null,
  );
}

/**
 * VALIDER UNE PROPOSITION D'UN VOYAGEUR — le demandeur en choisit une, les autres sont écartées. Choisir
 * un autre devis ensuite REMPLACE le choix, tant que le BC n'est pas demandé : après, le choix est ce que
 * le BC couvre, et il ne change plus d'ici.
 *
 * DEUX VALIDATIONS CROISÉES N'EN POSENT QU'UNE : la ligne du voyageur est verrouillée, le choix actuel
 * relu dessous et comparé à celui que la personne a VU (`retenuVu`) — le second geste trouve le choix
 * changé et le dit. L'écriture reste conditionnelle (devis encore libre, BC pas encore demandé), et l'index
 * partiel de la base n'admet qu'un retenu par voyageur. Un dépassement du montant accordé se DIT, sans bloquer.
 */
export async function validerDevisVoyageur(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const voyageurId = fdStr(formData, "voyageurId");
  const devisId = fdStr(formData, "devisId");
  if (!voyageurId || !devisId) return { ok: false, error: "Voyageur ou devis non précisés." };
  const found = await chargerVoyageur(voyageurId, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.status === "REJECTED") return { ok: false, error: "Ce poste a été refusé : on n'y retient plus de devis." };
  if (!BC_PAS_ENCORE_DEMANDE.includes(item.orderStage)) {
    return { ok: false, error: "Le bon de commande de ce poste est déjà demandé : le devis retenu est celui qu'il couvre, il ne change plus d'ici." };
  }
  const lien = await prisma.adProVoyageurDevis.findFirst({
    where: { voyageurId, piece: { itemId: item.id, legalDocumentId: devisId } },
    select: { id: true, retenuLe: true, piece: { select: { legalDocument: { select: { status: true, cancelledAt: true } } } } },
  });
  if (!lien) return { ok: false, error: `Ce devis n'est pas une proposition déposée pour ${nomComplet(v)}.` };
  const doc = lien.piece.legalDocument;
  if (doc.status === "CANCELLED" || doc.cancelledAt) return { ok: false, error: "Ce devis a été annulé au registre : il ne se retient plus." };
  if (lien.retenuLe) {
    const depasse = await depassementDuPoste(item.id, item.amountGranted);
    return { ok: true, id: devisId, message: `Ce devis est déjà celui retenu pour ${nomComplet(v)}.${depasse ? ` ${depasse}` : ""}` };
  }
  // CE QUE LA PERSONNE A VU RETENU (§118.187) : changer de devis ne remplace QUE ce choix-là. L'écran
  // l'envoie ; sans lui, c'est le choix LU ICI qui fait foi — un choix posé entre cette lecture et
  // l'écriture (un autre clic, une autre personne) l'emporte, et le refus le dit.
  const retenuLu = (await prisma.adProVoyageurDevis.findFirst({
    where: { voyageurId, retenuLe: { not: null } }, select: { piece: { select: { legalDocumentId: true } } },
  }))?.piece.legalDocumentId ?? null;
  const retenuVu = formData.has("retenuVu") ? fdStr(formData, "retenuVu") : retenuLu;

  let issue: "POSE" | "DEJA" | "CHANGE" | "BC";
  try {
    issue = await prisma.$transaction(async (tx) => {
      // UN GESTE À LA FOIS PAR VOYAGEUR : la ligne du voyageur est verrouillée, le choix actuel RELU dessous.
      await tx.$queryRaw`SELECT id FROM "AdProVoyageur" WHERE id = ${voyageurId} FOR UPDATE`;
      const actuel = await tx.adProVoyageurDevis.findFirst({
        where: { voyageurId, retenuLe: { not: null } }, select: { id: true, piece: { select: { legalDocumentId: true } } },
      });
      // Retenu entre la lecture et ce verrou : par un autre geste — ce clic-ci n'a rien posé.
      if (actuel?.piece.legalDocumentId === devisId) return "DEJA" as const;
      if ((actuel?.piece.legalDocumentId ?? null) !== retenuVu) return "CHANGE" as const;
      if (actuel) await tx.adProVoyageurDevis.update({ where: { id: actuel.id }, data: { retenuLe: null, retenuParId: null } });
      const pose = await tx.adProVoyageurDevis.updateMany({
        where: { id: lien.id, retenuLe: null, piece: { item: { orderStage: { in: BC_PAS_ENCORE_DEMANDE } } } },
        data: { retenuLe: new Date(), retenuParId: user.id },
      });
      // Le BC vient d'être demandé : on défait le retrait de l'ancien choix avec le reste.
      if (pose.count === 0) throw new ChoixPerdu();
      return "POSE" as const;
    });
  } catch (e) {
    if (e instanceof ChoixPerdu) issue = "BC";
    // L'INDEX PARTIEL de la base, second filet : deux retenus pour un voyageur n'existent jamais.
    else if (estConflitUnicite(e)) issue = "CHANGE";
    else throw e;
  }
  if (issue === "DEJA") return { ok: false, error: `Ce devis vient d'être retenu pour ${nomComplet(v)} : rouvrez la fiche.` };
  if (issue === "CHANGE") return { ok: false, error: `Le devis retenu pour ${nomComplet(v)} vient de changer : rouvrez la fiche.` };
  if (issue === "BC") return { ok: false, error: "Le bon de commande de ce poste vient d'être demandé : le devis retenu ne change plus d'ici." };
  const depasse = await depassementDuPoste(item.id, item.amountGranted);
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis retenu pour le voyageur « ${nomComplet(v)} » du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: devisId, message: `Devis retenu pour ${nomComplet(v)} — les autres propositions sont écartées.${depasse ? ` ${depasse}` : ""}` };
}

/**
 * DEMANDER LE BC D'UNE BILLETTERIE — d'après les propositions RETENUES. Exige au moins un devis retenu,
 * écrit la liste dans la demande (l'assistante sait quelles propositions établir), puis passe par la
 * porte du poste (`requestAdProItemOrder`) : mêmes gardes (poste accordé, budget), même chaîne ensuite
 * jusqu'à la facture. Le montant accordé ne bouge pas ; un dépassement se dit.
 */
export async function demanderBCBilletterie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » demande son BC d'après les devis de ses voyageurs." };
  const [retenus, total] = await Promise.all([
    prisma.adProVoyageurDevis.findMany({
      where: { retenuLe: { not: null }, voyageur: { itemId: id }, piece: { legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } } },
      select: { voyageur: { select: { nom: true, prenom: true, position: true } }, piece: { select: { legalDocument: { select: { title: true, reference: true, amount: true } } } } },
    }),
    prisma.adProVoyageur.count({ where: { itemId: id } }),
  ]);
  if (retenus.length === 0) {
    return { ok: false, error: "Validez d'abord le devis d'au moins un voyageur : le bon de commande s'établit d'après les propositions retenues." };
  }
  retenus.sort((a, b) => a.voyageur.position - b.voyageur.position);
  const liste = retenus.map((r) => {
    const d = r.piece.legalDocument;
    return `• ${nomComplet(r.voyageur)} — ${d.reference ?? d.title}${d.amount != null ? ` (${toNumber(d.amount).toLocaleString("fr-FR")} DZD)` : ""}`;
  }).join("\n");
  const sansDevis = total - retenus.length;
  const note = [fdStr(formData, "note"), `Devis retenus (${retenus.length}/${total} voyageur(s)) :\n${liste}`].filter(Boolean).join("\n\n");
  formData.set("note", note);
  const r = await requestAdProItemOrder(undefined, formData);
  if (!r.ok) return r;
  const depasse = await depassementDuPoste(id, item.amountGranted);
  const reste = sansDevis > 0 ? ` ${sansDevis} voyageur(s) sans devis retenu ne sont pas dans cette demande.` : "";
  return { ...r, message: `${r.message ?? "Bon de commande demandé."}${reste}${depasse ? ` ${depasse}` : ""}` };
}

// ═══════════════ §118.206 — Les lignes des devis d'un poste, et le bon de commande généré d'après elles ═══════════════

/**
 * « Quand un devis est validé entièrement, dans la case Bon de commande, on peut soit GÉNÉRER avec un petit CTA,
 * soit UPLOADER. Il se peut qu'il y ait eu plusieurs devis, et différentes références dans chaque devis qui soient
 * validées : alors ça peut demander de générer UN BC PAR DEVIS (incluant UNIQUEMENT les références validées).
 * S'il oublie une référence, il peut juste la cocher dans le devis et RÉGÉNÉRER le BC. » (Direction, 05/10.)
 *
 * Quatre gestes, et chacun a sa porte :
 *   • LIRE un devis (`lireLesLignesDuDevis`) ou le saisir (`enregistrerLignesDuDevis`) : le demandeur, ou qui arbitre ;
 *   • VALIDER les lignes qu'on commande (`validerLignesDuDevis`) : même porte — c'est l'attestation d'avoir comparé
 *     la ligne au papier, et rien ne se commande sans elle ;
 *   • GÉNÉRER le BC de chaque devis (`genererBonDeCommandePoste`) : le demandeur, comme « demander le BC ».
 *
 * Ces quatre gestes sont des gestes D'ÉCRAN, classés EXCLUDED à la parité : une ligne validée est un prix que la
 * société commande, et la validation atteste qu'une personne l'a lue sur le papier (§118.15, §118.152 i).
 *
 * UN GESTE À LA FOIS : le poste d'abord, puis chaque devis (`chez`) — valider une ligne pendant qu'un BC se
 * compose ferait un BC qui porte une ligne qu'on vient de décocher. Les écritures restent conditionnelles :
 * entre deux processus, la file ne vaut plus, la condition si (§118.187).
 */
const filePoste = (itemId: string) => `ad-pro-bc:${itemId}`;
const fileDevis = (pieceId: string) => `ad-pro-devis:${pieceId}`;
/** Passe le poste, puis le devis, une personne à la fois — toujours dans cet ordre (jamais d'interblocage). */
const chez = <T,>(itemId: string, pieceId: string, fn: () => Promise<T>): Promise<T> =>
  enSerie(filePoste(itemId), () => enSerie(fileDevis(pieceId), fn));

class RefusLignes extends Error {}

const peutTraiterLesDevis = (user: SessionUser, parent: AdProParent): boolean => canEditItems(user, parent) || canAllocate(user, parent);

/** Le devis d'un poste, tel que la carte le voit — `null` s'il n'est plus rattaché au poste ou s'il est annulé. */
async function devisDuPoste(itemId: string, pieceId: string | null) {
  if (!pieceId) return null;
  return ((await devisDesPostes([itemId])).get(itemId) ?? []).find((d) => d.pieceId === pieceId && !d.annule) ?? null;
}

/** Ce que tout geste sur les lignes d'un devis vérifie d'abord — le poste, la porte, l'argent, la demande. */
async function cadreDesLignes(user: SessionUser, formData: FormData) {
  const id = fdStr(formData, "id");
  const pieceId = fdStr(formData, "pieceId");
  if (!id || !pieceId) return { error: "Poste ou devis non précisé." } as const;
  const found = await loadItem(id, user);
  if (!found) return { error: "Poste introuvable." } as const;
  const { item, owner } = found;
  if (!peutTraiterLesDevis(user, owner.parent)) return { error: "Non autorisé." } as const;
  const refusStock = refusArgentSurPosteStock(item.kind, "des lignes de devis");
  if (refusStock) return { error: refusStock } as const;
  if (item.status === "REJECTED") return { error: `Le poste « ${item.label} » est refusé : ses devis ne se traitent plus.` } as const;
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { error: "Un sponsoring direct n'a pas de bon de commande : la facture suffit — ses devis ne se valident pas ligne à ligne." } as const;
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { error: "Opération introuvable." } as const;
  const fermee = refusDemandeFermee(info);
  if (fermee) return { error: fermee } as const;
  return { id, pieceId, item, owner, info } as const;
}

/**
 * VALIDER LES LIGNES D'UN DEVIS POUR CE POSTE — l'ensemble REMPLACE le précédent : les lignes envoyées sont validées,
 * les autres ne le sont plus (décocher une ligne la retire). Une ligne se valide COMPLÈTE (quantité, prix lisibles) et
 * pour UN seul poste ; une ligne lue par la machine demande l'attestation « j'ai comparé au devis ».
 */
export async function validerLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner } = cadre;
  const demandees = new Set(formData.getAll("ligneId").map((x) => String(x).trim()).filter(Boolean));
  const compare = fdCase(formData, "compare") === true;
  return chez(id, pieceId, async () => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    if (!devis.structure) return { ok: false, error: "Ce devis n'a pas encore de lignes : faites-le lire, ou saisissez ses lignes, avant d'en valider." };
    // L'ÉTAT D'ABORD (§118.18) : un BC signé ou facturé fige les lignes validées de ce devis.
    const gel = refusChangementDeValidation(devis.bc);
    if (gel) return { ok: false, error: gel };
    const parId = new Map(devis.lignes.map((l) => [l.id, l]));
    if ([...demandees].some((l) => !parId.has(l))) return { ok: false, error: "Une des lignes n'appartient pas à ce devis : rechargez la fiche." };
    const aValider = [...demandees].filter((l) => !parId.get(l)!.validee);
    const aRetirer = devis.lignes.filter((l) => l.validee && !demandees.has(l.id)).map((l) => l.id);
    for (const lid of aValider) {
      const l = parId.get(lid)!;
      if (l.valideeAilleurs) return { ok: false, error: `« ${l.reference.slice(0, 60)} » est déjà validée pour le poste « ${l.valideeAilleurs} » : une ligne ne se commande qu'une fois — décochez-la là-bas d'abord.` };
      if (l.refusValidation) return { ok: false, error: l.refusValidation };
    }
    if (aValider.some((l) => parId.get(l)!.lue !== null) && compare !== true) {
      return { ok: false, error: "Cochez « J'ai comparé ces lignes au devis » : elles viennent de la lecture du fichier, et seule une personne qui les a vérifiées sur le papier peut les valider pour un bon de commande." };
    }
    if (aValider.length === 0 && aRetirer.length === 0) return { ok: true, id, message: "Rien n'a changé : les lignes validées sont celles que vous aviez déjà." };
    try {
      await prisma.$transaction(async (tx) => {
        if (aValider.length > 0) {
          const r = await tx.adProDevisLigne.updateMany({
            where: { id: { in: aValider }, devis: { legalDocumentId: pieceId }, OR: [{ validatedItemId: null }, { validatedItemId: id }] },
            data: { validatedItemId: id, validatedAt: new Date(), validatedById: user.id },
          });
          if (r.count !== aValider.length) throw new RefusLignes("Une ligne vient d'être validée pour un autre poste, ou retirée du devis : rechargez la fiche.");
        }
        if (aRetirer.length > 0) {
          await tx.adProDevisLigne.updateMany({
            where: { id: { in: aRetirer }, validatedItemId: id },
            data: { validatedItemId: null, validatedAt: null, validatedById: null },
          });
        }
      });
    } catch (e) {
      if (e instanceof RefusLignes) return { ok: false, error: e.message };
      throw e;
    }
    const apres = await devisDuPoste(id, pieceId);
    await audit(user, owner.parent, owner.id, "UPDATE",
      `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » : ${aValider.length} ligne${aValider.length > 1 ? "s" : ""} validée${aValider.length > 1 ? "s" : ""}, ${aRetirer.length} retirée${aRetirer.length > 1 ? "s" : ""}.`);
    revalidate(owner.parent, owner.id);
    const suite = apres?.etat === "A_REGENERER" ? " Le bon de commande de ce devis n'est plus à jour : régénérez-le."
      : apres?.etat === "A_GENERER" ? " Le bon de commande de ce devis est à générer." : "";
    return {
      ok: true, id,
      message: `${apres?.nbValidees ?? 0} ligne${(apres?.nbValidees ?? 0) > 1 ? "s" : ""} validée${(apres?.nbValidees ?? 0) > 1 ? "s" : ""} pour ce poste (${(apres?.entete.tvaRate === null ? (apres?.totalValideHt ?? 0) : (apres?.totalValideTtc ?? 0)).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DZD ${apres?.entete.tvaRate === null ? "HT, TVA non indiquée" : "TTC"}).${suite}`,
    };
  });
}

/** Un nombre saisi : « 4 800 », « 4 800,5 » ; vide → `null` ; illisible → `NaN`. */
function nombreSaisi(brut: string): number | null {
  const t = brut.replace(/\s/g, "").replace(",", ".");
  return t === "" ? null : Number(t);
}

/**
 * SAISIR OU CORRIGER LES LIGNES D'UN DEVIS — la retranscription à la main, ou la correction de ce que la lecture
 * a proposé. Une ligne qui garde son identifiant est modifiée en place ; une ligne dont le CONTENU change perd sa
 * validation (l'attestation portait sur l'ancien prix) ; une ligne absente est retirée. Refusé tant qu'un BC actif
 * porte une ligne de ce devis (§118.206 : régénérer, ou annuler le BC d'abord).
 */
export async function enregistrerLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner } = cadre;

  const ids = formData.getAll("ligneId").map((x) => String(x ?? "").trim());
  const refs = formData.getAll("ligneReference").map((x) => String(x ?? "").trim());
  const unites = formData.getAll("ligneUnite").map((x) => String(x ?? "").trim());
  const quantites = formData.getAll("ligneQuantite").map((x) => String(x ?? "").trim());
  const prix = formData.getAll("lignePrix").map((x) => String(x ?? "").trim());
  const n = Math.max(refs.length, quantites.length, prix.length);
  const lignes: { ligneId: string | null; reference: string; unit: string | null; quantity: number | null; unitPrice: number | null }[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = refs[i] ?? "";
    const q = quantites[i] ?? "";
    const p = prix[i] ?? "";
    if (!r && !q && !p) continue; // une rangée de saisie inutilisée
    if (!r) return { ok: false, error: `Ligne ${i + 1} : la référence (ou désignation) est obligatoire.` };
    const quantity = nombreSaisi(q);
    const unitPrice = nombreSaisi(p);
    if (quantity !== null && !(quantity > 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : la quantité doit être un nombre supérieur à zéro (vide si elle est illisible).` };
    if (unitPrice !== null && !(unitPrice >= 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : le prix unitaire doit être un nombre positif (vide s'il est illisible).` };
    lignes.push({ ligneId: ids[i] || null, reference: r, unit: (unites[i] ?? "") || null, quantity, unitPrice });
  }
  const tvaSaisie = nombreSaisi(fdStr(formData, "tvaRate") ?? "");
  if (tvaSaisie !== null && !(tvaSaisie >= 0 && tvaSaisie <= 100)) return { ok: false, error: "Le taux de TVA s'exprime en pour cent, entre 0 et 100." };
  if (tvaSaisie !== null) {
    const tauxRefuse = refusTauxDuDevis(tvaSaisie);
    if (tauxRefuse) return { ok: false, error: tauxRefuse };
  }
  const taxeSaisie = nombreSaisi(fdStr(formData, "extraTaxRate") ?? "");
  if (taxeSaisie !== null && !(taxeSaisie > 0 && taxeSaisie < 100)) return { ok: false, error: "La taxe additionnelle s'exprime en pour cent, au-dessus de 0 et sous 100 (laissez vide s'il n'y en a pas)." };
  const totalSaisi = nombreSaisi(fdStr(formData, "announcedTotal") ?? "");
  if (totalSaisi !== null && !(totalSaisi >= 0)) return { ok: false, error: "Le total annoncé sur le devis doit être un montant positif." };
  const supplierId = fdStr(formData, "supplierId");
  let fournisseur: string | null = null;
  if (supplierId) {
    const parties = await resolveParties(user.id, [supplierId]);
    if (!parties.ok) return { ok: false, error: parties.error };
    fournisseur = parties.text;
  }

  return chez(id, pieceId, async () => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    // Les BC ACTIFS qui portent une ligne : lus en base, jamais sur la parole de la vue (le `bcId` d'un BC annulé ne gèle rien).
    const portees = await prisma.adProDevisLigne.findMany({
      where: { devis: { legalDocumentId: pieceId }, bcId: { not: null }, bc: { status: { not: "CANCELLED" }, cancelledAt: null } },
      select: { id: true, bcId: true, bc: { select: { id: true, reference: true } } },
    });
    const gel = refusEditionDesLignes(
      portees.map((l): LigneDevisPoste => ({ id: l.id, position: 0, reference: "-", unit: null, quantity: 1, unitPrice: 0, lue: null, aVerifier: null, validatedItemId: null, bcId: l.bcId })),
      [...new Map(portees.filter((l) => l.bc).map((l) => [l.bc!.id, { id: l.bc!.id, reference: l.bc!.reference }])).values()],
    );
    if (gel) return { ok: false, error: gel };
    const existantes = await prisma.adProDevisLigne.findMany({
      where: { devis: { legalDocumentId: pieceId } },
      select: { id: true, reference: true, unit: true, quantity: true, unitPrice: true, validatedItemId: true },
    });
    const parId = new Map(existantes.map((l) => [l.id, l]));
    const inconnues = lignes.filter((l) => l.ligneId && !parId.has(l.ligneId));
    if (inconnues.length > 0) return { ok: false, error: "Une ligne n'appartient plus à ce devis : rechargez la fiche avant de l'enregistrer." };
    const gardees = new Set(lignes.map((l) => l.ligneId).filter((x): x is string => Boolean(x)));
    const doc = await prisma.legalDocument.findUnique({ where: { id: pieceId }, select: { reference: true } });
    const donnees = {
      // Un champ TVA VIDE efface la TVA (« le devis n'en porte pas ») : on ne remet jamais un 19 de repli.
      ...(formData.has("tvaRate") ? { tvaRate: tvaSaisie !== null ? new Prisma.Decimal(tvaSaisie) : null } : {}),
      ...(formData.has("extraTaxRate") ? { extraTaxRate: taxeSaisie !== null ? new Prisma.Decimal(taxeSaisie) : null, extraTaxLabel: taxeSaisie !== null ? (fdStr(formData, "extraTaxLabel") ?? "Taxe additionnelle") : null } : {}),
      ...(formData.has("announcedTotal") ? { announcedTotal: totalSaisi !== null ? new Prisma.Decimal(totalSaisi) : null } : {}),
      ...(supplierId ? { supplierId } : {}),
    };
    const quand = fdStr(formData, "quoteDate");
    const date = quand && !Number.isNaN(Date.parse(quand)) ? new Date(`${quand.slice(0, 10)}T00:00:00.000Z`) : null;
    let perdues = 0;
    await prisma.$transaction(async (tx) => {
      const entete = await tx.adProDevis.upsert({
        where: { legalDocumentId: pieceId },
        create: { legalDocumentId: pieceId, createdById: user.id, ...donnees, ...(date ? { quoteDate: date } : {}) },
        update: { ...donnees, ...(date ? { quoteDate: date } : {}) },
        select: { id: true },
      });
      const aRetirer = existantes.filter((l) => !gardees.has(l.id));
      if (aRetirer.length > 0) await tx.adProDevisLigne.deleteMany({ where: { id: { in: aRetirer.map((l) => l.id) } } });
      for (const [i, l] of lignes.entries()) {
        const avant = l.ligneId ? parId.get(l.ligneId) : undefined;
        const valeurs = {
          position: i, reference: l.reference, unit: l.unit,
          quantity: l.quantity !== null ? new Prisma.Decimal(l.quantity) : null,
          unitPrice: l.unitPrice !== null ? new Prisma.Decimal(l.unitPrice) : null,
        };
        if (!avant) {
          await tx.adProDevisLigne.create({ data: { ...valeurs, devisId: entete.id } });
          continue;
        }
        const change = avant.reference !== l.reference || (avant.unit ?? null) !== l.unit
          || (avant.quantity != null ? Number(avant.quantity) : null) !== l.quantity
          || (avant.unitPrice != null ? Number(avant.unitPrice) : null) !== l.unitPrice;
        // L'ATTESTATION PORTAIT SUR L'ANCIEN CONTENU : une ligne corrigée n'est plus celle qu'on avait validée.
        if (change && avant.validatedItemId) perdues += 1;
        await tx.adProDevisLigne.update({
          where: { id: avant.id },
          data: { ...valeurs, ...(change ? { validatedItemId: null, validatedAt: null, validatedById: null, aVerifier: null } : {}) },
        });
      }
      const nouvelleRef = fdStr(formData, "reference");
      if (nouvelleRef !== null || fournisseur) {
        await tx.legalDocument.update({
          where: { id: pieceId },
          data: { ...(nouvelleRef !== null && nouvelleRef !== doc?.reference ? { reference: nouvelleRef } : {}), ...(fournisseur ? { counterparty: fournisseur } : {}), updatedById: user.id },
        });
      }
    });
    await audit(user, owner.parent, owner.id, "UPDATE", `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » : ${lignes.length} ligne${lignes.length > 1 ? "s" : ""} enregistrée${lignes.length > 1 ? "s" : ""}.`);
    revalidate(owner.parent, owner.id);
    return {
      ok: true, id,
      message: `${lignes.length} ligne${lignes.length > 1 ? "s" : ""} enregistrée${lignes.length > 1 ? "s" : ""}.`
        + (perdues > 0 ? ` ${perdues} ligne${perdues > 1 ? "s" : ""} corrigée${perdues > 1 ? "s" : ""} n'est plus validée : revalidez-la devant le papier.` : ""),
    };
  });
}

/**
 * LA VALIDATION AUTOMATIQUE D'UN DEVIS BIEN LU (Direction, 06/10) : « lecture automatique des devis uploadés
 * transformés en ligne » — sans cases à cocher ni attestation quand la lecture ne laisse AUCUN doute.
 *
 * TOUT OU RIEN, et c'est ce qui rend l'automatisme sûr : les lignes sont validées pour ce poste SEULEMENT si
 * CHACUNE est complète (quantité et prix lus), sans réserve de lecture, sans refus de validation et libre
 * (pas déjà validée pour un autre poste), et si le total des lignes colle au total imprimé quand le devis en
 * porte un. Au moindre doute, rien n'est validé : la personne retrouve les lignes à relire, comme avant.
 * Un devis qui porte déjà un bon de commande n'est jamais touché. Retourne le nombre de lignes validées.
 */
async function validerAutomatiquementLesLignesLues(userId: string, itemId: string, pieceId: string): Promise<number> {
  const devis = await devisDuPoste(itemId, pieceId);
  if (!devis || !devis.structure || devis.bc || devis.ecartTotal || devis.lignes.length === 0) return 0;
  if (devis.lignes.some((l) => l.validee)) return 0; // une personne a déjà tranché : on ne repasse pas derrière elle
  const sansDoute = devis.lignes.every((l) =>
    !l.valideeAilleurs && !l.refusValidation && !l.aVerifier && l.quantity != null && l.unitPrice != null);
  if (!sansDoute) return 0;
  const { count } = await prisma.adProDevisLigne.updateMany({
    where: { id: { in: devis.lignes.map((l) => l.id) }, devis: { legalDocumentId: pieceId }, validatedItemId: null },
    data: { validatedItemId: itemId, validatedAt: new Date(), validatedById: userId },
  });
  return count;
}

/**
 * RELIRE UN DEVIS DÉJÀ DÉPOSÉ — pour un devis d'avant la lecture, ou dont la première lecture a échoué. Le fichier est
 * relu en base, jamais renvoyé par le formulaire. Les lignes proposées REMPLACENT les précédentes : refusé dès qu'une
 * ligne est validée ou qu'un BC en porte une (on ne remplace pas ce qu'une personne a attesté sans le lui dire).
 */
export async function lireLesLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner } = cadre;
  return chez(id, pieceId, async () => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    if (devis.bc) return { ok: false, error: `Ce devis porte déjà un bon de commande (${devis.bc.reference}) : il ne se relit plus d'ici — annulez le bon de commande d'abord.` };
    if (devis.lignes.some((l) => l.validee || l.valideeAilleurs)) {
      return { ok: false, error: "Des lignes de ce devis sont déjà validées : une relecture les remplacerait. Décochez-les d'abord (ou corrigez les lignes à la main)." };
    }
    const fichier = await prisma.document.findFirst({
      where: { entityType: "LEGAL_DOCUMENT", entityId: pieceId }, orderBy: { createdAt: "asc" },
      select: { name: true, fileKey: true, confidentiality: true },
    });
    if (!fichier?.fileKey) return { ok: false, error: "Ce devis n'a pas de fichier à lire : joignez-le d'abord." };
    const octets = await readFileByKey(fichier.fileKey).catch(() => null);
    if (!octets) return { ok: false, error: "Le fichier de ce devis est introuvable dans le stockage." };
    const ing = await ingererDevisDuPoste({
      userId: user.id, legalDocumentId: pieceId, octets, nomFichier: fichier.name, remplacer: true,
      sortieCloudPermise: fichier.confidentiality === "INTERNAL",
    });
    if (!ing.ok) return { ok: false, error: ing.raison };
    await audit(user, owner.parent, owner.id, "UPDATE", `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » relu : ${ing.nbLignes} ligne${ing.nbLignes > 1 ? "s" : ""} proposée${ing.nbLignes > 1 ? "s" : ""}.`);
    const nb = await validerAutomatiquementLesLignesLues(user.id, id, pieceId).catch(() => 0);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: nb > 0 ? `Devis relu : ${nb} ligne${nb > 1 ? "s" : ""} validée${nb > 1 ? "s" : ""} automatiquement.` : phraseDeLecture(ing) };
  });
}

/**
 * GÉNÉRER LE OU LES BONS DE COMMANDE D'UN POSTE d'après les lignes VALIDÉES de ses devis — UN BC PAR DEVIS, avec
 * uniquement ses lignes validées. `pieceId` : un seul devis ; absent : tous ceux qui ont quelque chose à générer. Un
 * devis dont le BC existe et n'est ni signé ni facturé est RÉVISÉ (même numéro, version suivante) quand on a coché ou
 * décoché des lignes depuis ; signé ou facturé, le refus nomme le geste qui reste.
 *
 * Mêmes portes que « demander le BC » : le poste est accordé, son budget choisi, la demande n'est pas close, et
 * aucune demande de BC n'est ouverte chez l'assistante (deux chemins pour le même BC feraient deux commandes).
 * Le poste prend la marche du BC comme pour une demande — au-dessus du seuil le centre Ad & Pro le vise, une fois,
 * en deçà il passe à la signature des Finances. Les BC générés lisent CETTE porte (`portesDesBC`, source « POSTE »).
 */
export async function genererBonDeCommandePoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id")) return { ok: false, error: "Poste non précisé." };
  fdStr(formData, "pieceId"); // facultatif : un seul devis ; absent, tous ceux qui ont quelque chose à générer
  return traiterLeBCDuPoste(formData, "APERCU");
}

/**
 * VALIDER L'APERÇU ET L'ENVOYER AUX FINANCES (Direction, 10/2026) — « il faut d'abord pré-valider le preview du BC par le
 * demandeur, avec modification possible ». C'est ICI, et seulement ici, que le numéro NNN/DG/AAAA est attribué (donc sans trou :
 * un brouillon abandonné ne consomme rien), que le Word et le PDF définitifs sont produits et que la marche du BC démarre
 * (centre Ad & Pro au-dessus du seuil, puis signature des Finances). Le DEMANDEUR de la demande — ou le Super Admin — valide ;
 * l'assistante ou le collègue qui a préparé l'aperçu ne le valide pas à sa place.
 */
export async function validerEtEnvoyerBcPoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id")) return { ok: false, error: "Poste non précisé." };
  fdStr(formData, "pieceId"); // facultatif : un seul devis ; absent, tous ceux dont l'aperçu existe
  return traiterLeBCDuPoste(formData, "VALIDER");
}

async function traiterLeBCDuPoste(formData: FormData, mode: "APERCU" | "VALIDER"): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const pieceVoulue = fdStr(formData, "pieceId");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un bon de commande");
  if (refusStock) return { ok: false, error: refusStock };
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { ok: false, error: "Un sponsoring direct n'a pas de bon de commande : déposez la facture (et, si vous l'avez, la pro forma) puis demandez le paiement." };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };
  if (mode === "VALIDER" && !peutValiderLeBrouillon({ userId: user.id, role: user.role, demandeurId: info.requesterId })) {
    return { ok: false, error: REFUS_VALIDATION_BROUILLON };
  }

  return enSerie(filePoste(id), async () => {
    // L'ÉTAT D'ABORD (§118.18) : tout ce qui interdit de générer se lit AVANT de demander quoi que ce soit.
    const poste = await prisma.adProItem.findUnique({
      where: { id },
      select: { status: true, orderStage: true, expenseOrderId: true, amountGranted: true, budgetCategoryId: true, supplier: true },
    });
    if (!poste) return { ok: false, error: "Poste introuvable." };
    const montantAccorde = poste.amountGranted != null ? toNumber(poste.amountGranted) : null;
    const ouverte = (await demandesBCDesPostes([id])).get(id);
    const refus = refusGenerationBC({
      status: poste.status, amountGranted: montantAccorde, budgetCategoryId: poste.budgetCategoryId, orderStage: poste.orderStage,
      expenseOrderId: poste.expenseOrderId, demandeChez: ouverte?.assistante, demandeOuverte: Boolean(ouverte),
    });
    if (refus) return { ok: false, error: refus };

    const tous = ((await devisDesPostes([id])).get(id) ?? []).filter((d) => !d.annule);
    const visees = pieceVoulue ? tous.filter((d) => d.pieceId === pieceVoulue) : tous;
    if (pieceVoulue && visees.length === 0) return { ok: false, error: "Ce devis n'est pas rattaché à ce poste." };
    const aFaireTous = visees.filter((d) => d.etat === "A_GENERER" || d.etat === "A_REGENERER");
    if (aFaireTous.length === 0) {
      const bloque = visees.find((d) => d.etat === "FIGE" || d.etat === "A_ANNULER");
      if (bloque?.refus) return { ok: false, error: bloque.refus };
      if (visees.some((d) => d.etat === "A_JOUR")) return { ok: true, id, message: "Chaque devis validé a déjà son bon de commande, à jour : rien de nouveau à générer." };
      return { ok: false, error: "Aucune ligne n'est validée : cochez, dans un devis, les lignes à commander, puis générez le bon de commande." };
    }
    // L'APERÇU d'abord : un devis qui a déjà son brouillon le garde (ses corrections ne sont jamais écrasées par un clic) ;
    // la VALIDATION, elle, ne porte que sur les devis dont l'aperçu existe.
    const sansBrouillon = aFaireTous.filter((d) => !d.brouillon);
    if (mode === "APERCU" && sansBrouillon.length === 0) {
      return { ok: true, id, message: `${ETIQUETTE_BROUILLON} : l'aperçu existe déjà — relisez-le, corrigez au besoin, puis « Valider et envoyer aux Finances ».` };
    }
    const aFaire = mode === "APERCU" ? sansBrouillon : aFaireTous.filter((d) => d.brouillon);
    if (aFaire.length === 0) {
      return { ok: false, error: "Aucun aperçu de bon de commande à valider : générez d'abord l'aperçu (« Générer le BC »), relisez-le, puis validez-le." };
    }
    // Les lignes CORRIGÉES par le demandeur portent leur propre plafond (le hors-taxe saisi, comme « Modifier le BC ») ; sans correction,
    // ce sont les lignes validées des devis qui le portent.
    const corrigees = mode === "VALIDER" ? aFaire.filter((d) => d.brouillon?.lignes) : [];
    if (corrigees.length > 0) {
      const ht = aFaire.reduce((s, d) => s + totalHtDesLignes(d.brouillon?.lignes ?? d.brouillon?.lignesBc ?? []), 0);
      if (montantAccorde !== null && Number.isFinite(ht) && ht > montantAccorde + TOLERANCE_DZD) {
        return { ok: false, error: `Les lignes corrigées font ${Math.round(ht).toLocaleString("fr-FR")} DZD hors taxes, au-delà de l'accordé (${montantAccorde.toLocaleString("fr-FR")} DZD) : corrigez-les, ou demandez une révision du poste.` };
      }
    } else {
      const depasse = refusMontantDuPoste(tous, montantAccorde);
      if (depasse) return { ok: false, error: depasse };
    }
    for (const d of aFaire) {
      if (d.etat !== "A_GENERER") continue;
      // Un taux de TVA que le BC ne peut pas porter se dit AVANT la marche : la fabrique le refuserait après.
      const tauxRefuse = refusTauxDuDevis(d.entete.tvaRate);
      if (tauxRefuse) return { ok: false, error: `${d.reference ?? d.titre} : ${tauxRefuse}` };
      const t = await tiersDuDevis(d, poste.supplier);
      if (!t.ok) return { ok: false, error: `${d.reference ?? d.titre} : ${t.error}` };
    }
    const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    if (!societe) {
      return { ok: false, error: "La société qui commande est introuvable : la demande n'en nomme aucune, et la fiche salarié de son demandeur non plus. Renseignez la société du demandeur (RH › fiche salarié), puis relancez." };
    }

    // ── L'APERÇU : un BROUILLON sur chaque devis, et RIEN d'autre — ni numéro, ni pièce, ni marche, ni Finances. ──
    if (mode === "APERCU") {
      const maintenant = new Date();
      for (const d of aFaire) {
        const b = brouillonNeuf({ itemId: id, par: user.id, parNom: user.name ?? null, maintenant });
        await prisma.adProDevis.updateMany({ where: { legalDocumentId: d.pieceId }, data: { bcBrouillon: b as unknown as Prisma.InputJsonValue } });
      }
      await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » préparé (${aFaire.length} devis) — à vérifier par le demandeur ; aucun numéro attribué.`);
      revalidate(owner.parent, owner.id);
      const qui = info.requesterId && info.requesterId !== user.id ? " Le demandeur de la demande le valide." : "";
      return {
        ok: true, id,
        message: `${ETIQUETTE_BROUILLON} — ${aFaire.length} aperçu${aFaire.length > 1 ? "s" : ""} prêt${aFaire.length > 1 ? "s" : ""} : relisez, corrigez au besoin, puis « Valider et envoyer aux Finances ». Le numéro n'est attribué qu'à la validation.${qui}`,
      };
    }

    // LA MARCHE DU POSTE, comme une demande de BC — puis la composition. Prise avant : les BC lisent cette porte en naissant.
    let marche: { sousLeSeuil: boolean; seuilBC: number } | null = null;
    const etapeAvant = poste.orderStage;
    if (poste.orderStage === "NONE" || poste.orderStage === "REFUSED") {
      const prise = await lireLaMarcheDuBC({
        itemId: id, montantAccorde: montantAccorde as number, userId: user.id, assistantId: null,
        note: "Bon de commande généré d'après les lignes validées des devis du poste.",
      });
      const posee = await prisma.adProItem.updateMany({ where: prise.where, data: prise.data });
      if (posee.count === 0) return { ok: false, error: REFUS_MARCHE_PRISE };
      if (!prise.sousLeSeuil) {
        await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], notificationDuCentreBC({ id: item.id, ref: info.ref, label: item.label, montantAccorde: montantAccorde as number })).catch(() => undefined);
      }
      marche = { sousLeSeuil: prise.sousLeSeuil, seuilBC: prise.seuilBC };
    }
    // LA RÉFÉRENCE CHOISIE À LA VALIDATION (registre NNN/DG/AAAA, Direction 10/2026) : le champ est prérempli avec le prochain
    // numéro ; laissé tel quel, il ne fige rien (le prochain libre est attribué) ; modifié, c'est ce numéro-là, vérifié par la fabrique.
    const numeroDuFormulaire = pieceVoulue && formData.has("numeroChoisi")
      ? saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere"))
      : undefined;
    const bilan = await genererLesBCsDuPoste(
      user, { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: montantAccorde }, ref: info.ref, societe },
      aFaire.map((d) => d.pieceId),
      new Map(aFaire.filter((d) => d.brouillon).map((d) => [
        d.pieceId,
        (d.pieceId === pieceVoulue && numeroDuFormulaire !== undefined ? { ...(d.brouillon as BrouillonBc), numeroChoisi: numeroDuFormulaire } : d.brouillon) as BrouillonBc,
      ])),
    );
    // Les brouillons VALIDÉS sont consommés : le BC existe, l'aperçu a fait son œuvre (un échec garde le sien).
    if (bilan.bcs.length > 0) {
      await prisma.adProDevis.updateMany({ where: { legalDocumentId: { in: bilan.bcs.map((b) => b.devisPieceId) } }, data: { bcBrouillon: Prisma.DbNull } });
    }
    // RIEN N'A PU ÊTRE COMPOSÉ : la marche prise pour rien est rendue — le poste ne reste pas « demandé » sans BC.
    if (bilan.bcs.length === 0 && marche) {
      await prisma.adProItem.updateMany({
        where: { id, orderStage: marche.sousLeSeuil ? "DIRECTION_OK" : "REQUESTED", orderRequestedById: user.id },
        data: { orderStage: etapeAvant, orderRequestedAt: null, orderRequestedById: null, orderNote: null, orderDecisionNote: null },
      });
    }
    if (bilan.bcs.length === 0) return { ok: false, error: `Aucun bon de commande n'a pu être généré — ${bilan.echecs.join(" ; ")}.` };
    await audit(user, owner.parent, owner.id, "UPDATE", `Bons de commande générés pour le poste « ${item.label} » d'après les lignes validées : ${bilan.bcs.map((b) => `${b.reference}${b.regenere ? ` (révisé v${b.version})` : ""}`).join(", ")}.`);
    revalidate(owner.parent, owner.id);
    revalidatePath(CHEMIN_BC_A_SIGNER);
    if (marche && !marche.sousLeSeuil) revalidatePath("/centre-ad-pro");
    const suite = marche
      ? (marche.sousLeSeuil ? ` ${motifSousLeSeuil(marche.seuilBC)}` : " Le centre de validation Ad & Pro les vise avec le poste.")
      : "";
    return { ok: true, id, message: `${phraseBilanGeneration(bilan)}${suite}` };
  });
}

// ═══════════════ L'APERÇU DU BC — relu, corrigé, régénéré par le demandeur avant d'être validé ═══════════════

/** Le devis, son brouillon et le poste, lus sous la file du devis — ce que l'aperçu, sa correction et son retrait partagent. */
async function brouillonDuDevis(user: SessionUser, formData: FormData, ecriture: boolean) {
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { error: cadre.error } as const;
  const { id, pieceId, item, owner, info } = cadre;
  if (ecriture && !canEditItems(user, owner.parent)) return { error: "Non autorisé." } as const;
  const devis = await devisDuPoste(id, pieceId);
  if (!devis) return { error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." } as const;
  if (!devis.brouillon) return { error: "Il n'y a pas d'aperçu de bon de commande pour ce devis : générez-le d'abord (« Générer le BC »)." } as const;
  const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
  if (!societe) return { error: "La société qui commande est introuvable : renseignez la société du demandeur (RH › fiche salarié)." } as const;
  const poste = { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: item.amountGranted != null ? toNumber(item.amountGranted) : null }, ref: info.ref, societe };
  return { id, pieceId, item, owner, info, devis, brouillon: devis.brouillon as BrouillonBc, poste } as const;
}

export type ApercuBcPoste = ApercuDuBC | { ok: false; error: string };

/**
 * L'APERÇU DU BC — le PDF tel qu'il sera imprimé, rendu à blanc, avec le numéro « À attribuer à la validation » : aucun numéro
 * consommé. Lisible par qui voit les devis du poste (le demandeur, qui arbitre).
 */
export async function apercuBcPoste(formData: FormData): Promise<ApercuBcPoste> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, false);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Échec." };
  return apercuDuBC(user, lu.poste, lu.devis, lu.brouillon);
}

/**
 * CORRIGER L'APERÇU — le demandeur (ou qui prépare le poste) change la Référence, le Contact, les Modalités de paiement, le lieu et
 * la date de livraison, le bloc du fournisseur, les lignes (désignation, unité, quantité, PU) et les notes. Un champ vide revient à
 * ce que le devis donne. Rien n'est numéroté : on régénère l'aperçu autant de fois qu'il le faut.
 */
export async function modifierApercuBcPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, true);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Échec." };
  const { id, pieceId, item, owner, devis, brouillon } = lu;
  const champ = (cle: string): string | null => { const v = fdStr(formData, cle); return v && v.trim() ? v.trim() : null; };
  const listes: ListesDeLignes = {
    designations: formData.getAll("ligneDesignation").map(String), details: formData.getAll("ligneDetails").map(String),
    quantites: formData.getAll("ligneQuantite").map(String), prix: formData.getAll("lignePrix").map(String),
    remises: formData.getAll("ligneRemise").map(String), tvas: formData.getAll("ligneTva").map(String), sections: formData.getAll("ligneSection").map(String),
  };
  const unites = formData.getAll("ligneUnite").map(String);
  let lignes: LigneCommerciale[] | null = brouillon.lignes;
  if (listes.designations.length > 0) {
    lignes = lignesDepuisListes(listes).map((l, i) => ({ ...l, unite: (unites[i] ?? "").trim() || null }));
    const vide = lignes.findIndex((l) => !l.designation);
    if (vide >= 0) return { ok: false, error: `Ligne ${vide + 1} : la désignation est obligatoire.` };
    const mauvaise = lignes.findIndex((l) => !l.section && (!Number.isFinite(l.quantite) || l.quantite <= 0 || !Number.isFinite(l.prixUnitaire) || l.prixUnitaire < 0));
    if (mauvaise >= 0) return { ok: false, error: `Ligne ${mauvaise + 1} : la quantité (supérieure à zéro) et le prix unitaire (positif) doivent être des nombres.` };
  }
  const mode = champ("modePaiement");
  if (mode && !(MODES_PAIEMENT as readonly string[]).includes(mode)) return { ok: false, error: "Mode de paiement inconnu." };
  const dateLivraison = champ("livraisonDate");
  if (dateLivraison && !/^\d{4}-\d{2}-\d{2}$/.test(dateLivraison)) return { ok: false, error: "La date de livraison s'écrit AAAA-MM-JJ." };
  const tiers = {
    nom: champ("fournisseurNom") ?? undefined, adresse: champ("fournisseurAdresse"), telephone: champ("fournisseurTelephone"),
    email: champ("fournisseurEmail"), rc: champ("fournisseurRc"), nif: champ("fournisseurNif"),
  };
  const maintenant = new Date().toISOString();
  const apres: BrouillonBc = {
    ...brouillon, lignes,
    signature: lignes ? signatureDesLignes(lignesDuBCDuDevis(devis, id)) : null,
    objet: champ("objet"), notes: champ("notes"),
    contact: champ("contactNom") || champ("contactTelephone") ? { nom: champ("contactNom"), telephone: champ("contactTelephone") } : null,
    modePaiement: (mode as BrouillonBc["modePaiement"]) ?? null, conditionsPaiement: champ("conditionsPaiement"),
    livraison: champ("livraisonAdresse") || dateLivraison || champ("livraisonDelai") ? { adresse: champ("livraisonAdresse"), date: dateLivraison, delai: champ("livraisonDelai") } : null,
    tiers: Object.values(tiers).some(Boolean) ? tiers : null,
    numeroChoisi: champ("numeroChoisi"),
    modifieLe: maintenant, modifiePar: user.id,
  };
  return chez(id, pieceId, async () => {
    const r = await prisma.adProDevis.updateMany({ where: { legalDocumentId: pieceId }, data: { bcBrouillon: apres as unknown as Prisma.InputJsonValue } });
    if (r.count === 0) return { ok: false, error: "Ce devis n'a plus d'aperçu : rechargez la fiche." };
    await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » corrigé (devis « ${devis.reference ?? devis.titre} »).`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: "Aperçu mis à jour : régénérez-le pour relire le PDF, puis validez-le." };
  });
}

/** RETIRER L'APERÇU — le brouillon disparaît ; aucun numéro n'avait été attribué, la série reste continue. */
export async function annulerApercuBcPoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, true);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Échec." };
  const { id, pieceId, item, owner, devis } = lu;
  return chez(id, pieceId, async () => {
    await prisma.adProDevis.updateMany({ where: { legalDocumentId: pieceId }, data: { bcBrouillon: Prisma.DbNull } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » retiré (devis « ${devis.reference ?? devis.titre} ») — aucun numéro n'avait été attribué.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: "Aperçu retiré : aucun numéro de bon de commande n'a été consommé." };
  });
}
