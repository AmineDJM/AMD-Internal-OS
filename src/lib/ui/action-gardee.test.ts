import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════
 * UNE ACTION SERVEUR QUI LÈVE NE DOIT PAS FIGER L'ÉCRAN (audit 27/10/2026, FRONTEND-UX-01).
 *
 * `use-action.ts` et `action-outcome.ts` ont été écrits pour tuer ce patron :
 *
 *     setBusy(true);
 *     const r = await decidePayment(fd);   // ← si l'appel LÈVE, la ligne suivante n'existe pas
 *     setBusy(false);
 *
 * Une action serveur LÈVE côté navigateur dans des cas ordinaires : connexion coupée (un délégué
 * en 4G), redéploiement Render pendant la saisie (« Failed to find Server Action »), erreur
 * Prisma non attrapée. Mesuré au navigateur (connexion coupée simulée) :
 *   - appelée depuis un `onClick`, la levée laisse `busy` à vrai pour toujours — le bouton
 *     tourne, aucun message (capture `docs/audit/2026-10-27/captures/action-onclick-bloquee.png`) ;
 *   - appelée depuis un `<form action>`, elle remonte à la limite d'erreur : la page ENTIÈRE est
 *     remplacée par « Cette page n'a pas pu s'afficher », la saisie est perdue
 *     (`action-non-gardee-bloquee.png`).
 * Une requête qui ne revient jamais, elle, fige `busy` dans les deux cas.
 *
 * L'audit a mesuré le patron dans 318 points d'appel. Deux règles :
 *   1. les écrans de décision corrigés par l'audit n'en portent plus — vérifié à leur fichier ;
 *   2. le parc ne grandit plus — CLIQUET au chiffre MESURÉ (§118.79c), il ne peut que baisser.
 *
 * La détection est volontairement simple et lisible : une ligne `const r = await f(…)` (sans
 * `.catch(`), non précédée d'un `try {` dans les 12 lignes qui la précèdent, et suivie dans les
 * deux lignes d'un `setX(false)` / `setX(null)` — la remise à zéro qui ne s'exécutera jamais.
 * Le correctif attendu : `useAction()` / `useKeyedAction()` (`components/shared/use-action.ts`),
 * ou un `try { … } catch { setErr(actionFailureMessage("THROWN")) } finally { setBusy(false) }`.
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

const APPEL = /(const|let)\s+\w+\s*=\s*await\s+[a-zA-Z]\w*\(/;
const REMISE = /\bset\w+\((false|null)\)/;

/** Les points d'appel non gardés d'un fichier client, au format `chemin:ligne`. */
export function appelsNonGardes(chemin: string, src: string): string[] {
  if (!/^\s*["']use client["']/.test(src)) return [];
  const lignes = src.split("\n");
  const hits: string[] = [];
  lignes.forEach((l, i) => {
    // Une ligne de commentaire (un exemple du patron cité en prose) n'appelle rien (§118.79d).
    if (/^\s*(\*|\/\/)/.test(l)) return;
    if (!APPEL.test(l) || /\.catch\(|\bfetch\(/.test(l)) return;
    if (/try\s*\{/.test(lignes.slice(Math.max(0, i - 12), i).join("\n"))) return;
    if (!REMISE.test(lignes.slice(i + 1, i + 3).join("\n"))) return;
    hits.push(`${relative(process.cwd(), chemin)}:${i + 1}`);
  });
  return hits;
}

/**
 * Mesuré le 27/10/2026 (audit frontend-ux), après correction du centre de paiement et du panneau
 * de décision Ad & Pro « autres » : 315 points d'appel (318 avant). Il ne peut que baisser.
 * Ramené à 0 le 28/10/2026 (V3-B, primitives UI) — le parc entier passe par `useAction` / `useKeyedAction` /
 * `useFormAction` ou un `try/catch/finally` ; les lignes de commentaire ne sont plus lues comme des appels.
 */
const PLAFOND_APPELS_NON_GARDES = 0;

describe("l'action serveur gardée", () => {
  const parc = fichiers(SRC).map((f) => ({ f, src: readFileSync(f, "utf8") }));

  it("la garde lit bien le parc (plancher de fichiers)", () => {
    expect(parc.length).toBeGreaterThan(1000);
  });

  it("le détecteur reconnaît le patron, et laisse passer la version gardée", () => {
    const nu = `"use client";\nasync function go(fd) {\n  setBusy(true);\n  const r = await decidePayment(fd);\n  setBusy(false);\n}`;
    const garde = `"use client";\nasync function go(fd) {\n  setBusy(true);\n  try {\n    const r = await decidePayment(fd);\n    setBusy(false);\n  } catch {}\n}`;
    expect(appelsNonGardes(join(SRC, "x.tsx"), nu)).toHaveLength(1);
    expect(appelsNonGardes(join(SRC, "x.tsx"), garde)).toHaveLength(0);
    const cite = `"use client";\n/**\n *     const r = await decidePayment(fd);\n *     setBusy(false);\n */`;
    expect(appelsNonGardes(join(SRC, "x.tsx"), cite)).toHaveLength(0);
  });

  it("les écrans de décision corrigés par l'audit ne peuvent plus rester figés", () => {
    const ecrans = [
      // Autoriser / refuser un paiement, répondre au centre : la feuille se verrouillait.
      "src/app/(app)/centre-de-paiement/centre-board.tsx",
      // Approuver / refuser / clôturer / resoumettre une demande Ad & Pro « autres ».
      "src/app/(app)/ad-pro/autres/[id]/decision-panel.tsx",
    ];
    for (const e of ecrans) {
      const src = readFileSync(join(process.cwd(), e), "utf8");
      expect(appelsNonGardes(join(process.cwd(), e), src), `${e} porte encore un appel non gardé`).toEqual([]);
    }
  });

  it("le parc ne grandit plus en appels non gardés (cliquet)", () => {
    const tous = parc.flatMap(({ f, src }) => appelsNonGardes(f, src));
    expect(tous.length, `appels non gardés :\n${tous.slice(0, 40).join("\n")}`).toBeLessThanOrEqual(PLAFOND_APPELS_NON_GARDES);
  });
});
