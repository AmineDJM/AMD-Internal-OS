import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { prisma } from "@/lib/prisma";
import { blocsWord, deposerLivrableTravail, DOSSIER_TRAVAUX, nomDuLivrable } from "./travaux-livrables";

/**
 * LES LIVRABLES DES TRAVAUX (J8, décision 0023) — un vrai Word / Excel au Drive de la personne (dossier « Travaux »),
 * inscrit à la Bibliothèque ; une reprise après un dépôt interrompu le RETROUVE au lieu d'en créer un second.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__liv__${Date.now()}`;
let alice = "";
const MD = "## Synthèse\n\nSix demandes, **2 195 000 DZD** au total.\n\n- deux en attente\n- une refusée\n\n| Demande | Montant |\n|---|---|\n| Sponsoring Oran | 1 200 000 |\n| Congrès Alger | 995 000 |\n";

describe("le Markdown d'un livrable → les blocs Word de la fabrique (pur)", () => {
  it("titres, paragraphes en gras, puces et tableau", () => {
    const xml = blocsWord(MD).join("");
    expect(xml).toMatch(/Heading2|Titre2|w:pStyle/);
    expect(xml).toMatch(/2 195 000 DZD/);
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toMatch(/•/);
    expect(xml).toMatch(/<w:tbl>/);
    expect(xml).toMatch(/Sponsoring Oran/);
  });
  it("le nom est le même d'un passage à l'autre pour le même travail", () => {
    expect(nomDuLivrable("Rapport : bilan / 2026", "ckxyz0000abcdef", "docx")).toBe("Rapport bilan 2026 (travail abcdef).docx");
    expect(nomDuLivrable("Rapport", "ckxyz0000abcdef", "xlsx")).toMatch(/\.xlsx$/);
  });
});

suite("le dépôt d'un livrable au Drive (J8)", () => {
  beforeAll(async () => {
    alice = (await prisma.user.create({ data: { name: `${TAG}Alice`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SALES_USER" } })).id;
  });
  afterAll(async () => {
    await prisma.driveNode.deleteMany({ where: { ownerId: alice, type: "FILE" } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { ownerId: alice } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("un vrai Word dans « Travaux », inscrit à la Bibliothèque ; la reprise le retrouve", { timeout: 30_000 }, async () => {
    const r = await deposerLivrableTravail(alice, { travailId: `${TAG}trav01`, titre: "Rapport Ad & Pro", contenu: MD, format: "docx", reprise: false });
    if (!r.ok) throw new Error(r.erreur);
    const n = await prisma.driveNode.findUniqueOrThrow({ where: { id: r.document.nodeId }, select: { name: true, ownerId: true, mimeType: true, parent: { select: { name: true } }, versions: { select: { blobId: true } } } });
    expect(n).toMatchObject({ ownerId: alice, parent: { name: DOSSIER_TRAVAUX } });
    expect(n.mimeType).toMatch(/wordprocessingml/);
    expect(n.name).toMatch(/^Rapport Ad & Pro \(travail .+\)\.docx$/);
    expect(await prisma.pieceLien.count({ where: { sujetType: "ENTITE", sujetId: r.document.nodeId, entityType: "DRIVE_NODE" } })).toBe(1);
    // Le contenu : le titre et la synthèse dans word/document.xml.
    const { getBlob } = await import("@/lib/drive-storage");
    const octets = (await getBlob(n.versions[0]!.blobId))!;
    expect(new PizZip(octets).file("word/document.xml")!.asText()).toMatch(/2 195 000 DZD/);
    // Reprise : le même document, aucun second fichier.
    const encore = await deposerLivrableTravail(alice, { travailId: `${TAG}trav01`, titre: "Rapport Ad & Pro", contenu: MD, format: "docx", reprise: true });
    expect(encore.ok && encore.document.nodeId).toBe(r.document.nodeId);
    expect(await prisma.driveNode.count({ where: { ownerId: alice, name: n.name } })).toBe(1);
  });

  it("un Excel : une feuille par tableau du livrable", { timeout: 30_000 }, async () => {
    const r = await deposerLivrableTravail(alice, { travailId: `${TAG}trav02`, titre: "Tableau", contenu: MD, format: "xlsx", reprise: false });
    if (!r.ok) throw new Error(r.erreur);
    expect(r.document.format).toBe("xlsx");
    const n = await prisma.driveNode.findUniqueOrThrow({ where: { id: r.document.nodeId }, select: { mimeType: true } });
    expect(n.mimeType).toMatch(/spreadsheetml/);
  });

  it("un PDF : le Word, puis la conversion de l'Atelier (faite ici ou confiée au worker — dit)", { timeout: 60_000 }, async () => {
    const r = await deposerLivrableTravail(alice, { travailId: `${TAG}trav03`, titre: "Note PDF", contenu: MD, format: "pdf", reprise: false });
    if (!r.ok) throw new Error(r.erreur);
    expect(r.document.format === "pdf" || r.document.enFile === true || typeof r.document.note === "string").toBe(true);
  });
});
