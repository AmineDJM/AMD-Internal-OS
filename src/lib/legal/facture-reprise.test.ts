import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";

/**
 * LA REPRISE DES FACTURES DÉJÀ ENREGISTRÉES — prouvée sur des données, pas sur une lecture.
 *
 * Fondre deux registres en un ne vaut que si l'ancien PART AVEC SES LIGNES. Une reprise de
 * données ne tourne qu'une fois, au déploiement, et n'a aucune seconde chance : si elle perd la
 * moitié des factures, personne ne s'en aperçoit avant qu'un fournisseur ne rappelle.
 *
 * D'où ce test, qui rejoue LE TEXTE RÉEL du fichier `.sql` — pas une copie qui aurait divergé —
 * sur un jeu construit à la main. La table `Invoice` étant SUPPRIMÉE par cette même migration,
 * le test la RECONSTRUIT telle qu'elle était : ce fichier est désormais le dernier endroit où sa
 * forme est écrite, et c'est assumé — c'est aussi le seul endroit qui en a encore besoin.
 *
 * Ce qu'il vérifie, et pourquoi chacun compte :
 *   • L'IDENTIFIANT EST CONSERVÉ. Pièces jointes, liens d'affaire et journal d'audit désignent
 *     les factures par cet identifiant : le régénérer aurait fait de chaque PDF un orphelin
 *     silencieux — présent en base, invisible de tout écran ;
 *   • le vocabulaire se traduit sans perte : n° → référence, émission → début, échéance → fin ;
 *   • la PAIRE destinataire/payeur se réduit à la partie EN FACE — celle que l'écriture
 *     comptable retenait déjà — et la paire complète part dans les notes plutôt qu'à la benne ;
 *   • le statut ne dit plus l'argent : ACTIVE, sauf CANCELLED ; `PARTIAL`, qui n'a pas
 *     d'équivalent, est ÉCRIT dans les notes au lieu d'être perdu ;
 *   • le RÈGLEMENT suit : date et écriture financière liée ;
 *   • LES PIÈCES JOINTES DÉMÉNAGENT — sans quoi la fiche du document légal serait vide ;
 *   • rejouer la migration ne crée pas de doublon, et ne casse pas.
 */

const TAG = "REPRISE-FACTURE-TEST";
const SQL = join(process.cwd(), "prisma", "migrations", "20261015090000_facture_document_legal_ordinaire", "migration.sql");

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * Découpe le fichier en instructions. Un simple `split(";")` couperait AU MILIEU des blocs
 * `DO $$ … END $$` — qui contiennent justement toute la reprise.
 */
function instructions(sql: string): string[] {
  const sansCommentaires = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const out: string[] = [];
  let courante = "";
  let dansDollar = false;
  for (let i = 0; i < sansCommentaires.length; i += 1) {
    if (sansCommentaires.startsWith("$$", i)) { dansDollar = !dansDollar; courante += "$$"; i += 1; continue; }
    const c = sansCommentaires[i];
    if (c === ";" && !dansDollar) { if (courante.trim()) out.push(courante); courante = ""; continue; }
    courante += c;
  }
  if (courante.trim()) out.push(courante);
  return out;
}

async function rejouerLaMigration(): Promise<void> {
  for (const stmt of instructions(readFileSync(SQL, "utf8"))) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

/** La table `Invoice` TELLE QU'ELLE ÉTAIT, remontée le temps du test. */
async function remonterLAncienneTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Invoice"`);
  await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "InvoiceStatus"`);
  await prisma.$executeRawUnsafe(`CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'CANCELLED')`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "Invoice" (
      "custom" JSONB,
      "id" TEXT NOT NULL,
      "companyId" TEXT,
      "number" TEXT,
      "title" TEXT NOT NULL,
      "issueDate" TIMESTAMP(3),
      "dueDate" TIMESTAMP(3),
      "paidDate" TIMESTAMP(3),
      "amount" DECIMAL(14,2),
      "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
      "recipient" TEXT,
      "payer" TEXT,
      "notes" TEXT,
      "sourceType" "EntityType",
      "sourceId" TEXT,
      "createdById" TEXT,
      "updatedById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "direction" TEXT NOT NULL DEFAULT 'OUT',
      "transactionId" TEXT,
      CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Invoice_transactionId_key" UNIQUE ("transactionId")
    )`);
}

const ID_RECUE = `${TAG}-recue`;
const ID_EMISE = `${TAG}-emise`;
const ID_PARTIELLE = `${TAG}-partielle`;
const ID_ANNULEE = `${TAG}-annulee`;
let txId = "";
let docId = "";

suite("Reprise : les factures rejoignent le registre des documents légaux", () => {
  beforeAll(async () => {
    await remonterLAncienneTable();

    const tx = await prisma.financeTransaction.create({
      data: {
        reference: `${TAG}-FIN`, date: new Date("2026-04-02"), direction: "OUT", category: "AUTRE",
        label: `${TAG} règlement`, amount: 240_000, method: "BANK_TRANSFER", account: "Banque", status: "SETTLED",
      },
      select: { id: true },
    });
    txId = tx.id;

    await prisma.$executeRawUnsafe(`
      INSERT INTO "Invoice" ("id","number","title","issueDate","dueDate","paidDate","amount","status","recipient","payer","notes","direction","transactionId")
      VALUES
        ('${ID_RECUE}', 'F-2026-118', '${TAG} Maintenance groupe froid', '2026-03-01', '2026-04-30', '2026-04-02', 240000, 'PAID', 'Froid Industriel SPA', 'Adventum Pharma', 'Contrat annuel.', 'OUT', '${txId}'),
        ('${ID_EMISE}', 'AV-2026-004', '${TAG} Prestation réglementaire', '2026-02-10', '2026-03-10', NULL, 500000, 'UNPAID', 'Adventum Pharma', 'Laboratoire Client SARL', NULL, 'IN', NULL),
        ('${ID_PARTIELLE}', NULL, '${TAG} Fournitures de bureau', NULL, NULL, NULL, 30000, 'PARTIAL', 'Papeterie du Centre', NULL, NULL, 'OUT', NULL),
        ('${ID_ANNULEE}', 'F-2026-090', '${TAG} Commande annulée', '2026-01-05', NULL, NULL, 12000, 'CANCELLED', 'Fournisseur X', NULL, NULL, 'OUT', NULL)
    `);

    // Une PIÈCE JOINTE rattachée à la facture par l'ancienne adresse.
    const d = await prisma.document.create({
      data: { name: `${TAG}-scan.pdf`, entityType: "INVOICE", entityId: ID_RECUE, category: "OTHER" },
      select: { id: true },
    });
    docId = d.id;

    await rejouerLaMigration();
  }, 60_000);

  afterAll(async () => {
    await retirerDocumentsEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Invoice"`).catch(() => {});
    await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "InvoiceStatus"`).catch(() => {});
  }, 60_000);

  it("L'IDENTIFIANT EST CONSERVÉ — sinon chaque pièce jointe devient un orphelin silencieux", async () => {
    const d = await prisma.legalDocument.findUnique({ where: { id: ID_RECUE } });
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("INVOICE");
  });

  it("le vocabulaire se traduit sans perte : n° → référence, émission → début, échéance → fin", async () => {
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_RECUE } });
    expect(d.reference).toBe("F-2026-118");
    expect(d.title).toBe(`${TAG} Maintenance groupe froid`);
    expect(d.startDate?.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(d.endDate?.toISOString().slice(0, 10)).toBe("2026-04-30");
    expect(Number(d.amount)).toBe(240_000);
    expect(d.direction).toBe("OUT");
  });

  it("LA PARTIE EN FACE est celle que l'écriture comptable retenait déjà — et le SENS la désigne", async () => {
    // Facture reçue : c'est le destinataire que l'écriture prenait pour contrepartie.
    const recue = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_RECUE } });
    expect(recue.counterparty).toBe("Froid Industriel SPA");
    // Facture émise : c'est le payeur.
    const emise = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_EMISE } });
    expect(emise.counterparty).toBe("Laboratoire Client SARL");
    expect(emise.direction).toBe("IN");
  });

  it("LA PAIRE COMPLÈTE PART DANS LES NOTES — un champ fusionné qui efface l'autre ment", async () => {
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_RECUE } });
    expect(d.notes).toContain("Contrat annuel.");
    expect(d.notes).toContain("Froid Industriel SPA");
    expect(d.notes).toContain("Adventum Pharma");
  });

  it("LE STATUT NE DIT PLUS L'ARGENT — et « partiel », sans équivalent, est ÉCRIT plutôt que perdu", async () => {
    const payee = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_RECUE } });
    expect(payee.status).toBe("ACTIVE");
    expect(payee.paidDate?.toISOString().slice(0, 10)).toBe("2026-04-02");

    const partielle = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_PARTIELLE } });
    expect(partielle.status).toBe("ACTIVE");
    expect(partielle.paidDate).toBeNull();
    expect(partielle.notes).toMatch(/PARTIEL/i);
  });

  it("une facture ANNULÉE le reste, avec son motif", async () => {
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_ANNULEE } });
    expect(d.status).toBe("CANCELLED");
    expect(d.cancelledAt).not.toBeNull();
    expect(d.cancelReason).toMatch(/annulée/i);
  });

  it("LE RÈGLEMENT SUIT — l'écriture financière reste liée à sa facture", async () => {
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_RECUE } });
    expect(d.settlementTxId).toBe(txId);
    // Et une facture non réglée n'en a pas : le lien ne s'invente pas.
    const emise = await prisma.legalDocument.findUniqueOrThrow({ where: { id: ID_EMISE } });
    expect(emise.settlementTxId).toBeNull();
  });

  it("LES PIÈCES JOINTES DÉMÉNAGENT — sans quoi la fiche du document serait vide", async () => {
    const d = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(d.entityType).toBe("LEGAL_DOCUMENT");
    expect(d.entityId).toBe(ID_RECUE);
  });

  it("REJOUER LA MIGRATION NE CASSE RIEN et ne double aucune facture", async () => {
    // La table n'existe plus : la reprise doit sortir sans rien faire, pas échouer.
    await rejouerLaMigration();
    expect(await prisma.legalDocument.count({ where: { title: { startsWith: TAG } } })).toBe(4);
  });

  it("LE SECOND REGISTRE A DISPARU — le laisser en place aurait rouvert le trou", async () => {
    const [{ existe }] = await prisma.$queryRawUnsafe<{ existe: string | null }[]>(
      `SELECT to_regclass('public."Invoice"')::text AS existe`,
    );
    expect(existe).toBeNull();
  });
});
