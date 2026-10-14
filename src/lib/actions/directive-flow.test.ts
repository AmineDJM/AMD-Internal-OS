import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, scopeDirectives, type SessionUser } from "@/lib/rbac";
import { canViewDirective, getDirective } from "@/lib/queries/directives";
import {
  createDirective, updateDirectiveStatus, postDirectiveMessage, archiveDirective,
  publishDirective, rejectDirective, resendDirective,
} from "./directive-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__dirtest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Directives — rédaction, validation du DG, diffusion, relance", () => {
  let dirId = "", roleDirId = "", directionId = "", dgId = "", delegateId = "", delegate2Id = "", financeId = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [dir, dg, deleg, deleg2, fin] = await Promise.all([
      mk("direction", "DIRECTION"),
      // LE VALIDEUR. Sans lui, rien ne part : c'est tout l'objet du circuit.
      mk("dg", "GENERAL_MANAGER"),
      mk("deleg", "MEDICAL_DELEGATE"),
      mk("deleg2", "MEDICAL_DELEGATE"),
      // Un compte d'un AUTRE rôle (non ciblé) : getAccess résout le rôle EN DIRECT de la base,
      // on ne peut donc plus « forcer » un rôle sur l'id de la Direction — il faut un vrai compte.
      mk("finance", "FINANCE_BUDGET_MANAGER"),
    ]);
    directionId = dir.id; dgId = dg.id; delegateId = deleg.id; delegate2Id = deleg2.id; financeId = fin.id;
  });

  afterAll(async () => {
    // Une diffusion « à tous les salariés » notifie AUSSI les comptes hors test : le nettoyage
    // vise donc les notifications par leur LIEN (l'identifiant de la directive), pas seulement
    // les comptes créés ici — sinon la base garderait des lignes orphelines à chaque exécution.
    const mine = await prisma.directive.findMany({
      where: { from: { email: { startsWith: TAG } } }, select: { id: true },
    }).catch(() => [] as { id: string }[]);
    for (const d of mine) {
      await prisma.notification.deleteMany({ where: { link: `/directives/${d.id}` } }).catch(() => {});
    }
    await prisma.directive.deleteMany({ where: { from: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("RIEN NE PART SANS LE DG : la Direction rédige, la note attend — aucun destinataire notifié", async () => {
    ACTOR = await actorFor(directionId, "DIRECTION");
    const fd = new FormData();
    fd.set("title", `${TAG} Prioriser le dossier PCH`); fd.set("body", "Merci d'accélérer."); fd.set("priority", "HIGH");
    fd.set("audience", "USERS"); fd.append("targetUserIds", delegateId);
    const r = await createDirective(undefined, fd);
    expect(r.ok).toBe(true);
    dirId = r.id!;

    const d = await prisma.directive.findUniqueOrThrow({ where: { id: dirId } });
    expect(d.publication).toBe("PENDING_APPROVAL");
    expect(d.sendCount).toBe(0);
    expect(d.targetUserIds).toEqual([delegateId]);
    expect(d.targetUserId).toBe(delegateId); // cache d'affichage
    expect(d.reference).toMatch(/^DIR-\d{4}-\d{3}$/);
    // Le destinataire n'a RIEN reçu : c'est la propriété qui fait tout l'intérêt du circuit.
    expect(await prisma.notification.findFirst({ where: { userId: delegateId, title: "Nouvelle directive" } })).toBeNull();
    // …mais le valideur, lui, est prévenu, sans quoi la note dormirait.
    expect(await prisma.notification.findFirst({ where: { userId: dgId, title: "Directive à valider" } })).not.toBeNull();
  });

  it("une note NON PUBLIÉE est invisible de son destinataire, visible de son auteur et du DG", async () => {
    const d = await getDirective(dirId);
    expect(await canViewDirective(await actorFor(delegateId, "MEDICAL_DELEGATE"), d!)).toBe(false);
    expect(await canViewDirective(await actorFor(directionId, "DIRECTION"), d!)).toBe(true);
    expect(await canViewDirective(await actorFor(dgId, "GENERAL_MANAGER"), d!)).toBe(true);
  });

  it("le destinataire ne peut pas la faire avancer tant qu'elle n'est pas partie", async () => {
    ACTOR = await actorFor(delegateId, "MEDICAL_DELEGATE");
    const fd = new FormData(); fd.set("id", dirId); fd.set("status", "ACKNOWLEDGED");
    expect((await updateDirectiveStatus(fd)).ok).toBe(false);
  });

  it("un rôle ordinaire ne publie pas — même la Direction qui l'a écrite", async () => {
    ACTOR = await actorFor(directionId, "DIRECTION");
    const fd = new FormData(); fd.set("id", dirId);
    const r = await publishDirective(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/direction générale/i);
  });

  it("le DG publie : la note part, le destinataire est notifié, le compteur d'envois passe à 1", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData(); fd.set("id", dirId);
    expect((await publishDirective(fd)).ok).toBe(true);

    const d = await prisma.directive.findUniqueOrThrow({ where: { id: dirId } });
    expect(d.publication).toBe("PUBLISHED");
    expect(d.approvedById).toBe(dgId);
    expect(d.publishedAt).not.toBeNull();
    expect(d.sendCount).toBe(1);
    expect(await prisma.notification.findFirst({ where: { userId: delegateId, title: "Nouvelle directive" } })).not.toBeNull();
    // Et elle devient visible de son destinataire.
    expect(await canViewDirective(await actorFor(delegateId, "MEDICAL_DELEGATE"), (await getDirective(dirId))!)).toBe(true);
    expect(await canViewDirective(await actorFor(delegate2Id, "MEDICAL_DELEGATE"), (await getDirective(dirId))!)).toBe(false);
  });

  it("RENVOYER rejoue le même envoi et incrémente le compteur — on sait combien de fois", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData(); fd.set("id", dirId);
    const r = await resendDirective(fd);
    expect(r.ok).toBe(true);
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: dirId } });
    expect(d.sendCount).toBe(2);
    expect(d.lastSentAt).not.toBeNull();
    expect(await prisma.notification.findFirst({ where: { userId: delegateId, title: "Directive — rappel" } })).not.toBeNull();
  });

  it("le destinataire accuse réception puis le fil d'échange fonctionne dans les deux sens", async () => {
    ACTOR = await actorFor(delegateId, "MEDICAL_DELEGATE");
    const fdAck = new FormData(); fdAck.set("id", dirId); fdAck.set("status", "ACKNOWLEDGED");
    expect((await updateDirectiveStatus(fdAck)).ok).toBe(true);
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: dirId } });
    expect(d.status).toBe("ACKNOWLEDGED");
    expect(d.acknowledgedById).toBe(delegateId);

    const fdMsg = new FormData(); fdMsg.set("id", dirId); fdMsg.set("body", "Bien reçu, je m'en occupe.");
    expect((await postDirectiveMessage(fdMsg)).ok).toBe(true);

    ACTOR = await actorFor(directionId, "DIRECTION");
    const fdMsg2 = new FormData(); fdMsg2.set("id", dirId); fdMsg2.set("body", "Parfait, merci.");
    expect((await postDirectiveMessage(fdMsg2)).ok).toBe(true);

    const msgs = await prisma.directiveMessage.findMany({ where: { directiveId: dirId }, orderBy: { createdAt: "asc" } });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].authorId).toBe(delegateId);
    expect(msgs[1].authorId).toBe(directionId);
  });

  it("l'archivage est réservé à la Direction (le délégué ne peut pas)", async () => {
    ACTOR = await actorFor(delegateId, "MEDICAL_DELEGATE");
    const fd = new FormData(); fd.set("id", dirId);
    expect((await archiveDirective(fd)).ok).toBe(false);
    ACTOR = await actorFor(directionId, "DIRECTION");
    expect((await archiveDirective(fd)).ok).toBe(true);
    expect((await prisma.directive.findUniqueOrThrow({ where: { id: dirId } })).status).toBe("ARCHIVED");
  });

  it("une note écrite PAR le DG part d'emblée — se valider soi-même serait un clic vide", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData();
    fd.set("title", `${TAG} Fermeture exceptionnelle`); fd.set("body", "Jeudi."); fd.set("audience", "ALL");
    const r = await createDirective(undefined, fd);
    expect(r.ok).toBe(true);
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: r.id! } });
    expect(d.publication).toBe("PUBLISHED");
    expect(d.sendCount).toBe(1);
    // Audience « tous les salariés » : chacun l'a reçue, y compris un rôle sans lien avec la note.
    expect(await prisma.notification.findFirst({ where: { userId: financeId, title: "Nouvelle directive" } })).not.toBeNull();
  });

  it("PLUSIEURS destinataires nommés : chacun reçoit, un tiers non", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData();
    fd.set("title", `${TAG} Réunion de service`); fd.set("body", "Lundi 9h."); fd.set("audience", "USERS");
    fd.append("targetUserIds", delegateId); fd.append("targetUserIds", delegate2Id);
    const r = await createDirective(undefined, fd);
    expect(r.ok).toBe(true);
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: r.id! } });
    expect(d.targetUserIds.sort()).toEqual([delegateId, delegate2Id].sort());
    for (const uid of [delegateId, delegate2Id]) {
      expect(await prisma.notification.findFirst({ where: { userId: uid, body: { contains: "Réunion de service" } } })).not.toBeNull();
    }
    expect(await prisma.notification.findFirst({ where: { userId: financeId, body: { contains: "Réunion de service" } } })).toBeNull();
  });

  it("une portée VIDE est refusée, et le motif nomme la case à remplir", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData();
    fd.set("title", `${TAG} Sans destinataire`); fd.set("body", "…"); fd.set("audience", "COMPANY");
    const r = await createDirective(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/entité/i);
  });

  it("le REFUS exige un motif, et la note ne part jamais", async () => {
    ACTOR = await actorFor(directionId, "DIRECTION");
    const fd = new FormData();
    fd.set("title", `${TAG} Note à revoir`); fd.set("body", "Brouillon."); fd.set("audience", "ALL");
    const created = await createDirective(undefined, fd);
    expect(created.ok).toBe(true);

    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const sansMotif = new FormData(); sansMotif.set("id", created.id!);
    expect((await rejectDirective(sansMotif)).ok).toBe(false);

    const avecMotif = new FormData(); avecMotif.set("id", created.id!); avecMotif.set("note", "Trop imprécis.");
    expect((await rejectDirective(avecMotif)).ok).toBe(true);
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: created.id! } });
    expect(d.publication).toBe("REJECTED");
    expect(d.decisionNote).toBe("Trop imprécis.");
    expect(d.sendCount).toBe(0);
    // Une note refusée ne se renvoie pas.
    const relance = new FormData(); relance.set("id", created.id!);
    expect((await resendDirective(relance)).ok).toBe(false);
  });

  it("diffusion par RÔLE : visible de tout membre du rôle ciblé, invisible des autres", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData();
    fd.set("title", `${TAG} Tous délégués : remontez vos points`); fd.set("body", "Hebdo.");
    fd.set("audience", "ROLE"); fd.set("targetRole", "MEDICAL_DELEGATE");
    const r = await createDirective(undefined, fd);
    expect(r.ok).toBe(true);
    roleDirId = r.id!;
    const d = await prisma.directive.findUniqueOrThrow({ where: { id: roleDirId } });
    expect(d.targetRole).toBe("MEDICAL_DELEGATE");
    expect(d.targetUserId).toBeNull();

    const dg2 = await actorFor(delegate2Id, "MEDICAL_DELEGATE");
    const found = await prisma.directive.findFirst({ where: { AND: [{ id: roleDirId }, scopeDirectives(dg2)] }, select: { id: true } });
    expect(found?.id).toBe(roleDirId);

    const finance = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const notFound = await prisma.directive.findFirst({ where: { AND: [{ id: roleDirId }, scopeDirectives(finance)] }, select: { id: true } });
    expect(notFound).toBeNull();
  });
});
