import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UN DEVIS DE POSTE ET LE BC GÉNÉRÉ, DANS LE NAVIGATEUR (§118.206) — ÉCRITE, PAS JOUÉE.
 *
 * Cette spec n'a PAS été exécutée : elle exige un `npm run build` propre, et un autre build tournait au même moment sur
 * la machine (deux travaux qui touchent `.next` ne se mesurent pas l'un à côté de l'autre, §118.115). Le banc de flux
 * (`devis-bc-flow.test.ts`) prouve les règles par les vraies actions ; celle-ci prouve que la CARTE les déclenche :
 *   - le délégué ouvre les lignes d'un devis, en coche deux, les valide ;
 *   - la case « Bon de commande » propose « Générer le BC » (et pas un geste que l'action refuserait) ;
 *   - le BC apparaît avec son Word et son PDF ; en cocher une troisième propose « Régénérer le BC », et le même BC
 *     passe à la version 2.
 *
 * Décor propre à la spec (préfixe `__e2e11__`), retiré au début et à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e11__";
const KAM_EMAIL = `${P}kam@test.dz`;
let eventId = "", kamId = "", catId = "", companyId = "", posteId = "", devisId = "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}
async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}
async function carte(page: Page, libelle: string) {
  const c = page.locator("li").filter({ has: page.getByRole("button", { name: `Autres actions — ${libelle}` }) }).last();
  // LE TABLEAU DES POSTES (fiche simplifiée, 24/11/2026) : la carte d'un poste se déplie depuis sa ligne, « Ouvrir ».
  if ((await c.count()) === 0) {
    const ouvrir = page.getByRole("button", { name: `Ouvrir — ${libelle}`, exact: true });
    if (await ouvrir.count()) await ouvrir.first().click();
  }
  return c;
}
async function attendre<T>(lire: () => Promise<T>, ok: (v: T) => boolean, quoi: string): Promise<T> {
  const debut = Date.now();
  for (;;) {
    const v = await lire();
    if (ok(v)) return v;
    if (Date.now() - debut > 20_000) throw new Error(`${quoi} : toujours ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const events = await prisma.event.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const evIds = events.map((e) => e.id);
  const postes = (await prisma.adProItem.findMany({ where: { eventId: { in: evIds } }, select: { id: true } })).map((p) => p.id);
  const docs = (await prisma.legalDocument.findMany({ where: { OR: [{ title: { startsWith: P } }, { company: { name: { startsWith: P } } }] }, select: { id: true } })).map((d) => d.id);
  await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: { in: docs } } }, data: { bcId: null } });
  await prisma.legalDocument.updateMany({ where: { id: { in: docs } }, data: { chainFromId: null } });
  await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } });
  await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: docs } } });
  const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
  await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } });
  await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } });
  await prisma.document.deleteMany({ where: { entityId: { in: docs } } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } });
  await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } });
  await prisma.adProItem.deleteMany({ where: { id: { in: postes } } });
  await prisma.event.deleteMany({ where: { id: { in: evIds } } });
  await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } });
  await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } });
  await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.employee.deleteMany({ where: { fullName: { startsWith: P } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  const societes = (await prisma.company.findMany({ where: { name: { startsWith: P } }, select: { id: true } })).map((c) => c.id);
  await prisma.documentSequence.deleteMany({ where: { companyId: { in: societes } } });
  await prisma.officeLetterhead.deleteMany({ where: { companyId: { in: societes } } });
  await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: societes } } });
  await prisma.company.deleteMany({ where: { id: { in: societes } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  kamId = (await prisma.user.create({ data: { email: KAM_EMAIL, name: `${P} Délégué`, passwordHash: hash, role: "MEDICAL_DELEGATE" } })).id;
  companyId = (await prisma.company.create({ data: { name: `${P} Pharma`, shortName: `${P}Ph`.slice(0, 12), color: "#1B7F79" } })).id;
  await prisma.employee.create({ data: { fullName: `${P} Délégué`, userId: kamId, companyId } });
  await prisma.companyLegalIdentity.create({
    data: {
      companyId, legalName: `${P} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
      nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
      bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
    },
  });
  eventId = (await prisma.event.create({
    data: { name: `${P}Journée cardiologie`, requesterId: kamId, status: "VALIDATED", startDate: new Date("2026-12-04") }, select: { id: true },
  })).id;
  const env = await prisma.budgetEnvelope.create({
    data: { name: `${P}Enveloppe`, modules: ["EVENTS"], totalAmount: 10_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") }, select: { id: true },
  });
  catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${P}Imprimerie`, allocated: 5_000_000 }, select: { id: true } })).id;
  posteId = (await prisma.adProItem.create({
    data: {
      eventId, kind: "PRINTING", label: `${P}Brochures`, amountEstimated: 800_000, amountGranted: 800_000, status: "APPROVED",
      supplier: "Imprimerie Alpha", budgetCategoryId: catId, createdById: kamId,
    }, select: { id: true },
  })).id;
  // Un devis déjà déposé et RETRANSCRIT à la main (lignes sans lecture : lue = null, donc sans attestation à cocher).
  devisId = (await prisma.legalDocument.create({
    data: {
      title: `${P}Devis DV-1`, kind: "QUOTE", reference: `${P}DV-1`, counterparty: "Imprimerie Alpha", companyId,
      sourceType: "EVENT", sourceId: eventId, createdById: kamId, updatedById: kamId,
    }, select: { id: true },
  })).id;
  await prisma.adProItemPiece.create({ data: { itemId: posteId, legalDocumentId: devisId, nature: "DEVIS", createdById: kamId } as never });
  await prisma.adProDevis.create({
    data: {
      legalDocumentId: devisId, tvaRate: 19, createdById: kamId,
      lignes: {
        create: [
          { position: 0, reference: "Fiche posologique", unit: "u", quantity: 100, unitPrice: 1000 },
          { position: 1, reference: "Brochure produit", unit: "u", quantity: 50, unitPrice: 2000 },
          { position: 2, reference: "Kakémono", unit: "u", quantity: 4, unitPrice: 25000 },
        ],
      },
    },
  });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("LIGNES : cocher deux références, les valider, générer le BC — Word et PDF visibles, une ligne non cochée absente ; en cocher une autre RÉGÉNÈRE le même BC", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, KAM_EMAIL);
  await aller(page, `/events/${eventId}`);
  const c = await carte(page, `${P}Brochures`);

  // Rien n'est validé : la carte ne propose pas de générer.
  await expect(c.getByRole("button", { name: /Générer le BC/ })).toHaveCount(0);

  await c.getByRole("button", { name: `Lignes du devis ${P}DV-1` }).click();
  await c.getByLabel("Valider la ligne Fiche posologique").check();
  await c.getByLabel("Valider la ligne Brochure produit").check();
  await c.getByRole("button", { name: "Valider les lignes cochées" }).click();
  await attendre(
    () => prisma.adProDevisLigne.count({ where: { devis: { legalDocumentId: devisId }, validatedItemId: posteId } }),
    (n) => n === 2, "deux lignes validées",
  );

  // « Générer le BC » : un seul devis à générer, un seul geste.
  await aller(page, `/events/${eventId}`);
  await c.getByRole("button", { name: "Générer le BC" }).first().click();
  const bc = await attendre(
    () => prisma.legalDocument.findFirst({ where: { chainFromId: devisId, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } }, select: { id: true, reference: true, amount: true, custom: true } }),
    (d) => d !== null, "BC généré",
  );
  const designations = ((bc!.custom as { fabrique?: { spec?: { lignes?: { designation: string }[] } } })?.fabrique?.spec?.lignes ?? []).map((l) => l.designation);
  expect(designations, "le BC ne porte que les lignes cochées").toEqual(["Fiche posologique", "Brochure produit"]);
  await aller(page, `/events/${eventId}`);
  await expect(c.getByRole("link", { name: /Télécharger le Word/ })).toBeVisible();
  await expect(c.getByRole("link", { name: /Ouvrir le PDF/ })).toBeVisible();

  // S'il oublie une référence : il la coche, et RÉGÉNÈRE.
  await c.getByRole("button", { name: /^Lignes \(/ }).click();
  await c.getByLabel("Valider la ligne Kakémono").check();
  await c.getByRole("button", { name: "Valider les lignes cochées" }).click();
  await attendre(
    () => prisma.adProDevisLigne.count({ where: { devis: { legalDocumentId: devisId }, validatedItemId: posteId } }),
    (n) => n === 3, "trois lignes validées",
  );
  await aller(page, `/events/${eventId}`);
  await c.getByRole("button", { name: "Régénérer le BC" }).click();
  const apres = await attendre(
    () => prisma.legalDocument.findFirst({ where: { chainFromId: devisId, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } }, select: { id: true, reference: true, custom: true } }),
    (d) => ((d?.custom as { fabrique?: { version?: number } })?.fabrique?.version ?? 0) === 2, "BC révisé en version 2",
  );
  expect(apres!.id, "le même BC").toBe(bc!.id);
  expect(apres!.reference, "le même numéro").toBe(bc!.reference);
  expect(await prisma.legalDocument.count({ where: { chainFromId: devisId, kind: "PURCHASE_ORDER" } })).toBe(1);
});
