/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE DE L'ENRICHISSEMENT — la part PURE : clés, identifiants déterministes, reprise après échec.
 *
 * Une pièce déposée devient une ligne `TacheEnrichissement` par (empreinte, rattachement) — la même
 * clé que celle de `PIECE_DEPOSEE` (`depot.ts`). Le passage (`traitement.ts`) la prend, la traite et
 * la ferme ; ce module dit seulement COMMENT nommer et QUAND réessayer. Aucun import lourd.
 *
 * ── L'IDEMPOTENCE TIENT AUX IDENTIFIANTS ─────────────────────────────────────────────────────
 *
 * Rejouer un passage (processus tombé, lot relancé, deux instances) ne doit rien dupliquer. Plutôt
 * qu'un « regarder puis écrire » qui se fait doubler, chaque écriture vise un identifiant DÉRIVÉ de
 * ce qui la cause : la `Piece` de l'empreinte, l'`Extraction` de la pièce et de la version de la
 * chaîne, le `FaitPropose` de l'extraction et de son rang, le `FaitConfirme` et le `ConflitDeFait`
 * du fait proposé. La seconde écriture rencontre la première et s'arrête là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { cleRattachement, type ConfidentialitePiece, type Rattachement, type SourceDepot } from "./depot";

/**
 * Version de la CHAÎNE (classement + extracteurs). La monter, c'est demander une nouvelle extraction
 * des pièces déjà traitées — jamais en silence : une nouvelle version est un nouvel identifiant.
 */
export const VERSION_CHAINE = 1;

/** Au-delà, une pièce ne se lit pas pour enrichir une fiche (la limite de la lecture des pièces). */
export const TAILLE_MAX_ENRICHISSEMENT = 15 * 1024 * 1024;

/** Tâches prises au plus par passage — un battement ne doit jamais s'enliser dans la file. */
export const PLAFOND_PAR_PASSAGE = 10;

/** Une tâche `EN_COURS` depuis plus longtemps est tenue pour abandonnée (processus tombé) et se reprend. */
export const VERROU_PERIME_MS = 10 * 60_000;

/** Essais avant d'abandonner (`ECHEC`) — l'erreur reste écrite, le Super Admin peut relancer. */
export const ESSAIS_MAX = 5;

/** Attente avant l'essai suivant, selon le nombre d'essais déjà faits : 1 min, 5 min, 30 min, 2 h. */
const ATTENTES_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;

export type StatutTache = "A_FAIRE" | "EN_COURS" | "FAITE" | "ECHEC" | "IGNOREE";

/** Préfixe de la clé d'un dépôt direct au bucket, dont l'empreinte n'est pas encore calculée. */
const PREFIXE_DIRECT = "direct:";

/** La clé d'une tâche : celle de `PIECE_DEPOSEE`, ou `direct:<blobId>|…` tant que l'empreinte manque. */
export function cleTache(empreinte: string | null, blobId: string, r: Rattachement): string {
  return cleRattachement(empreinte ?? `${PREFIXE_DIRECT}${blobId}`, r);
}

export const pieceIdDe = (empreinte: string): string => `piece_${empreinte}`;
export const extractionIdDe = (pieceId: string): string => `${pieceId}_x${VERSION_CHAINE}`;
export const faitProposeIdDe = (extractionId: string, rang: number): string => `${extractionId}_f${rang}`;
export const faitConfirmeIdDe = (faitProposeId: string): string => `${faitProposeId}_ok`;
export const conflitIdDe = (faitProposeId: string): string => `${faitProposeId}_cf`;

/** Ce que la tâche devient après une erreur : un nouvel essai plus tard, ou l'abandon dit. */
export function issueApresEchec(tentativesFaites: number, maintenant: Date): { statut: StatutTache; prochainEssaiLe: Date } {
  if (tentativesFaites >= ESSAIS_MAX) return { statut: "ECHEC", prochainEssaiLe: maintenant };
  const attente = ATTENTES_MS[Math.min(Math.max(tentativesFaites - 1, 0), ATTENTES_MS.length - 1)];
  return { statut: "A_FAIRE", prochainEssaiLe: new Date(maintenant.getTime() + attente) };
}

/** Une erreur telle qu'on peut l'écrire : bornée, sur une ligne — jamais un contenu de pièce. */
export function erreurPourJournal(err: unknown): string {
  const brut = (err instanceof Error ? err.message : String(err ?? "")).replace(/\s+/g, " ").trim() || "erreur sans message";
  return brut.length > 300 ? `${brut.slice(0, 300)}…` : brut;
}

/** Le vocabulaire `SourcePiece` (R5) — plus étroit que celui des dépôts. */
export type SourcePiece = "DRIVE" | "CONVERSATION" | "EMAIL" | "PORTAIL" | "AD_PRO" | "RH" | "LEGAL" | "AUTRE";

const SOURCE_PIECE: Record<SourceDepot, SourcePiece> = {
  DRIVE: "DRIVE",
  DRIVE_VERSION: "DRIVE",
  MESSAGERIE: "CONVERSATION",
  EMAIL_GMAIL: "EMAIL",
  EMAIL_M365: "EMAIL",
  PORTAIL_FOURNISSEUR: "PORTAIL",
  ADPRO: "AD_PRO",
  RH: "RH",
  LEGAL: "LEGAL",
  REGULATORY: "AUTRE",
  PCH: "AUTRE",
  MATERIEL_PROMO: "AUTRE",
  ASSISTANT_ADAM: "AUTRE",
  ASSISTANT_IA: "AUTRE",
  IMPORT_EXCEL: "AUTRE",
  AUTRE_MODULE: "AUTRE",
};

export const sourcePieceDe = (s: SourceDepot): SourcePiece => SOURCE_PIECE[s] ?? "AUTRE";

/**
 * POURQUOI UNE TÂCHE NE SE TRAITE PAS — `null` : elle se traite. Une pièce trop lourde ou d'un format
 * sans texte n'est pas un échec : elle est IGNORÉE, et la raison est écrite.
 */
export function raisonDIgnorer(t: { taille: number; mime: string; nomFichier: string }, formatsLus: readonly string[]): string | null {
  if (t.taille > TAILLE_MAX_ENRICHISSEMENT) return `pièce de ${Math.round(t.taille / 1024 / 1024)} Mo : au-delà de ${TAILLE_MAX_ENRICHISSEMENT / 1024 / 1024} Mo, elle ne se lit pas pour enrichir une fiche`;
  if (t.taille === 0) return "pièce vide";
  const ext = extensionDe(t.nomFichier, t.mime);
  if (!ext || !formatsLus.includes(ext)) return `format « ${ext || "inconnu"} » : aucun lecteur de ce serveur n'en tire un texte`;
  return null;
}

const EXTENSION_DU_MIME: Record<string, string> = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls",
};

/** L'extension d'une pièce : celle du nom (même réduit à « *.pdf »), sinon celle du type MIME. */
export function extensionDe(nomFichier: string, mime: string): string {
  const parNom = /\.([a-z0-9]{1,8})$/i.exec(nomFichier.trim())?.[1]?.toLowerCase();
  return parNom ?? EXTENSION_DU_MIME[mime.trim().toLowerCase()] ?? "";
}

/** La source d'un `Document` de module, d'après le type de la fiche qui le porte. */
export function sourceDeLEntite(entityType: string): SourceDepot {
  if (entityType.startsWith("AD_PRO")) return "ADPRO";
  if (entityType.startsWith("REGULATORY")) return "REGULATORY";
  if (entityType.startsWith("PCH") || entityType === "STOCK_PCH_RELEVE") return "PCH";
  if (entityType === "PROMO_MATERIAL") return "MATERIEL_PROMO";
  if (["EMPLOYEE", "HR_REQUEST", "LEAVE_REQUEST", "RECRUITMENT_REQUEST", "RECRUITMENT_CANDIDATE"].includes(entityType)) return "RH";
  if (["LEGAL_DOCUMENT", "INVOICE", "CONSULTING_CONTRACT"].includes(entityType)) return "LEGAL";
  return "AUTRE_MODULE";
}

const RANG_CONFIDENTIALITE: Record<ConfidentialitePiece, number> = { INTERNAL: 0, RESTRICTED: 1, CONFIDENTIAL: 2 };

/**
 * La confidentialité d'une pièce POUR L'ENRICHISSEMENT : celle du document, relevée d'office pour ce
 * que l'inventaire des dépôts tient pour confidentiel (`refonte-p4-points-de-depot.md` §4) — pièce
 * d'identité, RH, congés, paie. Le document lui-même garde la sienne : l'accès à l'écran ne change pas,
 * seul ce que le registre et la file en retiennent (le nom réduit à son extension) se resserre.
 */
export function confidentialitePourEnrichissement(document: ConfidentialitePiece, p: { category?: string | null; entityType?: string | null }): ConfidentialitePiece {
  const imposee: ConfidentialitePiece =
    p.category === "ID_DOCUMENT" || ["EMPLOYEE", "HR_REQUEST", "LEAVE_REQUEST"].includes(p.entityType ?? "") ? "CONFIDENTIAL"
      : p.entityType === "RECRUITMENT_CANDIDATE" || p.entityType === "CONSULTING_CONTRACT" ? "RESTRICTED"
        : "INTERNAL";
  return RANG_CONFIDENTIALITE[imposee] > RANG_CONFIDENTIALITE[document] ? imposee : document;
}
