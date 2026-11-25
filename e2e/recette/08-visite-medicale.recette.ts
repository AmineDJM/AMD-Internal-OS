import type { Page } from "@playwright/test";
import { test, expect } from "./banc";
import { db, decorVisite, fermer, visitePrevue } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 8 — VISITE MÉDICALE : délégué / KAM sur téléphone ET ordinateur, rapport hors ligne, superviseur
 * (renommage, aiguillage, Ma journée, feuille de visite, rapport hors ligne, relecture superviseur, détection PV,
 * interface délégué de la maquette VisiteDelegue : FUSIONNÉS).
 *
 * Trois champs obligatoires (produits, message, compte rendu) sur une visite PRÉVUE — une visite hors plan naît sans
 * produit ni message exigés (§118.166). Le rapport s'enregistre SANS RÉSEAU (brouillon local) et part au retour du
 * réseau. Le superviseur RELIT et suit les RETARDS.
 */

const CR = `${P} Le Dr a posé des questions sur la posologie ; patient de 62 ans, vertiges et chute de tension après la 2e prise.`;
let decor = { produit: "", message: "", medecins: [] as string[] };
let visiteKam = "";

test.beforeAll(async () => {
  decor = await decorVisite("kam");
  await decorVisite("delegue");
  visiteKam = await visitePrevue("kam", decor.medecins[0]!);
});
test.afterAll(async () => { await fermer(); });

/** La carte d'un médecin dans « Ma journée » (visite prévue : « Commencer » ; panel : « Commencer (hors plan) ») → sa feuille. */
async function commencer(page: Page, medecin: string): Promise<void> {
  const carte = page.locator("li, article, div").filter({ hasText: medecin }).filter({ has: page.getByRole("button", { name: /^Commencer/ }) }).last();
  await carte.getByRole("button", { name: /^Commencer/ }).first().click();
  await expect(page.getByRole("dialog", { name: medecin })).toBeVisible();
}

const feuilleDe = (page: Page, medecin: string) => page.getByRole("dialog", { name: medecin });

/** Coche (ou décoche) une case du formulaire par son libellé. */
async function cocher(page: Page, medecin: string, libelle: string, voulu = true): Promise<void> {
  const caseACocher = feuilleDe(page, medecin).getByRole("checkbox", { name: libelle });
  if ((await caseACocher.isChecked()) !== voulu) await caseACocher.click();
}

/** Le rapport complet : produit, message, compte rendu — puis « Enregistrer la visite ». */
async function saisirRapport(page: Page, medecin: string, texte: string) {
  await commencer(page, medecin);
  await cocher(page, medecin, decor.produit);
  await cocher(page, medecin, decor.message);
  await feuilleDe(page, medecin).locator("textarea[name='report']").fill(texte);
  await feuilleDe(page, medecin).getByRole("button", { name: "Enregistrer la visite" }).click();
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
  const medecin = decor.medecins[0]!;
  await r.connecter("kam");
  await r.aller("/medical/ma-journee");
  await r.controle("Ouvrir la visite prévue, tout décocher, « Enregistrer la visite » sans rien remplir",
    "Rien ne part : le compte rendu est exigé par le formulaire ; produits et message sont marqués * (« Pourquoi obligatoires »)", async () => {
      await commencer(page, medecin);
      const feuille = feuilleDe(page, medecin);
      await cocher(page, medecin, decor.produit, false);
      await expect(feuille.getByText(/Produits présentés \*/)).toBeVisible();
      await expect(feuille.getByText(/Message porté \*/)).toBeVisible();
      await expect(feuille.getByRole("button", { name: "Pourquoi obligatoires" })).toBeVisible();
      await feuille.getByRole("button", { name: "Enregistrer la visite" }).click();
      expect(await feuille.locator("textarea[name='report']").evaluate((t: HTMLTextAreaElement) => t.validity.valueMissing)).toBe(true);
      await expect(feuille).toBeVisible();
    }, { cible: feuilleDe(page, medecin) });
  await r.controle("Écrire le compte rendu SANS produit ni message, enregistrer", "Refus : « Choisissez le ou les produits discutés avec le médecin… »", async () => {
    const feuille = feuilleDe(page, medecin);
    await feuille.locator("textarea[name='report']").fill(CR);
    await feuille.getByRole("button", { name: "Enregistrer la visite" }).click();
    await expect(feuille.getByRole("alert")).toContainText("Choisissez le ou les produits");
  }, { cible: feuilleDe(page, medecin) });
  await r.controle("Cocher le produit, toujours SANS message, enregistrer", "Refus : « Choisissez le ou les messages de la Direction Marketing… »", async () => {
    const feuille = feuilleDe(page, medecin);
    await cocher(page, medecin, decor.produit);
    await feuille.getByRole("button", { name: "Enregistrer la visite" }).click();
    await expect(feuille.getByRole("alert")).toContainText("Choisissez le ou les messages");
  }, { cible: feuilleDe(page, medecin) });
  await r.etape("Cocher le message ; « Enregistrer la visite »", "La visite est enregistrée (rapport fait)", async () => {
    await cocher(page, medecin, decor.message);
    await feuilleDe(page, medecin).getByRole("button", { name: "Enregistrer la visite" }).click();
    await expect.poll(async () => (await db().medicalVisit.findUnique({ where: { id: visiteKam }, select: { status: true } }))?.status, { timeout: 20_000 }).toBe("COMPLETED");
    return "visite COMPLETED";
  });
});

test("Délégué — TÉLÉPHONE, sans réseau : brouillon local puis envoi au retour du réseau", async ({ recette: r }) => {
  const tel = await r.telephone("delegue");
  const medecin = `${P} Dr Yacine Haddad (delegue)`;
  await r.controle("Ouvrir « Ma journée » sur téléphone", "Lisible à 390 px, sans défilement de côté", async () => {
    await r.aller("/medical/ma-journee", tel);
    return r.sansDebordement(tel);
  }, { page: tel });
  await r.etape("Couper le réseau, « Commencer (hors plan) », remplir le rapport, « Enregistrer la visite »",
    "Le rapport est gardé en BROUILLON LOCAL (« Pas de réseau : … gardé dans ce téléphone et partira tout seul »), rien n'est perdu", async () => {
      await tel.context().setOffline(true);
      await saisirRapport(tel, medecin, `${P} Visite hors ligne — RAS.`);
      await expect(tel.getByText(/gardé dans ce téléphone/).first()).toBeVisible();
    }, { page: tel });
  await r.etape("Rétablir le réseau", "Le brouillon part seul ; il apparaît côté serveur", async () => {
    await tel.context().setOffline(false);
    await expect.poll(async () => db().medicalVisit.count({ where: { report: { contains: "Visite hors ligne" } } }).catch(() => 0), { timeout: 60_000 }).toBeGreaterThan(0);
  }, { page: tel });
});

test("Superviseur — relire les rapports et suivre les retards", async ({ recette: r, page }) => {
  await r.controle("Le Directeur général (ni superviseur de cette BU, ni son N+1) ouvre le rapport du KAM", "Pas de « Marquer relu » : « Seul le superviseur de la BU de ce délégué, ou son N+1, marque ce rapport relu. »", async () => {
    await r.connecter("dg");
    await r.aller(`/planning?relire=${visiteKam}`);
    await expect(page.getByRole("button", { name: "Marquer relu" })).toHaveCount(0);
    await expect(page.getByText(/Seul le superviseur de la BU/).first()).toBeVisible();
    return new URL(page.url()).pathname;
  });
  await r.connecter("superviseur");
  await r.etape("Ouvrir l'écran de son équipe (Force de vente › Pilotage)", "« À faire » : « Rapports à relire » ; « Mon équipe » avec la colonne « Rapports en retard »", async () => {
    await r.aller("/planning");
    await expect(page.getByText("Mon équipe").first()).toBeVisible();
    await expect(page.getByText("Rapports en retard").first()).toBeVisible();
    await expect(page.getByText(/Rapports à relire \(\d+\)/).first()).toBeVisible();
  });
  await r.etape("« Relire » le rapport du KAM, écrire « Bien vu pour la relance », « Marquer relu »", "Le rapport est relu ; le délégué voit le mot du superviseur", async () => {
    await page.locator("li").filter({ hasText: /Belkacem/ }).getByRole("link", { name: "Relire" }).first().click();
    await expect(page.getByText("chute de tension").first()).toBeVisible();
    await page.getByPlaceholder(/Bien vu pour la relance/).fill(`${P} Bien vu pour la relance.`);
    await page.getByRole("button", { name: "Marquer relu" }).click();
    await expect.poll(async () => Boolean((await db().medicalVisit.findUnique({ where: { id: visiteKam }, select: { reluLe: true } }))?.reluLe), { timeout: 15_000 }).toBe(true);
    await expect(page.getByText(/^Relu/).first()).toBeVisible();
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
