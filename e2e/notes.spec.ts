import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » (décision 0026) — l'icône bloc-notes ouvre le panneau ; on crée une page, on la nomme, on y écrit des
 * puces et des cases (raccourcis « - » et « [] », Tab pour imbriquer) ; l'assistant (FAUX MODÈLE) propose « ajoute X » :
 * la ligne apparaît SURLIGNÉE, rien n'est écrit ; on accepte, puis on annule. Captures bureau et téléphone.
 *
 * Aucun appel de modèle réel : le tour est joué par `scripts/e2e/notes.ts demander` — le vrai fil, les vrais outils,
 * un modèle scénarisé — et l'écran ne l'apprend que par ses relectures, exactement comme en vrai.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENV = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public",
  NEXTAUTH_SECRET: E2E.authSecret,
  OPENAI_API_KEY: "",
};
const notes = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/e2e/notes.ts", ...args], { encoding: "utf8", env: ENV });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

test("Mes notes : une page nommée, des puces et des cases, puis « ajoute X » proposé par l'assistant — accepté, puis annulé", async ({ page }) => {
  test.setTimeout(180_000);
  notes("vider", E2E.superAdminEmail);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/assistant");

  // 1. L'icône bloc-notes ouvre le panneau, sur la page par défaut « Mes notes ».
  await page.getByTestId("bouton-notes").click();
  const panneau = page.getByTestId("notes-panneau");
  await expect(panneau).toBeVisible({ timeout: 30_000 });
  await expect(panneau.getByTestId("notes-onglet")).toHaveText(["Mes notes"]);

  // 2. Une page neuve, nommée « Congrès d'Oran ».
  await panneau.getByRole("button", { name: "Nouvelle page" }).click();
  await panneau.getByLabel("Nom de la nouvelle page").fill("Congrès d'Oran");
  await panneau.getByLabel("Nom de la nouvelle page").press("Enter");
  await expect(panneau.getByRole("tab", { name: /Congrès d'Oran/ })).toHaveAttribute("aria-selected", "true");

  // 3. Des puces (raccourci « - »), une sous-puce (Tab), des cases (raccourci « [] »).
  const lignes = panneau.getByTestId("note-ligne");
  const champ = lignes.first().locator("textarea");
  await champ.click();
  await page.keyboard.type("- Kakémonos pour le stand");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Deux formats : 80 x 200 et 100 x 200");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Backspace"); // la puce vide redevient du texte…
  await page.keyboard.type("[] Réserver la salle de l'hôtel");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Confirmer le traiteur");
  await expect(lignes).toHaveCount(4);
  await expect(lignes.nth(0)).toHaveAttribute("data-type", "puce");
  await expect(lignes.nth(1)).toHaveAttribute("data-type", "puce");
  await expect(lignes.nth(2)).toHaveAttribute("data-type", "tache");
  await expect(lignes.nth(3)).toHaveAttribute("data-type", "tache");
  // Cocher barre la ligne.
  await lignes.nth(2).getByRole("checkbox").check();
  await expect(lignes.nth(2)).toHaveAttribute("data-fait", "true");
  await expect(panneau.getByTestId("notes-sauvegarde")).toHaveText("Enregistré", { timeout: 10_000 });
  await page.screenshot({ path: "e2e-screenshots/notes-1-page-puces-cases.png" });

  // 4. Relue après rechargement : tout a été enregistré automatiquement.
  await page.reload();
  await page.getByTestId("bouton-notes").click();
  await panneau.getByRole("tab", { name: /Congrès d'Oran/ }).click();
  await expect(lignes).toHaveCount(4, { timeout: 20_000 });
  await expect(lignes.nth(1).locator("textarea")).toHaveValue("Deux formats : 80 x 200 et 100 x 200");

  // 5. « Ajoute X » à l'assistant (faux modèle) : une PROPOSITION — surlignée dans la page, rien n'est écrit.
  const r = JSON.parse(notes("demander", E2E.superAdminEmail, "Ajoute « relancer l'agence de voyage » à ma page Congrès d'Oran", "ajouter_note",
    JSON.stringify({ page: "Congrès d'Oran", texte: "Relancer l'agence de voyage", type: "tache" }))) as { propositions: unknown[]; reponse: unknown };
  expect(r.propositions, JSON.stringify(r.reponse)).toHaveLength(1);
  const proposee = panneau.getByTestId("note-ligne-proposee");
  await expect(proposee).toContainText("Relancer l'agence de voyage", { timeout: 20_000 });
  await expect(panneau.getByTestId("note-proposition")).toHaveCount(1);
  await expect(page.getByTestId("carte-notes")).toBeVisible({ timeout: 20_000 });
  await expect(lignes).toHaveCount(4);
  await page.screenshot({ path: "e2e-screenshots/notes-2-proposition-surlignee.png" });

  // 6. Accepter : la ligne devient une vraie ligne ; « Annuler » reste possible.
  await proposee.getByRole("button", { name: "Accepter" }).click();
  await expect(lignes).toHaveCount(5, { timeout: 20_000 });
  await expect(lignes.nth(4).locator("textarea")).toHaveValue("Relancer l'agence de voyage");
  await expect(panneau.getByTestId("note-acceptee")).toHaveCount(1);
  await expect(page.getByTestId("carte-notes-ligne")).toHaveAttribute("data-etat", "ACCEPTEE", { timeout: 20_000 });
  await page.screenshot({ path: "e2e-screenshots/notes-3-acceptee.png" });

  // 7. Annuler : la ligne repart.
  await panneau.getByTestId("note-acceptee").getByRole("button", { name: "Annuler" }).click();
  await expect(lignes).toHaveCount(4, { timeout: 20_000 });
  await expect(page.getByTestId("carte-notes-ligne")).toHaveAttribute("data-etat", "ANNULEE", { timeout: 20_000 });

  // 8. Refuser une seconde proposition : rien n'est écrit.
  notes("demander", E2E.superAdminEmail, "Supprime la ligne du traiteur", "supprimer_note", JSON.stringify({ page: "Congrès d'Oran", ligne: "traiteur" }));
  await expect(panneau.getByTestId("note-proposition")).toHaveCount(1, { timeout: 20_000 });
  await panneau.getByTestId("note-proposition").getByRole("button", { name: "Refuser" }).click();
  await expect(panneau.getByTestId("note-proposition")).toHaveCount(0, { timeout: 20_000 });
  await expect(lignes).toHaveCount(4);
  await expect(lignes.nth(3).locator("textarea")).toHaveValue("Confirmer le traiteur");

  // 9. Téléphone : le panneau est plein écran.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panneau).toBeVisible();
  await page.screenshot({ path: "e2e-screenshots/notes-4-telephone.png" });
  notes("vider", E2E.superAdminEmail);
});
