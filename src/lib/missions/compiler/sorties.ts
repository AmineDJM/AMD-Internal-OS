import { cheminPlausible, type Forme } from "@/lib/missions/registry/formes";
import { CHAMPS_JONCTION, SCHEMA_WORKER_MINIMAL } from "@/lib/missions/runtime/sorties";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FORME DE SORTIE D'UNE ÉTAPE, VUE DU COMPILATEUR — refuser ce qu'on SAIT faux, jamais plus.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Le compilateur vérifiait qu'une référence `{{etape.champ}}` désigne une étape EXISTANTE, et
 * s'arrêtait là. Son propre commentaire l'assumait : « Le chemin DANS la sortie n'est
 * vérifiable qu'à l'exécution ». À l'exécution, le moteur détecte parfaitement le champ absent
 * — et tue la mission : `INVALID_STEP`, `retryable: false`, après l'accord du dirigeant et
 * après que toutes les étapes amont ont tourné et coûté.
 *
 * Sur le banc des deux cents missions, la famille COMPOSITION faisait 1/13, et la première
 * cause était exactement cela : le planificateur devine un nom de champ, la devinette est
 * fausse, le refus arrive trop tard pour servir à quoi que ce soit.
 *
 * ── CE QUE LE COMPILATEUR SAIT VRAIMENT, ET DEPUIS QUAND ────────────────────────────────
 *
 * Il le savait déjà pour la moitié des cas, sans s'en servir :
 *
 *   • Un WORKER rend EXACTEMENT les champs de son `expectedOutputSchema`. Ce schéma est bâti
 *     par `schemaDepuisChamps` avec `additionalProperties: false`, et le fournisseur l'applique
 *     en mode strict. Sans `outputFields`, c'est `SCHEMA_WORKER_MINIMAL` — trois champs.
 *     Autrement dit : la forme d'un worker est une CONSTANTE de compilation, toujours.
 *   • Une JONCTION rend `{ joined }`. Rien d'autre, jamais.
 *   • Une CAPACITÉ rend ce qu'elle a été OBSERVÉE rendre (`registry/formes.ts`), quand elle a
 *     déjà tourné. C'est la seule source faillible des trois, et c'est la seule qui rend
 *     `null` (« je ne sais pas ») plutôt qu'un verdict.
 *
 * ── LA RÈGLE QUI GOUVERNE TOUT CE MODULE ────────────────────────────────────────────────
 *
 * **On ne refuse QUE ce qu'on sait faux.** Une ignorance n'est jamais un refus. Un refus à tort
 * est strictement pire que le défaut qu'on corrige : il fait échouer à la compilation des plans
 * corrects, sur les capacités NEUVES en priorité — celles qui n'ont jamais tourné. On aurait
 * échangé un défaut mesuré contre un défaut invisible.
 *
 * `certitude` porte cette distinction dans le type, pour qu'aucun appelant ne puisse la perdre :
 * seul `EXHAUSTIVE` autorise un refus sur l'absence d'un champ.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on sait de la sortie : tout (EXHAUSTIVE), une partie (PARTIELLE), rien (INCONNUE). */
export type Certitude = "EXHAUSTIVE" | "PARTIELLE" | "INCONNUE";

/** D'où vient ce qu'on sait — le message de refus le DIT, pour qu'il soit vérifiable. */
export type OrigineSortie = "SCHEMA_DECLARE" | "WORKER_MINIMAL" | "JONCTION" | "OBSERVATION" | "AUCUNE";

export interface SortieEtape {
  certitude: Certitude;
  origine: OrigineSortie;
  /** Les champs de la RACINE, quand on les connaît. Vide quand on ne sait pas. */
  champs: readonly string[];
  /** La forme apprise — elle seule sait descendre dans une liste. `null` hors observation. */
  forme: Forme | null;
}

/** L'ignorance, dite une fois. Aucun appelant ne doit fabriquer la sienne. */
export const SORTIE_INCONNUE: SortieEtape = {
  certitude: "INCONNUE", origine: "AUCUNE", champs: [], forme: null,
};

/** L'étape telle que le compilateur la voit — le sous-ensemble strictement nécessaire. */
export interface EtapeAExaminer {
  nodeType?: string;
  capability?: string | null;
  expectedOutputSchema?: Record<string, unknown>;
}

function champsDuSchema(schema: unknown): { champs: string[]; ferme: boolean } | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const o = schema as { properties?: unknown; additionalProperties?: unknown };
  if (!o.properties || typeof o.properties !== "object" || Array.isArray(o.properties)) return null;
  const champs = Object.keys(o.properties as Record<string, unknown>);
  if (champs.length === 0) return null;
  return { champs, ferme: o.additionalProperties === false };
}

/**
 * CE QU'UNE ÉTAPE VA RENDRE, pour autant qu'on puisse le savoir à la compilation.
 *
 * `formeCapacite` est facultatif À DESSEIN : un catalogue qui ne l'offre pas (un catalogue de
 * test, un déploiement dont le cache des formes est froid) fait simplement rendre `INCONNUE`
 * pour les capacités — donc ne refuse rien de plus qu'avant. L'absence de mesure ne change
 * jamais un verdict en refus.
 */
export function sortieAttendue(
  s: EtapeAExaminer,
  formeCapacite?: (nom: string) => Forme | null,
): SortieEtape {
  const type = s.nodeType ?? (s.capability ? "CAPABILITY" : "WORKER");

  if (type === "JOIN") {
    return { certitude: "EXHAUSTIVE", origine: "JONCTION", champs: CHAMPS_JONCTION, forme: null };
  }

  if (type === "WORKER") {
    // Un worker DÉCLARE sa sortie, ou hérite du minimal. Les deux sont fermés, donc exhaustifs.
    const declare = champsDuSchema(s.expectedOutputSchema);
    if (declare) {
      return {
        certitude: declare.ferme ? "EXHAUSTIVE" : "PARTIELLE",
        origine: "SCHEMA_DECLARE", champs: declare.champs, forme: null,
      };
    }
    const minimal = champsDuSchema(SCHEMA_WORKER_MINIMAL);
    return {
      certitude: "EXHAUSTIVE", origine: "WORKER_MINIMAL",
      champs: minimal ? minimal.champs : [], forme: null,
    };
  }

  // Un schéma déclaré sur un autre type de nœud reste une information — mais pas une autorité :
  // ce n'est pas ce schéma qui gouverne la sortie d'une capacité, c'est l'outil.
  if (type === "CAPABILITY" && s.capability) {
    const f = formeCapacite?.(s.capability) ?? null;
    if (f && f.observations > 0) {
      return {
        certitude: "PARTIELLE", origine: "OBSERVATION",
        champs: f.champs.map((c) => c.nom), forme: f,
      };
    }
  }

  return SORTIE_INCONNUE;
}

/** Le premier segment d'un chemin, l'index numérique de tête écarté (`0.nom` → `nom`). */
function premierChamp(chemin: string): string | null {
  for (const seg of chemin.split(".")) {
    if (seg === "" || /^\d+$/.test(seg)) continue;
    return seg;
  }
  return null;
}

export interface RefusChemin {
  /** Le champ que la référence réclame et qui n'existe pas. */
  champ: string;
  /** Ce que l'étape rend RÉELLEMENT — c'est ce que le planificateur doit lire à la place. */
  disponibles: readonly string[];
  origine: OrigineSortie;
  /** La phrase à mettre dans le refus, en français, sans jargon de schéma. */
  raison: string;
}

const DIT_ORIGINE: Record<OrigineSortie, string> = {
  SCHEMA_DECLARE: "cette étape a DÉCLARÉ ses champs de sortie",
  WORKER_MINIMAL: "un worker sans champs de sortie déclarés rend toujours ces trois champs-là",
  JONCTION: "une jonction ne porte AUCUNE donnée : elle ne rend qu'un compteur. Lis directement l'étape qui produit les données",
  OBSERVATION: "c'est ce que cette capacité a rendu à chacune de ses exécutions observées",
  AUCUNE: "",
};

/**
 * LE VERDICT SUR UNE RÉFÉRENCE — `null` quand on ne sait pas, et `null` quand c'est bon.
 *
 * L'appelant n'a donc qu'un cas à traiter : un objet, c'est un refus démontré. Cette forme de
 * retour est délibérée — un booléen aurait fait de l'ignorance un « faux », c'est-à-dire un
 * refus, exactement l'erreur que ce module existe pour ne pas commettre.
 */
export function verdictChemin(sortie: SortieEtape, chemin: string): RefusChemin | null {
  const champ = premierChamp(chemin);
  if (!champ) return null; // `{{etape}}` nu, ou `{{etape.0}}` : la sortie entière, toujours licite.

  if (sortie.certitude === "EXHAUSTIVE") {
    if (sortie.champs.includes(champ)) return null;
    return {
      champ, disponibles: sortie.champs, origine: sortie.origine,
      raison: DIT_ORIGINE[sortie.origine],
    };
  }

  // OBSERVATION : la forme apprise sait descendre dans la liste principale, et sait dire
  // « je ne sais pas » — c'est elle qui décide, jamais la simple absence du nom à la racine.
  if (sortie.origine === "OBSERVATION" && sortie.forme) {
    if (cheminPlausible(sortie.forme, chemin) === false) {
      return {
        champ, disponibles: sortie.champs, origine: "OBSERVATION",
        raison: DIT_ORIGINE.OBSERVATION,
      };
    }
  }

  return null;
}

/**
 * LA PHRASE DE REFUS — elle nomme ce qui manque ET ce qui existe.
 *
 * Un refus qui dit seulement « ce champ n'existe pas » oblige le planificateur à deviner une
 * seconde fois. Le moteur, lui, écrivait déjà la bonne phrase (« champs disponibles : … ») —
 * mais trop tard. On la remonte à la compilation, où elle peut encore servir.
 */
export function direRefus(cle: string, ref: string, r: RefusChemin): string {
  const liste = r.disponibles.length > 0
    ? `Champs réellement disponibles : ${r.disponibles.join(", ")}.`
    : "Cette étape ne rend aucun champ lisible.";
  return `« {{${ref}}} » lit « ${r.champ} » sur l'étape « ${cle} », qui ne le rend pas. ${liste}`
    + (r.raison ? ` (${r.raison}.)` : "");
}
