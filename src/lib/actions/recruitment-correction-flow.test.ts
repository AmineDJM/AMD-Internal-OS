import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, isTopManagement, userCan, type SessionUser } from "@/lib/rbac";
import {
  decideRecruitmentStep, cancelRecruitmentRequest, closeRecruitmentRequest, openRecruitmentSourcing,
  askRecruitmentInfo, answerRecruitmentInfo, moveRecruitmentCandidate, onboardRecruitment,
  renvoyerDemandeRecrutement, resoumettreDemandeRecrutement, rouvrirDemandeRecrutement, annulerEmbaucheRecrutement,
} from "./recruitment-actions";
import { getActionCenter } from "@/lib/queries/action-center";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__recorr__";
const DEJA = /vient de changer/;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "");

/**
 * LE RECRUTEMENT SE CORRIGE (audit 360°, R14 — §118.192). Par les VRAIS points d'entrée, avec des
 * validateurs et des RH SANS vue globale (§118.104), et des courses FORCÉES : le détenteur d'un verrou de
 * table attend que le geste soit bloqué entre sa lecture et son écriture, écrit lui-même le changement
 * concurrent, puis relâche (§118.164e) — jamais une simultanéité espérée.
 */
suite("Recrutement — renvoyer, corriger, rouvrir, annuler l'embauche, un geste à la fois", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = {
    dem: "VIEWER", n1: "VIEWER", n2: "VIEWER", rh: "VIEWER", dg: "GENERAL_MANAGER", autre: "VIEWER", ex: "VIEWER",
  };
  const created: string[] = [];
  let seq = 0;
  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!, roles[k]!); };

  async function nettoyer() {
    const reqs = await prisma.recruitmentRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const ids = reqs.map((r) => r.id);
    await prisma.comment.deleteMany({ where: { entityType: "RECRUITMENT_REQUEST", entityId: { in: ids } } }).catch(() => {});
    await prisma.recruitmentCandidate.deleteMany({ where: { requestId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.recruitmentRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((x) => x.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: uids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    // Les RH sans vue globale : un accès PERSONNALISÉ au module RH, rien d'autre (§118.104).
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: u.rh!, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    // Le demandeur voit le module Recrutement (la page et « Mon espace » le lisent).
    await prisma.userAccess.create({ data: { userId: u.dem!, module: "RECRUITMENT", canView: true, canCreate: true, scope: "ASSIGNED" } });
    // L'ancien demandeur n'a PLUS le module : tout le monde l'a (Direction, 07/10), seul un blocage de la console le retire.
    await prisma.userAccess.create({ data: { userId: u.ex!, module: "RECRUITMENT", canView: false } });
  });
  afterAll(nettoyer);

  async function demande(over: Partial<Prisma.RecruitmentRequestUncheckedCreateInput> = {}, marches: string[] = [u.n1!, u.n2!]): Promise<string> {
    seq += 1;
    const r = await prisma.recruitmentRequest.create({
      data: {
        reference: `${TAG}${seq}-${Date.now()}`, requesterId: u.dem!, position: "Délégué médical Oran",
        headcount: 2, contractType: "CDI", salaryMin: 80_000, salaryMax: 100_000, missions: "Visites des CHU de l'Ouest",
        stage: "CHAIN", ...over,
        approvals: { create: marches.map((approverId, i) => ({ order: i + 1, approverId })) },
      },
      select: { id: true },
    });
    created.push(r.id);
    return r.id;
  }
  const lire = (id: string) => prisma.recruitmentRequest.findUniqueOrThrow({
    where: { id },
    select: {
      stage: true, position: true, headcount: true, salaryMax: true, missions: true, closingNote: true,
      returnedFrom: true, returnNote: true, returnedById: true,
      approvals: { orderBy: { order: "asc" }, select: { order: true, status: true, reason: true } },
    },
  });
  const fil = async (id: string) => (await prisma.comment.findMany({ where: { entityType: "RECRUITMENT_REQUEST", entityId: id }, orderBy: { createdAt: "asc" }, select: { body: true } })).map((c) => c.body);
  const notifs = (userId: string, title: string) => prisma.notification.count({ where: { userId, title } });
  const decider = async (k: string, id: string, decision: string, reason?: string) => {
    await comme(k);
    return decideRecruitmentStep(form({ id, decision, ...(reason !== undefined ? { reason } : {}) }));
  };
  async function candidat(requestId: string, status: "RECEIVED" | "SELECTED" | "HIRED", employeeId: string | null = null): Promise<string> {
    const c = await prisma.recruitmentCandidate.create({ data: { requestId, fullName: `${TAG}cand-${seq}-${status}`, status, employeeId }, select: { id: true } });
    return c.id;
  }

  /** La course FORCÉE : le geste est lancé, bloqué à l'écriture par le verrou ; le détenteur écrit, puis relâche. */
  async function pendantLaLecture<T>(table: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${`%"${table}"%`}`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error(`le geste n'a pas atteint la barrière (${table})`);
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  it("PRÉMISSES : les RH instruisent sans être le sommet ; les validateurs ne tiennent pas les RH", async () => {
    const rh = await actorFor(u.rh!, "VIEWER");
    expect(userCan(rh, "RH", "UPDATE")).toBe(true);
    expect(isTopManagement(rh)).toBe(false);
    const n1 = await actorFor(u.n1!, "VIEWER");
    expect(userCan(n1, "RH", "UPDATE")).toBe(false);
    expect(isTopManagement(await actorFor(u.dg!, "GENERAL_MANAGER"))).toBe(true);
  });

  it("UNE DÉCISION ILLISIBLE N'EST PAS UN ACCORD — absente ou mal écrite, elle ne valide rien", async () => {
    const id = await demande();
    expect(err(await decider("n1", id, "APPROUVE"))).toMatch(/Décision illisible/);
    await comme("n1");
    expect(err(await decideRecruitmentStep(form({ id })))).toMatch(/Décision illisible/);
    expect((await lire(id)).approvals[0]!.status, "rien n'a été validé au nom du validateur").toBe("PENDING");
  });

  it("UN REFUS SE MOTIVE CÔTÉ SERVEUR — après l'état : qui n'a pas la main l'apprend avant qu'on lui demande un motif", async () => {
    const id = await demande();
    expect(err(await decider("n2", id, "REJECTED")), "l'état d'abord").toMatch(/En attente de/);
    expect(err(await decider("autre", id, "REJECTED"))).toMatch(/pas dans votre périmètre/);
    expect(err(await decider("n1", id, "REJECTED"))).toMatch(/Un refus se motive/);
    expect((await lire(id)).stage).toBe("CHAIN");
    expect(err(await decider("n1", id, "REJECTED", "Budget non prévu"))).toBeNull();
    const r = await lire(id);
    expect(r).toMatchObject({ stage: "REJECTED", closingNote: "Budget non prévu" });
    expect(r.approvals[0]).toMatchObject({ status: "REJECTED", reason: "Budget non prévu" });
    expect(await fil(id)).toEqual(["Refusée à la marche 1 — Budget non prévu"]);
  });

  it("RENVOYER, dans la chaîne : qui peut trancher la marche, motif exigé ; la balle passe au demandeur", async () => {
    const id = await demande();
    expect(err(await (async () => { await comme("n2"); return renvoyerDemandeRecrutement(form({ id, motif: "x" })); })())).toMatch(/En attente de/);
    await comme("dem");
    expect(err(await renvoyerDemandeRecrutement(form({ id, motif: "x" })))).toMatch(/En attente de/);
    await comme("n1");
    expect(err(await renvoyerDemandeRecrutement(form({ id })))).toMatch(/Dites ce qu'il faut corriger/);
    expect(err(await renvoyerDemandeRecrutement(form({ id, motif: "Précisez la zone : Oran seulement, ou tout l'Ouest ?" })))).toBeNull();
    expect(await lire(id)).toMatchObject({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n1, returnNote: expect.stringMatching(/zone/) });
    expect(await notifs(u.dem!, "Demande de recrutement à corriger")).toBe(1);
    // Renvoyée, personne ne tranche en attendant — la marche n'est pas « terminée », elle attend la correction.
    expect(err(await decider("n1", id, "APPROVED"))).toMatch(/chez son demandeur/);
    expect((await fil(id))[0]).toMatch(/^Renvoyée pour correction \(Validation hiérarchique\) — Précisez la zone/);
  });

  it("CORRIGER sans rien toucher de ce qui a été pesé : la demande revient à la MÊME marche, qui est prévenue", async () => {
    const id = await demande();
    await comme("n1");
    expect(err(await renvoyerDemandeRecrutement(form({ id, motif: "Missions trop vagues" })))).toBeNull();
    await comme("dem");
    expect(err(await resoumettreDemandeRecrutement(form({ id, missions: "Visites des CHU d'Oran et de Tlemcen" })))).toMatch(/Dites ce qui a changé/);
    const r = await resoumettreDemandeRecrutement(form({ id, missions: "Visites des CHU d'Oran et de Tlemcen", changements: "Missions précisées" }));
    expect(err(r)).toBeNull();
    expect(r.ok && r.message).toMatch(/revient à la marche/);
    const apres = await lire(id);
    expect(apres).toMatchObject({ stage: "CHAIN", returnedFrom: null, returnNote: null, returnedById: null, missions: "Visites des CHU d'Oran et de Tlemcen" });
    expect(apres.approvals.map((a) => a.status)).toEqual(["PENDING", "PENDING"]);
    expect(await notifs(u.n1!, "Demande de recrutement corrigée")).toBe(1);
    expect((await fil(id))[1]).toBe("Corrigée et renvoyée — Missions précisées");
  });

  it("CORRIGER en RELEVANT ce qui a été pesé : la chaîne repart de sa première marche — un accord ne couvre pas plus que ce qu'il a vu", async () => {
    const id = await demande();
    expect(err(await decider("n1", id, "APPROVED"))).toBeNull();
    await comme("n2");
    expect(err(await renvoyerDemandeRecrutement(form({ id, motif: "La fourchette est trop basse pour le marché" })))).toBeNull();
    await comme("dem");
    const r = await resoumettreDemandeRecrutement(form({ id, salaryMax: "130000", changements: "Fourchette relevée à 130 000" }));
    expect(err(r)).toBeNull();
    expect(r.ok && r.message).toMatch(/la chaîne repart de sa première marche/);
    const apres = await lire(id);
    expect(apres.stage).toBe("CHAIN");
    expect(Number(apres.salaryMax)).toBe(130_000);
    expect(apres.approvals.map((a) => a.status), "la marche 1 avait validé 100 000, pas 130 000").toEqual(["PENDING", "PENDING"]);
    expect(await notifs(u.n1!, "Demande de recrutement à valider de nouveau")).toBe(1);
    expect(await notifs(u.n2!, "La demande que vous avez renvoyée est corrigée"), "qui a renvoyé l'apprend aussi").toBe(1);
  });

  it("CORRIGER depuis les RH : sans changement matériel elle leur revient ; ce que le formulaire ne porte pas ne s'écrit pas", async () => {
    const id = await demande({ stage: "HR_REVIEW" });
    await prisma.recruitmentApproval.updateMany({ where: { requestId: id }, data: { status: "APPROVED", decidedAt: new Date() } });
    await comme("rh");
    expect(err(await renvoyerDemandeRecrutement(form({ id, motif: "Joignez la fiche de poste" })))).toBeNull();
    expect((await lire(id)).returnedFrom).toBe("HR_REVIEW");
    await comme("dem");
    // Seulement « ce qui a changé » : aucun champ du besoin n'est porté, aucun n'est effacé.
    expect(err(await resoumettreDemandeRecrutement(form({ id, changements: "Fiche de poste jointe" })))).toBeNull();
    const apres = await lire(id);
    expect(apres).toMatchObject({ stage: "HR_REVIEW", position: "Délégué médical Oran", headcount: 2, missions: "Visites des CHU de l'Ouest" });
    expect(apres.approvals.every((a) => a.status === "APPROVED"), "rien de matériel : la chaîne garde ses accords").toBe(true);
    expect(await notifs(u.rh!, "Demande de recrutement corrigée")).toBe(1);
  });

  it("une correction INVALIDE ne passe pas, et la demande reste chez son demandeur", async () => {
    const id = await demande({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n1!, returnNote: "x" });
    await comme("dem");
    expect(err(await resoumettreDemandeRecrutement(form({ id, endDate: "2027-06-30", changements: "Fin ajoutée" })))).toMatch(/Un CDI n'a pas de date de fin/);
    expect((await lire(id)).stage).toBe("RETURNED");
    await comme("n1");
    expect(err(await resoumettreDemandeRecrutement(form({ id, changements: "x" }))), "seul son demandeur corrige").toMatch(/Seul son demandeur/);
  });

  it("RENVOYÉE, une demande se RETIRE — même quand une marche avait déjà validé", async () => {
    const id = await demande({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n2!, returnNote: "x" });
    await prisma.recruitmentApproval.updateMany({ where: { requestId: id, order: 1 }, data: { status: "APPROVED", decidedAt: new Date() } });
    await comme("dem");
    expect(err(await cancelRecruitmentRequest(form({ id })))).toBeNull();
    expect((await lire(id)).stage).toBe("CANCELLED");
  });

  it("LES RH : refuser ou clôturer se motive, une décision illisible ne clôt rien", async () => {
    const id = await demande({ stage: "HR_REVIEW" });
    await comme("rh");
    expect(err(await closeRecruitmentRequest(form({ id, decision: "REJETER", note: "x" })))).toMatch(/Décision illisible/);
    expect(err(await closeRecruitmentRequest(form({ id, decision: "REJECTED" })))).toMatch(/Un refus se motive/);
    expect(err(await closeRecruitmentRequest(form({ id, decision: "REJECTED", note: "Poste non budgété" })))).toBeNull();
    expect(await lire(id)).toMatchObject({ stage: "REJECTED", closingNote: "Poste non budgété" });
    expect(await fil(id)).toEqual(["Refusée par les RH — Poste non budgété"]);
    const ouvert = await demande({ stage: "SOURCING" });
    expect(err(await closeRecruitmentRequest(form({ id: ouvert })))).toMatch(/clôt sans suite/);
    expect((await lire(ouvert)).stage).toBe("SOURCING");
  });

  it("ROUVRIR : à la marche qui a refusé et à elle seule, motif exigé, par les RH ou le sommet", async () => {
    const id = await demande();
    expect(err(await decider("n1", id, "APPROVED"))).toBeNull();
    expect(err(await decider("n2", id, "REJECTED", "Pas cette année"))).toBeNull();
    await comme("dem");
    expect(err(await rouvrirDemandeRecrutement(form({ id, motif: "x" })))).toMatch(/Seuls les RH ou la direction/);
    await comme("rh");
    expect(err(await rouvrirDemandeRecrutement(form({ id })))).toMatch(/Dites pourquoi vous la rouvrez/);
    expect(err(await rouvrirDemandeRecrutement(form({ id, motif: "Budget débloqué au comité du 30/09" })))).toBeNull();
    const r = await lire(id);
    expect(r).toMatchObject({ stage: "CHAIN", closingNote: null });
    expect(r.approvals.map((a) => a.status), "la marche 1 garde son accord").toEqual(["APPROVED", "PENDING"]);
    expect(await notifs(u.n2!, "Demande de recrutement rouverte — à trancher de nouveau")).toBe(1);
    expect((await fil(id)).at(-1)).toBe("Rouverte — Budget débloqué au comité du 30/09 · la décision précédente : « Pas cette année »");
  });

  it("ROUVRIR : refusée par les RH → chez les RH ; close sans recrutement → poste rouvert ; et les refus qui disent le geste qui reste", async () => {
    const rh = await demande({ stage: "REJECTED", closingNote: "Refus RH" });
    await prisma.recruitmentApproval.updateMany({ where: { requestId: rh }, data: { status: "APPROVED", decidedAt: new Date() } });
    await comme("dg");
    expect(err(await rouvrirDemandeRecrutement(form({ id: rh, motif: "Erreur d'appréciation" })))).toBeNull();
    expect((await lire(rh)).stage).toBe("HR_REVIEW");

    const close = await demande({ stage: "CLOSED", closingNote: "Gel des embauches" });
    expect(err(await rouvrirDemandeRecrutement(form({ id: close, motif: "Gel levé" })))).toBeNull();
    expect((await lire(close)).stage).toBe("SOURCING");

    const pourvue = await demande({ stage: "CLOSED", closingNote: "Pourvu" });
    await candidat(pourvue, "HIRED");
    expect(err(await rouvrirDemandeRecrutement(form({ id: pourvue, motif: "x" })))).toMatch(/Un candidat a été recruté/);

    const retiree = await demande({ stage: "CANCELLED" });
    expect(err(await rouvrirDemandeRecrutement(form({ id: retiree, motif: "x" })))).toMatch(/retirée par son auteur/);
  });

  it("ANNULER L'EMBAUCHE : avant la fiche, motif exigé — le candidat redevient retenu et le poste se rouvre", async () => {
    const id = await demande({ stage: "ONBOARDING" });
    const c = await candidat(id, "HIRED");
    await comme("rh");
    expect(err(await annulerEmbaucheRecrutement(form({ id })))).toMatch(/Dites pourquoi l'embauche s'annule/);
    expect(err(await annulerEmbaucheRecrutement(form({ id, motif: "Le candidat s'est désisté" })))).toBeNull();
    expect((await lire(id)).stage).toBe("SOURCING");
    expect((await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: c } })).status).toBe("SELECTED");
    expect(await notifs(u.dem!, "Embauche annulée — le poste est rouvert")).toBe(1);

    const avecFiche = await demande({ stage: "ONBOARDING" });
    const emp = await prisma.employee.create({ data: { fullName: `${TAG}emp-fiche` }, select: { id: true } });
    await candidat(avecFiche, "HIRED", emp.id);
    expect(err(await annulerEmbaucheRecrutement(form({ id: avecFiche, motif: "x" })))).toMatch(/La fiche employé existe déjà/);
  });

  it("MON ESPACE › À CORRIGER : le recrutement renvoyé et la demande de paiement renvoyée attendent leur demandeur", async () => {
    const id = await demande({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n1!, returnNote: "Précisez la zone" });
    const pay = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY-${Date.now()}`, title: `${TAG}Stand`, requesterId: u.dem!, status: "CHANGES_REQUESTED", amount: 500_000, payee: "SARL Atlas" },
      select: { id: true },
    });
    const { items } = await getActionCenter(await actorFor(u.dem!, "VIEWER"));
    const rec = items.find((i) => i.href === `/recrutement/${id}`);
    expect(rec, "le recrutement renvoyé est dans « À corriger »").toBeTruthy();
    expect(rec!.subtitle).toMatch(/Précisez la zone/);
    const p = items.find((i) => i.href === `/validations/paiements/${pay.id}`);
    expect(p, "la demande de paiement renvoyée aussi").toBeTruthy();
    expect(p!.statusLabel).toBe("À corriger");
    // Témoin : ce que d'AUTRES attendent ne s'affiche pas chez eux — y compris chez les RH, qui VOIENT le
    // module Recrutement (sans eux, une liste ouverte à tous les renvois passerait pour juste).
    const rh = await actorFor(u.rh!, "VIEWER");
    expect(userCan(rh, "RECRUITMENT", "VIEW"), "prémisse : les RH voient le module").toBe(true);
    for (const qui of [await actorFor(u.autre!, "VIEWER"), rh]) {
      const { items: autres } = await getActionCenter(qui);
      expect(autres.some((i) => i.href === `/recrutement/${id}` || i.href === `/validations/paiements/${pay.id}`)).toBe(false);
    }
  });

  it("MON ESPACE : un demandeur qui n'a plus le module Recrutement ne reçoit pas un lien vers une page qui le refusera", async () => {
    const ex = await actorFor(u.ex!, "VIEWER");
    expect(userCan(ex, "RECRUITMENT", "VIEW"), "prémisse : il n'a pas le module").toBe(false);
    const id = await demande({ requesterId: u.ex!, stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n1!, returnNote: "x" });
    const { items } = await getActionCenter(ex);
    expect(items.some((i) => i.href === `/recrutement/${id}`)).toBe(false);
  });

  // ─────────────────────────── Un geste à la fois — les courses forcées ───────────────────────────

  it("TÉMOIN : la direction tranche la marche PENDANT que le N+1 la tranche — le second ne réécrit pas la décision", async () => {
    const id = await demande();
    const r = await pendantLaLecture("RecruitmentApproval", () => decider("n1", id, "APPROVED"), async (tx) => {
      await tx.recruitmentApproval.updateMany({ where: { requestId: id, order: 1 }, data: { status: "APPROVED", reason: "par la direction", decidedAt: new Date() } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).approvals[0]!.reason, "la décision de la direction n'est pas écrasée").toBe("par la direction");
  });

  it("TÉMOIN : la demande quitte la chaîne PENDANT une décision — la marche ne garde pas une décision sans demande", async () => {
    const id = await demande();
    const r = await pendantLaLecture("RecruitmentRequest", () => decider("n1", id, "APPROVED"), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "CANCELLED" } });
    });
    expect(err(r)).toMatch(DEJA);
    const apres = await lire(id);
    expect(apres.stage).toBe("CANCELLED");
    expect(apres.approvals[0]!.status, "la transaction a défait la marche écrite").toBe("PENDING");
  });

  it("le N+1 valide PENDANT le retrait — la demande, encore dans sa chaîne, se retire quand même (04/10 : un avis n'est pas une embauche)", async () => {
    const id = await demande();
    await comme("dem");
    const r = await pendantLaLecture("RecruitmentRequest", () => cancelRecruitmentRequest(form({ id })), async (tx) => {
      await tx.recruitmentApproval.updateMany({ where: { requestId: id, order: 1 }, data: { status: "APPROVED", decidedAt: new Date() } });
    });
    expect(r.ok, err(r) ?? "").toBe(true);
    expect((await lire(id)).stage).toBe("CANCELLED");
  });

  it("TÉMOIN : la demande renvoyée est corrigée PENDANT son retrait — le retrait ne retire pas la demande repartie", async () => {
    const id = await demande({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n2!, returnNote: "x" });
    await prisma.recruitmentApproval.updateMany({ where: { requestId: id, order: 1 }, data: { status: "APPROVED", decidedAt: new Date() } });
    await comme("dem");
    const r = await pendantLaLecture("RecruitmentRequest", () => cancelRecruitmentRequest(form({ id })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "CHAIN" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("CHAIN");
  });

  it("TÉMOIN : un RH ouvre le poste PENDANT qu'un autre le refuse — le refus n'écrase pas l'ouverture", async () => {
    const id = await demande({ stage: "HR_REVIEW" });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => closeRecruitmentRequest(form({ id, decision: "REJECTED", note: "x" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "SOURCING" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("SOURCING");
  });

  it("TÉMOIN : la demande est validée PENDANT un renvoi — le renvoi ne la reprend pas aux RH", async () => {
    const id = await demande();
    await comme("n1");
    const r = await pendantLaLecture("RecruitmentRequest", () => renvoyerDemandeRecrutement(form({ id, motif: "x" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "HR_REVIEW" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("HR_REVIEW");
  });

  it("TÉMOIN : deux corrections croisées — la seconde n'écrit rien par-dessus la première", async () => {
    const id = await demande({ stage: "RETURNED", returnedFrom: "CHAIN", returnedById: u.n1!, returnNote: "x" });
    await comme("dem");
    const r = await pendantLaLecture("RecruitmentRequest", () => resoumettreDemandeRecrutement(form({ id, position: "Autre intitulé", changements: "x" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "CHAIN" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).position).toBe("Délégué médical Oran");
  });

  it("TÉMOIN : deux réouvertures à la même seconde — une seule rouvre", async () => {
    const id = await demande({ stage: "REJECTED", closingNote: "x" });
    await prisma.recruitmentApproval.updateMany({ where: { requestId: id, order: 1 }, data: { status: "REJECTED", decidedAt: new Date() } });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => rouvrirDemandeRecrutement(form({ id, motif: "x" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "CHAIN" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).approvals[0]!.status, "rien n'a été écrit sur la marche").toBe("REJECTED");
  });

  it("TÉMOIN : la fiche est créée PENDANT l'annulation de l'embauche — l'annulation ne défait rien", async () => {
    const id = await demande({ stage: "ONBOARDING" });
    const c = await candidat(id, "HIRED");
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => annulerEmbaucheRecrutement(form({ id, motif: "x" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "CLOSED" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: c } })).status, "le candidat reste recruté").toBe("HIRED");
  });

  it("TÉMOIN : la fiche est rattachée au candidat PENDANT l'annulation — on n'annule pas une embauche qui a sa fiche", async () => {
    const id = await demande({ stage: "ONBOARDING" });
    const c = await candidat(id, "HIRED");
    const emp = await prisma.employee.create({ data: { fullName: `${TAG}emp-course` }, select: { id: true } });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentCandidate", () => annulerEmbaucheRecrutement(form({ id, motif: "x" })), async (tx) => {
      await tx.recruitmentCandidate.update({ where: { id: c }, data: { employeeId: emp.id } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("ONBOARDING");
  });

  it("TÉMOIN : l'embauche est annulée PENDANT l'intégration — aucune fiche employé ne reste pour quelqu'un qu'on ne recrute plus", async () => {
    const id = await demande({ stage: "ONBOARDING" });
    const c = await prisma.recruitmentCandidate.create({ data: { requestId: id, fullName: `${TAG}integre`, status: "HIRED" }, select: { id: true } });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => onboardRecruitment(form({ id })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "SOURCING" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect(await prisma.employee.count({ where: { fullName: `${TAG}integre` } }), "la création est défaite avec le reste").toBe(0);
    expect((await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: c.id } })).employeeId).toBeNull();
  });

  it("TÉMOIN : l'embauche est annulée PENDANT la clôture d'un consultant — pas de clôture « consultant retenu »", async () => {
    const id = await demande({ stage: "ONBOARDING", contractType: "CONSULTING", endDate: new Date("2027-06-30") });
    await candidat(id, "HIRED");
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => onboardRecruitment(form({ id })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "SOURCING" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("SOURCING");
  });

  it("TÉMOIN : deux recrutements prononcés à la même seconde — un seul candidat devient « recruté »", async () => {
    const id = await demande({ stage: "SOURCING" });
    const a = await candidat(id, "SELECTED");
    await comme("dg");
    const r = await pendantLaLecture("RecruitmentRequest", () => moveRecruitmentCandidate(form({ candidateId: a, move: "HIRE" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "ONBOARDING" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: a } })).status, "défait avec la demande").toBe("SELECTED");
  });

  it("TÉMOIN : un candidat est écarté PENDANT sa présélection — la présélection ne le ressuscite pas", async () => {
    const id = await demande({ stage: "SOURCING" });
    const c = await candidat(id, "RECEIVED");
    await comme("dem");
    const r = await pendantLaLecture("RecruitmentCandidate", () => moveRecruitmentCandidate(form({ candidateId: c, move: "SHORTLIST" })), async (tx) => {
      await tx.recruitmentCandidate.update({ where: { id: c }, data: { status: "DECLINED" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: c } })).status).toBe("DECLINED");
  });

  it("TÉMOIN : la demande est refusée PENDANT l'ouverture du poste — l'ouverture ne la ressuscite pas", async () => {
    const id = await demande({ stage: "HR_REVIEW" });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => openRecruitmentSourcing(form({ id })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "REJECTED" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("REJECTED");
  });

  it("TÉMOIN : le poste est ouvert PENDANT une question des RH — la question ne le reprend pas", async () => {
    const id = await demande({ stage: "HR_REVIEW" });
    await comme("rh");
    const r = await pendantLaLecture("RecruitmentRequest", () => askRecruitmentInfo(form({ id, question: "Date de début ferme ?" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "SOURCING" } });
    });
    expect(err(r)).toMatch(DEJA);
    expect((await lire(id)).stage).toBe("SOURCING");
    expect(await prisma.recruitmentInfoRequest.count({ where: { requestId: id } }), "la question est défaite avec le reste").toBe(0);
  });

  it("TÉMOIN : la demande est refusée PENDANT la réponse du demandeur — la réponse ne la renvoie pas « chez les RH »", async () => {
    const id = await demande({ stage: "INFO_REQUESTED" });
    const q = await prisma.recruitmentInfoRequest.create({ data: { requestId: id, askedById: u.rh!, question: "Fourchette tenable ?" }, select: { id: true } });
    await comme("dem");
    const r = await pendantLaLecture("RecruitmentRequest", () => answerRecruitmentInfo(form({ id, infoId: q.id, answer: "Oui" })), async (tx) => {
      await tx.recruitmentRequest.update({ where: { id }, data: { stage: "REJECTED" } });
    });
    expect(r.ok && r.message).toMatch(/a changé entre-temps/);
    expect((await lire(id)).stage, "refusée, elle le reste").toBe("REJECTED");
    expect(await notifs(u.rh!, "Réponse à vos précisions — demande de recrutement")).toBe(0);
  });
});
