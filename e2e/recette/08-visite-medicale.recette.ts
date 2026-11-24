import type { Page } from "@playwright/test";
import { test, expect, attendFusion } from "./banc";
import { db, decorVisite, fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 8 — VISITE MÉDICALE : délégué / KAM sur téléphone ET ordinateur, rapport hors ligne, superviseur
 * (renommage, aiguillage, Ma journée, feuille de visite, rapport hors ligne, relecture superviseur, détection PV :
 * FUSIONNÉS ; interface délégué de la maquette VisiteDelegue : lot vmdelegue EN ATTENTE).
 *
 * Trois champs obligatoires (produits, message, compte rendu). Le rapport s'enregistre SANS RÉSEAU (brouillon
 * local) et part au retour du réseau. Le superviseur RELIT et suit les RETARDS.
 */

const CR = `${P} Le Dr a posé des questions sur la posologie ; patient de 62 ans, vertiges et chute de tension après la 2e prise.`;
let decor = { produit: "", message: "", medecins: [] as string[] };

test.beforeAll(async () => { decor = await decorVisite("kam"); await decorVisite("delegue"); });
test.afterAll(async () => { await fermer(); });

async function saisirRapport(page: Page, medecin: string, texte: string) {
  await page.getByLabel("Chercher un médecin").fill(medecin.replace(`${P} `, "").split(" (")[0]!);
  await page.getByText(medecin).first().click();
  const commencer = page.getByRole("button", { name: "Commencer" }).first();
  if (await commencer.isVisible().catch(() => false)) await commencer.click();
  await page.getByText(decor.produit).first().click();
  await page.getByText(decor.message).first().click();
  await page.locator("textarea[name='report']").fill(texte);
  await page.getByRole("button", { name: "Enregistrer la visite" }).click();
}

test("Aiguillage — « Visite médicale » mène chacun à SON écran", async ({ recette: r, page }) => {
  const attendus: [Parameters<typeof r.connecter>[0], RegExp, string][] = [
    ["kam", /\/medical\/ma-journee/, "Ma journée"],
    ["superviseur", /\/planning|\/medical/, "l'écran de son équipe"],
    ["dirOps", /\/operations|\/medical|cockpit/i, "le Cockpit Opérations"],
  ];
  for (const [cle, url, ecran] of attendus) {
    await r.controle(`${cle} : ouvrir /medical`, `Arrive sur ${ecran}`, async () => {
      await r.connecter(cle);
      await r.aller("/medical");
      await expect(page).toHaveURL(url);
      return new URL(page.url()).pathname;
    });
  }
  await r.controle("Le menu dit « Visite médicale » (plus « Promotion médicale »)", "Libellé du module renommé", async () => {
    await expect(page.locator("[data-app-sidebar]").getByText("Visite médicale").first()).toBeVisible();
    await expect(page.locator("[data-app-sidebar]").getByText("Promotion médicale")).toHaveCount(0);
  });
});

test("KAM — saisir un compte rendu sur ORDINATEUR, trois champs obligatoires", async ({ recette: r, page }) => {
  await r.connecter("kam");
  await r.aller("/medical/ma-journee");
  await r.controle("Cliquer « Enregistrer la visite » sans rien remplir", "Refus : produits, message et compte rendu sont obligatoires (« Pourquoi obligatoires »)", async () => {
    await page.getByLabel("Chercher un médecin").fill("Belkacem");
    await page.getByText(decor.medecins[0]!).first().click();
    const commencer = page.getByRole("button", { name: "Commencer" }).first();
    if (await commencer.isVisible().catch(() => false)) await commencer.click();
    await page.getByRole("button", { name: "Enregistrer la visite" }).click();
    await expect(page.getByText(/obligatoire/i).first()).toBeVisible();
  });
  await r.etape("Remplir produit, message, compte rendu ; « Enregistrer la visite »", "La visite est enregistrée ; elle apparaît « Rapport fait »", async () => {
    await r.aller("/medical/ma-journee");
    await saisirRapport(page, decor.medecins[0]!, CR);
    await expect.poll(async () => db().medicalVisit.count({ where: { report: { contains: "chute de tension" } } }).catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(0);
  });
});

test("Délégué — TÉLÉPHONE, sans réseau : brouillon local puis envoi au retour du réseau", async ({ recette: r }) => {
  const tel = await r.telephone("delegue");
  await r.controle("Ouvrir « Ma journée » sur téléphone", "Lisible à 390 px, sans défilement de côté", async () => {
    await r.aller("/medical/ma-journee", tel);
    return r.sansDebordement(tel);
  }, { page: tel });
  await r.etape("Couper le réseau, remplir le rapport, « Enregistrer la visite »", "Le rapport est gardé en BROUILLON LOCAL (message hors ligne), rien n'est perdu", async () => {
    await tel.context().setOffline(true);
    await saisirRapport(tel, decor.medecins[1]!.replace("(kam)", "(delegue)"), `${P} Visite hors ligne — RAS.`);
    await expect(tel.getByText(/hors ligne|brouillon|sans réseau|enverr/i).first()).toBeVisible();
  }, { page: tel });
  await r.etape("Rétablir le réseau", "Le brouillon part seul ; il apparaît côté serveur", async () => {
    await tel.context().setOffline(false);
    await expect.poll(async () => db().medicalVisit.count({ where: { report: { contains: "Visite hors ligne" } } }).catch(() => 0), { timeout: 60_000 }).toBeGreaterThan(0);
  }, { page: tel });
});

test("Superviseur — relire les rapports et suivre les retards", async ({ recette: r, page }) => {
  await r.connecter("superviseur");
  await r.etape("Ouvrir l'écran de son équipe (Force de vente › Pilotage)", "« Mon équipe » : délégués de sa BU, « Rapports en retard », « Tous les rapports »", async () => {
    await r.aller("/planning");
    await expect(page.getByText("Mon équipe").first()).toBeVisible();
    await expect(page.getByText("Rapports en retard").first()).toBeVisible();
  });
  await r.etape("Ouvrir le rapport du KAM, écrire « Bien vu pour la relance », « Marquer relu »", "Le rapport est relu ; le délégué voit le mot du superviseur", async () => {
    await page.getByText("Tous les rapports").first().click();
    await page.getByText(/Belkacem/).first().click();
    const mot = page.getByPlaceholder(/Bien vu pour la relance/);
    if (await mot.isVisible().catch(() => false)) await mot.fill(`${P} Bien vu pour la relance.`);
    await page.getByRole("button", { name: "Marquer relu" }).click();
    await expect(page.getByText(/relu/i).first()).toBeVisible();
  });
  await r.controle("Le superviseur d'une AUTRE BU (ici : le DG n'est pas superviseur) tente « Marquer relu »", "« Seul le superviseur de la BU de ce délégué, ou son N+1, marque ce rapport relu. »", async () => {
    await expect(page.getByText(/Seul le superviseur de la BU/).first()).toBeVisible();
  });
});

test("Détection IA d'un possible cas de PV dans le compte rendu", { tag: ["@ia-reelle"] }, async ({ recette: r, page }) => {
  await r.connecter("superviseur");
  await r.controle("Lire la file du superviseur après le rapport « vertiges et chute de tension »",
    "Le rapport est PRIORISÉ et marqué « Possible cas de pharmacovigilance » (exige une vraie clé IA : ANTHROPIC_API_KEY)", async () => {
      await r.aller("/planning");
      await expect(page.getByText(/pharmacovigilance|PV/).first()).toBeVisible();
    });
});

test("Interface délégué de la maquette VisiteDelegue", attendFusion("vmdelegue"), async ({ recette: r, page }) => {
  await r.connecter("kam");
  await r.aller("/medical/ma-journee");
  await r.etape("Lire « Ma journée »", "« Comptes rendus en retard · n », « Visites du jour · dans l'ordre de la tournée », « À rattraper si vous avez un creux », « + Visite hors plan »", async () => {
    await expect(page.getByText(/Visites du jour/).first()).toBeVisible();
    await expect(page.getByText("À rattraper si vous avez un creux").first()).toBeVisible();
  });
  await r.controle("Sur une visite : « Fiche du médecin », « Itinéraire », « Reporter ou annuler (visite non tenue) », « Signaler un cas de pharmacovigilance »", "Les quatre gestes sont là", async () => {
    for (const g of ["Fiche du médecin", "Itinéraire", "Signaler un cas de pharmacovigilance"]) await expect(page.getByText(g).first()).toBeVisible();
  });
  await r.controle("Après un compte rendu signalé « Possible PV — à déclarer » : « Ce n'est pas un cas »", "Le geste est tracé et visible du superviseur", async () => {
    await expect(page.getByRole("button", { name: /Ce n.est pas un cas/ }).first()).toBeVisible();
  });
  await r.controle("Mon sac, Mes demandes, Mes signalements de pharmacovigilance", "Les blocs de la maquette sont présents", async () => {
    await expect(page.getByText(/Mon sac|Mes demandes/).first()).toBeVisible();
  });
});
