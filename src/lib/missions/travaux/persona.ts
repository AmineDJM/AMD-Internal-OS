import type { CatalogueTravail, FormatLivrable, PersonaTravail } from "@/lib/missions/travaux/plan";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT D'UNE PERSONA (J2, décision 0016) — ce que le moteur des travaux attend d'Adam ou de
 * l'Assistant IA, sans jamais les nommer.
 *
 * Même raison que `missions/ports.ts` : le Mission Runtime est une FAÇADE de l'ERP. Importer le
 * catalogue d'un assistant ferait de lui un morceau de cet assistant, et le second ne pourrait plus
 * s'en servir. La persona est INJECTÉE par le point de composition (la tâche de fond, les actions de
 * l'écran) ; chaque assistant fournit la sienne de son côté de la frontière.
 *
 * LA RÈGLE QUI COMPTE : tout ce qui touche aux DROITS est RELU à chaque appel. Aucune de ces
 * fonctions ne reçoit un utilisateur en mémoire — seulement un identifiant —, si bien qu'un accès
 * retiré dans la console à 14 h s'applique à l'étape de 14 h 01 d'un travail lancé la veille.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueLecture = { ok: true; sortie: unknown } | { ok: false; erreur: string; reessayable: boolean };
export type IssueGeste = { ok: true; resultat: unknown; message?: string; lien?: string } | { ok: false; erreur: string };
export type IssueRaisonnement =
  | { ok: true; texte: string; usage: { entree: number; sortie: number; coutUsd: number | null } }
  /** `plafond` : le plafond de la personne (jour) a refusé l'appel — le travail DORT, il n'échoue pas. */
  | { ok: false; erreur: string; plafond?: boolean };

export interface PlafondsTravail {
  /** Le plafond d'un travail, pour cette personne (console : personne, puis rôle, puis défaut). */
  travailUsd: number;
  mensuelUsd: number;
  /** Ce que la personne a déjà dépensé en IA ce mois-ci (journal de consommation). */
  depenseMoisUsd: number;
  /** Le plafond de JETONS du jour est atteint : rien ne part avant demain. */
  jourAtteint: boolean;
}

/** Une pièce du Drive, désignée et nommée. */
export interface PieceTravail { nodeId: string; nom: string }

/** Le document qu'un livrable a déposé au Drive de la personne (J8). */
export interface DocumentLivrable {
  nodeId: string;
  nom: string;
  format: FormatLivrable;
  lien: string;
  /** Une conversion (PDF) confiée au worker : le PDF arrivera à côté du Word. */
  enFile?: boolean;
  note?: string | null;
}

/**
 * LES PIÈCES (J8) — ce que la délégation fait du Drive, sous les droits RELUS de chacun. Le moteur ne lit
 * jamais un fichier : il demande ce qu'une personne peut voir, et fait accorder la LECTURE d'une pièce.
 */
export interface PortPiecesTravail {
  /** Parmi `nodeIds`, ceux que `userId` peut voir maintenant — avec leur nom. Les autres sont écartés. */
  visibles(userId: string, nodeIds: readonly string[]): Promise<PieceTravail[]>;
  /** Accorde la LECTURE de ces pièces à `userId` (jamais par-dessus un droit existant), au nom de `parId`. */
  partager(nodeIds: readonly string[], userId: string, parId: string): Promise<void>;
}

export interface PersonaTravaux {
  persona: PersonaTravail;
  /** Le nom sous lequel la persona signe (« Assistant IA », « Adam »). */
  nom: string;
  /** La personne peut-elle ENCORE faire travailler cette persona ? `null` = oui ; sinon le motif, dit à la personne. */
  refusTravail(principalId: string): Promise<string | null>;
  /** Ce que la persona sait lire et faire pour CETTE personne, maintenant. */
  catalogue(principalId: string): Promise<CatalogueTravail>;
  lire(principalId: string, outil: string, entree: Record<string, unknown>): Promise<IssueLecture>;
  /** Le droit au geste, RELU juste avant d'agir (famille ouverte dans la console, droit d'écran). `null` = permis. */
  refusGeste(principalId: string, geste: string): Promise<string | null>;
  /** `contexte` (J7) : le travail, l'étape et la clé du geste — ils entrent au journal des effets. */
  ecrire(principalId: string, geste: string, entree: Record<string, unknown>, contexte?: { travailId: string; etape: string; cle: string }): Promise<IssueGeste>;
  raisonner(principalId: string, d: { consigne: string; texte: string; travailId: string }): Promise<IssueRaisonnement>;
  plafonds(principalId: string): Promise<PlafondsTravail>;
  /** J8 : les pièces du Drive (délégation) — droits relus à chaque appel. */
  pieces: PortPiecesTravail;
  /** J8 : le responsable hiérarchique (N+1) d'une personne — l'escalade d'une attente. `null` = aucun. */
  responsable(userId: string): Promise<string | null>;
  /**
   * J8 : dépose le livrable au Drive de la personne, en VRAI document (Word, PDF, Excel), inscrit à la
   * Bibliothèque. `reprise` : un dépôt précédent a peut-être eu lieu (processus tué) — le retrouver avant
   * d'en créer un second. `cle` désigne CE livrable de CE travail, d'un passage à l'autre.
   */
  deposerLivrable(principalId: string, d: {
    travailId: string; cle: string; titre: string; contenu: string; format: FormatLivrable; reprise: boolean;
  }): Promise<{ ok: true; document: DocumentLivrable } | { ok: false; erreur: string }>;
}
