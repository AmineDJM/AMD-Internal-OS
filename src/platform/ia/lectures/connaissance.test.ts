import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { inscrireDocumentRh, traiterFile } from "@/modules/bibliotheque/api";
import { outilsConnaissance } from "./connaissance";

/**
 * LA BIBLIOTHÈQUE BRANCHÉE DANS L'ASSISTANT (J4, décision 0018) — sur la vraie base, sans Prisma simulé.
 *
 * Ce qu'on prouve : un document se retrouve par son CONTENU, pour qui peut l'ouvrir et pour lui seul (refus par
 * rôle / par droit d'ouverture) ; une pièce CONFIDENTIELLE (un bulletin) ne part jamais au modèle, ni par la
 * recherche ni par l'ouverture, même pour son propriétaire ; un fait confirmé suit la pièce dont il vient, et un fait
 * sensible n'est jamais rendu.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__conn_${Date.now().toString(36)}_`;
const pieces: string[] = [];
let proprio: CurrentUser;
let etranger: CurrentUser;
let notePiece = "";
let bulletinPiece = "";
const sujet = `${TAG}org`;

async function compte(nom: string, role: "MEDICAL_DELEGATE" | "VIEWER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const outil = (u: CurrentUser, nom: string) => outilsConnaissance(u).find((o) => o.def.name === nom)!;
const appeler = async (u: CurrentUser, nom: string, entree: Record<string, unknown>) => JSON.parse(await outil(u, nom).run(entree, u));

suite("Connaissance de l'entreprise (J4) — chercher_documents, ouvrir_documents, faits_confirmes", () => {
  beforeAll(async () => {
    proprio = await compte("proprio", "MEDICAL_DELEGATE");
    etranger = await compte("etranger", "VIEWER");
    const note = await putBlob(Buffer.from(`Note interne ${TAG} : rupture de la chaîne du froid à Tamanrasset, 120 boîtes de vaccin écartées.`, "utf8"));
    await enregistrerFichierDrive(proprio, { parentId: null }, { blobId: note.blobId, size: note.size, mimeType: "text/plain", name: `${TAG}Note froid.txt`, sha256: note.sha256 });
    notePiece = `piece_${note.sha256}`;
    pieces.push(notePiece);

    const emp = await prisma.employee.create({ data: { fullName: `${TAG}Employé`, userId: proprio.id } });
    const b = await putBlob(Buffer.from(`Bulletin ${TAG}. Salaire de base 185000. Chaîne du froid Tamanrasset.`, "utf8"));
    const doc = await prisma.employeeDocument.create({
      data: { employeeId: emp.id, category: "PAYSLIP", name: `${TAG}bulletin.txt`, blobId: b.blobId, mime: "text/plain", size: b.size, visibleToEmployee: true },
    });
    await inscrireDocumentRh({ id: doc.id, blobId: b.blobId, sha256: b.sha256, nom: doc.name, mime: "text/plain", taille: b.size, deposeParId: null });
    bulletinPiece = `piece_${b.sha256}`;
    pieces.push(bulletinPiece);
    for (let i = 0; i < 5; i++) if ((await traiterFile({ max: 20, seulement: pieces })).prises === 0) break;

    await prisma.faitConfirme.createMany({
      data: [
        { sujetType: "ORGANISATION", sujetId: sujet, attribut: "organisation.raisonSociale", valeur: `${TAG}Frigo SARL`, valeurNormalisee: `${TAG}frigo sarl`, source: "PIECE", pieceId: notePiece },
        { sujetType: "ORGANISATION", sujetId: sujet, attribut: "organisation.iban", valeur: null, sensible: true, source: "PIECE", pieceId: notePiece },
      ],
    });
  });

  afterAll(async () => {
    await prisma.faitConfirme.deleteMany({ where: { sujetId: sujet } }).catch(() => {});
    await prisma.bibliothequeFiche.deleteMany({ where: { pieceId: { in: pieces } } }).catch(() => {});
    await prisma.piece.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.employeeDocument.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("retrouve la note par son contenu pour qui peut l'ouvrir, et l'ouvre", async () => {
    const r = await appeler(proprio, "chercher_documents", { requete: "chaîne du froid Tamanrasset" });
    const ids = r.resultats.map((x: { id: string }) => x.id);
    expect(ids).toContain(notePiece);
    const o = await appeler(proprio, "ouvrir_documents", { ids: [notePiece] });
    expect(o.refus).toEqual([]);
    expect(o.documents[0].texte).toContain("120 boîtes");
  });

  it("refus par droit : un autre rôle ne la trouve pas, ne l'ouvre pas — et rien ne dit qu'elle existe", async () => {
    const r = await appeler(etranger, "chercher_documents", { requete: "chaîne du froid Tamanrasset" });
    expect(r.resultats.map((x: { id: string }) => x.id)).not.toContain(notePiece);
    const o = await appeler(etranger, "ouvrir_documents", { ids: [notePiece] });
    expect(o.documents).toEqual([]);
    expect(o.refus[0].raison).toBe("Pièce introuvable ou inaccessible.");
  });

  it("CONFIDENTIEL exclu : le bulletin du propriétaire ne part jamais au modèle", async () => {
    const r = await appeler(proprio, "chercher_documents", { requete: "bulletin salaire chaîne du froid Tamanrasset" });
    expect(r.resultats.map((x: { id: string }) => x.id)).not.toContain(bulletinPiece);
    expect(JSON.stringify(r)).not.toContain("185000");
    const o = await appeler(proprio, "ouvrir_documents", { ids: [bulletinPiece] });
    expect(o.documents).toEqual([]);
    expect(JSON.stringify(o)).not.toContain("185000");
  });

  it("un fait confirmé suit la pièce dont il vient ; un fait sensible n'est jamais rendu", async () => {
    const vu = await appeler(proprio, "faits_confirmes", { recherche: `${TAG}Frigo` });
    expect(vu.faits.map((f: { attribut: string }) => f.attribut)).toEqual(["organisation.raisonSociale"]);
    expect(vu.note).toMatch(/sensibles/);
    const refuse = await appeler(etranger, "faits_confirmes", { recherche: `${TAG}Frigo` });
    expect(refuse.faits).toEqual([]);
  });
});
