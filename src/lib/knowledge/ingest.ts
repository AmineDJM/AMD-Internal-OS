import { prisma } from "@/lib/prisma";
import {
  type IngestStage,
  type KnowledgeMeta,
  type KnowledgeChunkDraft,
  type KnowledgeSourceType,
  type ExtractedBy,
  advances,
} from "./contract";
import { fold, clip } from "./text";
import { renumber } from "./chunk";
import { enqueue, enqueueAll } from "./queue";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PIPELINE — deux vitesses, et l'utilisateur ne connaît que la première.
 *
 * ── LA PROMESSE (§4 ET LA DERNIÈRE CONSIGNE) ─────────────────────────────────────────────
 *
 * Déposer un fichier rend la main TOUT DE SUITE. Ce que l'ingestion rapide fait — hacher,
 * dédoublonner, stocker le texte, l'indexer — suffit à rendre la donnée RETROUVABLE, qui est le
 * service attendu. Tout le reste (vision, vecteurs, relations, résumé) part en file et avance
 * tranquillement : si ça finit, tant mieux ; si ça échoue, l'utilisateur n'en sait rien et le
 * document reste trouvable par son texte.
 *
 * C'est pour cela que `READY` ne veut pas dire « tout est compris » mais « on peut compter
 * dessus ». Confondre les deux, ce serait faire attendre quelqu'un devant un écran pour un
 * enrichissement dont il n'a pas besoin à cet instant.
 *
 * ── L'IDEMPOTENCE, ET POURQUOI ELLE EST À DEUX ÉTAGES ────────────────────────────────────
 *
 *   1. `(sourceType, sourceId)` — désigne LA chose. Réingérer ne crée jamais un doublon.
 *   2. `contentHash` — désigne LE contenu. Identique → on ne retraite RIEN (pas un appel de
 *      modèle, pas un vecteur, pas une relation). Différent → nouvelle VERSION, l'ancienne est
 *      fermée dans le temps au lieu d'être écrasée.
 *
 * Sans le premier, un balayage rejoué double la base. Sans le second, renommer un fichier
 * coûterait une réextraction complète — et l'ERP finirait par payer son propre bruit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que l'ingestion rapide reçoit. Tout le reste se déduit ou s'enrichit plus tard. */
export interface IngestInput {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  contentHash: string;
  title?: string | null;
  docType?: string | null;
  language?: string | null;
  companyId?: string | null;
  confidentiality?: "public" | "internal" | "restricted" | null;
  text?: string | null;
  chunks?: KnowledgeChunkDraft[];
  meta?: KnowledgeMeta;
  extractedBy?: ExtractedBy;
  model?: string | null;
  confidence?: number | null;
  documentDate?: Date | null;
  effectiveDate?: Date | null;
  /** Les travaux de fond à prévoir. Vide = rien de lourd à faire, l'élément est déjà complet. */
  deepJobs?: ("vision" | "classify" | "entities" | "embed" | "enrich")[];
}

export interface IngestResult {
  itemId: string;
  /** `unchanged` = le contenu était identique : AUCUN traitement n'a été relancé. */
  outcome: "created" | "versioned" | "updated" | "unchanged";
  stage: IngestStage;
  version: number;
  jobsQueued: number;
}

/**
 * UN FICHIER LU JUSQU'AU BOUT, SANS TEXTE, ET SANS LECTURE VISUELLE À ATTENDRE : « sans texte
 * lisible » (`EMPTY`), un état honnête — ni « reçu » (comme si rien n'avait été tenté), ni « en
 * échec » (ce n'est pas une panne). Trois conditions, toutes nécessaires : un moyen d'extraction
 * déclaré (le contenu a été LU), ce moyen n'est pas `metadata` (un objet structuré se retrouve
 * par ses champs), et aucune vision n'est demandée (sinon le texte peut encore venir).
 */
export function sansTexteDefinitif(input: Pick<IngestInput, "extractedBy" | "deepJobs">): boolean {
  return Boolean(input.extractedBy)
    && input.extractedBy !== "metadata"
    && !(input.deepJobs ?? []).includes("vision");
}

/** Le texte principal stocké sur l'élément — assez pour retrouver et citer, pas pour tout relire. */
const TEXT_CAP = 40_000;

/**
 * INGESTION RAPIDE. Ne lève JAMAIS : une couche de connaissance qui casse un dépôt de fichier
 * a échoué à sa mission, quelle que soit la qualité de son index.
 */
export async function ingestFast(input: IngestInput): Promise<IngestResult | null> {
  try {
    const existing = await prisma.knowledgeItem.findUnique({
      where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } },
      select: { id: true, contentHash: true, version: true, stage: true, text: true },
    });

    // ── LE CONTENU EST LE MÊME, MAIS NOUS SAVONS MIEUX LE LIRE QU'AVANT.
    //
    // L'empreinte désigne le CONTENU du fichier, pas la qualité de notre extraction. Quand un
    // parseur s'améliore — ou qu'un défaut est corrigé — les documents déjà ingérés gardent
    // sinon leur extraction ratée POUR TOUJOURS : leur empreinte n'a pas bougé, donc le
    // dédoublonnage les protège de la correction même. C'est arrivé pour de vrai (les fichiers
    // texte partaient en vision faute d'être reconnus).
    //
    // La règle est donc étroite et sûre : on ne retraite QUE si l'ancien passage n'avait produit
    // AUCUN texte et que le nouveau en produit. Jamais l'inverse — une extraction qui régresse ne
    // doit pas pouvoir effacer une extraction qui marchait.
    const healed = Boolean(existing && !existing.text && input.text);

    // ── RIEN N'A CHANGÉ. Le cas le plus fréquent d'un balayage, et le seul qui doit coûter zéro.
    if (existing && existing.contentHash === input.contentHash && !healed) {
      return {
        itemId: existing.id,
        outcome: "unchanged",
        stage: existing.stage as IngestStage,
        version: existing.version,
        jobsQueued: 0,
      };
    }

    const text = input.text ? clip(input.text, TEXT_CAP) : null;
    const base = {
      contentHash: input.contentHash,
      title: input.title ?? null,
      docType: input.docType ?? null,
      language: input.language ?? null,
      companyId: input.companyId ?? null,
      confidentiality: input.confidentiality ?? null,
      text,
      textFold: text ? fold(text) : null,
      meta: (input.meta ?? undefined) as object | undefined,
      extractedBy: input.extractedBy ?? null,
      model: input.model ?? null,
      confidence: input.confidence ?? null,
      documentDate: input.documentDate ?? null,
      effectiveDate: input.effectiveDate ?? null,
      // INDEXED plutôt que READY : le texte est cherchable, les relations ne le sont pas encore.
      // Annoncer READY ici ferait promettre un lien qui n'existe pas.
      stage: text ? "INDEXED" : sansTexteDefinitif(input) ? "EMPTY" : "RECEIVED",
      error: null,
    };

    let itemId: string;
    let outcome: IngestResult["outcome"];
    let version: number;

    if (!existing) {
      const created = await prisma.knowledgeItem.create({ data: { sourceType: input.sourceType, sourceId: input.sourceId, ...base }, select: { id: true, version: true } });
      itemId = created.id;
      version = created.version;
      outcome = "created";
    } else if (healed && existing.contentHash === input.contentHash) {
      // ── MÊME CONTENU, MEILLEURE LECTURE. On MET À JOUR sur place, sans ouvrir de version.
      //
      // Une version dirait « le document a changé le 27 août » — ce serait faux : c'est notre
      // lecture qui a changé, pas le document. Inventer une version ici polluerait l'historique
      // avec un événement qui n'a jamais eu lieu, et « quelle était la situation en mars ? »
      // deviendrait faux pour un motif purement technique.
      await prisma.knowledgeItem.update({ where: { id: existing.id }, data: base });
      itemId = existing.id;
      version = existing.version;
      outcome = "updated";
    } else {
      // ── LE CONTENU A CHANGÉ → NOUVELLE VERSION.
      //
      // L'ancienne n'est pas écrasée : elle est FERMÉE dans le temps (`validTo`, `isCurrent`).
      // C'est ce qui permet de répondre « quelle était la situation en mars ? » au lieu de
      // n'avoir que le présent — et c'est irrécupérable si on écrase.
      const now = new Date();
      const archived = await prisma.knowledgeItem.update({
        where: { id: existing.id },
        data: { sourceId: `${input.sourceId}#v${existing.version}`, validTo: now, isCurrent: false },
        select: { id: true },
      });
      const created = await prisma.knowledgeItem.create({
        data: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          ...base,
          version: existing.version + 1,
          validFrom: now,
          supersedesId: archived.id,
        },
        select: { id: true, version: true },
      });
      itemId = created.id;
      version = created.version;
      outcome = "versioned";
    }

    // ── LES MORCEAUX. Remplacés en bloc : rejouer une extraction ne doit pas empiler deux
    //    découpages du même document, ce qui doublerait chaque résultat de recherche.
    if (input.chunks?.length) await replaceChunks(itemId, input.chunks);

    // ── LES TRAVAUX DE FOND. Mis en file, jamais attendus.
    const jobs = (input.deepJobs ?? []).map((kind) => ({ kind, itemId }));
    const jobsQueued = jobs.length ? await enqueueAll(jobs) : 0;

    return { itemId, outcome, stage: base.stage as IngestStage, version, jobsQueued };
  } catch (err) {
    console.error("[knowledge] ingestFast failed", input.sourceType, input.sourceId, err);
    return null;
  }
}

/**
 * REMPLACE LES MORCEAUX D'UN ÉLÉMENT. Suppression puis insertion, dans une transaction : un
 * document ne doit jamais se retrouver à moitié découpé, sinon une recherche rend un extrait
 * qui n'existe plus à côté d'un extrait à jour.
 */
export async function replaceChunks(itemId: string, chunks: KnowledgeChunkDraft[]): Promise<number> {
  const ordered = renumber(chunks);
  try {
    await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({ where: { itemId } }),
      prisma.knowledgeChunk.createMany({
        data: ordered.map((c) => ({
          itemId,
          kind: c.kind,
          ord: c.ord,
          label: c.label ?? null,
          locator: c.locator ?? null,
          text: c.text,
          textFold: fold(c.text),
        })),
      }),
    ]);
    return ordered.length;
  } catch (err) {
    console.error("[knowledge] replaceChunks failed", itemId, err);
    return 0;
  }
}

/**
 * FAIT AVANCER L'ÉTAPE — jamais reculer.
 *
 * Un job rejoué sur un élément déjà `READY` ne doit pas le remettre en `PARSED` : l'utilisateur
 * verrait une donnée disparaître de la recherche sans raison. La garde vit dans le contrat
 * (`advances`), donc la même règle s'applique à tous les appelants.
 */
export async function setStage(itemId: string, stage: IngestStage, error?: string | null): Promise<void> {
  const cur = await prisma.knowledgeItem.findUnique({ where: { id: itemId }, select: { stage: true } }).catch(sansBloquer("ingest.setStage.knowledgeItem", null));
  if (!cur) return;
  if (!advances(cur.stage as IngestStage, stage)) return;
  await prisma.knowledgeItem
    .update({ where: { id: itemId }, data: { stage, error: error ?? null } })
    .catch(sansBloquer("ingest.setStage.knowledgeItem"));
}

/**
 * L'ENTRÉE ÉVÉNEMENTIELLE (§19) — « quelque chose a changé, occupe-t'en ».
 *
 * Volontairement SANS `await` côté appelant : c'est un signal, pas une étape du circuit métier.
 * Un dépôt de fichier ne doit pas ralentir d'une milliseconde parce que la couche de
 * connaissance a du travail, ni échouer parce qu'elle est indisponible.
 *
 * Le job `parse` fait ensuite le vrai travail, dans la file, avec ses réessais.
 */
export function noteChange(sourceType: KnowledgeSourceType, sourceId: string, opts: { priority?: number; delayMs?: number } = {}): void {
  void enqueue({
    kind: "parse",
    payload: { sourceType, sourceId },
    priority: opts.priority,
    // Un léger retard laisse la transaction métier devenir visible : sans lui, le job lirait
    // parfois une ligne qui n'est pas encore committée et conclurait « introuvable ».
    delayMs: opts.delayMs ?? 2_000,
    dedupeKey: `parse:${sourceType}:${sourceId}`,
  }).catch(sansBloquer("ingest.noteChange.enqueue"));
}

/**
 * INGESTION D'UN OBJET DÉJÀ STRUCTURÉ (§18) — une tâche, un dossier, une décision.
 *
 * Ces objets ne sont PAS « RAGifiés » : leurs champs vont en base et en index relationnel, point.
 * Un vecteur n'est demandé que s'il reste du TEXTE LIBRE assez consistant pour qu'une recherche
 * par le sens apporte quelque chose. Vectoriser « statut : EN_COURS » coûterait un appel pour
 * une information qu'un `WHERE` trouve mieux.
 */
export const FREE_TEXT_WORTH_EMBEDDING = 200;

export async function ingestRecord(input: Omit<IngestInput, "extractedBy" | "deepJobs"> & { freeText?: string | null }): Promise<IngestResult | null> {
  const free = (input.freeText ?? "").trim();
  return ingestFast({
    ...input,
    extractedBy: "metadata",
    confidence: 1,
    deepJobs: [
      "entities",
      ...(free.length >= FREE_TEXT_WORTH_EMBEDDING ? (["embed"] as const) : []),
    ],
  });
}
