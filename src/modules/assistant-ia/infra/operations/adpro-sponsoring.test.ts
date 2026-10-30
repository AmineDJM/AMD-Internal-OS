import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { SPONSORING_CREATION } from "./adpro-sponsoring";
import { executerOperationIA, outilsOperations } from "./";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT IA PRÉPARE UNE DEMANDE DE SPONSORING — et c'est l'ACTION DE L'ÉCRAN qui la crée.
 *
 * Sur la vraie base : ce qui manque est nommé (une question à la fois), l'annuaire médical
 * pré-remplit, la pièce est exigée au bon format, le seuil du DG et les doublons sont dits, puis
 * la confirmation passe par `createSponsoring` — demande, premier poste et pièce jointe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaspo_${Date.now().toString(36)}_`;
const INSTITUTION = `${TAG}Association des cardiologues`;
const MEDECIN = `${TAG}Zéphyr Benali`;
let admin: CurrentUser;
let assistante: CurrentUser;
let demandePdf = "";
let photoPng = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

async function fichier(user: CurrentUser, nom: string, mime: string): Promise<string> {
  const octets = Buffer.from(`%PDF-1.4 ${nom} ${Date.now()}`);
  const { blobId, size } = await putBlob(octets);
  const r = await enregistrerFichierDrive(user, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: mime, name: nom });
  return r.id;
}

const complet = () => ({
  institution: INSTITUTION, medecins: MEDECIN, produits: "Cardiosol", type: "Congrès", nature: "direct",
  montantDemande: 1_500_000, montantSuggere: 1_200_000, importance: "haute", demandeMedecin: demandePdf,
});

suite("Assistant IA — demande de sponsoring de bout en bout", () => {
  beforeAll(async () => {
    admin = await compte("admin", "SUPER_ADMIN");
    assistante = await compte("assistante", "DIRECTION_ASSISTANT");
    await prisma.medicalDoctor.create({ data: { name: MEDECIN, specialty: "Cardiologie", wilaya: "Oran" } });
    demandePdf = await fichier(admin, `${TAG}demande.pdf`, "application/pdf");
    photoPng = await fichier(admin, `${TAG}photo.png`, "image/png");
  });

  afterAll(async () => {
    const spo = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } });
    const ids = spo.map((s) => s.id);
    await prisma.document.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: ids } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: [admin?.id, assistante?.id].filter(Boolean) as string[] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { body: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("rien donné : ce qui manque est NOMMÉ, dans l'ordre — l'agent posera la première question", async () => {
    const p = await SPONSORING_CREATION.proposer({}, admin);
    expect("manque" in p && p.manque[0]).toMatch(/institution/);
    expect("manque" in p && p.manque.some((m) => /demande du médecin/.test(m))).toBe(true);
  });

  it("le médecin reconnu dans l'annuaire PRÉ-REMPLIT la spécialité et la wilaya", async () => {
    const p = await SPONSORING_CREATION.proposer({ institution: INSTITUTION, medecins: MEDECIN }, admin);
    if (!("manque" in p)) throw new Error("attendu : incomplet");
    expect(p.manque.join(" ")).not.toMatch(/spécialité|wilaya/);
    expect(p.precision).toMatch(/spécialité, ville/);
  });

  it("la demande du médecin doit être un PDF ou un Word", async () => {
    const p = await SPONSORING_CREATION.proposer({ ...complet(), demandeMedecin: photoPng }, admin);
    expect("erreur" in p && p.erreur).toMatch(/PDF ou un Word/);
  });

  it("complet : une carte récapitulative, le seuil du DG dit, rien n'est encore créé", async () => {
    const p = await SPONSORING_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.find((f) => f.label === "Spécialité")?.value).toBe("Cardiologie");
    expect(p.carte.fields.find((f) => f.label === "Ville")?.value).toBe("Oran");
    expect(p.carte.warnings.join(" ")).toMatch(/Directeur Général validera/);
    expect(await prisma.sponsoringRequest.count({ where: { institution: INSTITUTION } })).toBe(0);
  });

  it("confirmée : l'action de l'écran crée la demande, son premier poste et la pièce jointe", async () => {
    const p = await SPONSORING_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: SPONSORING_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const spo = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: INSTITUTION }, include: { items: true } });
    expect(spo.doctor).toContain(MEDECIN);
    expect(spo.city).toBeTruthy();
    expect(spo.items).toHaveLength(1);
    expect(await prisma.document.count({ where: { entityType: "SPONSORING", entityId: spo.id, category: "REQUEST_LETTER" } })).toBe(1);
  });

  it("une seconde demande pour la même institution : le DOUBLON possible est signalé", async () => {
    const p = await SPONSORING_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.warnings.join(" ")).toMatch(/Doublon possible : SPO-/);
  });

  it("un rôle qui ne crée pas de sponsoring à l'écran n'a pas l'outil, et l'exécution le refuse", async () => {
    expect(outilsOperations(assistante, []).map((o) => o.def.name)).not.toContain(SPONSORING_CREATION.nom);
    const p = await SPONSORING_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error("prémisse");
    ACTOR = assistante;
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: SPONSORING_CREATION.nom, args: p.args });
    expect(r.ok).toBe(false);
  });
});
