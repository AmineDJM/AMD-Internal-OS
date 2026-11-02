import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { canAccessConversation } from "@/lib/messaging";
import { canViewMeeting } from "@/lib/meetings";
import { canReadFeedback } from "@/lib/feedback/access";
import { peutOuvrirDocument, peutOuvrirPieceDeRapport, peutOuvrirPieceDeSujet } from "@/lib/entity-access/ouverture-pieces";
import { chercherDocuments, embedderDeterministe, inscrireDocument, inscrirePiece, traiterFile, type Famille } from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DROITS DANS L'INDEX, FAMILLE PAR FAMILLE (J1) — refus par rôle.
 *
 * Une pièce par famille d'endroits, la même phrase dans chacune. Pour chaque personne (rôles différents,
 * membres ou non), la recherche doit rendre EXACTEMENT ce que la règle d'ouverture de l'écran qui sert le
 * fichier lui ouvre : ni plus (zéro résultat hors droits), ni moins. La règle est appelée ici telle quelle,
 * pour comparer — la recherche, elle, l'appelle par `infra/acces.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bibdr_${Date.now().toString(36)}_`;
const PHRASE = "Procédure de rappel du lot ZX-77 : retrait des officines sous quarante-huit heures.";
const embed = embedderDeterministe();
const pieces: string[] = [];
const endroits: { famille: Famille; id: string }[] = [];

type Role = "SUPER_ADMIN" | "DIRECTION" | "MEDICAL_DELEGATE" | "MEDICAL_PROMOTION_MANAGER" | "SALES_USER" | "VIEWER";
const personnes: Record<string, SessionUser> = {};
let ids: { conversation: string; dossier: string; reunion: string; rapport: string; retour: string; document: { id: string; entityType: "DIRECTIVE"; entityId: string; stepKey: null } };

async function compte(nom: string, role: Role): Promise<SessionUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, role: u.role, secondaryRole: access.secondaryRole, access };
}

/** Un blob DIFFÉRENT par endroit (sinon une seule pièce porterait toutes les clés). */
async function blob(famille: string) {
  const e = await putBlob(Buffer.from(`${PHRASE} (${famille} ${TAG})`, "utf8"));
  pieces.push(`piece_${e.sha256}`);
  return e;
}

suite("Bibliothèque — la recherche rend exactement ce que la règle d'ouverture ouvre, par rôle", () => {
  beforeAll(async () => {
    personnes.admin = await compte("admin", "SUPER_ADMIN");
    personnes.direction = await compte("direction", "DIRECTION");
    personnes.auteur = await compte("auteur", "MEDICAL_DELEGATE");
    personnes.collegue = await compte("collegue", "MEDICAL_DELEGATE");
    personnes.manager = await compte("manager", "MEDICAL_PROMOTION_MANAGER");
    personnes.ventes = await compte("ventes", "SALES_USER");
    personnes.lecteur = await compte("lecteur", "VIEWER");
    const a = personnes.auteur;

    // Messagerie : un fil entre l'auteur et le collègue.
    const conv = await prisma.conversation.create({ data: { type: "DIRECT", createdById: a.id, members: { create: [{ userId: a.id }, { userId: personnes.collegue.id }] } } });
    const msg = await prisma.message.create({ data: { conversationId: conv.id, senderId: a.id, kind: "FILE", body: "" } });
    const b1 = await blob("MESSAGE_PIECE");
    const pj = await prisma.messageAttachment.create({ data: { messageId: msg.id, blobId: b1.blobId, name: `${TAG}rappel.txt`, mime: "text/plain", size: b1.size } });
    await inscrirePiece({ blobId: b1.blobId, empreinte: b1.sha256, nom: pj.name, mime: "text/plain", source: "CONVERSATION", objet: { famille: "MESSAGE_PIECE", id: pj.id }, proprietaireId: a.id });
    endroits.push({ famille: "MESSAGE_PIECE", id: pj.id });

    // Sujet : l'auteur l'a créé, le manager y participe.
    const dos = await prisma.dossier.create({ data: { reference: `${TAG}DOS`, title: "Rappel", createdById: a.id, participantIds: [personnes.manager.id] } });
    const dm = await prisma.dossierMessage.create({ data: { dossierId: dos.id, authorId: a.id, body: "" } });
    const b2 = await blob("SUJET_PIECE");
    const spj = await prisma.dossierMessageAttachment.create({ data: { messageId: dm.id, blobId: b2.blobId, name: `${TAG}rappel.txt`, mime: "text/plain", size: b2.size } });
    await inscrirePiece({ blobId: b2.blobId, empreinte: b2.sha256, nom: spj.name, mime: "text/plain", source: "AUTRE", objet: { famille: "SUJET_PIECE", id: spj.id }, proprietaireId: a.id });
    endroits.push({ famille: "SUJET_PIECE", id: spj.id });

    // Réunion : l'auteur l'organise, le collègue y participe.
    const reu = await prisma.meeting.create({
      data: { title: "Cellule de crise", slug: `${TAG}reu`, publicToken: `${TAG}tok`, organizerId: a.id, participants: { create: [{ userId: personnes.collegue.id }] } },
    });
    const mm = await prisma.meetingMessage.create({ data: { meetingId: reu.id, authorId: a.id, body: "" } });
    const b3 = await blob("REUNION_PIECE");
    const rpj = await prisma.meetingMessageAttachment.create({ data: { messageId: mm.id, blobId: b3.blobId, name: `${TAG}rappel.txt`, mime: "text/plain", size: b3.size } });
    await inscrirePiece({ blobId: b3.blobId, empreinte: b3.sha256, nom: rpj.name, mime: "text/plain", source: "CONVERSATION", objet: { famille: "REUNION_PIECE", id: rpj.id }, proprietaireId: a.id });
    endroits.push({ famille: "REUNION_PIECE", id: rpj.id });

    // Rapport terrain du délégué auteur.
    const rap = await prisma.fieldReport.create({ data: { delegateId: a.id } });
    const b4 = await blob("TERRAIN_PIECE");
    const tpj = await prisma.fieldReportAttachment.create({ data: { reportId: rap.id, blobId: b4.blobId, name: `${TAG}rappel.txt`, mime: "text/plain", size: b4.size } });
    await inscrirePiece({ blobId: b4.blobId, empreinte: b4.sha256, nom: tpj.name, mime: "text/plain", source: "AUTRE", objet: { famille: "TERRAIN_PIECE", id: tpj.id }, proprietaireId: a.id });
    endroits.push({ famille: "TERRAIN_PIECE", id: tpj.id });

    // Retour (feedback) de l'auteur.
    const fb = await prisma.feedback.create({ data: { userId: a.id, message: "rappel" } });
    const b5 = await blob("RETOUR_PIECE");
    const fpj = await prisma.feedbackAttachment.create({ data: { feedbackId: fb.id, blobId: b5.blobId, name: `${TAG}rappel.txt`, mime: "text/plain", size: b5.size, uploadedById: a.id } });
    await inscrirePiece({ blobId: b5.blobId, empreinte: b5.sha256, nom: fpj.name, mime: "text/plain", source: "AUTRE", objet: { famille: "RETOUR_PIECE", id: fpj.id }, proprietaireId: a.id });
    endroits.push({ famille: "RETOUR_PIECE", id: fpj.id });

    // Un `Document` de module (une directive) : la règle est `canAccessEntity` + les portes étroites.
    const b6 = await blob("DOCUMENT");
    const cle = `DIRECTIVE/${TAG}/rappel.txt`;
    await prisma.storedFile.create({ data: { key: cle, blobId: b6.blobId, size: b6.size } });
    const doc = await prisma.document.create({
      data: { name: `${TAG}rappel.txt`, category: "OTHER", entityType: "DIRECTIVE", entityId: `${TAG}dir`, fileKey: cle, mimeType: "text/plain", sizeBytes: b6.size, confidentiality: "INTERNAL", uploadedById: a.id },
    });
    await inscrireDocument({ documentId: doc.id, entityType: "DIRECTIVE", category: "OTHER", blobId: b6.blobId, sha256: b6.sha256, nom: doc.name, mime: "text/plain", taille: b6.size, deposeParId: a.id });
    endroits.push({ famille: "DOCUMENT", id: doc.id });

    ids = { conversation: conv.id, dossier: dos.id, reunion: reu.id, rapport: rap.id, retour: fb.id, document: { id: doc.id, entityType: "DIRECTIVE", entityId: `${TAG}dir`, stepKey: null } };
    for (let i = 0; i < 4; i++) if ((await traiterFile({ max: 20, seulement: pieces, deps: { embed } })).prises === 0) break;
  });

  afterAll(async () => {
    await prisma.bibliothequeFiche.deleteMany({ where: { pieceId: { in: pieces } } }).catch(() => {});
    await prisma.piece.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: ids?.conversation } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: ids?.dossier } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { id: ids?.reunion } }).catch(() => {});
    await prisma.fieldReport.deleteMany({ where: { id: ids?.rapport } }).catch(() => {});
    await prisma.feedback.deleteMany({ where: { id: ids?.retour } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { key: { startsWith: `DIRECTIVE/${TAG}` } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** Ce que la règle d'ouverture de chaque famille ouvre à cette personne — appelée telle quelle. */
  async function attendu(u: SessionUser): Promise<string[]> {
    const ok: string[] = [];
    const reu = await prisma.meeting.findUniqueOrThrow({ where: { id: ids.reunion }, select: { organizerId: true, participants: { select: { userId: true } } } });
    const dos = await prisma.dossier.findUniqueOrThrow({ where: { id: ids.dossier }, select: { createdById: true, assignedToId: true, participantIds: true } });
    for (const e of endroits) {
      const peut = e.famille === "MESSAGE_PIECE" ? await canAccessConversation(u.id, ids.conversation)
        : e.famille === "SUJET_PIECE" ? peutOuvrirPieceDeSujet(u, dos)
          : e.famille === "REUNION_PIECE" ? canViewMeeting(u, reu)
            : e.famille === "TERRAIN_PIECE" ? peutOuvrirPieceDeRapport(u, { delegateId: personnes.auteur.id })
              : e.famille === "RETOUR_PIECE" ? canReadFeedback(u, { userId: personnes.auteur.id })
                : await peutOuvrirDocument(u, ids.document);
      if (peut) ok.push(`${e.famille}:${e.id}`);
    }
    return ok.sort();
  }

  const mesCles = () => new Set(endroits.map((e) => `${e.famille}:${e.id}`));

  it("chaque pièce est lue, avec un passage", async () => {
    const f = await prisma.bibliothequeFiche.findMany({ where: { pieceId: { in: pieces } }, select: { statut: true, nbPassages: true } });
    expect(f).toHaveLength(endroits.length);
    expect(f.every((x) => x.statut === "FAITE" && x.nbPassages === 1)).toBe(true);
  });

  it.each(["admin", "direction", "auteur", "collegue", "manager", "ventes", "lecteur"])("%s : la recherche rend exactement ce que les règles d'ouverture lui ouvrent", async (qui) => {
    const u = personnes[qui];
    const r = await chercherDocuments(u, "rappel du lot ZX-77 retrait des officines", {}, { embed, limite: 50 });
    const vus = r.resultats.map((x) => x.endroit.cle).filter((k) => mesCles().has(k)).sort();
    expect(vus).toEqual(await attendu(u));
  });

  it("les refus sont réels : le collègue ne voit ni le sujet ni le retour de l'auteur ; un délégué des ventes, aucun", async () => {
    const col = await chercherDocuments(personnes.collegue, "rappel ZX-77", {}, { embed, limite: 50 });
    const k = col.resultats.map((x) => x.endroit.cle);
    expect(k).toContain(`MESSAGE_PIECE:${endroits[0].id}`);
    expect(k).toContain(`REUNION_PIECE:${endroits[2].id}`);
    expect(k).not.toContain(`SUJET_PIECE:${endroits[1].id}`);
    expect(k).not.toContain(`RETOUR_PIECE:${endroits[4].id}`);
    const ventes = await chercherDocuments(personnes.ventes, "rappel ZX-77", {}, { embed, limite: 50 });
    expect(ventes.resultats.filter((x) => mesCles().has(x.endroit.cle))).toEqual([]);
    expect(ventes.ecartesParLesDroits).toBeGreaterThan(0);
  });
});
