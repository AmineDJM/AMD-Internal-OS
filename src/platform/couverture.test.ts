import { describe, expect, it } from "vitest";
import { mesurerCouverture } from "./couverture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CLIQUETS QUI MESURENT CE QUE LES AUTRES NE VOIENT PAS — rapport d'audit 08, ARCH-02 / ARCH-05.
 *
 * `domains.test.ts` et `boundary.test.ts` comptent les imports ENTRE couches de `src/lib/`. Ils
 * ne disent rien des fichiers rangés dans aucune couche, ni de `src/app/`, ni de `src/components/`.
 * Ces six chiffres, si : chacun est un PLAFOND mesuré, qui ne peut que BAISSER.
 *
 * ⚠ UN PLAFOND NE SE RELÈVE JAMAIS. Un chiffre qui dépasse veut dire qu'un fichier neuf a pris le
 * mauvais chemin : le ranger (domaine, socle, module), lire par une porte, déplacer le composant.
 * Un chiffre qui baisse grâce à vous : abaisser le plafond au chiffre mesuré, dans le même commit.
 *
 * Mesures au 28/10/2026 (lot V3-G, migration des référentiels vers `src/modules/`) :
 *   hors carte 828 → 766 · pages Prisma 129 → 126 · routes Prisma 53 · composants → app 12 ·
 *   kit d'interface → métier 6 · tests qui lisent le source par chemin 128.
 *
 * Point de départ RECALÉ à la fusion de la base `bf7a907` (lots V3-C/D/E), et seulement là : ces lots ont
 * ajouté 9 fichiers hors carte (`lib/agent/consommation*.ts`, `contenu-non-fiable.ts`, `testing/journal.ts`,
 * `actions/assistant-ia-consommation-actions.ts`, `journal.ts`, `incidents-repetes.ts`,
 * `migrations-appliquees.ts`) avant que ce cliquet existe dans la base — et en ont retiré un (`agent/agent.ts`).
 * `journal` et `migrations-appliquees` ont été rangés au socle ; reste 768. Désormais, chaque fichier neuf hors
 * carte se range avant fusion.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PLAFONDS = {
  /** Fichiers de production de `src/lib/` dans aucune couche : jamais mesurés par les autres cliquets. */
  horsCarte: 756,
  /** Pages et layouts qui importent `@/lib/prisma` : une page lit par la porte d'un module. */
  pagesPrisma: 126,
  /** Routes (`route.ts`) qui importent `@/lib/prisma`. */
  routesPrisma: 53,
  /** Imports `src/components/` → `src/app/` : un composant partagé ne dépend pas d'une page. */
  composantsVersApp: 12,
  /** Imports du kit d'interface du socle (`components/ui`, `components/shared`) vers un métier. */
  kitVersMetier: 6,
  /**
   * Tests (hors `src/platform/` et `src/modules/`) qui lisent le source par un chemin `src/…` : ils
   * rougissent au premier déplacement sans qu'aucun comportement change. Un nouveau test de structure
   * utilise `lireSource()` / `sourceDuSymbole()` (`platform/source.ts`) ou teste le comportement.
   */
  testsDeTexte: 125,
} as const;

const mesure = mesurerCouverture();

describe("couverture des cliquets — ce qui échappait à la mesure ne grossit plus", () => {
  for (const [cle, plafond] of Object.entries(PLAFONDS) as [keyof typeof PLAFONDS, number][]) {
    it(`${cle} ≤ ${plafond}`, () => {
      const liste = mesure[cle];
      expect(liste.length, `${cle} : ${liste.length} > ${plafond}. Les derniers :\n${liste.slice(-10).join("\n")}`).toBeLessThanOrEqual(plafond);
    });
  }

  it("la mesure n'est pas vide (le cliquet n'est pas désarmé)", () => {
    expect(mesure.horsCarte.length).toBeGreaterThan(0);
    expect(mesure.pagesPrisma.length).toBeGreaterThan(0);
  });
});
