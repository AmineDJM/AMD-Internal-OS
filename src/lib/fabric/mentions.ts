/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MENTIONS D'ENTITÉS — le lien document ↔ entité canonique, payé UNE fois (fabric F4).
 *
 * ── CE QUE CE MODULE CHANGE ─────────────────────────────────────────────────────────────
 *
 * « Tout ce qui concerne le Pembrolizumab » se payait à chaque question : une recherche texte
 * sur tout le corpus — qui, en plus, ne franchissait pas les ALIAS. Un document qui ne dit que
 * « Keytruda » n'apparaissait jamais quand on cherchait la DCI, alors que `RegulatoryProduct`
 * porte LES DEUX noms depuis la fusion des catalogues. L'entité canonique existait ; le lien
 * n'était persisté nulle part.
 *
 * L'extraction se fait À L'INGESTION (le même moment que la classification) et son résultat
 * est une TABLE indexée : la question « qu'est-ce qui est relié à X ? » devient une lecture
 * d'index, et « Keytruda » comme « pembrolizumab » mènent au même `entityId`.
 *
 * ── DÉTERMINISTE, ET POURQUOI C'EST NON NÉGOCIABLE ──────────────────────────────────────
 *
 * Le dictionnaire est la liste des CANONIQUES (produits : DCI + marque ; personnes : nom
 * complet ; organisations : laboratoires partenaires), replié comme le texte, apparié sur
 * FRONTIÈRES DE MOTS. Aucun modèle : une mention est un FAIT vérifiable (« ce nom apparaît
 * dans ce texte »), et un fait extrait par un modèle cesserait d'être opposable. Ce que le
 * dictionnaire ne connaît pas n'est PAS extrait — un lien absent est un manque du
 * dictionnaire, jamais une invention de lien.
 *
 * ── CE QUE LA TABLE NE DIT PAS ──────────────────────────────────────────────────────────
 *
 * Une mention n'est pas une PERTINENCE : un contrat qui cite un produit en annexe le
 * « mentionne ». Les appelants gardent leur jugement (et leur ACL — les nodeIds rendus par
 * `documentsLies` sont des CANDIDATS, revérifiés nœud par nœud par l'appelant, comme pour la
 * recherche de contenu).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

export interface EntiteDictionnaire {
  type: "PRODUIT" | "PERSONNE" | "ORGANISATION";
  id: string;
  label: string;
  /** Les clés d'appariement, REPLIÉES (minuscules sans accents), ≥ 4 caractères. */
  cles: string[];
}

const plier = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** Une clé trop courte apparie n'importe quoi ; une clé d'un seul mot très court aussi. */
const cleValide = (c: string): boolean => c.length >= 4;

/**
 * LE DICTIONNAIRE DES CANONIQUES — chargé de la base, mis en cache avec une ESTAMPILLE.
 *
 * Quelques centaines d'entrées : le garder en mémoire coûte moins qu'une requête, et le
 * recharger toutes les cinq minutes borne l'obsolescence sans bus d'invalidation. Un produit
 * créé apparaît dans les extractions au plus tard cinq minutes après — dit, pas caché.
 */
let cacheDictionnaire: { entites: EntiteDictionnaire[]; charge: number } | null = null;
const DICTIONNAIRE_TTL_MS = 5 * 60 * 1000;

export async function dictionnaireCanonique(): Promise<EntiteDictionnaire[]> {
  if (cacheDictionnaire && Date.now() - cacheDictionnaire.charge < DICTIONNAIRE_TTL_MS) {
    return cacheDictionnaire.entites;
  }
  const [produits, employes] = await Promise.all([
    prisma.regulatoryProduct.findMany({ select: { id: true, dci: true, brandName: true, partnerLab: true } }).catch(sansBloquer("mentions.dictionnaireCanonique.regulatoryProduct", [])),
    prisma.employee.findMany({ where: { isActive: true }, select: { id: true, fullName: true } }).catch(sansBloquer("mentions.dictionnaireCanonique.employee", [])),
  ]);

  const entites: EntiteDictionnaire[] = [];
  for (const p of produits) {
    const cles = [...new Set([p.dci, p.brandName].filter((x): x is string => !!x).map(plier).filter(cleValide))];
    if (cles.length > 0) entites.push({ type: "PRODUIT", id: p.id, label: p.brandName ?? p.dci, cles });
  }
  // LES PERSONNES S'APPARIENT SUR LE NOM COMPLET, jamais sur le prénom seul : « Amine » dans
  // un texte ne désigne personne en particulier, et un lien faux vaut moins que pas de lien.
  for (const e of employes) {
    const nom = plier(e.fullName);
    if (nom.includes(" ") && cleValide(nom)) entites.push({ type: "PERSONNE", id: e.id, label: e.fullName, cles: [nom] });
  }
  // LES ORGANISATIONS : les laboratoires partenaires distincts, portés par les produits. Leur
  // identifiant canonique est le LIBELLÉ plié — il n'existe pas (encore) de table dédiée, et
  // fabriquer des identifiants opaques pour une table absente serait une fausse canonicité.
  const labos = new Map<string, string>();
  for (const p of produits) {
    if (p.partnerLab && cleValide(plier(p.partnerLab))) labos.set(plier(p.partnerLab), p.partnerLab);
  }
  for (const [cle, label] of labos) entites.push({ type: "ORGANISATION", id: `lab:${cle}`, label, cles: [cle] });

  cacheDictionnaire = { entites, charge: Date.now() };
  return entites;
}

/** Vider le cache — pour les tests et après un import massif de produits. */
export function viderCacheDictionnaire(): void {
  cacheDictionnaire = null;
}

const echapper = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * EXTRAIT les mentions d'un texte REPLIÉ — pur, dictionnaire injecté, donc testable seul.
 *
 * Frontières de mots à la main (`[^a-z0-9]`) plutôt que `\b` : le texte est replié, et `\b`
 * de JavaScript raisonne en ASCII de toute façon — l'écrire explicitement enlève le doute.
 */
export function extraireMentions(
  textFold: string,
  entites: readonly EntiteDictionnaire[],
): { type: string; id: string; label: string; occurrences: number }[] {
  const out: { type: string; id: string; label: string; occurrences: number }[] = [];
  for (const e of entites) {
    let occurrences = 0;
    for (const cle of e.cles) {
      const re = new RegExp(`(?:^|[^a-z0-9])${echapper(cle)}(?:[^a-z0-9]|$)`, "g");
      occurrences += textFold.match(re)?.length ?? 0;
    }
    if (occurrences > 0) out.push({ type: e.type, id: e.id, label: e.label, occurrences });
  }
  return out;
}

/**
 * ENREGISTRE les mentions d'un document indexé — appelé à l'ingestion, meilleur-effort.
 *
 * Le remplacement est TOTAL (delete puis createMany) : une nouvelle version du fichier peut
 * avoir PERDU une mention, et un upsert seul laisserait le lien fantôme. `mentionsAt` est posé
 * même quand zéro mention : « extrait, rien trouvé » n'est pas « jamais extrait ».
 */
export async function enregistrerMentions(nodeId: string, textFold: string): Promise<number> {
  const entites = await dictionnaireCanonique();
  const mentions = extraireMentions(textFold, entites);
  await prisma.$transaction([
    prisma.entityMention.deleteMany({ where: { nodeId } }),
    ...(mentions.length > 0
      ? [prisma.entityMention.createMany({
        data: mentions.map((m) => ({
          nodeId, entityType: m.type, entityId: m.id, entityLabel: m.label, occurrences: m.occurrences,
        })),
      })]
      : []),
    prisma.driveTextIndex.update({ where: { nodeId }, data: { mentionsAt: new Date() } }),
  ]);
  return mentions.length;
}

/**
 * LE BALAYAGE DE RATTRAPAGE — les documents indexés AVANT que l'extraction existe.
 *
 * Borné et incrémental, comme les autres phases d'ingestion : `mentionsAt: null` désigne le
 * reste à faire, chaque passage en traite un lot, et un index vide d'entités est marqué
 * quand même — on ne repasse pas éternellement sur les mêmes fichiers.
 */
export async function balayerMentions(lot = 40): Promise<{ traites: number; restants: number }> {
  const aFaire = await prisma.driveTextIndex.findMany({
    where: { mentionsAt: null },
    select: { nodeId: true, textFold: true },
    orderBy: { updatedAt: "desc" },
    take: lot,
  });
  for (const d of aFaire) {
    await enregistrerMentions(d.nodeId, d.textFold).catch(sansBloquer("mentions.balayerMentions.enregistrerMentions"));
  }
  const restants = await prisma.driveTextIndex.count({ where: { mentionsAt: null } }).catch(sansBloquer("mentions.balayerMentions.driveTextIndex", 0));
  return { traites: aFaire.length, restants };
}

/**
 * LES DOCUMENTS LIÉS À UNE ENTITÉ — la lecture d'index qui remplace la re-recherche.
 *
 * Les identifiants rendus sont des CANDIDATS : l'appelant revérifie l'ACL nœud par nœud,
 * exactement comme pour `chercherContenu`. Tri par nombre d'occurrences — le document qui
 * parle dix fois du produit avant celui qui le cite une fois en annexe.
 */
export async function documentsLies(
  entityType: string,
  entityId: string,
  opts: { limit?: number } = {},
): Promise<{ nodeId: string; occurrences: number }[]> {
  const rows = await prisma.entityMention.findMany({
    where: { entityType, entityId },
    select: { nodeId: true, occurrences: true },
    orderBy: { occurrences: "desc" },
    take: Math.min(Math.max(opts.limit ?? 20, 1), 100),
  });
  return rows;
}

/**
 * RÉSOUT une requête en entités canoniques du dictionnaire — le pont entre « ce que la
 * personne a tapé » et « ce que la base connaît ». Exact sur clé pliée, frontières de mots
 * dans la requête ; jamais de rapprochement flou ici — le flou vit dans `entity-normalize`
 * et il REND ses ambiguïtés au lieu de trancher.
 */
export async function resoudreEntitesDe(requete: string): Promise<EntiteDictionnaire[]> {
  const plie = ` ${plier(requete)} `;
  const entites = await dictionnaireCanonique();
  return entites.filter((e) =>
    e.cles.some((c) => plie.includes(` ${c} `) || plie.includes(` ${c},`) || plie.includes(`(${c})`)));
}
