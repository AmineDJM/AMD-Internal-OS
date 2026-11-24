import { defineConfig, devices } from "@playwright/test";
import { createHash } from "node:crypto";
import { E2E } from "./e2e/global-setup";

/**
 * E2E PLAYWRIGHT — parcours RÉELS contre le build de production (`next start` sur `.next`),
 * SANS APPEL IA DE LEUR FAIT (la page d'arrivée du Super Admin en tente un : voir plus bas) : les specs couvrent l'authentification et le circuit d'invitation de
 * compte (page publique, usage unique) — des flux entièrement déterministes. La logique du
 * Chief (résolution, portes, confirmations) est verrouillée par la suite vitest (goldens) ;
 * l'E2E vérifie que les ÉCRANS tiennent debout de bout en bout.
 *
 * Lancement local : `npm run build && npm run test:e2e` (Postgres local démarré).
 * Le seed (utilisateur + invitations, préfixe __e2e__) est posé par `e2e/global-setup.ts`
 * et nettoyé à la fin — jamais de données simulées persistantes.
 */

const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  // Chromium PRÉINSTALLÉ de l'environnement (/opt/pw-browsers) : on pointe l'exécutable
  // directement — jamais de `playwright install` (téléchargement bloqué/inutile).
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" },
    },
  }],
  webServer: {
    command: "npx next start -p 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      DATABASE_URL: DB_URL,
      // ── LE KILL SWITCH SORTANT (`src/lib/sortie/garde.ts`) ──────────────────────────
      // Le banc pilote un VRAI serveur : tout y est vrai sauf l'intention. C'est exactement le
      // cas où un envoi part pour de bon. Le serveur est donc démarré avec les sorties
      // INTERDITES — la porte refuse AVANT d'ouvrir un transport, quel que soit l'adaptateur.
      // Sans cette ligne, `PLAYWRIGHT` ne franchit pas la frontière de processus et le serveur
      // se croirait en production : la garde ne verrait rien.
      ADAM_SORTIE_INTERDITE: "1",
      NEXTAUTH_URL: "http://localhost:3100",
      // MÊME source que le seed (`E2E.authSecret`) : la clé de chiffrement des blobs Drive en
      // est dérivée, et deux valeurs différentes rendent les fichiers du seed illisibles.
      NEXTAUTH_SECRET: E2E.authSecret,
      // `next start` tourne en PRODUCTION, où DRIVE_ENCRYPTION_KEY est obligatoire (audit Drive du 24/11, A2). Elle vaut
      // la clé que le seed (hors production) dérive de ce même secret : les fichiers du seed restent lisibles.
      DRIVE_ENCRYPTION_KEY: process.env.DRIVE_ENCRYPTION_KEY ?? createHash("sha256").update(E2E.authSecret).digest("hex"),
      // LA PLANCHE DE RENDU, le temps d'une revue. Les blocs de l'espace de travail n'existent
      // qu'au bout d'un vrai tour de conversation — donc d'un appel IA, que cette suite
      // s'interdit. Cette variable ouvre une route de démonstration qui, sans elle, rend 404 :
      // en production, elle n'a pas d'adresse.
      ADAM_BLOCK_PREVIEW: "1",
      // LE COMPOSEUR D'ADAM S'OUVRE (F8). La spec « d'où tu tiens ça ? » tape une phrase dans le
      // bureau d'Adam et attend une réponse DÉTERMINISTE : le code relit le registre des faits,
      // sans un seul appel de modèle. Sans clé présente, le champ est désactivé ; la clé ici est
      // un jalon, pas un secret. UNE requête part pourtant, mesuré le 01/10 : la page d'arrivée du
      // Super Admin (« Aujourd'hui ») demande son point du matin à un modèle (`getDailyBrief`, réservé
      // à qui voit Adam) ; avec cette fausse clé le fournisseur la refuse (401) et la page s'affiche
      // sans le point du matin. Le `fetch` du serveur ne passe pas par le mandataire du conteneur
      // (§118.84) : rien n'est facturé — mais « aucune requête ne part » était faux, et l'écrire ici
      // l'aurait fait croire à chaque spec qui se connecte en Super Admin.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "e2e-cle-presente-mais-non-utilisee",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "e2e-cle-presente-mais-non-utilisee",
    },
  },
});
