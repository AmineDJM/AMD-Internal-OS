import { defineConfig, devices } from "@playwright/test";

/**
 * K7 (décision 0037) — le parcours RÉEL de l'export dans l'app Adventum IA, au vrai modèle, contre `next start` déjà
 * lancé sur `amd_bench` (mode app : `APP_MODE=adventum-ia`). Deux appareils : iPhone 13 et bureau.
 *
 *   rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render
 *   APP_MODE=adventum-ia DATABASE_URL=…/amd_bench NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs" npx next start -p 3200
 *   DATABASE_URL=…/amd_bench npx playwright test -c e2e-live/k7.config.ts
 */
const chromium = { executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" };

export default defineConfig({
  testDir: ".",
  testMatch: /k7-exports\.spec\.ts$/,
  timeout: 420_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.K7_BASE_URL ?? "http://localhost:3200", trace: "retain-on-failure", acceptDownloads: true },
  projects: [
    { name: "iphone-13", use: { ...devices["iPhone 13"], browserName: "chromium", launchOptions: chromium } },
    { name: "bureau", use: { ...devices["Desktop Chrome"], launchOptions: chromium } },
  ],
});
