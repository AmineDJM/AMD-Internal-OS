import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TROIS CENTRES SAVENT FAIRE CORRIGER — dans le navigateur (audit 360°, lot C3, §118.188).
 *
 * Les bancs de flux prouvent les RÈGLES par les vraies actions ; celui-ci prouve qu'elles ont un
 * ÉCRAN qui les déclenche (§118.50), dans la peau de cinq personnes :
 *   - CENTRE DE VALIDATIONS : le validateur renvoie pour correction (le motif est exigé AVANT le
 *     clic) ; le demandeur lit le motif sur la fiche, corrige et resoumet — la même demande,
 *     version 2, revenue à l'étape qui l'a renvoyée ;
 *   - BONS DE COMMANDE : le signataire renvoie le BC à son émetteur — il quitte « à signer » sans
 *     disparaître, et l'émetteur est prévenu ;
 *   - CENTRE AD & PRO : un siège renvoie une « autre demande » pour correction ; son demandeur
 *     corrige le montant SOUS le seuil depuis la fiche, et la porte se retire.
 *
 * Décor propre à la spec (préfixe `__e2e11__`), retiré au début et à la fin. Les notifications que
 * ces gestes envoient À D'AUTRES (les sièges du centre, prévenus d'une resoumission) se retirent par
 * leur LIEN, bornées à la fenêtre du run : sans la borne, la table entière serait lue (§118.175).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e11__";
const EMAIL = {
  demandeur: `${P}demandeur@test.dz`,
  validateur: `${P}validateur@test.dz`,
  signataire: `${P}signataire@test.dz`,
  emetteur: `${P}emetteur@test.dz`,
  pdg: `${P}pdg@test.dz`,
  marketing: `${P}marketing@test.dz`,
};
const VAL_TITRE = `${P} Achat de kakémonos pour le congrès`;
const MOTIF_VAL = "Joignez le devis signé du fournisseur.";
const CORRECTION_VAL = "Devis signé joint, montant ramené au devis.";
const BC_TITRE = `${P} BC Imprimerie Atlas`;
const MOTIF_BC = "Le prix unitaire ne correspond pas au devis.";
const AUTRE_TITRE = `${P} Étude de terrain Oran`;
const MOTIF_CENTRE = "Le budget dépasse ce que l'étude demande : chiffrez-la au plus juste.";

let valId = "";
let bcId = "";
let autreId = "";
let emetteurId = "";
let seuilAdPro = 1_000_000;
const debut = new Date();

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  // 60 s : la toute première connexion après un build propre est lente (§118.124b).
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/** Naviguer PUIS attendre l'hydratation : un clic posé avant ne fait rien (§118.168). */
async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const vals = await prisma.validationRequest.findMany({ where: { title: { startsWith: P } }, select: { id: true } });
  const vIds = vals.map((v) => v.id);
  const bcs = await prisma.legalDocument.findMany({ where: { title: { startsWith: P } }, select: { id: true } });
  const bIds = bcs.map((b) => b.id);
  const autres = await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: P } }, select: { id: true } });
  const aIds = autres.map((a) => a.id);
  const lies = [...vIds, ...bIds, ...aIds];
  await prisma.comment.deleteMany({ where: { entityType: "VALIDATION_REQUEST", entityId: { in: vIds } } });
  await prisma.validationRequest.deleteMany({ where: { OR: [{ id: { in: vIds } }, { entityType: "LEGAL_DOCUMENT", entityId: { in: bIds } }] } });
  await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: [...aIds, ...bIds] } } });
  await prisma.adProOtherRequest.deleteMany({ where: { id: { in: aIds } } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: bIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  if (lies.length > 0) {
    await prisma.notification.deleteMany({
      where: { createdAt: { gte: new Date(debut.getTime() - 60 * 60 * 1000) }, OR: lies.map((id) => ({ link: { contains: id } })) },
    });
  }
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: lies } }] } }).catch(() => {});
  await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const mk = (email: string, nom: string, role: "MEDICAL_DELEGATE" | "HEAD_OF_SALES" | "FINANCE_BUDGET_MANAGER" | "DIRECTION_ASSISTANT" | "GENERAL_MANAGER" | "PRODUCT_MANAGER") =>
    prisma.user.create({ data: { email, name: `${P} ${nom}`, passwordHash: hash, role }, select: { id: true } });
  const [demandeur, validateur, , emetteur, , marketing] = await Promise.all([
    mk(EMAIL.demandeur, "Déléguée", "MEDICAL_DELEGATE"),
    mk(EMAIL.validateur, "Chef des ventes", "HEAD_OF_SALES"),
    mk(EMAIL.signataire, "Gestionnaire budgétaire", "FINANCE_BUDGET_MANAGER"),
    mk(EMAIL.emetteur, "Assistante de direction", "DIRECTION_ASSISTANT"),
    mk(EMAIL.pdg, "Directeur général", "GENERAL_MANAGER"),
    mk(EMAIL.marketing, "Directrice marketing", "PRODUCT_MANAGER"),
  ]);
  emetteurId = emetteur.id;

  // UNE DEMANDE DE VALIDATION à une étape, chez le chef des ventes.
  valId = (await prisma.validationRequest.create({
    data: {
      reference: `${P}VAL-1`, title: VAL_TITRE, description: "Dix kakémonos pour le stand.", module: "Demandes de validations",
      amount: 120_000, requesterId: demandeur.id, mode: "SEQUENTIAL",
      steps: { create: [{ order: 1, validatorId: validateur.id }] },
    },
    select: { id: true },
  })).id;

  // UN BC À SIGNER : dans le circuit, sa porte VALIDÉE (la demande de validation du BC, accordée) —
  // quel que soit le seuil du moment, il est « à signer » (§118.149).
  bcId = (await prisma.legalDocument.create({
    data: {
      title: BC_TITRE, reference: `${P}BC-1`, kind: "PURCHASE_ORDER", counterparty: "Imprimerie Atlas",
      amount: 80_000, bcCircuitAt: new Date(), createdById: emetteur.id,
    },
    select: { id: true },
  })).id;
  await prisma.validationRequest.create({
    data: {
      reference: `${P}VAL-BC`, title: `${P} Validation du BC`, module: "Legal", objectType: "BON_DE_COMMANDE",
      entityType: "LEGAL_DOCUMENT", entityId: bcId, requesterId: emetteur.id, status: "APPROVED", decidedAt: new Date(),
    },
  });

  // UNE « AUTRE DEMANDE » au-dessus du seuil Ad & Pro EN VIGUEUR, qui attend le centre. Le seuil est
  // un réglage global : on le LIT et l'on se place au-dessus, sans jamais l'écrire (§118.115).
  const reglage = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { adProDgThreshold: true } });
  if (reglage) seuilAdPro = Number(reglage.adProDgThreshold);
  const montant = seuilAdPro + 500_000;
  autreId = (await prisma.adProOtherRequest.create({
    data: {
      reference: `${P}AUT-1`, title: AUTRE_TITRE, description: "Étude des prescriptions à Oran.", amount: montant,
      status: "AWAITING_DECISION", requesterId: marketing.id, createdById: marketing.id,
    },
    select: { id: true },
  })).id;
  await prisma.adProGateVisa.create({
    data: { entityType: "AD_PRO_OTHER", entityId: autreId, status: "PENDING", threshold: seuilAdPro, amount: montant },
  });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("VALIDATIONS — le validateur RENVOIE pour correction : sans motif, le bouton ne part pas", async ({ page }) => {
  // Le premier parcours après un build propre paie le démarrage à froid du serveur (§118.124b) :
  // plafond LOCAL, le délai global ne bouge pas.
  test.setTimeout(120_000);
  await login(page, EMAIL.validateur);
  await aller(page, "/validations");
  // LE CENTRE, UN SEUL ÉCRAN (24/11/2026) : la ligne de la file ouvre la fiche ; le renvoi passe par « Demander une
  // précision » et l'interrupteur « Lui renvoyer la demande pour correction » — la question devient le motif.
  await page.getByRole("button", { name: VAL_TITRE }).first().click();
  await page.getByRole("button", { name: /^Demander une précision/ }).click();
  await page.getByRole("switch", { name: "Lui renvoyer la demande pour correction" }).click();
  const confirmer = page.getByRole("button", { name: "Envoyer et renvoyer" });
  await expect(confirmer, "pas de renvoi sans motif : le demandeur ne saurait pas quoi corriger").toBeDisabled();
  await page.getByLabel("Votre question").fill(MOTIF_VAL);
  await expect(confirmer).toBeEnabled();
  await cliquerDecisif(confirmer);
  await expect.poll(async () => (await prisma.validationRequest.findUniqueOrThrow({ where: { id: valId } })).status, { timeout: 15_000 })
    .toBe("CHANGES_REQUESTED");
  const etape = await prisma.validationStep.findFirstOrThrow({ where: { requestId: valId } });
  expect(etape.status).toBe("CHANGES_REQUESTED");
  expect(etape.reason).toBe(MOTIF_VAL);
});

test("VALIDATIONS — le demandeur lit le motif sur la fiche, corrige et RESOUMET : la même demande, version 2", async ({ page }) => {
  await login(page, EMAIL.demandeur);
  await aller(page, `/validations/${valId}`);
  // Le TITRE de la carte — le badge de statut dit aussi « À corriger » : deux éléments, un seul visé.
  await expect(page.getByRole("heading", { name: "À corriger" })).toBeVisible();
  await expect(page.getByText(`« ${MOTIF_VAL} »`), "le motif se lit sur la fiche, sans dérouler le circuit").toBeVisible();
  const resoumettre = page.getByRole("button", { name: "Resoumettre" });
  await expect(resoumettre, "ce qui a été corrigé est exigé").toBeDisabled();
  await page.getByPlaceholder("Ex. : montant corrigé, devis signé joint…").fill(CORRECTION_VAL);
  await page.locator('input[name="amount"]').fill("100000");
  await resoumettre.click();
  await expect(page.getByText("2 — resoumise après correction")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Historique des versions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resoumettre" }), "une demande resoumise n'est plus à resoumettre").toHaveCount(0);
  const req = await prisma.validationRequest.findUniqueOrThrow({ where: { id: valId }, include: { steps: true } });
  expect(req.status).toBe("PENDING");
  expect(req.version).toBe(2);
  expect(Number(req.amount)).toBe(100_000);
  expect(req.steps.map((e) => e.status), "elle revient à l'étape qui l'a renvoyée").toEqual(["PENDING"]);
});

test("BONS DE COMMANDE — le signataire RENVOIE le BC à son émetteur : il quitte « à signer » et l'émetteur est prévenu", async ({ page }) => {
  await login(page, EMAIL.signataire);
  await aller(page, "/bons-de-commande");
  const ligne = page.locator("li").filter({ hasText: BC_TITRE });
  await expect(ligne.getByRole("button", { name: "Signer" })).toBeVisible();
  await ligne.getByRole("button", { name: "Renvoyer à l'émetteur" }).click();
  const confirmer = ligne.getByRole("button", { name: "Confirmer le renvoi" });
  await expect(confirmer, "pas de renvoi sans ce qu'il faut corriger").toBeDisabled();
  await ligne.getByLabel("Ce qu'il faut corriger").fill(MOTIF_BC);
  await cliquerDecisif(confirmer);
  await expect.poll(async () => (await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId } })).signatureReturnedAt, { timeout: 15_000 })
    .not.toBeNull();
  const bc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId } });
  expect(bc.signedAt, "renvoyé n'est pas signé").toBeNull();
  expect(bc.signatureReturnNote).toBe(MOTIF_BC);
  expect(await prisma.notification.count({ where: { userId: emetteurId, title: "Bon de commande renvoyé pour correction" } })).toBe(1);

  await aller(page, "/bons-de-commande");
  await expect(page.getByRole("heading", { name: "Renvoyés à l'émetteur" })).toBeVisible();
  await expect(page.getByText(`À corriger : « ${MOTIF_BC} »`), "sorti de la file, pas perdu de vue").toBeVisible();
  await expect(page.locator("li").filter({ hasText: BC_TITRE }).getByRole("button", { name: "Signer" }), "un BC renvoyé ne se signe plus").toHaveCount(0);
});

test("CENTRE AD & PRO — un siège RENVOIE une « autre demande » pour correction, motif exigé", async ({ page }) => {
  await login(page, EMAIL.pdg);
  await aller(page, "/centre-ad-pro");
  // La file à gauche, la fiche de décision à droite (maquette du 24/11/2026) : on ouvre la ligne, puis « Renvoyer ».
  await page.locator(`#ligne-centre-${autreId}`).getByRole("button").click();
  const fiche = page.getByTestId("fiche-centre");
  await fiche.getByRole("button", { name: "Renvoyer", exact: true }).click();
  const renvoyer = fiche.getByRole("button", { name: "Confirmer le renvoi" });
  await expect(renvoyer, "pas de renvoi sans motif").toBeDisabled();
  await fiche.locator("#motif-centre").fill(MOTIF_CENTRE);
  await cliquerDecisif(renvoyer);
  await expect.poll(async () => (await prisma.adProGateVisa.findUnique({ where: { entityType_entityId: { entityType: "AD_PRO_OTHER", entityId: autreId } } }))?.status, { timeout: 15_000 })
    .toBe("CHANGES_REQUESTED");
});

test("CENTRE AD & PRO — le demandeur corrige le montant SOUS le seuil depuis la fiche et resoumet : la porte se retire", async ({ page }) => {
  await login(page, EMAIL.marketing);
  await aller(page, `/ad-pro/autres/${autreId}`);
  await expect(page.getByText(/Centre de validation Ad & Pro : à corriger/)).toBeVisible();
  await expect(page.getByText(`À corriger : « ${MOTIF_CENTRE} »`)).toBeVisible();
  const resoumettre = page.getByRole("button", { name: "Resoumettre au centre" });
  await expect(resoumettre, "ce qui a été corrigé est exigé").toBeDisabled();
  await page.getByLabel("Ce que vous avez corrigé").fill("Étude ramenée à deux wilayas.");
  const corrige = seuilAdPro - 100_000;
  await page.getByLabel("Montant corrigé (DZD)").fill(String(corrige));
  await resoumettre.click();
  await expect(page.getByText(/Centre de validation Ad & Pro : à corriger/), "corrigée sous le seuil, elle ne repasse pas par le centre").toHaveCount(0, { timeout: 15_000 });
  expect(await prisma.adProGateVisa.count({ where: { entityType: "AD_PRO_OTHER", entityId: autreId } })).toBe(0);
  const demande = await prisma.adProOtherRequest.findUniqueOrThrow({ where: { id: autreId } });
  expect(Number(demande.amount)).toBe(corrige);
  expect(demande.status, "elle poursuit son circuit").toBe("AWAITING_DECISION");
});
