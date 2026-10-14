import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, estPrete, accesAttribue, PERMISSIONS, type SessionUser } from "@/lib/rbac";
import { detenteurPourInterim } from "@/lib/hr/stand-in-resolve";
import { modulesPretables, delegatedActions } from "@/lib/hr/stand-in";
import { proposeStandIn, decideStandIn } from "@/lib/actions/stand-in-actions";
import { setCompanyAccess } from "@/lib/actions/company-access-actions";
import { setEmployeeActive } from "@/lib/actions/hr-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉRIM NE PRÊTE JAMAIS PLUS QUE CE QUE L'ABSENT DÉTIENT (§118.196, lot E4 — audit 360°, M13).
 *
 * Mesuré : les droits prêtés se lisaient sur la MATRICE du rôle principal de l'absent. Un module que la
 * console lui avait BLOQUÉ, un accès personnalisé plus ÉTROIT que son rôle, un module RETIRÉ de la
 * plateforme, un compte FERMÉ en cours de congé : tout passait à l'intérimaire. L'écran de déclaration
 * proposait TOUS les modules ; la notification menait à « /validations » et annonçait « vous remplacez »
 * des semaines avant le congé ; rien ne disait à l'intérimaire qu'il agissait au nom de quelqu'un.
 *
 * Et, trouvé en relisant les mêmes fonctions : une décision illisible valait accord, l'écriture des RH
 * n'était pas conditionnelle (elle validait un intérimaire changé pendant qu'on la prenait), « deux
 * personnes » n'était qu'une phrase, la RH d'une société tranchait par l'identifiant le congé d'une autre,
 * et un droit RH PRÊTÉ ouvrait des entités, fermait des comptes et validait des intérims.
 *
 * Joué par les VRAIS points d'entrée, avec des acteurs SANS vue globale (§118.104) et leurs prémisses.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = "__e4prete";
const TAG = `${PREFIXE}${Date.now()}__`;
const DEBUT = new Date();
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false } as CurrentUser;
}
const comme = async (id: string) => { ACTOR = await actorFor(id); return ACTOR; };
const form = (o: Record<string, string>, modules: string[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  for (const m of modules) f.append("modules", m);
  return f;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? "" : r.error ?? "");
const jour = (decalage: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + decalage); return d; };

suite("l'intérim ne prête jamais plus que ce que l'absent détient", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const e: Record<string, string> = {};

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    const fiches = (await prisma.employee.findMany({ where: { fullName: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: fiches } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userSession.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    // La désignation prévient les RH de TOUTE la base (`notifyRoles`) : on retire ces lignes par leur
    // texte, borné par la date — l'index de la date sert, la table n'est pas parcourue.
    await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, body: { contains: PREFIXE } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
  }

  // L'INTÉRIM DE L'ABSENT `a` (HEAD_OF_SALES) : la console ne lui laisse que la LECTURE des marchés PCH et
  // lui BLOQUE les stocks ; son rôle porte aussi les ventes, module RETIRÉ. L'intérim est armé (congé
  // accordé, RH d'accord, en cours) sur les trois — stocké comme avant ce lot.
  // L'INTÉRIM DE `g` (GENERAL_MANAGER) : il prête les ressources humaines à `t`.
  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = async (k: string, role: string, companyId: string) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } })).id;
      e[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, companyId, userId: u[k], isActive: true } })).id;
    };
    await Promise.all([
      mk("a", "HEAD_OF_SALES", A), mk("s", "COORDINATOR", A), mk("s2", "COORDINATOR", A), mk("w", "COORDINATOR", A),
      mk("g", "GENERAL_MANAGER", A), mk("t", "COORDINATOR", A), mk("rh", "GENERAL_MANAGER", A), mk("rhB", "GENERAL_MANAGER", B),
      mk("k", "COORDINATOR", A), mk("k2", "COORDINATOR", A),
    ]);
    e.n = (await prisma.employee.create({ data: { fullName: `${TAG} n`, companyId: A, isActive: true } })).id;
    await prisma.userAccess.createMany({
      data: [
        { userId: u.a, module: "PCH", canView: true, scope: "ALL" },
        { userId: u.a, module: "STOCKS", canView: false },
        // L'intérimaire `t` : la console lui BLOQUE les finances que `g` lui prête.
        { userId: u.t, module: "FINANCES", canView: false },
      ],
    });
    await prisma.leaveRequest.createMany({
      data: [
        {
          employeeId: e.a, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
          standInId: u.s, standInStatus: "APPROVED", standInModules: ["PCH", "STOCKS", "SALES"],
        },
        {
          employeeId: e.g, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
          standInId: u.t, standInStatus: "APPROVED", standInModules: ["RH", "FINANCES"],
        },
      ],
    });
  }, 120_000);
  afterAll(nettoyer, 120_000);

  const conge = async (k: string, o: Partial<Prisma.LeaveRequestUncheckedCreateInput> = {}) => (await prisma.leaveRequest.create({
    data: { employeeId: e[k], startDate: jour(20), endDate: jour(25), days: 5, status: "PENDING", stage: "MANAGER", ...o },
  })).id;
  const lire = (id: string) => prisma.leaveRequest.findUniqueOrThrow({
    where: { id }, select: { standInId: true, standInStatus: true, standInModules: true, standInNote: true, standInDecidedById: true },
  });

  /** La transaction du banc tient la ligne du congé ; le geste, qui a lu AVANT, est bloqué à son écriture ; le banc
   *  écrit alors lui-même le changement concurrent, puis relâche (§118.164e — une course se force). Les trois
   *  écritures d'intérim posent `standInDecidedById` : c'est à cette colonne qu'on reconnaît le geste qui attend. */
  async function pendantLeGeste<T>(id: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "LeaveRequest" WHERE id = $1 FOR UPDATE`, id);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%"standInDecidedById"%'`;
        if (n >= 1) break;
        if (Date.now() - debut > 15_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 30_000 });
    return geste;
  }

  it("PRÉMISSES : la matrice du rôle prête PCH, Stocks et Ventes ; l'absent n'en détient que la lecture de PCH", async () => {
    expect(PERMISSIONS.HEAD_OF_SALES.PCH).toContain("UPDATE");
    expect(PERMISSIONS.HEAD_OF_SALES.STOCKS).toContain("VIEW");
    expect(PERMISSIONS.HEAD_OF_SALES.SALES).toContain("VIEW");
    const a = await getAccess(u.a, "HEAD_OF_SALES");
    expect([...(a.modules.get("PCH")?.actions ?? [])]).toEqual(["VIEW"]);
    expect(a.modules.has("STOCKS"), "bloqué par la console").toBe(false);
    expect(a.modules.has("SALES"), "module retiré").toBe(false);
    const coordinateur = accesAttribue("COORDINATOR", null, []).modules;
    for (const m of ["PCH", "STOCKS", "SALES", "RH"] as const) expect(coordinateur.has(m), `l'intérimaire n'a pas ${m} par lui-même`).toBe(false);
  });

  it("getAccess : l'intérimaire reçoit ce que l'absent DÉTIENT — pas la matrice de son rôle", async () => {
    const s = await getAccess(u.s, "COORDINATOR");
    expect([...(s.modules.get("PCH")?.actions ?? [])], "la lecture, et elle seule").toEqual(["VIEW"]);
    expect(s.modules.has("STOCKS"), "un module bloqué chez l'absent ne passe pas").toBe(false);
    expect(s.modules.has("SALES"), "un module retiré ne se rouvre pas par l'intérim").toBe(false);
    // UNE règle, deux lecteurs : ce que l'absent a lui-même, et ce que son intérimaire en reçoit.
    const a = await getAccess(u.a, "HEAD_OF_SALES");
    expect([...(s.modules.get("PCH")?.actions ?? [])]).toEqual([...(a.modules.get("PCH")?.actions ?? [])]);
  });

  it("l'intérim se dit (interims) et ce qu'il ajoute se sait (pretes) ; le témoin n'a rien", async () => {
    const s = await actorFor(u.s);
    expect(s.access.interims?.map((i) => ({ absentId: i.absentId, absentNom: i.absentNom, modules: i.modules }))).toEqual([
      { absentId: u.a, absentNom: `${TAG} a`, modules: ["PCH"] },
    ]);
    expect(estPrete(s, "PCH", "VIEW")).toBe(true);
    expect(estPrete(s, "VALIDATIONS", "VIEW"), "ce qu'il détient lui-même n'est pas prêté").toBe(false);
    const w = await actorFor(u.w);
    expect(w.access.interims ?? []).toEqual([]);
    expect(w.access.pretes?.size ?? 0).toBe(0);
  });

  it("un module que la console BLOQUE chez l'intérimaire ne s'ouvre pas — et le bandeau ne l'annonce pas", async () => {
    expect(PERMISSIONS.GENERAL_MANAGER.FINANCES, "PRÉMISSE : l'absent prête les finances").toContain("VIEW");
    const t = await actorFor(u.t);
    expect(t.access.modules.has("FINANCES"), "le blocage de l'administrateur prime sur l'intérim").toBe(false);
    expect(t.access.interims?.map((i) => i.modules)).toEqual([["RH"]]);
    expect(estPrete(t, "FINANCES", "VIEW"), "rien n'est prêté de ce qui ne s'ouvre pas").toBe(false);
  });

  it("un compte FERMÉ ne prête plus rien — et ne se déclare plus", async () => {
    await prisma.user.update({ where: { id: u.a }, data: { isActive: false } });
    try {
      const s = await getAccess(u.s, "COORDINATOR");
      expect(s.modules.has("PCH")).toBe(false);
      expect(s.interims ?? []).toEqual([]);
      expect(await detenteurPourInterim(u.a)).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: u.a }, data: { isActive: true } });
    }
  });

  it("l'écran de déclaration ne propose que ce que l'absent détient", async () => {
    const a = await detenteurPourInterim(u.a);
    expect(a).not.toBeNull();
    const m = modulesPretables(a!);
    expect(m).toContain("PCH");
    expect(m).not.toContain("STOCKS");
    expect(m).not.toContain("SALES");
    expect(delegatedActions(a!, "PCH")).toEqual(["VIEW"]);
  });

  let l5 = "";
  it("proposer un module que l'absent ne détient pas est refusé, et rien ne s'écrit", async () => {
    l5 = await conge("a");
    await comme(u.a);
    const stocks = err(await proposeStandIn(form({ id: l5, standInId: u.s }, ["PCH", "STOCKS"])));
    expect(stocks).toContain("« Stocks PCH » ne serait pas prêté : vous ne détenez pas ce module");
    expect(stocks).toContain("Retirez-le de la sélection");
    expect(err(await proposeStandIn(form({ id: l5, standInId: u.s }, ["SALES"])))).toContain("« Ventes » ne serait pas prêté");
    expect((await lire(l5)).standInId).toBeNull();
  });

  it("proposer ce qu'il détient s'écrit tel quel, en attente des RH", async () => {
    await comme(u.a);
    const r = await proposeStandIn(form({ id: l5, standInId: u.s }, ["PCH"]));
    expect(r).toEqual({ ok: true, message: "Intérimaire proposé — en attente de validation des RH." });
    expect(await lire(l5)).toMatchObject({ standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"] });
  });

  it("désigner ou retirer sur un congé annulé PENDANT le geste n'écrit rien", async () => {
    const id = await conge("a");
    await comme(u.a);
    const r1 = await pendantLeGeste(
      id,
      () => proposeStandIn(form({ id, standInId: u.s }, ["PCH"])),
      (tx) => tx.leaveRequest.update({ where: { id }, data: { status: "CANCELLED" } }),
    );
    expect(err(r1)).toBe("Ce congé vient d'être annulé ou refusé — rechargez la page.");
    expect((await lire(id)).standInId, "rien n'est désigné sur un congé annulé").toBeNull();

    const id2 = await conge("a", { standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"] });
    const r2 = await pendantLeGeste(
      id2,
      () => proposeStandIn(form({ id: id2 })),
      (tx) => tx.leaveRequest.update({ where: { id: id2 }, data: { status: "CANCELLED" } }),
    );
    expect(err(r2)).toBe("Ce congé vient d'être annulé ou refusé — rechargez la page.");
    expect((await lire(id2)).standInId, "rien n'est retiré non plus").toBe(u.s);
  });

  it("la RH d'une autre société ne touche pas au congé — ni pour proposer, ni pour valider", async () => {
    const rhB = await comme(u.rhB);
    expect(userCan(rhB, "RH", "UPDATE"), "PRÉMISSE : des RH en titre").toBe(true);
    expect(estPrete(rhB, "RH", "UPDATE")).toBe(false);
    expect(err(await proposeStandIn(form({ id: l5, standInId: u.s2 }, ["PCH"])))).toBe("Demande de congé introuvable.");
    expect(err(await decideStandIn(form({ id: l5, decision: "APPROVED" })))).toBe("Demande de congé introuvable.");
    expect(await lire(l5)).toMatchObject({ standInId: u.s, standInStatus: "PENDING" });
  });

  it("un congé terminé n'a plus de place à tenir", async () => {
    const passe = await conge("a", { startDate: jour(-10), endDate: jour(-5), status: "APPROVED", stage: "DONE" });
    await comme(u.a);
    expect(err(await proposeStandIn(form({ id: passe, standInId: u.s }, ["PCH"])))).toBe("Ce congé est terminé : il n'y a plus de place à tenir.");
    const passeEnAttente = await conge("a", {
      startDate: jour(-10), endDate: jour(-5), status: "APPROVED", stage: "DONE", standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"],
    });
    await comme(u.rh);
    expect(err(await decideStandIn(form({ id: passeEnAttente, decision: "APPROVED" })))).toBe("Ce congé est terminé : il n'y a plus de place à tenir.");
    expect((await lire(passeEnAttente)).standInStatus).toBe("PENDING");
  });

  it("une décision illisible n'est pas un accord", async () => {
    await comme(u.rh);
    expect(err(await decideStandIn(form({ id: l5, decision: "PEUT-ÊTRE" })))).toMatch(/Décision illisible/);
    expect(err(await decideStandIn(form({ id: l5 })))).toMatch(/Décision illisible/);
    expect((await lire(l5)).standInStatus, "rien n'a été validé au nom des RH").toBe("PENDING");
  });

  let l10 = "";
  it("valider un intérim qui ne transmettrait pas tout ce qui a été choisi est refusé", async () => {
    l10 = await conge("a", { standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH", "STOCKS"] });
    await comme(u.rh);
    const r = err(await decideStandIn(form({ id: l10, decision: "APPROVED" })));
    expect(r).toContain("« Stocks PCH » ne serait pas prêté");
    expect(r).toContain(`${TAG} a ne détient pas ce module`);
    expect((await lire(l10)).standInStatus).toBe("PENDING");
  });

  it("aucun module choisi : la phrase le dit, avec le geste", async () => {
    const id = await conge("a", { standInId: u.s, standInStatus: "PENDING", standInModules: [] });
    await comme(u.rh);
    const r = err(await decideStandIn(form({ id, decision: "APPROVED" })));
    expect(r).toContain("Aucun module n'a été choisi");
    expect(r).toContain("Mon dossier RH › Mes congés et absences");
    expect((await lire(id)).standInStatus).toBe("PENDING");
  });

  it("un absent sans compte : rien à transmettre — ni à proposer, ni à valider", async () => {
    const id = await conge("n", { standInId: u.s, standInStatus: "PENDING", standInModules: ["VALIDATIONS"] });
    await comme(u.rh);
    expect(err(await proposeStandIn(form({ id, standInId: u.s2 }, ["VALIDATIONS"])))).toContain("n'a pas de compte actif sur la plateforme : il n'y a rien à déléguer");
    expect(err(await decideStandIn(form({ id, decision: "APPROVED" })))).toContain("n'a pas de compte actif sur la plateforme : un intérim ne transmettrait rien");
    expect(await lire(id)).toMatchObject({ standInId: u.s, standInStatus: "PENDING" });
  });

  it("on ne valide pas un intérim où l'on est partie — son propre congé, sa propre désignation", async () => {
    const sien = await conge("rh", { standInId: u.s, standInStatus: "PENDING", standInModules: ["VALIDATIONS"] });
    const designe = await conge("a", { standInId: u.rh, standInStatus: "PENDING", standInModules: ["PCH"] });
    await comme(u.rh);
    expect(err(await decideStandIn(form({ id: sien, decision: "APPROVED" })))).toContain("On ne valide pas l'intérimaire de son propre congé");
    expect(err(await decideStandIn(form({ id: designe, decision: "APPROVED" })))).toContain("On ne valide pas sa propre désignation");
    expect((await lire(sien)).standInStatus).toBe("PENDING");
    expect((await lire(designe)).standInStatus).toBe("PENDING");
  });

  it("valider : la notification mène à Mon espace et dit quand l'intérim s'ouvrira", async () => {
    await comme(u.rh);
    const avant = new Date();
    expect(await decideStandIn(form({ id: l5, decision: "APPROVED" }))).toEqual({ ok: true, message: "Intérimaire validé." });
    expect(await lire(l5)).toMatchObject({ standInStatus: "APPROVED", standInDecidedById: u.rh });
    const pourS = await prisma.notification.findFirstOrThrow({ where: { userId: u.s, createdAt: { gte: avant }, title: "Vous êtes intérimaire" } });
    expect(pourS.link).toBe("/mon-espace");
    expect(pourS.body, "le congé n'est pas encore accordé : on ne dit pas « vous remplacez »").not.toContain("Vous remplacez");
    expect(pourS.body).toContain("Le congé n'est pas encore accordé");
    expect(pourS.body).toContain("Modules prêtés : Marchés PCH.");
    const pourA = await prisma.notification.findFirstOrThrow({ where: { userId: u.a, createdAt: { gte: avant }, title: "Intérimaire validé" } });
    // L'absent, lui, retrouve l'intérim sur SON congé (« Mon dossier RH › Mes congés et absences »).
    expect(pourA.link).toBe("/mon-dossier#mes-conges");
  });

  it("un intérim déjà tranché ne se retranche pas", async () => {
    await comme(u.rh);
    expect(err(await decideStandIn(form({ id: l5, decision: "REJECTED", note: "Finalement non" })))).toContain("Cet intérimaire a déjà été validé");
    expect((await lire(l5)).standInStatus).toBe("APPROVED");
  });

  it("une décision porte sur ce qu'elle a vu : l'intérimaire changé pendant la décision n'est pas validé", async () => {
    const id = await conge("a", { status: "APPROVED", stage: "DONE", standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"] });
    await comme(u.rh);
    const r = await pendantLeGeste(
      id,
      () => decideStandIn(form({ id, decision: "APPROVED" })),
      (tx) => tx.leaveRequest.update({ where: { id }, data: { standInId: u.s2 } }),
    );
    expect(err(r)).toContain("vient d'être modifié ou tranché par quelqu'un d'autre");
    expect(await lire(id), "personne n'a validé s2, que les RH n'ont pas vu").toMatchObject({ standInId: u.s2, standInStatus: "PENDING" });
  });

  it("ni des modules changés pendant la décision, ni un congé annulé pendant qu'on la prend", async () => {
    const id = await conge("a", { status: "APPROVED", stage: "DONE", standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"] });
    await comme(u.rh);
    const r1 = await pendantLeGeste(
      id,
      () => decideStandIn(form({ id, decision: "APPROVED" })),
      (tx) => tx.leaveRequest.update({ where: { id }, data: { standInModules: ["PCH", "VALIDATIONS"] } }),
    );
    expect(err(r1)).toContain("vient d'être modifié ou tranché par quelqu'un d'autre");
    expect(await lire(id), "les RH n'ont pas vu « Demandes de validations »").toMatchObject({ standInStatus: "PENDING", standInModules: ["PCH", "VALIDATIONS"] });

    const id2 = await conge("a", { status: "APPROVED", stage: "DONE", standInId: u.s, standInStatus: "PENDING", standInModules: ["PCH"] });
    const r2 = await pendantLeGeste(
      id2,
      () => decideStandIn(form({ id: id2, decision: "APPROVED" })),
      (tx) => tx.leaveRequest.update({ where: { id: id2 }, data: { status: "CANCELLED" } }),
    );
    expect(err(r2)).toContain("vient d'être modifié ou tranché par quelqu'un d'autre");
    expect((await lire(id2)).standInStatus, "aucun intérim validé sur un congé annulé").toBe("PENDING");
  });

  it("un refus se motive ; motivé, il passe — y compris sans module choisi", async () => {
    const id = await conge("a", { standInId: u.s, standInStatus: "PENDING", standInModules: [] });
    await comme(u.rh);
    expect(err(await decideStandIn(form({ id, decision: "REJECTED" })))).toContain("Un refus se motive");
    const avant = new Date();
    expect(await decideStandIn(form({ id, decision: "REJECTED", note: "Pas disponible ces dates" }))).toEqual({ ok: true, message: "Intérimaire refusé." });
    expect(await lire(id)).toMatchObject({ standInStatus: "REJECTED", standInNote: "Pas disponible ces dates" });
    const pourS = await prisma.notification.findFirstOrThrow({ where: { userId: u.s, createdAt: { gte: avant }, title: "Intérim refusé" } });
    expect(pourS.link, "un refus ne mène nulle part : il n'y a rien à faire").toBeNull();
  });

  it("un droit RH prêté n'ouvre pas d'entité à un tiers", async () => {
    const t = await comme(u.t);
    expect(userCan(t, "RH", "UPDATE"), "PRÉMISSE : l'intérim lui prête les RH").toBe(true);
    expect(estPrete(t, "RH", "UPDATE")).toBe(true);
    expect(err(await setCompanyAccess(undefined, form({ userId: u.k, companyId: B, mode: "view" })))).toContain("par intérim");
    expect(await prisma.userCompanyAccess.count({ where: { userId: u.k } })).toBe(0);
    // TÉMOIN : les RH en titre le font — le refus ne vient que du prêt.
    const rh = await comme(u.rh);
    expect(estPrete(rh, "RH", "UPDATE")).toBe(false);
    expect((await setCompanyAccess(undefined, form({ userId: u.k, companyId: B, mode: "view" }))).ok).toBe(true);
    expect(await prisma.userCompanyAccess.count({ where: { userId: u.k } })).toBe(1);
  });

  it("un droit RH prêté ne valide ni ne désigne d'intérim", async () => {
    await comme(u.t);
    expect(err(await decideStandIn(form({ id: l10, decision: "REJECTED", note: "x" })))).toContain("Vous tenez les ressources humaines par intérim");
    expect((await lire(l10)).standInStatus).toBe("PENDING");
    const deW = await conge("w");
    expect(err(await proposeStandIn(form({ id: deW, standInId: u.s2 }, ["VALIDATIONS"])))).toBe("Seule la personne absente (ou les ressources humaines) désigne son intérimaire.");
    expect((await lire(deW)).standInId).toBeNull();
    // TÉMOIN : les RH en titre désignent pour quelqu'un.
    await comme(u.rh);
    expect((await proposeStandIn(form({ id: deW, standInId: u.s2 }, ["VALIDATIONS"]))).ok).toBe(true);
    expect((await lire(deW)).standInId).toBe(u.s2);
  });

  it("un droit RH prêté désactive la fiche mais ne ferme pas le compte — et le dit", async () => {
    await comme(u.t);
    try {
      const r = await setEmployeeActive(form({ id: e.k2 }));
      expect(r.ok).toBe(true);
      expect(r.ok && r.message).toContain("vous tenez les ressources humaines par intérim, et un intérim ne ferme pas de compte");
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.k2 } })).isActive, "la fiche, oui").toBe(false);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.k2 } })).isActive, "le compte, non").toBe(true);
    } finally {
      await prisma.employee.update({ where: { id: e.k2 }, data: { isActive: true } });
    }
  });

  it("POINTS D'APPEL — l'écran de déclaration lit la règle ; les écrans RH cachent ce qu'un droit prêté ne permet pas", () => {
    const dossier = readFileSync("src/app/(app)/mon-dossier/page.tsx", "utf8");
    expect(dossier).toContain("detenteurPourInterim(user.id)");
    expect(dossier).toContain("(moi ? modulesPretables(moi) : [])");
    expect(dossier).toContain("termine: congeTermine(l.endDate)");
    expect(dossier).not.toMatch(/MODULES\.filter\(isDelegatable\)/);
    const conges = readFileSync("src/app/(app)/rh/conges/page.tsx", "utf8");
    expect(conges).toContain(`const peutValiderInterims = canManage && !estPrete(user, "HR_REQUESTS", "UPDATE");`);
    expect(conges).toContain("const standIns = peutValiderInterims");
    expect(conges).toContain(".filter((l) => !congeTermine(l.endDate))");
    expect(conges).toContain("{peutValiderInterims && standIns.length > 0 && (");
    expect(conges).toContain("l.employee.userId === user.id || l.standInId === user.id ?");
    const fiche = readFileSync("src/app/(app)/rh/[id]/page.tsx", "utf8");
    expect(fiche).toContain(`{canUpdate && (hasGlobalView(user) || !estPrete(user, "RH", "UPDATE")) && employee.userId && (`);
  });
});
