/**
 * UNE ACTION À ARGUMENTS SE LIT AUSSI — paramètres positionnels simples, objet littéral unique,
 * identité de l'acteur refusée, valeurs par défaut littérales seulement.
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import { sansCommentaires } from "./decoupage";
import { estReference } from "./lecture-champs";
import type { ChampAction, TypeChamp } from "./types";

// ───────────────────────────────────────────────────────────────────────────────────────────
// UNE ACTION À ARGUMENTS SE LIT AUSSI
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * 67 REFUS IMPRIMAIENT LA SIGNATURE QU'ILS DÉCLARAIENT NE PAS SAVOIR LIRE.
 *
 * « entrée typée (missionId: string) — cette action ne s'appelle pas par un formulaire » :
 * le nom du paramètre, son type et son rang étaient DANS le message. C'est un « je ne peux
 * pas » artificiel écrit dans le CODE, comme le contrôle des livrables qui déclarait « aucun
 * moteur de calcul Excel dans le dépôt » alors que le dossier d'à côté en portait un
 * (§118.59) et comme l'ingestion qui renvoyait océriser à la main (§118.63). On TRADUIT au
 * lieu de refuser (§118.34).
 *
 * ── POURQUOI LA LECTURE EST TOUT-OU-RIEN ─────────────────────────────────────────────────
 *
 * Un formulaire est NOMMÉ : une clé manquante arrive vide et l'action s'en plaint. Un appel
 * positionnel est MUET : un argument manquant devient `undefined` au bon rang, et la fonction
 * part quand même. Un paramètre mal lu ne dégrade donc pas la lecture — il DÉCALE tous les
 * suivants, et `renameDocument(id, name)` appelé de travers renomme avec l'identifiant.
 * Un seul paramètre illisible rend TOUTE la signature illisible : ici, lire quatre paramètres
 * sur cinq est strictement pire que n'en lire aucun.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on sait traduire — et rien d'autre. Un type absent d'ici rend la signature illisible. */
const TYPES_SIMPLES: Readonly<Record<string, TypeChamp>> = {
  string: "texte", number: "nombre", boolean: "booleen", Date: "date",
  "string[]": "liste", "readonly string[]": "liste",
};

/**
 * L'IDENTITÉ DE L'ACTEUR, reconnue au NOM du paramètre — et refusée.
 *
 * Toute action d'écran tient son acteur de la SESSION (`requireUser`) ; celle qui le reçoit en
 * argument fait confiance à son appelant. Le bouton est un appelant sûr, un modèle ne l'est
 * pas : ouvrir ce paramètre, c'est permettre d'agir au nom de quelqu'un d'autre — exactement
 * ce qu'`executerAction` refuse déjà en ne transmettant PAS `user` (§118.7).
 *
 * La liste est FERMÉE et COURTE, parce qu'une garde large — « tout paramètre finissant par
 * Id » — refuserait `missionId`, `taskId`, `messageId`, c'est-à-dire la quasi-totalité du
 * parc, pour se protéger d'un risque qu'aucune de ces actions ne porte. Le refus NOMME la raison.
 *
 * La seule action qui a été dans ce cas (`rememberExchange`) n'est plus une action : le refus au
 * chemin générique ne fermait pas son point d'entrée public, et elle vit désormais dans un module
 * serveur ordinaire (`lib/memoire-echange.ts`, §118.153). La règle reste, pour la prochaine.
 */
const IDENTITE_ACTEUR = /^(userId|actorId|asUser|onBehalfOf|accountId|sessionUserId|impersonate\w*)$/i;

/**
 * Découpe une liste au niveau ZÉRO — un `{ a: string }` ne se coupe pas en deux.
 *
 * `separateurs` vaut « , » pour des paramètres et « ,; » pour les MEMBRES d'un type objet, que
 * TypeScript accepte séparés par l'un ou l'autre. Deux découpeurs auraient divergé au premier
 * membre écrit avec l'autre signe (§118.5).
 */
export function decouperParametres(signature: string, separateurs = ","): string[] {
  const out: string[] = [];
  let prof = 0, cur = "";
  for (const ch of signature) {
    if ("{<([".includes(ch)) prof++;
    else if ("}>)]".includes(ch)) prof--;
    if (separateurs.includes(ch) && prof === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Une union de littéraux (`"GRANTED" | "REFUSED"`) — les valeurs admises, lues sans les deviner. */
function litterauxUnion(type: string): string[] | null {
  const parts = type.split("|").map((p) => p.trim());
  if (parts.length < 2 || !parts.every((p) => /^"[^"]*"$/.test(p))) return null;
  return parts.map((p) => p.slice(1, -1));
}

/** Le résultat d'une lecture de signature : des champs, ou la RAISON exacte du refus (§118.30). */
export type LectureArguments = { champs: ChampAction[] } | { refus: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PARAMÈTRE OBJET LITTÉRAL SE LIT — ses membres SONT écrits dans la signature.
 *
 * `setInvoicePaid(input: { id: string; paidDate: string | null })` était refusée pour « le type
 * de « input » n'est pas une valeur simple ». C'est le refus de §118.78 recommencé un cran plus
 * bas : la source ÉNONCE `id` et `paidDate`, avec leurs types, à l'endroit exact où le refus
 * disait ne rien savoir. Treize actions du parc sont dans ce cas.
 *
 * ── POURQUOI SEULEMENT LE PARAMÈTRE UNIQUE ───────────────────────────────────────────────
 *
 * Un appel positionnel est MUET : rien ne signale un rang mal rempli (§118.78). Mélanger des
 * rangs simples et un objet demanderait de savoir, champ par champ, dans quel rang il va — un
 * état de plus à tenir juste, pour un gain que le parc ne réclame pas : les treize actions
 * concernées prennent TOUTES un objet unique. On lit ce cas-là, exactement, et l'on refuse le
 * reste en le NOMMANT.
 *
 * La lecture reste TOUT-OU-RIEN : un membre au type illisible (un objet imbriqué, un type
 * importé) rend toute la signature illisible. Livrer un objet amputé d'un champ ferait appeler
 * l'action avec une clé manquante — et une clé absente n'est pas une clé vide (§118.71).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lireObjetUnique(signature: string): LectureArguments | null {
  // LES COMMENTAIRES PARTENT D'ABORD, pas membre par membre : une phrase de documentation
  // contient des virgules, et découper dedans coupait un membre en deux — donc une liste de
  // champs AMPUTÉE, c'est-à-dire le sens dangereux de l'erreur (§118.78).
  const propre = sansCommentaires(signature);
  const params = decouperParametres(propre).map((p) => p.trim()).filter(Boolean);
  if (params.length !== 1) return null;
  const m = /^(\w+)\??\s*:\s*\{([\s\S]*)\}\s*$/.exec(params[0]!.replace(/,$/, "").trim());
  if (!m) return null;
  const membres = decouperParametres(m[2]!, ",;");
  const champs: ChampAction[] = [];
  for (const brut of membres) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) return { refus: `le membre ${lu.refus} de « ${m[1]} »` };
    champs.push(lu.champ);
  }
  return champs.length ? { champs } : null;
}


/**
 * UNE VALEUR PAR DÉFAUT LITTÉRALE N'EST PAS UN CALCUL.
 *
 * `spaceId: string | null = null` dit « facultatif, et voici ce que vaut son absence » — on
 * peut l'omettre sans rien changer. `now = new Date()` est autre chose : sa valeur est
 * CALCULÉE à l'appel, et la remplir depuis une demande ferait écrire une date choisie par un
 * modèle là où le code voulait « maintenant ». La liste des littéraux est FERMÉE, parce qu'un
 * détecteur qui accepterait « tout ce qui ne ressemble pas à un appel » finirait par laisser
 * passer une constante importée dont on ne sait rien.
 */
const DEFAUT_LITTERAL = /^(null|undefined|true|false|""|''|``|\[\]|\{\}|-?\d+(?:\.\d+)?)$/;

/**
 * UN PARAMÈTRE (ou un MEMBRE d'objet), lu ou refusé avec sa raison. `null` = rien à lire ici
 * (une virgule finale, un commentaire seul) — ce n'est pas un refus.
 */
export function lireUnParametre(brut: string): { champ: ChampAction } | { refus: string } | null {
  const p = sansCommentaires(brut).trim().replace(/[,;]$/, "");
  if (!p) return null;
  if (p.startsWith("...")) return { refus: `« ${p.slice(0, 30)} » est variadique` };
  const avantType = p.split(":")[0] ?? "";
  const egal = p.indexOf("=");
  if (avantType.includes("=") || /[^=!<>]=[^=>]/.test(p)) {
    const defaut = egal >= 0 ? p.slice(egal + 1).trim() : "";
    if (!DEFAUT_LITTERAL.test(defaut)) {
      return { refus: `« ${avantType.split("=")[0]!.trim()} » a une valeur par défaut CALCULÉE (${defaut.slice(0, 30)})` };
    }
    // Littérale : le paramètre est FACULTATIF, et l'omettre rend exactement ce défaut.
    return lireUnParametre(`${p.slice(0, egal).replace(/:/, "?:")}`);
  }
  const m = /^(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(p);
  if (!m) return { refus: `« ${p.slice(0, 40)} » n'est pas un nom simple typé` };
  const nom = m[1]!;
  let optionnel = Boolean(m[2]);
  let type = m[3]!.replace(/\s+/g, " ").trim();

  if (IDENTITE_ACTEUR.test(nom)) {
    return {
      refus: `« ${nom} » porte l'identité de l'ACTEUR — une action qui reçoit son auteur au lieu `
        + `de le lire dans la session ne s'appelle que depuis un écran`,
    };
  }
  if (/\|\s*undefined$/.test(type)) { type = type.replace(/\|\s*undefined$/, "").trim(); optionnel = true; }
  // `| null` dit qu'on accepte l'ABSENCE DE VALEUR, jamais l'absence d'ARGUMENT : sauter le
  // rang décalerait tous les suivants. Le champ reste donc obligatoire.
  if (/\|\s*null$/.test(type)) type = type.replace(/\|\s*null$/, "").trim();

  const valeurs = litterauxUnion(type);
  const simple = valeurs ? "texte" as const : TYPES_SIMPLES[type];
  if (!simple) return { refus: `« ${nom} » (${type}) n'est pas une valeur simple` };
  // MÊME RÈGLE DE RÉFÉRENCE QUE LE FORMULAIRE : `missionId` désigne une mission des deux
  // côtés. Deux conventions selon la façon d'appeler feraient qu'« arrête la mission de
  // consolidation » se résoudrait dans un cas et exigerait un cuid dans l'autre.
  return {
    champ: {
      nom,
      type: simple === "texte" && !valeurs && estReference(nom) ? "reference" : simple,
      obligatoire: !optionnel,
      valeurs: valeurs ?? null,
      // Le modèle désigné ne se lit pas dans la SIGNATURE : il vient du schéma croisé avec les
      // écritures de l'action, que `decrireAction` seule connaît. Elle le pose juste après.
      modele: null,
    },
  };
}

export function lireArguments(signature: string): LectureArguments {
  const champs: ChampAction[] = [];
  for (const brut of decouperParametres(signature)) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) return { refus: `le paramètre ${lu.refus}` };
    champs.push(lu.champ);
  }
  return champs.length ? { champs } : { refus: "aucun paramètre lisible" };
}
