import { prisma } from "@/lib/prisma";
import { semanticSearchSections, mergeHybrid } from "./semantic";
import { sansBloquer } from "@/lib/journal";

/**
 * RAG RÉGLEMENTAIRE (G4) — recherche dans le corpus **actif** via Postgres FTS `french`
 * (+ repli trigram `pg_trgm` si aucun résultat lexical). Retourne des **citations exactes**
 * (source, version, article/section, extrait). pgvector indisponible ici → pas d'embeddings ;
 * ce socle reste prêt pour un provider d'embeddings ultérieur.
 *
 * Règle : si aucune source active ne justifie une conclusion → l'appelant affiche
 * « EXIGENCE NON CONFIRMÉE — REVUE HUMAINE REQUISE » (jamais d'invention).
 */

export interface Citation {
  sectionId: string;
  sourceId: string;
  sourceVersionId: string;
  authority: string;
  jurisdiction: string;
  code: string;
  title: string;
  version: string;
  path: string;
  heading: string | null;
  snippet: string;
  rank: number;
}

interface Row {
  sectionId: string; sourceId: string; sourceVersionId: string; authority: string; jurisdiction: string;
  code: string; title: string; version: string; path: string; heading: string | null; snippet: string; rank: number;
}

export interface CorpusFilters {
  jurisdiction?: string;
  authority?: string;
  /** Catégorie de connaissance (« Droit du travail », « ANPP », « MIPH »…). */
  category?: string;
  limit?: number;
}

/**
 * FAÇADE HYBRIDE : lexical (FTS français + trigrammes) ∪ sémantique (vecteurs, trans-langue).
 *
 * Le lexical reste la colonne vertébrale — exact, explicable, sans dépendance. Le sémantique
 * comble son angle mort structurel : un corpus en ANGLAIS interrogé en FRANÇAIS. La fusion
 * normalise les scores des deux mondes et favorise la convergence (trouvé par les deux voies).
 * Sans clé d'embedding, la façade EST le lexical — jamais moins bien qu'avant.
 */
export async function searchCorpus(query: string, filters: CorpusFilters = {}): Promise<Citation[]> {
  const limit = Math.min(Math.max(filters.limit ?? 8, 1), 30);
  const lexical = await searchCorpusLexical(query, filters);

  const semantic = await semanticSearchSections(query, limit).catch(sansBloquer("rag.searchCorpus.semanticSearchSections", []));
  if (semantic.length === 0) return lexical;

  // Les sections sémantiques absentes du lexical doivent devenir des citations complètes.
  const known = new Set(lexical.map((c) => c.sectionId));
  const missingIds = semantic.filter((h) => !known.has(h.sectionId)).map((h) => h.sectionId);
  const extra = missingIds.length > 0 ? await citationsByIds(missingIds, filters) : [];

  const scoreOf = new Map(semantic.map((h) => [h.sectionId, h.score]));
  const merged = mergeHybrid(
    lexical.map((c) => ({ id: c.sectionId, score: c.rank, cite: c })),
    extra.concat(lexical.filter((c) => scoreOf.has(c.sectionId))).map((c) => ({ id: c.sectionId, score: scoreOf.get(c.sectionId) ?? 0, cite: c })),
    limit,
  );
  return merged.map((m) => m.cite);
}

async function searchCorpusLexical(query: string, filters: CorpusFilters = {}): Promise<Citation[]> {
  const q = (query ?? "").trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(filters.limit ?? 8, 1), 30);

  const conds: string[] = [`sv."status" = 'ACTIVE'`];
  const params: unknown[] = [q];
  let p = 2;
  if (filters.jurisdiction) { conds.push(`src."jurisdiction" = $${p++}`); params.push(filters.jurisdiction); }
  if (filters.authority) { conds.push(`src."authority" = $${p++}`); params.push(filters.authority); }
  if (filters.category) { conds.push(`src."category" = $${p++}`); params.push(filters.category); }
  const limIdx = p;
  params.push(limit);

  const base = `
    FROM "RegulatorySourceSection" sec
    JOIN "RegulatorySourceVersion" sv ON sv."id" = sec."sourceVersionId"
    JOIN "RegulatorySource" src ON src."id" = sv."sourceId"
    WHERE ${conds.join(" AND ")}`;

  // 1) Recherche lexicale FTS (français).
  const ftsSql = `
    SELECT sec."id" AS "sectionId", src."id" AS "sourceId", sv."id" AS "sourceVersionId",
      src."authority", src."jurisdiction", src."code", src."title", sv."version",
      sec."path", sec."heading",
      ts_headline('french', sec."text", plainto_tsquery('french', $1), 'MaxWords=42, MinWords=16, ShortWord=2') AS snippet,
      ts_rank(sec."search_vector", plainto_tsquery('french', $1)) AS rank
    ${base} AND sec."search_vector" @@ plainto_tsquery('french', $1)
    ORDER BY rank DESC LIMIT $${limIdx}`;

  let rows: Row[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<Row[]>(ftsSql, ...params);
  } catch {
    rows = [];
  }

  // 2) Repli trigram si le lexical ne rend rien (fautes / variantes).
  if (rows.length === 0) {
    const trgmSql = `
      SELECT sec."id" AS "sectionId", src."id" AS "sourceId", sv."id" AS "sourceVersionId",
        src."authority", src."jurisdiction", src."code", src."title", sv."version",
        sec."path", sec."heading",
        left(sec."text", 240) AS snippet,
        similarity(sec."text", $1) AS rank
      ${base} AND sec."text" % $1
      ORDER BY rank DESC LIMIT $${limIdx}`;
    try {
      rows = await prisma.$queryRawUnsafe<Row[]>(trgmSql, ...params);
    } catch {
      rows = [];
    }
  }

  return rows.map((r) => ({ ...r, rank: Number(r.rank) }));
}

/** Nombre de sections indexées dans le corpus ACTIF (diagnostic UI). */
export async function activeCorpusSize(): Promise<number> {
  try {
    return await prisma.regulatorySourceSection.count({ where: { sourceVersion: { status: "ACTIVE" } } });
  } catch {
    return 0;
  }
}


/** Citations complètes pour des sections précises (touches sémantiques hors résultat lexical). */
async function citationsByIds(sectionIds: string[], filters: CorpusFilters): Promise<Citation[]> {
  try {
    const rows = await prisma.regulatorySourceSection.findMany({
      where: {
        id: { in: sectionIds },
        sourceVersion: {
          status: "ACTIVE",
          source: {
            ...(filters.jurisdiction ? { jurisdiction: filters.jurisdiction } : {}),
            ...(filters.authority ? { authority: filters.authority } : {}),
            ...(filters.category ? { category: filters.category } : {}),
          },
        },
      },
      select: {
        id: true, path: true, heading: true, text: true,
        sourceVersion: { select: { id: true, version: true, source: { select: { id: true, authority: true, jurisdiction: true, code: true, title: true } } } },
      },
    });
    return rows.map((r) => ({
      sectionId: r.id,
      sourceId: r.sourceVersion.source.id,
      sourceVersionId: r.sourceVersion.id,
      authority: r.sourceVersion.source.authority,
      jurisdiction: r.sourceVersion.source.jurisdiction,
      code: r.sourceVersion.source.code,
      title: r.sourceVersion.source.title,
      version: r.sourceVersion.version,
      path: r.path,
      heading: r.heading,
      snippet: r.text.replace(/\s+/g, " ").trim().slice(0, 300),
      rank: 0,
    }));
  } catch {
    return [];
  }
}
