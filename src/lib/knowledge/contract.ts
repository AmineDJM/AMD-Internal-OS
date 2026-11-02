/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE DE CONNAISSANCE — « ingérer une fois, comprendre une fois, retrouver tout de suite ».
 *
 * ── À QUI APPARTIENT CE CHANTIER ─────────────────────────────────────────────────────────
 *
 * À L'ERP, pas à Adam. Adam en est un CONSOMMATEUR parmi d'autres : la recherche de l'écran
 * Drive, un tableau Regulatory ou un futur module y puisent de la même façon. C'est pour cela
 * que ce dossier vit dans `src/lib/knowledge/` et non dans `src/lib/assistant/` — où une partie
 * de cette logique s'était installée par commodité (l'ingestion Drive), ce qui la rendait
 * indisponible à tout ce qui n'est pas Adam.
 *
 * ── CE QUE CE FICHIER EST ────────────────────────────────────────────────────────────────
 *
 * Le VOCABULAIRE commun : ce qu'est une unité de connaissance, d'où elle vient, à quel point on
 * y croit, et où elle en est de son traitement. Zéro import — un contrat qui dépend de quelque
 * chose finit par en hériter les contraintes ; un test gèle cette propriété.
 *
 * ── LA RÈGLE QUI GOUVERNE TOUT LE RESTE ──────────────────────────────────────────────────
 *
 * **Ne jamais appeler un modèle pour une donnée que le code sait déjà comprendre.** L'échelle
 * est stricte et décroissante en préférence : parsing déterministe → texte classique → metadata
 * existantes → Luna (vision) → Terra (cas réellement complexe). Chaque barreau franchi doit être
 * JUSTIFIÉ par un fait constaté, pas par une intuition — et le fait est consigné (`RouteReason`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── D'où vient l'information ───────────────────────────────

/**
 * LA SOURCE. Un couple `(sourceType, sourceId)` désigne UNE chose dans l'ERP, de façon stable :
 * c'est la clé d'idempotence de toute la couche. Réingérer le même couple ne crée jamais un
 * second élément — il met à jour le premier, ou ouvre une nouvelle VERSION si le contenu a changé.
 */
export type KnowledgeSourceType =
  | "drive_file"      // un fichier du Drive
  | "email"           // un message reçu ou envoyé
  | "attachment"      // une pièce jointe (elle repasse par le même moteur)
  | "regulatory"      // un dossier Regulatory
  | "legal"           // contrat, bon de commande, facture
  | "courrier"        // courrier entrant / sortant
  | "task"            // tâche, demande
  | "decision"        // décision exécutive
  | "comment"         // commentaire, note de fil
  | "meeting"         // compte rendu de réunion
  | "product"         // fiche produit
  | "supplier"        // fiche fournisseur
  | "hr"              // pièce RH
  | "finance"         // pièce financière
  | "pch";            // marché / appel d'offres

// ─────────────────────────────── Où en est le traitement ───────────────────────────────

/**
 * LES ÉTAPES, dans l'ordre. Elles sont OBSERVABLES : à tout instant on peut dire où en est un
 * élément, et un élément bloqué se voit au lieu de disparaître.
 *
 * `READY` ne veut pas dire « tout est fait » : il veut dire **retrouvable**. C'est la promesse
 * de l'ingestion rapide (§4) — l'enrichissement profond continue derrière, sans que personne
 * n'attende devant un écran.
 */
export type IngestStage =
  | "RECEIVED"    // reçu, hashé, dédoublonné
  | "PARSED"      // texte extrait
  | "CLASSIFIED"  // type de document + métadonnées principales
  | "INDEXED"     // recherchable (lexical)
  | "READY"       // recherchable ET relié — l'utilisateur peut compter dessus
  | "ENRICHED"    // enrichissement profond terminé (résumé, relations secondaires, vecteurs)
  | "EMPTY"       // fichier lu jusqu'au bout, et il n'en sort AUCUN texte : un état, pas une panne
  | "FAILED";     // échec nommé — jamais un silence

export const INGEST_STAGES: readonly IngestStage[] = [
  "RECEIVED", "PARSED", "CLASSIFIED", "INDEXED", "READY", "ENRICHED", "EMPTY", "FAILED",
] as const;

/**
 * L'ordre de progression — un élément ne recule pas, sauf vers `FAILED`.
 *
 * `EMPTY` (« sans texte lisible ») se range juste au-dessus de `RECEIVED` : un fichier dont on n'a
 * rien tiré peut encore devenir lisible (une lecture visuelle, un parseur amélioré), donc tout ce
 * qui le rend RETROUVABLE l'emporte sur lui ; mais il ne remplace jamais un élément déjà
 * retrouvable. Ce n'est PAS `FAILED` : un scan blanc ou une archive sans texte est un fait du
 * fichier, pas un défaut du traitement — le ranger parmi les échecs remplissait l'écran de
 * non-problèmes, et cachait les vrais.
 */
const STAGE_RANK: Record<IngestStage, number> = {
  RECEIVED: 0, EMPTY: 0.5, PARSED: 1, CLASSIFIED: 2, INDEXED: 3, READY: 4, ENRICHED: 5, FAILED: -1,
};

/**
 * Le traitement a-t-il PROGRESSÉ ? Un job rejoué ne doit pas faire reculer l'étape : un
 * enrichissement relancé sur un élément déjà `READY` le laisserait sinon en `PARSED`, et
 * l'utilisateur verrait une donnée disparaître de la recherche sans raison.
 */
export function advances(from: IngestStage, to: IngestStage): boolean {
  if (to === "FAILED") return from !== "FAILED";
  return STAGE_RANK[to] > STAGE_RANK[from];
}

/** Recherchable ? C'est la seule question que l'écran se pose. */
export const isRetrievable = (stage: IngestStage): boolean =>
  STAGE_RANK[stage] >= STAGE_RANK.INDEXED;

// ─────────────────────────────── Comment on l'a comprise ───────────────────────────────

/**
 * PAR QUEL MOYEN une information a été obtenue. C'est le cœur de l'économie de la couche : on
 * mesure la répartition, et une dérive vers le haut de l'échelle se voit sur un tableau plutôt
 * que sur une facture.
 */
export type ExtractedBy =
  | "native"    // parsing déterministe (xlsx, docx, pptx, csv, pdf texte)
  | "metadata"  // déjà structuré dans l'ERP — aucun texte à comprendre
  | "ocr"       // reconnaissance de caractères
  | "luna"      // vision / compréhension, modèle économique
  | "hybrid"    // texte natif COMPLÉTÉ par une lecture visuelle des pages que le parseur n'a pas lues
  | "terra";    // escalade — cas réellement complexe

export const EXTRACTED_BY: readonly ExtractedBy[] = ["native", "metadata", "ocr", "luna", "hybrid", "terra"] as const;

/** Le coût relatif d'un moyen. Sert au routage ET au rapport : l'ordre est la doctrine. */
export const EXTRACTION_RANK: Record<ExtractedBy, number> = {
  metadata: 0, native: 1, ocr: 2, luna: 3, hybrid: 3.5, terra: 4,
};

/** Les moyens qui ont demandé un MODÈLE — la part « ambre » du tableau de bord. */
export const MOYENS_MODELE: ReadonlySet<ExtractedBy> = new Set<ExtractedBy>(["luna", "hybrid", "terra"]);

/**
 * LES ANCIENNES ÉCRITURES DU MÊME MOYEN. L'étage vision écrivait `luna_vision` (aucun texte natif)
 * et `hybride` (texte natif complété) pendant que l'ingestion écrivait `luna` : deux écritures de
 * la même méthode, que l'écran affichait côte à côte — « Luna — vision » et « luna_vision », deux
 * lignes pour une seule chose, la seconde sans libellé. L'écriture est désormais FERMÉE
 * (`ExtractedBy`) ; les lignes déjà en base se regroupent ici, à la lecture, sous le bon moyen.
 */
const MOYENS_HERITES: Readonly<Record<string, ExtractedBy>> = {
  luna_vision: "luna",
  hybride: "hybrid",
};

/**
 * LIT un moyen tel qu'il est en base. `null` pour une valeur vide ou inconnue — jamais une
 * supposition : un moyen inconnu se montre sous son nom brut plutôt que rangé sous un autre.
 */
export function normaliserMoyen(raw: string | null | undefined): ExtractedBy | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if ((EXTRACTED_BY as readonly string[]).includes(v)) return v as ExtractedBy;
  return MOYENS_HERITES[v] ?? null;
}

/**
 * LA RÉPARTITION PAR MOYEN, regroupée à la lecture : les anciennes écritures rejoignent leur
 * moyen, un moyen inconnu garde son nom brut (on ne le range pas sous un autre), un moyen absent
 * se dit « inconnu ».
 */
export function compterParMoyen(rows: readonly { moyen: string | null; n: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const cle = normaliserMoyen(r.moyen) ?? ((r.moyen ?? "").trim() || "inconnu");
    out[cle] = (out[cle] ?? 0) + r.n;
  }
  return out;
}

/**
 * LES TRAVAUX QUI APPELLENT UN MODÈLE. Sans clé, ou sous l'interrupteur général coupé, ils
 * ATTENDENT en file — ils ne sont même pas réclamés. Les autres (parse, classify, entities) ne
 * coûtent rien et avancent quoi qu'il arrive.
 */
export const JOB_KINDS_MODELE: ReadonlySet<JobKind> = new Set<JobKind>(["embed", "vision", "enrich"]);

/**
 * POURQUOI on est monté d'un barreau. Un motif VIDE est interdit par construction (le type
 * l'exige) : monter sans raison est précisément ce qu'on veut rendre impossible à faire
 * discrètement.
 */
export type RouteReason =
  | "no_text_layer"       // PDF sans couche texte — il faut regarder
  | "text_too_sparse"     // du texte, mais si peu qu'il ne dit rien du document
  | "image_source"        // photo, capture, image — il n'y a rien à parser
  | "ocr_unreliable"      // l'OCR a rendu du charabia
  | "table_heavy"         // des tableaux que le texte à plat détruit
  | "low_confidence"      // Luna n'était pas sûr — on escalade
  | "structured_only"     // déjà structuré : on NE monte pas, on s'arrête là
  | "parser_failed";      // le parser natif a échoué

/** Les deux seuils de la doctrine §22. Nommés ici pour qu'ils ne se dispersent pas. */
export const CONFIDENCE_ACCEPT = 0.85;  // au-dessus : on accepte
export const CONFIDENCE_VERIFY = 0.55;  // entre les deux : on tente de valider contre l'ERP

export type ConfidenceVerdict = "accept" | "verify" | "escalate";

export function verdictOf(value: number): ConfidenceVerdict {
  if (value >= CONFIDENCE_ACCEPT) return "accept";
  if (value >= CONFIDENCE_VERIFY) return "verify";
  return "escalate";
}

// ─────────────────────────────── Ce qu'on retient ───────────────────────────────

/**
 * LES MÉTADONNÉES COMMUNES. Toutes optionnelles, et c'est la règle §9 : on ne remplit QUE ce
 * qui est pertinent. Un champ rempli « pour faire complet » avec une valeur devinée est pire
 * qu'un champ vide — il se lit comme un fait.
 */
export interface KnowledgeMeta {
  companyId?: string | null;
  department?: string | null;
  domain?: string | null;
  documentType?: string | null;
  productIds?: string[];
  personIds?: string[];
  organizationIds?: string[];
  supplierId?: string | null;
  dossierId?: string | null;
  projectId?: string | null;
  authority?: string | null;
  status?: string | null;
  confidentiality?: "public" | "internal" | "restricted" | null;
  language?: string | null;
  tags?: string[];
  /** Dates repérées dans le contenu — utiles pour situer sans écraser les dates canoniques. */
  dates?: string[];
  deadlines?: string[];
}

/** La forme d'un morceau. Elle suit la STRUCTURE du document, jamais un découpage arbitraire. */
export type ChunkKind = "section" | "page" | "slide" | "table" | "sheet" | "message" | "whole";

export interface KnowledgeChunkDraft {
  kind: ChunkKind;
  /** Rang dans le document — l'ordre de lecture, pas l'ordre d'insertion. */
  ord: number;
  /** Titre de section, numéro de page, nom de feuille… ce qui permet de CITER. */
  label?: string | null;
  text: string;
  /** Page ou diapositive d'origine — la provenance descend jusqu'au morceau. */
  locator?: string | null;
}

// ─────────────────────────────── Les relations ───────────────────────────────

/**
 * LE PRÉDICAT d'une relation. Une liste FERMÉE : un graphe dont le vocabulaire s'invente au fil
 * de l'eau devient illisible en trois mois, et impossible à interroger sans deviner.
 */
export type RelationPredicate =
  | "mentions"     // un contenu cite une entité
  | "concerns"     // un dossier porte sur un produit
  | "references"   // un document renvoie à un autre objet
  | "manages"      // une personne est responsable de quelque chose
  | "assignedTo"   // une tâche revient à une personne
  | "belongsTo"    // appartenance (produit → gamme, dossier → entité)
  | "supplies"     // un fournisseur fournit un produit
  | "impacts"      // une décision touche un projet
  | "supersedes";  // une version remplace la précédente

// ─────────────────────────────── Les jobs ───────────────────────────────

/**
 * LES TRAVAUX DE FOND. Tout ce qui est lourd (vision, embeddings, relations, enrichissement)
 * quitte le chemin de l'utilisateur : §4 — « ne jamais bloquer l'utilisateur inutilement ».
 */
export type JobKind =
  | "parse"       // extraction (peut être longue sur un gros PDF)
  | "vision"      // pages illisibles → Luna
  | "classify"    // type de document + métadonnées
  | "entities"    // résolution d'entités + relations
  | "embed"       // vecteurs sémantiques
  | "enrich";     // résumé, engagements, échéances

export const JOB_KINDS: readonly JobKind[] = ["parse", "vision", "classify", "entities", "embed", "enrich"] as const;

/**
 * LA PRIORITÉ. Plus petit = plus urgent. Ce qui rend une donnée RETROUVABLE passe avant ce qui
 * la rend mieux comprise : un document qu'on ne trouve pas n'existe pas.
 */
export const JOB_PRIORITY: Record<JobKind, number> = {
  parse: 10, classify: 20, entities: 30, embed: 40, vision: 50, enrich: 60,
};

/** Tentatives avant la boîte morte. Au-delà, on arrête d'y revenir et on le SIGNALE. */
export const MAX_ATTEMPTS = 4;

/**
 * L'ATTENTE avant un nouvel essai — exponentielle, bornée. Un travail qui échoue à cause d'un
 * service indisponible ne doit pas le marteler ; un travail qui échoue pour une mauvaise raison
 * finit en boîte morte plutôt que de tourner pour rien.
 */
export function backoffMs(attempt: number): number {
  const base = 30_000; // 30 s
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 30 * 60_000); // plafond 30 min
}
