import { test, expect } from "./banc";
import { COMPTES, type CleCompte } from "./comptes";

/**
 * PARCOURS 0 — CHAQUE MÉTIER SE CONNECTE, ARRIVE QUELQUE PART D'UTILE, ET NE VOIT PAS CE QUI NE LE REGARDE PAS.
 *
 * Passe d'ouverture de la recette : pour chaque compte, connexion par l'écran, page d'arrivée sans erreur, menu
 * lisible, téléphone sans débordement ; puis une matrice courte d'adresses INTERDITES (séparation des tâches).
 */

const INTERDITS: Partial<Record<CleCompte, string[]>> = {
  delegue: ["/finances/paiements-a-faire", "/centre-de-paiement", "/rh/paie", "/admin", "/finances/comptabilite"],
  kam: ["/finances/paiements-a-faire", "/admin", "/rh"],
  comptable: ["/finances/paiements-a-faire", "/admin"],
  caissier: ["/finances/paiements-a-faire", "/admin", "/rh/paie"],
  pharmacienIM: ["/finances/paiements-a-faire", "/admin"],
  dirMarketing: ["/admin", "/rh/paie"],
};

for (const cle of Object.keys(COMPTES) as CleCompte[]) {
  test(`${COMPTES[cle].metier} — connexion, arrivée, menu, téléphone`, async ({ recette: r, page }) => {
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await r.etape("Se connecter par l'écran de connexion", "Arrivée hors de /login, sans erreur à l'écran", async () => {
      await r.connecter(cle);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expect(page.getByText(/Application error|Une erreur est survenue|Internal Server Error/)).toHaveCount(0);
      return `arrivé sur ${new URL(page.url()).pathname}`;
    });
    await r.controle("Lire le menu latéral", "Le menu s'affiche et porte au moins une entrée", async () => {
      await expect(page.locator("[data-app-sidebar]").getByRole("link").first()).toBeVisible();
      return `${await page.locator("[data-app-sidebar]").getByRole("link").count()} lien(s) visibles`;
    });
    for (const url of INTERDITS[cle] ?? []) {
      await r.controle(`Ouvrir ${url} (interdit à ce métier)`, "Refus : redirection hors de la page, ou écran « accès refusé »", async () => {
        await r.aller(url);
        const refuse = !page.url().endsWith(url) || (await page.getByText(/accès|autoris|siégez|no-access/i).count()) > 0;
        expect(refuse, `${url} ne doit pas s'ouvrir`).toBe(true);
        return `arrivé sur ${new URL(page.url()).pathname}`;
      });
    }
    const tel = await r.telephone(cle);
    await r.controle("Même connexion sur téléphone (390 px)", "Page d'arrivée sans défilement de côté", async () => {
      await tel.waitForLoadState("networkidle").catch(() => undefined);
      return r.sansDebordement(tel);
    }, { page: tel });
    await r.controle("Erreurs JavaScript pendant le parcours", "Aucune", async () => {
      expect(erreurs, erreurs.join(" | ")).toHaveLength(0);
    });
  });
}
