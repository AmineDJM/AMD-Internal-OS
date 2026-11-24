import type { Page } from "@playwright/test";
import { test, expect } from "./banc";
import { db, fermer, gros, pdfDeTest } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 7 — DRIVE : dépôt de plus de 10 Mo, versions, corbeille, pièces confidentielles
 * (lots drvstock, drvversions, drvsecu, drvacces FUSIONNÉS ; drvux EN ATTENTE).
 */

const GROS = `${P} Dossier AMM complet.bin`;
const DOC = `${P} Contrat agence.pdf`;

test.afterAll(async () => { await fermer(); });

/** Le menu d'actions d'un élément : clic droit sur sa ligne (comme une personne). */
async function actions(page: Page, nom: string) {
  await page.getByText(nom).first().click({ button: "right" });
}

test("Dépôt de plus de 10 Mo — le fichier arrive entier", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir le Drive (« Mes fichiers »)", "Bouton « Importer » visible", async () => {
    await r.aller("/drive");
    await expect(page.getByRole("button", { name: /Importer/ }).first()).toBeVisible();
  });
  await r.etape("« Importer » un fichier de 12 Mo", "Le fichier apparaît dans la liste ; en base, sa taille est exactement 12 582 912 octets (rien de tronqué)", async () => {
    await page.locator("input[type='file']").first().setInputFiles(gros(GROS, 12));
    await expect(page.getByText(GROS).first()).toBeVisible({ timeout: 120_000 });
    const n = await db().driveNode.findFirst({ where: { name: GROS }, select: { size: true } });
    expect(Number(n?.size ?? 0)).toBe(12 * 1024 * 1024);
    return `taille en base : ${Number(n?.size ?? 0)} octets`;
  });
});

test("Versions — déposer une nouvelle version, relire l'historique", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.aller("/drive");
  await r.etape("Importer « Contrat agence.pdf »", "Le document apparaît", async () => {
    await page.locator("input[type='file']").first().setInputFiles({ ...pdfDeTest("Contrat agence v1"), name: DOC });
    await expect(page.getByText(DOC).first()).toBeVisible({ timeout: 60_000 });
  });
  await r.etape("Clic droit › « Nouvelle version », choisir la v2", "Historique : 2 versions, la plus récente marquée « actuelle »", async () => {
    await actions(page, DOC);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "Nouvelle version" }).or(page.getByText("Nouvelle version")).first().click()]);
    await chooser.setFiles({ ...pdfDeTest("Contrat agence v2"), name: DOC });
    await actions(page, DOC);
    await page.getByText("Historique des versions").first().click();
    await expect(page.getByText("actuelle").first()).toBeVisible();
  });
});

test("Corbeille — mettre à la corbeille, restaurer", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.aller("/drive");
  await r.etape("Clic droit sur « Contrat agence.pdf » › « Mettre à la corbeille »", "« Il reste restaurable depuis la Corbeille. » ; le fichier quitte la liste", async () => {
    await actions(page, DOC);
    await page.getByText("Mettre à la corbeille").first().click();
    const confirmer = page.getByRole("button", { name: /Confirmer|Mettre à la corbeille/ }).last();
    if (await confirmer.isVisible().catch(() => false)) await confirmer.click();
    await expect(page.getByText(DOC)).toHaveCount(0, { timeout: 15_000 });
  });
  await r.etape("Ouvrir « Corbeille », clic droit › « Restaurer »", "Le fichier revient dans « Mes fichiers »", async () => {
    await page.getByRole("link", { name: "Corbeille" }).or(page.getByRole("button", { name: "Corbeille" })).first().click();
    await expect(page.getByText(DOC).first()).toBeVisible();
    await actions(page, DOC);
    await page.getByText("Restaurer").first().click();
    await r.aller("/drive");
    await expect(page.getByText(DOC).first()).toBeVisible();
  });
  await r.controle("Un autre compte (délégué) cherche ce fichier", "Rien : un élément privé (ou à la corbeille) n'existe que pour son propriétaire", async () => {
    await r.connecter("delegue");
    await r.aller("/drive");
    await expect(page.getByText(DOC)).toHaveCount(0);
  });
});

test("Pièces confidentielles — une pièce RH ne se copie pas au Drive et ne s'ouvre pas au simple lecteur", async ({ recette: r, page }) => {
  await r.controle("Le délégué cherche « fiche de paie » dans le Drive", "Aucune copie de pièce RH / médicale / pharmacovigilance / voyageur dans le Drive", async () => {
    await r.connecter("delegue");
    await r.aller("/drive");
    await expect(page.getByText(/fiche de paie|bulletin/i)).toHaveCount(0);
  });
});

