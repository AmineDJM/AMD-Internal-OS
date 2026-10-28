import { prisma } from "@/lib/prisma";
import { foldOrg, rankOrgCandidates } from "@/lib/name-match";
import {
  type EntityCandidate,
  type EntityKind,
  type EntityResolution,
  MIN_CANDIDATE_SCORE,
  isDecisive,
} from "./contract";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSOLVEUR — « de quoi parle-t-on ? », une seule fois, pour tout l'ERP.
 *
 * ── LA STRATÉGIE, DANS L'ORDRE DU MOINS CHER ─────────────────────────────────────────────
 *
 *   1. **La graphie exacte.** Un index sur `aliasFold` : une lecture, aucune comparaison. C'est
 *      le cas de LOIN le plus fréquent (« Keytruda », « REG-2026-041 », « Adventum »), et il doit
 *      coûter le prix d'un `WHERE =`.
 *   2. **Le trigramme.** Postgres rapproche les graphies voisines via l'index GIN — c'est lui qui
 *      absorbe les fautes de frappe SANS rapatrier tous les alias en mémoire.
 *   3. **Le classement fin**, en mémoire, sur la petite liste que (1) et (2) ont ramenée :
 *      acronymes, mots contenus, recouvrement, distance d'édition.
 *
 * Aucun modèle n'intervient. C'est la doctrine §2 appliquée à la lettre : appeler Luna pour
 * décider que « Keytruda » est Keytruda serait payer un modèle pour ce qu'un index sait faire.
 *
 * ── CE QUE LE RÉSOLVEUR NE FAIT PAS ──────────────────────────────────────────────────────
 *
 * Il ne TRANCHE pas quand deux candidats se valent. `kind: "ambiguous"` est une réponse complète,
 * pas un échec : l'appelant pose une question, ou range les deux. Choisir au hasard d'un ordre de
 * tri entre deux fournisseurs homonymes serait la seule issue vraiment inacceptable.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Combien de candidats on ramène de la base avant le classement fin. */
const FETCH_LIMIT = 60;

/** Le seuil de similarité trigramme. En dessous, Postgres ramène du bruit — mesuré, pas deviné. */
const TRGM_THRESHOLD = 0.42;

export interface ResolveOptions {
  /** Restreindre aux familles attendues — « qui est X ? » ne cherche pas une molécule. */
  kinds?: EntityKind[];
  /** Cloisonnement : n'accepter que les entités d'une entité juridique (ou communes). */
  companyId?: string | null;
  limit?: number;
}

interface AliasRow {
  entityId: string;
  alias: string;
  aliasFold: string;
  weight: number;
  kind: string;
  canonicalName: string;
  refType: string | null;
  refId: string | null;
  companyId: string | null;
}

/**
 * RÉSOUT UNE MENTION. Ne lève jamais : une résolution qui échoue rend `none`, et l'appelant
 * continue avec ce qu'il a — une couche d'index ne doit pas casser un écran.
 */
export async function resolveEntity(mention: string, opts: ResolveOptions = {}): Promise<EntityResolution> {
  const q = foldOrg(mention);
  const empty: EntityResolution = { kind: "none", best: null, candidates: [] };
  // Deux caractères ne désignent rien : « SA », « le », « M. » ramèneraient la moitié du référentiel.
  if (q.length < 2) return empty;

  try {
    const rows = await fetchCandidates(q, opts);
    if (!rows.length) return empty;

    const scored = scoreRows(mention, q, rows);
    const kept = scored.filter((c) => c.score >= MIN_CANDIDATE_SCORE).slice(0, opts.limit ?? 8);
    if (!kept.length) return empty;

    const [best, second] = kept;
    return { kind: isDecisive(best, second ?? null) ? "decisive" : "ambiguous", best, candidates: kept };
  } catch (err) {
    console.error("[knowledge] resolveEntity failed", mention, err);
    return empty;
  }
}

/**
 * RAMÈNE LES CANDIDATS PLAUSIBLES.
 *
 * La graphie exacte d'abord. Si elle donne déjà une réponse, on N'INTERROGE PAS le trigramme :
 * inutile de chercher des voisins approximatifs quand on tient le mot juste — et cela évite une
 * requête GIN sur chaque mention d'un document de quarante pages.
 */
async function fetchCandidates(q: string, opts: ResolveOptions): Promise<AliasRow[]> {
  const exact = await queryAliases({ mode: "exact", q, opts });
  if (exact.length) return exact;
  return queryAliases({ mode: "fuzzy", q, opts });
}

async function queryAliases(args: { mode: "exact" | "fuzzy"; q: string; opts: ResolveOptions }): Promise<AliasRow[]> {
  const { mode, q, opts } = args;
  const kinds = opts.kinds?.length ? opts.kinds : null;

  // SQL brut : `similarity()` et l'opérateur `%` de pg_trgm n'ont pas d'équivalent dans le client
  // Prisma, et c'est justement l'index GIN qui rend la tolérance aux fautes praticable.
  const rows = await prisma.$queryRawUnsafe<AliasRow[]>(
    `
    SELECT a."entityId", a."alias", a."aliasFold", a."weight",
           e."kind", e."canonicalName", e."refType", e."refId", e."companyId"
    FROM "KnowledgeAlias" a
    JOIN "KnowledgeEntity" e ON e."id" = a."entityId"
    WHERE e."isActive" = true
      ${mode === "exact" ? `AND a."aliasFold" = $1` : `AND similarity(a."aliasFold", $1) >= ${TRGM_THRESHOLD}`}
      ${kinds ? `AND e."kind" = ANY($2::text[])` : ""}
    ${mode === "exact" ? "" : `ORDER BY similarity(a."aliasFold", $1) DESC`}
    LIMIT ${FETCH_LIMIT}
    `,
    ...(kinds ? [q, kinds] : [q]),
  );

  // LE CLOISONNEMENT s'applique APRÈS la base, et jamais en SQL avec un `OR NULL` bricolé : une
  // entité SANS entité juridique est commune au groupe et reste visible ; une entité rattachée
  // ailleurs disparaît. Le faire ici garde la règle lisible et testable.
  if (opts.companyId === undefined) return rows;
  return rows.filter((r) => r.companyId == null || r.companyId === opts.companyId);
}

/**
 * LE CLASSEMENT FIN. Chaque entité ne garde que sa MEILLEURE graphie : proposer deux fois la même
 * société parce qu'elle a trois alias serait une fausse ambiguïté, et pousserait un bon candidat
 * hors de la liste.
 */
function scoreRows(mention: string, q: string, rows: AliasRow[]): EntityCandidate[] {
  const bestByEntity = new Map<string, EntityCandidate>();

  // Le classement générique travaille sur des chaînes ; on lui donne les graphies, puis on
  // recolle chaque score à son entité.
  const ranked = new Map<string, { score: number; why: string }>();
  for (const m of rankOrgCandidates(mention, [...new Set(rows.map((r) => r.alias))])) {
    ranked.set(foldOrg(m.value), { score: m.score, why: m.why });
  }

  for (const r of rows) {
    const base = r.aliasFold === q
      ? { score: 1, why: "graphie exacte" }
      : ranked.get(r.aliasFold);
    if (!base) continue;

    // LE POIDS DE LA GRAPHIE entre ici, et pas avant : un acronyme dérivé qui colle parfaitement
    // reste un acronyme dérivé, donc un candidat plus faible qu'une raison sociale qui colle
    // aussi bien. Sans cette pondération, « SAI » gagnerait contre la société qui s'appelle
    // réellement ainsi.
    const score = base.score * r.weight;
    const cand: EntityCandidate = {
      entityId: r.entityId,
      kind: r.kind as EntityKind,
      canonicalName: r.canonicalName,
      refType: r.refType,
      refId: r.refId,
      companyId: r.companyId,
      score,
      why: r.aliasFold === q && r.alias !== r.canonicalName ? `« ${r.alias} » désigne ${r.canonicalName}` : base.why,
      matchedAlias: r.alias,
    };
    const prev = bestByEntity.get(r.entityId);
    if (!prev || cand.score > prev.score) bestByEntity.set(r.entityId, cand);
  }

  return [...bestByEntity.values()].sort((a, b) => b.score - a.score);
}

/**
 * RÉSOUT PLUSIEURS MENTIONS D'UN COUP, sans redemander deux fois la même.
 *
 * Un document cite souvent la même société vingt fois. Sans ce dédoublonnage, indexer un contrat
 * de quarante pages ferait vingt requêtes identiques — et l'utilisateur paierait en latence une
 * répétition que le code peut voir.
 */
export async function resolveMany(
  mentions: string[],
  opts: ResolveOptions = {},
): Promise<Map<string, EntityResolution>> {
  const out = new Map<string, EntityResolution>();
  const unique = [...new Set(mentions.map((m) => m.trim()).filter((m) => m.length >= 2))];
  for (const m of unique) {
    const key = foldOrg(m);
    if (!key || out.has(key)) continue;
    out.set(key, await resolveEntity(m, opts));
  }
  return out;
}

/** L'entité d'une fiche ERP précise — le chemin inverse, quand on part de l'objet. */
export async function entityForRecord(refType: string, refId: string): Promise<EntityCandidate | null> {
  const e = await prisma.knowledgeEntity
    .findFirst({
      where: { refType, refId, isActive: true },
      select: { id: true, kind: true, canonicalName: true, refType: true, refId: true, companyId: true },
    })
    .catch(sansBloquer("resolve.entityForRecord.knowledgeEntity", null));
  if (!e) return null;
  return {
    entityId: e.id, kind: e.kind as EntityKind, canonicalName: e.canonicalName,
    refType: e.refType, refId: e.refId, companyId: e.companyId,
    score: 1, why: "fiche ERP", matchedAlias: e.canonicalName,
  };
}
