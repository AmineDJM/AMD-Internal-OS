import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import {
  capacites, chercherDocuments, embedderDeterministe, inscrireDocumentRh, inscrirePiece, oublierCapacites, ouvrirDocuments, traiterFile,
} from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BIBLIOTHÈQUE, DE BOUT EN BOUT (J1) — inscrire, lire une fois, retrouver par le contenu, sous les droits.
 *
 * Contre la vraie base : les fichiers entrent par la PORTE du Drive (`enregistrerFichierDrive`, qui inscrit),
 * l'ingestion les lit (lecteur réel pour le texte), le faux embedder déterministe remplace le fournisseur —
 * aucun appel réseau. Les deux chemins de recherche sont éprouvés : avec vecteur (si la base porte pgvector)
 * et SANS (le repli plein texte + trigrammes, forcé par `capacites`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bib_${Date.now().toString(36)}_`;
const embed = embedderDeterministe();
const pieces: string[] = [];

let proprio: SessionUser;
let invite: SessionUser;
let etranger: SessionUser;
let admin: SessionUser;
let contratId: string;
let noteId: string;
let corbeilleId: string;
let rhDocId: string;

async function compte(nom: string, role: "MEDICAL_DELEGATE" | "SUPER_ADMIN" = "MEDICAL_DELEGATE"): Promise<SessionUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, role: u.role, secondaryRole: access.secondaryRole, access };
}

async function deposer(user: SessionUser, nom: string, texte: string): Promise<string> {
  const ecrit = await putBlob(Buffer.from(texte, "utf8"));
  const r = await enregistrerFichierDrive(user, { parentId: null }, { blobId: ecrit.blobId, size: ecrit.size, mimeType: "text/plain", name: nom, sha256: ecrit.sha256 });
  pieces.push(`piece_${ecrit.sha256}`);
  return r.id;
}

/** Les clés des pièces de ce banc (les autres suites déposent aussi des fichiers dans la même base). */
const miennes = () => new Set([`DRIVE_NODE:${contratId}`, `DRIVE_NODE:${noteId}`, `DRIVE_NODE:${corbeilleId}`, `RH_DOCUMENT:${rhDocId}`, `MESSAGE_PIECE:${TAG}pj`]);

async function lireTout(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const b = await traiterFile({ max: 20, seulement: pieces, deps: { embed } });
    if (b.prises === 0) break;
  }
}

suite("Bibliothèque — inscrire, lire une fois, retrouver par le contenu, sous les droits", () => {
  beforeAll(async () => {
    proprio = await compte("proprio");
    invite = await compte("invite");
    etranger = await compte("etranger");
    admin = await compte("admin", "SUPER_ADMIN");

    contratId = await deposer(proprio, `${TAG}Contrat logistique.txt`,
      "Contrat de prestation. Le prestataire assure le transport frigorifique des vaccins entre Alger et Oran, sous température dirigée.");
    noteId = await deposer(proprio, `${TAG}Note qualité.txt`,
      "Note interne : la pharmacovigilance du lot 42 est close ; aucun effet indésirable grave n'a été déclaré.");
    corbeilleId = await deposer(proprio, `${TAG}Brouillon.txt`, "Brouillon oublié : transport frigorifique, version abandonnée.");
    await prisma.driveNode.update({ where: { id: corbeilleId }, data: { isTrashed: true } });
    await prisma.driveShare.create({ data: { nodeId: noteId, userId: invite.id, access: "VIEW" } });

    // Un bulletin dans le dossier RH du propriétaire : il l'ouvre (visible), un modèle jamais.
    const emp = await prisma.employee.create({ data: { fullName: `${TAG}Employé`, userId: proprio.id } });
    const bulletin = await putBlob(Buffer.from("Bulletin de paie octobre. Salaire de base 185000. Net à payer 160000. Transport frigorifique.", "utf8"));
    const doc = await prisma.employeeDocument.create({
      data: { employeeId: emp.id, category: "PAYSLIP", name: `${TAG}bulletin.txt`, blobId: bulletin.blobId, mime: "text/plain", size: bulletin.size, visibleToEmployee: true },
    });
    rhDocId = doc.id;
    await inscrireDocumentRh({ id: doc.id, blobId: bulletin.blobId, sha256: bulletin.sha256, nom: doc.name, mime: "text/plain", taille: bulletin.size, deposeParId: null });
    pieces.push(`piece_${bulletin.sha256}`);

    await lireTout();
  });

  afterAll(async () => {
    await prisma.bibliothequeFiche.deleteMany({ where: { pieceId: { in: pieces } } }).catch(() => {});
    await prisma.piece.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.employeeDocument.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la porte du Drive inscrit : registre, lien à l'endroit, fiche lue une fois et découpée", async () => {
    const f = await prisma.bibliothequeFiche.findFirstOrThrow({ where: { cles: { has: `DRIVE_NODE:${contratId}` } } });
    expect(f).toMatchObject({ statut: "FAITE", format: "texte", source: "DRIVE", methode: "texte", nbPassages: 1 });
    expect(await prisma.pieceLien.count({ where: { pieceId: f.pieceId, entityType: "DRIVE_NODE", sujetId: contratId } })).toBe(1);
    expect(await prisma.bibliothequePassage.count({ where: { pieceId: f.pieceId } })).toBe(1);
  });

  it("le même contenu rangé ailleurs n'est pas relu : la fiche gagne une clé, c'est tout", async () => {
    const f = await prisma.bibliothequeFiche.findFirstOrThrow({ where: { cles: { has: `DRIVE_NODE:${noteId}` } } });
    const avant = f.ingereLe;
    const blob = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: noteId }, select: { blobId: true } });
    const r = await inscrirePiece({
      blobId: blob.blobId, nom: "copie.txt", mime: "text/plain", source: "CONVERSATION",
      objet: { famille: "MESSAGE_PIECE", id: `${TAG}pj` }, proprietaireId: proprio.id,
    });
    expect(r).toMatchObject({ statut: "INSCRITE", pieceId: f.pieceId, nouvelle: false });
    const apres = await prisma.bibliothequeFiche.findUniqueOrThrow({ where: { pieceId: f.pieceId } });
    expect(apres.cles).toEqual([`DRIVE_NODE:${noteId}`, `MESSAGE_PIECE:${TAG}pj`].sort());
    expect(apres.familles).toEqual(["DRIVE_NODE", "MESSAGE_PIECE"]);
    expect(apres.statut).toBe("FAITE");
    expect(apres.ingereLe).toEqual(avant);
  });

  it("une nouvelle version prend la clé exclusive du nœud : l'ancienne ne ressort plus par là", async () => {
    const v2 = await putBlob(Buffer.from("Contrat de prestation, avenant 2 : transport frigorifique étendu à Constantine.", "utf8"));
    await enregistrerFichierDrive(proprio, { nodeId: contratId }, { blobId: v2.blobId, size: v2.size, mimeType: "text/plain", name: `${TAG}Contrat logistique.txt`, sha256: v2.sha256 });
    pieces.push(`piece_${v2.sha256}`);
    const porteurs = await prisma.bibliothequeFiche.findMany({ where: { cles: { has: `DRIVE_NODE:${contratId}` } }, select: { pieceId: true } });
    expect(porteurs.map((p) => p.pieceId)).toEqual([`piece_${v2.sha256}`]);
    await lireTout();
  });

  it("retrouve une pièce par son CONTENU, et l'extrait dit pourquoi", async () => {
    const r = await chercherDocuments(proprio, "pharmacovigilance lot 42", {}, { embed });
    expect(r.resultats[0]?.endroit.cle).toBe(`DRIVE_NODE:${noteId}`);
    expect(r.resultats[0].extrait.filter((s) => s.fort).map((s) => s.texte.toLowerCase())).toContain("pharmacovigilance");
    expect(r.resultats[0].endroit.lien).toBe(`/drive/${noteId}`);
  });

  it("le repli SANS pgvector (plein texte + trigrammes) trouve aussi, et le dit", async () => {
    const r = await chercherDocuments(proprio, "vaccins frigorifique", {}, { embed, capacites: { vecteur: false, trigrammes: false } });
    expect(r.mode).toMatchObject({ vecteur: false, vecteurUtilise: false });
    expect(r.resultats.map((x) => x.endroit.cle)).toContain(`DRIVE_NODE:${contratId}`);
    // Par le titre seul (trigrammes absents : LIKE replié).
    const t = await chercherDocuments(proprio, "note qualite", {}, { capacites: { vecteur: false, trigrammes: false } });
    expect(t.resultats.map((x) => x.endroit.cle)).toContain(`DRIVE_NODE:${noteId}`);
  });

  it("le chemin vectoriel (si la base porte pgvector) vectorise les passages et s'en sert", async () => {
    oublierCapacites();
    const cap = await capacites();
    if (!cap.vecteur) return; // la base de ce poste n'a pas pgvector : le repli est éprouvé ci-dessus
    const n = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "BibliothequePassage" WHERE "pieceId" IN (${pieces[1]}) AND "vecteur" IS NOT NULL`;
    expect(Number(n[0].n)).toBeGreaterThan(0);
    const r = await chercherDocuments(proprio, "effet indésirable grave déclaré", {}, { embed });
    expect(r.mode.vecteurUtilise).toBe(true);
    expect(r.resultats.find((x) => x.endroit.cle === `DRIVE_NODE:${noteId}`)?.voies).toContain("vecteur");
  });

  it("ZÉRO résultat hors droits : l'étranger ne voit rien, l'invité ne voit que ce qu'on lui a partagé", async () => {
    for (const q of ["transport frigorifique", "pharmacovigilance", "bulletin salaire", ""]) {
      expect((await chercherDocuments(etranger, q, {}, { embed })).resultats.filter((x) => miennes().has(x.endroit.cle))).toEqual([]);
    }
    const inv = await chercherDocuments(invite, "transport frigorifique pharmacovigilance", {}, { embed });
    expect(inv.resultats.filter((x) => miennes().has(x.endroit.cle)).map((x) => x.endroit.cle)).toEqual([`DRIVE_NODE:${noteId}`]);
  });

  it("la corbeille ne ressort pas, même pour son propriétaire", async () => {
    const r = await chercherDocuments(proprio, "brouillon oublié version abandonnée", {}, { embed });
    expect(r.resultats.map((x) => x.endroit.cle)).not.toContain(`DRIVE_NODE:${corbeilleId}`);
  });

  it("le bulletin s'ouvre à l'employé à l'écran, jamais pour un modèle (pourModele)", async () => {
    const ecran = await chercherDocuments(proprio, "bulletin salaire", {}, { embed });
    const vu = ecran.resultats.find((x) => x.endroit.cle === `RH_DOCUMENT:${rhDocId}`);
    expect(vu).toMatchObject({ confidentiality: "CONFIDENTIAL" });
    const modele = await chercherDocuments(proprio, "bulletin salaire transport frigorifique", {}, { embed, pourModele: true });
    expect(modele.resultats.map((x) => x.endroit.cle)).not.toContain(`RH_DOCUMENT:${rhDocId}`);
    // Son texte n'a pas été envoyé au fournisseur d'embeddings.
    const vecteurs = await prisma.bibliothequePassage.count({ where: { pieceId: { in: [pieces[3]] }, vectoriseLe: { not: null } } });
    expect(vecteurs).toBe(0);
    const o = await ouvrirDocuments(proprio, [pieces[3]], { pourModele: true });
    expect(o.documents).toEqual([]);
    expect(o.refus[0]).toMatchObject({ raison: "CONFIDENTIELLE" });
  });

  it("ouvrir rend le texte recousu sous les droits ; introuvable et interdit se disent pareil", async () => {
    const note = (await prisma.bibliothequeFiche.findFirstOrThrow({ where: { cles: { has: `DRIVE_NODE:${noteId}` } } })).pieceId;
    const ok = await ouvrirDocuments(invite, [note]);
    expect(ok.documents[0].texte).toContain("pharmacovigilance du lot 42");
    const refus = await ouvrirDocuments(etranger, [note, "piece_inexistante"]);
    expect(refus.documents).toEqual([]);
    expect(refus.refus.map((x) => x.message)).toEqual(["Pièce introuvable ou inaccessible.", "Pièce introuvable ou inaccessible."]);
  });

  it("les filtres (format, source, objet) restreignent sans jamais élargir", async () => {
    const parObjet = await chercherDocuments(admin, "transport", { objet: `DRIVE_NODE:${contratId}` }, { embed });
    expect(parObjet.resultats.map((x) => x.endroit.cle)).toEqual([`DRIVE_NODE:${contratId}`]);
    const pdfSeul = await chercherDocuments(admin, "transport frigorifique", { formats: "pdf" }, { embed });
    expect(pdfSeul.resultats.filter((x) => miennes().has(x.endroit.cle))).toEqual([]);
    const rh = await chercherDocuments(proprio, "salaire", { sources: "RH" }, { embed });
    expect(rh.resultats.every((x) => x.source === "RH")).toBe(true);
  });

  it("une inscription invalide est REJETÉE sans lever (le dépôt, lui, reste fait)", async () => {
    expect(await inscrirePiece({ blobId: "", nom: "x", source: "AUTRE", objet: { famille: "DOCUMENT", id: "d" }, proprietaireId: null }))
      .toMatchObject({ statut: "REJETEE" });
    expect(await inscrirePiece({ blobId: "blob_introuvable", nom: "x", source: "AUTRE", objet: { famille: "DOCUMENT", id: "d" }, proprietaireId: null }))
      .toMatchObject({ statut: "REJETEE", raison: "empreinte du blob introuvable" });
  });
});
