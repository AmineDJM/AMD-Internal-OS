/**
 * LES DÉPENDANCES ERP de les outils de domaine — la seule porte par laquelle ce dossier franchit la frontière
 * Adam ↔ ERP (et celle entre domaines) : une fois par module, comme le faisait le fichier d'origine
 * avant son découpage. Les cliquets `src/platform/boundary.test.ts` et `domains.test.ts` comptent
 * chaque import par fichier ; les morceaux importent d'ici plutôt que de répéter ces imports.
 */
export type { ClaudeToolDef } from "@/lib/ai";
export type { Module } from "@/lib/rbac";
