import { lienPosteAdPro, lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { revalidatePath } from "next/cache";
import type { AdProItemKind, AdProItemStatus, UserRole } from "@prisma/client";
import { userCan, hasGlobalView, rolesWithModule, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { reporterLesPostesSurLaDeclaration } from "@/lib/workflow/engine";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { AD_PRO_PARENTS, ITEM_KIND_LABELS, PARENT_ENTITE, type AdProParent } from "../../domaine/postes";
import { PIECE_SECRETARIAT, NATURES_PIECE_SECRETARIAT, TITRE_BC_A_ETABLIR, type NaturePieceSecretariat } from "../../domaine/pieces-secretariat";
import { montantDeLaDemande } from "../../domaine/montant-demande";
import { etatPostesSponsoring } from "../../domaine/cloture-sponsoring";
import { libelleLigne, type LigneRepartition } from "../../domaine/repartition";
import type { PosteReparti } from "../../domaine/repartition-ecriture";
import { porteDesVoyageurs, depassementDevisRetenus } from "../../domaine/voyageurs";
import { porteDesHebergements } from "../../domaine/hebergements";
import type { EtatBcPoste, GesteVisaPoste } from "../../domaine/bc-poste";
import { droitsValidation, rolesAPrevenir, type DroitsValidation, type Porteur } from "../../domaine/validation-poste";
import { signalerPorteDgSiBesoin } from "../porte-dg";
import { demanderBcAAssistante } from "../pieces-poste";
import { devisDesPostes } from "../requetes/devis-poste";
import { libelleArticleStock } from "@/lib/promo/stock";
import type { PromoFamille } from "@/lib/promo/catalogue";
import { lireSaisieDuComposeur } from "@/lib/bons-de-commande/saisie-composeur";
import type { ModificationsDocument } from "@/platform/ia/artifact/factory";
import { ecrireDansLeSujet } from "@/lib/dossiers-core";
import { annulerDemandeSecretariat } from "@/lib/secretariat/annulation";
import { sansBloquer } from "@/lib/journal";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LE SOCLE COMMUN DES ACTIONS DE POSTES — la table `PARENTS`, le chargement d'un poste et ses refus,
// le visa du centre et la clôture des demandes au secrétariat : ce que plusieurs morceaux de la clé
// `ad-pro-item-actions` emploient (`src/lib/actions/parc.ts`). Ces aides étaient privées au fichier
// d'actions de 4 409 lignes ; elles le restent au module (aucune porte ne les exporte), et les actions
// les importent en RELATIF, comme un appel local d'avant (le contrat d'aucune action ne change).
// ═══════════════════════════════════════════════════════════════════════════════════════════

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

export interface ParentInfo {
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
  /** La phrase d'une demande close autrement que par clôture ou transfert (une demande « autre » terminée). */
  closPhrase?: string;
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

export type AdProModule = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENTS" | "AD_PRO_OTHER";

export interface ParentSpec {
  module: AdProModule;
  path: string;
  /** Colonne de rattachement du poste — une par opération, jamais de colonne polymorphe. */
  column: "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId" | "otherRequestId";
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
export const CONGRESS_DECIDED = ["APPROVED", "COMPLETED"];

/** Une demande de congrès ou d'événement refusée ou annulée : ses postes ne partent plus. */
export const CONGRESS_FERME = ["REJECTED", "CANCELLED"];

/**
 * UN POSTE EST « TARDIF » SEULEMENT APRÈS UNE DÉCISION SUR L'ARGENT (27/10/2026). La prévalidation d'un
 * congrès ou d'un événement (requestStatus APPROVED) n'écrit plus de montant : comme un sponsoring
 * PRÉ-VALIDÉ, c'est le moment même où les postes se préparent — les marquer « ajoutés après la décision »
 * (et prévenir à chaque ligne) serait faux. Une demande d'avant la règle, accordée AVEC son montant
 * (`finalAmount`), garde le marquage.
 */
export const tardifCongres = (decided: boolean, finalAmount: unknown) => decided && finalAmount != null;

/** Un congrès (national ou international) lu pour ses postes — les deux ne diffèrent que par le bénéficiaire. */
function congresLu(
  r: { id: string; name: string; requestStatus: string; requesterId: string | null; companyId: string | null; finalAmount: unknown },
  beneficiary: string,
): ParentInfo {
  const decided = CONGRESS_DECIDED.includes(r.requestStatus);
  return {
    id: r.id, ref: r.name, beneficiary, decided, tardif: tardifCongres(decided, r.finalAmount), clos: false,
    refusee: CONGRESS_FERME.includes(r.requestStatus), requesterId: r.requesterId, companyId: r.companyId,
  };
}

export const PARENTS: Record<AdProParent, ParentSpec> = {
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
        select: { id: true, name: true, hostInstitution: true, requestStatus: true, requesterId: true, companyId: true, finalAmount: true },
      });
      // Le congrès n'a pas de référence : son nom est ce qui l'identifie sur une pièce.
      return r ? congresLu(r, r.hostInstitution ?? r.name) : null;
    },
  },
  CONGRESS_INTERNATIONAL: {
    module: "CONGRESS_INTERNATIONAL",
    path: "/congress-international",
    column: "congressInternationalId",
    load: async (id) => {
      const r = await prisma.congressInternational.findUnique({
        where: { id },
        select: { id: true, name: true, requestStatus: true, requesterId: true, companyId: true, finalAmount: true },
      });
      return r ? congresLu(r, r.name) : null;
    },
  },
  EVENT: {
    module: "EVENTS",
    path: "/events",
    column: "eventId",
    load: async (id) => {
      const r = await prisma.event.findUnique({
        where: { id },
        select: { id: true, name: true, requestStatus: true, requesterId: true, status: true, companyId: true, finalAmount: true },
      });
      if (!r) return null;
      // UN ÉVÉNEMENT PASSE PAR LE CIRCUIT COMME LES AUTRES (27/10/2026 — décisions #18/#19) : ce sont des
      // événements EXTERNES, pas organisés par nous. Sans prévalidation (requestStatus null : né hors
      // circuit), ses postes ne sont ni décidés ni payables — un état d'organisation (« En préparation »,
      // « Complet », même « Validé » tapé à la main avant §118.138) ne vaut pas accord.
      const decided = r.requestStatus != null && CONGRESS_DECIDED.includes(r.requestStatus);
      const refusee = r.requestStatus == null ? r.status === "CANCELLED" : CONGRESS_FERME.includes(r.requestStatus);
      return { id: r.id, ref: r.name, beneficiary: r.name, decided, tardif: tardifCongres(decided, r.finalAmount), clos: false, refusee, requesterId: r.requesterId, companyId: r.companyId };
    },
  },
  // LA DEMANDE « AUTRE » (27/10/2026, décision #17) : même circuit, mêmes postes. Prévalidée (`APPROVED`)
  // ou terminée (`DONE`), elle est décidée — sans montant global : les postes se préparent, jamais
  // « tardifs ». Terminée, ses postes sont arrêtés ; refusée ou annulée, ils ne partent plus.
  AD_PRO_OTHER: {
    module: "AD_PRO_OTHER",
    path: "/ad-pro/autres",
    column: "otherRequestId",
    load: async (id) => {
      const r = await prisma.adProOtherRequest.findUnique({
        where: { id },
        select: { id: true, reference: true, title: true, beneficiary: true, status: true, requesterId: true, companyId: true },
      });
      if (!r) return null;
      return {
        id: r.id, ref: r.reference, beneficiary: r.beneficiary ?? r.title,
        decided: r.status === "APPROVED" || r.status === "DONE", tardif: false,
        clos: r.status === "DONE",
        closPhrase: "Cette demande est marquée terminée : ses postes, leurs montants et leurs budgets sont arrêtés.",
        refusee: r.status === "REFUSED" || r.status === "CANCELLED",
        requesterId: r.requesterId, companyId: r.companyId,
      };
    },
  },
};

export const isParent = (v: string): v is AdProParent => (AD_PRO_PARENTS as readonly string[]).includes(v);

export interface ParentColumns {
  sponsoringId: string | null;
  congressNationalId: string | null;
  congressInternationalId: string | null;
  eventId: string | null;
  otherRequestId: string | null;
}

/** Le parent d'un poste, déduit de la colonne renseignée (la base garantit qu'il y en a une). */
export function parentOf(item: ParentColumns): { parent: AdProParent; id: string } | null {
  if (item.sponsoringId) return { parent: "SPONSORING", id: item.sponsoringId };
  if (item.congressNationalId) return { parent: "CONGRESS_NATIONAL", id: item.congressNationalId };
  if (item.congressInternationalId) return { parent: "CONGRESS_INTERNATIONAL", id: item.congressInternationalId };
  if (item.eventId) return { parent: "EVENT", id: item.eventId };
  if (item.otherRequestId) return { parent: "AD_PRO_OTHER", id: item.otherRequestId };
  return null;
}

export function revalidate(parent: AdProParent, id: string) {
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
export function canEditItems(user: SessionUser, parent: AdProParent): boolean {
  const m = PARENTS[parent].module;
  return userCan(user, m, "CREATE") || userCan(user, m, "UPDATE") || hasGlobalView(user);
}

export function canAllocate(user: SessionUser, parent: AdProParent): boolean {
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
export function valideursDuPoste(parent: AdProParent): UserRole[] {
  return [...new Set<UserRole>([...rolesWithModule(PARENTS[parent].module, "VALIDATE"), "DIRECTION", "SUPER_ADMIN"])];
}

/** Les rôles du DEMANDEUR de la demande — c'est lui qui décide qui tient le second temps (§118.204). */
export async function demandeurDe(requesterId: string | null | undefined): Promise<Porteur | null> {
  if (!requesterId) return null;
  return prisma.user.findUnique({ where: { id: requesterId }, select: { id: true, role: true, secondaryRole: true } });
}

/**
 * CE QUE CETTE PERSONNE TRANCHE SUR LES POSTES D'ARGENT DE CETTE DEMANDE (§118.204) — la même règle que
 * l'écran (`droitsValidation`), lue sur le demandeur de la DEMANDE, jamais du poste.
 */
export async function peutTrancherSur(user: SessionUser, owner: { parent: AdProParent; id: string }): Promise<DroitsValidation & { demandeur: Porteur | null }> {
  const info = await PARENTS[owner.parent].load(owner.id);
  const demandeur = await demandeurDe(info?.requesterId);
  return { ...droitsValidation(user, demandeur), demandeur };
}

/** Prévenir ceux qui tiennent un temps de validation — et le Super Admin, qui supplée. */
export async function prevenirLeTemps(
  temps: "OPERATIONS" | "MARKETING", demandeur: Porteur | null, titre: string, corps: string, lien: string,
): Promise<void> {
  const roles = [...new Set([...rolesAPrevenir(temps, demandeur), "SUPER_ADMIN"])] as UserRole[];
  await notifyRoles(roles, { type: "VALIDATION_REQUIRED", title: titre, body: corps, link: lien }).catch(sansBloquer("ad-pro-item-actions.prevenirLeTemps.notifyRoles"));
}

export async function audit(user: SessionUser, parent: AdProParent, id: string, action: "CREATE" | "UPDATE" | "DELETE", detail: string) {
  await recordAudit({
    actorId: user.id, module: PARENTS[parent].module, entityType: parent, entityId: id, action, summary: detail,
  }).catch(sansBloquer("ad-pro-item-actions.audit.recordAudit"));
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
export async function refusSiClos(parent: AdProParent, parentId: string, opts: { partir?: boolean } = {}): Promise<string | null> {
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
export function refusDemandeFermee(info: ParentInfo): string | null {
  return info.refusee
    ? "La demande est refusée ou annulée : ses postes ne partent plus (ni soumission, ni accord, ni bon de commande) tant qu'elle n'est pas relancée — par un appel, ou une nouvelle demande, depuis sa fiche."
    : null;
}

/**
 * AUCUN POSTE NE S'AJOUTE NI NE SE SOUMET AVANT LA PRÉVALIDATION (Direction, 27/10/2026 — décision #11) :
 * la demande doit avoir traversé son N+1, le Directeur des opérations et la Direction Marketing.
 */
export function refusAvantPrevalidation(info: ParentInfo): string | null {
  if (info.decided || info.clos) return null;
  return "Les postes s'ajoutent après la prévalidation de la Direction Marketing : la demande doit d'abord passer son N+1, "
    + "le Directeur des opérations puis la Direction Marketing. Aucun budget n'est ouvert avant.";
}

/** La phrase du refus, pour un appelant qui tient déjà l'opération chargée. */
export function refusPostesClos(info: ParentInfo): string | null {
  if (!info.clos) return null;
  if (info.closPhrase) return info.closPhrase;
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
export async function reprojeterMontantDemande(parent: AdProParent, parentId: string): Promise<void> {
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
    // Le champ diffère selon l'opération — sponsoring et congrès/événements n'ont pas nommé la
    // même colonne. Une seule écriture, décidée ici, pour qu'elles ne puissent pas diverger.
    if (total == null) {
      // Aucun montant de circuit (une prévalidation n'en fixe pas, 27/10/2026) : rien à reprojeter.
      // Pas de `return` : la déclaration et la porte du DG, plus bas, suivent les postes quand même.
    } else if (parent === "SPONSORING") {
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
  // LA DÉCLARATION D'INFORMATION MÉDICALE SUIT LES POSTES (§118.191) — son montant est l'estimation
  // de ce qu'ils portent, tant qu'elle n'est pas validée et qu'aucun ordre n'en est né.
  await reporterLesPostesSurLaDeclaration(parent, parentId)
    .catch((err) => console.error("[ad-pro] montant de la déclaration non reporté (non bloquant)", err));
  // LE TOTAL A PU FRANCHIR LE SEUIL (27/10/2026) : le DG est prévenu, une fois par nouveau total.
  await signalerPorteDgSiBesoin(parent, parentId);
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
export function demandeVisible(user: SessionUser, parent: AdProParent, parentId: string): Promise<boolean> {
  return canAccessEntity(user, PARENT_ENTITE[parent], parentId, "VIEW");
}

/**
 * Charge un poste avec son parent résolu — le point d'entrée de toutes les actions par `id`. Hors
 * de la portée de la personne, le poste est INTROUVABLE : la même phrase que l'absence, qui ne
 * confirme pas qu'il existe. L'acteur est un paramètre OBLIGATOIRE : un défaut rouvrirait la porte
 * en silence au prochain appelant qui l'oublierait (§118.127b).
 */
export async function loadItem(id: string, user: SessionUser) {
  const item = await prisma.adProItem.findUnique({
    where: { id },
    select: {
      id: true, label: true, kind: true, supplier: true, amountGranted: true, amountEstimated: true,
      expenseOrderId: true, promoMaterialId: true, status: true, budgetKind: true,
      budgetCategoryId: true, orderStage: true, adminRequestId: true, orderRequestedById: true,
      orderRequestedAt: true, orderDirectionAt: true, orderVisaAmount: true, orderVisaSupplier: true,
      reservationDossierId: true, opsDecidedAt: true, orderNote: true, repartitionId: true,
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
      montantPayeHistorique: true,
    },
  });
  if (!item) return null;
  const owner = parentOf(item);
  if (!owner || !(await demandeVisible(user, owner.parent, owner.id))) return null;
  // UN POSTE HISTORIQUE (intégration des dépenses réelles Ad & Pro 2026) est payé : aucun circuit ne s'y applique.
  return { item, owner, historique: item.montantPayeHistorique != null };
}

/**
 * LE REFUS D'UN GESTE DE CIRCUIT SUR UN POSTE HISTORIQUE — « déjà réalisé et payé » : ni validation, ni devis, ni BC,
 * ni paiement, ni modification de montant. Ce qui reste ouvert : les pièces (sur la demande) et les fiches voyageurs.
 */
export const REFUS_HISTORIQUE = "Ce poste est « Historique 2026 » : déjà réalisé et payé, il ne passe par aucun circuit (ni validation, ni devis, ni bon de commande, ni paiement). Ses pièces se joignent sur la demande.";

/**
 * LES FICHES PAR PERSONNE D'UN POSTE (Direction, 06/10) : ses voyageurs (billetterie) ou ses fiches
 * hôtellerie (hôtellerie). `undefined` hors de ces deux natures — la règle ne s'y applique pas.
 */
export async function compterFichesPersonnes(item: { id: string; kind: AdProItemKind }): Promise<number | undefined> {
  if (porteDesVoyageurs(item.kind)) return prisma.adProVoyageur.count({ where: { itemId: item.id } });
  if (porteDesHebergements(item.kind)) return prisma.adProHebergement.count({ where: { itemId: item.id } });
  return undefined;
}

/**
 * LA PRISE EN CHARGE PASSE-T-ELLE PAR UN SPONSORING INDIRECT ? Un poste né de « Répartir par nature »
 * (`repartitionId`), ou ajouté directement sur un sponsoring de nature INDIRECT. Là, les fiches
 * hôtellerie et voyageur par personne ne sont pas obligatoires (Direction, 06/10).
 */
export function priseEnChargeIndirecte(item: { repartitionId: string | null }, info: ParentInfo | null): boolean {
  return item.repartitionId != null || Boolean(info?.indirect);
}

// ───────────────────── Le bon de commande d'un poste : visa, pièces établies, secrétariat (§118.187) ─────────────────────

export type PosteCharge = NonNullable<Awaited<ReturnType<typeof loadItem>>>["item"];

/** Ce que la règle du visa lit d'un poste chargé — les valeurs AVANT la modification en cours. */
export function etatBcDe(item: PosteCharge): EtatBcPoste {
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
export const SIEGES_CENTRE: UserRole[] = ["GENERAL_MANAGER", "SUPER_ADMIN"];

export const FINANCES_BC: UserRole[] = ["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"];

/**
 * APPLIQUER LE GESTE DU VISA (`ad-pro/bc-poste.ts`) — une écriture CONDITIONNELLE sur l'étape lue :
 * un visa donné, une émission ou un retrait survenus entre la lecture et l'écriture ne se défont pas
 * en silence. Rend la phrase à ajouter au message de l'action, et se tait quand rien n'a bougé
 * (§118.32).
 */
export async function appliquerGesteVisa(
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
    }).catch(sansBloquer("ad-pro-item-actions.appliquerGesteVisa.notifyRoles"));
    // Les Finances avaient reçu « à émettre » : sans ce message, l'ordre partirait sous l'ancien visa.
    await notifyRoles(FINANCES_BC, {
      type: "GENERIC", title: "Bon de commande renvoyé au centre — ne pas l'émettre", body: `${cible} — ${geste.motif}`, link: lien,
    }).catch(sansBloquer("ad-pro-item-actions.appliquerGesteVisa.notifyRoles"));
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
  }).catch(sansBloquer("ad-pro-item-actions.appliquerGesteVisa.notifyRoles"));
  await audit(ctx.user, ctx.owner.parent, ctx.owner.id, "UPDATE", `Bon de commande de « ${item.label} » passé sous le seuil — ${geste.motif}`);
  revalidatePath("/centre-ad-pro");
  return geste.motif;
}

/**
 * LES DEMANDES AU BUREAU DU SECRÉTARIAT du poste (et elles seules) — par l'annulation commune. Rend le
 * nombre de demandes closes et la réserve d'une demande qui ne s'annule pas (paiement déjà réglé).
 */
export async function cloreDemandesAuBureau(
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

// ───────────────────────────── Répartir un sponsoring indirect (§118.175) ─────────────────────────────

/** « imprimerie 400 000 DZD, hôtellerie 600 000 DZD » — la phrase de l'audit et du message, une fois. */
export function resumeRepartition(lignes: readonly LigneRepartition[]): string {
  return lignes.map((l) => `${ITEM_KIND_LABELS[l.kind].toLowerCase()} ${l.montant.toLocaleString("fr-FR")} DZD`).join(", ");
}

/** Les lignes lues, prêtes à écrire : le libellé de chaque poste se compose ici, une fois. */
export function postesRepartis(lignes: readonly LigneRepartition[]): PosteReparti[] {
  return lignes.map((l) => ({ kind: l.kind, label: libelleLigne(ITEM_KIND_LABELS[l.kind], l.precision), montant: l.montant, payeA: l.payeA }));
}

/**
 * CE QUE LE COMPOSEUR ENVOIE pour un BC de poste — la MÊME lecture pour « Modifier le BC » (révision d'un BC émis) et pour la
 * correction de l'APERÇU (brouillon, sans numéro) : `lireSaisieDuComposeur` (`bons-de-commande/saisie-composeur.ts`), partagée
 * avec le Bureau du secrétariat (Direction, 14/10/2026 — « chaque détail peut être modifié dans le BC »). Une clé absente garde
 * sa valeur ; présente et vide, elle l'efface.
 */
export function lireModificationsDuBc(formData: FormData): ModificationsDocument {
  return lireSaisieDuComposeur(formData);
}

// ───────────────────────── Validation du poste (Direction) ─────────────────────────

/** Trace une décision SANS écraser la précédente : le 3ᵉ tour ne doit pas effacer les deux refus. */
export async function recordDecision(itemId: string, decision: AdProItemStatus, note: string | null, amount: number | null, byId: string) {
  await prisma.adProItemDecision.create({
    data: { itemId, decision, note, amount, byId },
  }).catch(sansBloquer("ad-pro-item-actions.recordDecision.adProItemDecision"));
}

// ───────────────────────── Devis et facture : demandes au secrétariat ─────────────────────────

/** Les demandes de pièce OUVERTES d'un poste, lues par le lien CANONIQUE. */
export async function piecesOuvertes(itemId: string): Promise<NaturePieceSecretariat[]> {
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


/** Envoie (ou met à jour) la demande de pièce « bon de commande » chez l'assistante, et la prévient. */
export async function envoyerDemandeBC(i: {
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
  }).catch(sansBloquer("ad-pro-item-actions.envoyerDemandeBC.notifyUser"));
  revalidatePath("/pieces");
  return d.id;
}

/** Le libellé lisible d'un article du stock (« Fiche posologique — Nivolex »). */
export async function libellesArticles(ids: readonly string[]): Promise<Map<string, { libelle: string; famille: PromoFamille }>> {
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

// ───────────────────────── Billetterie : voyageurs et réservation (§118.175) ─────────────────────────

/** Le poste « billetterie » d'un voyageur, avec son opération — le point d'entrée des actions par voyageur. */
export async function chargerVoyageur(id: string, user: SessionUser) {
  const v = await prisma.adProVoyageur.findUnique({
    where: { id },
    select: { id: true, itemId: true, nom: true, prenom: true, segments: true, villeDepart: true, villeArrivee: true, dateDepart: true, dateRetour: true, notes: true, trajet: true, transport: true },
  });
  if (!v) return null;
  const found = await loadItem(v.itemId, user);
  return found ? { voyageur: v, ...found } : null;
}

/**
 * UN CHANGEMENT APRÈS LA DEMANDE DE RÉSERVATION SE DIT DANS LE SUJET — « on modifie les dates
 * plus tard ». Sans cette ligne, l'assistante réserverait sur les dates d'avant, et la flexibilité
 * demandée se paierait en billets à changer. Rend la phrase à ajouter au message de l'action.
 */
export async function signalerAuSujet(item: { id: string }, auteurId: string, corps: string): Promise<string> {
  const poste = await prisma.adProItem.findUnique({ where: { id: item.id }, select: { reservationDossierId: true, label: true } });
  if (!poste?.reservationDossierId) return "";
  const ecrit = await ecrireDansLeSujet({ dossierId: poste.reservationDossierId, authorId: auteurId, body: `${poste.label} — ${corps}` });
  return ecrit ? " L'assistante est prévenue dans le sujet de réservation." : " Le sujet de réservation n'existe plus : redemandez la réservation pour le rouvrir.";
}

/**
 * LA MÊME PIÈCE RETENUE POUR PLUSIEURS VOYAGEURS ne se compte qu'une fois : chaque devis → la pièce qu'il copie (lui-même s'il
 * n'en copie aucune), lue par la même règle que la carte du BC (`devisMisAPart`).
 */
export async function pieceComptee(itemId: string): Promise<(pieceId: string) => string> {
  const vues = (await devisDesPostes([itemId])).get(itemId) ?? [];
  const copieDe = new Map(vues.filter((v) => v.miseAPart?.motif === "COPIE").map((v) => [v.pieceId, v.miseAPart!.de as string]));
  return (pieceId) => copieDe.get(pieceId) ?? pieceId;
}

/** La phrase du dépassement, sur l'ensemble des devis retenus du poste (tous voyageurs) — chaque pièce une fois. */
export async function depassementDuPoste(itemId: string, accorde: unknown): Promise<string | null> {
  const [retenus, piece] = await Promise.all([
    prisma.adProVoyageurDevis.findMany({
      where: { retenuLe: { not: null }, voyageur: { itemId }, piece: { legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } } },
      select: { piece: { select: { legalDocument: { select: { id: true, amount: true } } } } },
    }),
    pieceComptee(itemId),
  ]);
  const uniques = new Map(retenus.map((r) => [piece(r.piece.legalDocument.id), r.piece.legalDocument.amount]));
  return depassementDevisRetenus(
    [...uniques.values()].map((m) => (m != null ? toNumber(m) : null)),
    accorde != null ? toNumber(accorde) : null,
  );
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
export const filePoste = (itemId: string) => `ad-pro-bc:${itemId}`;

/** Le devis d'un poste, tel que la carte le voit — `null` s'il n'est plus rattaché au poste ou s'il est annulé. */
export async function devisDuPoste(itemId: string, pieceId: string | null) {
  if (!pieceId) return null;
  return ((await devisDesPostes([itemId])).get(itemId) ?? []).find((d) => d.pieceId === pieceId && !d.annule) ?? null;
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
export async function validerAutomatiquementLesLignesLues(userId: string, itemId: string, pieceId: string): Promise<number> {
  const devis = await devisDuPoste(itemId, pieceId);
  if (!devis || !devis.structure || devis.bc || devis.ecartTotal || devis.lignes.length === 0) return 0;
  // LA MÊME PIÈCE DÉPOSÉE DEUX FOIS (ou une proposition écartée) ne valide rien d'office : ses lignes seraient comptées
  // deux fois. Un contenu identique à un autre devis, sans preuve que c'est la même pièce, est un doute — rien non plus.
  if (devis.miseAPart || devis.doublonProbableDe) return 0;
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
