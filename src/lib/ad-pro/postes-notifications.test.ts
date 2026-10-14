import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { addAdProItem, submitAdProItem, decideAdProItem } from "@/lib/actions/ad-pro-item-actions";
import { getActionCenter } from "@/lib/queries/action-center";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__postenotif__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const DEBUT = new Date(Date.now() - 1_000);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (c: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(c)) f.set(k, v); return f; };

/**
 * LA DIRECTION MARKETING DÉCIDE LES POSTES D'UN CONGRÈS, ELLE DOIT EN ÊTRE PRÉVENUE (§118.200).
 * Rapporté par elle : un billet d'avion ajouté hors budget au « Congrès de Batna » est resté bloqué
 * à son niveau, faute de notification — la liste écrite à la main ne la nommait que sur le sponsoring.
 * Le juge compte par le LIEN CAUSAL (la notification mène à CE congrès), jamais par le voisinage.
 */
suite("Postes Ad & Pro — ceux qui décident sont prévenus (validation et lecture)", () => {
  const u: Record<string, string> = {};
  let congres = "";
  const recues = (type: "GENERIC" | "VALIDATION_REQUIRED", qui: "dm" | "ops" = "dm") => prisma.notification.count({
    where: { userId: u[qui], type, link: { contains: congres }, createdAt: { gte: DEBUT } },
  });

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("dm", "PRODUCT_MANAGER");
    // LA DIRECTION DES OPÉRATIONS tient le PREMIER temps de la validation (§118.204).
    await mk("ops", "DIRECTION");
    congres = (await prisma.congressNational.create({ data: { name: `${RUN} Congrès de Batna`, requesterId: u.kam } })).id;
  });
  afterAll(nettoyer);

  async function nettoyer() {
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  it("PRÉMISSE : la Direction Marketing décide les postes d'un congrès national", async () => {
    expect(userCan(await acteur(u.dm, "PRODUCT_MANAGER"), "CONGRESS_NATIONAL", "VALIDATE")).toBe(true);
  });

  it("un poste inclus, avant la décision, ne dérange personne (témoin)", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, label: `${RUN} Stand`, kind: "OTHER", amountEstimated: "30000" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await recues("GENERIC")).toBe(0);
  });

  it("un poste HORS BUDGET est dit en lecture, et sa soumission demande la validation", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, label: `${RUN} Billet d'avion`, kind: "TICKETING", amountEstimated: "45000", budgetKind: "ADDITIONAL" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await recues("GENERIC")).toBe(1);
    // UNE BILLETTERIE SE SOUMET AVEC AU MOINS UN VOYAGEUR (Direction, 06/10).
    await prisma.adProVoyageur.create({ data: { itemId: r.ok ? r.id! : "", nom: "Haddad", prenom: "Amel" } });
    const s = await submitAdProItem(undefined, fd({ id: r.ok ? r.id! : "" }));
    expect(s.ok, JSON.stringify(s)).toBe(true);
    // DEUX TEMPS (§118.204) : la soumission demande la validation à la Direction des opérations — la
    // Direction Marketing n'est pas encore sollicitée (elle sait le poste ajouté, en lecture).
    expect(await recues("VALIDATION_REQUIRED", "ops"), "la Direction des opérations est sollicitée").toBe(1);
    expect(await recues("VALIDATION_REQUIRED"), "la Direction Marketing pas encore").toBe(0);
    const cle = `poste-${r.ok ? r.id! : ""}`;
    const file = async (k: "dm" | "ops" | "kam", role: SessionUser["role"]) =>
      (await getActionCenter(await acteur(u[k], role) as unknown as SessionUser)).items;
    expect((await file("ops", "DIRECTION")).find((i) => i.key === cle)?.href, "la Direction des opérations voit le poste à valider").toBe(`/congress-national/${congres}`);
    expect((await file("dm", "PRODUCT_MANAGER")).some((i) => i.key === cle), "la Direction Marketing ne voit pas un temps qui n'est pas le sien").toBe(false);
    expect((await file("kam", "MEDICAL_DELEGATE")).some((i) => i.key === cle), "le demandeur ne le décide pas").toBe(false);

    // Le premier temps validé : c'est AU TOUR de la Direction Marketing — prévenue, et sa file le porte.
    ACTOR = await acteur(u.ops, "DIRECTION");
    const v = await decideAdProItem(undefined, fd({ id: r.ok ? r.id! : "", decision: "APPROVED" }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(await recues("VALIDATION_REQUIRED"), "la Direction Marketing est sollicitée").toBe(1);
    expect((await file("dm", "PRODUCT_MANAGER")).find((i) => i.key === cle)?.href, "la Direction Marketing voit le poste à décider").toBe(`/congress-national/${congres}`);
    expect((await file("ops", "DIRECTION")).some((i) => i.key === cle), "la Direction des opérations n'a plus rien à faire").toBe(false);
  });
});
