import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { companyScopedWhere, ficheScopedWhere, platformScope } from "@/lib/company";
import {
  hasGlobalView, scopeAdminRequests, scopeCongressIntl, scopeCongressNational, scopeSales, scopeSponsoring, userCan, type SessionUser,
} from "@/lib/rbac";
import { BC_DE_POSTE_NON_SIGNE, legalReaderWhere, legalViewScope, PURCHASE_CHAIN_KINDS, type LegalViewScope } from "@/lib/lecteurs/legal";
import type { LegalDocKind } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PÉRIMÈTRE D'UNE LISTE — lu par l'ÉCRAN et par la RECHERCHE GLOBALE, jamais recopié.
 *
 * ── LE DÉFAUT, MESURÉ (§118.177) ─────────────────────────────────────────────────────────
 *
 * La recherche globale (palette ⌘K, page /search) composait ses propres filtres, famille par
 * famille, à côté de ceux des écrans. Recensé sur ses vingt-trois familles : QUINZE ignoraient le
 * cloisonnement par entité que leur liste applique. Un salarié d'Adventum tapait trois lettres et
 * lisait les sponsorings, les écritures comptables, les salariés, les ventes, les commandes
 * logistiques, les praticiens, les appels d'offres, les contrats et les courriers de Pharmagène —
 * et, sur la moitié de ces familles, la fiche s'ouvrait ensuite en entier.
 *
 * La cause n'était pas quinze oublis : c'était DEUX écritures de la même règle. La recherche
 * reprenait la portée par ligne du module (`scopeSales`…) et s'arrêtait là ; l'écran, lui, la
 * composait avec l'entité. Deux clauses pour une seule question finissent toujours par diverger,
 * et c'est la plus large qui fuit (§118.5, §118.71).
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * Chaque fonction ci-dessous rend EXACTEMENT ce que l'écran de liste montre, sans ses filtres
 * d'affichage (dossier ouvert, statut choisi…). L'écran l'appelle pour charger sa liste ; la
 * recherche l'appelle pour chercher dedans. Un écran qui se resserre demain resserre la recherche
 * le même jour, sans que personne y pense. `visibilite-listes.test.ts` vérifie les deux points
 * d'appel (§118.49) et rejoue chaque famille avec un lecteur SANS vue globale (§118.104).
 *
 * ── DEUX FILTRES D'ENTITÉ, ET C'EST L'ÉCRAN QUI CHOISIT ──────────────────────────────────
 *
 * `platformScope` (strict) exclut une ligne sans entité des vues cloisonnées ; `companyScopedWhere`
 * la garde exprès pour qu'on la rattache (§118.154). Les deux coexistent depuis longtemps, chacun
 * avec sa raison : la recherche reprend celui de SON écran, famille par famille, et ne devient ni
 * plus stricte (un refus à tort, §118.27) ni plus large (une fuite) que lui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * `/sponsoring` — l'entité au sens strict, et la portée par ligne du délégué (§118.185, I4) : il
 * dépose SES demandes et ne voit qu'elles. Composées en `AND` (§118.133), jamais étalées.
 */
export async function clauseSponsoringsVisibles(user: SessionUser): Promise<Prisma.SponsoringRequestWhereInput> {
  return { AND: [scopeSponsoring(user), (await platformScope(user.id)) as Prisma.SponsoringRequestWhereInput] };
}

/**
 * `/formations` — QUI VOIT UNE FORMATION (§118.184).
 *
 * La page listait TOUTES les formations de la société à tout salarié — montants demandés et accordés,
 * motifs, pièces (audit 360°, S4). Une demande de formation est un dossier de PERSONNE : la voient
 * celles et ceux qui la portent ou la tranchent.
 *   • les RH (qui la valident ou la gèrent) et la vue globale : toutes, dans l'entité au sens strict ;
 *   • sinon : la sienne, celles où l'on est participant, celles dont on est le N+1 enregistré, et
 *     celles de ses subordonnés DIRECTS — la liste où l'on tranche l'étape « N+1 ». Le reste de la
 *     chaîne au-dessus ouvre la FICHE (`canAccessEntity`), comme il peut trancher (`deciderFor`).
 */
export async function clauseFormationsVisibles(user: SessionUser): Promise<Prisma.TrainingWhereInput> {
  const rh = userCan(user, "TRAINING", "VALIDATE") || userCan(user, "TRAINING", "UPDATE");
  if (rh || hasGlobalView(user)) return (await platformScope(user.id)) as Prisma.TrainingWhereInput;
  const moi = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  // L'INTÉRIMAIRE (I18) voit ce qui attend la marche du N+1 qu'il remplace — et cela seulement :
  // l'historique des formations de l'équipe de l'absent n'est pas l'objet d'un intérim.
  const absents = await standInForUserIds(user.id);
  const fichesAbsents = absents.length
    ? (await prisma.employee.findMany({ where: { userId: { in: absents } }, select: { id: true } })).map((e) => e.id)
    : [];
  return {
    OR: [
      { requesterId: user.id },
      { participants: { some: { userId: user.id } } },
      ...(moi ? [{ managerId: moi.id }, { requester: { employee: { managerId: moi.id } } }] : []),
      ...(fichesAbsents.length
        ? [{
            status: "PENDING" as const, stage: "MANAGER" as const,
            OR: [{ managerId: { in: fichesAbsents } }, { requester: { employee: { managerId: { in: fichesAbsents } } } }],
          }]
        : []),
    ],
  };
}

/** Le livre des Finances (`getFinanceData`, `getComptaData`) — l'entité au sens strict. */
export async function clauseEcrituresVisibles(userId: string): Promise<Prisma.FinanceTransactionWhereInput> {
  return (await platformScope(userId)) as Prisma.FinanceTransactionWhereInput;
}

/** La liste des salariés (`getRhData`, `/rh` et `/rh/equipe`) — l'entité au sens strict. */
export async function clauseSalariesVisibles(userId: string): Promise<Prisma.EmployeeWhereInput> {
  return (await platformScope(userId)) as Prisma.EmployeeWhereInput;
}

/**
 * `/sales/historique` — l'ancienne saisie manuelle, dans l'entité (les ventes sans entité restent rattachables). Le module
 * `SALES` est retiré du service : l'historique se lit désormais avec « Ventes PCH » (lecture seule, toutes les lignes de
 * l'entité) ; la portée de `SALES` ne sert plus qu'au cas où le module serait remis en service.
 */
export async function clauseVentesVisibles(user: SessionUser): Promise<Prisma.SaleWhereInput> {
  return companyScopedWhere(user.id, userCan(user, "PCH_VENTES", "VIEW") ? {} : scopeSales(user));
}

/** `/logistics` — l'entité ; une commande sans entité reste visible pour qu'on la rattache. */
export async function clauseCommandesLogistiqueVisibles(userId: string): Promise<Prisma.LogisticsOrderWhereInput> {
  return companyScopedWhere<Prisma.LogisticsOrderWhereInput>(userId, {});
}

/** Le bureau du secrétariat (`getRequestList`) — la portée du module ET l'entité stricte. */
export async function clauseDemandesSecretariatVisibles(user: SessionUser): Promise<Prisma.AdministrativeRequestWhereInput> {
  return { AND: [scopeAdminRequests(user), (await platformScope(user.id)) as Prisma.AdministrativeRequestWhereInput] };
}

/** Les prises en charge (`getCongressList`) — la portée du module ET l'entité stricte. */
export async function clauseCongresInternationauxVisibles(user: SessionUser): Promise<Prisma.CongressInternationalWhereInput> {
  return { AND: [scopeCongressIntl(user), (await platformScope(user.id)) as Prisma.CongressInternationalWhereInput] };
}

export async function clauseCongresNationauxVisibles(user: SessionUser): Promise<Prisma.CongressNationalWhereInput> {
  return { AND: [scopeCongressNational(user), (await platformScope(user.id)) as Prisma.CongressNationalWhereInput] };
}

/** `/events` (`getEvents`) — l'entité au sens strict. */
export async function clauseEvenementsVisibles(userId: string): Promise<Prisma.EventWhereInput> {
  return (await platformScope(userId)) as Prisma.EventWhereInput;
}

/**
 * `/pch` (`getPchTenders`) — l'entité ; un marché sans entité reste visible pour qu'on le rattache.
 *
 * LA FICHE lit TOUTES les sociétés auxquelles la personne a droit, pas seulement celle que la barre
 * supérieure affiche (§118.184 — audit 360°, S11) : la fiche, l'export et les gestes sur un marché ne
 * lisaient AUCUNE entité — un gestionnaire PCH d'Adventum ouvrait, exportait et modifiait le marché
 * de Pharmagène par son identifiant. Suivre la sélection d'en-tête sur une fiche ferait refuser un
 * lien de notification dès qu'on regarde une autre société (§118.27) : c'est la règle de toutes les
 * fiches cloisonnées (`ficheScopedWhere`).
 */
export async function clauseMarchesPchVisibles(userId: string, pour: "liste" | "fiche" = "liste"): Promise<Prisma.PchTenderWhereInput> {
  if (pour === "liste") return companyScopedWhere<Prisma.PchTenderWhereInput>(userId, {});
  const entite = await ficheScopedWhere<Prisma.PchTenderWhereInput>(userId, {});
  // Sans restriction d'entité, la clause vide est rendue TELLE QUELLE. Prisma ÉCARTE un `{}` placé dans un
  // `OR` au lieu de le lire « toutes les lignes » — mesuré : `OR: [{}, { responsibleId }]` ne rendait au
  // Super Admin que les marchés dont il est responsable, et chaque geste sur un marché lui était refusé.
  if (Object.keys(entite).length === 0) return entite;
  // Le RESPONSABLE et l'AUTEUR d'un marché le rouvrent même d'une autre société : le formulaire propose
  // tous les comptes actifs comme responsable, et le rappel d'échéance les prévient — leur fermer la
  // fiche ferait d'une notification une impasse (§118.63).
  return { OR: [entite, { responsibleId: userId }, { createdById: userId }] };
}

/**
 * Les bons de commande PCH n'ont pas d'écran à eux : ils vivent dans la fiche de LEUR marché, et
 * la liste des marchés les charge avec lui. Un bon de commande est donc visible quand son marché
 * l'est — il n'a pas d'entité propre, il hérite de celle du marché.
 */
export async function clauseBonsDeCommandePchVisibles(userId: string, pour: "liste" | "fiche" = "liste"): Promise<Prisma.PchOrderWhereInput> {
  return { tender: await clauseMarchesPchVisibles(userId, pour) };
}

/** `/courriers` — l'entité ; un pli sans entité reste visible pour qu'on le rattache. */
export async function clauseCourriersVisibles(userId: string): Promise<Prisma.MailEntryWhereInput> {
  return companyScopedWhere<Prisma.MailEntryWhereInput>(userId, {});
}

/**
 * `/legal` — la PORTÉE de la personne (tout le registre, ou la chaîne d'achat seule pour les
 * Finances), les LECTEURS désignés, puis l'entité.
 *
 * `where` vaut `null` quand la liste ne montre rien : sans droit (`NONE`), ou pour qui n'a que le
 * module « Bons de commande » — la liste le renvoie vers SON écran, elle ne lui ouvre pas le
 * registre. La portée voyage avec la clause parce que l'écran en a besoin pour s'afficher : la
 * calculer deux fois, c'est l'écrire deux fois.
 */
export async function perimetreLegal(user: SessionUser): Promise<{ portee: LegalViewScope; where: Prisma.LegalDocumentWhereInput | null }> {
  const portee = legalViewScope({
    onLegal: userCan(user, "LEGAL", "VIEW"),
    onFinances: userCan(user, "FINANCES", "VIEW"),
    onBonsDeCommande: userCan(user, "PURCHASE_ORDERS", "VIEW"),
  });
  if (portee === "NONE" || portee === "BONS_DE_COMMANDE") return { portee, where: null };
  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const nature: Prisma.LegalDocumentWhereInput = portee === "PURCHASE_CHAIN"
    ? { kind: { in: [...PURCHASE_CHAIN_KINDS] as LegalDocKind[] } }
    : {};
  // LE BC D'UN POSTE AVANT SA SIGNATURE (Direction, 11/2026) : au registre, seuls ses signataires (et le Super Admin) le voient.
  const signataire = user.role === "SUPER_ADMIN" || user.secondaryRole === "SUPER_ADMIN" || userCan(user, "PURCHASE_ORDERS", "UPDATE");
  const where = await companyScopedWhere<Prisma.LegalDocumentWhereInput>(user.id, {
    AND: [nature, ...(lecteurs ? [lecteurs as Prisma.LegalDocumentWhereInput] : []), ...(signataire ? [] : [{ NOT: BC_DE_POSTE_NON_SIGNE }])],
  });
  return { portee, where };
}

/**
 * La messagerie : les conversations dont la personne est membre ACTIF. La liste
 * (`getConversationSummaries`) et la fiche (`getConversationDetail`) exigent `leftAt: null` ;
 * la recherche ne le demandait pas, et un ancien membre retrouvait le canal par son titre — et
 * les messages par leur contenu, y compris ceux postés APRÈS son départ.
 */
export function clauseConversationsVisibles(userId: string): Prisma.ConversationWhereInput {
  return { members: { some: { userId, leftAt: null } } };
}

export function clauseMessagesVisibles(userId: string): Prisma.MessageWhereInput {
  return { deletedAt: null, conversation: clauseConversationsVisibles(userId) };
}
