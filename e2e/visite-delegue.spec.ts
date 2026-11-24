import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═════════════════════════════════════════════════════════════════
 * L'INTERFACE DU DÉLÉGUÉ (maquette VALIDÉE le 24/11/2026) — dans le navigateur, au bureau et au téléphone.
 *
 * Le banc de flux (`visite-pv-ecart-flow.test.ts`) prouve les RÈGLES ; celui-ci prouve qu'elles ont un écran :
 *   - « Ma journée » : les chiffres du jour, les comptes rendus en retard, la visite dont l'IA a relevé un possible cas
 *     (« Possible PV — à déclarer ») ;
 *   - le compte rendu envoyé : la phrase relevée, « Déclarer un PV (prérempli) » rattaché à la visite, et « Ce n'est
 *     pas un cas » qui se trace en base ;
 *   - les écrans du délégué (médecins, objectifs, pharmacovigilance, retours, sac, demandes) tiennent debout, sans
 *     défilement latéral à 390 px.
 * Décor propre à la spec (préfixe `__e2evm__`), posé en base et retiré au début et à la fin. `E2E_CAPTURES=<dossier>`
 * enregistre les captures.
 * ═════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2evm__";
const EMAIL = { kam: `${P}kam@test.dz`, sup: `${P}sup@test.dz` };
const EXTRAIT = "Une patiente de 71 ans a fait un malaise avec sueurs dix jours après le passage au traitement";
const CAPTURES = process.env.E2E_CAPTURES ?? "";
/** Contre un serveur de DÉVELOPPEMENT (chaque page se compile au premier passage) : `E2E_LENT=1` allonge les délais. */
const LENT = Boolean(process.env.E2E_LENT);
const u: Record<string, string> = {};
let visitePv = "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: LENT ? 600_000 : 60_000 });
}

async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function capture(page: Page, nom: string) {
  if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

async function sansDebordement(page: Page) {
  const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
  expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
}

async function nettoyer() {
  const ids = (await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })).map((x) => x.id);
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: ids } } });
  await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } });
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.businessUnit.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  u.kam = (await prisma.user.create({ data: { email: EMAIL.kam, name: `${P} Délégué`, passwordHash: hash, role: "MEDICAL_DELEGATE" }, select: { id: true } })).id;
  u.sup = (await prisma.user.create({ data: { email: EMAIL.sup, name: `${P} Superviseur`, passwordHash: hash, role: "NATIONAL_SALES" }, select: { id: true } })).id;
  const bu = await prisma.businessUnit.create({ data: { name: `${P}Cardio-Métabolisme`, supervisorId: u.sup }, select: { id: true } });
  await prisma.salesRepProfile.create({ data: { repId: u.kam, businessUnitId: bu.id } });
  const medecin = (nom: string, specialty: string, institution: string) =>
    prisma.medicalDoctor.create({ data: { name: `${P} ${nom}`, delegateId: u.kam, wilaya: "Blida", specialty, institution }, select: { id: true } });
  const [m1, m2, m3] = await Promise.all([
    medecin("Pr Karim Benali", "Cardiologie", "CHU Frantz-Fanon"),
    medecin("Dr Nadia Cherif", "Endocrinologie", "EPH Boufarik"),
    medecin("Dr Samia Kaci", "Néphrologie", "CHU Frantz-Fanon"),
  ]);
  const a = (jours: number, h: number, m = 0) => { const d = new Date(); d.setDate(d.getDate() + jours); d.setHours(h, m, 0, 0); return d; };
  // CE MATIN, rapportée : l'IA y a relevé un possible cas (la lecture que la tâche de fond écrit).
  visitePv = (await prisma.medicalVisit.create({
    data: {
      date: a(0, 8, 30), doctorId: m2!.id, delegateId: u.kam, status: "COMPLETED", origin: "PLAN", createdById: u.kam,
      report: `${EXTRAIT}. Elle demande la documentation sur l'adaptation de dose.`,
      pvIa: "POSSIBLE", pvIaRaison: "Malaise hypoglycémique possible.", pvIaExtrait: EXTRAIT, prioriteIa: 88, analyseIaLe: new Date(),
    },
    select: { id: true },
  })).id;
  // PLUS TARD, à faire — et une visite d'HIER encore dans sa fenêtre de 48 h.
  await prisma.medicalVisit.create({ data: { date: a(0, 23, 0), doctorId: m1!.id, delegateId: u.kam, status: "PLANNED", origin: "PLAN", objective: "Données LDL ; inviter aux Journées de cardiologie.", createdById: u.kam } });
  await prisma.medicalVisit.create({ data: { date: a(-1, 14, 0), doctorId: m3!.id, delegateId: u.kam, status: "PLANNED", origin: "PLAN", createdById: u.kam } });
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("MA JOURNÉE — les chiffres, le retard, l'alerte de l'IA ; « Ce n'est pas un cas » se trace (bureau)", async ({ page }) => {
  test.setTimeout(LENT ? 1_200_000 : 120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, EMAIL.kam);
  await aller(page, "/medical/ma-journee");
  await expect(page.getByRole("heading", { name: "Ma journée", level: 1 })).toBeVisible();
  await expect(page.getByText("Comptes rendus en retard · 1")).toBeVisible();
  await expect(page.getByText("Possible PV — à déclarer")).toBeVisible();
  await capture(page, "vm-journee-bureau");

  await page.getByRole("button", { name: "Voir", exact: true }).click();
  const feuille = page.getByRole("dialog");
  await expect(feuille.getByText("Possible cas de pharmacovigilance")).toBeVisible();
  await expect(feuille.getByText(`« ${EXTRAIT} »`)).toBeVisible();
  await expect(feuille.getByRole("link", { name: /Déclarer un PV/ })).toHaveAttribute("href", new RegExp(`visite=${visitePv}`));
  await capture(page, "vm-compte-rendu-alerte-bureau");
  await cliquerDecisif(feuille.getByRole("button", { name: "Ce n'est pas un cas" }));
  await expect(feuille.getByText("Vous avez indiqué : pas un cas")).toBeVisible({ timeout: 15_000 });
  const v = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: visitePv }, select: { pvEcarteLe: true, pvEcarteParId: true } });
  expect(v.pvEcarteParId).toBe(u.kam);
  await capture(page, "vm-compte-rendu-ecarte-bureau");
});

test("LES ÉCRANS DU DÉLÉGUÉ — au téléphone, sans défilement latéral ; au bureau", async ({ page }) => {
  test.setTimeout(LENT ? 1_800_000 : 180_000);
  await login(page, EMAIL.kam);
  const ecrans: [string, string][] = [
    ["/medical/ma-journee", "Ma journée"], ["/medical/mes-medecins", "Mes médecins"], ["/medical/objectifs", "Mes objectifs"],
    ["/medical/rapports/pharmacovigilance", "Mes signalements de pharmacovigilance"], ["/medical/retours", "Retours du superviseur"],
    ["/medical/mon-sac", "Mon sac"], ["/medical/mes-demandes", "Mes demandes"], ["/medical/plan-de-tournee", "Plan de tournée"],
  ];
  for (const [largeur, nom] of [[390, "telephone"], [1280, "bureau"]] as const) {
    await page.setViewportSize({ width: largeur, height: 860 });
    for (const [url, titre] of ecrans) {
      await aller(page, url);
      await expect(page.getByRole("heading", { name: titre, level: 1 })).toBeVisible();
      if (largeur === 390) await sansDebordement(page);
      await capture(page, `vm-${url.split("/").pop()}-${nom}`);
    }
  }
});
