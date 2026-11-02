/**
 * LE REGISTRE des suppressions définitives — la source de vérité UNIQUE, partagée par :
 *   • les actions serveur de l'écran (`admin-delete-actions.ts` : bouton rouge des fiches,
 *     corbeille, suppression par le créateur) ;
 *   • le Chief of Staff (`assistant.ts` : outil `delete_record`), qui PROPOSE la même
 *     suppression et l'exécute via `superAdminDelete` — jamais une deuxième logique.
 *
 * Il vit hors du fichier `"use server"` parce qu'un module d'actions ne peut exporter que des
 * fonctions async — or l'assistant a besoin de la LISTE des types, de leurs libellés et de leurs
 * champs de recherche pour résoudre « supprime REG-2026-041 » sans dupliquer quoi que ce soit.
 *
 * Découpé par famille (lot V4) : voir le dossier `src/lib/admin-delete-registry/` — `types`
 * (`DeletableKind`, `KindSpec`), six morceaux CONTIGUS du registre (`regulatory-rh-administration`,
 * `terrain-ventes-bd-support`, `finance`, `promotion-ad-pro`, `marches-validations-legal`,
 * `messagerie-drive`) et `registre` (leur composition dans l'ordre d'origine, et les lectures). Ce
 * fichier reste la PORTE : on importe `@/lib/admin-delete-registry`, jamais un morceau.
 */

export * from "./admin-delete-registry/types";
export * from "./admin-delete-registry/registre";
