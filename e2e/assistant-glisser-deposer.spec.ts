import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ASSISTANT IA — GLISSER-DÉPOSER UN DOSSIER (décision 0015, Direction 29/10/2026).
 *
 * Le parcours : des fichiers survolent la conversation → la zone de dépôt apparaît ; un DOSSIER de
 * trois fichiers est déposé (« Congrès Oran/… », parcouru récursivement, `.DS_Store` ignoré) → trois
 * puces au chemin relatif ; on en RETIRE une ; RIEN n'est parti dans le Drive ; Entrée → les deux
 * restantes sont téléversées et jointes au message ; un clic sur une pièce de la bulle ouvre l'APERÇU
 * latéral ; Échap le ferme.
 *
 * Le dépôt est simulé par un `DataTransfer` d'imitation : Chromium ne laisse pas un script fabriquer
 * des entrées de DOSSIER (`webkitGetAsEntry`) — l'imitation porte la même interface que le navigateur.
 * La réponse de l'assistant n'est pas attendue (aucun appel de modèle dans cette suite) : le tour
 * échoue faute de vraie clé, le message et ses pièces restent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Déclenche un événement de glisser sur la fenêtre, avec un dossier d'imitation. */
async function glisser(page: Page, type: "dragenter" | "drop") {
  await page.evaluate((type) => {
    const fichier = (nom: string, texte: string, mime: string) => {
      const f = new File([texte], nom, { type: mime });
      return { isFile: true, isDirectory: false, name: nom, file: (ok: (f: File) => void) => ok(f) };
    };
    const dossier = (nom: string, enfants: unknown[]) => ({
      isFile: false, isDirectory: true, name: nom,
      createReader: () => { let lu = false; return { readEntries: (ok: (e: unknown[]) => void) => { ok(lu ? [] : enfants); lu = true; } }; },
    });
    const racine = dossier("Congrès Oran", [
      fichier(".DS_Store", "x", ""),
      dossier("devis", [fichier("imprimeur.txt", "Devis imprimeur : 120 000 DZD pour 500 programmes.", "text/plain")]),
      fichier("programme.txt", "Programme du congrès d'Oran — 12 et 13 novembre.", "text/plain"),
      fichier("liste-invites.csv", "nom;ville\nDr A;Oran\nDr B;Alger\n", "text/csv"),
    ]);
    const dt = { types: ["Files"], files: [], items: [{ kind: "file", webkitGetAsEntry: () => racine }], dropEffect: "none" };
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    window.dispatchEvent(ev);
  }, type);
}

test("glisser un dossier de 3 fichiers, en retirer un, envoyer, ouvrir l'aperçu", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/assistant");
  await expect(page.getByLabel("Votre message")).toBeVisible({ timeout: 30_000 });

  // 1. Des fichiers survolent la fenêtre : la zone de dépôt apparaît.
  await glisser(page, "dragenter");
  await expect(page.getByTestId("zone-depot")).toBeVisible();
  await expect(page.getByText("Déposez vos fichiers ou dossiers")).toBeVisible();
  await page.screenshot({ path: "e2e-screenshots/assistant-depot-1-survol.png" });

  // 2. Le dossier est déposé : trois puces au chemin relatif, le fichier système ignoré et dit.
  await glisser(page, "drop");
  await expect(page.getByTestId("zone-depot")).toHaveCount(0);
  const puces = page.getByTestId("puce");
  await expect(puces).toHaveCount(3);
  await expect(page.getByText("Congrès Oran/devis/imprimeur.txt")).toBeVisible();
  await expect(page.getByTestId("avis-depot")).toContainText("1 fichier système ou caché ignoré");
  await page.screenshot({ path: "e2e-screenshots/assistant-depot-2-puces.png" });

  // 3. On en retire une (croix) ; rien n'est encore parti dans le Drive.
  const televersements: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/drive/upload")) televersements.push(r.url()); });
  await page.getByRole("button", { name: "Retirer Congrès Oran/liste-invites.csv" }).click();
  await expect(puces).toHaveCount(2);
  expect(televersements).toHaveLength(0);

  // 4. Entrée : les deux pièces partent dans le Drive, puis le message.
  await page.getByLabel("Votre message").fill("Résume ces documents du congrès.");
  await page.getByLabel("Votre message").press("Enter");
  await expect(puces).toHaveCount(0, { timeout: 30_000 });
  expect(televersements).toHaveLength(2);
  const piece = page.getByTestId("piece-message").filter({ hasText: "Congrès Oran/programme.txt" }).last();
  await expect(piece).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "e2e-screenshots/assistant-depot-3-envoye.png" });

  // 5. Un clic sur la pièce ouvre l'aperçu latéral ; Échap le ferme.
  await piece.click();
  const apercu = page.getByTestId("apercu-piece");
  await expect(apercu).toBeVisible();
  await expect(apercu.getByRole("link", { name: /Télécharger/ })).toBeVisible();
  await expect(apercu.getByRole("link", { name: /Ouvrir dans le Drive/ })).toBeVisible();
  await expect(apercu.getByText("Programme du congrès d'Oran")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "e2e-screenshots/assistant-depot-4-apercu.png" });
  await page.keyboard.press("Escape");
  await expect(apercu).toHaveCount(0);
});
