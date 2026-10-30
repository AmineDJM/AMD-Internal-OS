import type { WorkspaceActionIntent } from "./protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BOUTON N'A PAS BESOIN DU MODÈLE POUR SAVOIR CE QU'IL FAIT.
 *
 * ── LE COÛT QU'ON PAYAIT ─────────────────────────────────────────────────────────────────
 *
 * Jusqu'ici, tout geste de l'espace de travail écrivait une PHRASE dans la conversation :
 * « Ouvre le marché AO-2025-014 ». La phrase repartait au modèle, qui devait comprendre
 * l'intention, choisir l'outil, extraire l'argument — pour aboutir à l'appel que le serveur
 * connaissait DÉJÀ quand il a dessiné le bouton. Un aller-retour complet, une seconde et demie,
 * quelques milliers de jetons, et un risque de dérive à chaque maillon : pour rien.
 *
 * Un bouton posé par le serveur porte une intention EXACTE. La faire redécouvrir par un modèle
 * n'ajoute aucune information — ça en perd.
 *
 * ── LA RÈGLE QUI REND ÇA SÛR : LECTURE SEULEMENT ─────────────────────────────────────────
 *
 * Ce registre ne contient QUE des lectures. Aucune mutation, jamais. Une mutation déclenchée
 * directement par un clic contournerait la proposition, la carte de confirmation, l'action
 * canonique et l'audit — c'est-à-dire toute la chaîne qui fait qu'« Approuve VAL-014 » est une
 * décision tracée et non un effet de bord. Les gestes qui MODIFIENT continuent donc d'écrire
 * leur phrase dans la conversation, exactement comme avant.
 *
 * Le registre est également FERMÉ : un `intent` dont la capacité n'y figure pas est refusé.
 * Sans quoi il suffirait qu'un bloc déclare `{ capability: "delete_record" }` pour ouvrir une
 * seconde porte — et cette porte-là n'a ni RBAC revérifié à l'entrée ni approbation.
 *
 * ── CE QUI RESTE VÉRIFIÉ MALGRÉ LE RACCOURCI ─────────────────────────────────────────────
 *
 * Tout, sauf le modèle : la session, le `allowed()` de la capacité, les droits que l'ERP
 * revérifie de son côté, et le cloisonnement par entité. Le raccourci saute le RAISONNEMENT,
 * pas les GARDES.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DirectIntentDef {
  /** L'outil canonique appelé. Il doit exister dans le registre et être une LECTURE. */
  tool: string;
  /** Les arguments acceptés. Tout autre nom est ignoré — pas d'argument surprise. */
  args: readonly string[];
  /** Ce qui s'écrit dans le fil à la place de la question. `%s` = le premier argument. */
  phrase: string;
  /** Le libellé de trace, comme pour un outil appelé par le modèle. */
  label: string;
}

/**
 * LES INTENTIONS QU'UN BOUTON PEUT DÉCLENCHER SEUL.
 *
 * Chacune correspond à un ZOOM : on regarde de plus près un objet déjà à l'écran. C'est
 * exactement le cas où le modèle n'apporte rien — l'entité est identifiée, la lecture est
 * nommée, il n'y a aucune ambiguïté à lever.
 */
export const DIRECT_INTENTS = {
  "story.open": {
    tool: "business_story",
    args: ["affaire"],
    phrase: "Retracer %s",
    label: "Histoire d'une affaire",
  },
  "product.economics": {
    tool: "product_economics",
    args: ["produit"],
    phrase: "Économie du produit %s",
    label: "Économie d'un produit",
  },
  "pch.status": {
    tool: "pch_market_status",
    args: ["marche"],
    phrase: "État du marché %s",
    label: "État d'un marché PCH",
  },
  "record.inspect": {
    tool: "inspect_record",
    args: ["type", "reference"],
    phrase: "Fiche %s",
    label: "Fiche canonique",
  },
  "person.lookup": {
    tool: "directory_lookup",
    args: ["nom"],
    phrase: "Fiche de %s",
    label: "Annuaire",
  },
  /**
   * §46 — « OÙ TU EN ES ? » PENDANT QUE ÇA TOURNE.
   *
   * C'est le cas où le raccourci compte le plus : une mission de trois jours se consulte dix
   * fois, et dix raisonnements pour relire un compteur en base seraient dix secondes d'attente
   * et dix occasions de se tromper sur un chiffre exact. La mission est identifiée par le bloc
   * qui porte le bouton ; il n'y a rien à deviner.
   */
  "mission.status": {
    tool: "mission_status",
    args: ["mission"],
    phrase: "Où en est la mission %s",
    label: "État d'une mission",
  },
  // `as const satisfies` et non une annotation : l'annotation aurait élargi les clés à `string`,
  // et `intentFor` aurait accepté n'importe quelle faute de frappe. Le premier essai le faisait —
  // c'est le `@ts-expect-error` INUTILISÉ de son test qui l'a montré, la garde ne gardait rien.
} as const satisfies Record<string, DirectIntentDef>;

/** Les capacités réellement déclarées — un type, donc une faute de frappe ne compile pas. */
export type DirectIntentName = keyof typeof DIRECT_INTENTS;

/** Une intention est-elle déclarée ? Le seul point d'entrée : rien d'autre ne doit deviner. */
export function directIntent(capability: string): DirectIntentDef | null {
  // `hasOwnProperty` et non `?? null` : sans lui, `directIntent("toString")` rendrait la
  // méthode héritée du prototype, et le registre « fermé » serait ouvert par l'objet lui-même.
  return Object.prototype.hasOwnProperty.call(DIRECT_INTENTS, capability)
    ? (DIRECT_INTENTS as Record<string, DirectIntentDef>)[capability]
    : null;
}

/**
 * LES ARGUMENTS, FILTRÉS À CE QUI EST DÉCLARÉ.
 *
 * Un `intent` traverse le navigateur : il revient donc dans la requête tel que le client l'a
 * renvoyé. Prendre le dictionnaire tel quel laisserait passer n'importe quelle clé jusqu'à
 * l'outil — et un outil qui reçoit un argument qu'il n'attendait pas fait, au mieux, autre
 * chose que ce que le bouton promettait.
 */
export function intentArgs(def: DirectIntentDef, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of def.args) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) out[key] = v.trim().slice(0, 200);
  }
  return out;
}

/** La phrase écrite dans le fil — celle du registre, jamais celle envoyée par le client. */
export function intentPhrase(def: DirectIntentDef, args: Record<string, string>): string {
  const first = def.args.map((k) => args[k]).find((v) => v) ?? "";
  return def.phrase.replace("%s", first);
}

/**
 * L'INTENTION D'UN BOUTON, CONSTRUITE CÔTÉ SERVEUR.
 *
 * Écrire `{ capability: "story.open", args: { affaire: ref } }` à la main dans chaque émetteur
 * marcherait — et laisserait passer la faute de frappe qui produit un bouton mort. Ce
 * constructeur refuse une capacité inconnue à la CONSTRUCTION, donc au moment où elle est
 * écrite, et pas six écrans plus loin au moment où on clique.
 */
export function intentFor(capability: DirectIntentName, args: Record<string, string>): WorkspaceActionIntent | null {
  const def = directIntent(capability);
  if (!def) return null;
  const clean = intentArgs(def, args);
  if (Object.keys(clean).length === 0) return null;
  return { capability, args: clean };
}
