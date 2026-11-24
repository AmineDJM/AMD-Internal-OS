import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { autoriserAuCentre, ficheDuCentre, ligneDuCentre, ouvrirAuCentre } from "./centre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE PAIEMENT : LES SOCIÉTÉS EN HAUT, LA FILE « À DÉCIDER » ET SA FICHE (maquette validée le
 * 24/11/2026) — écrans réels, base réelle, aucun appel de modèle de leur fait.
 *
 * Les trois sections d'autrefois (Regulatory / Sales & Marketing / Autres) ont fait place à UNE file par
 * société, toutes origines confondues (Super Admin, 24/11/2026). Les bancs de flux prouvent le chargeur
 * et la fiche ; celui-ci prouve que l'ÉCRAN existe, se lit, change de société sans recharger la page,
 * tient à 375 px (la file, puis la fiche en plein écran) et ne montre jamais la société qu'un siège n'a
 * pas le droit de voir (§118.50). Deux personnes : le Super Admin (voit les
 * deux sociétés — le témoin sans lequel « B est cachée » ne prouverait rien) et un siège du centre
 * rattaché à UNE société, sans vue globale (§118.104).
 *
 * Décor propre à la spec (préfixe `__e2e9__`), retiré au début et à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e9__";
const SA_EMAIL = `${P}sa@test.dz`;
const SIEGE_EMAIL = `${P}siege@test.dz`;
const ALPHA = `${P}Alpha`;
const BETA = `${P}Beta`;
const L = {
  aReg: `${P} Taxe ANPP Alpha`,
  aSm: `${P} Sponsoring congrès Alpha`,
  aAu: `${P} Loyer Alpha`,
  bReg: `${P} Taxe ANPP Beta`,
  bSm: `${P} Sponsoring congrès Beta`,
};

let alphaId = "";
let betaId = "";
let siegeId = "";
let saId = "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/** Naviguer PUIS attendre l'hydratation : un clic posé avant ne fait rien (§118.168). */
async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function sansDebordement(page: Page) {
  const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
  expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const entites = await prisma.company.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const entiteIds = entites.map((c) => c.id);
  const ordres = await prisma.expenseOrder.findMany({ where: { OR: [{ label: { startsWith: P } }, { companyId: { in: entiteIds } }] }, select: { id: true } });
  const ordreIds = ordres.map((o) => o.id);
  await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordreIds } } }).catch(() => {});
  await prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ordreIds } }, { title: { startsWith: P } }] } }).catch(() => {});
  await prisma.expenseOrder.deleteMany({ where: { id: { in: ordreIds } } });
  await prisma.paymentCentreSeat.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.userCompanyAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: entiteIds } } });
}

let seq = 0;
async function ordre(label: string, o: { companyId: string; sourceType: string | null; sourceId?: string; amount: number }) {
  await prisma.expenseOrder.create({
    data: {
      reference: `${P}OD-${++seq}`, label, amount: o.amount, category: "AUTRE", companyId: o.companyId,
      sourceType: o.sourceType as never, sourceId: o.sourceId ?? null, centralStatus: "AWAITING", requestedById: saId,
    },
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const sa = await prisma.user.create({ data: { email: SA_EMAIL, name: `${P} Super Admin`, passwordHash: hash, role: "SUPER_ADMIN" } });
  const siege = await prisma.user.create({ data: { email: SIEGE_EMAIL, name: `${P} Siège`, passwordHash: hash, role: "DIRECTION_ASSISTANT" } });
  saId = sa.id; siegeId = siege.id;
  alphaId = (await prisma.company.create({ data: { name: `${P} Alpha SARL`, shortName: ALPHA, sortOrder: 9001 } })).id;
  betaId = (await prisma.company.create({ data: { name: `${P} Beta SARL`, shortName: BETA, sortOrder: 9002 } })).id;
  // LE SIÈGE : nommé au centre, rattaché à la SEULE société Alpha, sans vue globale.
  await prisma.userCompanyAccess.create({ data: { userId: siegeId, companyId: alphaId } });
  await prisma.paymentCentreSeat.create({ data: { userId: siegeId, note: `${P} siège` } });

  await ordre(L.aReg, { companyId: alphaId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 120_000 });
  await ordre(L.aSm, { companyId: alphaId, sourceType: "SPONSORING", sourceId: "x-sp", amount: 340_000 });
  await ordre(L.aAu, { companyId: alphaId, sourceType: "PAYROLL", sourceId: "x-paie", amount: 90_000 });
  await ordre(L.bReg, { companyId: betaId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 55_000 });
  await ordre(L.bSm, { companyId: betaId, sourceType: "SPONSORING", sourceId: "x-sp", amount: 77_000 });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("LES SOCIÉTÉS EN HAUT : une pastille par société avec ses paiements à décider, et UNE file de toutes les origines", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, `/centre-de-paiement?entite=${alphaId}`);
  const entites = page.getByRole("navigation", { name: "Entités" });
  await expect(entites.getByRole("link", { name: new RegExp(ALPHA) })).toHaveAttribute("aria-current", "page");
  await expect(entites.getByRole("link", { name: new RegExp(`${ALPHA}\\s*3`) })).toBeVisible();
  await expect(entites.getByRole("link", { name: new RegExp(`${BETA}\\s*2`) })).toBeVisible();
  // Plus de sections : Regulatory, sponsoring et paie d'Alpha attendent dans la même file — rien de Beta.
  await expect(page.getByRole("navigation", { name: "Types de demandes de paiement" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /À décider · 3/ })).toBeVisible();
  for (const l of [L.aReg, L.aSm, L.aAu]) await expect(ligneDuCentre(page, l)).toBeVisible();
  await expect(page.getByText(L.bReg)).toHaveCount(0);
  // La fiche du premier de la file est ouverte, avec ses gestes.
  await expect(ficheDuCentre(page).getByRole("button", { name: "Autoriser le paiement" })).toBeVisible();
});

test("CHANGER DE SOCIÉTÉ se fait EN HAUT, sans recharger la page — la file suit", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, `/centre-de-paiement?entite=${alphaId}`);
  // Un marqueur posé dans la page : s'il survit, la navigation n'a PAS rechargé le document.
  await page.evaluate(() => { (window as unknown as { __marqueur: string }).__marqueur = "vivant"; });
  await page.getByRole("navigation", { name: "Entités" }).getByRole("link", { name: new RegExp(BETA) }).click();
  await expect(page).toHaveURL(new RegExp(`entite=${betaId}`));
  await expect(ligneDuCentre(page, L.bSm)).toBeVisible();
  await expect(page.getByText(L.aSm)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __marqueur?: string }).__marqueur), "le document n'a pas été rechargé").toBe("vivant");
});

test("une société forgée dans l'adresse ne désigne rien : la page s'ouvre sur une société réelle, sans erreur", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, "/centre-de-paiement?entite=n-importe-quoi&section=bidon");
  await expect(page.getByRole("heading", { name: "Centre de paiement" }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Entités" }).locator('a[aria-current="page"]')).toHaveCount(1);
});

test("SIÈGE RATTACHÉ À UNE SOCIÉTÉ : sa pastille, jamais celle de l'autre — même en la demandant dans l'adresse", async ({ page }) => {
  await login(page, SIEGE_EMAIL);
  await aller(page, `/centre-de-paiement?entite=${betaId}`);
  const entites = page.getByRole("navigation", { name: "Entités" });
  await expect(entites.getByRole("link", { name: new RegExp(ALPHA) })).toBeVisible();
  await expect(entites.getByRole("link", { name: new RegExp(BETA) }), "la société Beta ne lui est pas ouverte").toHaveCount(0);
  await expect(page.getByText(L.bReg)).toHaveCount(0);
  await expect(page.getByText(L.bSm)).toHaveCount(0);
  // Il tombe sur la sienne.
  await expect(ligneDuCentre(page, L.aReg)).toBeVisible();
});

test("LA DÉCISION RESTE LA MÊME : le siège autorise depuis la fiche, la base le dit, et l'ordre quitte la file", async ({ page }) => {
  await login(page, SIEGE_EMAIL);
  await aller(page, `/centre-de-paiement?entite=${alphaId}`);
  await autoriserAuCentre(page, L.aSm);
  await expect.poll(async () => (await prisma.expenseOrder.findFirstOrThrow({ where: { label: L.aSm }, select: { centralStatus: true } })).centralStatus, { timeout: 15_000 }).toBe("APPROVED");
  // La pastille et la file suivent : décidé, il passe à l'historique (menu ⋯).
  await aller(page, `/centre-de-paiement?entite=${alphaId}`);
  await expect(page.getByRole("navigation", { name: "Entités" }).getByRole("link", { name: new RegExp(`${ALPHA}\\s*2`) })).toBeVisible();
  await expect(ligneDuCentre(page, L.aSm)).toHaveCount(0);
  await page.getByRole("button", { name: /Autres : déjà décidés/ }).click();
  await page.getByRole("menuitem", { name: /Déjà décidés/ }).click();
  await expect(page.getByRole("dialog").getByText(L.aSm)).toBeVisible();
});

test("AU TÉLÉPHONE (375 px) : la file d'abord, la fiche en plein écran au toucher, et la page ne déborde pas", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page, SA_EMAIL);
  await aller(page, `/centre-de-paiement?entite=${alphaId}`);
  await sansDebordement(page);
  await expect(ficheDuCentre(page), "la fiche attend qu'on touche une ligne").toBeHidden();
  const fiche = await ouvrirAuCentre(page, L.aAu);
  await expect(fiche.getByRole("button", { name: "Retour à la file" })).toBeVisible();
  const boite = await fiche.boundingBox();
  expect(boite && boite.width >= 370, "la fiche occupe tout l'écran").toBe(true);
  await sansDebordement(page);
  await fiche.getByRole("button", { name: "Retour à la file" }).click();
  await expect(ficheDuCentre(page)).toBeHidden();
  await page.getByRole("navigation", { name: "Entités" }).getByRole("link", { name: new RegExp(BETA) }).click();
  await expect(page).toHaveURL(new RegExp(`entite=${betaId}`));
  await sansDebordement(page);
});
