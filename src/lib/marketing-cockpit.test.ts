import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAVIGATION, MARKETING_COCKPIT_TABS, ANNUAIRES_TABS, MODULE_LABELS } from "@/lib/labels";
import { MODULES, PERMISSIONS } from "@/lib/rbac";
import { DEFAULT_APP_SETTINGS } from "@/lib/settings";

const lire = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Marketing cockpit (Direction, 07/10 — maquette validée) : une page, cinq vues par `?vue=` ; les Spécialités sont
 * parties dans les Annuaires ; la Direction Marketing écrit ses messages par défaut ; le marché reste à qui l'a déjà.
 */
describe("Marketing cockpit", () => {
  const entree = NAVIGATION.find((n) => n.label === "Marketing cockpit");

  it("est une entrée du pôle Sales & Marketing qui mène à la vue d'ensemble — la page rend elle-même ses vues", () => {
    expect(entree?.pole).toBe("MARKETING");
    expect(entree?.href).toBe("/marketing-cockpit");
    expect(entree?.match).toContain("/marketing-cockpit");
    // L'onglet actif est un paramètre (`?vue=`), pas un chemin : la barre du menu ne saurait pas l'allumer.
    expect(entree?.tabs).toBeUndefined();
    expect(MARKETING_COCKPIT_TABS.map((t) => t.label)).toEqual(["Vue d'ensemble", "Leaders d'opinion", "Messages", "Marché", "Investissements"]);
    expect(existsSync(join(process.cwd(), "src/app/(app)/marketing-cockpit/page.tsx"))).toBe(true);
    for (const t of MARKETING_COCKPIT_TABS.slice(1)) expect(t.href, t.label).toMatch(/^\/marketing-cockpit\?vue=[a-z]+$/);
  });

  it("est un MODULE À PART, réglable dans la console ; le marché et l'argent ont leur règle", () => {
    expect((MODULES as readonly string[]).includes("MARKETING_COCKPIT")).toBe(true);
    expect(MODULE_LABELS.MARKETING_COCKPIT).toBe("Marketing cockpit");
    expect(entree?.module).toBe("MARKETING_COCKPIT");
    for (const t of MARKETING_COCKPIT_TABS) expect(t.module, t.label).toBe("MARKETING_COCKPIT");
    expect(MARKETING_COCKPIT_TABS.find((t) => t.label === "Marché")?.regle).toBe("marche-cockpit");
    expect(MARKETING_COCKPIT_TABS.find((t) => t.label === "Investissements")?.regle).toBe("argent-cockpit");
  });

  it("par défaut, les mêmes personnes qu'hier ; la Direction Marketing y écrit en plus ses messages", () => {
    for (const [role, matrice] of Object.entries(PERMISSIONS)) {
      if (role === "SUPER_ADMIN" || role === "PRODUCT_MANAGER" || role === "OPERATIONS_DIRECTOR" || !matrice.SALES_PLANNING) continue;
      expect(matrice.MARKETING_COCKPIT, role).toEqual(matrice.SALES_PLANNING);
    }
    // LE DIRECTEUR DES OPÉRATIONS GÈRE la Force de vente depuis le 08/10 ; le cockpit marketing, lui, lui reste en
    // LECTURE — ce qu'il avait la veille. La gestion de la force de vente ne lui donne pas la parole marketing.
    expect(PERMISSIONS.OPERATIONS_DIRECTOR.MARKETING_COCKPIT).toEqual(["VIEW", "EXPORT"]);
    expect(PERMISSIONS.PRODUCT_MANAGER.MARKETING_COCKPIT).toEqual(expect.arrayContaining(["VIEW", "CREATE", "UPDATE", "DELETE"]));
    expect(PERMISSIONS.PRODUCT_MANAGER.SALES_PLANNING, "rien de plus sur la Force de vente").toEqual(["VIEW", "EXPORT"]);
    expect(DEFAULT_APP_SETTINGS.promoMessageAuthorRoles).toContain("PRODUCT_MANAGER");
    expect(lire("prisma/schema.prisma")).toMatch(/promoMessageAuthorRoles\s+String\[\]\s+@default\(\["PRODUCT_MANAGER"\]\)/);
  });

  it("le marché ne s'élargit pas : la règle est la porte VIVANTE des mêmes données — l'Explorateur produits (24/11/2026)", () => {
    // Business Development est RETIRÉ du service : sa porte répondait non à tout le monde, Super Admin compris, et l'onglet
    // était mort. L'Explorateur produits lit les mêmes fichiers (`lib/market/data`) : c'est lui qui gouverne ces données.
    const acces = lire("src/lib/marketing-cockpit/acces.ts");
    expect(acces).toContain('userCan(user, "PRODUCT_EXPLORER", "VIEW")');
    expect(acces).not.toContain('"BUSINESS_DEVELOPMENT"');
    expect(lire("src/app/(app)/explorateur-produits/page.tsx")).toContain('requireModule("PRODUCT_EXPLORER")');
    expect(lire("src/lib/marketing-cockpit/marche.ts")).toContain('from "@/lib/market/data"');
    // La Direction Marketing n'a pas le marché par défaut : elle ne voit ni l'onglet ni la tuile.
    expect(PERMISSIONS.PRODUCT_MANAGER.PRODUCT_EXPLORER).toBeUndefined();
    // Le Super Admin, si : l'onglet n'est plus mort pour lui.
    expect(PERMISSIONS.SUPER_ADMIN.PRODUCT_EXPLORER).toContain("VIEW");
  });

  it("la page garde sa porte, et les anciennes adresses mènent aux nouvelles", () => {
    expect(lire("src/app/(app)/marketing-cockpit/page.tsx")).toContain('requireModule("MARKETING_COCKPIT")');
    expect(lire("src/app/(app)/marketing-cockpit/messages/page.tsx")).toContain("/marketing-cockpit?");
    expect(lire("src/app/(app)/planning/messages/page.tsx")).toContain('redirect("/marketing-cockpit?vue=messages")');
    expect(lire("src/app/(app)/marketing-cockpit/specialites/page.tsx")).toContain('redirect("/annuaires/specialites")');
    expect(lire("src/app/(app)/planning/specialites/page.tsx")).toContain('redirect("/annuaires/specialites")');
  });

  it("les Spécialités sont un onglet des Annuaires, gardé par la règle du référentiel", () => {
    const tab = ANNUAIRES_TABS.find((t) => t.href === "/annuaires/specialites");
    expect(tab?.regle).toBe("specialites");
    const page = lire("src/app/(app)/annuaires/specialites/page.tsx");
    expect(page).toContain('peutGererSpecialites(user, "VIEW")');
    expect(page).toContain("<EcranSpecialites user={user} />");
  });

  it("un message déjà porté s'archive au lieu d'être effacé (la cascade emporterait son historique)", () => {
    const src = lire("src/lib/actions/promo-message-actions.ts");
    expect(src).toContain("retraitDuMessage(");
    expect(src).toMatch(/update\(\{ where: \{ id \}, data: \{ isActive: false \} \}\)/);
  });

  it("Force de vente ne porte plus ces onglets", () => {
    const hrefs = NAVIGATION.flatMap((n) => (n.tabs ?? []).map((t) => t.href));
    expect(hrefs).not.toContain("/planning/messages");
    expect(hrefs).not.toContain("/planning/specialites");
  });
});
