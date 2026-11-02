import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

/**
 * LES ADRESSES DE RÉEXPÉDITION (`src/platform/demenagements.ts`) — lues dans `tsconfig.json`, la
 * seule table : TypeScript, Next.js et `tsx` la lisent nativement, Vitest par ces lignes. Chaque
 * entrée est EXACTE (`^…$`) et passe avant l'alias général `@` : `@/lib/coffre/cle` va au module,
 * `@/lib/coffre/clef` (s'il existait) resterait sous `src/lib/`.
 */
const paths = (JSON.parse(fs.readFileSync(path.resolve(__dirname, "tsconfig.json"), "utf8"))
  .compilerOptions?.paths ?? {}) as Record<string, string[]>;
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const reexpeditions = Object.entries(paths)
  .filter(([cle]) => !cle.includes("*"))
  .map(([cle, [cible]]) => ({ find: new RegExp(`^${echapper(cle)}$`), replacement: path.resolve(__dirname, cible!) }));

export default defineConfig({
  resolve: {
    alias: [
      ...reexpeditions,
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Le siège stable du centre de validations — voir l'en-tête du fichier (§118.148).
    globalSetup: ["./vitest.global-setup.ts"],
    // next-auth est laissé à Node en tant que dépendance externe, et Node échoue à résoudre son
    // `import "next/server"` — ce qui faisait ÉCHOUER LE CHARGEMENT de suites entières : leurs
    // tests ne s'exécutaient pas du tout, sans que le total en rende compte. Traité par Vite,
    // l'import est résolu normalement.
    server: { deps: { inline: [/next-auth/, /@auth\//] } },
    /**
     * ═════════════════════════════════════════════════════════════════════════════════════
     * LES PLAFONDS DE TEMPS SONT CEUX D'UNE SUITE QUI PARLE À POSTGRES, pas ceux de Vitest.
     *
     * Les défauts (5 s par test, 10 s par hook) ont été choisis pour des tests purs. Ici, 685
     * fichiers tournent en parallèle et beaucoup sèment une vingtaine de lignes en base avant
     * de commencer. Mesuré : un test à 1,5 s tout seul dépasse 5 s sous la charge complète, et
     * un `beforeAll` de semis dépasse 10 s — la suite passe au rouge sans qu'aucune assertion
     * n'ait échoué. Un rouge qui ne veut rien dire est pire qu'un vert lent : il apprend à ne
     * plus lire le rouge, et le jour où une vraie régression tombe, elle ressemble à celui-là.
     *
     * Le contre-argument est réel — un plafond généreux laisse un blocage durer plus longtemps
     * avant d'être vu. D'où le facteur : le test le plus lent de la suite fait environ 2 s, on
     * garde un ordre de grandeur au-dessus. Rien n'est masqué : un test qui ne rend jamais la
     * main échoue toujours, un peu plus tard.
     * ═════════════════════════════════════════════════════════════════════════════════════
     */
    testTimeout: 20_000,
    /**
     * ── LE PLAFOND D'UN DÉCOR RÉPOND À « EST-IL BLOQUÉ ? », JAMAIS À « EST-IL LENT ? » ──
     *
     * MESURÉ. `ops-goldens.test.ts` : 985 ms SEUL, et son `beforeAll` a dépassé 30 000 ms dans
     * la suite complète — 717 fichiers sur QUATRE cœurs. Trente fois plus lent, sans une ligne
     * de code différente. Le rouge disait « Hook timed out » et ressemblait exactement à une
     * régression du produit : zéro assertion en échec, 8 220 tests verts, un fichier rouge.
     *
     * Un décor de fixtures coûte N ALLERS-RETOURS séquentiels vers Postgres, et sous contention
     * chacun se paie plusieurs centaines de millisecondes. Recensé : 74 décors portent 6 attentes
     * séquentielles ou plus, le pire en porte 47 — celui qui est tombé n'était même pas le plus
     * lourd. Un plafond calé sur l'espoir que la machine soit libre mesure l'humeur de
     * l'ordonnanceur, pas une propriété du code (§118.83), et refuser à tort coûte plus cher que
     * le défaut qu'on croit attraper (§118.27) : ici, une suite de six minutes rejouée pour rien.
     *
     * Ce que ce plafond garde vraiment : un `await` qui ne rendra JAMAIS la main (un verrou, une
     * connexion morte, un `await` oublié). N'IMPORTE QUELLE borne finie l'attrape — 30 s ou 120 s,
     * le test échoue, un peu plus tard. Le bruit d'ordonnancement, lui, ne fait qu'AJOUTER du
     * temps : c'est pourquoi la borne est généreuse ici, et pourquoi le COÛT STRUCTUREL des décors
     * est tenu ailleurs, par un cliquet qui compte les allers-retours séquentiels et non les
     * millisecondes (`src/platform/decors-de-test.test.ts`).
     */
    hookTimeout: 120_000,
  },
});
