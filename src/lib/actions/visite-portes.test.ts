import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { logVisit, createVisit, updateVisit } from "./medical-actions";
import { fdDate } from "./types";
import { refusVisiteHorsDelai } from "@/lib/sfe/tournee";
import { produitsDeLaBu, refusProduitsHorsBu } from "@/lib/sfe/produits-bu";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__visportes__";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v);
  }
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PORTES D'UNE VISITE FAITE — une seule règle, quelle que soit la porte (§118.177).
 *
 * Trois portes enregistraient une visite faite : le rapport d'une visite planifiée et la visite
 * imprévue appliquaient la fenêtre de 48 h et les produits de la Business Unit ; la saisie rapide
 * de « Ma journée » (que `log_visit` d'Adam appelle telle quelle) n'appliquait ni l'une ni l'autre.
 * Et une quatrième porte s'ouvrait à côté : la PLANIFICATION, qui acceptait le statut « réalisée »
 * à la création comme à la modification — une visite faite sans rapport, sans fenêtre, sans gamme.
 *
 * Joué par les VRAIES actions, avec un délégué sans vue globale (§118.104). Chaque refus est
 * comparé à la phrase que la garde PRODUIT, pas à un mot de vocabulaire qui pourrait se trouver
 * ailleurs (§118.22, §118.120).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Visite faite — la fenêtre de 48 h et la gamme tiennent à TOUTES les portes", () => {
  const ids: Record<string, string> = {};
  let dansGamme = "", horsGamme = "", docKam = "", docSansBu = "";

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    if (uids.length) {
      const visites = await prisma.medicalVisit.findMany({ where: { delegateId: { in: uids } }, select: { id: true } });
      await prisma.fieldReport.deleteMany({ where: { visitId: { in: visites.map((v) => v.id) } } });
      await prisma.medicalVisit.deleteMany({ where: { id: { in: visites.map((v) => v.id) } } });
    }
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    if (uids.length) await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, sansBu] = await Promise.all([faire("kam", "MEDICAL_DELEGATE"), faire("sansbu", "MEDICAL_DELEGATE")]);
    Object.assign(ids, { kam: kam.id, sansBu: sansBu.id });

    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie` }, select: { id: true } });
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });
    const [pIn, pOut] = await Promise.all([
      prisma.product.create({ data: { code: `${TAG}P1`, canonicalName: `${TAG}Nivolex`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivo` } as never, select: { id: true } }),
      prisma.product.create({ data: { code: `${TAG}P2`, canonicalName: `${TAG}Cardiox`, dci: `${TAG}cardio`, identityKey: `${TAG}cardio` } as never, select: { id: true } }),
    ]);
    dansGamme = pIn.id; horsGamme = pOut.id;
    await prisma.promoProduct.create({ data: { name: `${TAG}Nivolex`, businessUnitId: bu.id, productId: pIn.id } });
    const [d1, d2] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: kam.id } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Benali`, delegateId: sansBu.id } }),
    ]);
    docKam = d1.id; docSansBu = d2.id;
  });

  afterAll(async () => { ACTOR = null; await nettoyer(); });

  const visitesDe = (doctorId: string) => prisma.medicalVisit.count({ where: { doctorId } });

  it("« Ma journée » refuse une visite datée hors de la fenêtre de 48 h — et n'écrit rien", async () => {
    ACTOR = await actorFor(ids.kam!);
    const il_y_a_trois_jours = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const avant = await visitesDe(docKam);
    const fd = form({ doctorId: docKam, date: il_y_a_trois_jours });
    const r = await logVisit(undefined, fd);
    expect(r.ok).toBe(false);
    // La phrase EXACTE de la garde, pour la date que l'action a lue.
    expect(r.ok ? null : r.error).toBe(refusVisiteHorsDelai(fdDate(fd, "date")!));
    expect(await visitesDe(docKam)).toBe(avant);
  });

  it("« Ma journée » refuse un produit hors de la gamme — et n'écrit rien", async () => {
    ACTOR = await actorFor(ids.kam!);
    const avant = await visitesDe(docKam);
    const r = await logVisit(undefined, form({ doctorId: docKam, productId: [horsGamme] }));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error).toBe(refusProduitsHorsBu(1, await produitsDeLaBu(ids.kam!), "vous"));
    expect(await visitesDe(docKam)).toBe(avant);
  });

  it("sans Business Unit, le refus nomme le RATTACHEMENT, pas un autre clic dans la liste", async () => {
    ACTOR = await actorFor(ids.sansBu!);
    const gamme = await produitsDeLaBu(ids.sansBu!);
    // PRÉMISSE : ce délégué n'a aucune gamme.
    expect(gamme.rattache).toBe(false);
    const r = await logVisit(undefined, form({ doctorId: docSansBu, productId: [dansGamme] }));
    expect(r.ok ? null : r.error).toBe(refusProduitsHorsBu(1, gamme, "vous"));
    expect(r.ok ? null : r.error).toMatch(/Business Units/);
  });

  it("le témoin : dans la fenêtre et dans la gamme, la visite part, terminée, avec son produit lié", async () => {
    ACTOR = await actorFor(ids.kam!);
    const r = await logVisit(undefined, form({ doctorId: docKam, productId: [dansGamme] }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const v = await prisma.medicalVisit.findFirstOrThrow({ where: { doctorId: docKam }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, productLinks: { select: { productId: true } } } });
    expect(v.status).toBe("COMPLETED");
    expect(v.productLinks.map((p) => p.productId)).toEqual([dansGamme]);
  });

  it("la PLANIFICATION ne crée pas une visite « réalisée » — elle planifie", async () => {
    ACTOR = await actorFor(ids.kam!);
    const avant = await prisma.medicalVisit.count({ where: { doctorId: docKam, status: "COMPLETED" } });
    const r = await createVisit(undefined, form({ doctorId: docKam, status: "COMPLETED" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error).toMatch(/s'enregistre depuis « Ma journée »/);
    expect(await prisma.medicalVisit.count({ where: { doctorId: docKam, status: "COMPLETED" } })).toBe(avant);
    // Le témoin : une visite PLANIFIÉE se crée.
    const ok = await createVisit(undefined, form({ doctorId: docKam, status: "PLANNED" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
  });

  it("la modification ne passe pas une visite à « réalisée », et ne retouche pas une visite rapportée", async () => {
    ACTOR = await actorFor(ids.kam!);
    const planifiee = await prisma.medicalVisit.findFirstOrThrow({ where: { doctorId: docKam, status: "PLANNED" }, select: { id: true } });
    const faite = await prisma.medicalVisit.findFirstOrThrow({ where: { doctorId: docKam, status: "COMPLETED" }, select: { id: true } });

    const r1 = await updateVisit(form({ id: planifiee.id, status: "COMPLETED" }));
    expect(r1.ok).toBe(false);
    expect(r1.ok ? null : r1.error).toMatch(/s'enregistre depuis « Ma journée »/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: planifiee.id } })).status).toBe("PLANNED");

    const r2 = await updateVisit(form({ id: faite.id, notes: "retouche" }));
    expect(r2.ok).toBe(false);
    expect(r2.ok ? null : r2.error).toMatch(/déjà rapportée/);

    // REPORTÉE OU ANNULÉE SE DIT PAR SA PORTE (§118.193) : `direVisiteNonTenue` tient le motif et la fenêtre de 48 h.
    // Ici, rien ne les tiendrait — dire « annulée » une semaine après effacerait une visite perdue du taux.
    const r3 = await updateVisit(form({ id: planifiee.id, status: "POSTPONED" }));
    expect(r3.ok).toBe(false);
    expect(r3.ok ? null : r3.error).toMatch(/depuis « Ma journée »/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: planifiee.id } })).status).toBe("PLANNED");
    // Le témoin : planifier (l'objectif d'une visite hors plan) reste possible ici.
    const r4 = await updateVisit(form({ id: planifiee.id, objective: "Présenter la nouvelle étude" }));
    expect(r4.ok, r4.ok ? "" : r4.error).toBe(true);
  });
});
