import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═════════════════════════════════════════════════════════════════
 * LE PLAN DE TOURNÉE SE RÉVISE, UNE VISITE SE DIT NON TENUE — dans le navigateur (audit 360°, lot C4d2a, §118.193).
 *
 * Le banc de flux (`tournee-revision-flow.test.ts`) prouve les RÈGLES par les vraies actions ; celui-ci prouve
 * qu'elles ont un ÉCRAN qui les déclenche (§118.50), dans la peau du KAM :
 *   - il rouvre son plan validé pour révision, motif à l'appui — le bouton n'est offert qu'une fois le motif écrit ;
 *   - « Mon espace » range le plan dans « À corriger », avec ce qui a été demandé ;
 *   - dans « Ma journée », il dit qu'une visite de demain n'aura pas lieu (annulée, avec son motif), et la ligne
 *     le montre.
 *
 * Décor propre à la spec (préfixe `__e2e16__`), posé en base et retiré au début et à la fin.
 * ═════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e16__";
const EMAIL = { kam: `${P}kam@test.dz`, sup: `${P}sup@test.dz` };
const MOTIF_REVISION = "Le Dr Achour est en congé la semaine du 18.";
const MOTIF_ANNULATION = "Cabinet fermé pour travaux.";

const u: Record<string, string> = {};
let planId = "";
let visiteId = "";

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
  const ids = (await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })).map((x) => x.id);
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: ids } } });
  await prisma.tourPlan.deleteMany({ where: { repId: { in: ids } } });
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  u.kam = (await prisma.user.create({ data: { email: EMAIL.kam, name: `${P} KAM`, passwordHash: hash, role: "MEDICAL_DELEGATE" }, select: { id: true } })).id;
  u.sup = (await prisma.user.create({ data: { email: EMAIL.sup, name: `${P} Superviseur`, passwordHash: hash, role: "NATIONAL_SALES" }, select: { id: true } })).id;
  const doc = await prisma.medicalDoctor.create({ data: { name: `${P} Dr Achour`, delegateId: u.kam, wilaya: "Alger" }, select: { id: true } });
  // Un plan VALIDÉ pour le mois prochain — l'état exact que produit la décision du superviseur.
  const ref = new Date(); ref.setDate(15); ref.setMonth(ref.getMonth() + 1);
  const debut = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const fin = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59);
  planId = (await prisma.tourPlan.create({
    data: {
      repId: u.kam, periodStart: debut, periodEnd: fin, granularity: "MONTH", status: "APPROVED", submissionDueAt: debut,
      reviewerId: u.sup, submittedAt: new Date(), decidedById: u.sup, decidedAt: new Date(), createdById: u.kam,
    },
    select: { id: true },
  })).id;
  // Une visite DEMAIN, hors plan — celle que le KAM dira annulée.
  const demain = new Date(); demain.setDate(demain.getDate() + 1); demain.setHours(9, 0, 0, 0);
  visiteId = (await prisma.medicalVisit.create({
    data: { date: demain, doctorId: doc.id, delegateId: u.kam, status: "PLANNED", origin: "PLAN", createdById: u.kam },
    select: { id: true },
  })).id;
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("RÉVISER — le KAM rouvre son plan validé, motif à l'appui : le plan passe « En révision » et le dit", async ({ page }) => {
  // Le premier parcours après un build propre paie le démarrage à froid du serveur (§118.124b).
  test.setTimeout(120_000);
  await login(page, EMAIL.kam);
  await aller(page, `/medical/plan-de-tournee?plan=${planId}`);
  await page.getByRole("button", { name: "Demander une révision" }).click();
  const rouvrir = page.getByRole("button", { name: "Rouvrir pour révision" });
  // Sans motif, le geste n'est pas offert : c'est ce que lira la personne qui a validé.
  await expect(rouvrir).toBeDisabled();
  await page.getByLabel("Ce qui change dans la tournée").fill(MOTIF_REVISION);
  await cliquerDecisif(rouvrir);
  await expect(page.getByText("Plan validé, rouvert pour révision — à modifier puis resoumettre.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`« ${MOTIF_REVISION} »`)).toBeVisible();
  // L'en-tête du plan dit « à RESOUMETTRE » : « à soumettre » se lirait comme un plan jamais envoyé.
  await expect(page.getByText(/^À resoumettre avant le /)).toBeVisible();
  const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId }, select: { status: true, revisionNote: true, revisionCount: true } });
  expect(p).toEqual({ status: "REVISION", revisionNote: MOTIF_REVISION, revisionCount: 1 });
  // La liste des plans du KAM montre son échéance de 48 h — elle n'en montrait aucune pour un plan en révision.
  await aller(page, "/medical/plan-de-tournee");
  await expect(page.getByText(/à resoumettre avant le /).first()).toBeVisible({ timeout: 15_000 });
});

test("MON ESPACE — le plan en révision est « À corriger », avec ce qui a été demandé", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, EMAIL.kam);
  await aller(page, "/mon-espace");
  await expect(page.getByText(/À corriger — Plan de tournée du/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`En révision : ${MOTIF_REVISION} — à resoumettre.`)).toBeVisible();
});

test("NON TENUE — dans « Ma journée », le KAM dit qu'une visite de demain est annulée : la ligne le montre, motif compris", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, EMAIL.kam);
  await aller(page, "/medical/ma-journee?vue=DEMAIN");
  // 11/2026 : la ligne porte « Commencer » ; « La visite n'a pas eu lieu ? » est dans la feuille de la visite.
  await page.getByRole("button", { name: "Commencer", exact: true }).click();
  await page.getByRole("button", { name: "La visite n'a pas eu lieu ?" }).click();
  const enregistrer = page.getByRole("button", { name: "Enregistrer", exact: true });
  await expect(enregistrer).toBeDisabled();
  await page.getByLabel("Annulée").check();
  await page.getByLabel("Pourquoi").fill(MOTIF_ANNULATION);
  await cliquerDecisif(enregistrer);
  await expect(page.getByText(`« ${MOTIF_ANNULATION} »`)).toBeVisible({ timeout: 15_000 });
  const v = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: visiteId }, select: { status: true, notHeldReason: true } });
  expect(v).toEqual({ status: "CANCELLED", notHeldReason: MOTIF_ANNULATION });
});
