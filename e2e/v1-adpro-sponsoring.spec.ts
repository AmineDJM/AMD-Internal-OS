import { test, expect, type Page, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import JSZip from "jszip";
import { E2E } from "./global-setup";
import { cliquerDecisif } from "./decisif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V1 — SPONSORING ET AD & PRO DE BOUT EN BOUT, PAR L'ÉCRAN (Direction, 03/11/2026).
 *
 * « Est-ce que tu as fait les tests sur sponsoring, tout marche, on peut mettre des pièces jointes, tout
 * est validé… on peut créer des fiches hôtellerie, les sommes… Si on veut changer, on peut supprimer, on
 * peut modifier. On peut envoyer à l'assistante de direction pour qu'elle achète les billets, les hôtels.
 * Valider le paiement, mettre dans le budget et tout. »
 *
 * Le chemin du CLIC, dans la peau de chaque acteur du circuit (délégué, National Sales, Directeur des
 * opérations, Direction Marketing, DG, assistante de direction, PDG au centre de paiement, Finances).
 * Écrans réels, base réelle, aucun appel de modèle. Décor préfixé `__v1adpro__`, retiré avant et après.
 * Captures : `E2E_CAPTURES=<dossier>`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
});

const P = "__v1adpro__";
const R = {
  kam: { email: `${P}kam@test.dz`, nom: `${P} Délégué KAM`, role: "MEDICAL_DELEGATE" },
  ns: { email: `${P}ns@test.dz`, nom: `${P} National Sales`, role: "NATIONAL_SALES" },
  ops: { email: `${P}ops@test.dz`, nom: `${P} Directeur des opérations`, role: "OPERATIONS_DIRECTOR" },
  dm: { email: `${P}dm@test.dz`, nom: `${P} Directrice marketing`, role: "PRODUCT_MANAGER" },
  dg: { email: `${P}dg@test.dz`, nom: `${P} Directeur général`, role: "GENERAL_MANAGER" },
  ast: { email: `${P}ast@test.dz`, nom: `${P} Assistante de direction`, role: "DIRECTION_ASSISTANT" },
  pdg: { email: `${P}pdg@test.dz`, nom: `${P} PDG`, role: "DIRECTION" },
  fin: { email: `${P}fin@test.dz`, nom: `${P} Finances`, role: "FINANCE_BUDGET_MANAGER" },
} as const;
type Qui = keyof typeof R;

const INSTITUTION = `${P} Société algérienne de cardiologie`;
const INSTITUTION_REFUS = `${P} Association à refuser`;
const MEDECIN = `${P} Dr Amine Cardio`;
const PRODUIT = `${P}Cardiolex`;
const CAPTURES = process.env.E2E_CAPTURES ?? "";

const ids: Record<Qui, string> = { kam: "", ns: "", ops: "", dm: "", dg: "", ast: "", pdg: "", fin: "" };
let sponsoringId = "";
let categorieId = "";

// ─────────────────────────────── Les pièces : de VRAIS fichiers ───────────────────────────────

function pdfMinimal(texte: string): Buffer {
  const corps = `BT /F1 12 Tf 72 720 Td (${texte}) Tj ET`;
  const objets = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${corps.length} >>\nstream\n${corps}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objets.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** Un PNG 1×1 rouge (signature et CRC valides). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

async function docxMinimal(texte: string): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${texte}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

// ─────────────────────────────── Les gestes communs ───────────────────────────────

async function login(page: Page, qui: Qui) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(R[qui].email);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function aller(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function capture(page: Page, nom: string, cible?: Locator) {
  if (!CAPTURES) return;
  if (cible) await cible.screenshot({ path: `${CAPTURES}/${nom}.png` });
  else await page.screenshot({ path: `${CAPTURES}/${nom}.png`, fullPage: true });
}

/** Coche une option d'un choix multiple, en passant par sa recherche quand la liste est longue. */
async function cocher(panneau: Locator, champ: string, option: string) {
  const recherche = panneau.getByRole("textbox", { name: `Rechercher dans ${champ}` });
  if (await recherche.count()) await recherche.fill(P);
  await panneau.getByRole("checkbox", { name: new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).check();
}

/** Remplit le formulaire de création d'un sponsoring. */
async function remplirSponsoring(page: Page, institution: string, nature: "DIRECT" | "INDIRECT", demande: string, suggere: string) {
  const panneau = page.getByRole("dialog");
  await panneau.locator('input[name="institution"]').fill(institution);
  await cocher(panneau, "Médecin(s) concerné(s)", MEDECIN);
  await cocher(panneau, "Produit(s) concerné(s)", PRODUIT);
  await panneau.locator('select[name="city"]').selectOption({ index: 1 });
  const specialite = panneau.locator('[name="specialty"]');
  if ((await specialite.evaluate((e) => e.tagName)) === "SELECT") await specialite.selectOption({ index: 1 });
  else await specialite.fill("Cardiologie");
  await panneau.locator('select[name="type"]').selectOption({ index: 1 });
  await panneau.locator('select[name="nature"]').selectOption(nature);
  await panneau.locator('input[name="amountRequested"]').fill(demande);
  await panneau.locator('input[name="amountProposed"]').fill(suggere);
  await panneau.locator('select[name="strategicImportance"]').selectOption({ index: 1 });
  const gamme = panneau.locator('select[name="businessUnitId"]');
  if (await gamme.count()) await gamme.selectOption({ index: 1 });
  return panneau;
}

// ─────────────────────────────── Décor ───────────────────────────────

async function nettoyer() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const uid = users.map((u) => u.id);
  const spos = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: P } }, select: { id: true } });
  const spoIds = spos.map((s) => s.id);
  const postes = (await prisma.adProItem.findMany({ where: { sponsoringId: { in: spoIds } }, select: { id: true } })).map((p) => p.id);
  const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: [...spoIds, ...postes] } }, { requestedById: { in: uid } }] }, select: { id: true } })).map((o) => o.id);
  const ecritures = (await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
  await prisma.expenseOrder.updateMany({ where: { id: { in: ordres } }, data: { transactionId: null } }).catch(() => {});
  await prisma.financeTransaction.deleteMany({ where: { OR: [{ id: { in: ecritures } }, { label: { contains: P } }, { budgetCategory: { name: { startsWith: P } } }] } }).catch((e) => console.error("[nettoyer] écritures", e));
  await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
  await prisma.paymentRequestEvent.deleteMany({ where: { request: { expenseOrderId: { in: ordres } } } }).catch(() => {});
  await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
  await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { expenseOrderId: null } }).catch(() => {});
  await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
  const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
  await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
  const legaux = [...liens.map((l) => l.legalDocumentId), ...(await prisma.legalDocument.findMany({ where: { OR: [{ sourceId: { in: [...spoIds, ...postes] } }, { title: { contains: P } }] }, select: { id: true } })).map((l) => l.id)];
  const sujets = await prisma.dossier.findMany({ where: { OR: [{ sourceId: { in: [...spoIds, ...postes] } }, { title: { contains: P } }] }, select: { id: true } });
  await prisma.dossierMessage.deleteMany({ where: { dossierId: { in: sujets.map((s) => s.id) } } }).catch(() => {});
  await prisma.dossier.deleteMany({ where: { id: { in: sujets.map((s) => s.id) } } }).catch(() => {});
  await prisma.document.deleteMany({ where: { entityId: { in: [...spoIds, ...postes, ...legaux] } } }).catch(() => {});
  await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
  await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
  await prisma.demandeReservation.deleteMany({ where: { OR: [{ itemId: { in: postes } }, { operationId: { in: spoIds } }] } }).catch(() => {});
  await prisma.adProHebergement.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
  await prisma.adProVoyageur.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
  await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
  await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: spoIds } } }).catch(() => {});
  await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: spoIds } } }).catch(() => {});
  await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: spoIds } } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { entityId: { in: spoIds } } }).catch(() => {});
  await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spoIds } } }).catch(() => {});
  await prisma.deletedRecord.deleteMany({ where: { OR: [{ name: { contains: P } }, { label: { contains: P } }] } }).catch(() => {});
  await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: P } } }).catch(() => {});
  await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: P } } }).catch(() => {});
  await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: P } } }).catch(() => {});
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: P } } });
  await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: uid } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: uid } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: uid } } }).catch(() => {});
  await prisma.userAccess.deleteMany({ where: { userId: { in: uid } } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { userId: { in: uid } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: uid } } }).catch((e) => console.error("[nettoyer] comptes", e));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await nettoyer();
  const hash = await bcrypt.hash(E2E.password, 10);
  for (const k of Object.keys(R) as Qui[]) {
    ids[k] = (await prisma.user.create({ data: { email: R[k].email, name: R[k].nom, passwordHash: hash, role: R[k].role as never } })).id;
  }
  await prisma.medicalDoctor.create({ data: { name: MEDECIN, specialty: "Cardiologie" } });
  await prisma.regulatoryProduct.create({ data: { reference: `${P}REG`, dci: `${P}Cardiolol`, brandName: PRODUIT, status: "DECISION_OBTAINED" as never } });
  const env = await prisma.budgetEnvelope.create({
    data: { name: `${P} Enveloppe Ad & Pro 2026`, modules: ["SPONSORING"], domaine: "MARKETING", totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") } as never,
    select: { id: true },
  });
  categorieId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${P} Sponsoring`, allocated: 10_000_000 }, select: { id: true } })).id;
  await prisma.treasuryAccount.create({ data: { name: `${P} Banque`, openingBalance: 20_000_000, principal: true } });
});

test.afterAll(async () => {
  if (!process.env.E2E_GARDER) await nettoyer();
  await prisma.$disconnect();
});

// ─────────────────────────────── 1. Créer, joindre, ouvrir ───────────────────────────────

test("1 · le délégué crée un sponsoring DIRECT avec PDF, Word et image ; chaque pièce s'ouvre et se télécharge", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "kam");
  await aller(page, "/sponsoring?new=1");
  const panneau = await remplirSponsoring(page, INSTITUTION, "DIRECT", "850000.50", "800000.25");
  // La demande du médecin : PDF ET Word ; une image en pièce complémentaire.
  await panneau.locator('input[name="files"]').setInputFiles([
    { name: "demande-medecin.pdf", mimeType: "application/pdf", buffer: pdfMinimal("Demande du Dr Cardio") },
    { name: "lettre-association.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docxMinimal("Lettre de l'association") },
  ]);
  const annexes = panneau.locator('input[name="annexes"]');
  await expect(annexes, "le formulaire offre une case pour les pièces complémentaires").toHaveCount(1);
  await annexes.setInputFiles([{ name: "affiche.png", mimeType: "image/png", buffer: PNG }]);
  await capture(page, "v1-01-creation");
  await panneau.getByRole("button", { name: "Enregistrer" }).click();
  await page.waitForURL(/\/sponsoring\/[a-z0-9]+$/, { timeout: 60_000 });

  const cree = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION } });
  sponsoringId = cree.id;
  expect(Number(cree.amountRequested)).toBe(850000.5);
  expect(Number(cree.amountProposed)).toBe(800000.25);
  expect(cree.nature).toBe("DIRECT");
  const docs = await prisma.document.findMany({ where: { entityId: sponsoringId }, select: { id: true, name: true, mimeType: true } });
  expect(docs.map((d) => d.name).sort()).toEqual(["affiche.png", "demande-medecin.pdf", "lettre-association.docx"]);

  // Chaque pièce : l'écran la NOMME, l'aperçu s'ouvre (inline), le téléchargement rend les mêmes octets.
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Le bloc des pièces est REPLIÉ par défaut : il annonce son compte, on l'ouvre.
  await page.getByText("Pièces jointes (3)").click();
  for (const d of docs) {
    await expect(page.getByText(d.name).first(), `la fiche montre ${d.name}`).toBeVisible();
    const vue = await page.request.get(`/api/documents/${d.id}`);
    expect(vue.status(), `aperçu de ${d.name}`).toBe(200);
    const dl = await page.request.get(`/api/documents/${d.id}?dl=1`);
    expect(dl.status(), `téléchargement de ${d.name}`).toBe(200);
    expect(dl.headers()["content-disposition"] ?? "").toMatch(/attachment/);
    expect((await dl.body()).length, `${d.name} non vide`).toBeGreaterThan(50);
  }
  await capture(page, "v1-02-fiche-pieces");
});

test("1b · une image seule comme « demande du médecin » est refusée, et la phrase dit pourquoi", async ({ page }) => {
  await login(page, "kam");
  await aller(page, "/sponsoring?new=1");
  const panneau = await remplirSponsoring(page, `${P} Refus format`, "DIRECT", "1000", "1000");
  await panneau.locator('input[name="files"]').setInputFiles([{ name: "photo.png", mimeType: "image/png", buffer: PNG }]);
  await panneau.getByRole("button", { name: "Enregistrer" }).click();
  await expect(panneau.getByText(/doit être un scan PDF ou un Word/)).toBeVisible({ timeout: 30_000 });
  expect(await prisma.sponsoringRequest.count({ where: { institution: `${P} Refus format` } })).toBe(0);
});

// ─────────────────────────────── 2. Le circuit ───────────────────────────────

/** Le geste d'un acteur du circuit sur la fiche : Approuver / Renvoyer / Avis défavorable / Refuser. */
async function geste(page: Page, bouton: RegExp, note: string | null, confirmer: RegExp) {
  await page.getByRole("button", { name: bouton }).first().click();
  if (note !== null) {
    await page.getByPlaceholder(/obligatoire|optionnel/).first().fill(note);
  }
  await cliquerDecisif(page.getByRole("button", { name: confirmer }).first());
  await page.waitForLoadState("networkidle");
}

const statutSpo = async (id = sponsoringId) => (await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

test("2 · circuit : le NS RENVOIE pour correction, le délégué MODIFIE et resoumet, puis NS → Directeur des opérations → Direction Marketing pré-valident", async ({ page }) => {
  test.setTimeout(240_000);
  // Avant la prévalidation, le poste né avec la demande ne se soumet pas (aucun poste avant la prévalidation).
  await login(page, "kam");
  await aller(page, `/sponsoring/${sponsoringId}`);
  const soumettre = page.getByRole("button", { name: "Soumettre pour validation" });
  if (await soumettre.count()) {
    await soumettre.first().click();
    await page.waitForLoadState("networkidle");
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId }, select: { status: true } });
    expect(poste.status, "un poste ne part pas en validation avant la prévalidation de la demande").toBe("DRAFT");
    await expect(page.getByText(/prévalid/i).first(), "le refus dit pourquoi").toBeVisible();
  }

  await login(page, "ns");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await geste(page, /Renvoyer pour correction/, "Le montant suggéré doit être ramené à 750 000 DZD.", /Renvoyer au demandeur/);
  await expect.poll(() => statutSpo()).toBe("RETURNED");

  await login(page, "kam");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await expect(page.getByText(/750 000 DZD/).first(), "le délégué lit ce qu'il doit corriger").toBeVisible();
  // « Modifier » vit dans le menu « Autres actions » de la fiche.
  await page.getByRole("button", { name: "Autres actions", exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Modifier", exact: true }).click();
  const feuille = page.getByRole("dialog");
  await feuille.locator("#edit-amountProposed").fill("750000.75");
  await feuille.getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(async () => Number((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: sponsoringId } })).amountProposed)).toBe(750000.75);
  await page.keyboard.press("Escape");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await page.getByRole("button", { name: "Resoumettre la demande" }).click();
  await expect.poll(() => statutSpo()).toBe("AWAITING_PRELIMINARY");
  await capture(page, "v1-03-resoumise");

  await login(page, "ns");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await geste(page, /^Approuver$/, null, /Confirmer/);
  await login(page, "ops");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await geste(page, /^Approuver$/, null, /Confirmer/);
  await login(page, "dm");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await geste(page, /^Approuver$/, null, /Confirmer/);
  await expect.poll(() => statutSpo()).toBe("PRE_VALIDATED");

  const evts = await prisma.workflowStepEvent.findMany({ where: { instance: { entityId: sponsoringId } }, orderBy: { createdAt: "asc" }, select: { action: true, stepSlug: true, actorId: true } });
  const trace = evts.filter((e) => ["APPROVE", "RETURN", "RESUBMIT"].includes(e.action)).map((e) => `${e.action}:${e.stepSlug}`);
  expect(trace, "l'historique garde chaque geste, dans l'ordre").toEqual(expect.arrayContaining(["RETURN:preliminary", "APPROVE:preliminary", "APPROVE:final", "APPROVE:marketing"]));
  await capture(page, "v1-04-prevalidee");
});

// ─────────────────────────────── 3. Le poste : accord, budget ───────────────────────────────

/** La carte d'un poste, désignée par son menu « Autres actions ». */
function carte(page: Page, libelle: string) {
  return page.locator("li").filter({ has: page.getByRole("button", { name: `Autres actions — ${libelle}` }) }).last();
}
const posteDirect = () => prisma.adProItem.findFirstOrThrow({ where: { sponsoringId } });

test("3 · le poste de naissance a suivi la correction ; le délégué le soumet, la Direction Marketing l'accorde (montant + budget)", async ({ page }) => {
  test.setTimeout(180_000);
  const p0 = await posteDirect();
  expect(Number(p0.amountEstimated), "le poste né avec la demande suit le montant corrigé (750 000,75)").toBe(750000.75);

  await login(page, "kam");
  await aller(page, `/sponsoring/${sponsoringId}`);
  await carte(page, p0.label).getByRole("button", { name: "Soumettre pour validation" }).click();
  await expect.poll(async () => (await posteDirect()).status).toBe("PENDING");

  await login(page, "dm");
  await aller(page, `/sponsoring/${sponsoringId}`);
  const c = carte(page, p0.label);
  await c.getByRole("button", { name: "Valider et choisir le budget" }).click();
  await c.getByRole("spinbutton", { name: "Montant accordé à ce poste" }).fill("700000.50");
  await c.getByRole("combobox", { name: "Budget qui portera ce poste" }).selectOption({ label: `${P} Enveloppe Ad & Pro 2026 › ${P} Sponsoring` });
  await cliquerDecisif(c.getByRole("button", { name: "Accorder" }));
  await expect.poll(async () => (await posteDirect()).status).toBe("APPROVED");
  const p1 = await posteDirect();
  expect(Number(p1.amountGranted)).toBe(700000.5);
  expect(p1.budgetCategoryId).toBe(categorieId);
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Le bandeau de la fiche : affecté aux postes = 700 000,50 DZD (indépendant : 70 000 050 centimes).
  await expect(page.getByText("700 000,50 DZD").first()).toBeVisible();
  await capture(page, "v1-05-poste-accorde", carte(page, p0.label));
});

// ─────────────────────────────── 4. Sponsoring indirect : hôtellerie, billets, assistante ───────────────────────────────

const INSTITUTION_IND = `${P} Journées d'Oran (indirect)`;
let indirectId = "";
const postesInd = () => prisma.adProItem.findMany({ where: { sponsoringId: indirectId }, orderBy: { position: "asc" } });

test("4 · sponsoring INDIRECT déposé par le Directeur des opérations : la Direction Marketing pré-valide, il se répartit hôtellerie + billets", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "ops");
  await aller(page, "/sponsoring?new=1");
  const panneau = await remplirSponsoring(page, INSTITUTION_IND, "INDIRECT", "600000", "600000");
  await panneau.locator('input[name="files"]').setInputFiles([{ name: "demande.pdf", mimeType: "application/pdf", buffer: pdfMinimal("Demande indirecte") }]);
  await panneau.getByRole("button", { name: "Enregistrer" }).click();
  await page.waitForURL(/\/sponsoring\/[a-z0-9]+$/, { timeout: 60_000 });
  indirectId = (await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION_IND } })).id;

  await login(page, "dm");
  await aller(page, `/sponsoring/${indirectId}`);
  await geste(page, /^Approuver$/, null, /Confirmer/);
  await expect.poll(() => statutSpo(indirectId)).toBe("PRE_VALIDATED");

  await login(page, "ops");
  await aller(page, `/sponsoring/${indirectId}`);
  const origine = (await postesInd())[0]!;
  const c = carte(page, origine.label);
  await c.getByRole("button", { name: "Répartir par nature" }).click();
  await c.getByLabel("Prise en charge 1").selectOption("ACCOMMODATION");
  await c.getByLabel("Montant 1").fill("360000.40");
  await c.getByLabel("Précision 1").fill("Hôtel Sheraton");
  await c.getByLabel("Prise en charge 2").selectOption("TICKETING");
  await c.getByLabel("Montant 2").fill("239999.60");
  await c.getByRole("button", { name: "Répartir", exact: true }).click();
  await expect.poll(async () => (await postesInd()).map((p) => p.kind)).toEqual(["ACCOMMODATION", "TICKETING"]);
  const ps = await postesInd();
  // Somme indépendante en centimes : 36 000 040 + 23 999 960 = 60 000 000.
  expect(ps.reduce((t, p) => t + Math.round(Number(p.amountEstimated) * 100), 0)).toBe(60_000_000);
});

test("5 · FICHES HÔTELLERIE : ajout (dates → nuitées), modification, retrait ; envoi à l'assistante de direction qui la prend", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "ops");
  await aller(page, `/sponsoring/${indirectId}`);
  const hotel = (await postesInd()).find((p) => p.kind === "ACCOMMODATION")!;
  let c = carte(page, hotel.label);
  const ajouterFiche = async (prenom: string, nom: string, arrivee: string, depart: string) => {
    await c.getByRole("button", { name: "Ajouter une fiche hôtellerie" }).click();
    await c.getByLabel("Prénom", { exact: true }).fill(prenom);
    await c.getByLabel("Nom", { exact: true }).fill(nom);
    await c.getByLabel("Hôtel", { exact: true }).fill("Sheraton");
    await c.getByLabel("Ville", { exact: true }).fill("Oran");
    await c.getByLabel("Arrivée", { exact: true }).fill(arrivee);
    await c.getByLabel("Départ", { exact: true }).fill(depart);
    await c.getByLabel("Type de chambre", { exact: true }).fill("Single");
    await c.getByRole("button", { name: "Ajouter la fiche" }).click();
    await expect.poll(async () => prisma.adProHebergement.count({ where: { itemId: hotel.id, nom } })).toBe(1);
    await page.reload();
    await page.waitForLoadState("networkidle");
    c = carte(page, hotel.label);
  };
  await ajouterFiche("Amel", "Haddad", "2026-11-20", "2026-11-23");
  await ajouterFiche("Karim", "Benali", "2026-11-20", "2026-11-22");
  // Nuitées : calcul indépendant (jours calendaires).
  await expect(c.getByText(/Sheraton, Oran · 20\/11\/2026 → 23\/11\/2026 · 3 nuits/)).toBeVisible();
  await expect(c.getByText(/20\/11\/2026 → 22\/11\/2026 · 2 nuits/)).toBeVisible();
  await capture(page, "v1-06-fiches-hotellerie", c);

  // MODIFIER : le départ d'Amel passe au 24 → 4 nuits.
  await c.getByRole("button", { name: "Autres actions pour Amel Haddad" }).click();
  await c.getByRole("menuitem", { name: "Modifier", exact: true }).click();
  await c.getByLabel("Départ", { exact: true }).fill("2026-11-24");
  await c.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect.poll(async () => (await prisma.adProHebergement.findFirstOrThrow({ where: { itemId: hotel.id, nom: "Haddad" } })).dateDepart?.toISOString().slice(0, 10)).toBe("2026-11-24");
  await page.reload();
  await page.waitForLoadState("networkidle");
  c = carte(page, hotel.label);
  await expect(c.getByText(/20\/11\/2026 → 24\/11\/2026 · 4 nuits/)).toBeVisible();

  // RETIRER : Karim.
  page.once("dialog", (d) => void d.accept());
  await c.getByRole("button", { name: "Autres actions pour Karim Benali" }).click();
  await c.getByRole("menuitem", { name: /Retirer/ }).click();
  const confirmer = page.getByRole("button", { name: /Retirer|Confirmer|Oui/ }).last();
  if (await confirmer.isVisible().catch(() => false)) await confirmer.click();
  await expect.poll(async () => prisma.adProHebergement.count({ where: { itemId: hotel.id, nom: "Benali" } })).toBe(0);

  // ENVOYER à l'assistante de direction.
  await page.reload();
  await page.waitForLoadState("networkidle");
  c = carte(page, hotel.label);
  await c.getByRole("button", { name: /Envoyer les fiches prêtes \(1\)/ }).click();
  await expect.poll(async () => prisma.demandeReservation.count({ where: { hebergement: { itemId: hotel.id } } })).toBeGreaterThan(0);

  await login(page, "ast");
  await aller(page, "/demandes?onglet=adpro");
  await expect(page.getByText(/Haddad/).first(), "l'assistante voit la fiche d'Amel Haddad").toBeVisible();
  await capture(page, "v1-07-bureau-assistante");
  await page.getByRole("button", { name: /Prendre/ }).first().click();
  await expect(page.getByText(/prise|Prise|En cours/).first()).toBeVisible();
});

// ─────────────────────────────── 6. Le paiement : demande → centre → Finances → budget ───────────────────────────────

test("6 · paiement du poste DIRECT : pro forma jointe, le PDG autorise au centre, les Finances règlent, le budget est consommé au centime", async ({ page }) => {
  test.setTimeout(240_000);
  const p = await posteDirect();
  await login(page, "kam");
  await aller(page, `/sponsoring/${sponsoringId}`);
  let c = carte(page, p.label);
  await c.getByRole("button", { name: /demander le paiement/i }).first().click();
  await c.locator('input[name="attachment"]').setInputFiles([{ name: "proforma-asso.pdf", mimeType: "application/pdf", buffer: pdfMinimal("Pro forma association") }]);
  // Un montant AU-DELÀ de l'accordé est refusé par le formulaire (max) — on garde l'accordé prérempli.
  await expect(c.locator('input[name="montant"]')).toHaveValue("700000.5");
  await c.getByRole("button", { name: "Demander le paiement", exact: true }).click();
  await expect.poll(async () => (await posteDirect()).expenseOrderId, { timeout: 30_000 }).not.toBeNull();
  const ordreId = (await posteDirect()).expenseOrderId!;
  const o1 = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } });
  expect(Number(o1.amount)).toBe(700000.5);
  expect(o1.centralStatus).toBe("AWAITING");
  expect(o1.budgetCategoryId).toBe(categorieId);
  await capture(page, "v1-08-paiement-demande", carte(page, p.label));

  // LE CENTRE DE PAIEMENT — le PDG autorise.
  await login(page, "pdg");
  await aller(page, "/centre-de-paiement");
  const ligne = page.locator("li").filter({ hasText: INSTITUTION }).filter({ has: page.getByRole("button", { name: "Autoriser" }) }).first();
  await expect(ligne, "l'ordre du sponsoring est au centre").toBeVisible({ timeout: 20_000 });
  await expect(ligne.getByText(/700\s000,50/).first(), "le centre montre le montant exact").toBeVisible();
  await ligne.getByRole("button", { name: "Autoriser" }).click();
  await cliquerDecisif(page.getByRole("dialog").getByRole("button", { name: "Autoriser le paiement" }));
  await expect.poll(async () => (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).centralStatus).toBe("APPROVED");
  await capture(page, "v1-09-centre-autorise");

  // LES FINANCES règlent.
  await login(page, "fin");
  await aller(page, "/finances/paiements-a-faire");
  const rangee = page.locator("tr, li").filter({ hasText: INSTITUTION }).filter({ has: page.getByRole("button", { name: /Payé/ }) }).first();
  await expect(rangee).toBeVisible({ timeout: 20_000 });
  const paye = rangee.getByRole("button", { name: /Payé/ });
  if ((await paye.getAttribute("data-decisif")) !== null) await cliquerDecisif(paye);
  else {
    await paye.click();
    await cliquerDecisif(page.getByRole("dialog").getByRole("button", { name: /Régler|Classer et régler/ }));
  }
  await expect.poll(async () => (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).status, { timeout: 30_000 }).toBe("PAID");

  // LE BUDGET : l'écriture OUT/SETTLED porte la catégorie et le montant au centime.
  const regle = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId }, select: { transactionId: true } });
  const tx = await prisma.financeTransaction.findMany({ where: { id: regle.transactionId ?? "-" } });
  expect(tx).toHaveLength(1);
  expect(tx[0]!.direction).toBe("OUT");
  expect(tx[0]!.status).toBe("SETTLED");
  expect(Number(tx[0]!.amount)).toBe(700000.5);
  expect(tx[0]!.budgetCategoryId).toBe(categorieId);
  // Consommé de la catégorie (indépendant) = 70 000 050 centimes ; reste = 1 000 000 000 − 70 000 050.
  const consomme = await prisma.financeTransaction.aggregate({ where: { budgetCategoryId: categorieId, direction: "OUT", status: "SETTLED" }, _sum: { amount: true } });
  expect(Math.round(Number(consomme._sum.amount) * 100)).toBe(70_000_050);
  await capture(page, "v1-10-finances-paye");
});

// ─────────────────────────────── 7. Supprimer, retrouver dans la corbeille, restaurer ───────────────────────────────

test("7 · la Direction Marketing SUPPRIME le sponsoring indirect (aperçu de ce qui part) ; le Directeur des opérations le RESTAURE depuis sa corbeille, postes et fiches compris", async ({ page }) => {
  test.setTimeout(180_000);
  const avant = { postes: (await postesInd()).length, fiches: await prisma.adProHebergement.count({ where: { item: { sponsoringId: indirectId } } }) };
  expect(avant.postes).toBe(2);

  await login(page, "dm");
  await aller(page, `/sponsoring/${indirectId}`);
  await page.getByRole("button", { name: "Autres actions", exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Supprimer la demande" }).click();
  const feuille = page.getByRole("dialog");
  await expect(feuille.getByText(/postes/)).toBeVisible();
  await capture(page, "v1-11-suppression-apercu");
  await cliquerDecisif(feuille.getByRole("button", { name: /Oui, supprimer/ }));
  await expect.poll(async () => prisma.sponsoringRequest.count({ where: { id: indirectId } })).toBe(0);
  const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: indirectId } });

  await login(page, "ops");
  await aller(page, "/corbeille");
  const ligne = page.locator("li, tr, div").filter({ hasText: INSTITUTION_IND }).filter({ has: page.getByRole("button", { name: /Restaurer/ }) }).last();
  await expect(ligne, "la demande supprimée est dans la corbeille du Directeur des opérations").toBeVisible();
  await expect(ligne.getByText(/Parti avec lui, revient avec lui : 2 postes/)).toBeVisible();
  await capture(page, "v1-12-corbeille");
  await cliquerDecisif(ligne.getByRole("button", { name: /Restaurer/ }));
  await expect.poll(async () => prisma.sponsoringRequest.count({ where: { id: indirectId } }), { timeout: 30_000 }).toBe(1);
  expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).not.toBeNull();
  const apres = { postes: (await postesInd()).length, fiches: await prisma.adProHebergement.count({ where: { item: { sponsoringId: indirectId } } }) };
  expect(apres, "postes et fiches hôtellerie reviennent avec la demande").toEqual(avant);
  expect(await statutSpo(indirectId)).toBe("PRE_VALIDATED");
});

// ─────────────────────────────── 8. Refuser ; retirer (annuler) une demande ───────────────────────────────

test("8 · un sponsoring REFUSÉ à la dernière étape (avis défavorable du NS d'abord) ; un autre RETIRÉ par son demandeur", async ({ page }) => {
  test.setTimeout(240_000);
  for (const inst of [INSTITUTION_REFUS, `${P} Demande à retirer`]) {
    await login(page, "kam");
    await aller(page, "/sponsoring?new=1");
    const panneau = await remplirSponsoring(page, inst, "DIRECT", "100000", "90000");
    await panneau.locator('input[name="files"]').setInputFiles([{ name: "d.pdf", mimeType: "application/pdf", buffer: pdfMinimal(inst) }]);
    await panneau.getByRole("button", { name: "Enregistrer" }).click();
    await page.waitForURL(/\/sponsoring\/[a-z0-9]+$/, { timeout: 60_000 });
  }
  const refus = (await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION_REFUS } })).id;
  const retrait = (await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: `${P} Demande à retirer` } })).id;

  await login(page, "ns");
  await aller(page, `/sponsoring/${refus}`);
  await geste(page, /Avis défavorable/, "Opportunité faible selon le terrain.", /Émettre l'avis défavorable/);
  await login(page, "ops");
  await aller(page, `/sponsoring/${refus}`);
  await geste(page, /^Approuver$/, null, /Confirmer/);
  await login(page, "dm");
  await aller(page, `/sponsoring/${refus}`);
  await geste(page, /^Refuser$/, "Hors stratégie produit 2026.", /^Refuser$/);
  await expect.poll(() => statutSpo(refus)).toMatch(/REJECTED|REFUSED/);
  await capture(page, "v1-13-refuse");

  await login(page, "kam");
  await aller(page, `/sponsoring/${retrait}`);
  await page.getByRole("button", { name: "Autres actions", exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Retirer la demande" }).click();
  await page.getByPlaceholder("Pourquoi retirer la demande (obligatoire)…").fill("L'association a annulé l'événement.");
  // « Retirer » SUPPRIME la demande (circuit, postes, pièces) : elle part à la corbeille, d'où elle se restaure.
  await cliquerDecisif(page.getByRole("button", { name: /^Retirer$/ }));
  await expect.poll(async () => prisma.sponsoringRequest.count({ where: { id: retrait } })).toBe(0);
  const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: retrait } });
  expect(rec.purgedAt).toBeNull();
});

// ─────────────────────────────── 9. Billets et bon de commande : l'assistante de direction ───────────────────────────────

test("9 · BILLETS : un voyageur complet (trajet, date, passeport) envoyé à l'assistante ; HÔTEL accordé, le BC demandé à l'assistante", async ({ page }) => {
  test.setTimeout(240_000);
  const billets = (await postesInd()).find((p) => p.kind === "TICKETING")!;
  const hotel = (await postesInd()).find((p) => p.kind === "ACCOMMODATION")!;
  await login(page, "ops");
  await aller(page, `/sponsoring/${indirectId}`);
  let c = carte(page, billets.label);
  await c.getByRole("button", { name: "Ajouter un voyageur" }).click();
  await c.getByLabel("Prénom", { exact: true }).fill("Amel");
  await c.getByLabel("Nom", { exact: true }).fill("Haddad");
  await c.getByLabel("Étape 1 — départ").fill("Alger");
  await c.getByLabel("Étape 1 — arrivée").fill("Oran");
  await c.getByLabel("Étape 1 — date").fill("2026-11-20");
  // Le passeport dès la création (le sélecteur de fichiers est caché derrière son bouton).
  await c.locator('input[type="file"][aria-label="Passeport"]').setInputFiles([{ name: "passeport-haddad.png", mimeType: "image/png", buffer: PNG }]);
  await c.getByRole("button", { name: "Ajouter le voyageur" }).click();
  await expect.poll(async () => prisma.adProVoyageur.count({ where: { itemId: billets.id } })).toBe(1);
  await page.reload();
  await page.waitForLoadState("networkidle");
  c = carte(page, billets.label);
  // La fiche complète part à l'assistante de direction (la réservation se demande fiche par fiche).
  await c.getByRole("button", { name: /Envoyer les fiches prêtes \(1\)/ }).click();
  await expect.poll(async () => prisma.demandeReservation.count({ where: { voyageur: { itemId: billets.id } } })).toBe(1);

  await login(page, "ast");
  await aller(page, "/demandes?onglet=adpro");
  await expect(page.getByText(/Haddad/).first(), "l'assistante voit la fiche billet").toBeVisible();
  await capture(page, "v1-14-bureau-billets");

  // L'HÔTEL : soumis, accordé par la Direction Marketing, puis le BC demandé à l'assistante.
  await login(page, "ops");
  await aller(page, `/sponsoring/${indirectId}`);
  await carte(page, hotel.label).getByRole("button", { name: /Soumettre pour validation/ }).click();
  await expect.poll(async () => (await prisma.adProItem.findUniqueOrThrow({ where: { id: hotel.id } })).status).toBe("PENDING");
  await login(page, "dm");
  await aller(page, `/sponsoring/${indirectId}`);
  c = carte(page, hotel.label);
  await c.getByRole("button", { name: "Valider et choisir le budget" }).click();
  await c.getByRole("combobox", { name: "Budget qui portera ce poste" }).selectOption({ label: `${P} Enveloppe Ad & Pro 2026 › ${P} Sponsoring` });
  await cliquerDecisif(c.getByRole("button", { name: "Accorder" }));
  await expect.poll(async () => (await prisma.adProItem.findUniqueOrThrow({ where: { id: hotel.id } })).status).toBe("APPROVED");
  expect(Number((await prisma.adProItem.findUniqueOrThrow({ where: { id: hotel.id } })).amountGranted), "accordé = l'estimé de la répartition").toBe(360000.4);

  await login(page, "ops");
  await aller(page, `/sponsoring/${indirectId}`);
  c = carte(page, hotel.label);
  await c.getByRole("button", { name: /Demander l'émission du BC|Envoyer la demande de BC/ }).first().click();
  // Plusieurs assistantes actives : on choisit la nôtre (une seule : elle est choisie d'office).
  const assistante = page.getByRole("combobox", { name: /Assistante/ });
  if (await assistante.count()) await assistante.first().selectOption({ label: R.ast.nom });
  await page.getByRole("textbox", { name: "Message de la demande d'émission du bon de commande" }).fill("BC pour l'hôtel Sheraton Oran, 4 nuits.");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect.poll(async () => (await prisma.adProItem.findUniqueOrThrow({ where: { id: hotel.id } })).orderStage, { timeout: 20_000 }).toBe("REQUESTED");
  const demande = await prisma.documentRequest.findFirst({ where: { entityType: "AD_PRO_ITEM", entityId: hotel.id } });
  expect(demande, "une demande de pièce (BC) est ouverte pour l'assistante").not.toBeNull();
  expect(demande!.askedToId).toBe(ids.ast);
  await capture(page, "v1-15-bc-demande", carte(page, hotel.label));
});
