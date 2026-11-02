import { isInvoice } from "@/lib/labels";

/**
 * QUI PEUT OUVRIR UN DOCUMENT LÉGAL — le déposant désigne ses lecteurs.
 *
 * Avoir le module Legal, ce n'est pas avoir le droit de lire chaque engagement de la société.
 * Un bail, un protocole d'accord, un contrat de cadre concernent trois personnes ; les rendre
 * visibles de tout le module, c'est publier des montants et des clauses à des gens qui n'ont
 * aucune raison de les connaître — et c'est pourquoi, en pratique, ces pièces ne sont jamais
 * déposées et restent dans une boîte mail.
 *
 * QUATRE PORTES, ET QUATRE SEULEMENT :
 *   1. les LECTEURS désignés ;
 *   2. le DÉPOSANT — on ne se ferme pas la porte du document qu'on vient de verser ;
 *   3. le SUPER ADMIN — il arbitre, et un document que personne ne peut plus ouvrir (déposant
 *      parti, lecteurs désactivés) serait perdu ;
 *   4. AUCUN lecteur désigné → le document reste ouvert au module, comme avant.
 *
 * La quatrième n'est pas un trou : c'est le seul défaut sûr pour l'historique. Deviner des
 * listes de lecteurs sur des milliers de documents existants aurait fermé à leurs utilisateurs
 * des pièces dont personne n'aurait su reconstituer la liste.
 *
 * ⚠️ La restriction s'ajoute au CLOISONNEMENT PAR ENTITÉ, elle ne le remplace pas : être lecteur
 * d'un document de Pharmagène ne donne pas accès au reste de Pharmagène.
 *
 * Module PUR — testé, sans base de données.
 */

export interface LegalReaderContext {
  /** Le spectateur. */
  viewerId: string;
  /** Vue groupe / arbitrage — le Super Admin. */
  isSuperAdmin: boolean;
}

export interface LegalDocumentAccess {
  /** Qui a déposé le document (`null` si le compte a été supprimé). */
  createdById: string | null;
  /** Lecteurs désignés. Vide = document ouvert au module. */
  readerIds: string[];
}

/** Le document est-il RESTREINT, c'est-à-dire réservé à une liste nommée ? */
export function isRestricted(doc: LegalDocumentAccess): boolean {
  return doc.readerIds.length > 0;
}

/** Ce spectateur peut-il ouvrir ce document ? (le droit de module est vérifié à part) */
export function canReadLegalDocument(ctx: LegalReaderContext, doc: LegalDocumentAccess): boolean {
  if (ctx.isSuperAdmin) return true;
  if (!isRestricted(doc)) return true;
  if (doc.createdById && doc.createdById === ctx.viewerId) return true;
  return doc.readerIds.includes(ctx.viewerId);
}

/**
 * Le filtre Prisma des documents lisibles — la MÊME règle, côté requête.
 *
 * `null` signifie « aucune restriction à poser » (Super Admin). Sinon, un `OR` : les documents
 * sans lecteur désigné, ceux que j'ai déposés, et ceux où l'on m'a nommé.
 *
 * Ce filtre doit être composé AVEC le cloisonnement d'entité, jamais à sa place.
 */
export function legalReaderWhere(ctx: LegalReaderContext): {
  OR: ({ readers: { none: Record<string, never> } } | { createdById: string } | { readers: { some: { userId: string } } })[];
} | null {
  if (ctx.isSuperAdmin) return null;
  return {
    OR: [
      { readers: { none: {} } },
      { createdById: ctx.viewerId },
      { readers: { some: { userId: ctx.viewerId } } },
    ],
  };
}

/**
 * La liste de lecteurs à ENREGISTRER, à partir de ce que le formulaire a envoyé.
 *
 * Le déposant est retiré s'il s'y est mis : il a déjà accès par la porte 2, et l'inscrire
 * ferait croire qu'en se retirant il se fermerait le document. Doublons écartés.
 */
export function normalizeReaderIds(raw: string[], createdById: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    const v = id.trim();
    if (!v || v === createdById || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * LES LECTEURS DE LA SUITE d'un document renouvelé (audit 360°, S7). Un document OUVERT (aucun lecteur)
 * le reste ; un document RESTREINT garde ses lecteurs, et son auteur d'origine en devient un — sur la
 * suite, l'auteur est la personne qui renouvelle, et l'auteur d'origine perdrait sinon le contrat qu'il
 * a lui-même enregistré. La personne qui renouvelle n'y figure pas : elle est l'auteur de la suite.
 */
export function lecteursDeLaSuite(lecteurs: readonly string[], auteurOrigine: string | null, auteurSuite: string): string[] {
  if (lecteurs.length === 0) return [];
  return normalizeReaderIds([...lecteurs, ...(auteurOrigine ? [auteurOrigine] : [])], auteurSuite);
}

/**
 * QUI GÈRE LES ACCÈS D'UN DOCUMENT — le déposant, et le Super Admin.
 *
 * Pas celui qui a le droit d'ÉCRITURE sur le module : pouvoir corriger une date d'échéance n'est
 * pas pouvoir s'ouvrir un document qu'on ne devrait pas lire. Ce serait la porte dérobée exacte
 * que la restriction ferme — il suffirait de s'ajouter soi-même à la liste.
 *
 * Cette règle vivait DANS l'action. Elle en sort pour que l'écran pose exactement la même
 * question : un bouton qu'on voit et qui refuse ensuite est pire qu'un bouton absent, parce
 * qu'on cherche la panne au lieu de demander à la bonne personne.
 */
export function canManageLegalReaders(
  ctx: LegalReaderContext,
  doc: { createdById: string | null },
): boolean {
  return ctx.isSuperAdmin || (doc.createdById !== null && doc.createdById === ctx.viewerId);
}

/** À qui s'adresser quand on ne gère pas soi-même les accès. Nommer évite l'aller-retour. */
export function readersManagerHint(depositorName: string | null): string {
  return depositorName
    ? `Seul ${depositorName}, qui a déposé ce document, ou un Super Admin peut en changer les accès.`
    : "Seul le déposant du document, ou un Super Admin, peut en changer les accès.";
}

/** Phrase d'état, telle qu'elle s'affiche sur la fiche et dans la liste. */
export function readersCaption(doc: LegalDocumentAccess): string {
  const n = doc.readerIds.length;
  if (n === 0) return "Visible de tout le module Legal";
  return `Restreint — ${n} lecteur${n > 1 ? "s" : ""} désigné${n > 1 ? "s" : ""} (plus le déposant)`;
}

/**
 * CE QU'UNE PERSONNE VOIT DU REGISTRE.
 *
 * ── LE PIÈGE DE LA CENTRALISATION ───────────────────────────────────────────────────────────
 *
 * Fondre les factures dans Legal aurait pu, sans qu'on y pense, FERMER LA PORTE à la
 * comptabilité : elle venait lire ce qui reste à payer dans un écran Finances, et le registre
 * des engagements ne lui est pas ouvert. Centraliser ne doit rien retirer à personne.
 *
 * L'ouvrir en grand aurait été pire : le registre porte des baux, des contrats de cadre, des
 * protocoles d'accord — des pièces qu'on ne lit pas parce qu'on tient la trésorerie.
 *
 * D'où trois portées, et pas deux. Elle est appliquée PAR LE SERVEUR, dans la requête, et non
 * par un filtre d'écran : un filtre d'écran se retire dans le navigateur.
 */
export type LegalViewScope = "ALL" | "PURCHASE_CHAIN" | "BONS_DE_COMMANDE" | "NONE";

/**
 * LES NATURES QUE LA COMPTABILITÉ VOIT ET ÉCRIT : les factures, et les bons de commande dont
 * elles découlent. Décision de la Direction (septembre 2026) : les Finances COMPOSENT les factures
 * ET les bons de commande de la société — le bon de commande de référence remis avec la facture
 * est le leur, et l'on ne peut pas émettre une pièce qu'on n'aurait pas le droit de retrouver au
 * registre. Contrats, baux, conventions, assurances restent fermés : une liste FERMÉE, en un
 * endroit, lue par la liste, la fiche, l'action serveur et Adam. L'AVOIR (§118.195) en fait partie : il corrige une
 * facture que les Finances émettent, et l'on ne peut pas émettre une correction qu'on n'aurait pas le droit de lire.
 */
export const PURCHASE_CHAIN_KINDS: readonly string[] = ["INVOICE", "PURCHASE_ORDER", "CREDIT_NOTE"];

/**
 * LA TROISIÈME PORTE, ET LA PLUS ÉTROITE : le module « Bons de commande » (§118.176). Le Super
 * Admin l'ouvre « à qui il veut » — y compris à quelqu'un qui n'a ni Legal ni les Finances. Il faut
 * alors qu'il puisse LIRE ce qu'on lui demande de signer : la fiche du bon de commande, ses
 * fichiers. Sans cette porte, la file lui montrerait des pièces qu'aucun clic n'ouvre, et une
 * signature sur une pièce qu'on ne peut pas lire n'est pas une signature (§118.149e). Elle n'ouvre
 * QUE les bons de commande — pas les factures, pas le reste du registre.
 *
 * Les trois droits sont OBLIGATOIRES : un défaut silencieux (« pas de troisième porte ») ferait
 * redevenir la file une impasse chez le prochain appelant qui l'oublierait (§118.127b).
 */
export function legalViewScope(rights: { onLegal: boolean; onFinances: boolean; onBonsDeCommande: boolean }): LegalViewScope {
  if (rights.onLegal) return "ALL";
  if (rights.onFinances) return "PURCHASE_CHAIN";
  if (rights.onBonsDeCommande) return "BONS_DE_COMMANDE";
  return "NONE";
}

/** Une pièce est-elle dans la portée de cette personne ? La fiche le vérifie sur la pièce elle-même. */
export function legalKindVisible(scope: LegalViewScope, kind: string): boolean {
  if (scope === "ALL") return true;
  if (scope === "PURCHASE_CHAIN") return PURCHASE_CHAIN_KINDS.includes(kind);
  if (scope === "BONS_DE_COMMANDE") return kind === "PURCHASE_ORDER";
  return false;
}

/**
 * PEUT-ON ÉCRIRE CETTE PIÈCE ?
 *
 * La comptabilité tient les FACTURES — les enregistrer, les corriger, marquer leur règlement — et
 * les BONS DE COMMANDE qu'elle émet (voir `PURCHASE_CHAIN_KINDS`). Elle ne tient pas le reste du
 * registre. La règle vit ici, elle est donc la même pour l'écran,
 * pour l'action serveur et pour Adam ; trois copies auraient fini par diverger, et la divergence
 * d'un contrôle d'accès s'appelle une faille.
 */
export function legalWriteAllowed(input: { onLegal: boolean; onFinances: boolean; kind: string }): boolean {
  if (input.onLegal) return true;
  return input.onFinances && (isInvoice(input.kind) || PURCHASE_CHAIN_KINDS.includes(input.kind));
}

/**
 * LE BC D'UN POSTE AD & PRO N'ENTRE DANS LEGAL QU'UNE FOIS SIGNÉ (Direction, 11/2026). Avant la signature, il vit sur le poste
 * et sur la page Bons de commande : seuls ceux qui le SIGNENT (et le Super Admin) l'ouvrent au registre. La clause écarte ces
 * pièces pour les autres ; `bcDePosteAvantSignature` dit la même chose d'une pièce déjà lue.
 */
export const BC_DE_POSTE_NON_SIGNE = { kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", signedAt: null } as const;

export function bcDePosteAvantSignature(doc: { kind: string; sourceType: string | null; signedAt: Date | string | null }): boolean {
  return doc.kind === "PURCHASE_ORDER" && doc.sourceType === "AD_PRO_ITEM" && doc.signedAt === null;
}
