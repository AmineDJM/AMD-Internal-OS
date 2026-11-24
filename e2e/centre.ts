import { expect, type Locator, type Page } from "@playwright/test";
import { cliquerDecisif } from "./decisif";

/**
 * LE CENTRE DE PAIEMENT PAR SES ÉCRANS (maquette du 24/11/2026) — la file « À décider » à gauche, la fiche de
 * décision à droite. Une ligne de la file est un bouton qui ouvre sa fiche ; « Autoriser le paiement » est un bouton
 * DÉCISIF de la fiche (deux clics).
 */

/** La ligne de la file qui porte ce texte. */
export function ligneDuCentre(page: Page, texte: string | RegExp): Locator {
  return page.locator("section[aria-labelledby='file-centre'] li").filter({ hasText: texte }).first();
}

/** La fiche de décision ouverte. */
export function ficheDuCentre(page: Page): Locator {
  return page.locator("section[aria-labelledby='fiche-centre']");
}

/** Ouvre la fiche de l'ordre (la ligne doit être dans la file). */
export async function ouvrirAuCentre(page: Page, texte: string | RegExp): Promise<Locator> {
  const ligne = ligneDuCentre(page, texte);
  await expect(ligne, "l'ordre attend dans la file « À décider »").toBeVisible({ timeout: 20_000 });
  const bouton = ligne.getByRole("button").first();
  await bouton.click();
  await expect(bouton, "la ligne touchée est celle de la fiche ouverte").toHaveAttribute("aria-current", "true");
  const fiche = ficheDuCentre(page);
  await expect(fiche).toBeVisible();
  return fiche;
}

/** Ouvre la fiche et autorise (deux clics sur le bouton décisif). */
export async function autoriserAuCentre(page: Page, texte: string | RegExp): Promise<Locator> {
  const fiche = await ouvrirAuCentre(page, texte);
  await cliquerDecisif(fiche.getByRole("button", { name: "Autoriser le paiement" }));
  return fiche;
}
