import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVENTS_TABS, NAVIGATION, STOCK_PROMO_TABS, type NavItem } from "@/lib/labels";
import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";

/**
 * DES ONGLETS SANS PORTE (§118.169).
 *
 * « Où se trouvent le stock promotionnel et le catalogue ? Je les trouve pas ! » Les deux écrans
 * existaient, gardés, testés — et le menu menait à `/ad-pro`, la SEULE page du pôle qui ne
 * rendait pas la barre d'onglets. Tous les autres écrans d'Ad & Pro la portaient ; celui par
 * lequel on entre, non. Le Stock et le Catalogue ne sont pas des natures de demande : aucune
 * ligne de la liste n'y mène, donc ils n'avaient AUCUNE porte depuis le menu. Les bancs les
 * ouvraient par leur adresse — exactement ce qu'aucune personne ne fait (§118.50 : une vue
 * parfaite que rien n'affiche est du code mort).
 *
 * La règle qui en sort s'arme sur la DÉCLARATION du menu, pas sur une liste d'écrans écrite à la
 * main : toute entrée qui déclare des onglets doit les MONTRER sur la page où elle mène — ou y
 * rediriger vers un onglet qui les montre. Une entrée ajoutée demain est jugée sans que personne
 * pense à elle (§118.17).
 */

const APP = path.join(process.cwd(), "src/app/(app)");

/** Le code, sans sa prose : un commentaire qui CITE `<ModuleTabs` n'affiche rien (§118.79d). */
function sansCommentaires(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function pageDe(href: string): string | null {
  const fichier = path.join(APP, href.replace(/^\//, "").split("?")[0], "page.tsx");
  return existsSync(fichier) ? fichier : null;
}

/** Lit un import LOCAL, résolu depuis le fichier qui l'écrit — pas depuis la page. */
type Lecteur = (specifier: string, depuis: string) => { fichier: string; source: string } | null;

/**
 * La page montre-t-elle une barre d'onglets ? Trois formes, et seulement trois :
 *   • elle rend `<ModuleTabs` elle-même ;
 *   • elle importe un composant LOCAL qui le rend (l'en-tête partagé des Annuaires) ;
 *   • c'est une page d'ESCALE : elle ne rend rien et redirige vers le premier onglet ouvert.
 *
 * Un import relatif se résout depuis le fichier qui l'ÉCRIT : `./en-tete` lu dans
 * `annuaires/feuille-praticiens.tsx` n'est pas `./en-tete` lu dans `annuaires/medecins/page.tsx`.
 * La première version les confondait, et déclarait sans barre deux pages qui l'ont.
 */
export function montreOnglets(source: string, depuis = "", lire: Lecteur = () => null, vus = new Set<string>()): boolean {
  const code = sansCommentaires(source);
  if (/<ModuleTabs\b/.test(code)) return true;
  if (/\bredirect\(/.test(code) && !/return\s*\(?\s*</.test(code)) return true;
  // Les imports relatifs, et les barres d'onglets PARTAGÉES (`@/components/shared/onglets-*`, ex. `OngletsAdam`).
  for (const m of code.matchAll(/from\s+"(\.{1,2}\/[^"]+|@\/components\/shared\/onglets-[^"]+)"/g)) {
    const local = lire(m[1], depuis);
    if (!local || vus.has(local.fichier)) continue;
    vus.add(local.fichier);
    if (montreOnglets(local.source, local.fichier, lire, vus)) return true;
  }
  return false;
}

const lireSurDisque: Lecteur = (specifier, depuis) => {
  for (const ext of [".tsx", ".ts", "/index.tsx"]) {
    const fichier = specifier.startsWith("@/")
      ? path.join(process.cwd(), "src", specifier.slice(2) + ext)
      : path.resolve(path.dirname(depuis), specifier + ext);
    if (existsSync(fichier)) return { fichier, source: readFileSync(fichier, "utf8") };
  }
  return null;
};

function pageMontreOnglets(href: string): boolean | null {
  const fichier = pageDe(href);
  if (!fichier) return null;
  return montreOnglets(readFileSync(fichier, "utf8"), fichier, lireSurDisque);
}

function entreesAOnglets(): NavItem[] {
  const toutes: NavItem[] = [];
  const parcourir = (liste: NavItem[]) => liste.forEach((e) => { toutes.push(e); if (e.children) parcourir(e.children); });
  parcourir(NAVIGATION);
  return toutes.filter((e) => (e.tabs?.length ?? 0) >= 2);
}

describe("Des onglets qui ont une porte depuis le menu", () => {
  it("TÉMOINS : le détecteur sait dire NON, et ne se laisse pas prendre à la prose", () => {
    // Sans ces cas, un détecteur qui répond « oui » à tout rendrait le cliquet vert sur le défaut.
    expect(montreOnglets(`export default function P() { return (<div><PageHeader title="x" /></div>); }`)).toBe(false);
    expect(montreOnglets(`// <ModuleTabs tabs={t} /> — à remettre\nexport default function P() { return (<div />); }`)).toBe(false);
    expect(montreOnglets(`{/* <ModuleTabs tabs={t} /> */}\nexport default function P() { return (<div />); }`)).toBe(false);
    // Et dans l'autre sens : les trois formes légitimes sont reconnues.
    expect(montreOnglets(`export default function P() { return (<div><ModuleTabs tabs={t} /></div>); }`)).toBe(true);
    expect(montreOnglets(`export default async function P() { redirect("/x"); }`)).toBe(true);
    const enTete: Lecteur = (s) => (s === "./en-tete" ? { fichier: "/x/en-tete.tsx", source: `export function EnTete() { return (<ModuleTabs tabs={t} />); }` } : null);
    expect(montreOnglets(`import { EnTete } from "./en-tete";\nexport default function P() { return (<EnTete />); }`, "/x/page.tsx", enTete)).toBe(true);
  });

  it("PRÉMISSE : le parcours lit bien les entrées à onglets du VRAI menu", () => {
    // Un parcours cassé qui ne trouverait rien rendrait le cliquet vert sans rien juger (§118.17).
    const entrees = entreesAOnglets();
    expect(entrees.length, entrees.map((e) => e.label).join(", ")).toBeGreaterThanOrEqual(10);
    expect(entrees.some((e) => e.href === "/ad-pro"), "l'entrée « Ad & Pro » et ses onglets").toBe(true);
  });

  it("toute entrée de menu à onglets MONTRE ses onglets sur la page où elle mène", () => {
    const sansPorte = entreesAOnglets()
      .filter((e) => pageMontreOnglets(e.href) !== true)
      .map((e) => `« ${e.label} » → ${e.href} : ${(e.tabs ?? []).filter((t) => t.href !== e.href).map((t) => t.label).join(", ")} n'ont aucune porte depuis le menu`);
    expect(sansPorte, sansPorte.join("\n")).toEqual([]);
  });

  it("le Stock promotionnel est un sous-module À PART (§118.173) — et chacun de ses écrans, comme ceux d'Ad & Pro, garde la barre", () => {
    const adpro = EVENTS_TABS.map((t) => t.href);
    const stock = STOCK_PROMO_TABS.map((t) => t.href);
    expect(adpro, "le stock n'est plus un onglet d'Ad & Pro").not.toContain(CHEMIN_STOCK_PROMO);
    expect(stock).toEqual([CHEMIN_STOCK_PROMO, CHEMIN_CATALOGUE_PROMO]);
    expect(entreesAOnglets().some((e) => e.href === CHEMIN_STOCK_PROMO), "son entrée de menu, à onglets").toBe(true);
    // Y arriver ne suffit pas : on doit pouvoir en REPARTIR vers les autres écrans du module.
    for (const href of [...adpro, ...stock]) expect(pageMontreOnglets(href), href).toBe(true);
  });

  it("CLIQUET : les pages d'onglet qui ne montrent pas la barre ne sont pas plus nombreuses qu'aujourd'hui", () => {
    // DETTE MESURÉE (§118.169), et non traitée par ce lot : sur ces pages, on ne peut pas passer à
    // un onglet voisin sans revenir au menu — mais on y ARRIVE, depuis la page d'entrée, qui montre
    // la barre. Le cliquet empêche qu'une page d'onglet NEUVE naisse sans elle ; il ne descend que
    // si l'on répare, et le chiffre suit alors la mesure (§118.79c).
    const sansBarre = entreesAOnglets()
      .flatMap((e) => (e.tabs ?? []).filter((t) => t.href !== e.href).map((t) => ({ entree: e.label, ...t })))
      .filter((t) => pageMontreOnglets(t.href) === false)
      .map((t) => `${t.entree} › ${t.label} (${t.href})`);
    expect(sansBarre.length, sansBarre.join("\n")).toBeLessThanOrEqual(6);
  });
});
