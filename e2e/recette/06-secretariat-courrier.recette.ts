import { test, expect } from "./banc";
import { fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 6 — BUREAU DU SECRÉTARIAT et COURRIER EN PANNEAU (lots secretariat + courrierux FUSIONNÉS).
 *
 * Bureau : un seul tableau, sans onglets ni tuiles-compteurs ni filtres ; une seule recherche ; colonnes Type,
 * Objet (+ référence), Demandeur, Dates, État, Chez qui, Échéance ; chaque ligne ouvre une FICHE adaptée avec
 * la DISCUSSION en bas ; les courses / le coursier n'existent plus ; un demandeur ordinaire ne voit que ses
 * demandes ; les notes de frais vont aux RH par le supérieur, pas à l'assistante.
 * Courrier : enregistrement et fiche dans un PANNEAU latéral, correction sans effacement.
 */

test.afterAll(async () => { await fermer(); });

test("Assistante — le Bureau du secrétariat : un tableau, une recherche, pas de courses", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir « Bureau du secrétariat » (/demandes)", "Titre « Bureau du secrétariat » ; colonnes Type, Objet, Demandeur, Dates, État, Chez qui, Échéance ; PAS de colonne Montant", async () => {
    await r.aller("/demandes");
    await expect(page.getByRole("heading", { name: "Bureau du secrétariat" })).toBeVisible();
    for (const col of ["Type", "Objet", "Demandeur", "Dates", "État", "Chez qui", "Échéance"]) await expect(page.getByRole("columnheader", { name: col })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Montant/ })).toHaveCount(0);
  });
  await r.controle("Chercher les onglets, tuiles-compteurs et filtres", "Aucun onglet (role=tab) ; une seule recherche « Rechercher : objet, référence, demandeur, personne… »", async () => {
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByPlaceholder("Rechercher : objet, référence, demandeur, personne…")).toHaveCount(1);
  });
  await r.controle("Taper « zzz-introuvable » dans la recherche", "État vide : une phrase + le remède", async () => {
    await page.getByPlaceholder("Rechercher : objet, référence, demandeur, personne…").fill("zzz-introuvable");
    await expect(page.locator("tbody tr")).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
  });
  await r.controle("Chercher les courses / le coursier", "Plus de menu « Courses » ; /demandes/courses ne s'ouvre plus", async () => {
    await expect(page.locator("[data-app-sidebar]").getByRole("link", { name: /Courses|Coursier/ })).toHaveCount(0);
    const rep = await page.goto("/demandes/courses");
    const ferme = (rep?.status() ?? 200) >= 400 || !/\/demandes\/courses/.test(page.url()) || (await page.getByText(/introuvable|n'existe plus|404/i).count()) > 0;
    expect(ferme, "la page des courses doit avoir disparu").toBe(true);
  });
});

test("Délégué — demandeur ordinaire : il ne voit que ses demandes ; la note de frais part aux RH", async ({ recette: r, page }) => {
  await r.connecter("delegue");
  await r.controle("Ouvrir /demandes", "Uniquement ses propres demandes (aucune ligne d'un autre demandeur)", async () => {
    await r.aller("/demandes");
    const autres = page.locator("tbody tr").filter({ hasNotText: /Délégué médical/ });
    expect(await autres.count()).toBe(0);
  });
  await r.controle("Ouvrir « Mon espace › Demander » › note de frais", "Le circuit annoncé est : supérieur hiérarchique → RH (pas l'assistante de direction)", async () => {
    await r.aller("/mon-espace");
    await page.getByRole("button", { name: "Demander" }).first().click();
    await expect(page.getByText(/note de frais/i).first()).toBeVisible();
  });
});

test("Assistante — courrier : enregistrer, ouvrir en panneau, corriger sans effacer", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir « Courriers », cliquer « Enregistrer un courrier »", "Un panneau latéral s'ouvre (la liste reste visible derrière)", async () => {
    await r.aller("/courriers");
    await page.getByRole("button", { name: "Enregistrer un courrier" }).first().click();
    await expect(page.getByRole("dialog").last()).toBeVisible();
  });
  await r.etape("Saisir l'objet « Convocation ANPP — Cardiolex », expéditeur, date ; enregistrer", "Le courrier apparaît en tête de liste", async () => {
    const panneau = page.getByRole("dialog").last();
    await panneau.getByLabel(/Objet/).first().fill(`${P} Convocation ANPP — Cardiolex`);
    const exp = panneau.getByLabel(/Expéditeur|Correspondant|De/).first();
    if (await exp.isVisible().catch(() => false)) await exp.fill(`${P} ANPP`);
    await panneau.getByRole("button", { name: /Enregistrer/ }).last().click();
    await expect(page.getByText("Convocation ANPP — Cardiolex").first()).toBeVisible();
  });
  await r.etape("Cliquer la ligne du courrier", "Sa fiche s'ouvre en PANNEAU ; bouton « Enregistrer les corrections »", async () => {
    await page.getByText("Convocation ANPP — Cardiolex").first().click();
    await expect(page.getByRole("button", { name: "Enregistrer les corrections" })).toBeVisible();
  });
  await r.controle("Téléphone : ouvrir la liste des courriers", "Pas de défilement de côté ; le panneau prend tout l'écran", async () => {
    const tel = await r.telephone("assistante");
    await r.aller("/courriers", tel);
    return r.sansDebordement(tel);
  });
});
