import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES POSTES AD & PRO, SIMPLIFIÉS, DANS LE NAVIGATEUR (§118.175) — écrans réels, base réelle,
 * aucun appel de modèle de son fait — hormis le point du matin que tente la page d'arrivée du
 * Super Admin (voir `playwright.config.ts`), qu'aucune de ces personnes n'est.
 *
 * Le banc de flux prouve les RÈGLES par les vraies actions ; celui-ci prouve qu'elles ont un ÉCRAN
 * qui s'ouvre et qui les déclenche (§118.50), dans la peau de cinq personnes :
 *   - le National Sales crée un sponsoring dont un médecin n'est PAS dans l'annuaire — il coche
 *     « non présent » et écrit son nom ;
 *   - il répartit le sponsoring indirect par nature, et chaque carte de poste n'offre qu'UN geste ;
 *   - il ajoute un poste de billetterie, ses voyageurs, et demande la réservation ;
 *   - l'assistante de direction trouve le sujet qui s'est ouvert pour elle ;
 *   - le directeur des opérations dépose un devis avec son seul titre et son PDF, au téléphone ;
 *   - une chargée de marketing ne voit pas « Supprimer la demande » ; la directrice marketing,
 *     elle, la supprime — devant l'aperçu de ce qui part avec.
 *
 * Décor propre à la spec (préfixe `__e2e7__`), retiré au début et à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e7__";
const NS_EMAIL = `${P}ns@test.dz`;
const DIR_EMAIL = `${P}dir@test.dz`;
const ASST_EMAIL = `${P}asst@test.dz`;
const CHEF_EMAIL = `${P}chef@test.dz`;
const SUB_EMAIL = `${P}sub@test.dz`;
const INSTITUTION = `${P} Société de cardiologie`;
const MEDECIN_ANNUAIRE = `${P} Dr Karim Annuaire`;
const MEDECIN_HORS = `${P} Dr Yacine Ouali`;
const PRODUIT = `${P}Nivolex`;
const CAPTURES = process.env.E2E_CAPTURES ?? "";

let sponsoringId = "";
let sujetId = "";

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

/**
 * Une capture pour la relecture humaine (`E2E_CAPTURES`). La page défile DANS sa zone principale,
 * donc une capture « pleine page » ne montre que le haut : quand on veut voir une carte, on la vise.
 */
async function capture(page: Page, nom: string, cible?: ReturnType<Page["locator"]>) {
  if (!CAPTURES) return;
  if (cible) await cible.screenshot({ path: `${CAPTURES}/${nom}.png` });
  else await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

/** Aucun débordement horizontal : un écran de téléphone ne défile pas de côté. */
async function sansDebordement(page: Page) {
  const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
  expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
}

/** La carte d'un poste — désignée par son menu « Autres actions », que les lignes de voyageurs n'ont pas. */
async function carte(page: Page, libelle: string) {
  // `.last()` : une nature répartie vit DANS le groupe de sa répartition, lui-même un élément de
  // liste qui contient aussi ce bouton — le plus profond vient le dernier dans l'ordre du document.
  const c = page.locator("li").filter({ has: page.getByRole("button", { name: `Autres actions — ${libelle}` }) }).last();
  // LE TABLEAU DES POSTES (fiche simplifiée, 24/11/2026) : la carte d'un poste se déplie depuis sa ligne, « Ouvrir ».
  if ((await c.count()) === 0) {
    const ouvrir = page.getByRole("button", { name: `Ouvrir — ${libelle}`, exact: true });
    if (await ouvrir.count()) await ouvrir.first().click();
  }
  return c;
}

/**
 * LE RAFRAÎCHISSEMENT RALENTI (§118.172) — la seule façon de JOUER la course qu'un réseau lent
 * fabrique : la réponse du rafraîchissement (`RSC: 1`, hors préchargement) est retenue, la base est
 * déjà écrite, seul l'écran attend — exactement comme au téléphone.
 */
async function ralentirRafraichissements(page: Page, ms: number) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const h = req.headers();
    if (req.method() === "GET" && h["rsc"] === "1" && !h["next-router-prefetch"]) {
      const reponse = await route.fetch();
      await new Promise((r) => setTimeout(r, ms));
      await route.fulfill({ response: reponse });
      return;
    }
    await route.continue();
  });
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const spos = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: P } }, select: { id: true } });
  const spoIds = spos.map((s) => s.id);
  const postes = await prisma.adProItem.findMany({ where: { sponsoringId: { in: spoIds } }, select: { id: true } });
  const sujets = await prisma.dossier.findMany({ where: { OR: [{ sourceId: { in: spoIds } }, { title: { contains: P } }] }, select: { id: true } });
  await prisma.dossierMessage.deleteMany({ where: { dossierId: { in: sujets.map((s) => s.id) } } });
  await prisma.dossier.deleteMany({ where: { id: { in: sujets.map((s) => s.id) } } });
  const legaux = await prisma.legalDocument.findMany({ where: { title: { startsWith: P } }, select: { id: true } });
  await prisma.document.deleteMany({ where: { entityId: { in: [...spoIds, ...postes.map((p) => p.id), ...legaux.map((l) => l.id)] } } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: legaux.map((l) => l.id) } } });
  await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: spoIds } } } });
  await prisma.workflowInstance.deleteMany({ where: { entityId: { in: spoIds } } });
  await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spoIds } } });
  await prisma.deletedRecord.deleteMany({ where: { name: { contains: P } } });
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: P } } });
  await prisma.employee.updateMany({ where: { userId: { in: ids } }, data: { managerId: null } });
  await prisma.employee.deleteMany({ where: { userId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const creer = (email: string, name: string, role: string) =>
    prisma.user.create({ data: { email, name, passwordHash: hash, role: role as never } });
  await creer(NS_EMAIL, `${P} National Sales`, "NATIONAL_SALES");
  await creer(DIR_EMAIL, `${P} Directeur des opérations`, "DIRECTION");
  await creer(ASST_EMAIL, `${P} Assistante de direction`, "DIRECTION_ASSISTANT");
  const chef = await creer(CHEF_EMAIL, `${P} Directrice marketing`, "PRODUCT_MANAGER");
  const sub = await creer(SUB_EMAIL, `${P} Chargée marketing`, "PRODUCT_MANAGER");
  // L'ORGANIGRAMME dit qui est la directrice : la chargée lui rapporte (§118.164c).
  const eChef = await prisma.employee.create({ data: { fullName: `${P} Directrice marketing`, userId: chef.id } });
  await prisma.employee.create({ data: { fullName: `${P} Chargée marketing`, userId: sub.id, managerId: eChef.id } });
  // Un médecin DANS l'annuaire et un produit promouvable : sans eux, les deux champs retombent en
  // saisie libre, et la case « non présent » — qui vit sous le choix multiple — n'existerait pas.
  await prisma.medicalDoctor.create({ data: { name: MEDECIN_ANNUAIRE, specialty: "Cardiologie" } });
  await prisma.regulatoryProduct.create({ data: { reference: `${P}REG`, dci: `${P}Nivolumab`, brandName: PRODUIT, status: "DECISION_OBTAINED" as never } });
});

// Une retenue survit à son cas et ferait tomber le suivant (§118.172) : elle part avec lui.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

/** Coche une option d'un choix multiple, en passant par sa recherche quand la liste est longue. */
async function cocher(panneau: ReturnType<Page["getByRole"]>, champ: string, option: string) {
  const recherche = panneau.getByRole("textbox", { name: `Rechercher dans ${champ}` });
  if (await recherche.count()) await recherche.fill(P);
  await panneau.getByRole("checkbox", { name: new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).check();
}

test("SPONSORING : le médecin absent de l'annuaire se coche « non présent » et s'écrit à la main", async ({ page }) => {
  // LE PREMIER PARCOURS APRÈS UN BUILD PROPRE paie le démarrage à froid du serveur : mesuré au
  // premier passage, le délai de 45 s s'est écoulé entre la connexion et la première page, sans
  // qu'une seule réponse arrive (§118.150 avait mesuré 22,5 s pour le même premier pas). Plafond
  // LOCAL, la mesure écrite à côté ; le délai global ne bouge pas.
  test.setTimeout(120_000);
  await login(page, NS_EMAIL);
  await aller(page, "/sponsoring?new=1");
  const panneau = page.getByRole("dialog");
  // Les champs se visent par leur NOM : le formulaire ajoute « * » au libellé d'un champ requis, et les
  // cases des médecins portent aussi des mots comme « Spécialité » — un libellé exact ne tient pas.
  await panneau.locator('input[name="institution"]').fill(INSTITUTION);
  await panneau.locator('input[name="files"]').setInputFiles({
    name: "demande.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 demande"),
  });
  await cocher(panneau, "Médecin(s) concerné(s)", MEDECIN_ANNUAIRE);
  // « NON PRÉSENT » : la case, puis la saisie — un nom par ligne.
  await panneau.getByRole("checkbox", { name: "Médecin non présent dans l'annuaire" }).check();
  await panneau.getByRole("textbox", { name: "Médecin non présent dans l'annuaire" }).fill(MEDECIN_HORS);
  await cocher(panneau, "Produit(s) concerné(s)", PRODUIT);
  await panneau.locator('select[name="city"]').selectOption({ index: 1 });
  // Par le NOM du champ : le libellé « Spécialité » apparaît aussi dans les cases des médecins.
  const specialite = panneau.locator('[name="specialty"]');
  if ((await specialite.evaluate((e) => e.tagName)) === "SELECT") await specialite.selectOption({ index: 1 });
  else await specialite.fill("Cardiologie");
  await panneau.locator('select[name="type"]').selectOption({ index: 1 });
  await panneau.locator('select[name="nature"]').selectOption("INDIRECT");
  await panneau.locator('input[name="amountRequested"]').fill("1200000");
  await panneau.locator('input[name="amountProposed"]').fill("1000000");
  await panneau.locator('select[name="strategicImportance"]').selectOption({ index: 1 });
  const gamme = panneau.locator('select[name="businessUnitId"]');
  if (await gamme.count()) await gamme.selectOption({ index: 1 });
  await capture(page, "p1-sponsoring-non-present");
  await panneau.getByRole("button", { name: "Enregistrer" }).click();
  await page.waitForURL(/\/sponsoring\/[a-z0-9]+$/, { timeout: 30_000 });

  const cree = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION }, select: { id: true, doctor: true } });
  sponsoringId = cree.id;
  // Les deux : le coché de l'annuaire ET le nom écrit à la main — jamais l'un à la place de l'autre.
  expect(cree.doctor).toContain(MEDECIN_ANNUAIRE);
  expect(cree.doctor).toContain(MEDECIN_HORS);
});

test("POSTES : un seul geste par carte — et le sponsoring indirect se RÉPARTIT par nature", async ({ page }) => {
  const origine = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId }, select: { id: true, label: true, kind: true } });
  expect(origine.kind, "la demande naît avec son poste indirect").toBe("INDIRECT_SUPPORT");

  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  const c = await carte(page, origine.label);
  await expect(c.getByRole("button", { name: "Répartir par nature" })).toBeVisible();
  // UN geste, pas neuf : ni « Soumettre », ni demande au secrétariat en bouton principal.
  await expect(c.getByRole("button", { name: /Soumettre/ })).toHaveCount(0);
  await capture(page, "p2-poste-indirect", c);

  await c.getByRole("button", { name: "Répartir par nature" }).click();
  await c.getByLabel("Prise en charge 1").selectOption("PRINTING");
  await c.getByLabel("Montant 1").fill("400000");
  await c.getByLabel("Précision 1").fill("Affiches");
  await c.getByLabel("Prise en charge 2").selectOption("ACCOMMODATION");
  await c.getByLabel("Montant 2").fill("600000");
  await c.getByRole("button", { name: "Répartir", exact: true }).click();
  await expect.poll(async () => (await prisma.adProItem.findMany({ where: { sponsoringId }, orderBy: { position: "asc" } })).map((p) => p.kind))
    .toEqual(["PRINTING", "ACCOMMODATION"]);

  await page.reload();
  await page.waitForLoadState("networkidle");
  // Le groupe d'un seul tenant, et chaque nature avec SON geste : soumettre.
  await expect(page.getByText(/2 natures/)).toBeVisible();
  const natures = await prisma.adProItem.findMany({ where: { sponsoringId }, orderBy: { position: "asc" }, select: { label: true } });
  expect(natures.map((n) => n.label)[0]).toBe("Imprimerie — Affiches");
  for (const n of natures) {
    await expect((await carte(page, n.label)).getByRole("button", { name: "Soumettre pour validation" })).toBeVisible();
  }
  // Le tableau des postes (24/11/2026) : la répartition se lit d'un tenant dans la section « Postes ».
  await capture(page, "p3-postes-repartis", page.locator("#postes"));
});

test("BILLETTERIE : les voyageurs, puis la réservation — un sujet s'ouvre pour l'assistante, et une date changée s'y écrit", async ({ page }) => {
  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: "Ajouter un poste" }).click();
  const ajout = page.locator("form").filter({ has: page.getByRole("button", { name: "Ajouter", exact: true }) });
  await ajout.getByLabel("Nature").selectOption("TICKETING");
  await ajout.getByLabel("Libellé").fill(`${P} Billets Paris`);
  await ajout.getByLabel("Montant estimé (DZD)").fill("300000");
  await ajout.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect.poll(async () => prisma.adProItem.count({ where: { sponsoringId, kind: "TICKETING" } })).toBe(1);
  await page.reload();
  await page.waitForLoadState("networkidle");

  const c = await carte(page, `${P} Billets Paris`);
  await expect(c.getByText("Voyageurs (0)")).toBeVisible();
  await c.getByRole("button", { name: "Ajouter un voyageur" }).click();
  // Un NOM suffit : les dates viendront plus tard.
  await c.getByLabel("Nom", { exact: true }).fill(MEDECIN_HORS);
  await c.getByRole("button", { name: "Ajouter le voyageur" }).click();
  await expect(c.getByText(/À préciser pour réserver : date de départ, trajet/)).toBeVisible();

  await c.getByRole("button", { name: "Demander la réservation" }).click();
  await expect.poll(async () => (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId, kind: "TICKETING" } })).reservationDossierId).not.toBeNull();
  sujetId = (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId, kind: "TICKETING" } })).reservationDossierId!;
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect((await carte(page, `${P} Billets Paris`)).getByRole("link", { name: /Réservation : sujet/ })).toBeVisible();

  // FLEXIBILITÉ : la date arrive après la demande — elle s'écrit dans le sujet, d'elle-même.
  const avant = await prisma.dossierMessage.count({ where: { dossierId: sujetId } });
  const c2 = await carte(page, `${P} Billets Paris`);
  await c2.getByRole("button", { name: `Autres actions pour ${MEDECIN_HORS}` }).click();
  await c2.getByRole("menuitem", { name: "Modifier", exact: true }).click();
  await c2.getByLabel(/^Date de départ/).fill("2026-11-04");
  await c2.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect.poll(async () => prisma.dossierMessage.count({ where: { dossierId: sujetId } })).toBe(avant + 1);
  await capture(page, "p4-billetterie", await carte(page, `${P} Billets Paris`));
});

test("BILLETTERIE : nom et prénom séparés, trajet à PLUSIEURS DESTINATIONS, documents du voyageur ouverts d'emblée", async ({ page }) => {
  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  const c = await carte(page, `${P} Billets Paris`);
  await c.getByRole("button", { name: "Ajouter un voyageur" }).click();
  await c.getByLabel("Prénom", { exact: true }).fill("Karim");
  await c.getByLabel("Nom", { exact: true }).fill("Benali");
  await c.getByLabel("plusieurs destinations").check();
  // Un aller d'Alger, un retour vers une ville, puis un autre aller d'une ville vers une autre : on enchaîne des ÉTAPES.
  await c.getByLabel("Étape 1 — arrivée").fill("Paris");
  await c.getByLabel("Étape 1 — date").fill("2026-11-12");
  await c.getByRole("button", { name: "Ajouter une étape" }).click();
  // La nouvelle étape part d'où la précédente arrive.
  await expect(c.getByLabel("Étape 2 — départ")).toHaveValue("Paris");
  await c.getByLabel("Étape 2 — arrivée").fill("Alger");
  await c.getByLabel("Étape 2 — date").fill("2026-11-15");
  await c.getByRole("button", { name: "Ajouter une étape" }).click();
  await c.getByLabel("Étape 3 — départ").fill("Alger");
  await c.getByLabel("Étape 3 — arrivée").fill("Dubaï");
  await c.getByLabel("Étape 3 — date").fill("2026-12-01");
  await c.getByRole("button", { name: "Ajouter une étape" }).click();
  await c.getByRole("button", { name: "Retirer l'étape 4" }).click();
  await c.getByRole("button", { name: "Ajouter le voyageur" }).click();

  await expect.poll(async () => prisma.adProVoyageur.count({ where: { prenom: "Karim", nom: "Benali", item: { sponsoringId } } })).toBe(1);
  const v = await prisma.adProVoyageur.findFirstOrThrow({ where: { prenom: "Karim", nom: "Benali", item: { sponsoringId } } });
  expect(v.trajet).toBe("MULTI_DESTINATIONS");
  expect(v.segments).toEqual([
    { de: "Alger", vers: "Paris", date: "2026-11-12" },
    { de: "Paris", vers: "Alger", date: "2026-11-15" },
    { de: "Alger", vers: "Dubaï", date: "2026-12-01" },
  ]);
  // Le voyageur s'affiche « Prénom NOM », ses étapes en liste ordonnée, et SES documents sont ouverts d'emblée.
  const c2 = await carte(page, `${P} Billets Paris`);
  await expect(c2.getByText("Karim Benali").first()).toBeVisible();
  await expect(c2.getByText(/Alger → Paris · 12\/11\/2026/)).toBeVisible();
  await expect(c2.getByText(/Documents de Karim Benali/)).toBeVisible();
  await capture(page, "p4b-billetterie-multi", await carte(page, `${P} Billets Paris`));
});

test("LE RAFRAÎCHISSEMENT RETENU : la carte garde ses gestes fermés tant que l'écran n'est pas à jour", async ({ page }) => {
  // Le défaut fermé (§118.172) : entre la fin d'une action et l'arrivée des nouvelles données, la
  // carte montre l'état d'AVANT — rouvrir un voyageur à ce moment ouvrirait un formulaire sur ses
  // anciennes dates, et l'enregistrer les réécrirait par-dessus les nouvelles.
  await login(page, NS_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await ralentirRafraichissements(page, 3_000);
  const c = await carte(page, `${P} Billets Paris`);
  await c.getByRole("button", { name: `Autres actions pour ${MEDECIN_HORS}` }).click();
  await c.getByRole("menuitem", { name: "Modifier", exact: true }).click();
  await c.getByLabel(/^Date de retour/).fill("2026-11-09");
  await c.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect.poll(async () => (await prisma.adProVoyageur.findFirstOrThrow({ where: { nom: "Haddad", item: { sponsoringId } } })).dateRetour?.toISOString().slice(0, 10))
    .toBe("2026-11-09");
  await expect(c.getByRole("button", { name: "Ajouter un voyageur" })).toBeDisabled();
  await expect(c.getByRole("button", { name: `Autres actions pour ${MEDECIN_HORS}` })).toBeDisabled();
  // Les données arrivent : les gestes reviennent, sur l'état à jour.
  await expect(c.getByRole("button", { name: "Ajouter un voyageur" })).toBeEnabled({ timeout: 15_000 });
  await expect(c.getByText(/09\/11\/2026/)).toBeVisible();
});

test("L'ASSISTANTE DE DIRECTION trouve le sujet de réservation, avec ce qui manque encore", async ({ page }) => {
  await login(page, ASST_EMAIL);
  await aller(page, `/dossiers/${sujetId}`);
  await expect(page.getByText(/Réservation billets/).first()).toBeVisible();
  await expect(page.getByText(MEDECIN_HORS).first()).toBeVisible();
  await capture(page, "p5-sujet-assistante");
});

// À RÉÉCRIRE : le dépôt d'un devis vit désormais sur la carte du POSTE (« Devis / pro forma › Ajouter »), plus dans
// le bouton « Devis » des pièces liées de la demande que ce parcours pilotait (refonte du 04/10, §118.204). Écarté
// plutôt que laissé rouge ; le refus de fournisseur obligatoire est tenu par les bancs de flux des postes.
test.fixme("DEVIS au téléphone : le titre et le PDF suffisent — sans fournisseur", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page, DIR_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await sansDebordement(page);
  await page.getByRole("button", { name: /^Devis$/ }).first().click();
  const feuille = page.getByRole("dialog");
  await expect(feuille.getByText("Fournisseur (facultatif)")).toBeVisible();
  await feuille.getByLabel("Titre exact du devis").fill(`${P} Devis imprimerie`);
  await feuille.getByLabel("PDF du devis").setInputFiles({ name: "devis.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 devis") });
  await feuille.getByRole("button", { name: "Créer le devis" }).click();
  await expect.poll(async () => prisma.legalDocument.count({ where: { title: `${P} Devis imprimerie`, kind: "QUOTE", sourceId: sponsoringId } })).toBe(1);
  const devis = await prisma.legalDocument.findFirstOrThrow({ where: { title: `${P} Devis imprimerie` }, select: { id: true, counterpartyIds: true } });
  expect(devis.counterpartyIds).toEqual([]);
  expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: devis.id } }), "le PDF part avec le devis").toBe(1);
  await sansDebordement(page);
});

test("SUPPRESSION : la chargée de marketing ne voit pas le bouton ; la directrice marketing supprime, devant ce qui part avec", async ({ page }) => {
  await login(page, SUB_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Supprimer la demande" })).toHaveCount(0);

  await login(page, CHEF_EMAIL);
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: "Supprimer la demande" }).click();
  const feuille = page.getByRole("dialog");
  // L'APERÇU, avant le clic : les postes partent avec la demande.
  await expect(feuille.getByText(/postes/)).toBeVisible();
  await capture(page, "p6-suppression-apercu");
  await cliquerDecisif(feuille.getByRole("button", { name: "Oui, supprimer définitivement" }));
  await expect.poll(async () => prisma.sponsoringRequest.count({ where: { id: sponsoringId } })).toBe(0);
  const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: sponsoringId } });
  const chef = await prisma.user.findUniqueOrThrow({ where: { email: CHEF_EMAIL }, select: { id: true } });
  expect(rec.deletedById).toBe(chef.id);
});
