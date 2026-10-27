import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { DEPOT_PIECE, RELANCE, RENDEZ_VOUS, REPONSE_MESSAGE, dateHeure } from "@/lib/agent/operations/quotidien";
import { executerOperationIA, type PropositionCarte } from "@/lib/agent/operations";
import { lecturesQuotidien } from "@/lib/agent/lectures";

/**
 * L'ASSISTANT IA — LES GESTES DU QUOTIDIEN de l'assistante de direction, par les actions de
 * l'écran ; et ce qu'elle lit est à ELLE (ses conversations, ses demandes, ses brouillons).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaquot_${Date.now().toString(36)}_`;
let assistante: CurrentUser;
let directeur: CurrentUser;
let collegue: CurrentUser;
let convAvecCollegue = "";
let convDesAutres = "";
let demandeId = "";
let spoId = "";
let piece = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

const lire = async (u: CurrentUser, nom: string, entree: Record<string, unknown> = {}, props: PropositionCarte[] = []) =>
  JSON.parse(await lecturesQuotidien(u, props).find((o) => o.def.name === nom)!.run(entree, u));

suite("Assistant IA — gestes du quotidien", () => {
  beforeAll(async () => {
    assistante = await compte("assistante", "DIRECTION_ASSISTANT");
    directeur = await compte("directeur", "DIRECTION");
    collegue = await compte("collegue", "VIEWER");
    convAvecCollegue = (await prisma.conversation.create({ data: { members: { create: [{ userId: assistante.id }, { userId: collegue.id }] } } })).id;
    await prisma.message.create({ data: { conversationId: convAvecCollegue, senderId: collegue.id, body: `${TAG} Peux-tu m'envoyer le planning ?` } });
    convDesAutres = (await prisma.conversation.create({ data: { members: { create: [{ userId: directeur.id }, { userId: collegue.id }] } } })).id;
    await prisma.message.create({ data: { conversationId: convDesAutres, senderId: directeur.id, body: `${TAG} Sujet confidentiel` } });
    demandeId = (await prisma.validationRequest.create({ data: { reference: `${TAG}VAL-1`, title: `${TAG}Achat de toner`, module: "ADMIN", requesterId: assistante.id, steps: { create: [{ order: 1, validatorId: directeur.id }] } } })).id;
    spoId = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}Association`, type: "Congrès", requesterId: directeur.id, createdById: directeur.id } })).id;
    const { blobId, size } = await putBlob(Buffer.from(`%PDF-1.4 ${TAG} programme`));
    piece = (await enregistrerFichierDrive(directeur, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: "application/pdf", name: `${TAG}programme.pdf` })).id;
  });

  afterAll(async () => {
    await prisma.comment.deleteMany({ where: { entityId: demandeId } }).catch(() => {});
    await prisma.validationStep.deleteMany({ where: { requestId: demandeId } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: demandeId } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: spoId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversationId: { in: [convAvecCollegue, convDesAutres] } } }).catch(() => {});
    await prisma.conversationMember.deleteMany({ where: { conversationId: { in: [convAvecCollegue, convDesAutres] } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: { in: [convAvecCollegue, convDesAutres] } } }).catch(() => {});
    const evts = await prisma.calendarEvent.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.calendarInvite.deleteMany({ where: { eventId: { in: evts.map((e) => e.id) } } }).catch(() => {});
    await prisma.calendarEvent.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: [assistante?.id, directeur?.id].filter(Boolean) as string[] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [assistante?.id, directeur?.id, collegue?.id].filter(Boolean) as string[] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("les dates et heures s'écrivent comme on les dit", () => {
    expect(dateHeure("03/11/2026 à 14h30")).toBe("2026-11-03T14:30");
    expect(dateHeure("2026-11-03 9:05")).toBe("2026-11-03T09:05");
    expect(dateHeure("2026-11-03")).toBe("2026-11-03");
  });

  it("LIMITE : ses conversations, jamais celles des autres", async () => {
    const r = await lire(assistante, "mes_conversations");
    const texte = JSON.stringify(r);
    expect(texte).toContain("Peux-tu m'envoyer le planning");
    expect(texte).not.toContain("Sujet confidentiel");
  });

  it("relancer : hors Direction, la relance passe par la DISCUSSION — le validateur est prévenu", async () => {
    expect((await lire(assistante, "mes_demandes_en_attente")).demandes[0].enAttenteDe).toBe(directeur.name);
    const p = await RELANCE.proposer({ demande: `${TAG}VAL-1` }, assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.warnings[0]).toMatch(/discussion/);
    ACTOR = assistante;
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: RELANCE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.comment.count({ where: { entityType: "VALIDATION_REQUEST", entityId: demandeId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: directeur.id, link: `/validations/${demandeId}` } })).toBeGreaterThan(0);
  });

  it("répondre : dans SA conversation, en fil du dernier message reçu", async () => {
    const p = await REPONSE_MESSAGE.proposer({ conversation: `${TAG}collegue`, texte: "Je te l'envoie dans l'heure." }, assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = assistante;
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: REPONSE_MESSAGE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const envoye = await prisma.message.findFirstOrThrow({ where: { conversationId: convAvecCollegue, senderId: assistante.id } });
    expect(envoye.parentId).not.toBeNull();
    // Une conversation dont elle n'est pas membre n'est même pas trouvée.
    const autre = await REPONSE_MESSAGE.proposer({ conversation: `${TAG}directeur`, texte: "x" }, assistante);
    expect("manque" in autre && autre.manque[0]).toMatch(/aucune de vos conversations/);
  });

  it("rendez-vous : dans son agenda, l'invité désigné par son nom", async () => {
    const p = await RENDEZ_VOUS.proposer({ titre: `${TAG}Point budget`, debut: "2026-11-20 10:00", fin: "2026-11-20 11:00", invites: `${TAG}directeur` }, assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = assistante;
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: RENDEZ_VOUS.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.calendarEvent.count({ where: { title: `${TAG}Point budget` } })).toBe(1);
  });

  it("déposer une pièce : sur une demande VISIBLE, par l'action de l'écran", async () => {
    const p = await DEPOT_PIECE.proposer({ demande: `${TAG}SPO-1`, pieces: piece, categorie: "lettre de demande" }, directeur);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = directeur;
    const r = await executerOperationIA(directeur, { kind: "assistant_ia_op", op: DEPOT_PIECE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.document.count({ where: { entityType: "SPONSORING", entityId: spoId } })).toBe(1);
  });

  it("reprendre un brouillon : la carte non confirmée est RÉAFFICHÉE (même intention)", async () => {
    const p = await RENDEZ_VOUS.proposer({ titre: `${TAG}Réunion`, debut: "2026-11-21 09:00" }, assistante);
    if (!("carte" in p)) throw new Error("prémisse");
    const intent = await prisma.assistantActionIntent.create({ data: { userId: assistante.id, kind: "assistant_ia_op", module: "WORKSPACE", title: p.carte.title, summary: p.carte.title, payload: { kind: "assistant_ia_op", op: RENDEZ_VOUS.nom, args: p.args }, status: "PROPOSED", origin: "text", events: [] } });
    const liste = await lire(assistante, "mes_brouillons");
    expect(liste.cartesNonConfirmees.map((c: { identifiant: string }) => c.identifiant)).toContain(intent.id);
    const props: PropositionCarte[] = [];
    await lire(assistante, "mes_brouillons", { reprendre: intent.id }, props);
    expect(props[0]?.intentId).toBe(intent.id);
  });
});
