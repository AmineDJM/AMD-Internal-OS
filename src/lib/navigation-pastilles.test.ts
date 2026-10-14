import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NAVIGATION, type NavItem } from "@/lib/labels";
import { FLAT_GROUPS, groupIntoPoles, itemsOfGroup, pastillesDesEntrees, modulesComptes, modulesDeLEntree, modulesPropres } from "@/lib/navigation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PASTILLE PAR MODULE, JAMAIS UNE PAR SOUS-MENU (§118.154).
 *
 * Mesuré dans la peau des Finances : « 3 » sur Finances ET sur Banque & paiements, Comptabilité
 * et Bons de commande — les trois notifications du module affichées quatre fois, et « Bons de
 * commande 3 » quand aucun bon n'attendait de signature. Le cas est joué sur le VRAI catalogue du
 * menu : une entrée fabriquée pour le banc prouverait une règle sur un menu qui n'existe pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const entree = (label: string): NavItem => {
  const e = NAVIGATION.find((n) => n.label === label);
  if (!e) throw new Error(`entrée « ${label} » absente du catalogue`);
  return e;
};

describe("pastillesDesEntrees — chaque module compté une fois", () => {
  it("PRÉMISSE : Finances et ses sous-menus portent le MÊME module — sinon le cas ne mesure rien", () => {
    // Les Bons de commande sont un module à part (§118.176) ; tous les sous-menus restants
    // (paiements, comptabilité, recensement des doublons de factures…) sont des Finances.
    const finances = entree("Finances");
    const modules = finances.children?.map((c) => c.module) ?? [];
    expect(modules.length).toBeGreaterThanOrEqual(2);
    expect(new Set(modules)).toEqual(new Set(["FINANCES"]));
  });

  it("le parent porte la pastille ; ses sous-menus du même module n'en portent aucune", () => {
    const finances = entree("Finances");
    const badges = { FINANCES: 3 };
    expect(pastillesDesEntrees([finances], badges)).toEqual([3]);
    const enfants = finances.children ?? [];
    expect(pastillesDesEntrees(enfants, badges, modulesDeLEntree(finances))).toEqual(enfants.map(() => 0));
  });

  it("LES BONS DE COMMANDE ONT LEUR PROPRE PASTILLE — « Bon de commande à signer » ne s'affiche plus sous Finances (§118.176)", () => {
    // Le lien des notifications « à signer » mène au module à part : leur pastille est la sienne,
    // et une notification des Finances ne s'y affiche pas (deux modules, deux comptes).
    const finances = entree("Finances");
    const bc = entree("Bons de commande");
    expect(bc.module).toBe("PURCHASE_ORDERS");
    const badges = { FINANCES: 2, PURCHASE_ORDERS: 5 };
    expect(pastillesDesEntrees([finances, bc], badges)).toEqual([2, 5]);
  });

  it("un sous-menu d'un AUTRE module garde sa propre pastille — la règle n'efface rien", () => {
    // Ressources humaines : la Paie répète le module du parent (RH), le Recrutement est un module à part (Direction, 07/10).
    const rh = entree("Ressources humaines");
    const modules = rh.children?.map((c) => c.module) ?? [];
    expect(modules).toEqual(expect.arrayContaining(["RH", "RECRUITMENT"]));
    const badges = { RH: 2, RECRUITMENT: 4 };
    const pastilles = pastillesDesEntrees(rh.children ?? [], badges, modulesDeLEntree(rh));
    expect(pastilles[modules.indexOf("RECRUITMENT")]).toBe(4);
    expect(pastilles[modules.indexOf("RH")]).toBe(0);
  });

  it("entre sœurs : la première entrée du module compte, les suivantes non ; le pôle replié ne multiplie plus", () => {
    const regulatory = groupIntoPoles(NAVIGATION).find((p) => p.key === "REGULATORY");
    expect(regulatory, "le pôle Regulatory existe au catalogue").toBeTruthy();
    const modules = regulatory!.children.map((c) => c.module);
    // PRÉMISSE : au moins deux entrées sœurs du même module, sinon le cas est inerte.
    expect(modules.filter((m) => m === "REGULATORY").length).toBeGreaterThanOrEqual(2);
    const badges = { REGULATORY: 2, MEDICAL_INFO: 1 };
    const pastilles = pastillesDesEntrees(regulatory!.children, badges);
    expect(pastilles.reduce((a, n) => a + n, 0), "le total est celui des notifications, pas un multiple").toBe(3);
    expect(pastilles[modules.indexOf("REGULATORY")]).toBe(2);
  });

  it("les onglets fusionnés d'une entrée comptent avec elle, une fois", () => {
    const e = { module: "SPONSORING", tabs: [{ module: "EVENTS" }, { module: "SPONSORING" }] } as unknown as NavItem;
    expect(modulesDeLEntree(e)).toEqual(["SPONSORING", "EVENTS"]);
    expect(pastillesDesEntrees([e], { SPONSORING: 1, EVENTS: 2 })).toEqual([3]);
  });
});

describe("les deux menus lisent la même règle (points d'appel, §118.49)", () => {
  const lire = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("la barre latérale et le tiroir mobile appellent `pastillesDesEntrees` et ne lisent plus un module seul", () => {
    for (const f of ["src/components/layout/sidebar.tsx", "src/components/layout/mobile-tabbar.tsx"]) {
      const src = lire(f);
      expect(src, f).toMatch(/pastillesDesEntrees\(/);
      // Lire `moduleBadges[x]` en direct, c'est recompter le module à chaque entrée qui le porte.
      expect(src, f).not.toMatch(/moduleBadges\[/);
    }
  });

  it("les sous-menus passent ce que leur parent a COMPTÉ comme déjà compté, dans les deux menus", () => {
    for (const f of ["src/components/layout/sidebar.tsx", "src/components/layout/mobile-tabbar.tsx"]) {
      expect(lire(f), f).toMatch(/pastillesDesEntrees\(kids, moduleBadges, modulesComptes\(item, proprietaires\), proprietaires\)/);
    }
  });

  it("chaque liste passe où vivent les modules du menu (§118.157) — sans quoi un onglet reprend la pastille de son module", () => {
    for (const f of ["src/components/layout/sidebar.tsx", "src/components/layout/mobile-tabbar.tsx"]) {
      const src = lire(f);
      expect(src, f).toMatch(/modulesPropres\(items\)/);
      // Aucun appel sans le quatrième argument : chaque liste du menu doit le recevoir.
      const appels = src.match(/pastillesDesEntrees\([^;]*?\)(?=[;.])/g) ?? [];
      expect(appels.length, f).toBeGreaterThanOrEqual(3);
      for (const appel of appels) expect(appel, `${f} : ${appel}`).toMatch(/proprietaires\)$/);
    }
  });
});

describe("une notification se compte là où son module VIT (§118.157)", () => {
  const promo = entree("Promotion médicale");
  const annuaires = entree("Annuaires");

  it("PRÉMISSE : Annuaires porte des onglets de la Promotion médicale et de l'espace de travail, qui ont chacun leur entrée", () => {
    expect(modulesDeLEntree(annuaires)).toEqual(expect.arrayContaining(["DIRECTORIES", "MEDICAL", "WORKSPACE"]));
    const propres = modulesPropres(NAVIGATION);
    expect(propres.has("MEDICAL") && propres.has("WORKSPACE") && propres.has("DIRECTORIES")).toBe(true);
    expect(promo.module).toBe("MEDICAL");
  });

  it("la fiche de coaching finalisée allume la Promotion médicale, pas les Annuaires — qui gardent leur propre module", () => {
    // Sur le menu entier, Annuaires ne compte plus que son propre module…
    expect(modulesComptes(annuaires, modulesPropres(NAVIGATION))).toEqual(["DIRECTORIES"]);
    // … et dans un menu où seule la Promotion médicale porte le module MEDICAL, la notification y va.
    const proprietaires = modulesPropres([promo, annuaires]);
    expect(pastillesDesEntrees([annuaires], { MEDICAL: 1 }, [], proprietaires)).toEqual([0]);
    expect(pastillesDesEntrees([promo], { MEDICAL: 1 }, [], proprietaires)).toEqual([1]);
    expect(pastillesDesEntrees([annuaires], { DIRECTORIES: 2 }, [], proprietaires)).toEqual([2]);
  });

  it("un SOUS-MENU est aussi une maison : le module qu'il porte ne se recompte pas sur l'onglet d'une autre entrée", () => {
    // Aucune entrée du menu d'aujourd'hui n'exerce ce cas (un onglet dont le module ne vit que
    // dans un sous-menu) : le décor synthétique tient la règle pour le jour où il existera (§118.82).
    const parent = { module: "A", children: [{ module: "B" }] } as unknown as NavItem;
    const autre = { module: "C", tabs: [{ module: "B" }] } as unknown as NavItem;
    const proprietaires = modulesPropres([parent, autre]);
    expect(proprietaires.has("B")).toBe(true);
    expect(pastillesDesEntrees([autre], { B: 1 }, [], proprietaires)).toEqual([0]);
  });

  it("sans la Promotion médicale dans le menu (accès par annuaire, §118.147), l'onglet reprend la pastille — sinon elle ne s'afficherait nulle part", () => {
    expect(pastillesDesEntrees([annuaires], { MEDICAL: 1 }, [], modulesPropres([annuaires]))).toEqual([1]);
  });

  it("sur le VRAI menu entier, dessiné liste par liste comme les deux menus le font, une notification médicale s'affiche UNE fois", () => {
    const proprietaires = modulesPropres(NAVIGATION);
    const listes = [...FLAT_GROUPS.map((g) => itemsOfGroup(NAVIGATION, g)), ...groupIntoPoles(NAVIGATION).map((p) => p.children)];
    const total = (badges: Record<string, number>, prop?: Set<string>) =>
      listes.flatMap((l) => pastillesDesEntrees(l, badges, [], prop)).reduce((a, n) => a + n, 0);
    expect(total({ MEDICAL: 1 }, proprietaires)).toBe(1);
    // TÉMOIN : sans la règle, la même notification s'affichait deux fois — l'assertion peut tomber.
    expect(total({ MEDICAL: 1 })).toBe(2);
  });
});
