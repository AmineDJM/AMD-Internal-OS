import { prisma } from "@/lib/prisma";
import type { RelationPredicate } from "../contract";
import { extractMentions, mentionConfidence } from "./extract";
import { resolveEntity } from "./resolve";
import { CONFIDENCE_VERIFY } from "../contract";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TISSAGE — le texte d'un document devient des arêtes du graphe.
 *
 * ── LA RÈGLE DE SÛRETÉ (§22) ─────────────────────────────────────────────────────────────
 *
 * Une arête est une DONNÉE STRUCTURÉE. Elle ne s'écrit donc pas depuis une intuition : il faut
 * que la résolution soit `decisive` ET que la confiance combinée tienne le seuil. Une mention
 * ambiguë n'écrit RIEN — elle n'écrit surtout pas « probablement celle-ci ».
 *
 * Le prix de cette prudence est un lien manquant, que l'utilisateur retrouve quand même par le
 * texte (le document est indexé depuis l'ingestion rapide). Le prix de l'imprudence serait un
 * contrat rattaché au mauvais fournisseur dans un écran qui a l'air sûr de lui.
 *
 * ── POURQUOI `mentions` ET PAS `concerns` ────────────────────────────────────────────────
 *
 * Trouver « Sanofi » dans un document prouve que le document PARLE de Sanofi. Cela ne prouve pas
 * qu'il PORTE sur Sanofi — la différence entre « cité en passant » et « objet du document » ne se
 * lit pas dans une occurrence. Le prédicat reste donc `mentions`, qui est vrai. Les prédicats
 * plus forts (`concerns`, `supplies`) viennent des champs STRUCTURÉS de l'ERP, où ils sont des
 * faits, jamais d'une reconnaissance de forme dans un texte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le type d'objet visé par une arête, tel qu'il est écrit dans `KnowledgeLink.toType`. */
export const ENTITY_LINK_TYPE = "entity";

export interface LinkResult {
  mentions: number;
  resolved: number;
  written: number;
  ambiguous: number;
}

/**
 * TISSE LES LIENS D'UN ÉLÉMENT. Ne lève pas : un document mal relié reste un document trouvable.
 */
export async function linkEntitiesForItem(itemId: string): Promise<LinkResult> {
  const out: LinkResult = { mentions: 0, resolved: 0, written: 0, ambiguous: 0 };

  const item = await prisma.knowledgeItem
    .findUnique({ where: { id: itemId }, select: { id: true, text: true, title: true, companyId: true } })
    .catch(sansBloquer("link.linkEntitiesForItem.knowledgeItem", null));
  if (!item) return out;

  // Le TITRE compte double, littéralement : il est concaténé au texte, donc ses mentions sont vues
  // deux fois et remontent au classement. Un nom dans le titre d'un fichier est rarement fortuit.
  const haystack = [item.title, item.title, item.text].filter(Boolean).join("\n");
  if (!haystack.trim()) return out;

  const mentions = extractMentions(haystack);
  out.mentions = mentions.length;
  if (!mentions.length) return out;

  const rows: { itemId: string; predicate: RelationPredicate; toType: string; toId: string; confidence: number; mention: string }[] = [];
  const seen = new Set<string>();

  for (const m of mentions) {
    const res = await resolveEntity(m.text, {
      // Le cloisonnement suit celui du document : un fichier d'Adventum ne doit pas se relier à
      // une entité de Pharmagène par homonymie.
      companyId: item.companyId,
    });
    if (res.kind === "none" || !res.best) continue;
    out.resolved += 1;
    if (res.kind === "ambiguous") { out.ambiguous += 1; continue; }

    const confidence = res.best.score * mentionConfidence(m.form);
    if (confidence < CONFIDENCE_VERIFY) continue;
    if (seen.has(res.best.entityId)) continue;
    seen.add(res.best.entityId);

    rows.push({
      itemId: item.id,
      predicate: "mentions",
      toType: ENTITY_LINK_TYPE,
      toId: res.best.entityId,
      confidence,
      // La mention EXACTE telle qu'elle figure dans le document : c'est elle qui permet de dire
      // « ce lien vient d'ici » et donc de le contester.
      mention: m.text.slice(0, 200),
    });
  }

  if (rows.length) {
    // `skipDuplicates` plutôt qu'un vidage préalable : rejouer le tissage ne doit pas faire
    // clignoter les liens d'un document — un écran ouvert pendant le passage verrait un instant
    // un document relié à rien.
    const written = await prisma.knowledgeLink.createMany({ data: rows, skipDuplicates: true }).catch(sansBloquer("link.linkEntitiesForItem.knowledgeLink", { count: 0 }));
    out.written = written.count;
  }
  return out;
}

/**
 * LES ÉLÉMENTS QUI CITENT UNE ENTITÉ — la question « qu'a-t-on sur Keytruda ? ».
 *
 * Les plus récents d'abord, et seulement les versions COURANTES : ressortir la version de mars
 * d'un contrat renégocié depuis serait une réponse fausse présentée comme un historique.
 */
export async function itemsMentioning(entityId: string, limit = 20) {
  return prisma.knowledgeLink
    .findMany({
      where: { toType: ENTITY_LINK_TYPE, toId: entityId, item: { isCurrent: true } },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        confidence: true, mention: true,
        item: { select: { id: true, sourceType: true, sourceId: true, title: true, documentDate: true, stage: true } },
      },
    })
    .catch(sansBloquer("link.itemsMentioning.knowledgeLink", []));
}
