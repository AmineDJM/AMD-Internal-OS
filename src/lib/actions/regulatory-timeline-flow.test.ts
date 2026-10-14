import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  startDossierTimeline, addDossierStep, updateDossierStep, deleteDossierStep,
} from "./regulatory-timeline-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__frisetest__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * LA FRISE DEPUIS LA VRAIE PORTE — les actions que l'écran appelle, pas un état injecté.
 *
 * Ce qui doit être prouvé ici n'est pas « la ligne s'écrit » : c'est que l'HISTOIRE reste
 * lisible — la frise s'ouvre sur « Réserves ANPP 1 » (le CTD initial, lui, se dépose sur
 * l'étape 1 du processus), les insertions tombent à la bonne place, et rien n'efface des
 * documents en silence. Les frises HISTORIQUES ouvertes par un CTD initial restent protégées.
 */
suite("Regulatory — frise du dossier : Réserves ANPP 1, insertion à la place voulue, journal", () => {
  let productId = "", regId = "", viewerId = "", initialStepId = "";

  beforeAll(async () => {
    const [reg, viewer] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}reg`, email: `${TAG}reg@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}viewer`, email: `${TAG}viewer@t.dz`, role: "VIEWER", passwordHash: "x" } }),
    ]);
    regId = reg.id; viewerId = viewer.id;
    const p = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-001`, dci: `${TAG} Bictegravir`, status: "PRE_SUBMISSION" },
    });
    productId = p.id;
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { entityType: "REGULATORY_PRODUCT", entityId: productId } }).catch(() => {});
    await prisma.regulatoryDossierStep.deleteMany({ where: { productId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: productId } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("la frise s'ouvre sur « Réserves ANPP 1 » — et l'ouvrir DEUX FOIS n'en crée pas deux", async () => {
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData(); fd.set("productId", productId);
    const first = await startDossierTimeline(fd);
    expect(first.ok).toBe(true);
    initialStepId = first.id!;

    // Second clic (ou second onglet) : une frise déjà ouverte n'est pas rouverte.
    const second = await startDossierTimeline(fd);
    expect(second.ok).toBe(true);
    expect(second.id).toBe(initialStepId);

    const steps = await prisma.regulatoryDossierStep.findMany({ where: { productId } });
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("ANPP_RESERVES");
    expect(steps[0].label).toBe("Réserves ANPP 1");
    expect(steps[0].order).toBe(0);
  });

  it("ajouter des réserves puis une réponse : la frise se déroule dans l'ordre", async () => {
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const res = new FormData();
    res.set("productId", productId); res.set("kind", "ANPP_RESERVES");
    res.set("label", "Réserves du 12/03"); res.set("occurredAt", "2026-03-12");
    const r1 = await addDossierStep(undefined, res);
    expect(r1.ok).toBe(true);

    const rep = new FormData();
    rep.set("productId", productId); rep.set("kind", "ANPP_RESPONSE"); rep.set("label", "Réponse du labo");
    const r2 = await addDossierStep(undefined, rep);
    expect(r2.ok).toBe(true);

    const steps = await prisma.regulatoryDossierStep.findMany({ where: { productId }, orderBy: { order: "asc" } });
    expect(steps.map((s) => s.kind)).toEqual(["ANPP_RESERVES", "ANPP_RESERVES", "ANPP_RESPONSE"]);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(steps[1].occurredAt?.toISOString().slice(0, 10)).toBe("2026-03-12");
  });

  it("le « + » sous une étape insère À CET ENDROIT — les suivantes se décalent", async () => {
    const before = await prisma.regulatoryDossierStep.findMany({ where: { productId }, orderBy: { order: "asc" } });
    const reserves = before.find((s) => s.label === "Réserves du 12/03")!;

    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData();
    fd.set("productId", productId); fd.set("kind", "OTHER");
    fd.set("label", "Réunion ANPP intermédiaire"); fd.set("afterId", reserves.id);
    expect((await addDossierStep(undefined, fd)).ok).toBe(true);

    const after = await prisma.regulatoryDossierStep.findMany({ where: { productId }, orderBy: { order: "asc" } });
    expect(after.map((s) => s.label)).toEqual([
      "Réserves ANPP 1", "Réserves du 12/03", "Réunion ANPP intermédiaire", "Réponse du labo",
    ]);
    // Les rangs restent contigus : une frise trouée se relit mal.
    expect(after.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it("une version du CTD sans numéro est refusée ; avec son numéro, elle porte la version", async () => {
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const sans = new FormData();
    sans.set("productId", productId); sans.set("kind", "CTD_VERSION"); sans.set("label", "CTD v2");
    const ko = await addDossierStep(undefined, sans);
    expect(ko.ok).toBe(false);
    expect(ko.error).toMatch(/numéro de version/i);

    const avec = new FormData();
    avec.set("productId", productId); avec.set("kind", "CTD_VERSION");
    avec.set("label", "CTD v2 — module 3 revu"); avec.set("version", "2");
    const ok = await addDossierStep(undefined, avec);
    expect(ok.ok).toBe(true);
    const v = await prisma.regulatoryDossierStep.findUniqueOrThrow({ where: { id: ok.id! } });
    expect(v.version).toBe(2);
    expect(v.kind).toBe("CTD_VERSION");
  });

  it("le CTD initial ne s'ajoute pas une seconde fois par le formulaire", async () => {
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData();
    fd.set("productId", productId); fd.set("kind", "CTD_INITIAL"); fd.set("label", "Encore le CTD");
    const r = await addDossierStep(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/étape 1/i);
  });

  it("une étape se renomme, et l'ANCIEN nom reste au journal", async () => {
    const step = await prisma.regulatoryDossierStep.findFirstOrThrow({
      where: { productId, label: "Réunion ANPP intermédiaire" },
    });
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData();
    fd.set("id", step.id); fd.set("label", "Réunion ANPP du 20/03");
    expect((await updateDossierStep(fd)).ok).toBe(true);

    expect((await prisma.regulatoryDossierStep.findUniqueOrThrow({ where: { id: step.id } })).label)
      .toBe("Réunion ANPP du 20/03");
    // On filtre par ENTITÉ (indexée) puis on cherche en mémoire : un `contains` sur le résumé
    // balaierait tout le journal de la base, qui grossit sans cesse.
    const logs = await prisma.auditLog.findMany({
      where: { entityId: productId, action: "UPDATE" }, orderBy: { createdAt: "desc" }, take: 20,
    });
    const log = logs.find((l) => (l.summary ?? "").includes("renommée"));
    expect(log?.summary).toContain("Réunion ANPP intermédiaire");
    expect(log?.summary).toContain("Réunion ANPP du 20/03");
  }, 30_000);

  it("une étape qui PORTE une pièce ne se supprime pas — on ne jette pas un document en silence", async () => {
    const step = await prisma.regulatoryDossierStep.findFirstOrThrow({ where: { productId, label: "Réserves du 12/03" } });
    await prisma.document.create({
      data: {
        name: `${TAG}lettre-reserves.pdf`, category: "QUERY_RECEIVED",
        entityType: "REGULATORY_PRODUCT", entityId: productId, stepKey: step.id,
        confidentiality: "INTERNAL", uploadedById: regId,
      },
    });

    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData(); fd.set("id", step.id);
    const r = await deleteDossierStep(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1 pièce/);
    expect(await prisma.regulatoryDossierStep.findUnique({ where: { id: step.id } })).not.toBeNull();
  });

  it("une frise HISTORIQUE garde son origine : le CTD initial ne se supprime pas, la base en refuse un second", async () => {
    // Les frises ouvertes AVANT la bascule vers « Réserves ANPP 1 » commencent par un
    // CTD_INITIAL : on ne réécrit pas leur histoire — il ne se supprime pas, et l'index
    // unique partiel refuse toujours d'en créer deux.
    const historique = await prisma.regulatoryDossierStep.create({
      data: { productId, kind: "CTD_INITIAL", label: "CTD initial (historique)", order: 90 },
    });
    await expect(prisma.regulatoryDossierStep.create({
      data: { productId, kind: "CTD_INITIAL", label: "Deuxième origine", order: 91 },
    })).rejects.toThrow();

    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const fd = new FormData(); fd.set("id", historique.id);
    const r = await deleteDossierStep(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/origine historique/i);
    // Nettoyage direct : la ligne « historique » ne doit pas polluer les tests suivants.
    await prisma.regulatoryDossierStep.delete({ where: { id: historique.id } });
  });

  it("une étape vide créée par erreur s'efface, et la suppression est JOURNALISÉE", async () => {
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
    const add = new FormData();
    add.set("productId", productId); add.set("kind", "OTHER"); add.set("label", "Erreur de saisie");
    const created = await addDossierStep(undefined, add);
    expect(created.ok).toBe(true);

    const del = new FormData(); del.set("id", created.id!);
    expect((await deleteDossierStep(del)).ok).toBe(true);
    expect(await prisma.regulatoryDossierStep.findUnique({ where: { id: created.id! } })).toBeNull();

    const logs = await prisma.auditLog.findMany({
      where: { entityId: productId, action: "DELETE" }, orderBy: { createdAt: "desc" }, take: 20,
    });
    expect(logs.some((l) => (l.summary ?? "").includes("Erreur de saisie"))).toBe(true);
  }, 30_000);

  it("un compte SANS droit d'écriture Regulatory ne touche pas la frise", async () => {
    ACTOR = await actorFor(viewerId, "VIEWER");
    const fd = new FormData();
    fd.set("productId", productId); fd.set("kind", "ANPP_RESERVES"); fd.set("label", "Tentative");
    const r = await addDossierStep(undefined, fd);
    expect(r.ok).toBe(false);
  });

  it("chaque ajout a laissé sa trace au journal, avec le type et le nom", async () => {
    const all = await prisma.auditLog.findMany({
      where: { entityId: productId, action: "CREATE" }, orderBy: { createdAt: "asc" }, take: 50,
    });
    const logs = all.filter((l) => (l.summary ?? "").includes("Frise"));
    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs.some((l) => (l.summary ?? "").includes("Réserves ANPP 1"))).toBe(true);
    expect(logs.some((l) => (l.summary ?? "").includes("Réserves ANPP — Réserves du 12/03"))).toBe(true);
    expect(logs.some((l) => (l.summary ?? "").includes("Version du CTD v2"))).toBe(true);
  }, 30_000);
});
