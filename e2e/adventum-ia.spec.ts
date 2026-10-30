import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADVENTUM IA — L'APP (décision 0027), au bureau (1440 px) et sur iPhone (390 px).
 *
 * Créer une conversation (elle rejoint la liste avec son titre), une conversation PRIVÉE (verrouillée dès le premier
 * message), un DOSSIER (nom, consignes, conversation dedans), un MESSAGE VOCAL enregistré (micro simulé par Chromium :
 * appui bref → verrouillé, « ■ » → réécoute, « Envoyer » → la bulle vocale), le panneau NOTES. Aucune réponse de
 * l'assistant n'est attendue (aucun appel de modèle dans cette suite : le tour échoue faute de vraie clé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
test.use({
  permissions: ["microphone"],
  launchOptions: {
    executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

const NOM_DOSSIER = `Congrès e2e ${Date.now().toString(36)}`;

for (const ecran of [{ nom: "bureau", largeur: 1440, hauteur: 900 }, { nom: "iphone", largeur: 390, hauteur: 844 }] as const) {
  test(`Adventum IA (${ecran.nom}) — conversation, privée, dossier, vocal, notes`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: ecran.largeur, height: ecran.hauteur });
    const telephone = ecran.largeur < 1024;
    await login(page);
    await page.goto("/ia");
    await expect(page.getByTestId("accueil")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/par quoi on commence/)).toBeVisible();
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-1-accueil.png` });

    const ouvrirListe = async () => {
      if (telephone) await page.getByRole("button", { name: "Ouvrir la liste des conversations" }).click();
    };
    const fermerListe = async () => {
      if (telephone) await page.getByRole("button", { name: "Fermer la liste" }).first().click();
    };

    // 1. CRÉER une conversation : le premier message la crée ; elle rejoint la liste sous son titre provisoire.
    const sujet = `Budget congrès d'Oran ${ecran.nom}`;
    await page.getByLabel("Votre message").fill(sujet);
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(page.getByTestId("fil").getByText(sujet)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/ia\?c=/);
    await ouvrirListe();
    await expect(page.getByTestId("conversation").filter({ hasText: sujet })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-2-conversation.png` });

    // 2. PRIVÉE : choisie avant le premier message, verrouillée après.
    await page.getByTestId("nouvelle-conversation").click();
    await page.getByTestId("bouton-prive").click();
    await expect(page.getByTestId("badge-prive")).toBeVisible();
    await expect(page.getByText(/n'utilise pas votre mémoire et ne retient rien/)).toBeVisible();
    await page.getByLabel("Votre message").fill("Question privée e2e");
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(page.getByTestId("fil").getByText("Question privée e2e")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("bouton-prive")).toBeDisabled();
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-3-privee.png` });

    // 3. DOSSIER : créé, consignes enregistrées, une conversation ouverte dedans.
    await ouvrirListe();
    await page.getByRole("button", { name: "Nouveau dossier" }).click();
    await page.getByLabel("Nom du dossier").fill(NOM_DOSSIER + ecran.nom);
    await page.getByRole("button", { name: "Créer le dossier" }).click();
    await page.getByLabel("Consignes du dossier").fill("Réponds en tableau, montants en DZD.");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Consignes enregistrées.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-4-dossier.png` });
    await page.getByRole("button", { name: "Nouvelle conversation dans ce dossier" }).click();
    await fermerListe().catch(() => undefined);
    await expect(page.getByText(`Dans le dossier « ${NOM_DOSSIER + ecran.nom} »`)).toBeVisible();

    // 4. MESSAGE VOCAL : appui bref → enregistrement verrouillé ; « ■ » → réécoute ; « Envoyer » → la bulle vocale.
    await page.getByRole("button", { name: /Message vocal/ }).click();
    await expect(page.getByRole("button", { name: "Arrêter pour réécouter" })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_600);
    await page.getByRole("button", { name: "Arrêter pour réécouter" }).click();
    await expect(page.getByTestId("vocal-relecture")).toBeVisible();
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-5-vocal-relecture.png` });
    await page.getByTestId("vocal-relecture").getByRole("button", { name: "Envoyer le vocal" }).click();
    await expect(page.getByTestId("bulle-vocale").first()).toBeVisible({ timeout: 20_000 });

    // 5. LE PANNEAU NOTES (tiroir Notes / Travaux / Documents).
    await page.getByRole("button", { name: "Notes, travaux et documents" }).click();
    await expect(page.getByTestId("panneau-notes")).toBeVisible();
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-6-notes.png` });
    await page.getByRole("tab", { name: "Travaux" }).click();
    await expect(page.getByText("Ces travaux tournent sur le serveur, même app fermée.")).toBeVisible();
    await page.getByRole("button", { name: "Fermer le panneau" }).click();

    // 6. RETROUVER : la recherche porte sur les titres et le contenu.
    await ouvrirListe();
    await page.getByPlaceholder("Rechercher dans les conversations").fill(sujet.slice(0, 20));
    await expect(page.getByTestId("conversation").filter({ hasText: sujet })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `e2e-screenshots/adventum-ia-${ecran.nom}-7-recherche.png` });
  });
}

test("l'écran /assistant de l'ERP a les mêmes conversations", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/assistant");
  await expect(page.getByLabel("Votre message")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
  await expect(page.getByTestId("conversation").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "e2e-screenshots/adventum-ia-erp-assistant.png" });
});
