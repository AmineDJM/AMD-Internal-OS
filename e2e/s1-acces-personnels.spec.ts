import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT S1 (décision 0048) — UN ASSISTANT PAR EMPLOYÉ, serveur RÉEL (build de production).
 *
 * Le scénario du 02/11 : la Direction ouvre le compte de « Radia » (assistante de direction, non Super Admin) en Vue
 * exacte, l'accueil dit « Bonjour Radia », puis l'assistant répond « Salut Amine » avec les droits du Super Admin.
 *   • Connexion RÉELLE de Radia : l'accueil la nomme, jamais le Super Admin.
 *   • Vue exacte : l'accueil dit que l'assistant est FERMÉ ; un message reçoit le refus — jamais un salut au nom du
 *     Super Admin, jamais un montant. Aucun appel de modèle n'est nécessaire (la porte refuse avant).
 * 0 erreur console ; aucune barre de défilement horizontale.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const prisma = new PrismaClient();
const EMAIL = "__e2e__s1-radia@test.dz";
const NOM = "Radia __e2e__KEBIR";
let radiaId = "";

test.beforeAll(async () => {
  const u = await prisma.user.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, name: NOM, role: "DIRECTION_ASSISTANT", passwordHash: await bcrypt.hash(E2E.password, 10) },
    update: { name: NOM, role: "DIRECTION_ASSISTANT", isActive: true },
  });
  radiaId = u.id;
  await prisma.userAccess.deleteMany({ where: { userId: u.id, module: "ASSISTANT_IA" } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  await prisma.employee.deleteMany({ where: { userId: u.id } });
  await prisma.employee.create({ data: { fullName: NOM, userId: u.id, position: "Assistante de direction", baseSalary: 105180, netToPay: 110000 } });
});
test.afterAll(async () => {
  await prisma.employee.deleteMany({ where: { userId: radiaId } });
  await prisma.assistantIaFil.deleteMany({ where: { userId: radiaId } });
  await prisma.userAccess.deleteMany({ where: { userId: radiaId } });
  await prisma.userSession.deleteMany({ where: { userId: radiaId } });
  await prisma.user.deleteMany({ where: { id: radiaId } }).catch(() => undefined);
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

const sansDefilementHorizontal = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("S1 — connexion réelle de Radia : son assistant la nomme, jamais le Super Admin", async ({ page }) => {
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  await login(page, EMAIL);
  await page.goto("/assistant");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Bonjour Radia/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Super Admin/)).toHaveCount(0);
  expect(await sansDefilementHorizontal(page)).toBe(true);
  expect(erreurs).toEqual([]);
});

test("S1 — Vue exacte sur Radia : l'assistant est FERMÉ — ni « Salut » au nom du Super Admin, ni montant", async ({ page }) => {
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  await login(page, E2E.superAdminEmail);
  await page.goto(`/admin/users/${radiaId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /voir comme cet utilisateur/i }).click();
  await expect(page.getByText(/Vous voyez l.interface de/)).toContainText("Radia", { timeout: 20_000 });

  await page.goto("/assistant");
  await page.waitForLoadState("networkidle");
  // L'écran apprend la vue au premier relevé du fil : l'accueil dit alors la fermeture.
  await expect(page.getByText(/fermé en « Vue exacte »/).first()).toBeVisible({ timeout: 20_000 });

  await page.getByPlaceholder("Écrivez votre demande…").fill("Quel est le salaire de radia ?");
  await page.getByRole("button", { name: "Envoyer" }).click();
  await expect(page.getByText(/fermé en « Vue exacte »/)).toHaveCount(2, { timeout: 20_000 });
  const corps = await page.locator("body").innerText();
  expect(corps).not.toMatch(/Salut\s+__e2e__|110\s?000|105\s?180/);
  expect(await sansDefilementHorizontal(page)).toBe(true);

  await page.getByRole("button", { name: /^quitter$/i }).click();
  await expect(page.getByText(/Vous voyez l.interface de/)).toHaveCount(0, { timeout: 15_000 });
  expect(erreurs).toEqual([]);
});

test("S1 — Administration › IA › Accès : « Ce que son assistant voit » montre le profil de Radia et ses familles", async ({ page }) => {
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  await login(page, E2E.superAdminEmail);
  await page.goto("/admin/ai/acces");
  await page.waitForLoadState("networkidle");
  const carte = page.getByTestId("assistant-de-la-personne");
  await carte.getByLabel("Personne").selectOption(radiaId);
  await expect(carte.getByTestId("consigne-profil")).toContainText(`Tu parles à : ${NOM}`, { timeout: 20_000 });
  await expect(carte.getByTestId("consigne-profil")).toContainText("Assistante de direction");
  await expect(carte.getByText(/AUCUN périmètre nominatif|Aucun — hors droit applicatif/).first()).toBeVisible();
  expect(await sansDefilementHorizontal(page)).toBe(true);
  expect(erreurs).toEqual([]);
});
