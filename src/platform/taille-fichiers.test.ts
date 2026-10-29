import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DE TAILLE — rapport d'audit 08, ARCH-04 (lot V4 « fichiers géants »).
 *
 * Un fichier de 7 000 lignes, personne ne le comprend en entier, deux sessions qui y touchent entrent
 * en conflit, et chaque ligne changée recharge ses cent dépendances. La règle : un fichier de
 * production (`src/**`, hors tests) tient en **1 000 lignes au plus**, découpé PAR RESPONSABILITÉ
 * dans un dossier qui porte son nom (le fichier d'origine reste une porte qui réexporte).
 *
 * `HERITES` liste, à la ligne près, les fichiers qui dépassaient encore à la mesure du lot V4 —
 * chacun avec son plafond (sa taille mesurée). Cette liste ne peut que RÉTRÉCIR :
 *   - un fichier hérité ne grossit pas au-delà de son plafond ;
 *   - un fichier hérité passé sous 1 000 lignes SORT de la liste (dans le même commit) ;
 *   - un fichier hérité qui maigrit sans passer sous 1 000 : abaisser son plafond au chiffre mesuré ;
 *   - tout autre fichier, neuf ou ancien, est plafonné à 1 000.
 *
 * ⚠ UN PLAFOND NE SE RELÈVE JAMAIS, ET LA LISTE NE S'ALLONGE JAMAIS. Un fichier qui dépasse se
 * découpe (voir `docs/architecture/MODULES.md` et les dossiers `src/lib/rbac/`, `src/lib/labels/`,
 * `src/lib/assistant/coeur/` pour des exemples) ; il n'entre pas dans la liste.
 *
 * Mesure (lignes comme `wc -l`) : 49 fichiers > 1 000 lignes avant le lot V4 (dont `assistant.ts` 7 314,
 * `assistant/ops/catalog.ts` 5 399, `labels.ts` 2 289, `rbac.ts` 2 212) → 1 après fusion des lots RH
 * et Ad & Pro (qui ont découpé les leurs) : `payment-request-actions.ts`, confié au chantier des paiements — le seul HÉRITÉ.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PLAFOND = 1_000;

/** Fichiers hérités au-dessus du plafond (hors périmètre du lot V4, confiés à d'autres chantiers) → taille mesurée. */
const HERITES: Readonly<Record<string, number>> = {
  "src/lib/actions/payment-request-actions.ts": 1197,
};

function fichiersDeProduction(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") fichiersDeProduction(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

/** Nombre de lignes, compté comme `wc -l` (les retours à la ligne). */
function lignes(fichier: string): number {
  const texte = fs.readFileSync(fichier, "utf8");
  let n = 0;
  for (let i = 0; i < texte.length; i++) if (texte.charCodeAt(i) === 10) n++;
  return n;
}

const tailles = new Map(fichiersDeProduction("src").map((f) => [f, lignes(f)] as const));

describe("taille des fichiers — 1 000 lignes au plus, la liste des hérités ne fait que rétrécir", () => {
  it(`aucun fichier hors liste ne dépasse ${PLAFOND} lignes`, () => {
    const trop = [...tailles].filter(([f, n]) => n > PLAFOND && !(f in HERITES)).map(([f, n]) => `${f} : ${n} lignes`);
    expect(trop, `À découper par responsabilité (dossier au nom du fichier, l'origine devient une porte) :\n${trop.join("\n")}`).toEqual([]);
  });

  for (const [fichier, plafond] of Object.entries(HERITES)) {
    it(`${fichier} ≤ ${plafond}`, () => {
      const n = tailles.get(fichier);
      expect(n, `${fichier} n'existe plus : le retirer de HERITES`).toBeDefined();
      expect(n!, `${fichier} : ${n} lignes > plafond ${plafond} (un plafond ne se relève jamais — découper)`).toBeLessThanOrEqual(plafond);
      expect(n!, `${fichier} est passé sous ${PLAFOND} lignes : le retirer de HERITES (la liste ne fait que rétrécir)`).toBeGreaterThan(PLAFOND);
    });
  }

  it("la mesure n'est pas vide (le cliquet n'est pas désarmé)", () => {
    expect(tailles.size).toBeGreaterThan(1_000);
  });
});
