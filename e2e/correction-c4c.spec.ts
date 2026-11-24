import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";
import { autoriserAuCentre, ouvrirAuCentre } from "./centre";

/**
 * ═════════════════════════════════════════════════════════════════
 * LA DEMANDE DE PAIEMENT SE CORRIGE, LE SECRÉTARIAT A DES GESTES NOMMÉS — dans le navigateur
 * (audit 360°, lot C4c, §118.191).
 *
 * Les bancs de flux (`payment-correction-flow.test.ts`, `secretariat-gestes-flow.test.ts`) prouvent les
 * RÈGLES par les vraies actions ; celui-ci prouve qu'elles ont un ÉCRAN qui les déclenche (§118.50), dans
 * la peau de trois personnes :
 *   - le DÉLÉGUÉ corrige le montant d'une demande que les Finances lui ont renvoyée — le centre avait déjà
 *     autorisé : la fiche l'en avertit, et la hausse lui renvoie le paiement ;
 *   - le SUPER ADMIN, au centre de paiement, décide sur ce qu'il a LU : un montant corrigé pendant sa
 *     lecture se dit avec les deux chiffres, et rien n'est autorisé ;
 *   - l'ASSISTANTE DE DIRECTION n'a plus de menu de statut libre : elle bloque (avec son motif), reprend,
 *     rouvre une demande terminée (avec son motif) ; et l'annulation d'une demande de BC de poste n'est
 *     pas offerte — la raison se lit à sa place.
 *
 * Décor propre à la spec (préfixe `__e2e14__`), posé en base et retiré au début et à la fin.
 * ═════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e14__";
const EMAIL = { del: `${P}del@test.dz`, sa: `${P}sa@test.dz`, ast: `${P}ast@test.dz` };
const LIBELLE = `${P}PAY-1 — Stand congrès SAHO`;
const CHANGE = "La facture définitive porte 560 000 DZD : deux panneaux de plus.";
const BLOCAGE = "Le traiteur ne répond pas : relance faite ce matin.";
const REOUVERTURE = "La livraison n'est jamais arrivée.";

let delId = "";
let saId = "";
let astId = "";
let demandeId = "";
let ordreId = "";
let enCoursId = "";
let termineeId = "";
let bcPosteId = "";
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

/** Les montants s'écrivent avec une espace insécable (fr-FR) : on compare des chiffres, pas des espaces. */
const chiffres = (s: string) => s.replace(/[\s  ]/g, " ");

async function nettoyer() {
  const ids = (await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })).map((u) => u.id);
  const demandes = (await prisma.paymentRequest.findMany({ where: { reference: { startsWith: P } }, select: { id: true } })).map((d) => d.id);
  const ordres = (await prisma.expenseOrder.findMany({ where: { reference: { startsWith: P } }, select: { id: true } })).map((o) => o.id);
  const secretariat = (await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: P } }, select: { id: true } })).map((d) => d.id);
  await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: demandes } } });
  await prisma.paymentRequest.updateMany({ where: { id: { in: demandes } }, data: { expenseOrderId: null } });
  await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes } } });
  await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } });
  await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } });
  await prisma.comment.deleteMany({ where: { entityId: { in: secretariat } } });
  await prisma.administrativeRequest.deleteMany({ where: { id: { in: secretariat } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  // Les notifications parties À D'AUTRES (la Direction prévenue d'une ré-autorisation) se retirent
  // par leur contenu, bornées à la fenêtre du run (§118.175).
  await prisma.notification.deleteMany({
    where: { createdAt: { gte: new Date(debut.getTime() - 60 * 60 * 1000) }, body: { contains: P } },
  });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...demandes, ...ordres, ...secretariat] } }] } }).catch(() => {});
  await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  const [del, sa, ast] = await Promise.all([
    prisma.user.create({ data: { email: EMAIL.del, name: `${P} Délégué`, passwordHash: hash, role: "MEDICAL_DELEGATE" }, select: { id: true } }),
    prisma.user.create({ data: { email: EMAIL.sa, name: `${P} Super admin`, passwordHash: hash, role: "SUPER_ADMIN" }, select: { id: true } }),
    prisma.user.create({ data: { email: EMAIL.ast, name: `${P} Assistante`, passwordHash: hash, role: "DIRECTION_ASSISTANT" }, select: { id: true } }),
  ]);
  delId = del.id; saId = sa.id; astId = ast.id;
  // La demande RENVOYÉE par les Finances, dont le paiement a déjà été AUTORISÉ par le centre — l'état
  // exact que produit le circuit (transmission → ordre au centre → autorisation → renvoi au demandeur).
  const demande = await prisma.paymentRequest.create({
    data: {
      reference: `${P}PAY-1`, title: "Stand congrès SAHO", amount: 500_000, payee: "SARL Atlas",
      status: "CHANGES_REQUESTED", requesterId: delId, dueDate: new Date("2026-11-15T00:00:00Z"),
    },
    select: { id: true },
  });
  demandeId = demande.id;
  const ordre = await prisma.expenseOrder.create({
    data: {
      reference: `${P}OD-1`, label: LIBELLE, amount: 500_000, beneficiary: "SARL Atlas",
      status: "PENDING", centralStatus: "APPROVED", centralDecidedById: saId, centralDecidedAt: new Date(),
      sourceType: "PAYMENT_REQUEST", sourceId: demandeId, requestedById: delId,
    },
    select: { id: true },
  });
  ordreId = ordre.id;
  await prisma.paymentRequest.update({ where: { id: demandeId }, data: { expenseOrderId: ordreId } });

  // Trois demandes au secrétariat, chacune au point que son parcours mesure.
  const commun = { type: "OTHER" as const, priority: "MEDIUM" as const, requesterId: delId, assignedToId: astId };
  enCoursId = (await prisma.administrativeRequest.create({ data: { ...commun, reference: `${P}DEM-1`, title: `${P} Réservation salle du conseil`, status: "IN_PROGRESS" }, select: { id: true } })).id;
  termineeId = (await prisma.administrativeRequest.create({ data: { ...commun, reference: `${P}DEM-2`, title: `${P} Livraison fournitures`, status: "DONE", completedAt: new Date() }, select: { id: true } })).id;
  bcPosteId = (await prisma.administrativeRequest.create({
    data: { ...commun, reference: `${P}DEM-3`, title: `Bon de commande à établir — ${P} imprimerie`, status: "IN_PROGRESS", linkedEntityType: "AD_PRO_ITEM", linkedEntityId: `${P}poste` },
    select: { id: true },
  })).id;
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("CORRIGER — le délégué relève le montant d'une demande renvoyée : la fiche l'avertit, et le centre doit autoriser de nouveau", async ({ page }) => {
  // Le premier parcours après un build propre paie le démarrage à froid du serveur (§118.124b).
  test.setTimeout(120_000);
  await login(page, EMAIL.del);
  await aller(page, `/validations/paiements/${demandeId}`);
  await page.getByRole("button", { name: "Corriger la demande" }).click();
  const volet = page.getByRole("dialog");
  await expect(volet.getByText(/relever le montant ou changer de bénéficiaire le lui renvoie/), "le centre a déjà autorisé : la fiche le dit AVANT").toBeVisible();
  await volet.getByLabel("Montant (DZD)").fill("560000");
  await volet.getByLabel(/Ce qui a changé/).fill(CHANGE);
  await volet.getByRole("button", { name: "Enregistrer la correction" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Demande corrigée — le paiement repasse au centre de paiement, qui doit l'autoriser de nouveau." })).toBeVisible({ timeout: 15_000 });

  const d = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: demandeId }, select: { amount: true, status: true } });
  expect([Number(d.amount), d.status]).toEqual([560_000, "CHANGES_REQUESTED"]);
  const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { amount: true, centralStatus: true, centralDecidedById: true } });
  expect([Number(o.amount), o.centralStatus, o.centralDecidedById], "l'autorisation donnée pour 500 000 ne couvre pas 560 000").toEqual([560_000, "AWAITING", null]);
  const fil = await prisma.paymentCentreMessage.findMany({ where: { orderId: ordreId }, select: { body: true } });
  expect(fil.some((m) => chiffres(m.body).includes("Montant relevé de 500 000 à 560 000 DZD")), "la raison est au fil du centre").toBe(true);
  // Ce qui a changé se lit au fil du dossier — dit par le demandeur, pas déduit.
  await expect(page.getByText(CHANGE).first()).toBeVisible();
});

test("LE CENTRE DÉCIDE SUR CE QU'IL A LU — un montant corrigé pendant la lecture se dit, avec les deux chiffres, et rien n'est autorisé", async ({ page }) => {
  await login(page, EMAIL.sa);
  await aller(page, "/centre-de-paiement?entite=sans-entite");
  const fiche = await ouvrirAuCentre(page, LIBELLE);
  // PENDANT QUE LE SIÈGE LIT, le montant change (une seconde correction) : il a lu 560 000.
  await prisma.expenseOrder.update({ where: { id: ordreId }, data: { amount: 600_000 } });
  await cliquerDecisif(fiche.getByRole("button", { name: "Autoriser le paiement" }));
  await expect(fiche.getByRole("alert").filter({ hasText: /a changé pendant que vous lisiez/ })).toBeVisible({ timeout: 15_000 });
  await expect(fiche.getByRole("alert")).toContainText(/560[\s  ]000 → 600[\s  ]000 DZD/);
  const apres = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { centralStatus: true } });
  expect(apres.centralStatus, "un montant qu'on n'a pas vu ne s'autorise pas").toBe("AWAITING");

  // TÉMOIN : relu, le même geste passe — la garde ne refuse pas tout.
  await aller(page, "/centre-de-paiement?entite=sans-entite");
  await autoriserAuCentre(page, LIBELLE);
  await expect.poll(async () => (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { centralStatus: true } })).centralStatus, { timeout: 15_000 }).toBe("APPROVED");
  const autorise = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { centralStatus: true, amount: true } });
  expect([autorise.centralStatus, Number(autorise.amount)]).toEqual(["APPROVED", 600_000]);
});

test("SECRÉTARIAT — plus de menu libre : bloquer exige son motif, le demandeur le lit, reprendre l'efface", async ({ page }) => {
  await login(page, EMAIL.ast);
  await aller(page, `/demandes/${enCoursId}`);
  await expect(page.getByText("Changer le statut"), "le menu qui terminait, annulait et ressuscitait sans garde n'existe plus").toHaveCount(0);
  await page.getByRole("button", { name: "Bloquer…", exact: true }).click();
  const volet = page.getByRole("dialog");
  await volet.getByRole("button", { name: "Bloquer", exact: true }).click();
  // Sans motif, rien ne part : le volet reste, la demande aussi.
  await expect(volet).toBeVisible();
  expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: enCoursId }, select: { status: true } })).status).toBe("IN_PROGRESS");
  await volet.getByLabel("Ce qui bloque").fill(BLOCAGE);
  await volet.getByRole("button", { name: "Bloquer", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  const bloquee = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: enCoursId }, select: { status: true, blockedReason: true } });
  expect([bloquee.status, bloquee.blockedReason]).toEqual(["BLOCKED", BLOCAGE]);
  // Le demandeur lit le MOTIF — jamais l'énumération brute.
  const avis = await prisma.notification.findFirstOrThrow({ where: { userId: delId, title: "Demande bloquée" }, select: { body: true } });
  expect(avis.body).toContain(BLOCAGE);
  expect(avis.body).not.toMatch(/BLOCKED/);

  await page.getByRole("button", { name: "Reprendre", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bloquer…", exact: true })).toBeVisible({ timeout: 15_000 });
  const reprise = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: enCoursId }, select: { status: true, blockedReason: true } });
  expect([reprise.status, reprise.blockedReason]).toEqual(["IN_PROGRESS", null]);
});

test("ROUVRIR une demande terminée, avec son motif — et l'annulation d'une demande de BC de poste n'est pas offerte : la raison se lit à sa place", async ({ page }) => {
  await login(page, EMAIL.ast);
  await aller(page, `/demandes/${termineeId}`);
  await expect(page.getByText("Demande terminée : elle ne se traite plus. Si elle doit reprendre, rouvrez-la — avec son motif.")).toBeVisible();
  await page.getByRole("button", { name: "Rouvrir…", exact: true }).click();
  const volet = page.getByRole("dialog");
  await volet.getByLabel("Pourquoi la rouvrir").fill(REOUVERTURE);
  await volet.getByRole("button", { name: "Rouvrir", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  const rouverte = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: termineeId }, select: { status: true, completedAt: true } });
  expect([rouverte.status, rouverte.completedAt]).toEqual(["IN_PROGRESS", null]);
  const fil = await prisma.comment.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: termineeId }, select: { body: true } });
  expect(fil.some((c) => c.body === `Demande rouverte — ${REOUVERTURE}`)).toBe(true);

  // La demande de BC d'un poste se retire DEPUIS LE POSTE : le bouton n'est pas offert, la raison l'est.
  await aller(page, `/demandes/${bcPosteId}`);
  await expect(page.getByRole("button", { name: /Annuler la demande/ })).toHaveCount(0);
  await expect(page.getByText(/retirez-la depuis le poste/)).toBeVisible();
});
