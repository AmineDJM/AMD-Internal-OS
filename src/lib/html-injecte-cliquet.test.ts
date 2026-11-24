import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLIQUET — AUCUN HTML INJECTÉ DANS LA PAGE HORS D'UNE LISTE NOMMÉE ET MOTIVÉE (audit sécurité).
 *
 * L'écran d'administration du corpus réglementaire rendait l'extrait de `ts_headline` avec
 * `dangerouslySetInnerHTML` : le texte venait de pages de régulateurs téléchargées, une balise
 * `<img onerror>` glissée dans l'une d'elles s'exécutait dans la session du Super Admin. Avant lui,
 * l'aperçu Office (SA-12, `apercu-isole.ts`) avait eu le même défaut. React échappe tout ce qu'on
 * lui donne en enfant ; ces puits-ci contournent l'échappement. Ce test fait échouer toute
 * NOUVELLE occurrence : le remède est de rendre en JSX (segments, `<mark>` construits ici) ou, pour
 * un document entier, dans un `<iframe sandbox>` — et sinon de l'inscrire ci-dessous avec la preuve
 * que le contenu ne peut pas porter de balise venue de la base, d'un utilisateur, d'un fichier ou
 * du web.
 */

const SRC = path.join(process.cwd(), "src");
const CE_FICHIER = path.relative(process.cwd(), __filename).split(path.sep).join("/");

/** Les puits qui posent du HTML brut dans le document. */
const PUITS: { nom: string; motif: RegExp }[] = [
  { nom: "dangerouslySetInnerHTML", motif: /dangerouslySetInnerHTML\s*[=:]/ },
  { nom: "innerHTML/outerHTML =", motif: /\.(inner|outer)HTML\s*\+?=/ },
  { nom: "insertAdjacentHTML", motif: /\.insertAdjacentHTML\s*\(/ },
  { nom: "document.write", motif: /\.document\.write(ln)?\s*\(|\bdocument\.write(ln)?\s*\(/ },
];

/**
 * LES OCCURRENCES ADMISES — fichier → motif. Une entrée qui ne correspond plus à rien fait aussi
 * échouer le test : la liste ne garde que des exceptions vivantes.
 */
const ADMIS: Record<string, string> = {
  "src/app/(app)/admin/organigramme/org-canvas.tsx":
    "document.write dans la fenêtre d'impression de l'organigramme : `buildPrintDocument` (src/lib/org-chart-print.ts) "
    + "échappe chaque nom, poste, entité, titre et sous-titre par `escapeXml` et filtre la couleur par `safeColor` "
    + "— testé dans org-chart-print.test.ts (« A & B », « <b>x</b> »).",
};

function fichiers(dir: string, out: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const p = path.join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom !== "node_modules" && nom !== "generated") fichiers(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(nom)) {
      out.push(p);
    }
  }
  return out;
}

/** Les lignes de code (commentaires de ligne et blocs `/* … *\/` retirés grossièrement). */
function codeSansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("cliquet — HTML injecté dans la page", () => {
  const trouves = new Map<string, string[]>();
  for (const f of fichiers(SRC)) {
    const rel = path.relative(process.cwd(), f).split(path.sep).join("/");
    if (rel === CE_FICHIER || /\.test\.(ts|tsx)$/.test(rel)) continue;
    const code = codeSansCommentaires(readFileSync(f, "utf8"));
    const puits = PUITS.filter((p) => p.motif.test(code)).map((p) => p.nom);
    if (puits.length) trouves.set(rel, puits);
  }

  it("aucune occurrence hors de la liste nommée et motivée", () => {
    const nouvelles = [...trouves.entries()].filter(([f]) => !(f in ADMIS)).map(([f, p]) => `${f} — ${p.join(", ")}`);
    expect(nouvelles, "Rendre en JSX (React échappe) ou dans un <iframe sandbox> ; sinon inscrire le fichier dans ADMIS avec la preuve que le contenu est sûr.").toEqual([]);
  });

  it("chaque exception admise existe encore et porte un motif", () => {
    for (const [f, motif] of Object.entries(ADMIS)) {
      expect(trouves.has(f), `${f} : plus d'occurrence — retirer l'entrée`).toBe(true);
      expect(motif.length).toBeGreaterThan(40);
    }
  });
});
