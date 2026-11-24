import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE COACHING DANS LE NAVIGATEUR (§118.157) — écrans réels, base réelle, zéro appel de
 * modèle, dans la peau de quatre personnes.
 *
 * Le banc de flux (`coaching-actions.test.ts`) prouve la RÈGLE par les vraies actions ; celui-ci
 * prouve qu'elle a un ÉCRAN (§118.50) : l'onglet est dans la Promotion médicale, le directeur des
 * opérations y administre la grille, le superviseur remplit la fiche en cliquant les niveaux et
 * voit le total bouger, le classeur se télécharge, le KAM retrouve SA fiche — et son collègue ne
 * la trouve pas, même par l'adresse.
 *
 * Décor propre à la spec (préfixe `__e2e__`), retiré à la fin — y compris la version de grille
 * que le directeur des opérations publie, pour que la base ressorte avec la grille d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const DO_EMAIL = "__e2e__do-coaching@test.dz";
const NS_EMAIL = "__e2e__ns-coaching@test.dz";
const KAM_EMAIL = "__e2e__kam-coaching@test.dz";
const PAIR_EMAIL = "__e2e__pair-coaching@test.dz";
const KAM_NOM = "__e2e__ Amel Coaching";
const BU = "__e2e__ BU Coaching";
const CAPTURES = process.env.E2E_CAPTURES ?? "";
let ficheId = "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  // 60 s : la toute première connexion après un build propre est lente (§118.124b, mesuré 22,5 s).
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

/**
 * Choisir un niveau COMME UNE PERSONNE : on clique la LIGNE visible du critère, jamais la case
 * radio elle-même — elle est masquée (1 px, `sr-only`) pour les lecteurs d'écran et le clavier.
 * Mesuré : un clic forcé sur la case n'atteint rien (le point visé est vide), alors que la ligne,
 * le clavier (Espace, flèches) et le second clic qui retire la note fonctionnent. Un banc qui
 * force la case éprouve un geste que personne ne fait.
 */
async function choisirNiveau(page: Page, nom: RegExp) {
  const caseRadio = page.getByRole("radio", { name: nom });
  await caseRadio.locator("xpath=ancestor::label[1]").click();
  await expect(caseRadio).toBeChecked();
}

async function capture(page: Page, nom: string) {
  if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

async function nettoyer() {
  const emails = [DO_EMAIL, NS_EMAIL, KAM_EMAIL, PAIR_EMAIL];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.coachingSheet.deleteMany({ where: { OR: [{ collaboratorId: { in: ids } }, { createdById: { in: ids } }] } });
  await prisma.coachingGrid.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } });
  await prisma.businessUnit.deleteMany({ where: { name: BU } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const creer = (email: string, name: string, role: string) =>
    prisma.user.create({ data: { email, name, passwordHash: hash, role: role as never } });
  await creer(DO_EMAIL, "__e2e__ Directeur des Opérations", "OPERATIONS_DIRECTOR");
  const ns = await creer(NS_EMAIL, "__e2e__ National Sales", "NATIONAL_SALES");
  const kam = await creer(KAM_EMAIL, KAM_NOM, "MEDICAL_DELEGATE");
  const pair = await creer(PAIR_EMAIL, "__e2e__ Collègue KAM", "MEDICAL_DELEGATE");
  const bu = await prisma.businessUnit.create({ data: { name: BU, supervisorId: ns.id } });
  await prisma.salesRepProfile.createMany({
    data: [{ repId: kam.id, businessUnitId: bu.id, region: "Est" }, { repId: pair.id, businessUnitId: bu.id }],
  });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("le directeur des opérations trouve l'onglet Coaching dans la Visite médicale, et administre la grille", async ({ page }) => {
  await login(page, DO_EMAIL);
  // « Ma journée » est l'écran du délégué : le directeur des opérations y est renvoyé vers son Cockpit (11/2026) ;
  // il ouvre le module par le plan de tournée, qui porte les mêmes onglets.
  await page.goto("/medical/plan-de-tournee");
  await page.getByRole("link", { name: "Coaching", exact: true }).first().click();
  await expect(page).toHaveURL(/\/medical\/coaching$/);
  await expect(page.getByRole("heading", { name: "Coaching — tournées en double" })).toBeVisible();
  await expect(page.getByText(/Vous administrez cette grille/)).toBeVisible();
  await capture(page, "1-do-liste");

  await page.getByRole("link", { name: /Administrer la grille/ }).click();
  await expect(page.getByRole("heading", { name: /Grille d'évaluation/ })).toBeVisible();
  const titreA = page.getByLabel("Titre de l'axe 1");
  await expect(titreA).toHaveValue("A. Préparation de la visite");
  await expect(page.getByLabel("Titre de l'axe 5")).toHaveValue("E. Conclusion & Engagement");
  await capture(page, "2-do-grille");

  // Une faute se voit AVANT l'envoi, et le bouton reste fermé tant qu'elle est là.
  await titreA.fill("");
  await expect(page.getByText(/Axe n° 1 : le titre est vide/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Publier la version/ })).toBeDisabled();

  await titreA.fill("A. Préparation et ciblage de la visite");
  await page.getByLabel("Motif de la modification").fill("E2E : reformulation");
  await page.getByRole("button", { name: /Publier la version/ }).click();
  await expect(page.getByText(/publiée — les nouvelles fiches l'utilisent/)).toBeVisible();
  const versions = await prisma.coachingGrid.findMany({ where: { createdBy: { email: DO_EMAIL } } });
  expect(versions).toHaveLength(1);
  expect(JSON.stringify(versions[0]!.content)).toContain("A. Préparation et ciblage de la visite");
});

test("le superviseur remplit la fiche en cliquant les niveaux : le total bouge sous ses yeux, puis il finalise", async ({ page }) => {
  await login(page, NS_EMAIL);
  await page.goto("/medical/coaching");
  await page.getByRole("link", { name: /Nouvelle fiche/ }).click();
  await expect(page).toHaveURL(/\/medical\/coaching\/nouvelle/);

  await page.getByLabel(/^Collaborateur/).selectOption({ label: KAM_NOM });
  // Le secteur se pré-remplit depuis la force de vente.
  await expect(page.getByLabel(/Secteur \/ Région \/ CDR/)).toHaveValue(`Est — BU ${BU}`);
  await page.getByLabel(/Date de la tournée/).fill("2026-09-12");

  // L'exemple du classeur de la Direction : MA, MA, MA, MP, MP → 13 / 20.
  const niveaux: [RegExp, string][] = [
    [/^A\. Préparation et ciblage de la visite — MA/, "MA"],
    [/^B\. Conduite de la visite — MA/, "MA"],
    [/^C\. Écoute Active & Temps de Parole \(70\/30\) — MA/, "MA"],
    [/^D\. Gestion des Objections — MP/, "MP"],
    [/^E\. Conclusion & Engagement — MP/, "MP"],
  ];
  const finaliser = page.getByRole("button", { name: /Finaliser et partager/ });
  await expect(finaliser, "fermé tant qu'un axe manque").toBeDisabled();
  for (const [nom] of niveaux) await choisirNiveau(page, nom);
  const jauge = page.getByRole("progressbar", { name: "Total des points" });
  await expect(jauge).toHaveAttribute("aria-valuenow", "13");
  await expect(page.getByText(/5 \/ 5 axe\(s\) évalué\(s\)/)).toBeVisible();
  // Une note posée par erreur s'enlève d'un second clic — et « Finaliser » se referme aussitôt.
  const derniere = page.getByRole("radio", { name: /^E\. Conclusion & Engagement — MP/ });
  await derniere.locator("xpath=ancestor::label[1]").click();
  await expect(derniere).not.toBeChecked();
  await expect(jauge).toHaveAttribute("aria-valuenow", "11");
  await expect(finaliser).toBeDisabled();
  await choisirNiveau(page, /^E\. Conclusion & Engagement — MP/);
  await expect(jauge).toHaveAttribute("aria-valuenow", "13");
  await expect(finaliser).toBeEnabled();

  await page.getByLabel(/1\. Points Forts Observés/).fill("Préparation soignée, bonne connaissance de l'historique.");
  await page.getByLabel(/2\. Points à Améliorer/).fill("Laisser davantage parler le médecin (70/30).");
  await capture(page, "3-ns-saisie");

  let confirmation = "";
  page.once("dialog", (d) => { confirmation = d.message(); void d.accept(); });
  await finaliser.click();
  // Un vrai identifiant de fiche (cuid) : `/nouvelle` correspond aussi à « des lettres minuscules »,
  // et l'attente se résolvait avant même la redirection — le banc lisait alors l'id « nouvelle ».
  await page.waitForURL(/\/medical\/coaching\/c[a-z0-9]{20,}$/);
  expect(confirmation).toMatch(/pourra la consulter/);
  ficheId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: `Fiche de coaching — ${KAM_NOM}` })).toBeVisible();
  await expect(page.getByText("Finalisée", { exact: true })).toBeVisible();
  // Finalisée, elle ne se modifie plus par son auteur : le bouton n'est pas offert.
  await expect(page.getByRole("link", { name: /Modifier/ })).toHaveCount(0);
  await capture(page, "4-ns-fiche");

  const fiche = await prisma.coachingSheet.findUniqueOrThrow({ where: { id: ficheId }, include: { collaborator: true } });
  expect(fiche.status).toBe("FINALIZED");
  expect(fiche.collaborator.email).toBe(KAM_EMAIL);
  expect(await prisma.notification.count({ where: { userId: fiche.collaboratorId, link: `/medical/coaching/${ficheId}` } })).toBe(1);
});

test("le classeur se télécharge au format de la fiche, avec son total en formule", async ({ page }) => {
  await login(page, NS_EMAIL);
  await page.goto(`/medical/coaching/${ficheId}`);
  const [telechargement] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Télécharger \(Excel\)/ }).click(),
  ]);
  expect(telechargement.suggestedFilename()).toMatch(/^Fiche_coaching_e2e_Amel_Coaching_2026-09-12\.xlsx$/);
  const chemin = await telechargement.path();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(chemin!);
  const ws = wb.getWorksheet("Fiche de coaching")!;
  let total: unknown = null;
  ws.eachRow((row) => row.eachCell((c) => {
    const v = c.value as { formula?: string; result?: unknown } | null;
    if (c.master.address === c.address && v && typeof v === "object" && v.formula?.includes("+")) total = v.result;
  }));
  expect(total).toBe(13);
});

test("le KAM retrouve SA fiche ; son collègue ne la trouve pas, même par l'adresse", async ({ page }) => {
  await login(page, KAM_EMAIL);
  await page.goto("/medical/coaching");
  await expect(page.getByText("Mes fiches de coaching")).toBeVisible();
  await expect(page.getByText("13 / 20").first()).toBeVisible();
  await page.goto(`/medical/coaching/${ficheId}`);
  await expect(page.getByText("Laisser davantage parler le médecin (70/30).")).toBeVisible();
  await expect(page.getByRole("button", { name: /Finaliser|Retirer/ })).toHaveCount(0);
  await capture(page, "5-kam-fiche");

  await page.context().clearCookies();
  await login(page, PAIR_EMAIL);
  await page.goto(`/medical/coaching/${ficheId}`);
  await expect(page.getByText("Laisser davantage parler le médecin (70/30).")).toHaveCount(0);
  await expect(page.getByText(/introuvable|n'existe pas|404/i).first()).toBeVisible();
});

test("le directeur des opérations corrige la fiche finalisée ; la page d'impression la rend sans la coque", async ({ page }) => {
  await login(page, DO_EMAIL);
  await page.goto(`/medical/coaching/${ficheId}`);
  await page.getByRole("link", { name: /Modifier/ }).click();
  await expect(page).toHaveURL(/modifier=1/);
  await choisirNiveau(page, /^D\. Gestion des Objections — MA/);
  await page.getByRole("button", { name: /Enregistrer les modifications/ }).click();
  await page.waitForURL(new RegExp(`/medical/coaching/${ficheId}$`));
  await expect(page.getByRole("progressbar", { name: "Total des points" })).toHaveAttribute("aria-valuenow", "14");
  const n = await prisma.notification.findMany({ where: { link: `/medical/coaching/${ficheId}` }, orderBy: { createdAt: "asc" } });
  expect(n.map((x) => x.title)).toEqual(["Votre fiche de coaching est disponible", "Votre fiche de coaching a été modifiée"]);

  await page.goto(`/impression/coaching/${ficheId}`);
  await expect(page.getByRole("heading", { name: "FICHE DE COACHING – TOURNÉE EN DOUBLE" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Imprimer \/ Enregistrer en PDF/ })).toBeVisible();
  // Pas de menu de l'application sur la feuille à imprimer.
  await expect(page.getByRole("link", { name: "Visite médicale" })).toHaveCount(0);
  await capture(page, "6-impression");
});

test("au téléphone (375 px), la page et la fiche ne défilent pas latéralement", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, NS_EMAIL);
  for (const url of ["/medical/coaching", `/medical/coaching/${ficheId}`, "/medical/coaching/nouvelle"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const debord = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(debord, url).toBeLessThanOrEqual(1);
  }
  await capture(page, "7-mobile-saisie");
});
