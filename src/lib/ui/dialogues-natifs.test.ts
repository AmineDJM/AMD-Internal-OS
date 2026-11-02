import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════
 * PAS DE BOÎTE DU NAVIGATEUR, PAS DE « ÉCHEC. » (V3-B, audit 27/10/2026 FRONTEND-UX-05).
 *
 * `window.confirm()`, `window.alert()` et `window.prompt()` ouvrent une boîte grise qui BLOQUE l'onglet,
 * ignore le style et la langue de l'application, dit « OK » quel que soit le geste, et que les
 * navigateurs mobiles laissent supprimer d'un appui (« Empêcher cette page d'ouvrir des boîtes de
 * dialogue ») — après quoi `confirm()` renvoie `false` en silence et le geste ne part plus jamais.
 * Les remplaçants vivent dans `src/components/ui/` :
 *
 *   confirm(q)  → `const confirmer = useConfirmer();  if (!(await confirmer(q))) return;`
 *   prompt(q)   → `const saisir = useSaisir();        const motif = await saisir({ titre, saisie: { libelle } });`
 *   alert(m)    → `<Retour ton="erreur">{err}</Retour>` près du geste, ou `useRetours().erreur(m)`
 *
 * Et le repli générique `r.error ?? "Échec."` ne dit ni ce qui a raté ni que faire : on écrit ce que
 * le geste n'a pas fait (« La suppression n'a pas abouti. ») ou `actionFailureMessage()`.
 *
 * CLIQUETS AU CHIFFRE MESURÉ (§118.79c) — ils ne peuvent que baisser ; l'objectif est zéro. Les seuls
 * appels natifs permis sont les replis des primitives elles-mêmes, quand aucun porteur n'est monté.
 * ═══════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

/** Commentaires retirés : un cliquet ne s'accroche pas à la prose (§118.79d). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Les replis des primitives (aucun porteur monté) — les SEULS appels natifs permis. */
const PRIMITIVES = new Set(["src/components/ui/dialogue.tsx", "src/components/ui/retours-porteur.tsx"]);

/** `confirm(` nu ou `window.confirm(` — pas `useConfirmer(`, pas `x.confirm(`. */
export const MOTIFS = {
  confirm: /(?<![\w.])confirm\(|\bwindow\.confirm\(/g,
  alert: /(?<![\w.])alert\(|\bwindow\.alert\(/g,
  prompt: /(?<![\w.])prompt\(|\bwindow\.prompt\(/g,
  repliGenerique: /\?\?\s*["'](Échec|Erreur|Action impossible)\.?["']/g,
} as const;

/** Le relevé du parc, par motif : `chemin` → nombre. */
export function releve(): Record<keyof typeof MOTIFS, Map<string, number>> {
  const out = { confirm: new Map(), alert: new Map(), prompt: new Map(), repliGenerique: new Map() } as Record<keyof typeof MOTIFS, Map<string, number>>;
  for (const f of fichiers(SRC)) {
    const rel = relative(process.cwd(), f);
    if (PRIMITIVES.has(rel)) continue;
    const src = sansCommentaires(readFileSync(f, "utf8"));
    for (const k of Object.keys(MOTIFS) as (keyof typeof MOTIFS)[]) {
      const n = (src.match(MOTIFS[k]) ?? []).length;
      if (n) out[k].set(rel, n);
    }
  }
  return out;
}

/**
 * Mesuré le 28/10/2026 (V3-B), avant migration : confirm 125, alert 46, prompt 6, repli générique 259.
 * Après migration du parc (lots A1, A2, B, C, D) : ZÉRO partout. Le plafond est désormais une interdiction.
 */
const PLAFONDS: Record<keyof typeof MOTIFS, number> = {
  confirm: 0,
  alert: 0,
  prompt: 0,
  repliGenerique: 0,
};

describe("pas de boîte du navigateur, pas de repli générique", () => {
  const mesure = releve();

  it("la garde lit bien le parc (plancher de fichiers)", () => {
    expect(fichiers(SRC).length).toBeGreaterThan(1000);
  });

  it("le détecteur distingue l'appel natif de ses voisins", () => {
    const ok = (s: string) => (s.match(MOTIFS.confirm) ?? []).length;
    expect(ok("if (!window.confirm(q)) return;")).toBe(1);
    expect(ok("if (!confirm(q)) return;")).toBe(1);
    expect(ok("await confirmer(q); useConfirmer(); onConfirm(); x.confirm(q);")).toBe(0);
    expect(("r.error ?? \"Échec.\"".match(MOTIFS.repliGenerique) ?? []).length).toBe(1);
  });

  for (const k of Object.keys(PLAFONDS) as (keyof typeof MOTIFS)[]) {
    it(`${k} : le parc ne grandit plus (cliquet au chiffre mesuré)`, () => {
      const parFichier = [...mesure[k].entries()];
      const total = parFichier.reduce((a, [, n]) => a + n, 0);
      expect(total, `${total} × ${k} (plafond ${PLAFONDS[k]}) :\n${parFichier.slice(0, 30).map(([f, n]) => `${f} (${n})`).join("\n")}`).toBeLessThanOrEqual(PLAFONDS[k]);
    });
  }
});
