import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { seuilAdProEnVigueur, lireVisaAdPro } from "@/lib/ad-pro/visa";
import {
  createAdProOtherRequest, decideAdProOtherRequest, resoumettreAdProOtherRequest, closeAdProOtherRequest,
} from "./ad-pro-other-actions";
import { updateAdProRequest } from "./ad-pro-edit-actions";
import { deciderVisaCentreAdPro } from "./ad-pro-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__autrecorr__";
const T0 = new Date();

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE « AUTRE DEMANDE » SE CORRIGE ET SE RESOUMET — par les VRAIS points d'entrée (audit 360°,
 * rapport 17 R14, lot C4a).
 *
 * Refusée, elle était morte : aucun geste ne la rouvrait, et un montant mal tapé n'avait que le
 * refus pour issue. Ce banc joue ce qu'une personne fait : se voir refuser AVEC un motif, corriger
 * la description ou le montant, RESOUMETTRE en disant ce qui a changé — et voir la porte du centre
 * Ad & Pro suivre le montant corrigé, y compris quand c'est le CENTRE qui avait refusé.
 *
 * LE DEMANDEUR et son collègue sont la Direction Marketing, sans vue globale (§118.104) ; la
 * décision revient au Directeur Général, lui aussi hors de la vue globale. Le Super Admin n'est
 * que le SIÈGE du centre. Un compte de la Direction (qui, elle, a la vue globale) n'est là que pour
 * RECEVOIR ce qu'on lui adresse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("« Autre demande » — refuser avec motif, corriger, resoumettre, annuler (flux réel)", () => {
  let auDessus = 0, enDessous = 0;
  let demandeurId = "", collegueId = "", gmId = "", saId = "", directionId = "";

  const commeDemandeur = async () => { ACTOR = await actorFor(demandeurId, "PRODUCT_MANAGER"); };
  const commeDecideur = async () => { ACTOR = await actorFor(gmId, "GENERAL_MANAGER"); };
  const creer = async (suffix: string, amount: number) => {
    await commeDemandeur();
    const r = await createAdProOtherRequest(undefined, form({ title: `${TAG} ${suffix}`, description: `Description ${suffix}`, amount: String(amount) }));
    expect(r.ok, r.error).toBe(true);
    return r.id!;
  };
  const decider = async (id: string, approve: boolean, note = "") => {
    await commeDecideur();
    return decideAdProOtherRequest(form({ id, approve: approve ? "1" : "0", ...(note ? { note } : {}) }));
  };
  const resoumettre = async (id: string, champs: Record<string, string>) => {
    await commeDemandeur();
    return resoumettreAdProOtherRequest(form({ id, ...champs }));
  };
  const demande = (id: string) => prisma.adProOtherRequest.findUniqueOrThrow({ where: { id } });
  const fil = (id: string) =>
    prisma.comment.findMany({ where: { entityType: "AD_PRO_OTHER", entityId: id }, select: { body: true }, orderBy: { createdAt: "asc" } });
  const notifs = async (userId: string, title: string, id: string) => {
    const ref = (await demande(id)).reference;
    // La référence SUIVIE du séparateur du corps : « AUT-…-012 » ne doit pas compter « AUT-…-0123 » (§118.92).
    return prisma.notification.count({ where: { userId, title, createdAt: { gte: T0 }, OR: [{ link: { contains: id } }, { body: { contains: `${ref} — ` } }] } });
  };

  /** Attendre que `n` sessions soient bloquées sur un verrou dont la requête nomme `motif`. */
  async function attendreBloques(tx: Prisma.TransactionClient, motif: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${motif}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${motif}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const seuil = await seuilAdProEnVigueur();
    expect(seuil, "PRÉMISSE : avec un seuil nul, la porte est désarmée et rien ne serait mesuré (§118.104).").not.toBeNull();
    auDessus = (seuil as number) * 5;
    enDessous = Math.max(1, Math.floor((seuil as number) / 10));
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [d, c, gm, sa, dir] = await Promise.all([
      mk("demandeur", "PRODUCT_MANAGER"), mk("collegue", "PRODUCT_MANAGER"), mk("dg", "GENERAL_MANAGER"),
      mk("sa", "SUPER_ADMIN"), mk("direction", "DIRECTION"),
    ]);
    demandeurId = d.id; collegueId = c.id; gmId = gm.id; saId = sa.id; directionId = dir.id;
  });

  afterAll(async () => {
    const ids = (await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, body: { contains: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("PRÉMISSES : le demandeur et son collègue voient la nature sans vue globale ; le DG tranche", async () => {
    const d = await actorFor(demandeurId, "PRODUCT_MANAGER");
    const c = await actorFor(collegueId, "PRODUCT_MANAGER");
    const gm = await actorFor(gmId, "GENERAL_MANAGER");
    expect([hasGlobalView(d.role), hasGlobalView(c.role), hasGlobalView(gm.role)]).toEqual([false, false, false]);
    expect([userCan(d, "AD_PRO_OTHER", "CREATE"), userCan(c, "AD_PRO_OTHER", "VIEW"), userCan(gm, "AD_PRO_OTHER", "VALIDATE")]).toEqual([true, true, true]);
  });

  it("REFUSER exige un motif, VALIDER n'en exige pas — et l'état passe avant le motif", async () => {
    const a = await creer("valider", enDessous);
    const v = await decider(a, true);
    expect(v.ok, "valider n'exige aucun motif").toBe(true);
    const deja = await decider(a, false);
    expect(deja.error, "une demande tranchée ne demande pas de motif (§118.18)").toBe("Cette demande a déjà été tranchée.");

    const r = await creer("refuser", enDessous);
    expect((await decider(r, false)).error).toMatch(/motif du refus/);
    expect((await demande(r)).status).toBe("AWAITING_DECISION");
    expect((await decider(r, false, "Hors budget.")).ok).toBe(true);
    expect((await demande(r)).status).toBe("REFUSED");
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: demandeurId, title: "Demande refusée", link: { contains: r } } });
    expect(n.body).toMatch(/motif : Hors budget\..*Resoumettre/);
  });

  it("RESOUMETTRE : son demandeur seul, une demande refusée seulement (l'état avant le motif) ; ce qui a changé va au fil, la décision repart de zéro", async () => {
    const r = await creer("resoumise", enDessous);
    expect((await decider(r, false, "Devis trop élevé.")).ok).toBe(true);

    ACTOR = await actorFor(collegueId, "PRODUCT_MANAGER");
    expect((await resoumettreAdProOtherRequest(form({ id: r, note: "Par un collègue." }))).error).toBe("Seul son demandeur resoumet une demande refusée.");

    const validee = await creer("pasrefusee", enDessous);
    expect((await decider(validee, true)).ok).toBe(true);
    expect((await resoumettre(validee, {})).error, "l'état d'abord : pas de motif demandé pour ce qui ne se resoumet pas").toBe("Seule une demande refusée se resoumet.");

    expect((await resoumettre(r, {})).error).toMatch(/Dites ce qui a changé/);
    expect((await resoumettre(r, { note: "Nouveau devis.", description: "" })).error).toMatch(/Décrivez la demande/);
    expect((await resoumettre(r, { note: "Nouveau devis.", amount: "-5" })).error).toMatch(/nombre positif/);
    expect((await demande(r)).status, "aucun refus n'a rien écrit").toBe("REFUSED");

    const ok = await resoumettre(r, { note: "Nouveau devis, 20 % moins cher.", description: "Description corrigée" });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.message).toBe("Demande resoumise : elle revient à la décision de la Direction.");
    const d = await demande(r);
    expect([d.status, d.decidedById, d.decisionNote, d.description]).toEqual(["AWAITING_DECISION", null, null, "Description corrigée"]);
    expect(Number(d.amount), "le montant que le formulaire ne porte pas reste ce qu'il était").toBe(enDessous);
    const lignes = (await fil(r)).map((l) => l.body);
    expect(lignes.some((b) => b.includes("« Devis trop élevé. »") && b.endsWith("Ce qui a changé : Nouveau devis, 20 % moins cher.")), JSON.stringify(lignes)).toBe(true);
    expect(await notifs(directionId, "Demande Ad & Pro resoumise après refus", r)).toBe(1);
  });

  it("RESOUMISE AU-DESSUS du seuil : la porte s'ouvre, le centre est prévenu, la phrase le dit — et la décision attend le centre", async () => {
    const r = await creer("ausseuil", enDessous);
    expect((await decider(r, false, "Il manque la seconde journée.")).ok).toBe(true);
    const ok = await resoumettre(r, { note: "Deux journées.", amount: String(auDessus) });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.message).toMatch(/dépasse le seuil du centre de validation Ad & Pro/);
    expect(await lireVisaAdPro("AD_PRO_OTHER", r)).toBe("PENDING");
    expect(await notifs(saId, "Centre Ad & Pro — demande resoumise au-dessus du seuil", r)).toBe(1);
    const bloque = await decider(r, true);
    expect(bloque.ok).toBe(false);
    expect(bloque.error).toMatch(/centre/i);
    // Refuser RÉDUIT (§118.15) : il passe sous la porte, et la retire — refusée, elle n'attend plus le centre.
    expect((await decider(r, false, "Toujours trop cher.")).ok).toBe(true);
    expect(await lireVisaAdPro("AD_PRO_OTHER", r)).toBeNull();
  });

  it("DEUX RESOUMISSIONS à la même seconde : une seule s'écrit — une ligne au fil, pas deux", async () => {
    const r = await creer("doubleresoumise", enDessous);
    expect((await decider(r, false, "Incomplet.")).ok).toBe(true);
    const d = await actorFor(demandeurId, "PRODUCT_MANAGER");
    let pa!: ReturnType<typeof resoumettreAdProOtherRequest>, pb!: ReturnType<typeof resoumettreAdProOtherRequest>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "AdProOtherRequest" IN SHARE MODE`);
      ACTOR = d; pa = resoumettreAdProOtherRequest(form({ id: r, note: "Premier clic." }));
      ACTOR = d; pb = resoumettreAdProOtherRequest(form({ id: r, note: "Second clic." }));
      await attendreBloques(tx, "AdProOtherRequest", 2);
    }, { timeout: 20_000 });
    const [a, b] = [await pa, await pb];
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient de changer/);
    expect((await fil(r)).filter((l) => l.body.startsWith("Resoumise après refus"))).toHaveLength(1);
  });

  it("RESOUMISE sous un REFUS du centre : c'est le centre qu'on prévient — la Direction, que ce refus bloque, ne pourrait rien", async () => {
    const r = await creer("refuscentre", auDessus);
    expect(await lireVisaAdPro("AD_PRO_OTHER", r), "PRÉMISSE : au-dessus du seuil, la création pose la porte").toBe("PENDING");
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    expect((await deciderVisaCentreAdPro(form({ entityType: "AD_PRO_OTHER", entityId: r, decision: "REFUSER", note: "Trop cher." }))).ok).toBe(true);
    // Refuser RÉDUIT (§118.15) : la Direction peut dire non sous un refus du centre.
    expect((await decider(r, false, "Le centre a refusé le dépassement.")).ok).toBe(true);

    const ok = await resoumettre(r, { note: "Argumentaire joint." });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.message).toMatch(/seul un siège du centre peut le réexaminer/);
    expect(await lireVisaAdPro("AD_PRO_OTHER", r)).toBe("REFUSED");
    expect(await notifs(saId, "Centre Ad & Pro — demande resoumise : votre refus est à réexaminer", r)).toBe(1);
    expect(await notifs(directionId, "Demande Ad & Pro resoumise après refus", r), "la Direction n'est pas sollicitée pour une décision qu'elle ne peut pas prendre").toBe(0);
  });

  it("ANNULER : l'état d'abord (une demande close ne demande pas pourquoi), un motif ensuite, au fil ; « terminée » n'a rien à expliquer", async () => {
    const fait = await creer("terminee", enDessous);
    expect((await decider(fait, true)).ok).toBe(true);
    await commeDemandeur();
    const t = await closeAdProOtherRequest(form({ id: fait, cancel: "0" }));
    expect(t.ok, "« terminée » n'exige aucun motif").toBe(true);
    expect((await demande(fait)).status).toBe("DONE");
    expect((await closeAdProOtherRequest(form({ id: fait, cancel: "1" }))).error).toBe("Cette demande est déjà close.");

    const id = await creer("annulee", enDessous);
    expect((await closeAdProOtherRequest(form({ id, cancel: "1" }))).error).toMatch(/Dites pourquoi la demande est annulée/);
    const r = await closeAdProOtherRequest(form({ id, cancel: "1", note: "L'association a reporté." }));
    expect(r.ok, r.error).toBe(true);
    expect((await demande(id)).status).toBe("CANCELLED");
    expect((await fil(id)).map((l) => l.body)).toContain("Demande annulée — L'association a reporté.");
  });

  it("DEUX ANNULATIONS à la même seconde : une seule s'écrit — un motif au fil, pas deux", async () => {
    const id = await creer("double", enDessous);
    const d = await actorFor(demandeurId, "PRODUCT_MANAGER");
    let pa!: ReturnType<typeof closeAdProOtherRequest>, pb!: ReturnType<typeof closeAdProOtherRequest>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "AdProOtherRequest" IN SHARE MODE`);
      ACTOR = d; pa = closeAdProOtherRequest(form({ id, cancel: "1", note: "Premier clic." }));
      ACTOR = d; pb = closeAdProOtherRequest(form({ id, cancel: "1", note: "Second clic." }));
      await attendreBloques(tx, "AdProOtherRequest", 2);
    }, { timeout: 20_000 });
    const [a, b] = [await pa, await pb];
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient de changer d'état/);
    expect((await fil(id)).filter((l) => l.body.startsWith("Demande annulée"))).toHaveLength(1);
  });

  it("CORRIGER une demande EN ATTENTE : au-dessus du seuil la porte s'ouvre et le centre est prévenu ; l'objet ne se vide pas ; refusée, elle ne se corrige plus en silence", async () => {
    const id = await creer("corrigee", enDessous);
    await commeDemandeur();
    const r = await updateAdProRequest(form({ kind: "AD_PRO_OTHER", id, amount: String(auDessus) }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/dépasse le seuil du centre de validation Ad & Pro/);
    expect(await lireVisaAdPro("AD_PRO_OTHER", id)).toBe("PENDING");
    expect(await notifs(saId, "Centre Ad & Pro — montant corrigé au-dessus du seuil", id)).toBe(1);
    expect((await updateAdProRequest(form({ kind: "AD_PRO_OTHER", id, title: "" }))).error).toBe("L'objet de la demande est obligatoire.");

    expect((await decider(id, false, "Non.")).ok).toBe(true);
    await commeDemandeur();
    expect((await updateAdProRequest(form({ kind: "AD_PRO_OTHER", id, amount: "1" }))).error)
      .toBe("La décision est rendue : seule la Direction peut encore corriger cette demande.");
  });
});
