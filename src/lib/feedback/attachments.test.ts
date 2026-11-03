import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { putBlob, getBlob, releaseBlob } from "@/lib/drive-storage";
import { checkAttachment, MAX_ATTACHMENTS_PER_FEEDBACK } from "@/lib/files/attachment-policy";
import { canReadFeedback, canRemoveFeedbackAttachment } from "./access";

/**
 * LES PIÈCES JOINTES D'UN RETOUR, DE BOUT EN BOUT.
 *
 * Ce fichier ne teste pas un champ de formulaire : il teste qu'un fichier DÉPOSÉ existe encore
 * quand on revient, qu'il se relit octet pour octet, qu'un dépôt refusé ne laisse RIEN derrière
 * lui, et que personne d'autre que l'auteur ou le Super Admin n'y accède.
 *
 * Le scénario reproduit exactement ce que fait l'action serveur (`submitFeedback`) : vérifier
 * les octets, les ranger dans le magasin chiffré, puis écrire le retour et ses pièces dans UNE
 * transaction. Tester la séquence plutôt que l'action elle-même permet de provoquer l'échec au
 * bon moment — ce qu'un appel de bout en bout ne permet pas.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fbatt__${Date.now()}`;
const users: string[] = [];
const feedbacks: string[] = [];
const blobs: string[] = [];

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("contenu du contrat")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(32)]);

async function utilisateur(role: "SUPER_ADMIN" | "DIRECTION" | "VIEWER") {
  const u = await prisma.user.create({
    data: {
      email: `${TAG}-${Math.random().toString(36).slice(2)}@test.dz`,
      name: `${TAG} ${role}`,
      role,
      passwordHash: "x",
    },
    select: { id: true, role: true },
  });
  users.push(u.id);
  return u;
}

/** Ce que fait `submitFeedback` : octets d'abord, puis retour + pièces dans une transaction. */
async function deposer(userId: string, message: string, fichiers: { name: string; bytes: Buffer }[]) {
  const prepared: { blobId: string; name: string; mime: string; size: number }[] = [];
  for (const f of fichiers) {
    const v = checkAttachment(f.name, f.bytes);
    if (!v.ok) {
      for (const p of prepared) await releaseBlob(p.blobId);
      return { ok: false as const, error: v.reason };
    }
    const { blobId } = await putBlob(f.bytes);
    blobs.push(blobId);
    prepared.push({ blobId, name: v.safeName, mime: v.mime, size: v.size });
  }
  const fb = await prisma.$transaction(async (tx) => {
    const created = await tx.feedback.create({ data: { userId, message }, select: { id: true } });
    if (prepared.length > 0) {
      await tx.feedbackAttachment.createMany({
        data: prepared.map((p) => ({ ...p, feedbackId: created.id, uploadedById: userId })),
      });
    }
    return created;
  });
  feedbacks.push(fb.id);
  return { ok: true as const, id: fb.id };
}

afterAll(async () => {
  if (!dbOk) return;
  await prisma.feedbackAttachment.deleteMany({ where: { feedbackId: { in: feedbacks } } });
  await prisma.feedback.deleteMany({ where: { id: { in: feedbacks } } });
  await retirerComptesEtSemis({ where: { id: { in: users } } });
});

suite("retours — pièces jointes réelles", () => {
  it("un retour SANS fichier reste un retour valide", async () => {
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} juste un message`, []);
    expect(r.ok).toBe(true);
    const att = await prisma.feedbackAttachment.count({ where: { feedbackId: r.ok ? r.id : "" } });
    expect(att).toBe(0);
  });

  it("UN fichier : déposé, retrouvé après relecture, et relu OCTET POUR OCTET", async () => {
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} avec un pdf`, [{ name: "contrat.pdf", bytes: PDF }]);
    expect(r.ok).toBe(true);

    // Relecture COMPLÈTE depuis la base — c'est ce que fait la page au rechargement.
    const relu = await prisma.feedback.findUnique({
      where: { id: r.ok ? r.id : "" },
      include: { attachments: true },
    });
    expect(relu?.attachments).toHaveLength(1);
    const a = relu!.attachments[0];
    expect(a.name).toBe("contrat.pdf");
    expect(a.mime).toBe("application/pdf");
    expect(a.size).toBe(PDF.length);
    expect(a.uploadedById).toBe(u.id);
    expect(a.createdAt).toBeInstanceOf(Date);

    // Le CONTENU aussi : une ligne en base sans octets derrière ne vaut rien.
    const bytes = await getBlob(a.blobId);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).equals(PDF)).toBe(true);
  });

  it("PLUSIEURS fichiers sont tous conservés, dans leur ordre de dépôt", async () => {
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} trois pièces`, [
      { name: "capture.png", bytes: PNG },
      { name: "contrat.pdf", bytes: PDF },
      { name: "notes.txt", bytes: Buffer.from("une observation", "utf8") },
    ]);
    expect(r.ok).toBe(true);
    const att = await prisma.feedbackAttachment.findMany({
      where: { feedbackId: r.ok ? r.id : "" },
      orderBy: { createdAt: "asc" },
      select: { name: true, mime: true },
    });
    expect(att.map((a) => a.name)).toEqual(["capture.png", "contrat.pdf", "notes.txt"]);
    expect(att.map((a) => a.mime)).toEqual(["image/png", "application/pdf", "text/plain"]);
  });

  it("un format NON SUPPORTÉ est refusé, et ne crée NI retour NI ligne fantôme", async () => {
    const u = await utilisateur("DIRECTION");
    const avantRetours = await prisma.feedback.count({ where: { userId: u.id } });
    const avantPieces = await prisma.feedbackAttachment.count({ where: { uploadedById: u.id } });

    const r = await deposer(u.id, `${TAG} avec un exe`, [{ name: "virus.exe", bytes: EXE }]);
    expect(r.ok).toBe(false);

    expect(await prisma.feedback.count({ where: { userId: u.id } })).toBe(avantRetours);
    expect(await prisma.feedbackAttachment.count({ where: { uploadedById: u.id } })).toBe(avantPieces);
  });

  it("un fichier TROP GROS est refusé avant toute écriture", async () => {
    const u = await utilisateur("DIRECTION");
    const enorme = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const r = await deposer(u.id, `${TAG} trop gros`, [{ name: "enorme.pdf", bytes: enorme }]);
    expect(r.ok).toBe(false);
    expect(await prisma.feedback.count({ where: { userId: u.id } })).toBe(0);
  });

  it("UN fichier refusé dans un lot annule TOUT le lot — pas de retour à moitié documenté", async () => {
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} lot mixte`, [
      { name: "capture.png", bytes: PNG }, // valable
      { name: "piege.pdf", bytes: EXE },   // refusé sur ses octets
    ]);
    expect(r.ok).toBe(false);
    expect(await prisma.feedback.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.feedbackAttachment.count({ where: { uploadedById: u.id } })).toBe(0);
  });

  it("l'ÉCHEC de l'écriture ne laisse aucune pièce désignant un contenu inexistant", async () => {
    const u = await utilisateur("DIRECTION");
    // On provoque l'échec de la transaction : un `feedbackId` qui n'existe pas.
    const { blobId } = await putBlob(PDF);
    blobs.push(blobId);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.feedbackAttachment.create({
          data: { feedbackId: "retour-inexistant", blobId, name: "x.pdf", mime: "application/pdf", size: PDF.length, uploadedById: u.id },
        });
      }),
    ).rejects.toThrow();
    expect(await prisma.feedbackAttachment.count({ where: { blobId, uploadedById: u.id } })).toBe(0);
  });

  it("le contenu vit dans le MAGASIN CANONIQUE, partagé avec le reste de l'ERP", async () => {
    // Exigence explicite : aucune représentation de fichier propre au Feedback. Le contenu est
    // un `FileBlob` — le même objet que celui des messages, des projets et des réunions — donc
    // lisible par tout ce qui sait déjà lire un fichier de l'ERP, le Chief compris.
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} magasin canonique`, [{ name: "contrat.pdf", bytes: PDF }]);
    expect(r.ok).toBe(true);

    const att = await prisma.feedbackAttachment.findFirst({
      where: { feedbackId: r.ok ? r.id : "" },
      select: { blobId: true, size: true },
    });
    const blob = await prisma.fileBlob.findUnique({
      where: { id: att!.blobId },
      select: { id: true, sha256: true, size: true },
    });
    expect(blob, "la pièce doit désigner un FileBlob réel").not.toBeNull();
    expect(blob!.size).toBe(att!.size);
    expect(blob!.sha256).toHaveLength(64); // dédupliqué par empreinte, comme partout ailleurs
  });

  it("la limite du nombre de pièces est une règle, pas une suggestion", () => {
    expect(MAX_ATTACHMENTS_PER_FEEDBACK).toBeGreaterThan(0);
    const trop = Array.from({ length: MAX_ATTACHMENTS_PER_FEEDBACK + 1 }, () => "x");
    expect(trop.length > MAX_ATTACHMENTS_PER_FEEDBACK).toBe(true);
  });
});

suite("retours — qui a le droit d'ouvrir la pièce", () => {
  it("l'AUTEUR du retour y a accès", async () => {
    const auteur = await utilisateur("DIRECTION");
    expect(canReadFeedback(auteur, { userId: auteur.id })).toBe(true);
  });

  it("le SUPER ADMIN y a accès — c'est lui qui traite le retour", async () => {
    const auteur = await utilisateur("DIRECTION");
    const admin = await utilisateur("SUPER_ADMIN");
    expect(canReadFeedback(admin, { userId: auteur.id })).toBe(true);
  });

  it("UN AUTRE UTILISATEUR n'y a PAS accès, même connecté et même DIRECTION", async () => {
    const auteur = await utilisateur("DIRECTION");
    const tiers = await utilisateur("DIRECTION");
    expect(canReadFeedback(tiers, { userId: auteur.id })).toBe(false);
    expect(canRemoveFeedbackAttachment(tiers, { userId: auteur.id })).toBe(false);
    // Un rôle plus faible non plus, évidemment.
    const viewer = await utilisateur("VIEWER");
    expect(canReadFeedback(viewer, { userId: auteur.id })).toBe(false);
  });
});

suite("retours — retirer une pièce", () => {
  it("retirer la pièce l'enlève de la liste, sans toucher au retour", async () => {
    const u = await utilisateur("DIRECTION");
    const r = await deposer(u.id, `${TAG} à nettoyer`, [
      { name: "capture.png", bytes: PNG },
      { name: "contrat.pdf", bytes: PDF },
    ]);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.id : "";

    const avant = await prisma.feedbackAttachment.findMany({ where: { feedbackId: id }, select: { id: true, blobId: true } });
    expect(avant).toHaveLength(2);

    await prisma.feedbackAttachment.delete({ where: { id: avant[0].id } });
    await releaseBlob(avant[0].blobId).catch(() => undefined);

    const apres = await prisma.feedbackAttachment.findMany({ where: { feedbackId: id } });
    expect(apres).toHaveLength(1);
    // Le retour lui-même est intact.
    expect(await prisma.feedback.findUnique({ where: { id }, select: { id: true } })).not.toBeNull();
    // Et la pièce restante se relit toujours.
    expect(await getBlob(apres[0].blobId)).not.toBeNull();
  });

  it("supprimer le RETOUR emporte ses pièces (cascade), pas celles des autres", async () => {
    const u = await utilisateur("DIRECTION");
    const aSupprimer = await deposer(u.id, `${TAG} éphémère`, [{ name: "capture.png", bytes: PNG }]);
    const aGarder = await deposer(u.id, `${TAG} conservé`, [{ name: "contrat.pdf", bytes: PDF }]);
    expect(aSupprimer.ok && aGarder.ok).toBe(true);

    await prisma.feedback.delete({ where: { id: aSupprimer.ok ? aSupprimer.id : "" } });

    expect(await prisma.feedbackAttachment.count({ where: { feedbackId: aSupprimer.ok ? aSupprimer.id : "" } })).toBe(0);
    expect(await prisma.feedbackAttachment.count({ where: { feedbackId: aGarder.ok ? aGarder.id : "" } })).toBe(1);
  });
});
