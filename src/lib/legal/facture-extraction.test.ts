import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";

/**
 * LA SORTIE DES FACTURES HORS DES BONS DE COMMANDE — prouvée sur des données, pas sur une lecture.
 *
 * Cette migration a été écrite sans voir la base de production : elle déplace des pièces et crée
 * des documents à partir d'une hypothèse sur la façon dont les factures y sont classées. Une
 * migration de DONNÉES qu'on ne fait tourner qu'une fois, au déploiement, n'a aucune seconde
 * chance — d'où ce test, qui rejoue LE TEXTE RÉEL du fichier `.sql` (pas une copie qui aurait
 * divergé) sur un jeu construit à la main.
 *
 * Ce qu'il vérifie, et pourquoi chacun compte :
 *   • la facture devient une pièce Legal, le fichier DÉMÉNAGE (il n'est pas recopié) ;
 *   • une pièce qui n'est PAS une facture ne bouge pas — le filtre doit être étroit ;
 *   • une facture attachée à un CONTRAT ne bouge pas non plus : la consigne visait les bons ;
 *   • LES LECTEURS SUIVENT — sans quoi sortir une facture d'un bon restreint l'exposerait à tout
 *     le module, silencieusement. C'est le défaut le plus coûteux que ce fichier puisse avoir ;
 *   • rien n'est INVENTÉ : montant, référence, dates et contrepartie restent vides ;
 *   • rejouer la migration ne crée pas de doublon.
 */

const TAG = "EXTRACT-FACT-TEST";
const SQL = join(process.cwd(), "prisma", "migrations", "20261003100000_factures_sorties_des_bons", "migration.sql");

/** Rejoue le fichier de migration, instruction par instruction (commentaires retirés d'abord). */
async function rejouerLaMigration(): Promise<void> {
  const brut = readFileSync(SQL, "utf8");
  const sansCommentaires = brut
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  for (const stmt of sansCommentaires.split(";")) {
    if (stmt.trim()) await prisma.$executeRawUnsafe(stmt);
  }
}

let bcId = "";
let contratId = "";
let lecteurId = "";
let deposantId = "";
let dossierId = "";
let factureA = "";
let factureB = "";
let bonDeLivraison = "";
let factureDuContrat = "";

beforeAll(async () => {
  const [lecteur, deposant] = await Promise.all([
    prisma.user.create({ data: { name: `${TAG} lecteur`, email: `${TAG.toLowerCase()}-l@amd.dz`, role: "VIEWER", passwordHash: "x" }, select: { id: true } }),
    prisma.user.create({ data: { name: `${TAG} déposant`, email: `${TAG.toLowerCase()}-d@amd.dz`, role: "VIEWER", passwordHash: "x" }, select: { id: true } }),
  ]);
  lecteurId = lecteur.id;
  deposantId = deposant.id;

  const dossier = await prisma.legalFolder.create({ data: { name: `${TAG} dossier` }, select: { id: true } });
  dossierId = dossier.id;

  // UN BON DE COMMANDE RESTREINT : c'est le cas dangereux — ses lecteurs doivent suivre.
  const bc = await prisma.legalDocument.create({
    data: {
      title: `${TAG} BC fournitures`, kind: "PURCHASE_ORDER", reference: "BC-2026-014",
      counterparty: "Papeterie du Centre", folderId: dossierId, createdById: deposantId,
      readers: { create: [{ userId: lecteurId }] },
    },
    select: { id: true },
  });
  bcId = bc.id;

  const contrat = await prisma.legalDocument.create({
    data: { title: `${TAG} contrat cadre`, kind: "CONTRACT", createdById: deposantId },
    select: { id: true },
  });
  contratId = contrat.id;

  const piece = (name: string, category: "INVOICE" | "DELIVERY_NOTE", entityId: string) =>
    prisma.document.create({
      data: {
        name, category, entityType: "LEGAL_DOCUMENT", entityId,
        fileKey: `${TAG}/${name}`, confidentiality: "INTERNAL", uploadedById: deposantId,
      },
      select: { id: true },
    });

  const [a, b, bl, fc] = await Promise.all([
    piece("Facture 2026-0181.pdf", "INVOICE", bc.id),
    piece("FACT-2026-0182.PDF", "INVOICE", bc.id),
    piece("Bon de livraison 77.pdf", "DELIVERY_NOTE", bc.id),
    piece("Facture du contrat.pdf", "INVOICE", contrat.id),
  ]);
  factureA = a.id; factureB = b.id; bonDeLivraison = bl.id; factureDuContrat = fc.id;

  await rejouerLaMigration();
});

afterAll(async () => {
  const crees = [`linv_${factureA}`, `linv_${factureB}`];
  await retirerDocumentsEtContenu({ where: { fileKey: { startsWith: `${TAG}/` } } });
  await prisma.auditLog.deleteMany({ where: { id: { in: [`alinv_${factureA}`, `alinv_${factureB}`] } } });
  await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: crees } } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: crees } } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: [bcId, contratId] } } });
  await prisma.legalFolder.deleteMany({ where: { id: dossierId } });
  await retirerComptesEtSemis({ where: { id: { in: [lecteurId, deposantId] } } });
});

describe("les factures sortent des bons de commande", () => {
  it("chaque facture devient une PIÈCE LEGAL de nature Facture, reliée à son bon", async () => {
    const doc = await prisma.legalDocument.findUnique({ where: { id: `linv_${factureA}` } });
    expect(doc, "la facture n'a pas été érigée en pièce Legal").not.toBeNull();
    expect(doc!.kind).toBe("INVOICE");
    expect(doc!.chainFromId).toBe(bcId);
    // Le titre vient du NOM DU FICHIER, sans son extension — la seule information réelle.
    expect(doc!.title).toBe("Facture 2026-0181");
    // L'extension en majuscules se retire aussi.
    const b = await prisma.legalDocument.findUnique({ where: { id: `linv_${factureB}` } });
    expect(b!.title).toBe("FACT-2026-0182");
  });

  it("LE FICHIER DÉMÉNAGE — il n'est pas recopié, le bon ne le porte plus", async () => {
    const piece = await prisma.document.findUnique({ where: { id: factureA }, select: { entityId: true } });
    expect(piece!.entityId).toBe(`linv_${factureA}`);
    const restantes = await prisma.document.count({
      where: { entityType: "LEGAL_DOCUMENT", entityId: bcId, category: "INVOICE" },
    });
    expect(restantes, "une facture est restée dans le bon").toBe(0);
  });

  it("ce qui n'est PAS une facture ne bouge pas — le filtre reste étroit", async () => {
    const bl = await prisma.document.findUnique({ where: { id: bonDeLivraison }, select: { entityId: true } });
    expect(bl!.entityId).toBe(bcId);
  });

  it("une facture attachée à un CONTRAT ne bouge pas : la consigne visait les BONS", async () => {
    const fc = await prisma.document.findUnique({ where: { id: factureDuContrat }, select: { entityId: true } });
    expect(fc!.entityId).toBe(contratId);
    expect(await prisma.legalDocument.findUnique({ where: { id: `linv_${factureDuContrat}` } })).toBeNull();
  });

  it("LES LECTEURS SUIVENT — sortir une facture d'un bon restreint ne l'expose pas", async () => {
    // Un document Legal sans lecteur désigné est ouvert à TOUT le module : ne pas recopier les
    // lecteurs aurait élargi l'accès en silence, ce qu'aucun écran n'aurait signalé.
    const lecteurs = await prisma.legalDocumentReader.findMany({
      where: { documentId: `linv_${factureA}` }, select: { userId: true },
    });
    expect(lecteurs.map((l) => l.userId)).toEqual([lecteurId]);
  });

  it("RIEN N'EST INVENTÉ : montant, référence, dates et contrepartie restent à compléter", async () => {
    const doc = await prisma.legalDocument.findUnique({ where: { id: `linv_${factureA}` } });
    expect(doc!.amount).toBeNull();
    expect(doc!.reference).toBeNull();
    expect(doc!.startDate).toBeNull();
    expect(doc!.endDate).toBeNull();
    expect(doc!.counterparty, "la contrepartie du BON n'est pas celle de la facture").toBeNull();
    // Ce qu'on SAIT du bon vit dans la note, pas dans les champs.
    expect(doc!.notes).toContain("BC-2026-014");
    expect(doc!.notes).toContain("Papeterie du Centre");
    expect(doc!.notes).toMatch(/à compléter/i);
    // Le classement et le déposant sont des FAITS : ils suivent.
    expect(doc!.folderId).toBe(dossierId);
    expect(doc!.createdById).toBe(deposantId);
  });

  it("le journal garde la trace du déménagement — une pièce déplacée sans trace se croit perdue", async () => {
    const trace = await prisma.auditLog.findUnique({ where: { id: `alinv_${factureA}` } });
    expect(trace).not.toBeNull();
    expect(trace!.entityId).toBe(`linv_${factureA}`);
    expect(trace!.summary).toContain("BC-2026-014");
  });

  it("REJOUER la migration ne crée aucun doublon", async () => {
    const avantDocs = await prisma.legalDocument.count({ where: { id: { startsWith: "linv_" } } });
    const avantLecteurs = await prisma.legalDocumentReader.count({ where: { documentId: { startsWith: "linv_" } } });
    await rejouerLaMigration();
    expect(await prisma.legalDocument.count({ where: { id: { startsWith: "linv_" } } })).toBe(avantDocs);
    expect(await prisma.legalDocumentReader.count({ where: { documentId: { startsWith: "linv_" } } })).toBe(avantLecteurs);
  });
});
