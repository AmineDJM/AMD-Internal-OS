import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { addAdProItem, submitAdProItem } from "../actions-postes";
import { decideAdProItem } from "../actions-postes-decision";
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
 *
 * Depuis le 27/10/2026 : les postes ne s'ajoutent qu'APRÈS la prévalidation (requestStatus APPROVED,
 * sans montant), et UN SEUL temps les accepte — la Direction Marketing. La Direction des opérations
 * (le Directeur des opérations a déjà validé la DEMANDE) n'est plus sollicitée poste par poste.
 */
suite("Postes Ad & Pro — ceux qui décident sont prévenus (validation et lecture)", () => {
  const u: Record<string, string> = {};
  let congres = "", brouillon = "";
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
    // LA DIRECTION DES OPÉRATIONS ne tient plus de temps sur les postes (27/10/2026) : le témoin qu'on ne la dérange pas.
    await mk("ops", "DIRECTION");
    // PRÉVALIDÉ (N+1, Directeur des opérations, Direction Marketing) : les postes peuvent s'ajouter. Aucun montant écrit.
    congres = (await prisma.congressNational.create({ data: { name: `${RUN} Congrès de Batna`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    // Encore dans le circuit : aucun poste ne s'y ajoute.
    brouillon = (await prisma.congressNational.create({ data: { name: `${RUN} Congrès de Sétif`, requesterId: u.kam } })).id;
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

  it("AVANT LA PRÉVALIDATION, aucun poste ne s'ajoute — et personne n'est dérangé", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: brouillon, label: `${RUN} Stand`, kind: "OTHER", amountEstimated: "30000", budgetKind: "ADDITIONAL" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/^Les postes s'ajoutent après la prévalidation de la Direction Marketing/);
    expect(await prisma.adProItem.count({ where: { congressNationalId: brouillon } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: { in: [u.dm, u.ops] }, link: { contains: brouillon }, createdAt: { gte: DEBUT } } })).toBe(0);
  });

  it("un poste inclus, après la prévalidation, ne dérange personne (témoin) — il n'est pas « ajouté après la décision »", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, label: `${RUN} Stand`, kind: "OTHER", amountEstimated: "30000" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await recues("GENERIC")).toBe(0);
    expect(await recues("GENERIC", "ops")).toBe(0);
    // La prévalidation n'écrit aucun montant : préparer ses postes est l'étape même, pas un ajout tardif.
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" } })).addedAfterDecision).toBe(false);
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
    // UN SEUL TEMPS (27/10/2026) : la soumission va DROIT à la Direction Marketing — la Direction des
    // opérations n'est pas sollicitée.
    expect(await recues("VALIDATION_REQUIRED"), "la Direction Marketing est sollicitée").toBe(1);
    expect(await recues("VALIDATION_REQUIRED", "ops"), "la Direction des opérations ne l'est plus").toBe(0);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" } })).opsDecidedAt, "l'ancien premier temps est franchi d'office, tracé").not.toBeNull();
    const cle = `poste-${r.ok ? r.id! : ""}`;
    const file = async (k: "dm" | "ops" | "kam", role: SessionUser["role"]) =>
      (await getActionCenter(await acteur(u[k], role) as unknown as SessionUser)).items;
    const ligne = (await file("dm", "PRODUCT_MANAGER")).find((i) => i.key === cle);
    expect(ligne?.href, "la Direction Marketing voit le poste à décider").toBe(`/congress-national/${congres}`);
    // La ligne ne prétend pas qu'une Direction des opérations l'a validé : `opsDecidedAt` est posé d'office.
    expect(ligne?.subtitle).toMatch(/^hors budget · poste à accepter — montant et budget à décider/);
    expect(ligne?.subtitle).not.toMatch(/Direction des opérations/);
    expect((await file("ops", "DIRECTION")).some((i) => i.key === cle), "la Direction des opérations n'a rien à faire").toBe(false);
    expect((await file("kam", "MEDICAL_DELEGATE")).some((i) => i.key === cle), "le demandeur ne le décide pas").toBe(false);

    // La Direction des opérations ne tranche pas un poste : son geste est refusé, et rien ne bouge.
    ACTOR = await acteur(u.ops, "DIRECTION");
    const v = await decideAdProItem(undefined, fd({ id: r.ok ? r.id! : "", decision: "APPROVED" }));
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.error).toBe("Ce poste attend la décision de la Direction Marketing (montant et budget).");
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" } })).status).toBe("PENDING");
  });
});
