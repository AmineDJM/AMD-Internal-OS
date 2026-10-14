import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canReadLegalDocument } from "@/lib/lecteurs/legal";
import { setLegalReaders } from "./legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__legalacc__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const form = (id: string, readerIds: string[]): FormData => {
  const fd = new FormData();
  fd.set("id", id);
  for (const r of readerIds) fd.append("readerId", r);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACCÈS D'UN DOCUMENT LEGAL SE GÈRENT DEPUIS LEGAL, document par document.
 *
 * La restriction existait, mais la liste de lecteurs ne se choisissait qu'À LA CRÉATION : plus
 * aucun écran ne permettait d'y ajouter quelqu'un, d'en retirer une personne partie, ni de lever
 * la restriction — l'action existait, seul l'assistant pouvait l'appeler. On redéposait donc le
 * document pour corriger une liste (deux exemplaires, dont un aux mauvais accès), ou l'on
 * envoyait le fichier par mail : exactement ce que la restriction sert à éviter.
 *
 * Ce qui suit part de l'action que le panneau appelle, et vérifie surtout ce qu'elle REFUSE :
 * gérer les accès n'est pas un pouvoir d'écriture, sans quoi il suffirait de s'ajouter à la liste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Accès d'un document Legal", () => {
  let ownerId = "", otherId = "", readerId = "", adminId = "", docId = "";

  beforeAll(async () => {
    const [owner, other, reader, admin] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}deposant`, email: `${TAG}dep@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lect@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
    ]);
    ownerId = owner.id; otherId = other.id; readerId = reader.id; adminId = admin.id;
    // « L'autre » a le droit d'ÉCRITURE sur Legal : c'est tout l'objet du test.
    await prisma.userAccess.create({
      data: { userId: otherId, module: "LEGAL", canView: true, canCreate: true, canUpdate: true, scope: "ALL" },
    });
    const doc = await prisma.legalDocument.create({
      data: { title: `${TAG} Bail du siège`, kind: "CONTRACT", createdById: ownerId },
    });
    docId = doc.id;
  });

  afterAll(async () => {
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: docId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: docId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: docId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [ownerId, otherId, readerId, adminId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const readers = async () => (await prisma.legalDocumentReader.findMany({ where: { documentId: docId }, select: { userId: true } })).map((r) => r.userId);

  it("LE DÉPOSANT RESTREINT SON DOCUMENT APRÈS COUP — c'est tout le chantier", async () => {
    ACTOR = await actorFor(ownerId, "HEAD_OF_REGULATORY");
    const r = await setLegalReaders(form(docId, [readerId]));
    expect(r.ok, r.error).toBe(true);
    expect(await readers()).toEqual([readerId]);

    // Et la restriction produit son effet : elle n'est pas qu'un libellé.
    const acces = { createdById: ownerId, readerIds: await readers() };
    expect(canReadLegalDocument({ viewerId: readerId, isSuperAdmin: false }, acces)).toBe(true);
    expect(canReadLegalDocument({ viewerId: otherId, isSuperAdmin: false }, acces)).toBe(false);
    expect(canReadLegalDocument({ viewerId: ownerId, isSuperAdmin: false }, acces)).toBe(true);
  });

  it("LE DROIT D'ÉCRITURE SUR LEGAL NE SUFFIT PAS — sinon on s'ajouterait soi-même", async () => {
    ACTOR = await actorFor(otherId, "HEAD_OF_REGULATORY");
    const r = await setLegalReaders(form(docId, [otherId, readerId]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déposant/i);
    expect(await readers(), "la liste ne doit pas avoir bougé").toEqual([readerId]);
  });

  it("le Super Admin arbitre : il peut ajouter quelqu'un", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await setLegalReaders(form(docId, [readerId, otherId]));
    expect(r.ok, r.error).toBe(true);
    expect((await readers()).sort()).toEqual([readerId, otherId].sort());
  });

  it("LEVER LA RESTRICTION rouvre le document, et le journal retient qui l'a fait", async () => {
    ACTOR = await actorFor(ownerId, "HEAD_OF_REGULATORY");
    const r = await setLegalReaders(form(docId, []));
    expect(r.ok, r.error).toBe(true);
    expect(await readers()).toEqual([]);
    expect(canReadLegalDocument({ viewerId: otherId, isSuperAdmin: false }, { createdById: ownerId, readerIds: [] })).toBe(true);

    const trace = await prisma.auditLog.findFirst({
      where: { entityType: "LEGAL_DOCUMENT", entityId: docId, field: "readers" },
      orderBy: { createdAt: "desc" },
    });
    expect(trace?.actorId).toBe(ownerId);
    expect(trace?.summary).toMatch(/restriction levée/i);
  });

  it("un compte DÉSACTIVÉ ne devient pas lecteur — la liste ne garde que des personnes réelles", async () => {
    await prisma.user.update({ where: { id: readerId }, data: { isActive: false } });
    ACTOR = await actorFor(ownerId, "HEAD_OF_REGULATORY");
    const r = await setLegalReaders(form(docId, [readerId]));
    expect(r.ok).toBe(true);
    expect(await readers()).toEqual([]);
    await prisma.user.update({ where: { id: readerId }, data: { isActive: true } });
  });
});
