import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { lunaEmbed } from "@/lib/openai-luna";
import { cosine } from "@/lib/regulatory/intelligence/corpus/semantic";
import { sansBloquer } from "@/lib/journal";

/**
 * RECHERCHE SÉMANTIQUE SUR LE DRIVE — le NIVEAU DE REPLI quand le lexical ne trouve pas :
 * « durée de conservation » doit retrouver un document qui dit « shelf life », un scan mal
 * nommé doit sortir par le SENS de son contenu.
 *
 * Même architecture ASSUMÉE que le corpus réglementaire (`corpus/semantic.ts`) — et pour la
 * même raison : pgvector est INDISPONIBLE sur cette infrastructure (vérifié :
 * `pg_available_extensions` ne le propose pas). À l'échelle du Drive indexé (centaines à
 * quelques milliers de fichiers), des vecteurs 512d en JSONB + un cosinus en mémoire coûtent
 * quelques millisecondes — introduire une base vectorielle serait de l'infrastructure inutile.
 *
 *   • cache de processus estampillé (nombre, dernière écriture) — la première recherche
 *     charge, les suivantes ne touchent plus la base ;
 *   • JAMAIS bloquant : sans clé d'embedding, sans vecteurs, ou en cas d'échec → liste vide,
 *     le lexical continue seul (et la COUVERTURE le dit) ;
 *   • l'ACL n'est PAS évaluée ici : l'appelant revérifie nœud par nœud, comme pour le lexical.
 *
 * `embed` est INJECTABLE : les tests mesurent le mécanisme avec un embedder déterministe ;
 * la qualité réelle des vecteurs OpenAI se mesure, elle, en production (banc Recall).
 */

export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

export interface DriveSemanticHit {
  nodeId: string;
  /** Similarité cosinus 0..1. */
  score: number;
}

interface CachedVec { nodeId: string; vec: number[] }

let cache: { stamp: string; rows: CachedVec[] } | null = null;

async function loadVectors(): Promise<CachedVec[]> {
  const [count, last] = await Promise.all([
    prisma.driveTextIndex.count({ where: { NOT: { embedding: { equals: Prisma.AnyNull } } } }),
    prisma.driveTextIndex.findFirst({
      where: { NOT: { embedding: { equals: Prisma.AnyNull } } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  const stamp = `${count}:${last?.updatedAt.getTime() ?? 0}`;
  if (cache?.stamp === stamp) return cache.rows;
  const rows = await prisma.driveTextIndex.findMany({
    where: { NOT: { embedding: { equals: Prisma.AnyNull } } },
    select: { nodeId: true, embedding: true },
    take: 8_000,
  });
  const vecs: CachedVec[] = [];
  for (const r of rows) {
    if (Array.isArray(r.embedding)) vecs.push({ nodeId: r.nodeId, vec: r.embedding as number[] });
  }
  cache = { stamp, rows: vecs };
  return vecs;
}

/** Vide le cache de processus — pour les tests et après un gros backfill. */
export function resetDriveSemanticCache(): void { cache = null; }

/**
 * Les candidats SÉMANTIQUES pour une requête — triés par similarité, seuil anti-bruit.
 * Renvoie [] sans clé / sans vecteurs / sur échec : le lexical reste le chemin principal.
 */
export async function driveSemanticCandidates(
  query: string,
  limit = 8,
  embed: EmbedFn = (t) => lunaEmbed(t),
): Promise<DriveSemanticHit[]> {
  try {
    const q = (query ?? "").trim();
    if (q.length < 3) return [];
    const [qv] = (await embed([q])) ?? [];
    if (!qv) return [];
    const rows = await loadVectors();
    if (!rows.length) return [];
    return rows
      .map((r) => ({ nodeId: r.nodeId, score: cosine(qv, r.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter((h) => h.score > 0.3); // en dessous, ce n'est plus une similarité, c'est du bruit
  } catch (e) {
    console.error("[semantic-drive] recherche impossible (lexical seul)", e);
    return [];
  }
}

/**
 * Vectorise un TEXTE d'index au moment de l'indexation — jamais bloquant, jamais obligatoire.
 * Rend true si un vecteur a été écrit.
 */
export async function embedDriveIndexEntry(nodeId: string, text: string, embed: EmbedFn = (t) => lunaEmbed(t)): Promise<boolean> {
  try {
    const body = (text ?? "").slice(0, 4_000).trim();
    if (!body) return false;
    const [vec] = (await embed([body])) ?? [];
    if (!vec) return false;
    await prisma.driveTextIndex.update({ where: { nodeId }, data: { embedding: vec } });
    return true;
  } catch {
    return false;
  }
}

/**
 * RATTRAPAGE BORNÉ : vectorise un paquet d'entrées d'index sans vecteur — appelé par
 * l'ingestion planifiée (un paquet par passage, jamais plus).
 */
export async function embedDriveBacklog(batch = 40, embed: EmbedFn = (t) => lunaEmbed(t)): Promise<number> {
  try {
    const rows = await prisma.driveTextIndex.findMany({
      where: { embedding: { equals: Prisma.AnyNull }, text: { not: "" } },
      select: { nodeId: true, text: true },
      orderBy: { updatedAt: "desc" },
      take: batch,
    });
    if (!rows.length) return 0;
    const vecs = await embed(rows.map((r) => r.text.slice(0, 4_000)));
    if (!vecs) return 0;
    let done = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!Array.isArray(vecs[i])) continue;
      await prisma.driveTextIndex.update({ where: { nodeId: rows[i].nodeId }, data: { embedding: vecs[i] } }).catch(sansBloquer("semantic-drive.embedDriveBacklog.driveTextIndex"));
      done += 1;
    }
    return done;
  } catch {
    return 0;
  }
}
