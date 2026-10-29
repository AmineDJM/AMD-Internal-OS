/**
 * LES TYPES DE VUE, RÉEXPORTÉS PAR LE PONT.
 *
 * ── POURQUOI CE FICHIER D'UNE LIGNE EXISTE ─────────────────────────────────────────────
 *
 * Le protocole de conversation (`assistant/workspace/protocol.ts`) et le workspace React ont
 * besoin de la FORME d'une vue d'artefact. Ce sont des fichiers d'Adam ; `src/lib/artifact/`
 * est l'ERP. Un import direct ajouterait des franchissements de frontière, et le cliquet — qui
 * est exactement à son plafond — les refuserait.
 *
 * La bonne réponse n'est pas de relever le plafond : c'est de passer par le PONT, dont c'est
 * précisément le rôle. Ici, la traversée est un `export type` — effacé à la compilation, sans
 * aucun effet à l'exécution. Adam apprend la FORME d'une vue, pas comment on la fabrique.
 *
 * C'est aussi ce qui garde le composant `"use client"` propre : `render/view.ts` n'importe que
 * des types, donc rien ne remonte vers `fs` ni vers Prisma.
 */

export type {
  BlocVue,
  VueArtefact,
  VueContenu,
  VueDocx,
  VuePdf,
  VuePptx,
  VueXlsx,
} from "@/lib/artifact/render/view";

export type { ArtifactFormat, TextStyle } from "@/lib/artifact/object-model/model";
export type { CommandeArtefact } from "@/lib/artifact/commands/ir";

/**
 * LE SCHÉMA DE COMMANDE est une VALEUR, pas un type : c'est ce que le modèle doit remplir. Le
 * faire transiter par le pont plutôt que de l'importer directement garde la même propriété que
 * le reste — Adam consomme le contrat, il ne connaît pas le domaine qui le fabrique.
 */
export { SCHEMA_COMMANDE, SCHEMA_EDITION, LIBELLE_CAPACITE, CAPACITES_ARTEFACT } from "@/lib/artifact/capabilities/catalog";
