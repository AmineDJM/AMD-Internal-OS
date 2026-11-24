import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉVISER UN POSTE ET UNE DEMANDE AU SECRÉTARIAT, DANS LE NAVIGATEUR (§118.187) — écrans réels,
 * base réelle, aucun appel de modèle de son fait.
 *
 * Le banc de flux prouve les RÈGLES par les vraies actions ; celui-ci prouve que les écrans les
 * déclenchent — et qu'ils renvoient ce qu'ils ont LU, ce qu'aucun banc unitaire ne rend (§118.50) :
 *   - le délégué demande le BC d'un poste, en CORRIGE le message, puis le RETIRE avec son motif ;
 *   - un BC établi dans Legal : la carte le dit, et n'offre plus le retrait que l'action refuserait ;
 *   - le Directeur Général vise depuis le centre un poste dont le montant a changé APRÈS l'affichage :
 *     le centre renvoie le montant qu'il montrait, et l'action refuse en le disant ;
 *   - le demandeur d'une demande au secrétariat la SUPPRIME dans les trente minutes, et
 *     l'ANNULE au-delà, motif à l'appui — elle ne disparaît plus, elle se clôt.
 *
 * Décor propre à la spec (préfixe `__e2e10__`), retiré au début et à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__e2e10__";
const KAM_EMAIL = `${P}kam@test.dz`;
const GM_EMAIL = `${P}gm@test.dz`;
const ASST_EMAIL = `${P}asst@test.dz`;
const CAPTURES = process.env.E2E_CAPTURES ?? "";
const DEUX_HEURES = 2 * 60 * 60 * 1000;

let eventId = "";
let kamId = "";
let catId = "";

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

/** La carte d'un poste — désignée par son menu « Autres actions ». */
async function carte(page: Page, libelle: string) {
  const c = page.locator("li").filter({ has: page.getByRole("button", { name: `Autres actions — ${libelle}` }) }).last();
  // LE TABLEAU DES POSTES (fiche simplifiée, 24/11/2026) : la carte d'un poste se déplie depuis sa ligne, « Ouvrir ».
  if ((await c.count()) === 0) {
    const ouvrir = page.getByRole("button", { name: `Ouvrir — ${libelle}`, exact: true });
    if (await ouvrir.count()) await ouvrir.first().click();
  }
  return c;
}

/** Attendre qu'un fait soit écrit en base — l'écran a pu répondre avant le rafraîchissement. */
async function attendre<T>(lire: () => Promise<T>, ok: (v: T) => boolean, quoi: string): Promise<T> {
  const debut = Date.now();
  for (;;) {
    const v = await lire();
    if (ok(v)) return v;
    if (Date.now() - debut > 15_000) throw new Error(`${quoi} : toujours ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function poste(label: string, data: Record<string, unknown> = {}) {
  return prisma.adProItem.create({
    data: {
      eventId, kind: "PRINTING", label: `${P}${label}`, amountEstimated: 600_000, amountGranted: 600_000, status: "APPROVED",
      supplier: "Imprimerie Alpha", budgetCategoryId: catId, createdById: kamId, ...data,
    },
    select: { id: true },
  });
}

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const events = await prisma.event.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const evIds = events.map((e) => e.id);
  const postes = await prisma.adProItem.findMany({ where: { eventId: { in: evIds } }, select: { id: true } });
  const posteIds = postes.map((p) => p.id);
  const demandes = await prisma.administrativeRequest.findMany({
    where: { OR: [{ requesterId: { in: ids } }, { linkedEntityId: { in: posteIds } }] }, select: { id: true },
  });
  const demIds = demandes.map((d) => d.id);
  await prisma.comment.deleteMany({ where: { entityId: { in: demIds } } });
  await prisma.validationRequest.deleteMany({ where: { entityId: { in: demIds } } });
  await prisma.administrativeRequest.deleteMany({ where: { id: { in: demIds } } });
  const pieces = await prisma.documentRequest.findMany({ where: { entityId: { in: posteIds } }, select: { legalDocumentId: true } });
  await prisma.documentRequest.deleteMany({ where: { entityId: { in: posteIds } } });
  await prisma.legalDocument.deleteMany({ where: { OR: [{ id: { in: pieces.map((p) => p.legalDocumentId).filter((x): x is string => Boolean(x)) } }, { title: { startsWith: P } }] } });
  await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: posteIds } } });
  await prisma.adProItem.deleteMany({ where: { id: { in: posteIds } } });
  await prisma.event.deleteMany({ where: { id: { in: evIds } } });
  await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: P } } });
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
  kamId = (await creer(KAM_EMAIL, `${P} Délégué`, "MEDICAL_DELEGATE")).id;
  await creer(GM_EMAIL, `${P} Directeur Général`, "GENERAL_MANAGER");
  await creer(ASST_EMAIL, `${P} Assistante`, "DIRECTION_ASSISTANT");
  eventId = (await prisma.event.create({
    data: { name: `${P}Journée cardiologie`, requesterId: kamId, status: "VALIDATED", startDate: new Date("2026-12-04") },
    select: { id: true },
  })).id;
  const env = await prisma.budgetEnvelope.create({
    data: { name: `${P}Enveloppe`, modules: ["EVENTS"], totalAmount: 10_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
    select: { id: true },
  });
  catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${P}Imprimerie`, allocated: 5_000_000 }, select: { id: true } })).id;
});

test.afterAll(async () => {
  await nettoyer();
  await prisma.$disconnect();
});

test("POSTE : demander le BC, en corriger le message, puis le retirer avec son motif", async ({ page }) => {
  test.setTimeout(120_000);
  const { id } = await poste("Brochures");
  await login(page, KAM_EMAIL);
  await aller(page, `/events/${eventId}`);
  const c = await carte(page, `${P}Brochures`);
  await c.getByRole("button", { name: "Demander l'émission du BC" }).click();
  await c.getByRole("textbox").fill("Réf. devis DV-12, 2 000 brochures.");
  // Plusieurs assistantes de direction dans la base : la plateforme n'en choisit aucune à la place du demandeur.
  const choixAssistante = c.getByLabel("Assistante de direction qui établira le bon de commande");
  if (await choixAssistante.count()) await choixAssistante.selectOption({ label: `${P} Assistante` });
  await c.getByRole("button", { name: "Envoyer la demande" }).click();
  await attendre(() => prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { orderStage: true } }), (p) => p.orderStage === "REQUESTED", "BC demandé");

  // CORRIGER : le message déjà envoyé revient dans la boîte — rien à retaper.
  await aller(page, `/events/${eventId}`);
  await c.getByRole("button", { name: `Autres actions — ${P}Brochures` }).click();
  await page.getByRole("menuitem", { name: "Modifier la demande de BC" }).click();
  const boite = c.getByRole("textbox");
  await expect(boite).toHaveValue("Réf. devis DV-12, 2 000 brochures.");
  await boite.fill("Réf. devis DV-31, 500 brochures.");
  await c.getByRole("button", { name: "Mettre à jour la demande" }).click();
  await attendre(() => prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { orderNote: true } }), (p) => p.orderNote === "Réf. devis DV-31, 500 brochures.", "message corrigé");
  await capture(page, "c2-poste-bc-corrige", c);

  // RETIRER : le motif est exigé, et la demande repart à zéro.
  await aller(page, `/events/${eventId}`);
  await c.getByRole("button", { name: `Autres actions — ${P}Brochures` }).click();
  await page.getByRole("menuitem", { name: "Annuler la demande de BC" }).click();
  await c.getByRole("textbox").fill("Le devis est caduc.");
  await cliquerDecisif(c.getByRole("button", { name: "Annuler la demande", exact: true }));
  const apres = await attendre(() => prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { orderStage: true } }), (p) => p.orderStage === "NONE", "demande retirée");
  expect(apres.orderStage).toBe("NONE");
});

test("UN BC ÉTABLI DANS LEGAL, NON SIGNÉ : la carte le dit, et « Annuler la demande de BC » l'annule avec la demande (constat 36)", async ({ page }) => {
  const { id } = await poste("Kakémonos", { orderStage: "DIRECTION_OK", orderRequestedAt: new Date(), orderRequestedById: kamId, orderDirectionAt: new Date(), orderVisaAmount: 600_000, orderVisaSupplier: "Imprimerie Alpha" });
  const piece = await prisma.legalDocument.create({ data: { title: `${P}BC Kakémonos`, kind: "PURCHASE_ORDER", reference: `${P}BC-1` }, select: { id: true } });
  await prisma.documentRequest.create({
    data: { reference: `${P}DR-1`, entityType: "AD_PRO_ITEM", entityId: id, label: "BC", kind: "PURCHASE_ORDER", legalDocumentId: piece.id, askedById: kamId, askedToId: kamId },
  });
  await login(page, KAM_EMAIL);
  await aller(page, `/events/${eventId}`);
  const c = await carte(page, `${P}Kakémonos`);
  await expect(c.getByText(`BC établi dans Legal : ${P}BC-1`)).toBeVisible();
  await c.getByRole("button", { name: `Autres actions — ${P}Kakémonos` }).click();
  await expect(page.getByRole("menuitem", { name: "Modifier la demande de BC" }), "le message se corrige encore").toBeVisible();
  // Un BC non signé s'annule avec la demande (un seul geste) : le geste est offert. Signé ou facturé, il ne l'est plus.
  await expect(page.getByRole("menuitem", { name: "Annuler la demande de BC" }), "le BC non signé s'annule avec la demande").toHaveCount(1);
  await capture(page, "c2-bc-legal", c);
});

test("LE CENTRE RENVOIE CE QU'IL MONTRAIT : un montant changé après l'affichage ne se vise pas", async ({ page }) => {
  const { id } = await poste("Affiches", { orderStage: "REQUESTED", orderRequestedAt: new Date(), orderRequestedById: kamId, orderNote: "Réf. DV-77." });
  await login(page, GM_EMAIL);
  await aller(page, "/centre-ad-pro");
  const ligne = page.locator("li").filter({ hasText: `${P}Affiches` }).last();
  await expect(ligne).toBeVisible();
  // Pendant que le Directeur Général lit la ligne, le montant change.
  await prisma.adProItem.update({ where: { id }, data: { amountGranted: 800_000 } });
  await cliquerDecisif(ligne.getByRole("button", { name: "Valider le bon de commande" }));
  await expect(ligne.getByText(/a changé pendant que vous lisiez \(600\s000 → 800\s000 DZD\)/)).toBeVisible();
  expect((await prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { orderStage: true, orderVisaAmount: true } }))).toEqual({ orderStage: "REQUESTED", orderVisaAmount: null });
  await capture(page, "c2-centre-relire", ligne);
});

test("SECRÉTARIAT : supprimée dans les trente minutes, annulée au-delà — motif à l'appui, sans disparaître", async ({ page }) => {
  const neuve = await prisma.administrativeRequest.create({
    data: { reference: `${P}R1`, type: "OTHER", title: `${P}Billet Alger–Oran`, priority: "MEDIUM", requesterId: kamId, status: "NEW" },
    select: { id: true },
  });
  const vieille = await prisma.administrativeRequest.create({
    data: { reference: `${P}R2`, type: "OTHER", title: `${P}Salle de réunion`, priority: "MEDIUM", requesterId: kamId, status: "NEW", createdAt: new Date(Date.now() - DEUX_HEURES) },
    select: { id: true },
  });
  await login(page, KAM_EMAIL);

  // DANS LA FENÊTRE : le temps qui reste se voit, et la suppression reste douce.
  await aller(page, `/demandes/${neuve.id}`);
  await expect(page.getByText(/sans prévenir personne pendant/)).toBeVisible();
  await cliquerDecisif(page.getByRole("button", { name: "Supprimer" }));
  await attendre(() => prisma.administrativeRequest.findUniqueOrThrow({ where: { id: neuve.id }, select: { deletedAt: true } }), (d) => d.deletedAt !== null, "suppression douce");

  // AU-DELÀ : l'encart reste, et l'annulation porte son motif.
  await aller(page, `/demandes/${vieille.id}`);
  await expect(page.getByText("Vous pouvez encore corriger ou annuler cette demande : l'assistante en sera prévenue.")).toBeVisible();
  await capture(page, "c2-demande-au-dela");
  await page.getByRole("button", { name: "Annuler la demande" }).click();
  const fenetre = page.getByRole("dialog");
  await fenetre.getByRole("textbox", { name: "Pourquoi l'annulez-vous ?" }).fill("La réunion se tiendra en visio.");
  await cliquerDecisif(fenetre.getByRole("button", { name: "Annuler la demande" }));
  const d = await attendre(
    () => prisma.administrativeRequest.findUniqueOrThrow({ where: { id: vieille.id }, select: { status: true, deletedAt: true } }),
    (x) => x.status === "CANCELLED", "annulation",
  );
  expect(d.deletedAt, "close, pas effacée").toBeNull();
  const trace = await prisma.comment.findFirstOrThrow({ where: { entityType: "ADMIN_REQUEST", entityId: vieille.id }, select: { body: true } });
  expect(trace.body).toBe("Demande annulée par son demandeur : La réunion se tiendra en visio.");
});
