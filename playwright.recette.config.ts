import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * LA RECETTE UTILISATEUR (contrôle final, Super Admin 24/11/2026) — parcours par métier, dans un vrai
 * navigateur, contre un serveur de production locale que `scripts/recette/lancer.sh` démarre sur une
 * base DÉDIÉE (jamais la production : `e2e/recette/seed.ts` refuse une base non locale).
 *
 * Distincte de `playwright.config.ts` : les fichiers s'appellent `*.recette.ts` (la suite E2E habituelle
 * ne les ramasse pas), le serveur n'est PAS démarré ici (lancer.sh s'en charge — `RECETTE_URL`), et le
 * rapport n'est pas une liste de tests mais un cahier d'étapes avec captures (`e2e/recette/rapporteur.ts`).
 *
 * Un seul ouvrier, dans l'ordre des fichiers (01, 02…) : les parcours s'enchaînent sur la même base (le centre de
 * paiement décide ce que la caisse a envoyé…). PAS de mode « serial » : un parcours raté ne doit pas faire sauter
 * ceux qui suivent — une recette rend compte de TOUT. Les données d'un fichier sont donc posées de façon
 * idempotente (`donnees.ts` retrouve avant de créer) : un ouvrier relancé après un échec retrouve le même décor.
 */
const LENT = process.env.RECETTE_LENT === "1";
const SORTIE = path.resolve(process.env.RECETTE_SORTIE ?? "recette-sortie");
process.env.RECETTE_SORTIE = SORTIE;

export default defineConfig({
  testDir: "./e2e/recette",
  testMatch: "**/*.recette.ts",
  globalSetup: "./e2e/recette/seed.ts",
  outputDir: path.join(SORTIE, "playwright"),
  workers: 1,
  fullyParallel: false,
  // Contre `next dev` (RECETTE_LENT=1), chaque page se compile à sa première visite : délais ×5.
  timeout: LENT ? 900_000 : 180_000,
  expect: { timeout: LENT ? 120_000 : 15_000 },
  retries: 0,
  reporter: [["list"], ["./e2e/recette/rapporteur.ts"]],
  use: {
    baseURL: process.env.RECETTE_URL ?? "http://localhost:3200",
    locale: "fr-FR",
    timezoneId: "Africa/Algiers",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    actionTimeout: LENT ? 120_000 : 20_000,
    navigationTimeout: LENT ? 400_000 : 90_000,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" },
  },
});
