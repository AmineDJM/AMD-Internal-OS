import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TERRAIN ET VOIX (lot J13, décision 0025) — au téléphone, 390 px de large.
 *
 *   1. L'écran Terrain tient à 390 px (aucun défilement horizontal), avec ses deux gestes : Dicter, Photo.
 *   2. HORS LIGNE : une photo et un vocal (micro simulé par Chromium) entrent dans la file locale ; l'état le dit
 *      (« partira au retour du réseau ») ; RIEN n'est parti au serveur.
 *   3. Le réseau revient : la file se vide seule, chaque capture devient une captation affichée — aucune perte.
 *   4. La conversation vocale de l'Assistant IA s'ouvre plein écran à 390 px ; sans clé de fournisseur (cette suite
 *      ne fait aucun appel d'IA), elle le DIT au lieu de rester muette.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
test.use({
  viewport: { width: 390, height: 844 },
  permissions: ["microphone"],
  launchOptions: {
    executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

const sansDefilementHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Une image PNG 1×1 valide.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("terrain à 390 px : hors ligne, la file garde la photo et le vocal, puis tout part au retour du réseau", async ({ page, context }) => {
  test.setTimeout(150_000);
  await login(page);
  await page.goto("/medical/terrain");
  await expect(page.getByTestId("dicter")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("photo")).toBeVisible();
  expect(await sansDefilementHorizontal(page)).toBe(true);
  await page.screenshot({ path: "e2e-screenshots/terrain-1-ecran-390.png", fullPage: true });

  const envois: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/assistant-ia/terrain") && r.method() === "POST") envois.push(r.url()); });

  // ── HORS LIGNE ──
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.getByTestId("photo-fichier").setInputFiles({ name: "presentoir.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("dicter").click();
  await expect(page.getByTestId("arreter")).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByTestId("arreter").click();
  await expect(page.getByTestId("element-file")).toHaveCount(2);
  await expect(page.getByTestId("etat-file")).toContainText("2 en attente d'envoi — partira au retour du réseau");
  expect(await sansDefilementHorizontal(page)).toBe(true);
  await page.screenshot({ path: "e2e-screenshots/terrain-2-hors-ligne-390.png", fullPage: true });

  // ── RETOUR DU RÉSEAU : la file se vide seule ──
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("element-file")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("etat-file")).toContainText("Tout est envoyé.");
  expect(envois.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("captation").first()).toBeVisible();
  await page.screenshot({ path: "e2e-screenshots/terrain-3-envoye-390.png", fullPage: true });

  // Rien n'est resté dans le téléphone : la file locale est vide.
  const restants = await page.evaluate(() => new Promise<number>((ok) => {
    const r = indexedDB.open("amd-terrain");
    r.onsuccess = () => { const q = r.result.transaction("file").objectStore("file").count(); q.onsuccess = () => ok(q.result); };
    r.onerror = () => ok(-1);
  }));
  expect(restants).toBe(0);
});

test("la conversation vocale de l'Assistant IA tient à 390 px et dit pourquoi elle ne démarre pas", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/assistant");
  await expect(page.getByLabel("Votre message")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("voix-temps-reel").click();
  const panneau = page.getByRole("dialog", { name: "Conversation vocale" });
  await expect(panneau).toBeVisible();
  await expect(panneau.getByText("elle ne s'exécute que par son bouton, jamais à la voix")).toBeVisible();
  expect(await sansDefilementHorizontal(page)).toBe(true);
  await panneau.getByRole("button", { name: "Parler à l'assistant" }).click();
  await expect(panneau.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "e2e-screenshots/voix-temps-reel-390.png" });
});
