/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE LIEUX — LA PORTE SERVEUR (référentiel du socle, refonte V2-D).
 *
 * Hors de `src/modules/lieux/`, on importe CE fichier (ou `./partage` pour les règles pures),
 * jamais `domaine/` ni `infra/` : tenu par ESLint (`no-restricted-imports`) et par
 * `src/modules/frontieres.test.ts`. Ce qui n'est pas exporté ici est un détail d'implémentation.
 *
 * Tables : le module ne possède pas de table ; il écrit la colonne `wilayaCode` des cinq fiches
 * qui portent un lieu (`MODELES_LIEU`). Toute écriture d'une de ces fiches appelle
 * `reposerWilayaCode` — `double-ecriture-garde.test.ts` le vérifie sur tout `src/`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

// ── Commandes (écritures) ─────────────────────────────────────────────────────────────────
export { poserWilayaCodes, reposerWilayaCode, lireLotLieux, type FicheLieu } from "./infra/rattachement-prisma";
