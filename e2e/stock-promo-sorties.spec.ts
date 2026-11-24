import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉTAPES 2 À 4 DU STOCK PROMOTIONNEL DANS LE NAVIGATEUR (§118.165–167) — écrans réels, base
 * réelle, aucun appel de modèle de son fait — hormis le point du matin que tente la page d'arrivée du Super Admin (voir `playwright.config.ts`).
 *
 * Les bancs de flux prouvent les RÈGLES par les vraies actions ; aucun ne prouvait qu'elles ont un
 * ÉCRAN qui s'ouvre et qui les déclenche (§118.50). Ce parcours le fait, dans la peau de quatre
 * personnes :
 *   - le délégué remet du matériel en visite, depuis son téléphone — et au-delà de ce qu'il a en
 *     main, la visite est BLOQUÉE et le DIT (étape 3) ; la remise apparaît « Remis aux médecins » ;
 *   - il compose sa demande d'achat dans le catalogue, avec l'action attendue du fournisseur, puis
 *     demande les devis — et la liste se fige (étape 2) ;
 *   - le National Sales liste le matériel d'un sponsoring, la Direction l'accorde (il est RÉSERVÉ au
 *     magasin), puis il confirme après l'événement et le reste revient (étape 4).
 *
 * Décor propre à la spec (préfixe `__e2e6__`), retiré au début et à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e6__";
const SA_EMAIL = `${P}sa@test.dz`;
const DM_EMAIL = `${P}dm@test.dz`;
const KAM_EMAIL = `${P}kam@test.dz`;
const NS_EMAIL = `${P}ns@test.dz`;
const DIR_EMAIL = `${P}dir@test.dz`;
const ASST_EMAIL = `${P}asst@test.dz`;
const KAM_NOM = `${P} Karim Visite`;
const FICHE = `${P} Fiche posologique`;
const BROCHURE = `${P} Brochure congrès`;
const MEDECIN = `${P} Dr Samia Remise`;
const CAPTURES = process.env.E2E_CAPTURES ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  // 60 s : la toute première connexion après un build propre est lente (§118.124b).
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/**
 * NAVIGUER PUIS ATTENDRE QUE LA PAGE SOIT INTERACTIVE. Un bouton cliqué avant l'hydratation ne fait
 * RIEN — aucune requête ne part (mesuré sur la trace du premier passage : le clic « J'ai tout reçu »
 * n'a déclenché aucun POST) — et le banc accuse alors l'écran d'un défaut qu'il n'a pas.
 */
async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function capture(page: Page, nom: string) {
  if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

/** Aucun débordement horizontal : un écran de téléphone ne défile pas de côté. */
async function sansDebordement(page: Page) {
  const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
  expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
}

/** Le solde d'un détenteur (`null` = le magasin), lu dans le REGISTRE — jamais à l'écran. */
async function solde(holderId: string | null, nom: string): Promise<number> {
  const r = await prisma.promoStockMovement.aggregate({ where: { holderId, item: { catalogue: { nom } } }, _sum: { delta: true } });
  return Number(r._sum.delta ?? 0);
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const spos = await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: P } }, select: { id: true } });
  // Les postes d'abord : leurs lignes de matériel visent les articles en RESTRICT.
  await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: spos.map((s) => s.id) } } });
  await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos.map((s) => s.id) } } });
  // La facture et le BC du dossier en exécution emportent PromoFacture et ses lignes (Cascade).
  await prisma.legalDocument.deleteMany({ where: { reference: { startsWith: P } } });
  const dossiers = await prisma.promoMaterial.findMany({ where: { reference: { startsWith: P } }, select: { id: true } });
  await prisma.promoMaterial.updateMany({ where: { id: { in: dossiers.map((d) => d.id) } }, data: { adminRequestId: null } });
  await prisma.administrativeRequest.deleteMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: dossiers.map((d) => d.id) } } });
  await prisma.promoMaterial.deleteMany({ where: { id: { in: dossiers.map((d) => d.id) } } });
  const medecins = await prisma.medicalDoctor.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  // L'article de stock emporte lots, mouvements (remises comprises) et transferts (Cascade).
  const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: P } }, select: { id: true } });
  if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
  await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: P } } });
  await prisma.medicalVisit.deleteMany({ where: { doctorId: { in: medecins.map((m) => m.id) } } });
  await prisma.medicalDoctor.deleteMany({ where: { id: { in: medecins.map((m) => m.id) } } });
  await prisma.employee.deleteMany({ where: { userId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

let kamId = "", nsId = "", medecinId = "", dossierId = "", sponsoringId = "";
let dossierExecId = "", ligneFactureId = "";

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const creer = (email: string, name: string, role: string) =>
    prisma.user.create({ data: { email, name, passwordHash: hash, role: role as never } });
  await creer(SA_EMAIL, `${P} Super Admin`, "SUPER_ADMIN");
  const dm = await creer(DM_EMAIL, `${P} Directrice Marketing`, "PRODUCT_MANAGER");
  const kam = await creer(KAM_EMAIL, KAM_NOM, "MEDICAL_DELEGATE");
  const ns = await creer(NS_EMAIL, `${P} National Sales`, "NATIONAL_SALES");
  await creer(DIR_EMAIL, `${P} Direction`, "DIRECTION");
  // L'assistante NOMMÉE du dossier : la demande de devis la prévient, elle seule — sans elle, toutes
  // les assistantes de la base seraient prévenues d'un dossier de banc.
  const asst = await creer(ASST_EMAIL, `${P} Assistante`, "DIRECTION_ASSISTANT");
  kamId = kam.id;
  nsId = ns.id;
  // La directrice est la CHEFFE de la Direction Marketing : personne de son rôle au-dessus d'elle.
  await prisma.employee.create({ data: { fullName: `${P} Directrice Marketing`, userId: dm.id } });
  await prisma.employee.create({ data: { fullName: KAM_NOM, userId: kam.id } });
  const catFiche = await prisma.promoCatalogueArticle.create({ data: { reference: `${P}FICHE`, nom: FICHE, famille: "CONSOMMABLE", unite: "pièce" } });
  await prisma.promoCatalogueArticle.create({ data: { reference: `${P}BROCH`, nom: BROCHURE, famille: "CONSOMMABLE", unite: "pièce" } });
  // Le médecin est dans le PANEL du délégué : c'est ce qui le lui fait proposer dans la saisie.
  medecinId = (await prisma.medicalDoctor.create({ data: { name: MEDECIN, delegateId: kam.id } })).id;
  // Un dossier du circuit 2, devis encore à demander : la liste d'articles s'y compose.
  dossierId = (await prisma.promoMaterial.create({
    data: {
      reference: `${P}MP`, title: `${P} Fiches posologiques 2027`, status: "PROSPECTION_REQUESTED",
      circuitState: "QUOTE_TO_REQUEST", circuitVersion: 2, requesterId: kam.id, assistantId: asst.id, createdById: kam.id, updatedById: kam.id,
    },
    select: { id: true },
  })).id;

  // UN DOSSIER EN EXÉCUTION, sa facture déposée : le parcours jusqu'ici (devis transcrits, lignes
  // retenues, validations, BC généré puis signé, facture saisie ligne à ligne) est prouvé par les
  // vraies actions dans `promo-achats-flow.test.ts`. Ce que ce décor pose, c'est l'ÉTAT où la
  // personne coche ce qui est arrivé — l'écran que ce banc existe pour ouvrir.
  dossierExecId = (await prisma.promoMaterial.create({
    data: {
      reference: `${P}MP2`, title: `${P} Fiches imprimées`, status: "PROSPECTION_REQUESTED",
      circuitState: "IN_EXECUTION", circuitVersion: 2, requesterId: kam.id, assistantId: asst.id, createdById: kam.id, updatedById: kam.id,
    },
    select: { id: true },
  })).id;
  const demande = await prisma.promoRequestItem.create({
    data: { promoMaterialId: dossierExecId, catalogueId: catFiche.id, quantite: 100, actions: ["IMPRESSION"] },
    select: { id: true },
  });
  const maintenant = new Date();
  const bc = await prisma.legalDocument.create({
    data: {
      title: `${P} BC imprimerie`, reference: `${P}BC`, kind: "PURCHASE_ORDER", counterparty: `${P} Imprimerie`,
      amount: 2380, signedAt: maintenant, bcCircuitAt: maintenant,
      // CE QUE LE PRODUIT ÉCRIT, à l'identique : la fabrique pose la SOURCE du BC, le dépôt celle de
      // la facture — et la réception d'une ligne la relit. Le premier passage de ce banc l'omettait :
      // l'écran montrait la ligne (il la trouve par la CHAÎNE) et l'action la refusait (elle la
      // trouve par la SOURCE). Un décor qui n'écrit pas ce que le produit écrit fait accuser l'écran.
      sourceType: "PROMO_MATERIAL", sourceId: dossierExecId,
    },
    select: { id: true },
  });
  const devis = await prisma.promoQuote.create({
    data: {
      promoMaterialId: dossierExecId, supplierName: `${P} Imprimerie`, reference: `${P}DEV`, purchaseOrderId: bc.id,
      lines: { create: [{ reference: "Fiche posologique", quantity: 100, unitPrice: 20, selected: true, action: "IMPRESSION", requestItemId: demande.id }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  const facture = await prisma.legalDocument.create({
    data: {
      title: `${P} Facture imprimerie`, reference: `${P}F1`, kind: "INVOICE", counterparty: `${P} Imprimerie`, amount: 2380,
      chainFromId: bc.id, startDate: maintenant, sourceType: "PROMO_MATERIAL", sourceId: dossierExecId,
    },
    select: { id: true },
  });
  ligneFactureId = (await prisma.promoFacture.create({
    data: {
      legalDocumentId: facture.id, quoteId: devis.id, tvaRate: 19, totalImprime: 2380,
      lignes: { create: [{ designation: "Fiche posologique", action: "IMPRESSION", quantite: 100, prixUnitaire: 20, quoteLineId: devis.lines[0]!.id, requestItemId: demande.id }] },
    },
    select: { lignes: { select: { id: true } } },
  })).lignes[0]!.id;
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("le décor par les vrais écrans : le magasin reçoit, la directrice dote le délégué, il confirme", async ({ page }) => {
  await login(page, SA_EMAIL);
  await aller(page, "/stock-promotionnel?vue=magasin");
  for (const [nom, quantite] of [[FICHE, "20"], [BROCHURE, "30"]] as const) {
    await page.getByRole("button", { name: "Entrée manuelle" }).click();
    const panneau = page.getByRole("dialog");
    const choix = panneau.getByLabel(/Article du catalogue/);
    const valeur = await choix.locator("option", { hasText: nom }).getAttribute("value");
    await choix.selectOption(valeur!);
    await panneau.getByLabel(/^Quantité/).fill(quantite);
    await panneau.getByLabel(/D'où vient ce matériel/).fill("E2E — décor des sorties de stock");
    await panneau.getByRole("button", { name: "Entrer au magasin" }).click();
    await expect(page.getByRole("status").filter({ hasText: `+${quantite} au magasin central` })).toBeVisible();
  }

  await login(page, DM_EMAIL);
  await aller(page, "/stock-promotionnel?vue=magasin");
  await page.locator("li", { hasText: FICHE }).first().getByRole("button", { name: "Doter" }).click();
  const panneau = page.getByRole("dialog");
  await panneau.getByLabel(/Personne dotée/).selectOption({ label: KAM_NOM });
  await panneau.getByLabel(/^Quantité/).fill("8");
  await panneau.getByRole("button", { name: "Envoyer" }).click();
  await expect(page.getByRole("status").filter({ hasText: `8 en route vers ${KAM_NOM}` })).toBeVisible();

  await login(page, KAM_EMAIL);
  await aller(page, "/stock-promotionnel");
  await page.getByRole("button", { name: "J'ai tout reçu" }).click();
  await expect(page.getByRole("button", { name: "J'ai tout reçu" })).toHaveCount(0);
  expect(await solde(kamId, FICHE)).toBe(8);
  expect(await solde(null, BROCHURE)).toBe(30);
});

test("ÉTAPE 3 — le délégué remet 3 fiches en visite, depuis son téléphone : elles sortent de SON stock", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, KAM_EMAIL);
  await aller(page, "/medical/ma-journee");
  // LA VISITE HORS PLAN (11/2026) : « Voir un médecin hors plan », puis la feuille « Visite ».
  await page.getByRole("button", { name: "Voir un médecin hors plan" }).click();
  await page.getByRole("dialog").getByPlaceholder(/Nom, spécialité/).fill("Samia Remise");
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(MEDECIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const fiche = page.getByRole("dialog").filter({ hasText: "Visite hors plan" });
  await expect(fiche).toBeVisible();
  await fiche.getByLabel(/Compte rendu/).fill("Remise de trois fiches au Dr.");
  // Replié par défaut (« trois champs, rien de plus ») : « Plus de détails » s'ouvre d'un geste.
  await fiche.getByText("Plus de détails").click();
  await expect(fiche.getByText(/8 en main/)).toBeVisible();
  await fiche.getByLabel(`Quantité remise — ${FICHE}`).fill("3");
  await sansDebordement(page);
  await capture(page, "s1-visite-remise-mobile");
  await fiche.getByRole("button", { name: "Enregistrer la visite" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await solde(kamId, FICHE), "la remise sort du stock du délégué, et de lui seul").toBe(5);
  expect(await prisma.medicalVisit.count({ where: { doctorId: medecinId } })).toBe(1);
});

test("ÉTAPE 3 — au-delà de ce qu'il a en main, la visite est BLOQUÉE et l'écran le DIT", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, KAM_EMAIL);
  await aller(page, "/medical/ma-journee");
  await page.getByRole("button", { name: "Voir un médecin hors plan" }).click();
  await page.getByRole("dialog").getByPlaceholder(/Nom, spécialité/).fill("Samia Remise");
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(MEDECIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const fiche = page.getByRole("dialog").filter({ hasText: "Visite hors plan" });
  await fiche.getByLabel(/Compte rendu/).fill("Remise de cinquante fiches.");
  await fiche.getByText("Plus de détails").click();
  await fiche.getByLabel(`Quantité remise — ${FICHE}`).fill("50");
  await fiche.getByRole("button", { name: "Enregistrer la visite" }).click();
  // Le refus est DANS la fiche : l'annonceur de route de Next.js porte aussi `role="alert"` (§118.159f).
  await expect(fiche.getByRole("alert")).toContainText("Rien n'est enregistré");
  await capture(page, "s2-visite-bloquee-mobile");
  expect(await solde(kamId, FICHE), "rien n'est sorti").toBe(5);
  expect(await prisma.medicalVisit.count({ where: { doctorId: medecinId } }), "ni la visite").toBe(1);
});

test("ÉTAPE 3 — la remise apparaît dans « Remis aux médecins »", async ({ page }) => {
  await login(page, KAM_EMAIL);
  await aller(page, "/stock-promotionnel?vue=medecins");
  await expect(page.getByRole("tab", { name: /Remis aux médecins/ })).toHaveAttribute("aria-selected", "true");
  const ligne = page.locator("li", { hasText: MEDECIN });
  await expect(ligne).toContainText(`3 ${FICHE}`);
  await capture(page, "s3-remis-aux-medecins");
});

test("ÉTAPE 2 — le délégué compose sa demande d'achat dans le catalogue, demande les devis, et la liste se fige", async ({ page }) => {
  await login(page, KAM_EMAIL);
  await aller(page, `/promo-material/${dossierId}`);
  await page.getByRole("button", { name: "Ajouter un article du catalogue" }).click();
  const panneau = page.getByRole("dialog");
  const choix = panneau.getByLabel(/Article du catalogue/);
  const valeur = await choix.locator("option", { hasText: FICHE }).getAttribute("value");
  await choix.selectOption(valeur!);
  // Une fiche se conçoit PUIS s'imprime : deux actions sur la même ligne (§118.165).
  await panneau.getByLabel(/^Conception —/).check();
  await panneau.getByLabel(/^Impression —/).check();
  await panneau.getByLabel(/Quantité souhaitée/).fill("500");
  await panneau.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const article = page.locator("li", { hasText: FICHE });
  await expect(article).toContainText("Conception");
  await expect(article).toContainText("Impression");
  await capture(page, "s4-articles-demandes");
  const ligne = await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: dossierId } });
  expect([...ligne.actions].sort()).toEqual(["CONCEPTION", "IMPRESSION"]);
  expect(Number(ligne.quantite)).toBe(500);

  await page.getByRole("button", { name: /Demander les devis à l.assistante de direction/ }).click();
  await expect.poll(async () => (await prisma.promoMaterial.findUniqueOrThrow({ where: { id: dossierId } })).circuitState).toBe("QUOTE_REQUESTED");
  await page.reload();
  // LA LISTE SE FIGE une fois les devis demandés : l'assistante chiffre ce qui a été demandé.
  await expect(page.getByRole("button", { name: "Ajouter un article du catalogue" })).toHaveCount(0);
  await expect(page.locator("li", { hasText: FICHE })).toBeVisible();
});

test("ÉTAPE 2 — le demandeur coche ce qui est ARRIVÉ : un lot entre au magasin, au coût de la facture", async ({ page }) => {
  await login(page, KAM_EMAIL);
  await aller(page, `/promo-material/${dossierExecId}`);
  const facture = page.locator("div", { hasText: `Facture ${P}F1` }).filter({ has: page.getByRole("table") }).last();
  await expect(facture).toContainText("1 ligne(s) à réceptionner");
  await facture.getByRole("button", { name: "Réceptionner" }).click();
  // Partielle : 90 fiches arrivées sur 100 facturées — on coche ce qui est là, pas ce qui est dû.
  await facture.getByLabel("Quantité reçue").fill("90");
  await capture(page, "s5-reception");
  await facture.getByRole("button", { name: "Confirmer", exact: true }).click();
  await expect.poll(async () => Number((await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: ligneFactureId } })).quantiteRecue ?? 0)).toBe(90);
  const ligne = await prisma.promoFactureLigne.findUniqueOrThrow({ where: { id: ligneFactureId }, include: { stockLot: true } });
  expect(ligne.recueParId, "c'est le demandeur qui atteste la réception").toBe(kamId);
  expect(ligne.stockLot, "un lot est entré au magasin").not.toBeNull();
  expect(Number(ligne.stockLot!.coutUnitaire), "au coût de la facture").toBe(20);
  const entree = await prisma.promoStockMovement.aggregate({ where: { lotId: ligne.stockLotId!, holderId: null }, _sum: { delta: true } });
  expect(Number(entree._sum.delta ?? 0)).toBe(90);
  await page.reload();
  // Dans la FACTURE : la ligne du devis retenu porte aussi « Fiche posologique » — deux lignes
  // du même nom, deux tableaux, et seule celle de la facture dit ce qui est arrivé.
  await expect(facture.locator("tr", { hasText: "Fiche posologique" })).toContainText("90 reçue(s)");
});

test("ÉTAPE 4 — le National Sales liste le matériel d'un sponsoring, la Direction l'accorde et le RÉSERVE", async ({ page }) => {
  // Le sponsoring pioche dans le magasin de SA société : celle où le magasin vient de recevoir.
  const broch = await prisma.promoStockItem.findFirstOrThrow({ where: { catalogue: { nom: BROCHURE } }, select: { companyId: true } });
  sponsoringId = (await prisma.sponsoringRequest.create({
    data: {
      reference: `${P}SPO`, institution: `${P} Société algérienne d'oncologie`, type: "Congrès",
      status: "PRE_VALIDATED", requesterId: nsId, companyId: broch.companyId,
    },
    select: { id: true },
  })).id;

  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: "Ajouter un poste" }).click();
  const ajout = page.locator("form").filter({ has: page.getByRole("button", { name: "Ajouter", exact: true }) });
  await ajout.getByLabel("Nature").selectOption({ label: "Matériel du stock" });
  await ajout.getByLabel("Libellé").fill("Matériel du stand");
  await ajout.getByRole("button", { name: "Ajouter", exact: true }).click();

  const bloc = page.locator("div", { hasText: "Matériel pris au magasin" }).filter({ has: page.getByRole("button", { name: /Lister/ }) }).last();
  const article = bloc.getByLabel("Article du magasin");
  const valeur = await article.locator("option", { hasText: BROCHURE }).getAttribute("value");
  await article.selectOption(valeur!);
  await bloc.getByLabel("Quantité").fill("10");
  await bloc.getByRole("button", { name: /Lister/ }).click();
  await expect(bloc.locator("li", { hasText: BROCHURE })).toContainText("10");
  // Rien ne sort du magasin avant l'accord.
  expect(await solde(null, BROCHURE)).toBe(30);
  await page.getByRole("button", { name: "Soumettre à la Direction" }).click();
  await expect.poll(async () => (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId } })).status).toBe("PENDING");
  await capture(page, "s5-poste-materiel-liste");

  await login(page, DIR_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: "Décider de ce poste" }).click();
  await cliquerDecisif(page.getByRole("button", { name: "Accorder et réserver" }));
  await expect.poll(async () => (await prisma.adProStockLine.findFirstOrThrow({ where: { item: { sponsoringId } } })).statut).toBe("RESERVEE");
  expect(await solde(null, BROCHURE), "l'accord RÉSERVE : le matériel quitte le magasin").toBe(20);
});

test("ÉTAPE 4 — après l'événement, il dit ce qui a été remis, et le reste revient au magasin", async ({ page }) => {
  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: /Confirmer le matériel après l.événement/ }).click();
  const formulaire = page.locator("form").filter({ hasText: "Dites ce qui s'est passé pendant l'événement" });
  await formulaire.getByLabel(/Remis pendant l.événement/).fill("7");
  await formulaire.getByRole("button", { name: "Confirmer", exact: true }).click();
  await expect.poll(async () => (await prisma.adProStockLine.findFirstOrThrow({ where: { item: { sponsoringId } } })).statut).toBe("CONFIRMEE");
  expect(await solde(null, BROCHURE), "les 3 brochures non remises reviennent au magasin").toBe(23);
  await page.reload();
  // La ligne de matériel est un élément de liste DANS l'élément du poste : on vise la feuille, celle
  // qui ne contient pas d'autre ligne — le poste entier porterait aussi le nom de la brochure.
  await expect(page.locator("li", { hasText: BROCHURE }).filter({ hasNot: page.locator("li") })).toContainText("7 remis, 3 revenu(s) au magasin");
  await capture(page, "s6-poste-materiel-confirme");
});
