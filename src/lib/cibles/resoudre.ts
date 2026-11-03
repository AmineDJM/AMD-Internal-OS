import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { ENTITIES, getEntity, canReadEntity, type EntityDef } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DU TEXTE D'UN HUMAIN À UNE LIGNE DE LA BASE — un seul résolveur, pour les 29 objets.
 *
 * ── LE DÉFAUT QU'ON FERME, CHIFFRÉ ───────────────────────────────────────────────────────
 *
 * `src/lib/assistant/ops/` portait **117 résolveurs écrits à la main** : `resolveRegProduct`,
 * `resolveCompanyByName`, `resolvePerson`, un par objet et parfois un par opération. Chacun
 * cherchait à sa façon, refusait dans ses mots, et — le point qui coûte — rendait une FORME
 * QUI DÉPEND DE LA DONNÉE : `ProductHit | { error }`. C'est exactement §118.20 : l'appelant
 * écrit ses références avant de savoir ce que la recherche rendra, donc il parie.
 *
 * Ici les clés sont TOUJOURS les mêmes et c'est la VALEUR qui dit l'absence — une liste vide,
 * que tout le monde sait déjà traiter.
 *
 * ── CE QU'IL NE FAIT JAMAIS ──────────────────────────────────────────────────────────────
 *
 * Il ne DEVINE pas. Une correspondance unique désigne la cible ; PLUSIEURS n'en désignent
 * aucune — la collapser choisirait à la place d'un humain, et l'on modifierait le mauvais
 * dossier en annonçant que c'est fait (§118.34, §104.7). Zéro correspondance ne devient pas
 * « rien n'existe » : c'est « rien dans VOTRE périmètre », et le refus le dit.
 *
 * ── LA PORTÉE EST CELLE DE L'ÉCRAN ───────────────────────────────────────────────────────
 *
 * `porteeEntite` compose la portée par ligne du module ET le cloisonnement par entité — la
 * même clause que l'écran. Un résolveur qui chercherait sans elle ferait exister, le temps
 * d'un refus (« plusieurs correspondances : REG-2026-041… »), des lignes que la personne n'a
 * pas le droit de voir : un refus peut révéler autant qu'une réponse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une cible désignée — de quoi la RECONNAÎTRE à l'écran, jamais un identifiant nu. */
export interface Cible {
  id: string;
  /** Ce qu'on lit en premier : la référence si l'objet en a une, sinon son nom. */
  titre: string;
  /** Ce qui distingue deux homonymes. `null` quand l'objet n'a rien d'autre à dire. */
  sousTitre: string | null;
}

/**
 * LE CONTRAT — les trois clés sont TOUJOURS là (§118.20).
 *
 * `retenu` porte 0 ou 1 élément : la cible sur qui AGIR. Une liste plutôt qu'un `Cible | null`
 * pour la raison de `resolve_person` (§118.34) — un appelant qui déploie un éventail dessus
 * fait ce qu'il faut dans les deux cas, là où un `null` l'aurait fait planter ou deviner.
 */
export interface Resolution {
  retenu: Cible[];
  /** Ce qui ressemble quand rien n'est certain. Vide quand `retenu` est rempli. */
  candidats: Cible[];
  /** Ce qu'on a cherché et où — sans quoi un refus ne dit rien d'exploitable (§118.30). */
  cherche: { texte: string; entite: string; libelle: string };
}

/** Au-delà, ce n'est plus une désignation ambiguë : c'est une recherche, et elle a son outil. */
const MAX_CANDIDATS = 8;

const vide = (texte: string, def: EntityDef | null, nom: string): Resolution => ({
  retenu: [], candidats: [],
  cherche: { texte, entite: def?.name ?? nom, libelle: def?.label ?? nom },
});

/**
 * COMMENT ON NOMME UNE LIGNE — dérivé, jamais déclaré 29 fois.
 *
 * La référence lisible d'abord (« REG-2026-041 »), sinon le premier champ de recherche (le
 * titre, le nom, la DCI). Le sous-titre est le premier champ de recherche QUI DIFFÈRE de la
 * source du titre : c'est lui qui distingue deux dossiers de même référence tronquée.
 */
function nommer(def: EntityDef, ligne: Record<string, unknown>): Cible {
  const lire = (champ: string): string => {
    const v = ligne[champ];
    return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  };
  const champTitre = def.referenceField && lire(def.referenceField) ? def.referenceField : def.searchFields[0];
  const titre = champTitre ? lire(champTitre) : "";
  const champSous = def.searchFields.find((c) => c !== champTitre && lire(c));
  return {
    id: String(ligne.id ?? ""),
    titre: titre || String(ligne.id ?? ""),
    sousTitre: champSous ? lire(champSous) : null,
  };
}

/** Les champs à charger pour pouvoir nommer une ligne, sans tirer tout le modèle. */
const selectionNommage = (def: EntityDef): Record<string, true> => {
  const champs = new Set<string>(["id", ...def.searchFields]);
  if (def.referenceField) champs.add(def.referenceField);
  return Object.fromEntries([...champs].map((c) => [c, true as const]));
};

const modeleDe = (def: EntityDef) =>
  (prisma as unknown as Record<string, {
    findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
    findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  }>)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];

/**
 * RÉSOUT UN TEXTE VERS UNE LIGNE, dans le périmètre RÉEL de la personne.
 *
 * Trois passes, de la plus sûre à la plus large — et l'on s'arrête à la première qui désigne :
 *   1. l'IDENTIFIANT tel quel (un plan enchaîné passe l'id qu'il tient déjà, §118.35) ;
 *   2. la RÉFÉRENCE exacte, insensible à la casse (« reg-2026-041 ») ;
 *   3. ce qui CONTIENT le texte dans les champs de recherche déclarés.
 *
 * Une personne qui n'a pas le module reçoit une résolution VIDE — pas une erreur : c'est
 * l'appelant qui refuse, avec son vocabulaire et sa porte (l'action revérifie de toute façon).
 */
export async function resoudreCible(
  user: SessionUser,
  entite: string,
  texte: string,
): Promise<Resolution> {
  const def = getEntity(entite);
  const q = (texte ?? "").trim();
  if (!def) return vide(q, null, entite);
  if (!q) return vide(q, def, entite);
  if (!canReadEntity(user, def)) return vide(q, def, entite);

  const portee = await porteeEntite(user, def);
  const model = modeleDe(def);
  if (!model) return vide(q, def, entite);
  const select = selectionNommage(def);
  const trouve = (c: Cible[]): Resolution => ({
    retenu: c.length === 1 ? c : [],
    candidats: c.length === 1 ? [] : c,
    cherche: { texte: q, entite: def.name, libelle: def.label },
  });

  // 1. L'IDENTIFIANT — mais SEULEMENT s'il en a la forme. Interroger la base sur « le dossier
  //    de Nivolex » comme si c'était un identifiant est un aller-retour dont on connaît déjà
  //    la réponse : mesuré, c'est un tiers des requêtes du résolveur pour zéro résultat.
  if (ressembleAUnId(q)) {
    const parId = await model.findFirst({ where: { AND: [portee, { id: q }] }, select });
    if (parId) return trouve([nommer(def, parId)]);
  }

  // 2. UNE SEULE REQUÊTE pour la référence exacte ET le texte contenu — puis on TRANCHE en
  //    mémoire. Deux requêtes séquentielles donnaient la même réponse pour le double du temps.
  const clauses: Record<string, unknown>[] = def.searchFields.map((c) => ({ [c]: { contains: q, mode: "insensitive" } }));
  if (def.referenceField) clauses.unshift({ [def.referenceField]: { equals: q, mode: "insensitive" } });
  if (clauses.length === 0) return vide(q, def, entite);

  const lignes = await model.findMany({
    where: { AND: [portee, { OR: clauses }] },
    select,
    take: MAX_CANDIDATS,
    ...(def.orderBy ? { orderBy: def.orderBy } : {}),
  });

  // LA RÉFÉRENCE EXACTE TRANCHE, même au milieu de dix homonymes : elle IDENTIFIE. Sans cette
  // ligne, « REG-2026-4 » resterait ambigu face à « REG-2026-41 » et « REG-2026-42 », alors
  // que la personne a donné la référence entière.
  const ref = def.referenceField;
  if (ref) {
    const exacte = lignes.filter((l) => String(l[ref] ?? "").toLowerCase() === q.toLowerCase());
    if (exacte.length === 1) return trouve([nommer(def, exacte[0]!)]);
  }
  if (lignes.length) return trouve(lignes.map((l) => nommer(def, l)));

  // 3. LES MOTS, quand le texte entier ne se trouve nulle part (lot T2, banc d'audit 02/11) : « Dr Karima BENSALEM »
  //    ne CONTIENT pas la fiche « Karima BENSALEM », « BENSALEM Karima » non plus — chaque mot, lui, s'y trouve. On
  //    retire les titres (Dr, Pr, Mme…), puis CHAQUE mot restant doit figurer dans l'un des champs de recherche : une
  //    désignation plus large que le texte n'est jamais tranchée en silence (plusieurs lignes → candidats, refus).
  const mots = motsDeDesignation(q);
  if (!mots.length || mots.join(" ") === q.toLowerCase()) return trouve([]);
  const parMots = await model.findMany({
    where: { AND: [portee, ...mots.map((m) => ({ OR: def.searchFields.map((c) => ({ [c]: { contains: m, mode: "insensitive" } })) }))] },
    select,
    take: MAX_CANDIDATS,
    ...(def.orderBy ? { orderBy: def.orderBy } : {}),
  });
  return trouve(parMots.map((l) => nommer(def, l)));
}

/** Les titres et mots vides d'une désignation (« le Dr », « la Pharmacie de ») — retirés avant la recherche par mots. */
// F2 (TR-EV-01) : « la BU Hépatologie », « la gamme Hépatologie » — la catégorie dite devant le nom n'en fait pas partie.
const MOTS_VIDES = new Set(["dr", "dr.", "docteur", "pr", "pr.", "professeur", "mme", "mme.", "madame", "m", "m.", "mr", "monsieur", "mlle", "le", "la", "les", "l", "de", "du", "des", "d", "et", "à", "a", "au", "bu", "gamme"]);
export function motsDeDesignation(q: string): string[] {
  return q.toLowerCase().split(/[\s'’,;:()«»"]+/).map((m) => m.trim()).filter((m) => m.length >= 2 && !MOTS_VIDES.has(m)).slice(0, 6);
}

/**
 * A-T-IL LA FORME D'UN IDENTIFIANT ? `cuid()` : une lettre puis 20 à 30 caractères
 * alphanumériques, sans espace. On ne cherche pas à valider — on cherche à ne PAS interroger
 * la base sur « le dossier de Nivolex ».
 */
export const ressembleAUnId = (q: string): boolean => /^[a-z][a-z0-9]{20,31}$/i.test(q);

/**
 * LA PHRASE DU REFUS — écrite UNE fois.
 *
 * Les 117 résolveurs refusaient chacun dans ses mots ; la moitié disait « introuvable » sur une
 * ambiguïté, ce qui envoie chercher au lieu de faire préciser. Ici le refus NOMME le remède :
 * les candidats quand il y en a, la façon de désigner quand il n'y en a pas (§118.30).
 *
 * Rend `null` quand une cible est retenue : il n'y a rien à refuser.
 */
export function direRefus(r: Resolution): string | null {
  if (r.retenu.length === 1) return null;
  const quoi = r.cherche.libelle.toLowerCase();
  const nom = (c: Cible) => (c.sousTitre ? `${c.titre} — ${c.sousTitre}` : c.titre);
  if (!r.cherche.texte) return `Précisez de quel ${quoi} il s'agit (son nom ou sa référence).`;
  if (r.candidats.length === 0) {
    // « Rien trouvé » n'est pas « n'existe pas » : c'est « rien dans VOTRE périmètre ».
    return `Aucun ${quoi} « ${r.cherche.texte} » dans votre périmètre.`;
  }
  return `Plusieurs ${quoi}s correspondent à « ${r.cherche.texte} » : ${r.candidats.map(nom).join(" ; ")}. Précisez lequel.`;
}

/** Les objets que ce résolveur sait désigner — pour décrire la capacité à un modèle. */
export const ENTITES_RESOLVABLES: readonly { entite: string; libelle: string }[] =
  ENTITIES.map((e) => ({ entite: e.name, libelle: e.label }));
