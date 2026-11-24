import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";

/**
 * Finances › Banque & paiements (§118.215) : « Solde bancaire » daté (un seul chiffre), « Après les paiements à faire » à côté,
 * cases d'entités. Décor propre (préfixe `__e2e19__`), retiré au début et à la fin.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});
const P = "__e2e19__";
const EMAIL = `${P}sa@test.dz`;

async function nettoyer() {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.company.deleteMany({ where: { name: { startsWith: P } } });
}

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  await prisma.user.create({ data: { email: EMAIL, name: `${P} SA`, passwordHash: hash, role: "SUPER_ADMIN" } });
  await prisma.company.create({ data: { name: `${P}ADV`, color: "#1d4ed8" } as never });
});
test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("la page porte « Solde bancaire », « Après les paiements à faire » à côté, et les cases d'entités", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(EMAIL);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.goto("/finances/paiements-a-faire");
  await expect(page.getByText("Solde bancaire").first()).toBeVisible();
  await expect(page.getByText(/Après les \d+ paiements à faire/).first()).toBeVisible();
  await expect(page.getByText("Solde de trésorerie")).toHaveCount(0);
  const cases = page.locator("[data-entite]");
  expect(await cases.count()).toBeGreaterThan(0);
  await expect(page.getByText("Toutes les entités")).toHaveCount(0); // plus de vue groupe (06/10)
  await page.goto("/finances/paiements-a-faire?entite=inconnue");
  await expect(page.getByText("Solde bancaire").first()).toBeVisible();
  if (process.env.E2E_CAPTURES) await page.screenshot({ path: `${process.env.E2E_CAPTURES}/finances-solde.png`, fullPage: true });
});
