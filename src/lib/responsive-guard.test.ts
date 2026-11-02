import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * LE GARDE-FOU DU RESPONSIVE — deux erreurs qui reviennent, et qu'on ne voit pas en développant.
 *
 * On travaille sur un écran large ; les deux défauts ci-dessous n'y apparaissent jamais. Ils ne se
 * découvrent que sur le téléphone de quelqu'un, en réunion, et ils donnent exactement la sensation
 * dont on se plaint : « il faut tirer l'écran vers la gauche ».
 *
 *  1. UNE TABLE LARGE HORS CONTENEUR DÉFILANT. Une table qui impose sa largeur minimale sans être
 *     enveloppée dans un `overflow-x-auto` ne défile pas toute seule : c'est LA PAGE ENTIÈRE qui
 *     part de travers, en-tête et menu compris.
 *  2. `col-span-N` SANS PRÉFIXE, dans une grille qui commence à UNE colonne. CSS grid crée alors
 *     une deuxième colonne implicite : l'élément « pleine largeur » devient deux fois trop large
 *     et pousse tout le reste hors de l'écran. Le correctif est toujours le même — `sm:col-span-N`.
 *
 * Ce test lit les sources : il n'a besoin ni de navigateur, ni de capture d'écran.
 */

const ROOTS = ["src/app", "src/components", "src/modules"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => tsxFiles(r));

/** Le numéro de ligne d'une position dans un fichier — pour que l'échec soit actionnable. */
const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

/**
 * Les COMMENTAIRES ne sont pas du balisage.
 *
 * Un commentaire qui EXPLIQUE le piège (« ici, `col-span-2` fabriquerait une colonne implicite »)
 * déclencherait l'alerte qu'il sert à prévenir — et l'on apprendrait à contourner le garde-fou en
 * s'interdisant d'écrire des commentaires clairs. On les blanchit, en gardant les sauts de ligne
 * pour que les numéros restent justes.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("responsive — la page ne doit JAMAIS défiler latéralement", () => {
  it("toute table à largeur minimale défile DANS SON PROPRE conteneur", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const m of source.matchAll(/<table[^>]*min-w-\[/g)) {
        // Le conteneur défilant est juste au-dessus dans le balisage : on regarde ce qui précède
        // immédiatement l'ouverture de la table.
        const before = source.slice(Math.max(0, m.index - 400), m.index);
        if (!/overflow-x-auto|overflow-auto/.test(before)) {
          offenders.push(`${file}:${lineAt(source, m.index)}`);
        }
      }
    }
    expect(offenders, `Table large sans conteneur défilant (ajouter un parent « overflow-x-auto ») :\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  it("aucun `col-span-N` non préfixé n'excède les colonnes de base de sa grille parente", () => {
    // La règle regarde la GRILLE PARENTE LA PLUS PROCHE, pas « le fichier » : un `col-span-2` dans
    // une grille `grid-cols-2 sm:grid-cols-3` est exact (il couvre les deux colonnes du
    // téléphone), et le signaler parce qu'une autre grille du fichier démarre à une colonne
    // ferait un garde qu'on apprend à contourner. Ce qui casse, c'est un span PLUS LARGE que la
    // base : CSS grid crée alors une colonne implicite, et l'élément sort de l'écran.
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const m of source.matchAll(/(?<![a-z0-9:-])col-span-(\d+)/g)) {
        const start = source.lastIndexOf('"', m.index) + 1;
        const prefixChar = source.slice(Math.max(start, m.index - 4), m.index);
        if (/(sm|md|lg|xl|2xl):$/.test(prefixChar)) continue;
        const span = Number(m[1]);
        // La grille parente : la dernière `className="…grid…"` déclarée avant cet élément.
        const before = source.slice(0, m.index);
        const grilles = [...before.matchAll(/className="([^"]*\bgrid\b[^"]*)"/g)];
        const parent = grilles.length ? grilles[grilles.length - 1][1] : null;
        if (!parent) continue;
        const base = parent.split(/\s+/).map((t) => /^grid-cols-(\d+)$/.exec(t)?.[1]).find(Boolean);
        // Sans colonne de base, l'autre règle de ce fichier prend le relais.
        if (!base) continue;
        if (span > Number(base)) offenders.push(`${file}:${lineAt(source, m.index)} — col-span-${span} dans « ${parent} »`);
      }
    }
    expect(offenders, `« col-span » plus large que les colonnes de base de sa grille (préfixer : « sm:col-span-N ») :\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  /**
   * UNE GRILLE SANS COLONNE DE BASE — le débordement que l'audit navigateur a mesuré sur 13 pages.
   *
   * `className="grid gap-4 lg:grid-cols-2"` ne déclare AUCUNE colonne sous `lg` : la grille
   * range alors ses enfants dans des colonnes IMPLICITES, dimensionnées `auto` — c'est-à-dire au
   * moins à la largeur de leur contenu le plus large. Un tableau, un mot sans espace (une adresse
   * e-mail), un `whitespace-nowrap`, un champ avec un long placeholder : n'importe lequel élargit
   * la colonne au-delà de l'écran, et la carte entière sort à droite. Sur ordinateur, où la
   * grille passe à deux colonnes de `minmax(0, 1fr)`, rien de tout cela n'apparaît.
   *
   * `grid-cols-1` en base (`repeat(1, minmax(0, 1fr))`) borne la colonne à son conteneur : c'est
   * le contenu qui se replie ou défile chez lui, jamais la page. Le correctif est toujours le
   * même — ajouter `grid-cols-1` — et ce test empêche d'en écrire une nouvelle sans.
   */
  it("toute grille qui n'a de colonnes qu'à partir d'un point de rupture part de `grid-cols-1`", () => {
    const offenders: string[] = [];
    const classes = /(?:className=|cn\()\s*"((?:grid|inline-grid)\s[^"]*)"/g;
    for (const file of FILES) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const m of source.matchAll(classes)) {
        const tokens = m[1].split(/\s+/);
        const base = tokens.some((t) => /^grid-cols-\S+$/.test(t));
        const prefixed = tokens.some((t) => /^(sm|md|lg|xl|2xl):grid-cols-\S+$/.test(t));
        if (prefixed && !base) offenders.push(`${file}:${lineAt(source, m.index ?? 0)} — « ${m[1]} »`);
      }
    }
    expect(offenders, `Grille sans colonne de base (ajouter « grid-cols-1 » après « grid ») :\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  /**
   * LA COQUE ELLE-MÊME — la garde qui rend les deux précédentes utiles.
   *
   * Le conteneur défilant de l'application porte `overflow-y-auto`. En CSS, un axe en `auto`
   * force l'autre à devenir défilant : sans borne explicite, ce conteneur défile AUSSI
   * latéralement, et le moindre contenu trop large fait partir toute la page de travers —
   * exactement ce dont on se plaignait (« ça glisse trop »). Les deux règles ci-dessus obligent
   * le contenu large à défiler chez lui ; celle-ci empêche de rouvrir la porte par le haut.
   */
  it("le conteneur défilant de l'application ne défile pas latéralement", () => {
    const shell = readFileSync("src/app/(app)/layout.tsx", "utf8");
    const main = shell.slice(shell.indexOf("<main"), shell.indexOf(">", shell.indexOf("<main")));
    expect(main, "Le <main> de la coque doit rester `overflow-x-hidden` (voir le commentaire du fichier).")
      .toMatch(/overflow-x-hidden/);
  });
});
