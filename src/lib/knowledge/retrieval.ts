import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lunaEmbed, lunaConfigured, EMBED_DIMS } from "@/lib/openai-luna";
import type { KnowledgeMeta, KnowledgeSourceType, RelationPredicate } from "./contract";
import { fold } from "./text";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RETRIEVAL — la seule porte, et elle est gardée.
 *
 * ── CE QUE CETTE COUCHE PROMET À SES APPELANTS ───────────────────────────────────────────
 *
 * Ni Adam, ni un écran métier n'ont à connaître le hachage, les versions, les morceaux, les
 * vecteurs ou la file. Ils posent une question ; ils reçoivent des extraits CITABLES, avec leur
 * provenance. Toute la complexité reste de ce côté-ci.
 *
 * ── LA GARDE, ET POURQUOI ELLE EST À LA LECTURE ──────────────────────────────────────────
 *
 * L'ingestion stocke SANS lire les droits ; c'est la RECHERCHE qui les revérifie. Ce n'est pas
 * un raccourci, c'est le même choix que l'index Drive existant, et il est plus sûr : les droits
 * changent (une personne quitte un service, un document devient confidentiel) alors qu'un index
 * figé au moment du dépôt garderait éternellement la permission d'hier.
 *
 * La conséquence est une règle stricte : **aucune fonction de ce fichier ne rend un extrait sans
 * avoir passé le filtre**. Le filtre est INJECTÉ (`canSee`) parce que les règles d'accès
 * appartiennent à chaque domaine — le Drive sait qui voit un nœud, Regulatory sait qui voit un
 * dossier. Les recopier ici en ferait une seconde vérité, qui divergerait.
 *
 * ── CE QUE CETTE COUCHE NE FAIT PAS ENCORE ───────────────────────────────────────────────
 *
 * pgvector n'est pas disponible sur cette infrastructure (vérifié, pas supposé) : la recherche
 * par le SENS reste celle du produit — vecteurs en JSONB, cosinus en mémoire.
 *
 * La recherche est donc HYBRIDE à quatre étages : EXACT, LEXICAL, SÉMANTIQUE, MÉTADONNÉES. Le
 * sémantique n'entre en jeu que si les vecteurs existent ET que la question est assez longue pour
 * porter une intention — sur « BC 2026 », le lexical est meilleur ET gratuit. Sans clé OpenAI,
 * l'étage se retire silencieusement : la recherche est alors dégradée, jamais cassée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La question posée. Tout est optionnel sauf le texte — le reste RESSERRE. */
export interface SearchQuery {
  text?: string;
  sourceTypes?: KnowledgeSourceType[];
  docType?: string;
  companyId?: string | null;
  /** Situer dans le temps (§16). Absent = la situation ACTUELLE. */
  asOf?: Date;
  /** Les versions closes sont exclues par défaut : on cherche ce qui vaut aujourd'hui. */
  includeSuperseded?: boolean;
  limit?: number;
}

export interface SearchHit {
  itemId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  docType: string | null;
  /** L'extrait le plus pertinent, avec de quoi le CITER. */
  snippet: string;
  locator: string | null;
  label: string | null;
  documentDate: Date | null;
  version: number;
  /** Ce qui a fait remonter ce résultat — l'utilisateur a le droit de le savoir. */
  matchedBy: "exact" | "lexical" | "semantic" | "metadata";
  score: number;
}

/**
 * LE FILTRE D'ACCÈS. Injecté par l'appelant, qui connaît SES règles.
 *
 * Rend la liste des identifiants d'éléments que ce compte peut voir. Un filtre absent est traité
 * comme « personne ne voit rien » — refuser par défaut est la seule position tenable quand la
 * question est « a-t-il le droit ? ».
 */
export type AccessFilter = (items: { itemId: string; sourceType: string; sourceId: string }[]) => Promise<Set<string>>;

const DEFAULT_LIMIT = 20;
/** On récupère large avant de filtrer : sinon un compte peu autorisé rendrait une page vide. */
const OVERFETCH = 4;

/**
 * RECHERCHE HYBRIDE — exact, puis lexical, puis métadonnées.
 *
 * L'ordre EST le classement. Une référence exacte (« REG-2026-041 ») bat toujours une
 * correspondance lexicale : quand quelqu'un tape une référence, il ne cherche pas « des
 * documents qui en parlent », il cherche CELUI-LÀ.
 */
export async function search(q: SearchQuery, canSee: AccessFilter): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), 100);
  const needle = (q.text ?? "").trim();

  const where = {
    ...(q.sourceTypes?.length ? { sourceType: { in: q.sourceTypes } } : {}),
    ...(q.docType ? { docType: q.docType } : {}),
    ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
    ...temporalWhere(q),
  };

  // ── EXACT. La référence telle qu'elle est écrite dans le document.
  const exact = needle
    ? await prisma.knowledgeItem.findMany({
        where: { ...where, OR: [{ title: { contains: needle, mode: "insensitive" as const } }, { sourceId: needle }] },
        take: limit * OVERFETCH,
        orderBy: { documentDate: "desc" },
        select: SELECT_ITEM,
      })
    : [];

  // ── LEXICAL. Sur la colonne REPLIÉE, servie par l'index trigramme.
  //
  // LE DÉFAUT QUE CE DÉCOUPAGE CORRIGE. La requête entière servait de motif `contains` : « que
  // dit le contrat sur la pénalité de retard ? » n'est une sous-chaîne d'AUCUN document, donc
  // l'étage lexical ne rendait jamais rien dès que la question faisait plus d'un mot. Autant dire
  // qu'il ne servait qu'aux recherches d'un seul terme. On cherche désormais les MOTS
  // DISCRIMINANTS, et un morceau qui les contient TOUS remonte — c'est la conjonction qui fait la
  // précision, l'index trigramme qui fait la vitesse.
  const folded = fold(needle);
  const terms = lexicalTerms(folded);
  const lexical = terms.length
    ? await prisma.knowledgeChunk.findMany({
        where: { AND: terms.map((t) => ({ textFold: { contains: t } })), item: where },
        take: limit * OVERFETCH,
        orderBy: { item: { documentDate: "desc" } },
        select: { ord: true, label: true, locator: true, text: true, item: { select: SELECT_ITEM } },
      })
    : [];

  // ── LEXICAL ÉLARGI. Si la conjonction ne rend rien, on retente sur les mots les plus
  //    DISCRIMINANTS pris séparément. Rendre trop vaut mieux que rendre rien : le reclassement
  //    coupera, alors qu'une liste vide ne se rattrape pas.
  const lexicalLoose = !lexical.length && terms.length > 1
    ? await prisma.knowledgeChunk.findMany({
        where: { OR: longestTerms(terms).map((t) => ({ textFold: { contains: t } })), item: where },
        take: limit * OVERFETCH,
        orderBy: { item: { documentDate: "desc" } },
        select: { ord: true, label: true, locator: true, text: true, item: { select: SELECT_ITEM } },
      })
    : [];

  // ── SÉMANTIQUE. Le SENS, quand la question en porte un et que les vecteurs existent.
  const semantic = needle.length >= SEMANTIC_MIN_QUERY ? await semanticChunks(needle, where, limit * OVERFETCH) : [];

  // ── MÉTADONNÉES SEULES. Sans texte, la question porte sur un TYPE ou une période.
  const byMeta = !needle
    ? await prisma.knowledgeItem.findMany({ where, take: limit * OVERFETCH, orderBy: { documentDate: "desc" }, select: SELECT_ITEM })
    : [];

  const hits = new Map<string, SearchHit>();
  const add = (h: SearchHit) => {
    const prev = hits.get(h.itemId);
    // Un même document trouvé deux fois garde sa MEILLEURE justification, pas la dernière.
    if (!prev || h.score > prev.score) hits.set(h.itemId, h);
  };

  for (const it of exact) add(hitOf(it, { matchedBy: "exact", score: 1, snippet: it.text?.slice(0, 300) ?? "" }));
  for (const c of lexical) {
    add(hitOf(c.item, {
      matchedBy: "lexical",
      score: 0.6,
      snippet: excerpt(c.text, terms[0] ?? folded),
      locator: c.locator,
      label: c.label,
    }));
  }
  for (const c of lexicalLoose) {
    // Score plus bas : un morceau qui contient UN des mots demandés est un candidat, pas une
    // réponse. Le distinguer évite qu'un repli élargi passe pour une correspondance franche.
    add(hitOf(c.item, {
      matchedBy: "lexical",
      score: 0.45,
      snippet: excerpt(c.text, longestTerms(terms)[0] ?? folded),
      locator: c.locator,
      label: c.label,
    }));
  }
  for (const s of semantic) {
    // Le score sémantique est BORNÉ SOUS le lexical : une correspondance de mots exacts est une
    // preuve, une proximité de vecteurs est une ressemblance. Les mettre à égalité ferait passer
    // un document « qui parle du même sujet » devant celui qui contient le mot demandé.
    add(hitOf(s.item, {
      matchedBy: "semantic",
      score: 0.35 + s.similarity * 0.2,
      snippet: s.text.slice(0, 300),
      locator: s.locator,
      label: s.label,
    }));
  }
  for (const it of byMeta) add(hitOf(it, { matchedBy: "metadata", score: 0.3, snippet: it.text?.slice(0, 300) ?? "" }));

  const all = [...hits.values()].sort((a, b) => b.score - a.score || (b.documentDate?.getTime() ?? 0) - (a.documentDate?.getTime() ?? 0));

  // ── LA GARDE. Rien ne sort d'ici sans être passé par elle.
  const allowed = await canSee(all.map((h) => ({ itemId: h.itemId, sourceType: h.sourceType, sourceId: h.sourceId })));
  return all.filter((h) => allowed.has(h.itemId)).slice(0, limit);
}

/**
 * SOUS CETTE LONGUEUR, LA QUESTION N'A PAS DE SENS À CHERCHER.
 *
 * « BC 2026 » ou « ANPP » sont des MOTS, pas des intentions : le lexical les trouve mieux, tout de
 * suite, et sans encoder la question. Encoder à tout prix coûterait un appel par recherche pour
 * dégrader le classement.
 */
const SEMANTIC_MIN_QUERY = 12;

/** Au-delà, le cosinus en mémoire coûte plus que le rappel qu'il rapporte. */
const SEMANTIC_SCAN_CAP = 4_000;

/** En dessous, deux textes ne « parlent » pas du même sujet : ils se ressemblent par hasard. */
const SEMANTIC_MIN_SIMILARITY = 0.28;

interface SemanticChunk {
  item: ItemRow;
  text: string;
  label: string | null;
  locator: string | null;
  similarity: number;
}

/**
 * LE RAPPROCHEMENT PAR LE SENS.
 *
 * pgvector n'est pas disponible sur cette infrastructure (vérifié via `pg_available_extensions`,
 * pas supposé) : les vecteurs vivent en JSONB et le cosinus se calcule ICI, en mémoire. C'est le
 * même compromis que le corpus CTD et l'index Drive, et il tient tant que le nombre de morceaux
 * candidats reste borné — d'où `SEMANTIC_SCAN_CAP`, qui est une limite ASSUMÉE et non un oubli.
 *
 * Le pré-filtre `where` fait le gros du travail : on ne balaie jamais tout l'index, seulement les
 * morceaux des documents que la question concerne déjà (type, entité, période).
 */
async function semanticChunks(needle: string, where: object, take: number): Promise<SemanticChunk[]> {
  if (!lunaConfigured()) return [];

  const encoded = await lunaEmbed([needle], EMBED_DIMS).catch(sansBloquer("retrieval.semanticChunks.lunaEmbed", null));
  const query = encoded?.[0];
  if (!query) return []; // service indisponible : on se retire, la recherche continue sans nous

  const rows = await prisma.knowledgeChunk
    .findMany({
      where: { item: where, NOT: { embedding: { equals: Prisma.DbNull } } },
      take: SEMANTIC_SCAN_CAP,
      select: { text: true, label: true, locator: true, embedding: true, item: { select: SELECT_ITEM } },
    })
    .catch(sansBloquer("retrieval.semanticChunks.knowledgeChunk", []));

  const scored: SemanticChunk[] = [];
  for (const r of rows) {
    const vec = r.embedding;
    if (!Array.isArray(vec) || vec.length !== query.length) continue;
    const similarity = cosine(query, vec as number[]);
    if (similarity < SEMANTIC_MIN_SIMILARITY) continue;
    scored.push({ item: r.item, text: r.text, label: r.label, locator: r.locator, similarity });
  }

  // Un document peut avoir vingt morceaux proches ; seul le MEILLEUR le représente, sinon il
  // occuperait toute la page de résultats à lui seul.
  const best = new Map<string, SemanticChunk>();
  for (const s of scored) {
    const prev = best.get(s.item.id);
    if (!prev || s.similarity > prev.similarity) best.set(s.item.id, s);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, take);
}

/**
 * LE COSINUS. Les vecteurs de l'encodeur sont déjà normés, mais on divise quand même par les
 * normes : le jour où un vecteur vient d'ailleurs, la formule reste juste au lieu de rendre
 * discrètement des scores supérieurs à 1.
 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * LES MOTS QUI DISCRIMINENT DANS UNE REQUÊTE.
 *
 * On écarte les mots-outils du français et tout ce qui fait moins de trois lettres : ils sont
 * présents dans presque tous les documents, donc leur conjonction ne restreint rien tout en
 * coûtant un parcours d'index par mot. Ce qui reste est ce que l'utilisateur cherche vraiment.
 */
const LEXICAL_STOPWORDS = new Set([
  "que", "qui", "quoi", "quel", "quelle", "quels", "quelles", "est", "sont", "ete", "etre",
  "dit", "dire", "sur", "dans", "avec", "sans", "pour", "par", "des", "les", "une", "aux",
  "cette", "cet", "ces", "son", "sa", "ses", "leur", "leurs", "nos", "notre", "vos", "votre",
  "plus", "moins", "tout", "tous", "toute", "toutes", "fait", "faire", "avoir", "the", "and",
  "what", "does", "with", "from", "this", "that",
]);

export function lexicalTerms(folded: string, max = 4): string[] {
  // DÉCOUPAGE UNICODE, ET NON `[^a-z0-9]`. La classe latine paraissait suffisante — tout le
  // français y entre. Elle jetait en réalité l'INTÉGRALITÉ d'une question écrite en arabe : plus
  // aucun terme, donc aucune requête lexicale, donc zéro résultat. Chez Adventum, l'ANPP écrit en
  // arabe ; une recherche muette sur sa langue n'est pas une limite acceptable. Constaté en
  // mesurant le corpus, sur la seule question arabe du banc — elle rappelait 0 document.
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !LEXICAL_STOPWORDS.has(w));
  // Les plus LONGS d'abord : « pénalité » restreint bien plus que « retard ». Au-delà de quatre
  // termes, chaque mot supplémentaire coûte un parcours d'index et ne retire presque rien.
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}

/** Les deux mots les plus longs — le repli élargi, quand la conjonction n'a rien rendu. */
export function longestTerms(terms: string[]): string[] {
  return terms.slice(0, 2);
}

const SELECT_ITEM = {
  id: true, sourceType: true, sourceId: true, title: true, docType: true,
  text: true, documentDate: true, version: true,
} as const;

type ItemRow = { id: string; sourceType: string; sourceId: string; title: string | null; docType: string | null; text: string | null; documentDate: Date | null; version: number };

function hitOf(it: ItemRow, over: Partial<SearchHit> & Pick<SearchHit, "matchedBy" | "score" | "snippet">): SearchHit {
  return {
    itemId: it.id,
    sourceType: it.sourceType as KnowledgeSourceType,
    sourceId: it.sourceId,
    title: it.title,
    docType: it.docType,
    documentDate: it.documentDate,
    version: it.version,
    locator: null,
    label: null,
    ...over,
  };
}

/**
 * LA FENÊTRE TEMPORELLE. Sans `asOf`, on ne rend que ce qui vaut AUJOURD'HUI : une réponse qui
 * mélangerait la V1 et la V3 d'un contrat serait pire qu'une absence de réponse.
 */
function temporalWhere(q: SearchQuery): Record<string, unknown> {
  if (q.asOf) {
    return { validFrom: { lte: q.asOf }, OR: [{ validTo: null }, { validTo: { gt: q.asOf } }] };
  }
  return q.includeSuperseded ? {} : { isCurrent: true };
}

/**
 * L'EXTRAIT AUTOUR DU TERME TROUVÉ. Rendre les 300 premiers caractères d'un document de 40 000
 * quand le terme est page 12 donne un extrait qui ne contient pas ce qu'on cherchait — et laisse
 * croire que le résultat est mauvais alors que c'est l'affichage qui l'est.
 */
export function excerpt(text: string, foldedNeedle: string, radius = 140): string {
  if (!foldedNeedle) return text.slice(0, radius * 2);
  const at = fold(text).indexOf(foldedNeedle);
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + foldedNeedle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** UN DOCUMENT, entier — après la garde, toujours. */
export async function getDocument(itemId: string, canSee: AccessFilter) {
  const item = await prisma.knowledgeItem.findUnique({
    where: { id: itemId },
    select: { ...SELECT_ITEM, meta: true, language: true, confidence: true, extractedBy: true, model: true, stage: true, validFrom: true, validTo: true, isCurrent: true },
  });
  if (!item) return null;
  const allowed = await canSee([{ itemId: item.id, sourceType: item.sourceType, sourceId: item.sourceId }]);
  if (!allowed.has(item.id)) return null;

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { itemId },
    orderBy: { ord: "asc" },
    select: { kind: true, ord: true, label: true, locator: true, text: true },
  });
  return { ...item, meta: (item.meta ?? null) as KnowledgeMeta | null, chunks };
}

/**
 * CE QUI EST RELIÉ — la question inverse du graphe : « qu'est-ce qui parle de CE produit ? ».
 *
 * C'est l'arête qui porte la réponse, donc la garde s'applique aux ÉLÉMENTS trouvés, pas à
 * l'entité de départ : savoir qu'un produit existe n'autorise pas à lire les contrats qui le
 * citent.
 */
export async function getRelated(
  target: { toType: string; toId: string },
  canSee: AccessFilter,
  opts: { predicates?: RelationPredicate[]; limit?: number } = {},
) {
  const links = await prisma.knowledgeLink.findMany({
    where: {
      toType: target.toType,
      toId: target.toId,
      ...(opts.predicates?.length ? { predicate: { in: opts.predicates } } : {}),
      item: { isCurrent: true },
    },
    take: Math.min(opts.limit ?? 40, 200),
    orderBy: { confidence: "desc" },
    select: { predicate: true, confidence: true, mention: true, item: { select: SELECT_ITEM } },
  });

  const allowed = await canSee(links.map((l) => ({ itemId: l.item.id, sourceType: l.item.sourceType, sourceId: l.item.sourceId })));
  return links
    .filter((l) => allowed.has(l.item.id))
    .map((l) => ({
      predicate: l.predicate as RelationPredicate,
      confidence: l.confidence,
      mention: l.mention,
      itemId: l.item.id,
      sourceType: l.item.sourceType as KnowledgeSourceType,
      sourceId: l.item.sourceId,
      title: l.item.title,
    }));
}

/**
 * L'HISTOIRE D'UNE SOURCE — V1 → V2 → V3 (§16).
 *
 * C'est ce qui distingue « quelle est la situation ? » de « quelle était-elle en mars ? ».
 * Les versions closes portent leur fenêtre de validité : on peut donc dater une affirmation
 * au lieu de la présenter comme intemporelle.
 */
export async function getHistory(sourceType: KnowledgeSourceType, sourceId: string, canSee: AccessFilter) {
  const rows = await prisma.knowledgeItem.findMany({
    // Une version close est archivée sous `sourceId#vN` — le préfixe les rassemble toutes.
    where: { sourceType, OR: [{ sourceId }, { sourceId: { startsWith: `${sourceId}#v` } }] },
    orderBy: { version: "asc" },
    select: { ...SELECT_ITEM, validFrom: true, validTo: true, isCurrent: true, contentHash: true },
  });
  if (!rows.length) return [];
  const allowed = await canSee(rows.map((r) => ({ itemId: r.id, sourceType: r.sourceType, sourceId: r.sourceId })));
  return rows.filter((r) => allowed.has(r.id));
}

/** L'ÉTAT ACTUEL d'une source — le raccourci de `getHistory` quand seule la V courante compte. */
export async function getCurrentState(sourceType: KnowledgeSourceType, sourceId: string, canSee: AccessFilter) {
  const item = await prisma.knowledgeItem.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } },
    select: { id: true },
  });
  return item ? getDocument(item.id, canSee) : null;
}
