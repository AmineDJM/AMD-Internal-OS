import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * MÉMOIRE TYPÉE DU CHIEF OF STAFF — la couche de LECTURE, volontairement légère.
 *
 * Ce module ne dépend que de Prisma : il est importé à la fois par le contexte personnel
 * (`assistant-memory.ts`), par la recherche fédérée (expansion d'alias) et par les outils
 * de mémoire — sans jamais tirer le registre d'outils complet.
 *
 * ⚠️ La mémoire n'est JAMAIS la source de vérité d'une donnée métier : un salaire, un stock,
 * un statut se relisent TOUJOURS à la source. La mémoire oriente la recherche et le ton.
 */

export const MEMORY_TYPES = [
  "USER_PREFERENCE",
  "WORKING_STYLE",
  "TERMINOLOGY",
  "ENTITY_ALIAS",
  "STRATEGIC_PRIORITY",
  "RECURRING_INTEREST",
  "REPORTING_PREFERENCE",
  "ORGANIZATIONAL_CONTEXT",
  "EXECUTIVE_PRINCIPLE",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  USER_PREFERENCE: "Préférence",
  WORKING_STYLE: "Style de travail",
  TERMINOLOGY: "Terminologie",
  ENTITY_ALIAS: "Alias",
  STRATEGIC_PRIORITY: "Priorité stratégique",
  RECURRING_INTEREST: "Sujet récurrent",
  REPORTING_PREFERENCE: "Préférence de reporting",
  ORGANIZATIONAL_CONTEXT: "Contexte organisationnel",
  EXECUTIVE_PRINCIPLE: "Principe exécutif",
};

export function isMemoryType(v: string): v is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(v);
}

/** Minuscules sans accents — pour comparer « Pembro » et « pembro » sans se faire piéger. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

interface AliasPair { alias: string; target: string }

function aliasOf(item: { content: string; structuredData: unknown }): AliasPair | null {
  const d = item.structuredData as { alias?: unknown; target?: unknown } | null;
  if (d && typeof d.alias === "string" && typeof d.target === "string" && d.alias.trim() && d.target.trim()) {
    return { alias: d.alias.trim(), target: d.target.trim() };
  }
  // Repli : « pembro = Pembrolizumab » écrit en clair dans le contenu.
  const m = item.content.match(/^\s*(.{1,60}?)\s*=\s*(.{1,120}?)\s*$/);
  return m ? { alias: m[1], target: m[2] } : null;
}

/**
 * Le bloc mémoire injecté dans le prompt système : alias d'abord (une ligne chacun), puis les
 * mémoires les plus récentes. BORNÉ — on n'injecte jamais toute la mémoire, on garde la place
 * pour la conversation.
 */
export async function typedMemoryContext(userId: string): Promise<string> {
  const items = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { type: true, content: true, structuredData: true },
  });
  if (items.length === 0) return "";

  const aliasLines: string[] = [];
  const otherLines: string[] = [];
  for (const it of items) {
    if (it.type === "ENTITY_ALIAS" || it.type === "TERMINOLOGY") {
      const pair = aliasOf(it);
      aliasLines.push(pair ? `${pair.alias} = ${pair.target}` : it.content);
    } else if (otherLines.length < 12) {
      const label = isMemoryType(it.type) ? MEMORY_TYPE_LABEL[it.type] : it.type;
      otherLines.push(`- [${label}] ${it.content}`);
    }
  }

  const parts: string[] = ["\nMÉMOIRE DURABLE (ce que cette personne t'a demandé de retenir) :"];
  if (aliasLines.length) parts.push(`Vocabulaire et alias : ${aliasLines.slice(0, 25).join(" ; ")}.`);
  if (otherLines.length) parts.push(otherLines.join("\n"));
  parts.push(
    "⚠️ Cette mémoire n'est JAMAIS la source de vérité d'une donnée métier : un salaire, un stock, " +
    "un statut, un montant se relisent TOUJOURS à la source via les outils, même si la mémoire en garde une trace.",
  );
  return parts.join("\n");
}

export interface QueryExpansion {
  /** La requête enrichie (originale + cibles des alias reconnus). */
  query: string;
  /** Les correspondances appliquées, pour l'expliquer dans la réponse. */
  expansions: AliasPair[];
}

/**
 * EXPANSION D'ALIAS pour la recherche : « où en est pembro ? » cherche aussi « Pembrolizumab ».
 * Ne touche pas la requête si aucun alias ne s'applique. Meilleur-effort : toute erreur rend
 * la requête d'origine (la recherche ne doit jamais échouer à cause de la mémoire).
 */
export async function expandQueryWithAliases(userId: string, query: string): Promise<QueryExpansion> {
  const bare: QueryExpansion = { query, expansions: [] };
  if (query.trim().length < 2) return bare;
  try {
    const items = await prisma.assistantMemoryItem.findMany({
      where: { userId, active: true, type: { in: ["ENTITY_ALIAS", "TERMINOLOGY"] } },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, content: true, structuredData: true },
    });
    if (items.length === 0) return bare;

    const folded = ` ${foldText(query)} `;
    const applied: AliasPair[] = [];
    const usedIds: string[] = [];
    for (const it of items) {
      const pair = aliasOf(it);
      if (!pair) continue;
      const needle = foldText(pair.alias);
      // Mot entier (bordé par un non-alphanumérique) — « dt » ne doit pas s'allumer dans « update ».
      const at = folded.indexOf(needle);
      const whole =
        at >= 0 &&
        !/[a-z0-9]/.test(folded[at - 1] ?? " ") &&
        !/[a-z0-9]/.test(folded[at + needle.length] ?? " ");
      if (whole && !folded.includes(foldText(pair.target))) {
        applied.push(pair);
        usedIds.push(it.id);
      }
    }
    if (applied.length === 0) return bare;

    // Trace d'usage, sans bloquer la recherche.
    prisma.assistantMemoryItem
      .updateMany({ where: { id: { in: usedIds } }, data: { lastUsedAt: new Date() } })
      .catch(sansBloquer("memory-context.expandQueryWithAliases.assistantMemoryItem"));

    return { query: `${query} ${applied.map((p) => p.target).join(" ")}`, expansions: applied };
  } catch {
    return bare;
  }
}
