import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { activeStandInsFor } from "@/lib/hr/stand-in-resolve";
import { createRequest, requestApproval, decideApproval } from "@/lib/actions/admin-request-actions";
import { createPurchaseRequest, withdrawPurchaseRequest } from "@/lib/actions/purchase-request-actions";
import { getApprovals } from "@/lib/queries/admin-requests";
import { annulerDemandeSecretariat } from "@/lib/secretariat/annulation";
import { purchaseStage } from "@/lib/general-means/purchase-request";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APPROBATION D'UN ACHAT AU SECRÉTARIAT — qui a tranché, ce qu'il a dit, et rien de ce qu'on ne
 * peut pas trancher (lot E5 — audit des managers, M14 et M15). Par les VRAIS points d'entrée :
 * l'achat se dépose par `createPurchaseRequest` (le validateur est le N+1 de l'organigramme), se
 * tranche par `decideApproval`, se retire par `withdrawPurchaseRequest`. Aucun acteur n'a la vue
 * globale (§118.104) ; chacun est NOMMÉ dans son cas. Les courses sont FORCÉES (§118.164e).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__e5achat";
const TAG = `${PREFIXE}${Date.now().toString(36)}__`;

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const jour = (decalage: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + decalage); return d; };
async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}

suite("Secrétariat — l'approbation d'un achat dit qui a tranché, exige son motif, et ne se prend qu'une fois", () => {
  const u: Record<string, string> = {};
  const emp: Record<string, string> = {};

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    if (comptes.length === 0) return;
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const demandes = (await prisma.administrativeRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: demandes } }, select: { id: true } })).map((x) => x.id);
    await prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ordres } }, { requesterId: { in: comptes } }] } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.purchaseRequestLogEntry.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { OR: [{ requestId: { in: demandes } }, { validatorId: { in: comptes } }, { requestedById: { in: comptes } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...demandes, ...ordres] } }, { actorId: { in: comptes } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: fiches } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const companyId = (await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))!.id;
    // dem le demandeur ; n1 son directeur (N+1 de l'organigramme) ; s l'intérimaire de n1 ; w le témoin sans droit ;
    // asst l'assistante de direction (droit « Valider » du module, sans vue globale) ; v2 un second validateur.
    const roles = [["dem", "MEDICAL_DELEGATE"], ["n1", "HEAD_OF_SALES"], ["s", "SALES_USER"], ["w", "SALES_USER"], ["asst", "DIRECTION_ASSISTANT"], ["v2", "GENERAL_MANAGER"]] as const;
    const comptes = await Promise.all(roles.map(([k, role]) =>
      prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })));
    roles.forEach(([k], i) => { u[k] = comptes[i].id; });
    emp.n1 = (await prisma.employee.create({ data: { fullName: `${TAG} n1`, userId: u.n1, companyId, isActive: true } })).id;
    const fiches = await Promise.all((["dem", "s", "asst"] as const).map((k) =>
      prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true, managerId: emp.n1 } })));
    (["dem", "s", "asst"] as const).forEach((k, i) => { emp[k] = fiches[i].id; });
    // L'INTÉRIM : congé de n1 accordé, intérimaire s validé par les RH, en cours aujourd'hui (comme `interim-decisions-flow`).
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.n1, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
        standInId: u.s, standInStatus: "APPROVED", standInModules: ["VALIDATIONS"],
      },
    });
  }, 120_000);
  afterAll(async () => { await nettoyer(); await prisma.$disconnect().catch(() => {}); }, 120_000);

  /** Un achat déposé par l'écran « Mes demandes d'achat » — rend la demande et son approbation. */
  async function deposerAchat(par: "dem" | "asst", libelle: string): Promise<{ id: string; approval: string }> {
    ACTOR = await acteur(u[par]);
    const r = await createPurchaseRequest(undefined, form({
      title: `${TAG}${libelle}`,
      lines: JSON.stringify([{ articleId: null, label: `${TAG}${libelle}`, quantity: 2, unitPrice: 1500 }]),
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const approval = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: r.id! }, select: { id: true } });
    return { id: r.id!, approval: approval.id };
  }
  /** Une demande ordinaire et une approbation CHIFFRÉE demandée par l'assistante — l'accord émet un ordre. */
  async function approbationChiffree(libelle: string, validateur = "n1"): Promise<{ id: string; approval: string }> {
    ACTOR = await acteur(u.dem);
    const c = await createRequest(undefined, form({ type: "OTHER", title: `${TAG}${libelle}`, priority: "MEDIUM" }));
    expect(c.ok, c.ok ? "" : c.error).toBe(true);
    ACTOR = await acteur(u.asst);
    const a = await requestApproval(form({ requestId: c.id!, validatorId: u[validateur], amount: "12000" }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    const approval = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: c.id!, status: "PENDING" }, select: { id: true } });
    return { id: c.id!, approval: approval.id };
  }
  const decider = async (qui: string, approvalId: string, decision: string, comment?: string) => {
    ACTOR = await acteur(u[qui]);
    return decideApproval(form({ approvalId, decision, ...(comment !== undefined ? { comment } : {}) }));
  };
  const etat = (id: string) => prisma.adminApproval.findUniqueOrThrow({
    where: { id }, select: { status: true, decidedById: true, decidedAt: true, decisionNote: true, comment: true },
  });

  async function attendreBloques(tx: Prisma.TransactionClient, table: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${table}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${table}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** Un geste arrêté entre sa lecture et son écriture pendant que le détenteur du verrou écrit — déterministe. */
  async function pendantLaLecture<T>(table: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      await attendreBloques(tx, table, 1);
      await concurrent(tx);
    }, { timeout: 30_000 });
    return geste;
  }
  /** Deux gestes forcés à se croiser : ils lisent tous deux avant que l'un écrive. */
  async function ensemble<T>(table: string, lancer: () => Promise<T>[]): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, table, gestes.length);
    }, { timeout: 30_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : personne n'a la vue globale ; seule l'assistante a « Valider » ; l'intérim de s est armé", async () => {
    for (const k of ["dem", "n1", "s", "w"]) {
      const a = await acteur(u[k]);
      expect(hasGlobalView(a.role), k).toBe(false);
      expect(userCan(a, "ADMIN_REQUESTS", "VALIDATE"), `${k} trancherait par le droit du module, pas par la porte qu'on éprouve`).toBe(false);
    }
    const asst = await acteur(u.asst);
    expect(hasGlobalView(asst.role)).toBe(false);
    expect(userCan(asst, "ADMIN_REQUESTS", "VALIDATE"), "l'assistante a le droit « Valider » du module — il ne suffit plus à trancher (audit du 14/10/2026)").toBe(true);
    expect((await activeStandInsFor(u.s)).map((a) => a.absenteeUserId)).toEqual([u.n1]);
    expect(await activeStandInsFor(u.w)).toEqual([]);
  });

  it("M14 — QUI A TRANCHÉ : la décision porte son auteur ; l'estimation du demandeur reste la sienne ; le journal ne la prend pas pour l'avis", async () => {
    const { id, approval } = await deposerAchat("dem", "Cartouches");
    expect((await etat(approval)).comment, "la parole du demandeur").toMatch(/^Estimation catalogue/);
    const r = await decider("n1", approval, "APPROVED");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await etat(approval);
    expect(apres.status).toBe("APPROVED");
    expect(apres.decidedById).toBe(u.n1);
    expect(apres.decidedAt).not.toBeNull();
    expect(apres.decisionNote, "un accord sans mot n'a pas de parole").toBeNull();
    expect(apres.comment, "la décision n'écrase plus la parole du demandeur").toMatch(/^Estimation catalogue/);
    const ligne = await prisma.purchaseRequestLogEntry.findFirstOrThrow({ where: { requestId: id, event: "APPROVED" } });
    expect(ligne.note, "avant : l'estimation du catalogue, affichée entre guillemets comme le mot du directeur").toBeNull();
    const decision = (ligne.snapshot as { decision?: { decidedBy?: string | null } }).decision;
    expect(decision?.decidedBy).toBe(`${TAG} n1`);
  });

  it("M14 — L'INTÉRIMAIRE tranche, et la décision porte SON nom — pas celui du validateur nommé", async () => {
    const { id, approval } = await deposerAchat("dem", "Agrafeuse");
    const r = await decider("s", approval, "REJECTED", "Déjà en stock au siège.");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await etat(approval);
    expect(apres.decidedById, "avant : rien ne disait que ce n'était pas n1").toBe(u.s);
    expect(apres.decisionNote).toBe("Déjà en stock au siège.");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "REFUSE" }, select: { summary: true } });
    expect(audit.summary).toBe(`Validation refusée — Déjà en stock au siège. (par l'intérimaire de ${TAG} n1)`);
  });

  it("M14 / audit 14/10 — L'ASSISTANTE (droit « Valider ») ne tranche plus l'achat d'un autre ; LE SOMMET demande une modification : son nom, son motif", async () => {
    const { id, approval } = await deposerAchat("dem", "Fauteuil");
    const refus = await decider("asst", approval, "CHANGES_REQUESTED", "Préciser le modèle et le fournisseur.");
    expect(refus.ok, "avant : le droit « Valider » du module suffisait").toBe(false);
    expect(refus.error).toBe(`Cette validation est adressée à ${TAG} n1 : seul le validateur, son intérimaire ou la Direction la tranche.`);
    expect((await etat(approval)).status).toBe("PENDING");
    const t0 = new Date();
    const r = await decider("v2", approval, "CHANGES_REQUESTED", "Préciser le modèle et le fournisseur.");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await etat(approval);
    expect(apres.decidedById).toBe(u.v2);
    const demande = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(purchaseStage(demande.status, apres), "avant : « En attente de votre directeur »").toBe("CHANGES_REQUESTED");
    const avis = await prisma.notification.findMany({ where: { userId: u.dem, link: `/demandes/${id}`, createdAt: { gte: t0 } }, select: { title: true, body: true } });
    expect(avis).toHaveLength(1);
    expect(avis[0].title).toBe("Modification demandée");
    expect(avis[0].body).toContain("Préciser le modèle et le fournisseur.");
  });

  it("M15 — REFUSER ou DEMANDER UNE MODIFICATION sans motif est refusé, avec ce qu'il faut écrire — et rien n'est écrit", async () => {
    const { id, approval } = await deposerAchat("dem", "Classeurs");
    const t0 = new Date();
    const sans = await decider("n1", approval, "REJECTED");
    expect(sans.ok).toBe(false);
    expect(sans.error).toBe("Dites pourquoi vous refusez : c'est ce que lira le demandeur.");
    const blanc = await decider("n1", approval, "CHANGES_REQUESTED", "   ");
    expect(blanc.ok).toBe(false);
    expect(blanc.error).toBe("Dites ce qu'il faut modifier : c'est ce que lira le demandeur.");
    expect((await etat(approval)).status, "toujours en attente").toBe("PENDING");
    expect(await prisma.notification.count({ where: { userId: u.dem, link: `/demandes/${id}`, createdAt: { gte: t0 } } }), "personne n'a été prévenu d'une décision qui n'a pas eu lieu").toBe(0);

    // Avec son motif, la décision part — et le demandeur le LIT.
    const ok = await decider("n1", approval, "REJECTED", "Hors budget du trimestre.");
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const avis = await prisma.notification.findFirstOrThrow({ where: { userId: u.dem, link: `/demandes/${id}`, createdAt: { gte: t0 } }, select: { title: true, body: true } });
    expect(avis.title).toBe("Validation refusée");
    expect(avis.body).toContain("Hors budget du trimestre.");
    expect((await etat(approval)).decisionNote).toBe("Hors budget du trimestre.");
  });

  it("L'ÉTAT D'ABORD : déjà tranchée, non autorisé, demande annulée — chacun avant le motif (§118.18)", async () => {
    const tranchee = await deposerAchat("dem", "Ramettes");
    expect((await decider("n1", tranchee.approval, "APPROVED")).ok).toBe(true);
    const encore = await decider("n1", tranchee.approval, "REJECTED");
    expect(encore.ok).toBe(false);
    expect(encore.error, "pas la phrase du motif : le refus vient de l'état").toBe("Cette validation a déjà été tranchée — rechargez la page.");

    const autre = await deposerAchat("dem", "Stylos");
    const temoin = await decider("w", autre.approval, "REJECTED");
    expect(temoin.ok).toBe(false);
    expect(temoin.error).toBe(`Cette validation est adressée à ${TAG} n1 : seul le validateur, son intérimaire ou la Direction la tranche.`);

    // La demande annulée par un autre chemin, son approbation restée en file : on ne la tranche plus.
    const annulee = await deposerAchat("dem", "Toner");
    await prisma.administrativeRequest.update({ where: { id: annulee.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const r = await decider("n1", annulee.approval, "REJECTED");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Cette demande a été annulée : la validation n'a plus d'objet.");
  });

  it("UNE DÉCISION ILLISIBLE n'est pas une décision — « PENDING » et une faute de frappe sont refusés, rien n'est écrit", async () => {
    const { approval } = await deposerAchat("dem", "Câbles");
    for (const d of ["PENDING", "FOO", "approved"]) {
      const r = await decider("n1", approval, d, "x");
      expect(r.ok, d).toBe(false);
      expect(r.error, d).toBe("Décision invalide.");
    }
    expect((await etat(approval)).status).toBe("PENDING");
  });

  it("E5-2b — ON NE VALIDE PAS SA PROPRE DEMANDE, même avec le droit « Valider » ; la liste ne la propose plus", async () => {
    const sienne = await deposerAchat("asst", "Badge");
    const r = await decider("asst", sienne.approval, "APPROVED");
    expect(r.ok, "avant : l'assistante validait son propre achat").toBe(false);
    expect(r.error).toBe(`Cette validation est adressée à ${TAG} n1 : seul le validateur, son intérimaire ou la Direction la tranche.`);
    expect((await etat(sienne.approval)).status).toBe("PENDING");
    const file = await getApprovals(await acteur(u.asst));
    expect(file.some((a) => a.id === sienne.approval), "la liste n'offre pas un bouton que l'action refuserait").toBe(false);
    // Celle d'un autre n'y est plus non plus (audit du 14/10/2026) : elle est adressée au N+1, l'assistante relance.
    const autre = await deposerAchat("dem", "Badge visiteur");
    expect((await getApprovals(await acteur(u.asst))).some((a) => a.id === autre.approval)).toBe(false);
    expect((await decider("asst", autre.approval, "APPROVED")).ok).toBe(false);
    // Le sommet la voit et la tranche ; son propre achat aussi (il est parfois le seul au-dessus).
    expect((await getApprovals(await acteur(u.v2))).some((a) => a.id === autre.approval)).toBe(true);
    expect((await decider("v2", autre.approval, "APPROVED")).ok).toBe(true);
  });

  it("COURSE — le directeur et le Directeur Général tranchent ENSEMBLE : un seul passe, l'autre le lit", async () => {
    const { approval } = await deposerAchat("dem", "Écran");
    const [n1, asst] = await Promise.all([acteur(u.n1), acteur(u.v2)]);
    const [a, b] = await ensemble("AdminApproval", () => {
      ACTOR = n1;
      const p1 = decideApproval(form({ approvalId: approval, decision: "APPROVED" }));
      ACTOR = asst;
      const p2 = decideApproval(form({ approvalId: approval, decision: "REJECTED", comment: "Pas maintenant." }));
      return [p1, p2];
    });
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    const perdant = a.ok ? b : a;
    expect(perdant.error).toBe("Cette validation vient d'être tranchée par quelqu'un d'autre — rechargez la page.");
    const apres = await etat(approval);
    expect(apres.decidedById, "l'auteur est le gagnant").toBe(a.ok ? u.n1 : u.v2);
    expect(apres.status).toBe(a.ok ? "APPROVED" : "REJECTED");
  });

  it("E5-2c — LE RETRAIT PENDANT LA DÉCISION : le directeur tranche entre la lecture et l'écriture — rien n'est retiré", async () => {
    const { id, approval } = await deposerAchat("dem", "Imprimante");
    ACTOR = await acteur(u.dem);
    const r = await pendantLaLecture("AdminApproval",
      () => withdrawPurchaseRequest(form({ id })),
      (tx) => tx.adminApproval.update({ where: { id: approval }, data: { status: "APPROVED", decidedById: u.n1, decidedAt: new Date() } }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toBe("Votre directeur vient de trancher cette demande — rechargez la page pour voir sa décision.");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "avant : annulée sous un accord").not.toBe("CANCELLED");
    expect((await etat(approval)).status).toBe("APPROVED");
  });

  it("E5-2c — LA DEMANDE CHANGE PENDANT LE RETRAIT : prise en charge entre la lecture et l'écriture — rien n'est retiré, rien n'est annulé", async () => {
    const { id, approval } = await deposerAchat("dem", "Projecteur");
    ACTOR = await acteur(u.dem);
    const r = await pendantLaLecture("AdministrativeRequest",
      () => withdrawPurchaseRequest(form({ id })),
      (tx) => tx.administrativeRequest.update({ where: { id }, data: { status: "IN_PROGRESS" } }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toBe("Cette demande vient de changer — rechargez la page pour voir où elle en est.");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "avant : annulée par-dessus la prise en charge").toBe("IN_PROGRESS");
    expect((await etat(approval)).status, "le retrait de l'approbation est défait avec le reste").toBe("PENDING");
  });

  it("E5-2c — une demande « à modifier » se retire ; une demande qui n'est PAS un achat ne se retire pas par ce geste", async () => {
    const amodifier = await deposerAchat("dem", "Chaise");
    expect((await decider("n1", amodifier.approval, "CHANGES_REQUESTED", "Préciser la quantité.")).ok).toBe(true);
    ACTOR = await acteur(u.dem);
    const r = await withdrawPurchaseRequest(form({ id: amodifier.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: amodifier.id }, select: { status: true } })).status).toBe("CANCELLED");

    const autre = await createRequest(undefined, form({ type: "OTHER", title: `${TAG}Attestation`, priority: "MEDIUM" }));
    expect(autre.ok).toBe(true);
    const k = await withdrawPurchaseRequest(form({ id: autre.id! }));
    expect(k.ok, "avant : annulée sans retirer ce qui en dépendait").toBe(false);
    expect(k.error).toMatch(/« Annuler ma demande »/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: autre.id! }, select: { status: true } })).status).not.toBe("CANCELLED");
  });

  it("UNE DEMANDE, UNE APPROBATION EN ATTENTE : la redemander à un autre retire la précédente — et son validateur le sait", async () => {
    const { id, approval: premiere } = await approbationChiffree("Redemandée");
    const t0 = new Date();
    ACTOR = await acteur(u.asst);
    expect((await requestApproval(form({ requestId: id, validatorId: u.v2, amount: "12000" }))).ok).toBe(true);
    expect(await prisma.adminApproval.count({ where: { id: premiere } }), "avant : restée en file chez n1, qui pouvait l'approuver — deux ordres").toBe(0);
    expect(await prisma.adminApproval.count({ where: { requestId: id, status: "PENDING" } })).toBe(1);
    const avis = await prisma.notification.findMany({ where: { userId: u.n1, title: "Validation retirée", createdAt: { gte: t0 } }, select: { body: true } });
    expect(avis).toHaveLength(1);
    expect(avis[0].body).toContain(`redemandée à ${TAG} v2`);
    // Le témoin : une approbation déjà TRANCHÉE n'est pas retirée par la suivante.
    const seconde = await prisma.adminApproval.findFirstOrThrow({ where: { requestId: id, status: "PENDING" }, select: { id: true } });
    expect((await decider("v2", seconde.id, "CHANGES_REQUESTED", "Joindre le devis.")).ok).toBe(true);
    ACTOR = await acteur(u.asst);
    expect((await requestApproval(form({ requestId: id, validatorId: u.v2, amount: "12000" }))).ok).toBe(true);
    expect(await prisma.adminApproval.count({ where: { id: seconde.id } }), "une décision prise reste ce qu'elle est").toBe(1);
  });

  it("R2 — UNE ANNULATION PENDANT LA PRISE : l'approbation ne se prend pas, aucun ordre ne naît", async () => {
    const { id, approval } = await approbationChiffree("Course prise");
    ACTOR = await acteur(u.n1);
    const r = await pendantLaLecture("AdminApproval",
      () => decideApproval(form({ approvalId: approval, decision: "APPROVED" })),
      (tx) => tx.administrativeRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toBe("Cette demande a été annulée : la validation n'a plus d'objet.");
    expect((await etat(approval)).status).toBe("PENDING");
    expect(await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id } }), "aucun paiement pour une demande annulée").toBe(0);
  });

  it("R2 — UNE ANNULATION APRÈS LA PRISE, AVANT L'ORDRE : l'ordre émis est annulé, et la décision le dit", async () => {
    const { id, approval } = await approbationChiffree("Course ordre");
    ACTOR = await acteur(u.n1);
    const r = await pendantLaLecture("ExpenseOrder",
      () => decideApproval(form({ approvalId: approval, decision: "APPROVED" })),
      async () => {
        // L'accord est pris, l'ordre attend de naître : l'annulation commune passe — elle ne peut pas le voir.
        const a = await annulerDemandeSecretariat(id, { acteurId: u.dem, motif: "Plus nécessaire.", cause: "par son demandeur" });
        expect(a.ok && a.annulee, JSON.stringify(a)).toBe(true);
      },
    );
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toMatch(/annulée pendant votre décision : votre accord est enregistré, mais le paiement qu'il émettait a été annulé/);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: id }, select: { status: true } });
    expect(ordres.map((o) => o.status), "avant : un ordre payable pour une demande annulée").toEqual(["CANCELLED"]);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("CANCELLED");
  });
});
