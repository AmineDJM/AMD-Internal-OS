/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — LES AIDES DE SEMIS PARTAGÉES par tous les domaines de tâches.
 *
 * Fichiers (Word, PDF, Excel) fabriqués à la volée, dépôt dans le Drive d'une persona (et dans un dossier), session
 * d'une persona, demande Ad & Pro « autre ». Le stockage des blobs et le dépôt du Drive sont INJECTÉS par l'appelant
 * (`brancherDepots`, frontière `src/lib/`) : la suite de tests et le script du banc passent les vrais gestes.
 * Un domaine qui a besoin d'un autre objet (fiche d'annuaire, dossier réglementaire…) l'écrit dans SON semis, par Prisma.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { PieceSemee } from "./types";

export async function docx(paragraphes: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphes.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function pdf(lignes: string[]): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fini = new Promise<void>((r) => doc.on("end", () => r()));
  doc.fontSize(14).text(lignes[0]!, { underline: true }).moveDown();
  doc.fontSize(10.5);
  for (const l of lignes.slice(1)) doc.text(l).moveDown(0.5);
  doc.end();
  await fini;
  return Buffer.concat(morceaux);
}

export async function xlsx(lignes: (string | number)[][], feuille = "Feuille 1"): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(feuille);
  for (const l of lignes) ws.addRow(l);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Un utilisateur de session, tel que `requireUser` le construit (la Vue exacte ajoute `impersonatedBy`). */
export async function sessionDe(userId: string, vueExacteDe?: { id: string; name: string }): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const access = await getAccess(u.id, u.role);
  return {
    id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false,
    ...(vueExacteDe ? { impersonatedBy: vueExacteDe } : {}),
  } as CurrentUser;
}

/**
 * Le stockage des pièces, PASSÉ par l'appelant (la suite de tests, le script du banc) : le module n'importe ni le
 * stockage des blobs ni le dépôt du Drive (frontière `src/lib/`), il en reçoit les deux gestes.
 */
export interface DepotsDuSemis {
  putBlob: (octets: Buffer) => Promise<{ blobId: string; size: number; sha256: string }>;
  enregistrerFichierDrive: (u: CurrentUser, cible: { parentId?: string | null }, f: { blobId: string; size: number; mimeType: string; name: string; sha256?: string | null }) => Promise<{ id: string }>;
}

let depots: DepotsDuSemis | null = null;

/** Branche les gestes de dépôt (appelé par `semerAudit` avant tout semis de domaine). */
export function brancherDepots(d: DepotsDuSemis): void {
  depots = d;
}

const MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
};

/** Dépose un fichier dans le Drive de `userId` (racine, ou le dossier `parentId`) ; le type suit l'extension du nom. */
export async function deposerPiece(userId: string, nom: string, octets: Buffer, parentId: string | null = null, mime?: string): Promise<PieceSemee> {
  if (!depots) throw new Error("banc d'audit : brancherDepots() n'a pas été appelé");
  const s = await sessionDe(userId);
  const b = await depots.putBlob(octets);
  const ext = nom.split(".").pop()?.toLowerCase() ?? "";
  const { id } = await depots.enregistrerFichierDrive(s, { parentId }, { blobId: b.blobId, size: b.size, mimeType: mime ?? MIMES[ext] ?? "application/octet-stream", name: nom, sha256: b.sha256 });
  return { id, nom };
}

/** Un dossier du Drive de `userId` (à la racine, ou sous `parentId`). */
export async function dossierDrive(userId: string, nom: string, parentId: string | null = null): Promise<PieceSemee> {
  const n = await prisma.driveNode.create({ data: { name: nom, type: "FOLDER", ownerId: userId, parentId, createdById: userId }, select: { id: true } });
  return { id: n.id, nom };
}

/** Une demande Ad & Pro « autre », au nom de `requesterId` (statut, montant, mois de création réglables). */
export async function demandeAdProAutre(d: {
  companyId: string; requesterId: string; reference: string; titre: string; description?: string; montant: number;
  statut?: "AWAITING_DECISION" | "APPROVED" | "REFUSED" | "DONE"; mois?: number;
}): Promise<string> {
  const an = new Date().getUTCFullYear();
  const r = await prisma.adProOtherRequest.create({
    data: {
      reference: d.reference, title: d.titre, description: d.description ?? d.titre, amount: d.montant, status: d.statut ?? "AWAITING_DECISION",
      companyId: d.companyId, requesterId: d.requesterId, createdById: d.requesterId, createdAt: new Date(Date.UTC(an, (d.mois ?? 6) - 1, 10)),
    } as never,
    select: { id: true },
  });
  return r.id;
}
