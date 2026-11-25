import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { trouverOuCreerEnveloppe } from "./enveloppe-unique";
import { createEnvelope } from "@/lib/actions/budget-envelope-actions";

/**
 * TROUVER, SINON CRÉER — contre la base : la même clé ne crée jamais deux enveloppes, même à cinq en même temps ; une
 * enveloppe ancienne sans code est ADOPTÉE ; une clé sans société adopte l'unique enveloppe de société (la règle du
 * doublon), jamais quand il y en a deux ; une création À LA MAIN sur une clé prise est refusée, en nommant l'enveloppe.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__uniq${Date.now().toString(36)}__`;
const ANNEE = 2032;
const societes: string[] = [];

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Une enveloppe par (société, direction, année) — trouver, sinon créer", () => {
  let saId = "";

  beforeAll(async () => {
    saId = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    for (const n of ["A", "B"]) societes.push((await prisma.company.create({ data: { name: `${TAG} Société ${n}` } })).id);
  });

  afterAll(async () => {
    const envs = await prisma.budgetEnvelope.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { companyId: { in: societes } }] }, select: { id: true } });
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs.map((e) => e.id) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [saId] } } }).catch(() => {});
  });

  it("cinq ouvertures simultanées de la même clé : UNE enveloppe, la même pour tous", async () => {
    const cle = { companyId: societes[0]!, annee: ANNEE, direction: "ADMINISTRATION" };
    const r = await Promise.all(Array.from({ length: 5 }, () => trouverOuCreerEnveloppe(cle, { name: `${TAG} Administration`, module: "ADMINISTRATION", domaine: "GENERAL" })));
    expect(new Set(r.map((x) => x.id)).size).toBe(1);
    expect(r.filter((x) => x.creee)).toHaveLength(1);
    expect(await prisma.budgetEnvelope.count({ where: { companyId: societes[0], module: "ADMINISTRATION", periodStart: new Date(Date.UTC(ANNEE, 0, 1)) } })).toBe(1);
    // Autre année, autre société : une autre enveloppe.
    expect((await trouverOuCreerEnveloppe({ ...cle, annee: ANNEE + 1 }, { name: `${TAG} Administration+1` })).creee).toBe(true);
    expect((await trouverOuCreerEnveloppe({ ...cle, companyId: societes[1]! }, { name: `${TAG} Administration B` })).creee).toBe(true);
  });

  it("une enveloppe ANCIENNE sans code, reconnue à sa ligne, est adoptée et reçoit le code — pas doublée", async () => {
    const vieille = await prisma.budgetEnvelope.create({ data: { name: `${TAG} Informatique`, companyId: societes[0], periodStart: new Date(Date.UTC(ANNEE, 0, 1)), periodEnd: new Date(Date.UTC(ANNEE, 11, 31)) } });
    await prisma.budgetCategoryLine.create({ data: { envelopeId: vieille.id, name: "IA", cle: "IA_CONSOMMATION" } });
    const r = await trouverOuCreerEnveloppe(
      { companyId: societes[0]!, annee: ANNEE, direction: "INFORMATIQUE" },
      { name: `${TAG} Informatique (neuve)` },
      { reconnaitre: { companyId: societes[0], categories: { some: { cle: "IA_CONSOMMATION" } } } },
    );
    expect(r).toMatchObject({ id: vieille.id, creee: false });
    expect((await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: vieille.id } })).module).toBe("INFORMATIQUE");
  });

  it("LA RÈGLE DU DOUBLON : sans société, on adopte l'unique enveloppe de société du pôle — jamais quand il y en a deux", async () => {
    const annee = ANNEE + 2;
    const opsA = await trouverOuCreerEnveloppe({ companyId: societes[0]!, annee, direction: "OPERATIONS" }, { name: `${TAG} Operations & Sales`, domaine: "OPERATIONS" });
    const sans = await trouverOuCreerEnveloppe({ companyId: null, annee, direction: "OPERATIONS" }, { name: `${TAG} Operations & Sales`, domaine: "OPERATIONS" });
    expect(sans).toMatchObject({ id: opsA.id, creee: false });
    // La même clé AVEC société retrouve aussi la sienne.
    expect((await trouverOuCreerEnveloppe({ companyId: societes[0]!, annee, direction: "OPERATIONS" }, { name: "x", domaine: "OPERATIONS" })).id).toBe(opsA.id);
    // Deux sociétés : on ne devine pas — une enveloppe du groupe naît.
    await trouverOuCreerEnveloppe({ companyId: societes[1]!, annee, direction: "OPERATIONS" }, { name: `${TAG} Operations & Sales B`, domaine: "OPERATIONS" });
    const groupe = await trouverOuCreerEnveloppe({ companyId: null, annee: annee, direction: "MARKETING" }, { name: `${TAG} Marketing groupe`, domaine: "MARKETING" });
    expect(groupe.creee).toBe(true);
    const ambigu = await prisma.budgetEnvelope.count({ where: { domaine: "OPERATIONS", periodStart: new Date(Date.UTC(annee, 0, 1)), companyId: { in: societes } } });
    expect(ambigu).toBe(2);
    const r = await trouverOuCreerEnveloppe({ companyId: null, annee, direction: "OPERATIONS" }, { name: `${TAG} Operations groupe`, domaine: "OPERATIONS" });
    expect(r.creee).toBe(true);
    expect([opsA.id]).not.toContain(r.id);
  });

  it("à la main : la seconde enveloppe d'une même clé est REFUSÉE en nommant celle qui existe ; une enveloppe libre passe", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const fd = (nom: string, module?: string) => {
      const f = new FormData();
      f.set("name", nom);
      f.set("periodStart", `${ANNEE + 3}-01-01`);
      f.set("periodEnd", `${ANNEE + 3}-12-31`);
      if (module) f.set("modules", module);
      return f;
    };
    const premiere = await createEnvelope(fd(`${TAG} Sponsoring`, "SPONSORING"));
    expect(premiere.ok, premiere.error).toBe(true);
    const seconde = await createEnvelope(fd(`${TAG} Sponsoring bis`, "SPONSORING"));
    expect(seconde.ok).toBe(false);
    expect(seconde.error).toContain(`${TAG} Sponsoring`);
    expect(await prisma.budgetEnvelope.count({ where: { name: { startsWith: `${TAG} Sponsoring` } } })).toBe(1);
    // Sans module, l'enveloppe est libre : rien à dédoublonner.
    expect((await createEnvelope(fd(`${TAG} Libre 1`))).ok).toBe(true);
    expect((await createEnvelope(fd(`${TAG} Libre 2`))).ok).toBe(true);
  });
});
