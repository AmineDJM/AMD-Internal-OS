import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FINANCES DU 01/10 DANS LE NAVIGATEUR (§118.176) — écrans réels, base réelle, aucun appel de
 * modèle de leur fait (la page d'arrivée du Super Admin tente son point du matin, voir
 * `playwright.config.ts`).
 *
 * « Le compte bancaire doit être ancré, non réécrit à chaque fois […] on peut avoir plusieurs
 * comptes. Ce qu'il y a dans les comptes − les paiements autorisés, c'est le Solde trésorerie. La
 * caisse donnée mensuellement aux moyens généraux et la paie doivent passer par le centre de
 * paiement […] un bouton par entité. Le module bon de commande doit être à part. Tu dois me donner
 * la main pour supprimer, une ou plusieurs, les écritures à imputer. »
 *
 * Les bancs de flux prouvent les RÈGLES par les vraies actions ; celui-ci prouve qu'elles ont un
 * ÉCRAN qui s'ouvre et qui les déclenche (§118.50), dans la peau de quatre personnes :
 *   - le Super Admin ouvre un compte ANCRÉ à un relevé, supprime une écriture « à imputer » (une
 *     remise de caisse n'y figure plus), autorise la paie au centre — et voit le solde de
 *     trésorerie la retrancher — puis remet une somme en caisse, qui part au centre ;
 *   - une RH sans vue globale envoie la paie de SON entité avec la somme des salaires à virer ;
 *   - un financier trouve « Bons de commande » comme module à part ;
 *   - la détentrice de la caisse ne peut rien confirmer avant le versement.
 *
 * Décor propre à la spec (préfixe `__e2e8__`), retiré au début et à la fin. Le service des moyens
 * généraux est un réglage GLOBAL : la spec l'écrit pour de vrai, puis le restaure à la valeur
 * qu'elle a LUE avant d'y toucher (§118.170).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e8__";
const SA_EMAIL = `${P}sa@test.dz`;
const RH_EMAIL = `${P}rh@test.dz`;
const FIN_EMAIL = `${P}fin@test.dz`;
const CAISSE_EMAIL = `${P}caisse@test.dz`;
const ENTITE = `${P}ADV`;
const COMPTE = `${P} SGA Birkhadem — Adventum`;
/** Une année à elle : la liste « à imputer » n'y voit que le décor de la spec, pas la base entière. */
const ANNEE_BUDGET = 2041;
const FACTURE = `${P} Facture location de voiture`;
const REMISE_LIBELLE = `Caisse d'avance — ${P} Administration (juin ${ANNEE_BUDGET})`;
const CAPTURES = process.env.E2E_CAPTURES ?? "";

let companyId = "";
let deptId = "";
let envelopeId = "";
let factureId = "";
let serviceAvant: string | null = null;

const maintenant = new Date();
const ANNEE = maintenant.getFullYear();
const MOIS = maintenant.getMonth() + 1;
const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const LIBELLE_PAIE = `Paie ${NOMS_MOIS[MOIS - 1]} ${ANNEE} — ${ENTITE}`;
/** « d'octobre 2026 » / « de septembre 2026 » — la phrase que la RH lit après avoir cliqué. */
const deMoisLu = `${/^[aeiouyàâéèêîôû]/i.test(NOMS_MOIS[MOIS - 1]!) ? "d'" : "de "}${NOMS_MOIS[MOIS - 1]} ${ANNEE}`;

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

async function capture(page: Page, nom: string, cible?: ReturnType<Page["locator"]>) {
  if (!CAPTURES) return;
  if (cible) await cible.screenshot({ path: `${CAPTURES}/${nom}.png` });
  else await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

async function sansDebordement(page: Page) {
  const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
  expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
}

/**
 * DÉPLIER UN PÔLE DU MENU, comme une personne. Un pôle de plus de cinq entrées naît replié, et
 * replié il ne REND pas ses liens : chercher « Bons de commande » sans déplier prouverait une
 * absence qui n'est qu'un pli — et « la RH n'a pas le lien » passerait au vert sans rien mesurer.
 */
async function deplierPole(page: Page, libelle: string) {
  const bouton = page.locator("[data-app-sidebar] nav button[aria-expanded]").filter({ hasText: libelle }).first();
  await expect(bouton).toBeVisible();
  if ((await bouton.getAttribute("aria-expanded")) === "false") await bouton.click();
  await expect(bouton).toHaveAttribute("aria-expanded", "true");
}

/** Le montant autorisé et pas encore payé, porté par le bloc « Solde bancaire » (`data-a-payer`, Banque & paiements 24/11/2026). */
async function autorisesARegler(page: Page): Promise<number> {
  const valeur = await page.locator("[data-a-payer]").first().getAttribute("data-a-payer");
  return Number(valeur ?? "NaN");
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const entites = await prisma.company.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const entiteIds = entites.map((c) => c.id);
  const depts = await prisma.department.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const deptIds = depts.map((d) => d.id);
  const comptes = await prisma.treasuryAccount.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const compteIds = comptes.map((c) => c.id);
  const ordres = await prisma.expenseOrder.findMany({
    where: { OR: [{ label: { contains: P } }, { companyId: { in: entiteIds } }] }, select: { id: true, transactionId: true },
  });
  const ordreIds = ordres.map((o) => o.id);
  const remises = await prisma.pettyCashAllotment.findMany({ where: { departmentId: { in: deptIds } }, select: { transactionId: true } });
  const txIds = [
    ...ordres.map((o) => o.transactionId), ...remises.map((r) => r.transactionId),
  ].filter((v): v is string => Boolean(v));
  await prisma.payrollWire.deleteMany({ where: { companyId: { in: entiteIds } } });
  await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ordreIds } }, { title: { contains: P } }] } });
  await prisma.expenseOrder.deleteMany({ where: { id: { in: ordreIds } } });
  await prisma.financeTransaction.deleteMany({
    where: { OR: [{ id: { in: txIds } }, { label: { contains: P } }, { treasuryAccountId: { in: compteIds } }, { companyId: { in: entiteIds } }] },
  });
  await prisma.deletedRecord.deleteMany({ where: { name: { contains: P } } });
  await prisma.treasuryAccount.deleteMany({ where: { id: { in: compteIds } } });
  await prisma.payrollEntry.deleteMany({ where: { employee: { companyId: { in: entiteIds } } } });
  await prisma.departmentBudget.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.employee.deleteMany({ where: { OR: [{ companyId: { in: entiteIds } }, { userId: { in: ids } }] } });
  const enveloppes = await prisma.budgetEnvelope.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: enveloppes.map((e) => e.id) } } });
  await prisma.budgetEnvelope.deleteMany({ where: { id: { in: enveloppes.map((e) => e.id) } } });
  await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.userCompanyAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: entiteIds } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  serviceAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { generalMeansDepartmentId: true } }))?.generalMeansDepartmentId ?? null;
  const hash = await bcrypt.hash(E2E.password, 10);
  const creer = (email: string, name: string, role: string) =>
    prisma.user.create({ data: { email, name, passwordHash: hash, role: role as never } });
  await creer(SA_EMAIL, `${P} Super Admin`, "SUPER_ADMIN");
  const rh = await creer(RH_EMAIL, `${P} Ressources humaines`, "DIRECTION_ASSISTANT");
  await creer(FIN_EMAIL, `${P} Responsable Finances`, "FINANCE_BUDGET_MANAGER");
  const caisse = await creer(CAISSE_EMAIL, `${P} Assistante caisse`, "DIRECTION_ASSISTANT");

  companyId = (await prisma.company.create({ data: { name: `${P} Adventum`, shortName: ENTITE } })).id;
  deptId = (await prisma.department.create({ data: { name: `${P} Administration`, code: `${P}ADM`, companyId } })).id;
  // LA RH N'A QUE LE MODULE RH ET NE VOIT QUE SON ENTITÉ : sans vue globale (§118.104).
  await prisma.userAccess.create({ data: { userId: rh.id, module: "RH", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
  await prisma.employee.create({ data: { fullName: `${P} Ressources humaines`, userId: rh.id, companyId, departmentId: deptId } });
  await prisma.userCompanyAccess.create({ data: { userId: rh.id, companyId, canEdit: true } });
  await prisma.userAccess.create({ data: { userId: caisse.id, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });

  // DEUX SALAIRES SAISIS pour le mois en cours : c'est ce que la carte de l'entité doit compter.
  for (const [nom, net] of [["Karima", 100_000], ["Yacine", 110_000]] as const) {
    const e = await prisma.employee.create({ data: { fullName: `${P} ${nom}`, companyId, departmentId: deptId, employerCost: 150_000 } });
    await prisma.payrollEntry.create({
      data: {
        employeeId: e.id, year: ANNEE, month: MOIS, status: "PAID", paidDate: new Date(),
        gross: 130_000, net, employerCost: 150_000, employeeNotifyAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  // « À IMPUTER » : une facture sans catégorie, et une REMISE de caisse (ancienne, close) — qui
  // n'est pas une dépense et ne doit plus y figurer.
  envelopeId = (await prisma.budgetEnvelope.create({
    data: { name: `${P} Enveloppe ${ANNEE_BUDGET}`, periodStart: new Date(`${ANNEE_BUDGET}-01-01`), periodEnd: new Date(`${ANNEE_BUDGET}-12-31`), totalAmount: 5_000_000 },
  })).id;
  await prisma.budgetCategoryLine.create({ data: { envelopeId, name: `${P} Location`, allocated: 5_000_000 } });
  const jour = new Date(`${ANNEE_BUDGET}-06-15T10:00:00Z`);
  factureId = (await prisma.financeTransaction.create({
    data: { reference: `${P}FIN-1`, direction: "OUT", category: "AUTRE", label: FACTURE, amount: 375_000, status: "SETTLED", date: jour },
  })).id;
  const remiseTx = await prisma.financeTransaction.create({
    data: { reference: `${P}FIN-2`, direction: "OUT", category: "AUTRE", label: REMISE_LIBELLE, amount: 24_000, status: "SETTLED", date: jour },
  });
  await prisma.pettyCashAllotment.create({
    data: { departmentId: deptId, period: `${ANNEE_BUDGET}-06`, amount: 24_000, status: "CLOSED", transactionId: remiseTx.id },
  });

  // LE SERVICE DES MOYENS GÉNÉRAUX : celui de la spec, le temps de la spec.
  await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", generalMeansDepartmentId: deptId }, update: { generalMeansDepartmentId: deptId } });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await prisma.appSetting.update({ where: { id: "global" }, data: { generalMeansDepartmentId: serviceAvant } }).catch(() => {});
  await nettoyer();
  await prisma.$disconnect();
});

test("COMPTES ANCRÉS : le Super Admin ouvre un compte depuis un relevé — banque, RIB, entité, solde au jour du relevé", async ({ page }) => {
  // Le premier parcours après un build propre paie le démarrage à froid (§118.124b).
  test.setTimeout(120_000);
  await login(page, SA_EMAIL);
  await aller(page, "/finances/comptabilite");
  await page.getByRole("button", { name: "Comptes de trésorerie" }).click();
  const panneau = page.getByRole("dialog");
  await panneau.getByRole("button", { name: "Ouvrir un compte" }).click();
  await panneau.getByLabel("Nom du compte").fill(COMPTE);
  await panneau.getByLabel("Banque / agence").fill("SGA Birkhadem");
  await panneau.getByLabel("RIB").fill("02100012113006233628");
  await panneau.getByLabel(/Solde du relevé/).fill("2966153");
  await panneau.getByLabel("Date du relevé").fill("2026-09-28");
  await panneau.locator('select[name="companyId"]').selectOption({ label: ENTITE });
  await panneau.getByRole("button", { name: "Ouvrir le compte" }).click();

  const ligne = panneau.locator(`[data-compte="${COMPTE}"]`);
  await expect(ligne).toBeVisible({ timeout: 15_000 });
  // L'ANCRE : le solde du relevé, à sa date — jamais réécrit par une ouverture.
  await expect(ligne).toContainText(/Ancré à 2[\s  ]966[\s  ]153/);
  await expect(ligne).toContainText("28/09/2026");
  await expect(ligne).toContainText("RIB 02100012113006233628");
  await capture(page, "f1-compte-ancre", ligne);

  const enBase = await prisma.treasuryAccount.findFirstOrThrow({ where: { name: COMPTE } });
  expect(Number(enBase.openingBalance)).toBe(2_966_153);
  expect(enBase.companyId).toBe(companyId);
  expect(enBase.rib).toBe("02100012113006233628");
});

test("BONS DE COMMANDE : un module À PART — le financier le trouve au menu, l'ancienne adresse y mène, la RH n'y entre pas", async ({ page }) => {
  await login(page, FIN_EMAIL);
  await aller(page, "/");
  await deplierPole(page, "Administration");
  const menu = page.locator("[data-app-sidebar]");
  const lien = menu.getByRole("link", { name: "Bons de commande", exact: true });
  await expect(lien).toHaveAttribute("href", "/bons-de-commande");
  // Le module ne vit plus SOUS les Finances : le sous-menu des Finances ne le porte plus.
  await expect(menu.locator('a[href="/finances/bons-de-commande"]')).toHaveCount(0);
  await lien.click();
  await expect(page).toHaveURL(/\/bons-de-commande$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Bons de commande/);
  // L'ANCIENNE ADRESSE — celle des notifications déjà envoyées — mène au module, elle ne meurt pas.
  await aller(page, "/finances/bons-de-commande");
  await expect(page).toHaveURL(/\/bons-de-commande$/);

  // La RH n'a pas le module : la porte la renvoie, et le menu DÉPLIÉ ne le lui propose pas.
  await page.context().clearCookies();
  await login(page, RH_EMAIL);
  await aller(page, "/bons-de-commande");
  await expect(page).not.toHaveURL(/\/bons-de-commande$/);
  await deplierPole(page, "Administration");
  // Témoin : le pôle déplié montre bien ses liens à elle (Ressources humaines) — sans lui, « aucun lien Bons
  // de commande » se lirait aussi sur un menu qui ne rend rien (§118.17).
  await expect(page.locator("[data-app-sidebar]").getByRole("link", { name: "Ressources humaines" }).first()).toBeVisible();
  await expect(page.locator("[data-app-sidebar]").getByRole("link", { name: "Bons de commande", exact: true })).toHaveCount(0);
});

test("À IMPUTER : le Super Admin supprime une écriture — et une remise de caisse n'y figure plus", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, `/budgets/depenses?env=${envelopeId}`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "À imputer" }) });
  await expect(section.getByText(FACTURE)).toBeVisible();
  // La remise est un CHANGEMENT DE TIROIR, pas une dépense : ses achats s'imputent un par un.
  await expect(section.getByText(REMISE_LIBELLE)).toHaveCount(0);

  await section.getByRole("checkbox", { name: `Sélectionner ${P}FIN-1` }).check();
  await section.getByRole("button", { name: /Supprimer la sélection \(1\)/ }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirmer la suppression des écritures" });
  await expect(confirmation).toContainText("Supprimer 1 écriture");
  await expect(confirmation).toContainText("Corbeille");
  await capture(page, "f2-a-imputer-confirmation", confirmation);
  await confirmation.getByRole("button", { name: /Supprimer définitivement/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /1 écriture supprimée/ })).toBeVisible({ timeout: 15_000 });
  await expect(section.getByText(FACTURE)).toHaveCount(0, { timeout: 15_000 });

  expect(await prisma.financeTransaction.count({ where: { id: factureId } })).toBe(0);
  expect(await prisma.deletedRecord.count({ where: { sourceId: factureId, restoredAt: null } })).toBe(1);
});

test("PAIE : la RH envoie la paie de SON entité, avec la somme des salaires à virer — jamais pré-remplie", async ({ page }) => {
  await login(page, RH_EMAIL);
  await aller(page, "/rh/paie");
  const carte = page.locator(`[data-entite="${ENTITE}"]`);
  await expect(carte).toContainText("2 salaires saisis à envoyer");
  // La matrice, AVANT : la saisie est une saisie — pas un versement.
  const ligneKarima = page.locator("tr").filter({ hasText: `${P} Karima` });
  await expect(ligneKarima).toContainText("Saisi");
  const somme = carte.getByLabel(/Somme des salaires à virer/);
  // OBLIGATOIRE ET JAMAIS PRÉ-REMPLIE : c'est l'attestation des RH (§118.108).
  await expect(somme).toHaveValue("");
  await expect(somme).toHaveAttribute("required", "");
  await somme.fill("215 000");
  await expect(carte).toContainText(/écart \+5[\s  ]000/);
  await capture(page, "f3-paie-carte", carte);
  await cliquerDecisif(carte.getByRole("button", { name: `Envoyer la paie au centre — ${ENTITE}` }));
  await expect(carte.getByRole("status")).toContainText(`La paie ${deMoisLu} de ${ENTITE} est envoyée au centre de paiement`, { timeout: 15_000 });
  await expect(carte).toContainText("en attente du centre de paiement", { timeout: 15_000 });
  // Un seul envoi à la fois : le bouton s'est refermé, et la carte dit pourquoi.
  await expect(carte.getByRole("button", { name: /Envoyer/ })).toHaveCount(0);
  // La matrice, APRÈS : « Envoyé » — plus « Saisi », et jamais « Viré » avant que l'argent parte.
  await expect(ligneKarima).toContainText("Envoyé");
  await expect(ligneKarima).not.toContainText("Saisi");
  await expect(ligneKarima).not.toContainText("Viré");

  const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId }, include: { expenseOrder: true } });
  expect(Number(wire.amount)).toBe(215_000);
  expect(wire.expenseOrder?.centralStatus).toBe("AWAITING");
  expect(wire.expenseOrder?.label).toBe(LIBELLE_PAIE);

  // Au téléphone, la page ne déborde pas : la matrice défile DANS son cadre.
  await page.setViewportSize({ width: 375, height: 800 });
  await aller(page, "/rh/paie");
  await sansDebordement(page);
});

test("CENTRE : la paie s'autorise comme tout paiement — et le solde de trésorerie la retranche", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, "/finances/paiements-a-faire");
  const avant = await autorisesARegler(page);

  // L'entité se choisit EN HAUT (§118.211) : la paie de l'entité du décor se range dans « Autres ».
  await aller(page, `/centre-de-paiement?entite=${companyId}&section=autres`);
  const ligne = page.locator("li").filter({ hasText: LIBELLE_PAIE }).filter({ has: page.getByRole("button", { name: "Autoriser" }) }).first();
  await expect(ligne).toBeVisible();
  // L'origine s'ouvre : la paie de l'entité, là où se lit ce qui est saisi, envoyé, viré.
  await expect(ligne.getByRole("link", { name: /Paie/ }).last()).toHaveAttribute("href", "/rh/paie");
  await ligne.getByRole("button", { name: "Autoriser" }).click();
  await cliquerDecisif(page.getByRole("dialog").getByRole("button", { name: "Autoriser le paiement" }));
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

  await aller(page, "/finances/paiements-a-faire");
  const apres = await autorisesARegler(page);
  expect(apres - avant, "le solde de trésorerie retranche la paie autorisée, au dinar près").toBe(215_000);
  await expect(page.getByText(LIBELLE_PAIE).first()).toBeVisible();
});

test("CAISSE D'AVANCE : la remise part au centre — la détentrice ne confirme rien avant le versement", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, "/moyens-generaux");
  // Le service n'a AUCUNE caisse ouverte (sa seule remise est soldée) : l'écran propose la remise
  // d'emblée, sans bouton intermédiaire.
  const formulaire = page.locator("form").filter({ hasText: "Remettre une somme en caisse" });
  await expect(formulaire).toBeVisible();
  await formulaire.locator('input[name="amount"]').fill("24000");
  await formulaire.locator('select[name="holderId"]').selectOption({ label: `${P} Assistante caisse` });
  await formulaire.getByRole("button", { name: "Envoyer au centre de paiement" }).click();
  // La phrase porte la RÉFÉRENCE de l'ordre : c'est ce qu'on suit ensuite au centre de paiement.
  await expect(page.getByText(/Remise de 24[\s  ]000 DZD envoyée au centre de paiement \(/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/en attente du centre de paiement/i).first()).toBeVisible({ timeout: 15_000 });

  const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId, status: "ALLOTTED" }, include: { expenseOrder: true } });
  expect(remise.transactionId, "écrire la sortie avant l'autorisation, c'est inscrire un décaissement que personne n'a autorisé").toBeNull();
  expect(remise.expenseOrder?.centralStatus).toBe("AWAITING");
  expect(remise.expenseOrder?.companyId).toBe(companyId);

  await page.context().clearCookies();
  await login(page, CAISSE_EMAIL);
  await aller(page, "/moyens-generaux");
  await expect(page.getByText(/en attente du centre de paiement/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /J'ai reçu la somme/ })).toHaveCount(0);
  await capture(page, "f4-caisse-en-attente");
});
