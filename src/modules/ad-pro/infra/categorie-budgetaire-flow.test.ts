import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { addAdProItem, submitAdProItem, setAdProItemBudget } from "../actions-postes";
import { decideAdProItem } from "../actions-postes-decision";
import { refusCategoriePourLaDemande } from "./categorie-budgetaire-serveur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CATÉGORIE BUDGÉTAIRE CONVIENT À LA DEMANDE — par les VRAIS points d'entrée (point 9, 27/10).
 *
 * « Seule son existence est vérifiée » : la Direction Marketing pouvait accorder un poste d'événement sur la
 * catégorie des PEC, sur l'enveloppe de l'an passé, sur le budget d'une autre gamme. Le serveur refuse les trois,
 * en le disant ; la bonne catégorie passe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__catbud__";
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

suite("Ad & Pro — la catégorie budgétaire doit convenir à la nature, à l'exercice et à la gamme de la demande", () => {
  let kamId = "", pmId = "", opsId = "", eventId = "", congresId = "", buA = "", buB = "";
  const cat: Record<string, string> = {};
  const annee = new Date().getUTCFullYear();

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    const [kam, pm, ops] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("pm", "PRODUCT_MANAGER"), mk("ops", "DIRECTION")]);
    kamId = kam.id; pmId = pm.id; opsId = ops.id;
    buA = (await prisma.businessUnit.create({ data: { name: `${RUN}Cardiologie` } })).id;
    buB = (await prisma.businessUnit.create({ data: { name: `${RUN}Oncologie` } })).id;
    eventId = (await prisma.event.create({
      data: { name: `${TAG}Journée cardiologie`, requesterId: kamId, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date(`${annee}-12-04`), businessUnitId: buA },
      select: { id: true },
    })).id;
    congresId = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès national`, requesterId: kamId, requestStatus: "APPROVED", businessUnitId: buA }, select: { id: true } })).id;

    const enveloppe = async (nom: string, debut: string, fin: string, businessUnitId: string | null = null) => (await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}${nom}`, domaine: "MARKETING", modules: ["SPONSORING", "EVENTS", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"],
        totalAmount: 10_000_000, periodStart: new Date(debut), periodEnd: new Date(fin), businessUnitId,
      },
      select: { id: true },
    })).id;
    const courante = await enveloppe("Courante", `${annee}-01-01`, `${annee}-12-31`);
    const passee = await enveloppe("Passée", `${annee - 1}-01-01`, `${annee - 1}-12-31`);
    const autreGamme = await enveloppe("Oncologie", `${annee}-01-01`, `${annee}-12-31`, buB);
    const ligne = async (envelopeId: string, nom: string, module: string) =>
      (await prisma.budgetCategoryLine.create({ data: { envelopeId, name: `${TAG}${nom}`, module, allocated: 2_000_000 }, select: { id: true } })).id;
    cat.evenements = await ligne(courante, "Événements", "EVENTS");
    cat.pecNationales = await ligne(courante, "Congrès nationaux", "CONGRESS_NATIONAL");
    cat.evenementsPasses = await ligne(passee, "Événements", "EVENTS");
    cat.evenementsOnco = await ligne(autreGamme, "Événements", "EVENTS");
  });

  afterAll(async () => {
    const comptes = [kamId, pmId, opsId].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({ where: { eventId }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [eventId, congresId, ...postes] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: congresId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

  /** Un poste d'événement décrit, soumis, validé par la Direction des opérations : il attend la Direction Marketing. */
  async function posteAuSecondTemps(label: string): Promise<string> {
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const a = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind: "PRINTING", label: `${TAG}${label}`, amountEstimated: "300000", supplier: "Imprimerie Alpha" }));
    ok(a);
    ok(await submitAdProItem(undefined, fd({ id: a.id! })));
    // UN SEUL TEMPS depuis le 27/10/2026 : soumis, le poste attend la Direction Marketing.
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    return a.id!;
  }

  it("LE TEST DE LA DIRECTION : la catégorie « Événements » sur une PEC nationale est refusée", async () => {
    const refus = await refusCategoriePourLaDemande(cat.evenements, "CONGRESS_NATIONAL", congresId);
    expect(refus).toMatch(/réservée aux dépenses « Événements »/);
    expect(refus).toMatch(/prise en charge nationale/);
    // Le témoin : la catégorie des PEC nationales lui convient.
    expect(await refusCategoriePourLaDemande(cat.pecNationales, "CONGRESS_NATIONAL", congresId)).toBeNull();
  });

  it("accorder un poste : nature, exercice et gamme refusés en le disant — la bonne catégorie passe", async () => {
    const id = await posteAuSecondTemps("Brochures");
    const accorder = (budgetCategoryId: string) => decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "300000", budgetCategoryId }));

    const nature = await accorder(cat.pecNationales);
    expect(nature.ok).toBe(false);
    expect(nature.error).toMatch(/Prises en charge nationales/);
    expect(nature.error).toMatch(/un événement/);

    const exercice = await accorder(cat.evenementsPasses);
    expect(exercice.ok).toBe(false);
    expect(exercice.error).toMatch(/exercice/);

    const gamme = await accorder(cat.evenementsOnco);
    expect(gamme.ok).toBe(false);
    expect(gamme.error).toMatch(/autre Business Unit/);

    // Rien n'a été écrit par les refus.
    const avant = await prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { status: true, budgetCategoryId: true } });
    expect(avant).toEqual({ status: "PENDING", budgetCategoryId: null });

    ok(await accorder(cat.evenements));
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { budgetCategoryId: true } })).budgetCategoryId).toBe(cat.evenements);
  });

  it("changer le budget d'un poste accordé passe par la même règle", async () => {
    const id = (await prisma.adProItem.findFirstOrThrow({ where: { eventId, label: `${TAG}Brochures` }, select: { id: true } })).id;
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const r = await setAdProItemBudget(undefined, fd({ id, budgetCategoryId: cat.pecNationales }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/réservée aux dépenses « Prises en charge nationales »/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { budgetCategoryId: true } })).budgetCategoryId).toBe(cat.evenements);
  });
});
