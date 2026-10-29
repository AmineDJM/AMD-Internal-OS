import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { seuilAdProEnVigueur, lireVisaAdPro, getAdProRequests } from "@/modules/ad-pro/api";
import { getActionCenter } from "@/lib/queries/action-center";
import {
  requestConsultingValidation, decideConsultingContract, closeConsultingContract, prolongerConsultingContract,
} from "./consulting-actions";
import { updateAdProRequest } from "@/modules/ad-pro/actions-edition";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__consultcorr__";
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
 * UN CONTRAT DE CONSULTING SE CORRIGE — par les VRAIS points d'entrée (audit 360°, lot C4a).
 *
 * Un contrat ne connaissait que « valider » ou « refuser » ; refusé, il était ANNULÉ — la seule
 * issue d'un montant mal tapé était donc de tout recommencer, et rien ne se modifiait, même en
 * brouillon. Ce banc joue ce qu'une personne fait : se voir RENVOYER un contrat avec ce qu'il faut
 * corriger, le CORRIGER, le RESOUMETTRE à la personne qui l'a demandé ; voir la porte du centre
 * Ad & Pro SUIVRE le montant corrigé ; PROLONGER un contrat en cours ; ANNULER en disant pourquoi.
 *
 * LES ACTEURS N'ONT PAS LA VUE GLOBALE (§118.104) : le porteur est la Direction Marketing, le
 * validateur désigné le Directeur Général (absent, par décision, de la vue globale), et les RH un
 * compte dont le seul module est RH. Un Super Admin rendrait vraies, quoi qu'il arrive, les gardes
 * de porteur et de validateur. Il ne sert ici que de SIÈGE du centre — c'est sa fonction.
 *
 * LE SEUIL n'est pas écrit (réglage global, suite parallèle — §118.132) : on le lit, et la
 * prémisse est assertée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Consulting — renvoyer, corriger, resoumettre, prolonger, annuler (flux réel)", () => {
  let auDessus = 0, enDessous = 0;
  let porteurId = "", gmId = "", saId = "", rhId = "";

  const creer = async (suffix: string, data: Partial<Prisma.ConsultingContractUncheckedCreateInput> = {}) =>
    (await prisma.consultingContract.create({
      data: {
        reference: `${TAG}${suffix}`, title: `${TAG} ${suffix}`, counterparty: `${TAG} cabinet`,
        amount: enDessous, status: "DRAFT", requesterId: porteurId, createdById: porteurId,
        ...data,
      },
      select: { id: true },
    })).id;
  const contrat = (id: string) => prisma.consultingContract.findUniqueOrThrow({ where: { id } });
  const commePorteur = async () => { ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER"); };
  const commeValidateur = async () => { ACTOR = await actorFor(gmId, "GENERAL_MANAGER"); };
  const commeSiege = async () => { ACTOR = await actorFor(saId, "SUPER_ADMIN"); };

  /** Créé puis soumis par son porteur, au validateur désigné. */
  const soumis = async (suffix: string, amount: number) => {
    const id = await creer(suffix, { amount });
    await commePorteur();
    const r = await requestConsultingValidation(form({ id, validatorId: gmId }));
    expect(r.ok, r.error).toBe(true);
    return id;
  };
  const decider = async (id: string, decision: "VALIDER" | "RENVOYER" | "REFUSER", note = "") => {
    await commeValidateur();
    return decideConsultingContract(form({ id, decision, ...(note ? { note } : {}) }));
  };
  const corriger = (id: string, champs: Record<string, string>) =>
    updateAdProRequest(form({ kind: "CONSULTING_CONTRACT", id, ...champs }));
  const fil = (id: string) =>
    prisma.comment.findMany({ where: { entityType: "CONSULTING_CONTRACT", entityId: id }, select: { body: true }, orderBy: { createdAt: "asc" } });
  /**
   * Les notifications de CE contrat : par son lien, ou — celles du centre pointent vers la file — par sa
   * RÉFÉRENCE suivie du séparateur que le corps écrit. Chercher le TAG compterait celles des autres contrats
   * du banc, et le compte dépendrait de l'ordre des cas (§118.92).
   */
  const notifs = async (userId: string, title: string, id: string) => {
    const ref = (await contrat(id)).reference;
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
  /**
   * Deux gestes FORCÉS à se croiser : le verrou SHARE arrête toute écriture de contrat sans arrêter
   * les lectures — chacun lit l'état d'avant, puis les deux écritures partent ensemble. Sans
   * l'écriture conditionnelle, la seconde passerait aussi (§118.164e : on force, on n'espère pas).
   */
  async function croises<T>(table: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
    let pa!: Promise<T>, pb!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      pa = a();
      pb = b();
      await attendreBloques(tx, table, 2);
    }, { timeout: 20_000 });
    return [await pa, await pb];
  }

  beforeAll(async () => {
    const seuil = await seuilAdProEnVigueur();
    expect(seuil, "PRÉMISSE : avec un seuil nul, la porte est désarmée et rien ne serait mesuré (§118.104).").not.toBeNull();
    auDessus = (seuil as number) * 5;
    enDessous = Math.max(1, Math.floor((seuil as number) / 10));

    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [porteur, gm, sa, rh] = await Promise.all([
      mk("porteur", "PRODUCT_MANAGER"), mk("dg", "GENERAL_MANAGER"), mk("sa", "SUPER_ADMIN"), mk("rh", "VIEWER"),
    ]);
    porteurId = porteur.id; gmId = gm.id; saId = sa.id; rhId = rh.id;
    // Les RH, et RIEN d'autre : un accès personnalisé au seul module RH (§118.147).
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: rhId, module, canView: true, canCreate: true, canUpdate: true, canValidate: true, scope: "ALL" } });
  });

  afterAll(async () => {
    const ids = (await prisma.consultingContract.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.consultingTask.deleteMany({ where: { contractId: { in: ids } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    // Les rôles prévenus en masse (le centre, la Direction) atteignent aussi des comptes d'autres bancs :
    // on retire ce que CE banc a écrit, par son identifiant, borné dans le temps (§118.175).
    await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, body: { contains: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("PRÉMISSES : aucun acteur n'a la vue globale, hors le siège ; les RH n'ont que les RH", async () => {
    const porteur = await actorFor(porteurId, "PRODUCT_MANAGER");
    const gm = await actorFor(gmId, "GENERAL_MANAGER");
    const rh = await actorFor(rhId, "VIEWER");
    expect(hasGlobalView(porteur.role) || hasGlobalView(gm.role)).toBe(false);
    expect(userCan(gm, "CONSULTING", "VALIDATE"), "le validateur désigné a le droit de valider").toBe(true);
    expect(userCan(porteur, "RH", "VIEW"), "la Direction Marketing n'a pas les RH").toBe(false);
    expect([userCan(rh, "RH", "VALIDATE"), userCan(rh, "CONSULTING", "VIEW")]).toEqual([true, false]);
  });

  it("RENVOYER : l'état d'abord (un brouillon ne demande pas pourquoi), un motif ensuite ; renvoyé, le contrat revient chez son porteur et sa porte en attente se retire", async () => {
    const brouillon = await creer("etat");
    const avant = await decider(brouillon, "RENVOYER");
    expect(avant.error, "un contrat qui n'attend rien ne demande pas de motif (§118.18)").toBe("Ce contrat n'attend pas de décision.");

    const id = await soumis("renvoi", auDessus);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "PRÉMISSE : au-dessus du seuil, la soumission pose la porte").toBe("PENDING");
    const sansMotif = await decider(id, "RENVOYER");
    expect(sansMotif.error).toMatch(/Dites ce qu'il faut corriger/);
    expect((await contrat(id)).status, "un refus de motif n'écrit rien").toBe("AWAITING_VALIDATION");

    const r = await decider(id, "RENVOYER", "Cinq jours facturés pour trois prévus : à revoir.");
    expect(r.ok, r.error).toBe(true);
    const c = await contrat(id);
    expect([c.status, c.returnedById, c.returnNote]).toEqual(["DRAFT", gmId, "Cinq jours facturés pour trois prévus : à revoir."]);
    expect(c.returnedAt).not.toBeNull();
    expect([c.validatedById, c.cancelledAt], "un renvoi n'est ni une validation ni une annulation").toEqual([null, null]);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "renvoyé, il n'attend plus le centre : la porte en attente est retirée").toBeNull();
    expect(await notifs(porteurId, "Contrat de consulting à corriger", id), "le porteur apprend ce qu'il doit corriger").toBe(1);
  });

  it("CORRIGER puis RESOUMETTRE : le renvoi s'efface et va au fil, le validateur qui l'a demandé reste désigné et le reçoit — sous le seuil, aucune porte", async () => {
    const id = await soumis("resoumis", auDessus);
    expect((await decider(id, "RENVOYER", "Montant hors grille.")).ok).toBe(true);

    await commePorteur();
    const c1 = await corriger(id, { amount: String(enDessous) });
    expect(c1.ok, c1.error).toBe(true);
    expect(c1.message, "en brouillon, la porte ne bouge pas : elle se jugera à la resoumission").toBeUndefined();
    expect(Number((await contrat(id)).amount)).toBe(enDessous);

    // SANS validatorId : une resoumission garde le validateur qui a demandé la correction (§118.152c).
    const r = await requestConsultingValidation(form({ id }));
    expect(r.ok, r.error).toBe(true);
    const c = await contrat(id);
    expect([c.status, c.validatorId]).toEqual(["AWAITING_VALIDATION", gmId]);
    expect([c.returnedAt, c.returnedById, c.returnNote], "le renvoi est traité : il s'efface du contrat").toEqual([null, null, null]);
    const lignes = (await fil(id)).map((l) => l.body);
    expect(lignes.some((b) => b.startsWith("Resoumis après correction") && b.includes("« Montant hors grille. »")), JSON.stringify(lignes)).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "sous le seuil, aucune porte").toBeNull();
    // UNE seule : à la première soumission, au-dessus du seuil, c'est le CENTRE qu'on prévenait — la
    // correction, sous le seuil, revient au validateur qui l'a demandée.
    expect(await notifs(gmId, "Contrat de consulting à valider", id), "le validateur reçoit la correction").toBe(1);
  });

  it("RESOUMIS AU-DESSUS de ce que le centre avait autorisé : l'autorisation se ROUVRE, la phrase le dit, et la décision attend le centre", async () => {
    const id = await soumis("rouvert", auDessus);
    await commeSiege();
    expect((await deciderVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, decision: "VALIDER" }))).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id)).toBe("APPROVED");
    // Renvoyer RÉDUIT (§118.15) : il passe même sous une autorisation du centre, qui reste.
    expect((await decider(id, "RENVOYER", "Ajouter la phase 2.")).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "une décision rendue par le centre reste : c'est de l'histoire").toBe("APPROVED");

    await commePorteur();
    expect((await corriger(id, { amount: String(auDessus * 2) })).ok).toBe(true);
    const r = await requestConsultingValidation(form({ id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/dépasse ce que le centre de validation Ad & Pro avait autorisé/);
    const v = await prisma.adProGateVisa.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONSULTING_CONTRACT", entityId: id } } });
    expect([v.status, Number(v.amount), v.decidedById]).toEqual(["PENDING", auDessus * 2, null]);
    expect(v.note).toMatch(/Montant relevé/);
    const bloque = await decider(id, "VALIDER");
    expect(bloque.ok, "un accord ne couvre pas plus que ce qu'il a vu").toBe(false);
    expect(bloque.error).toMatch(/centre/i);
  });

  it("RESOUMIS PLUS BAS mais encore au-dessus du seuil : l'autorisation COUVRE, rien ne se rouvre, et la décision passe", async () => {
    const id = await soumis("couvert", auDessus * 2);
    await commeSiege();
    expect((await deciderVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, decision: "VALIDER" }))).ok).toBe(true);
    expect((await decider(id, "RENVOYER", "Une phase de trop.")).ok).toBe(true);
    await commePorteur();
    expect((await corriger(id, { amount: String(auDessus) })).ok).toBe(true);
    const r = await requestConsultingValidation(form({ id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message, "rien n'a bougé au centre : rien à dire").toBeUndefined();
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id)).toBe("APPROVED");
    const d = await decider(id, "VALIDER");
    expect(d.ok, d.error).toBe(true);
    expect((await contrat(id)).status).toBe("ACTIVE");
  });

  it("RESOUMIS sous un REFUS du centre : c'est le centre qu'on prévient — le validateur, que ce refus bloque, ne pourrait rien", async () => {
    const id = await soumis("refuscentre", auDessus);
    await commeSiege();
    expect((await deciderVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, decision: "REFUSER", note: "Hors enveloppe." }))).ok).toBe(true);
    expect((await decider(id, "RENVOYER", "Le centre a refusé : réduire le périmètre.")).ok).toBe(true);
    await commePorteur();
    const r = await requestConsultingValidation(form({ id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/seul un siège du centre peut le réexaminer/);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id)).toBe("REFUSED");
    expect(await notifs(saId, "Centre Ad & Pro — contrat resoumis : votre refus est à réexaminer", id)).toBe(1);
    expect(await notifs(gmId, "Contrat de consulting à valider", id), "le validateur n'est pas sollicité pour une décision qu'il ne peut pas prendre").toBe(0);
  });

  it("CORRIGÉ PENDANT QU'IL ATTEND le centre : la porte suit le montant — relevé, elle se met à jour ; sous le seuil, elle se retire et la phrase le dit", async () => {
    const id = await soumis("encours", auDessus);
    await commePorteur();
    const releve = await corriger(id, { amount: String(auDessus * 3) });
    expect(releve.ok, releve.error).toBe(true);
    const v = await prisma.adProGateVisa.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONSULTING_CONTRACT", entityId: id } } });
    expect([v.status, Number(v.amount)]).toEqual(["PENDING", auDessus * 3]);

    const baisse = await corriger(id, { amount: String(enDessous) });
    expect(baisse.ok, baisse.error).toBe(true);
    expect(baisse.message).toMatch(/désormais sous le seuil/);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id)).toBeNull();
    const d = await decider(id, "VALIDER");
    expect(d.ok, "la porte retirée ne bloque plus la décision").toBe(true);
  });

  it("REFUSER exige un motif ; refusé, le contrat est annulé, sa porte en attente retirée, et le porteur lit le motif", async () => {
    const id = await soumis("refus", auDessus);
    expect((await decider(id, "REFUSER")).error).toMatch(/motif du refus/);
    const r = await decider(id, "REFUSER", "Pas de budget cette année.");
    expect(r.ok, r.error).toBe(true);
    const c = await contrat(id);
    expect([c.status, c.decisionNote, c.validatedById]).toEqual(["CANCELLED", "Pas de budget cette année.", gmId]);
    expect(c.cancelledAt).not.toBeNull();
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id)).toBeNull();
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: porteurId, title: "Contrat de consulting refusé", link: { contains: id } } });
    expect(n.body).toMatch(/Motif : Pas de budget cette année\./);
  });

  it("DEUX DÉCISIONS à la même seconde (un double clic) : une seule s'écrit, l'autre apprend qu'elle a été prise", async () => {
    const id = await soumis("duel", enDessous);
    const gm = await actorFor(gmId, "GENERAL_MANAGER");
    const [a, b] = await croises(
      "ConsultingContract",
      () => { ACTOR = gm; return decideConsultingContract(form({ id, decision: "RENVOYER", note: "À revoir." })); },
      () => { ACTOR = gm; return decideConsultingContract(form({ id, decision: "REFUSER", note: "Non." })); },
    );
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient d'être tranché/);
    expect((await contrat(id)).status).toBe(a.ok ? "DRAFT" : "CANCELLED");
  });

  it("ANNULER : l'état d'abord (un contrat clos ne demande pas pourquoi), un motif ensuite, au fil ; un terme atteint n'a rien à expliquer", async () => {
    await commePorteur();
    const clos = await creer("clos", { status: "CANCELLED", cancelledAt: new Date() });
    expect((await closeConsultingContract(form({ id: clos, cancel: "1" }))).error).toBe("Ce contrat est déjà clos.");

    const id = await creer("annule");
    expect((await closeConsultingContract(form({ id, cancel: "1" }))).error).toMatch(/Dites pourquoi le contrat est annulé/);
    expect((await contrat(id)).status).toBe("DRAFT");
    const r = await closeConsultingContract(form({ id, cancel: "1", note: "Le cabinet s'est retiré." }));
    expect(r.ok, r.error).toBe(true);
    expect((await contrat(id)).status).toBe("CANCELLED");
    expect((await fil(id)).map((l) => l.body)).toContain("Contrat annulé — Le cabinet s'est retiré.");

    const actif = await creer("terme", { status: "ACTIVE" });
    const t = await closeConsultingContract(form({ id: actif, cancel: "0" }));
    expect(t.ok, "« arrivé à expiration » n'exige aucun motif").toBe(true);
    expect((await contrat(actif)).status).toBe("EXPIRED");
  });

  it("DEUX ANNULATIONS à la même seconde : une seule s'écrit — un motif au fil, pas deux", async () => {
    const id = await creer("double");
    const porteur = await actorFor(porteurId, "PRODUCT_MANAGER");
    const [a, b] = await croises(
      "ConsultingContract",
      () => { ACTOR = porteur; return closeConsultingContract(form({ id, cancel: "1", note: "Premier clic." })); },
      () => { ACTOR = porteur; return closeConsultingContract(form({ id, cancel: "1", note: "Second clic." })); },
    );
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient de changer d'état/);
    expect((await fil(id)).filter((l) => l.body.startsWith("Contrat annulé"))).toHaveLength(1);
  });

  it("PROLONGER : un contrat EN COURS, par qui le valide, vers une fin qui SUIT l'actuelle, avec un motif — au fil, et le porteur prévenu", async () => {
    const id = await creer("prolonge", { status: "ACTIVE", validatorId: gmId, startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") });
    await commePorteur();
    expect((await prolongerConsultingContract(form({ id, endDate: "2027-06-30", note: "Avenant." }))).error)
      .toBe("Prolonger un contrat revient à qui peut le valider.");

    const brouillon = await creer("prolongebrouillon", { validatorId: gmId });
    await commeValidateur();
    expect((await prolongerConsultingContract(form({ id: brouillon, endDate: "2027-06-30", note: "Avenant." }))).error).toBe("Seul un contrat en cours se prolonge.");
    expect((await prolongerConsultingContract(form({ id, endDate: "2026-06-30", note: "Avenant." }))).error).toMatch(/doit suivre l'actuelle/);
    expect((await prolongerConsultingContract(form({ id, endDate: "2027-06-30" }))).error).toMatch(/Dites ce qui fonde la prolongation/);

    const r = await prolongerConsultingContract(form({ id, endDate: "2027-06-30", note: "Avenant n°2 signé le 1er octobre." }));
    expect(r.ok, r.error).toBe(true);
    expect((await contrat(id)).endDate?.toISOString().slice(0, 10)).toBe("2027-06-30");
    expect((await fil(id)).some((l) => l.body.startsWith("Contrat prolongé") && l.body.endsWith("Avenant n°2 signé le 1er octobre."))).toBe(true);
    expect(await prisma.notification.count({ where: { userId: porteurId, link: { contains: id }, createdAt: { gte: T0 } } })).toBeGreaterThanOrEqual(1);
  });

  it("DEUX PROLONGATIONS croisées : une seule s'écrit, la seconde apprend que le contrat a changé", async () => {
    const id = await creer("prolongeduel", { status: "ACTIVE", validatorId: gmId, endDate: new Date("2026-12-31") });
    const gm = await actorFor(gmId, "GENERAL_MANAGER");
    const [a, b] = await croises(
      "ConsultingContract",
      () => { ACTOR = gm; return prolongerConsultingContract(form({ id, endDate: "2027-03-31", note: "Trois mois." })); },
      () => { ACTOR = gm; return prolongerConsultingContract(form({ id, endDate: "2027-09-30", note: "Neuf mois." })); },
    );
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient de changer/);
    expect((await contrat(id)).endDate?.toISOString().slice(0, 10)).toBe(a.ok ? "2027-03-31" : "2027-09-30");
  });

  it("UN CONTRAT RH se corrige par le module RH : les RH y entrent, la Direction Marketing (sans RH) n'y entre pas", async () => {
    const id = await creer("rh", { pole: "RH", requesterId: gmId, createdById: gmId });
    ACTOR = await actorFor(rhId, "VIEWER");
    const r = await corriger(id, { title: `${TAG} rh — intitulé corrigé` });
    expect(r.ok, r.error).toBe(true);
    expect((await contrat(id)).title).toBe(`${TAG} rh — intitulé corrigé`);

    await commePorteur();
    const refus = await corriger(id, { title: `${TAG} rh — par la promotion` });
    expect(refus.error, "hors de sa portée, le contrat est introuvable — la même phrase que son absence").toBe("Demande introuvable.");
  });

  it("CORRIGER, côté serveur : un champ obligatoire ne se vide pas, un menu n'accepte que ses choix, la fin ne précède pas le début — et l'historique dit les LIBELLÉS", async () => {
    const id = await creer("champs", { startDate: new Date("2026-03-01"), billing: "ONE_OFF" });
    await commePorteur();
    expect((await corriger(id, { title: "" })).error).toBe("L'intitulé du contrat est obligatoire.");
    expect((await corriger(id, { counterparty: "" })).error).toMatch(/un contrat a deux parties/);
    expect((await corriger(id, { billing: "HEBDO" })).error).toBe("« Rythme » : choisissez une valeur de la liste.");
    expect((await corriger(id, { endDate: "2026-01-15" })).error).toBe("La date de fin ne peut pas précéder la date de début.");

    const r = await corriger(id, { billing: "MONTHLY" });
    expect(r.ok, r.error).toBe(true);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, summary: { startsWith: "Demande modifiée" } }, orderBy: { createdAt: "desc" } });
    expect(a.summary).toContain("Rythme : Forfait unique → Mensuel");
  });

  it("UN CONTRAT ACTIF ne se corrige plus par son porteur — ses termes font foi tels qu'ils ont été validés", async () => {
    const id = await creer("actif", { status: "ACTIVE" });
    await commePorteur();
    expect((await corriger(id, { amount: "1" })).error).toBe("La décision est rendue : seule la Direction peut encore corriger cette demande.");
  });

  it("RENVOYÉ, il est « À corriger » partout où son porteur regarde : la liste Ad & Pro et Mon espace", async () => {
    const id = await soumis("partout", enDessous);
    expect((await decider(id, "RENVOYER", "Joindre la proposition commerciale.")).ok).toBe(true);
    const porteur = await actorFor(porteurId, "PRODUCT_MANAGER");
    const ligne = (await getAdProRequests(porteur)).find((r) => r.id === id);
    expect(ligne?.state, "un brouillon renvoyé n'est pas un brouillon qu'on n'a pas encore envoyé").toBe("RETURNED");
    const centre = await getActionCenter(porteur);
    const item = centre.items.find((i) => i.key === `corriger-CONSULTING_CONTRACT-${id}`);
    expect(item?.subtitle).toBe("Renvoyé pour correction : Joindre la proposition commerciale.");
    expect(item?.href).toBe(`/consulting/${id}`);
  });
});
