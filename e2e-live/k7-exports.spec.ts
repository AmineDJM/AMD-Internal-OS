import { mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K7 — « GÉNÈRE LE SUIVI REGULATORY ET ENVOIE-LE À AMEL HADDAD », DANS L'APP, AU VRAI MODÈLE.
 *
 * La demande tapée dans l'app Adventum IA ; le fichier TÉLÉCHARGÉ par son lien ; la carte d'envoi confirmée ; le
 * message REÇU par Amel en base, avec la pièce et l'accès en lecture. Captures à chaque étape (`bench-out/k7/`), et
 * AUCUNE erreur de console. Base LOCALE du banc seulement.
 *
 * `K7_FAUX=1` (vrai modèle injoignable — crédit épuisé) : la demande est jouée au FAUX modèle par
 * `scripts/e2e/k7-exports.ts` (le code de production du fil et des outils) ; l'écran, le téléchargement et l'envoi
 * restent ceux de l'app. Le passage au vrai modèle est alors à refaire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const DB = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\/amd_bench/.test(DB)) throw new Error("Ce parcours ne tourne que sur amd_bench (base locale).");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
const SORTIE = "bench-out/k7";
mkdirSync(SORTIE, { recursive: true });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email professionnel").fill("super@adventum-bench.dz");
  await page.getByLabel("Mot de passe").fill("Bench12345!");
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

test("export du suivi Regulatory, téléchargé, puis envoyé à Amel Haddad", async ({ page }, info) => {
  const appareil = info.project.name;
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  page.on("pageerror", (e) => erreurs.push(String(e)));
  const capture = (etape: string) => page.screenshot({ path: `${SORTIE}/${appareil}-${etape}.png`, fullPage: false });

  const sa = await prisma.user.findUniqueOrThrow({ where: { email: "super@adventum-bench.dz" }, select: { id: true } });
  const amel = await prisma.user.findUniqueOrThrow({ where: { email: "amel.haddad@adventum-bench.dz" }, select: { id: true } });
  const debut = new Date();

  await login(page);
  await page.goto("/ia");
  const saisie = page.getByPlaceholder(/Écrivez, glissez des fichiers/);
  await saisie.waitFor({ timeout: 60_000 });
  await capture("1-app");

  // ── LA DEMANDE ────────────────────────────────────────────────────────────────────────────
  const demande = "Génère le suivi Regulatory et envoie-le à Amel Haddad.";
  if (process.env.K7_FAUX === "1") {
    execFileSync("npx", ["tsx", "scripts/e2e/k7-exports.ts", "demander", "super@adventum-bench.dz", demande], { env: process.env, stdio: "pipe" });
    await page.reload();
  } else {
    await saisie.fill(demande);
    await page.getByRole("button", { name: "Envoyer", exact: true }).first().click();
  }

  // La carte d'envoi : « Message à Amel Haddad », avec la pièce.
  const carte = page.getByText("Message à Amel Haddad").last();
  await carte.waitFor({ timeout: 300_000 });
  await expect(page.getByText(/regulatory-.*\.xlsx/).first()).toBeVisible();
  await capture("2-carte");

  // ── LE FICHIER TÉLÉCHARGÉ par le lien de la réponse ───────────────────────────────────────
  const lien = page.locator('a[href*="/raw?dl=1"]').last();
  await expect(lien).toBeVisible({ timeout: 30_000 });
  const [telechargement] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), lien.click()]);
  const chemin = `${SORTIE}/${appareil}-${telechargement.suggestedFilename()}`;
  await telechargement.saveAs(chemin);
  expect(telechargement.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(statSync(chemin).size).toBeGreaterThan(2_000);
  const node = await prisma.driveNode.findFirstOrThrow({ where: { ownerId: sa.id, createdAt: { gte: debut }, parent: { name: "Exports" } }, select: { id: true, name: true } });

  // ── L'ENVOI : la carte confirmée ──────────────────────────────────────────────────────────
  const bouton = page.getByRole("button", { name: /^Envoyer$/ }).last();
  await bouton.scrollIntoViewIfNeeded();
  await bouton.click();
  await expect(page.getByText(/Message envoyé/).last()).toBeVisible({ timeout: 60_000 });
  await capture("3-envoye");

  // ── LE MESSAGE REÇU par Amel, avec la pièce qu'elle peut ouvrir ───────────────────────────
  const m = await prisma.message.findFirstOrThrow({
    where: { senderId: sa.id, createdAt: { gte: debut }, conversation: { members: { some: { userId: amel.id } } } },
    select: { body: true, attachments: { select: { driveNodeId: true, name: true } } },
  });
  expect(m.attachments.map((a) => a.driveNodeId)).toContain(node.id);
  expect(await prisma.driveShare.count({ where: { nodeId: node.id, userId: amel.id } })).toBe(1);

  expect(erreurs, erreurs.join("\n")).toEqual([]);
});

test.afterAll(async () => { await prisma.$disconnect(); });
