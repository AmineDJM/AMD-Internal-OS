import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO, MENU_CATALOGUE_PROMO, MENU_STOCK_PROMO,
  VUES_STOCK_PROMO, lienStockPromo, vueStockPromo,
} from "./stock-promo";
import { EVENTS_TABS, NAVIGATION, STOCK_PROMO_TABS } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE STOCK PROMOTIONNEL, SOUS-MODULE À PART — son adresse, ses anciennes adresses, et tous ceux
 * qui la citent (§118.173).
 *
 * L'adresse changeait, et elle était écrite en toutes lettres à vingt-cinq endroits. Trois
 * propriétés, chacune avec le cas qui la ferait tomber :
 *   1. UNE ancienne adresse ne meurt pas : la page d'escale redirige, la vue demandée comprise — et
 *      seulement une vue que l'écran connaît (une valeur inconnue n'est pas recopiée).
 *   2. AUCUN fichier de production ne réécrit l'ancienne adresse ni l'ancien chemin de menu : une
 *      copie oubliée mènerait à l'escale (au mieux) ou nommerait un chemin que le menu n'a plus
 *      (§118.128 : un remède qui nomme un chemin faux fait chercher).
 *   3. LE MENU porte le stock À PART : une entrée du pôle Sales & Marketing, plus un onglet d'Ad &
 *      Pro. Le relier aux achats reste le rôle de ses liens (réception, poste, visite), pas du menu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({ redirect: (vers: string) => { throw new Redirection(vers); } }));

async function destination(appel: () => unknown): Promise<string> {
  try {
    await appel();
  } catch (e) {
    if (e instanceof Redirection) return e.vers;
    throw e;
  }
  throw new Error("la page n'a pas redirigé");
}

describe("les anciennes adresses mènent au bon écran", () => {
  it("le stock : la vue demandée suit, une vue inconnue est jetée", async () => {
    const { default: Escale } = await import("@/app/(app)/promo-material/stock/page");
    expect(await destination(() => Escale({ searchParams: Promise.resolve({ vue: "comptages" }) }))).toBe(`${CHEMIN_STOCK_PROMO}?vue=comptages`);
    expect(await destination(() => Escale({ searchParams: Promise.resolve({ vue: "moi" }) }))).toBe(lienStockPromo("moi"));
    expect(await destination(() => Escale({ searchParams: Promise.resolve({}) }))).toBe(CHEMIN_STOCK_PROMO);
    // Une valeur forgée n'est pas recopiée dans l'adresse de destination.
    expect(await destination(() => Escale({ searchParams: Promise.resolve({ vue: "https://ailleurs.example" }) }))).toBe(CHEMIN_STOCK_PROMO);
  });

  it("le catalogue", async () => {
    const { default: Escale } = await import("@/app/(app)/promo-material/catalogue/page");
    expect(await destination(() => Escale())).toBe(CHEMIN_CATALOGUE_PROMO);
  });

  it("la lecture d'une vue — les sept, et rien d'autre", () => {
    for (const v of VUES_STOCK_PROMO) expect(vueStockPromo(v)).toBe(v);
    expect(vueStockPromo("MOI")).toBeUndefined();
    expect(vueStockPromo(undefined)).toBeUndefined();
    expect(vueStockPromo(["moi"])).toBeUndefined();
  });
});

const SRC = join(process.cwd(), "src");
function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}
/** Les commentaires retirés : la prose qui RACONTE l'ancienne adresse n'est pas un lien (§118.79d). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const ANCIENNES = [/["'`]\/promo-material\/(?:stock|catalogue)\b/, /Ad (?:&|&amp;) Pro › (?:Stock|Catalogue) promotionnel/];

export function citationsAnciennes(src: string): string[] {
  const code = sansCommentaires(src);
  return ANCIENNES.flatMap((re) => code.match(new RegExp(re.source, "g")) ?? []);
}

describe("personne ne réécrit l'ancienne adresse", () => {
  it("le détecteur lui-même — dans les deux sens (§118.17)", () => {
    expect(citationsAnciennes(`revalidatePath("/promo-material/stock");`)).toHaveLength(1);
    expect(citationsAnciennes("link: `/promo-material/stock?vue=${v}`")).toHaveLength(1);
    expect(citationsAnciennes(`x = "Ad &amp; Pro › Catalogue promotionnel";`)).toHaveLength(1);
    expect(citationsAnciennes(`x = "Ad & Pro › Stock promotionnel";`)).toHaveLength(1);
    // La fiche d'un dossier n'est pas le stock ; un commentaire ne compte pas.
    expect(citationsAnciennes(`href={\`/promo-material/\${id}\`}`)).toEqual([]);
    expect(citationsAnciennes(`/* ancien : "/promo-material/stock" */\n// "Ad & Pro › Stock promotionnel"`)).toEqual([]);
  });

  it("aucun fichier de production ne cite l'ancienne adresse ni l'ancien chemin de menu", () => {
    const tous = fichiers(SRC);
    expect(tous.length, "PRÉMISSE : le parcours lit bien le dépôt").toBeGreaterThan(1000);
    const fautes = tous.flatMap((f) => citationsAnciennes(readFileSync(f, "utf8")).map((c) => `${relative(process.cwd(), f)} : ${c}`));
    expect(fautes, fautes.join("\n")).toEqual([]);
  });

  it("le chemin de menu nommé dans les phrases est celui que le menu affiche", () => {
    const entree = NAVIGATION.find((n) => n.href === CHEMIN_STOCK_PROMO);
    expect(entree, "l'entrée du stock promotionnel").toBeDefined();
    expect(MENU_STOCK_PROMO).toBe(`Sales & Marketing › ${entree!.label}`);
    const onglet = STOCK_PROMO_TABS.find((t) => t.href === CHEMIN_CATALOGUE_PROMO);
    expect(MENU_CATALOGUE_PROMO).toBe(`${MENU_STOCK_PROMO} › ${onglet!.label}`);
  });
});

describe("le menu porte le stock À PART", () => {
  it("une entrée du pôle Sales & Marketing, dont les onglets sont le stock et le catalogue", () => {
    const entree = NAVIGATION.find((n) => n.href === CHEMIN_STOCK_PROMO)!;
    expect(entree.pole).toBe("MARKETING");
    expect(entree.tabs).toBe(STOCK_PROMO_TABS);
    expect(STOCK_PROMO_TABS.map((t) => [t.module, t.href])).toEqual([["PROMO_STOCK", CHEMIN_STOCK_PROMO], ["PROMO_CATALOG", CHEMIN_CATALOGUE_PROMO]]);
  });

  it("plus un onglet d'Ad & Pro — ni sous son adresse, ni dans son périmètre de surlignage", () => {
    const adpro = EVENTS_TABS.map((t) => t.href);
    expect(adpro).not.toContain(CHEMIN_STOCK_PROMO);
    expect(adpro).not.toContain(CHEMIN_CATALOGUE_PROMO);
    expect(adpro.some((h) => h.startsWith(CHEMIN_STOCK_PROMO))).toBe(false);
    const entreeAdPro = NAVIGATION.find((n) => n.tabs === EVENTS_TABS)!;
    expect((entreeAdPro.match ?? []).some((m) => m.startsWith(CHEMIN_STOCK_PROMO))).toBe(false);
  });
});
