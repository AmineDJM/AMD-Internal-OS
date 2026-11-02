import { prisma } from "@/lib/prisma";
import { lunaEmbed } from "@/lib/openai-luna";
import { sansBloquer } from "@/lib/journal";

/**
 * RECHERCHE SÉMANTIQUE SUR LE CORPUS — le complément que le lexical ne fournira jamais.
 *
 * Le corpus est largement en ANGLAIS (ICH, EMA, OMS) et les requêtes en FRANÇAIS : « durée de
 * conservation » ne matchera jamais « shelf life » en plein-texte. Les vecteurs, si — c'est
 * précisément leur métier.
 *
 * Architecture assumée, à cette échelle (quelques milliers de sections actives) :
 *   • PAS de pgvector (indisponible ici) : les vecteurs vivent en JSONB et le calcul se fait en
 *     mémoire — un cosinus sur 5 000 vecteurs de 512 dimensions prend quelques millisecondes ;
 *   • un CACHE de processus, estampillé par (nombre, dernière écriture) : la première recherche
 *     charge les vecteurs, les suivantes ne touchent plus la base ; toute ingestion ou activation
 *     change l'estampille et invalide le cache d'elle-même ;
 *   • JAMAIS bloquant : sans clé d'embedding, sans vecteurs, ou en cas d'échec → liste vide, et
 *     la recherche lexicale continue seule.
 */

export interface SemanticHit {
  sectionId: string;
  /** Similarité cosinus 0..1 — comparable d'une requête à l'autre. */
  score: number;
}

/** Cosinus de deux vecteurs de même taille. Fonction PURE — testée. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Fusion lexical + sémantique. L'UNION, ordonnée par le meilleur score NORMALISÉ des deux
 * mondes : un texte trouvé par les deux voies est plus sûr qu'un texte trouvé par une seule,
 * mais un excellent résultat sémantique ne doit pas être noyé par dix résultats lexicaux
 * médiocres. Fonction PURE — testée.
 */
export function mergeHybrid<T extends { id: string; score: number }>(
  lexical: T[],
  semantic: T[],
  limit: number,
): T[] {
  const norm = (list: T[]) => {
    const max = Math.max(...list.map((x) => x.score), 1e-9);
    return list.map((x) => ({ ...x, score: x.score / max }));
  };
  const byId = new Map<string, T>();
  for (const x of [...norm(lexical), ...norm(semantic)]) {
    const prev = byId.get(x.id);
    // Présent dans les DEUX voies : petit bonus — la convergence est un signal.
    if (prev) byId.set(x.id, { ...x, score: Math.max(prev.score, x.score) + 0.15 });
    else byId.set(x.id, x);
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Cache de processus : vecteurs des sections ACTIVES.
let cache: { stamp: string; rows: { sectionId: string; vec: number[] }[] } | null = null;

async function activeStamp(): Promise<string> {
  const agg = await prisma.regulatorySourceSection.aggregate({
    where: { embedding: { not: undefined }, sourceVersion: { status: "ACTIVE" } },
    _count: { id: true },
  });
  const latest = await prisma.regulatorySourceVersion.aggregate({ _max: { createdAt: true }, where: { status: "ACTIVE" } });
  return `${agg._count.id}:${latest._max.createdAt?.getTime() ?? 0}`;
}

async function loadVectors(): Promise<{ sectionId: string; vec: number[] }[]> {
  const stamp = await activeStamp();
  if (cache?.stamp === stamp) return cache.rows;
  const rows = await prisma.regulatorySourceSection.findMany({
    where: { embedding: { not: undefined }, sourceVersion: { status: "ACTIVE" } },
    select: { id: true, embedding: true },
  });
  const parsed = rows
    .map((r) => ({ sectionId: r.id, vec: Array.isArray(r.embedding) ? (r.embedding as number[]) : [] }))
    .filter((r) => r.vec.length > 0);
  cache = { stamp, rows: parsed };
  return parsed;
}

/** Top-k sémantique parmi les sections actives. Vide si pas de clé / pas de vecteurs. */
export async function semanticSearchSections(query: string, limit = 8): Promise<SemanticHit[]> {
  try {
    const q = (query ?? "").trim();
    if (q.length < 3) return [];
    const [qv] = (await lunaEmbed([q])) ?? [];
    if (!qv) return [];
    const rows = await loadVectors();
    if (rows.length === 0) return [];
    return rows
      .map((r) => ({ sectionId: r.sectionId, score: cosine(qv, r.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter((h) => h.score > 0.25); // en dessous, ce n'est plus une similarité, c'est du bruit
  } catch (e) {
    console.error("[semantic] recherche impossible (lexical seul)", e);
    return [];
  }
}

/**
 * RATTRAPAGE BORNÉ : vectorise un paquet de sections/réserves qui n'ont pas encore de vecteur.
 * Appelé par le planificateur — un paquet par passage, jamais plus : le rattrapage d'un gros
 * corpus s'étale sur quelques passages plutôt que de bloquer un tick entier.
 */
export async function embedBacklog(batch = 96): Promise<number> {
  try {
    let done = 0;
    const sections = await prisma.regulatorySourceSection.findMany({
      where: { embedding: { equals: undefined } },
      select: { id: true, heading: true, text: true },
      take: batch,
    });
    if (sections.length > 0) {
      const vecs = await lunaEmbed(sections.map((s) => `${s.heading ?? ""}\n${s.text}`.trim()));
      if (vecs) {
        for (let i = 0; i < sections.length; i++) {
          await prisma.regulatorySourceSection.update({ where: { id: sections[i].id }, data: { embedding: vecs[i] } }).catch(sansBloquer("semantic.embedBacklog.regulatorySourceSection"));
        }
        done += sections.length;
      }
    }

    const reserves = await prisma.anppReserve.findMany({
      where: { embedding: { equals: undefined } },
      select: { id: true, verbatim: true, ctdSection: true },
      take: batch,
    });
    if (reserves.length > 0) {
      const vecs = await lunaEmbed(reserves.map((r) => `${r.ctdSection ?? ""} ${r.verbatim}`.trim()));
      if (vecs) {
        for (let i = 0; i < reserves.length; i++) {
          await prisma.anppReserve.update({ where: { id: reserves[i].id }, data: { embedding: vecs[i] } }).catch(sansBloquer("semantic.embedBacklog.anppReserve"));
        }
        done += reserves.length;
      }
    }

    // Documents d'ÉTUDES DE CAS (module Entraînement IA) : mêmes vecteurs, même rattrapage.
    const caseDocs = await prisma.regulatoryCaseDoc.findMany({
      where: { embedding: { equals: undefined } },
      select: { id: true, filename: true, ctdSection: true, text: true },
      take: batch,
    });
    if (caseDocs.length > 0) {
      const vecs = await lunaEmbed(caseDocs.map((c) => `${c.ctdSection ?? ""} ${c.filename}\n${c.text}`.trim()));
      if (vecs) {
        for (let i = 0; i < caseDocs.length; i++) {
          await prisma.regulatoryCaseDoc.update({ where: { id: caseDocs[i].id }, data: { embedding: vecs[i] } }).catch(sansBloquer("semantic.embedBacklog.regulatoryCaseDoc"));
        }
        done += caseDocs.length;
      }
    }
    return done;
  } catch (e) {
    console.error("[semantic] rattrapage impossible", e);
    return 0;
  }
}
