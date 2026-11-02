/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TEACH ADAM — LA COUCHE DE RÈGLES (§119) : ce qu'une personne a ENSEIGNÉ à Adam, structuré,
 * versionné, borné à un périmètre, daté, et toujours retrouvable.
 *
 * ── UNE RÈGLE EST UNE ATTESTATION, PAS UNE OBSERVATION ──────────────────────────────────
 *
 * « Désormais, les devis sont valables 45 jours. » Ce n'est pas un souvenir : c'est une
 * instruction qu'une personne identifiée donne, à un moment donné, pour un périmètre donné.
 * Elle porte donc QUI l'a dite (`ownerId`), POUR QUI elle vaut (`scope` + sujet), DEPUIS QUAND
 * (`effectiveFrom`), et D'OÙ elle vient (`provenance` : la conversation, le message). Ce
 * qu'Adam a seulement observé n'entre jamais ici tout seul (§12 : pas d'apprentissage
 * silencieux) — au mieux il le PROPOSE, et une personne le confirme d'un geste.
 *
 * ── LA MÉMOIRE PERSONNELLE ET LES RÈGLES NE SONT PAS LA MÊME CHOSE ──────────────────────
 *
 * `AssistantMemoryItem` retient des FAITS sur la personne et son vocabulaire (« pembro =
 * Pembrolizumab », « s'intéresse au marché de l'insuline »). Une règle dit COMMENT AGIR ou
 * DÉCIDER (« toute facture au-dessus de 500 000 DZD passe par le PDG », « le devis se fait sur
 * le papier Adventum »). Les deux se composent dans le contexte, chacune à sa place ; aucune
 * ne remplace l'autre.
 *
 * ── LA VERSION EST UNE LIGNE, PAS UN CHAMP ──────────────────────────────────────────────
 *
 * Modifier une règle crée une NOUVELLE ligne (`version + 1`, `supersedesId` → l'ancienne),
 * et l'ancienne passe en SUPERSEDED. Supprimer la met en DELETED. Rien n'est jamais effacé :
 * « quelle était la règle en mars ? » a une réponse, et « 100 % des règles récupérables »
 * est une propriété de la table, pas une promesse.
 *
 * Module PUR : types, libellés, constantes. Aucun import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures d'enseignement — ce qu'une personne peut apprendre à Adam. */
export const KINDS = [
  "PREFERENCE",
  "COMPANY_RULE",
  "WORKFLOW",
  "CONVENTION",
  "DOCUMENT_STANDARD",
  "VALIDATION_RULE",
  "EXCEPTION",
  "MAPPING",
  "BUSINESS_DEFINITION",
] as const;
export type Kind = (typeof KINDS)[number];

export const LIBELLE_KIND: Record<Kind, string> = {
  PREFERENCE: "Préférence",
  COMPANY_RULE: "Règle de société",
  WORKFLOW: "Workflow",
  CONVENTION: "Convention",
  DOCUMENT_STANDARD: "Standard documentaire",
  VALIDATION_RULE: "Règle de validation",
  EXCEPTION: "Exception",
  MAPPING: "Correspondance",
  BUSINESS_DEFINITION: "Définition métier",
};

/**
 * LES NATURES CONTRAIGNANTES — celles qu'une règle plus étroite ne peut PAS écarter.
 *
 * Une règle de société ou une règle de validation dit ce qui DOIT se faire ; une préférence
 * personnelle ne l'annule pas (« je préfère envoyer sans validation » ne vaut rien contre « toute
 * facture > 500 000 passe par le PDG »). Une convention, un standard, une correspondance, une
 * définition peuvent être PRÉCISÉS par un périmètre plus étroit : c'est le sens même d'un
 * périmètre.
 */
export const KINDS_CONTRAIGNANTS: ReadonlySet<Kind> = new Set(["COMPANY_RULE", "VALIDATION_RULE", "WORKFLOW", "EXCEPTION"]);

export const SCOPES = ["PERSON", "GROUP", "COMPANY"] as const;
export type Scope = (typeof SCOPES)[number];

export const LIBELLE_SCOPE: Record<Scope, string> = { PERSON: "Personnel", GROUP: "Département", COMPANY: "Société" };

/** Du plus étroit au plus large — l'ordre sert à la précédence. */
export const RANG_SCOPE: Record<Scope, number> = { PERSON: 0, GROUP: 1, COMPANY: 2 };

export const STATUTS = ["ACTIVE", "DISABLED", "SUPERSEDED", "DELETED"] as const;
export type Statut = (typeof STATUTS)[number];

export const LIBELLE_STATUT: Record<Statut, string> = { ACTIVE: "en vigueur", DISABLED: "désactivée", SUPERSEDED: "remplacée", DELETED: "supprimée" };

/**
 * LES DOMAINES suggérés — le champ reste libre (minuscules, sans accent), mais ceux-ci sont
 * ceux que les outils et le planificateur savent filtrer. `general` s'applique partout.
 */
export const DOMAINES_SUGGERES = [
  "general", "finance", "legal", "regulatory", "documents", "mail", "missions", "hr", "drive", "sales", "pch", "meetings", "reporting",
] as const;

export interface Provenance {
  threadId?: string | null;
  messageId?: string | null;
  missionId?: string | null;
  /** La phrase de la personne, telle qu'elle l'a dite (≤ 400 caractères). */
  citation?: string | null;
  /** `TAUGHT` : dit par la personne ; `PROPOSED` : observé par Adam et confirmé d'un geste. */
  mode?: "TAUGHT" | "PROPOSED" | null;
}

/** Une règle telle que le résolveur la voit — la ligne de base, sans les relations. */
export interface Regle {
  id: string;
  kind: Kind;
  scope: Scope;
  /** Qui l'a enseignée. */
  ownerId: string;
  /** PERSON : la personne pour qui elle vaut (l'enseignant, sauf délégation). */
  subjectUserId: string | null;
  companyId: string | null;
  departmentId: string | null;
  domain: string;
  /** L'intitulé court, à l'impératif : « Validité des devis ». */
  title: string;
  /** La règle, en une ou deux phrases. C'est ce texte que le modèle lit. */
  statement: string;
  /**
   * La part STRUCTURÉE, quand la règle porte une valeur qu'un programme peut appliquer :
   * `{ cle: "validiteDevis", valeur: 45, unite: "jours" }`, `{ de: "DT", vers: "Direction technique" }`,
   * `{ seuil: 500000, devise: "DZD" }`, `{ exceptionDe: "<id ou clé>" }`. `null` = texte seul.
   */
  params: Record<string, unknown> | null;
  /** Plus haut = servi d'abord à égalité de périmètre. 0 par défaut. */
  priority: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: Statut;
  version: number;
  supersedesId: string | null;
  provenance: Provenance | null;
  createdAt: Date;
}

/** Le sujet pour qui l'on résout : la personne, ses sociétés, sa chaîne de départements. */
export interface Sujet {
  userId: string;
  companyIds: readonly string[];
  departmentIds: readonly string[];
  maintenant?: Date;
}

/** Bornes de bon sens — au-delà, ce n'est plus une règle, c'est un document. */
export const MAX_STATEMENT = 800;
export const MAX_TITLE = 120;
export const MAX_CITATION = 400;
export const MAX_REGLES_ACTIVES_PAR_SUJET = 500;

export const estKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);
export const estScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);

/** Le domaine normalisé : minuscules, sans accent, un mot. Vide ou inconnu → `general`. */
export function normaliserDomaine(v: unknown): string {
  if (typeof v !== "string") return "general";
  const d = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return d || "general";
}
