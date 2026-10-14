import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { createDirectValidation } from "@/lib/validation";
import { decideValidation, resoumettreValidation, deleteMyValidationRequest } from "@/lib/actions/validation-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__valrenvoi__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
const jour = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE VALIDATIONS FAIT CORRIGER AU LIEU DE CLORE — par les VRAIS points d'entrée
 * (audit 360°, lot C3 : R08, et ce que le chantier a trouvé en route).
 *
 * « Modification demandée » clôturait la demande ; le motif était facultatif ; deux validateurs
 * d'un circuit parallèle qui approuvaient à la même seconde laissaient la demande en attente pour
 * toujours ; et les pièces d'une demande s'ouvraient, par leur identifiant, à tout porteur du module.
 * Chaque acteur est NOMMÉ dans son cas (§118.151f), aucun n'a la vue globale (§118.104), et les deux
 * courses sont FORCÉES sous barrière, jamais espérées (§118.164e).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Validations — renvoyer pour correction, resoumettre, un geste à la fois", () => {
  let demId = "", v1Id = "", v2Id = "", horsId = "", interimId = "", companyId = "";
  const employes: string[] = [];
  const conges: string[] = [];
  const demandes: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    const [dem, v1, v2, hors, interim] = await Promise.all([
      mk("dem", "MEDICAL_DELEGATE"), mk("v1", "HEAD_OF_SALES"), mk("v2", "FINANCE_BUDGET_MANAGER"),
      mk("hors", "MEDICAL_DELEGATE"), mk("interim", "MEDICAL_DELEGATE"),
    ]);
    demId = dem.id; v1Id = v1.id; v2Id = v2.id; horsId = hors.id; interimId = interim.id;
    companyId = (await prisma.company.create({ data: { name: `${RUN}société` } })).id;
    // L'INTÉRIM : congé de V2 accordé, intérimaire validé par les RH, en cours aujourd'hui.
    const [eV2, eInterim] = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} v2`, userId: v2Id, companyId, isActive: true } }),
      prisma.employee.create({ data: { fullName: `${TAG} interim`, userId: interimId, companyId, isActive: true } }),
    ]);
    employes.push(eV2.id, eInterim.id);
    conges.push((await prisma.leaveRequest.create({
      data: {
        employeeId: eV2.id, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
        standInId: interimId, standInStatus: "APPROVED", standInModules: ["VALIDATIONS"],
      },
    })).id);
  }, 120_000);

  afterAll(async () => {
    const comptes = [demId, v1Id, v2Id, horsId, interimId].filter(Boolean);
    await prisma.comment.deleteMany({ where: { entityType: "VALIDATION_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: demandes } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { id: { in: conges } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: employes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  async function demande(titre: string, opts: { mode?: "SEQUENTIAL" | "PARALLEL"; validateurs?: string[]; amount?: number; entityType?: "ADMIN_REQUEST" } = {}) {
    const r = await createDirectValidation({
      requesterId: demId, title: `${TAG}${titre}`, description: "Texte d'origine", module: "Demandes de validations",
      validatorIds: opts.validateurs ?? [v1Id, v2Id], mode: opts.mode, amount: opts.amount ?? null,
      ...(opts.entityType ? { entityType: opts.entityType, entityId: `${RUN}source` } : {}),
    });
    expect(r.ok, r.error).toBe(true);
    demandes.push(r.requestId!);
    return r.requestId!;
  }
  const etapes = (id: string) => prisma.validationStep.findMany({ where: { requestId: id }, orderBy: { order: "asc" }, select: { id: true, order: true, validatorId: true, status: true, reason: true } });
  const etapeDe = async (id: string, validatorId: string) => (await etapes(id)).find((e) => e.validatorId === validatorId)!.id;
  const etat = (id: string) => prisma.validationRequest.findUniqueOrThrow({ where: { id }, select: { status: true, version: true, currentOrder: true, description: true, amount: true } });

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
   * DEUX DÉCISIONS FORCÉES À SE CROISER (§118.164e) : le verrou SHARE sur les étapes arrête toute
   * écriture d'étape ; on relâche quand les deux gestes sont bloqués — chacun a lu avant que l'autre
   * n'écrive, s'il n'y a pas de verrou de la demande pour les mettre en file.
   */
  async function ensemble<T>(lancer: () => Promise<T>[]): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "ValidationStep" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, "Validation", gestes.length);
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : le tiers a le module des validations, sans la vue globale — un refus ne peut venir que de la règle de la demande", async () => {
    const hors = await acteur(horsId, "MEDICAL_DELEGATE");
    expect(userCan(hors, "VALIDATIONS", "VIEW"), "sans le module, le refus viendrait du module, pas de la demande").toBe(true);
    expect(hors.role).not.toBe("SUPER_ADMIN");
  });

  it("ACCÈS : la règle de la fiche est celle des pièces — demandeur et validateurs lisent, l'intérimaire aussi, le tiers non ; seul le demandeur joint", async () => {
    const id = await demande("Accès");
    const [dem, v1, hors, interim] = await Promise.all([
      acteur(demId, "MEDICAL_DELEGATE"), acteur(v1Id, "HEAD_OF_SALES"), acteur(horsId, "MEDICAL_DELEGATE"), acteur(interimId, "MEDICAL_DELEGATE"),
    ]);
    expect(await canAccessEntity(dem, "VALIDATION_REQUEST", id, "VIEW")).toBe(true);
    expect(await canAccessEntity(v1, "VALIDATION_REQUEST", id, "VIEW")).toBe(true);
    expect(await canAccessEntity(interim, "VALIDATION_REQUEST", id, "VIEW"), "il tranche l'étape de V2 : il lit ce qu'il tranche").toBe(true);
    expect(await canAccessEntity(hors, "VALIDATION_REQUEST", id, "VIEW"), "le module seul ouvrait la pièce d'un autre").toBe(false);
    expect(await canAccessEntity(dem, "VALIDATION_REQUEST", id, "UPDATE")).toBe(true);
    expect(await canAccessEntity(v1, "VALIDATION_REQUEST", id, "UPDATE"), "un validateur ne réécrit pas les pièces qu'on lui soumet").toBe(false);
  });

  it("MOTIF : renvoyer ou refuser sans dire pourquoi est refusé — valider ne demande rien", async () => {
    const id = await demande("Motif", { mode: "PARALLEL" });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    const sansMotif = await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "CHANGES_REQUESTED" }));
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.error).toMatch(/Indiquez le motif/);
    const refus = await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "REJECTED" }));
    expect(refus.ok).toBe(false);
    expect((await etat(id)).status, "rien n'a été écrit").toBe("PENDING");
    const accord = await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "APPROVED" }));
    expect(accord.ok, accord.error).toBe(true);
  });

  it("RENVOI PUIS RESOUMISSION (séquentiel) : la demande reprend À L'ÉTAPE QUI L'A RENVOYÉE, l'accord d'avant reste, le fil garde le motif", async () => {
    const id = await demande("Séquentiel", { mode: "SEQUENTIAL" });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    expect((await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "APPROVED" }))).ok).toBe(true);
    const depuis = new Date();
    ACTOR = await acteur(v2Id, "FINANCE_BUDGET_MANAGER");
    const renvoi = await decideValidation(fd({ stepId: await etapeDe(id, v2Id), decision: "CHANGES_REQUESTED", reason: "Joignez le devis signé." }));
    expect(renvoi.ok, renvoi.error).toBe(true);
    expect((await etat(id)).status).toBe("CHANGES_REQUESTED");
    const avis = await prisma.notification.findFirstOrThrow({ where: { userId: demId, createdAt: { gte: depuis } }, orderBy: { createdAt: "desc" } });
    expect(avis.body, "le motif voyage avec la décision").toContain("Joignez le devis signé.");
    expect(avis.link, "le lien mène à LA demande").toBe(`/validations/${id}`);

    // Une demande renvoyée ne se tranche plus tant qu'elle n'est pas resoumise.
    const encore = await decideValidation(fd({ stepId: await etapeDe(id, v2Id), decision: "APPROVED" }));
    expect(encore.ok).toBe(false);

    // Seul le demandeur resoumet, et il dit ce qu'il a corrigé.
    ACTOR = await acteur(horsId, "MEDICAL_DELEGATE");
    expect((await resoumettreValidation(fd({ id, note: "x" }))).ok).toBe(false);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const sansNote = await resoumettreValidation(fd({ id }));
    expect(sansNote.ok).toBe(false);
    const avant = new Date();
    const reprise = await resoumettreValidation(fd({ id, note: "Devis signé joint." }));
    expect(reprise.ok, reprise.error).toBe(true);
    const apres = await etat(id);
    expect(apres).toMatchObject({ status: "PENDING", version: 2, currentOrder: 2 });
    expect(apres.description, "ce que le formulaire ne porte pas ne s'écrit pas (§118.152c)").toBe("Texte d'origine");
    const [e1, e2] = await etapes(id);
    expect(e1.status, "l'accord d'avant reste acquis").toBe("APPROVED");
    expect(e2).toMatchObject({ status: "PENDING", reason: null });
    const fil = await prisma.comment.findMany({ where: { entityType: "VALIDATION_REQUEST", entityId: id } });
    expect(fil).toHaveLength(1);
    expect(fil[0].body).toContain("Joignez le devis signé.");
    expect(fil[0].body).toContain("Devis signé joint.");
    const prevenus = await prisma.notification.findMany({ where: { userId: { in: [v1Id, v2Id] }, createdAt: { gte: avant }, title: "Demande resoumise après correction" }, select: { userId: true } });
    expect(prevenus.map((p) => p.userId), "seule l'étape où le circuit reprend est prévenue").toEqual([v2Id]);

    ACTOR = await acteur(v2Id, "FINANCE_BUDGET_MANAGER");
    expect((await decideValidation(fd({ stepId: e2.id, decision: "APPROVED" }))).ok).toBe(true);
    expect((await etat(id)).status).toBe("APPROVED");
  });

  it("MONTANT RELEVÉ À LA RESOUMISSION : les accords déjà donnés repartent — une baisse, non", async () => {
    const id = await demande("Montant", { mode: "SEQUENTIAL", amount: 100_000 });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "APPROVED" }));
    ACTOR = await acteur(v2Id, "FINANCE_BUDGET_MANAGER");
    await decideValidation(fd({ stepId: await etapeDe(id, v2Id), decision: "CHANGES_REQUESTED", reason: "Montant incomplet." }));
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await resoumettreValidation(fd({ id, note: "Transport ajouté.", amount: "150000" }));
    expect(r.ok, r.error).toBe(true);
    const [e1, e2] = await etapes(id);
    expect([e1.status, e2.status], "un accord ne couvre pas plus que ce qu'il a vu").toEqual(["PENDING", "PENDING"]);
    expect((await etat(id)).currentOrder).toBe(1);

    const id2 = await demande("Montant baissé", { mode: "SEQUENTIAL", amount: 100_000 });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    await decideValidation(fd({ stepId: await etapeDe(id2, v1Id), decision: "APPROVED" }));
    ACTOR = await acteur(v2Id, "FINANCE_BUDGET_MANAGER");
    await decideValidation(fd({ stepId: await etapeDe(id2, v2Id), decision: "CHANGES_REQUESTED", reason: "Trop cher." }));
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    expect((await resoumettreValidation(fd({ id: id2, note: "Remise obtenue.", amount: "80000" }))).ok).toBe(true);
    expect((await etapes(id2)).map((e) => e.status)).toEqual(["APPROVED", "PENDING"]);
  });

  it("PARALLÈLE, deux accords à la même seconde : la demande est VALIDÉE — elle ne reste plus en attente pour toujours", async () => {
    const id = await demande("Parallèle", { mode: "PARALLEL" });
    const [a1, a2] = [await etapeDe(id, v1Id), await etapeDe(id, v2Id)];
    const [act1, act2] = [await acteur(v1Id, "HEAD_OF_SALES"), await acteur(v2Id, "FINANCE_BUDGET_MANAGER")];
    // Chaque geste lit SON acteur au moment de l'appel : `requireUser` est simulé par une variable
    // partagée, on lance donc chacun avec son acteur sous la main.
    const [r1, r2] = await ensemble(() => [
      (async () => { ACTOR = act1; return decideValidation(fd({ stepId: a1, decision: "APPROVED" })); })(),
      (async () => { ACTOR = act2; return decideValidation(fd({ stepId: a2, decision: "APPROVED" })); })(),
    ]);
    expect([r1.ok, r2.ok], JSON.stringify([r1, r2])).toEqual([true, true]);
    expect((await etat(id)).status, "avant : deux étapes validées, une demande en attente que plus personne ne pouvait trancher").toBe("APPROVED");
  });

  it("DOUBLE CLIC sur la dernière étape : une seule décision — la seconde trouve l'étape déjà traitée", async () => {
    const id = await demande("Double clic", { validateurs: [v1Id] });
    const etape = await etapeDe(id, v1Id);
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    const [r1, r2] = await ensemble(() => [
      decideValidation(fd({ stepId: etape, decision: "APPROVED" })),
      decideValidation(fd({ stepId: etape, decision: "APPROVED" })),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean), JSON.stringify([r1, r2])).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityType: "VALIDATION_REQUEST", entityId: id, action: "VALIDATE" } }), "avant : deux décisions, et deux ordres de dépense sur une pièce chiffrée").toBe(1);
  });

  it("DEUX RESOUMISSIONS à la même seconde : une seule version de plus — la seconde trouve la demande déjà repartie", async () => {
    const id = await demande("Double resoumission", { validateurs: [v1Id] });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    expect((await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "CHANGES_REQUESTED", reason: "Joindre le devis." }))).ok).toBe(true);
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    let gestes: Promise<{ ok: boolean; error?: string }>[] = [];
    // Le verrou SHARE sur les demandes arrête leur ÉCRITURE, pas le verrou de ligne qui la précède :
    // les deux resoumissions ont relu « à corriger » avant que l'une n'écrive.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "ValidationRequest" IN SHARE MODE`);
      gestes = [resoumettreValidation(fd({ id, note: "Devis joint." })), resoumettreValidation(fd({ id, note: "Devis joint (bis)." }))];
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, "ValidationRequest", 2);
    }, { timeout: 20_000 });
    const [r1, r2] = await Promise.all(gestes);
    expect([r1.ok, r2.ok].filter(Boolean), JSON.stringify([r1, r2])).toHaveLength(1);
    expect((await etat(id)).version, "une resoumission, une version").toBe(2);
    expect(await prisma.comment.count({ where: { entityType: "VALIDATION_REQUEST", entityId: id, body: { contains: "Resoumise après correction" } } }), "un seul passage au fil").toBe(1);
  });

  it("UNE DEMANDE NÉE D'UN AUTRE CIRCUIT se corrige là-bas : ni resoumise ni abandonnée d'ici", async () => {
    const id = await demande("Source", { entityType: "ADMIN_REQUEST", validateurs: [v1Id] });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "CHANGES_REQUESTED", reason: "Pièce illisible." }));
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await resoumettreValidation(fd({ id, note: "x" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/objet d'origine/);
    const a = await deleteMyValidationRequest(fd({ id }));
    expect(a.ok).toBe(false);
    expect((await etat(id)).status, "son circuit la clôt en la remplaçant").toBe("CHANGES_REQUESTED");
  });

  it("ABANDONNER UNE DEMANDE RENVOYÉE : close et visible, son historique intact — pas effacée", async () => {
    const id = await demande("Abandon", { validateurs: [v1Id] });
    ACTOR = await acteur(v1Id, "HEAD_OF_SALES");
    await decideValidation(fd({ stepId: await etapeDe(id, v1Id), decision: "CHANGES_REQUESTED", reason: "Mauvais exercice." }));
    ACTOR = await acteur(demId, "MEDICAL_DELEGATE");
    const r = await deleteMyValidationRequest(fd({ id }));
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.validationRequest.findUnique({ where: { id }, select: { status: true } });
    expect(apres?.status, "avant : « à corriger » pour toujours, ou effacée avec ce qu'un tiers avait dit").toBe("CANCELLED");
  });
});
