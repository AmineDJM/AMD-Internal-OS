import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ». La garde des fiches
// ne doit justement PAS en dépendre (§118.184) — elle juge sur les droits.
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { updateEvent } from "@/lib/actions/event-actions";
import { updateAdProRequest } from "@/lib/actions/ad-pro-edit-actions";
import { champsModifies, porteeModificationEvenement, CHAMPS_ORGANISATION } from "@/lib/events/modification";
import { peutOuvrirLeDossierPromo } from "@/lib/queries/promo-circuit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI MODIFIE UN ÉVÉNEMENT, ET LA DEMANDE AD & PRO D'UN COLLÈGUE (§118.184 — audit 360°, S3/S10/R16).
 *
 * Mesuré par l'audit : le formulaire complet d'un événement et la correction d'une demande Ad & Pro
 * s'ouvraient au droit UPDATE du module, que les délégués portent (CONTRIBUTE). Tout délégué
 * réécrivait l'événement d'un collègue — budget, médecins, produits —, même d'une autre société, et
 * même après la décision ; et la correction d'une demande se faisait par un identifiant, sans portée.
 * Ce banc joue la règle par les VRAIES portes (`canAccessEntity`, `updateEvent`, `updateAdProRequest`)
 * avec des acteurs RATTACHÉS à une société, sans vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("Événement — la portée de la modification (règle pure)", () => {
  it("vue globale : tout, toujours ; qui tranche : tout avant la décision, l'organisation après ; les autres : rien", () => {
    expect(porteeModificationEvenement({ vueGlobale: true, tranche: false, decided: true })).toBe("TOUT");
    expect(porteeModificationEvenement({ vueGlobale: false, tranche: true, decided: false })).toBe("TOUT");
    expect(porteeModificationEvenement({ vueGlobale: false, tranche: true, decided: true })).toBe("ORGANISATION");
    expect(porteeModificationEvenement({ vueGlobale: false, tranche: false, decided: false })).toBe("AUCUNE");
  });

  it("ce que l'écriture ne porte pas ne change rien ; l'ordre d'une liste de médecins non plus", () => {
    const avant = {
      name: "Symposium", estimatedBudget: { toNumber: () => 500000 }, startDate: new Date("2026-11-03T00:00:00Z"),
      doctor: "Dr Benali · Dr Haddad", products: "Nivolex", meetingLink: null,
    };
    // Mêmes valeurs, autre forme : rien n'a bougé.
    expect(champsModifies(avant, {
      name: " Symposium ", estimatedBudget: 500000, startDate: new Date("2026-11-03T00:00:00Z"),
      doctor: "Dr Haddad · Dr Benali", products: "Nivolex", businessUnitId: undefined,
    })).toEqual([]);
    // Le budget et un médecin de plus : nommés, en clair.
    expect(champsModifies(avant, { estimatedBudget: 900000, doctor: "Dr Benali · Dr Haddad · Dr Cherif" })).toEqual(["médecins", "budget estimé"]);
    // L'organisation se lit dans sa propre table : le lien n'est pas un champ de la décision.
    expect(champsModifies(avant, { meetingLink: "https://meet.example/x" })).toEqual([]);
    expect(champsModifies(avant, { meetingLink: "https://meet.example/x" }, CHAMPS_ORGANISATION)).toEqual(["lien de connexion"]);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__edpor__";

suite("Événement et demande Ad & Pro — les vraies portes", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const ev: Record<string, string> = {};
  let delegue1: SessionUser, delegue2: SessionUser, dm: SessionUser, direction: SessionUser;

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  /** Le formulaire COMPLET d'un événement, tel que l'écran l'envoie — avec ce qu'on veut y changer. */
  function formulaire(id: string, change: Record<string, string | string[]> = {}): FormData {
    const base: Record<string, string | string[]> = {
      id, name: `${TAG}Symposium`, type: "CONGRESS", scope: "NATIONAL", format: "PRESENTIAL",
      startDate: "2026-11-03", endDate: "2026-11-04", location: "Hôtel Aurassi", city: "Alger", country: "Algérie",
      specialty: "Cardiologie", doctor: "Dr Benali · Dr Haddad", product: "Nivolex", estimatedBudget: "500000",
      responsibleId: u.d2, description: "Symposium régional",
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...change })) {
      if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
    }
    return fd;
  }

  async function nettoyer() {
    const evs = await prisma.event.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: evs.map((e) => e.id) } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = async (k: string, role: string, companyId: string | null) => {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } });
      u[k] = user.id;
      if (companyId) await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id } });
    };
    await mk("d1", "MEDICAL_DELEGATE", A);
    await mk("d2", "MEDICAL_DELEGATE", A);
    // La Direction Marketing TRANCHE les événements (EVENTS : MANAGE) — rattachée à Alpha SEULE.
    await mk("dm", "PRODUCT_MANAGER", A);
    await mk("dir", "DIRECTION", null);
    // Les Finances LISENT le matériel promotionnel en portée « toutes les lignes », sans le trancher.
    await mk("fin", "FINANCE_BUDGET_MANAGER", A);
    // Le National Sales SUPERVISE une gamme : il tranche, par le circuit, les demandes de ses KAM.
    await mk("ns", "NATIONAL_SALES", A);
    delegue1 = await acteur(u.d1, "MEDICAL_DELEGATE");
    delegue2 = await acteur(u.d2, "MEDICAL_DELEGATE");
    dm = await acteur(u.dm, "PRODUCT_MANAGER");
    direction = await acteur(u.dir, "DIRECTION");
    const cree = async (k: string, companyId: string, requestStatus: string | null, requesterId: string) => {
      ev[k] = (await prisma.event.create({
        data: {
          name: `${TAG}Symposium`, companyId, requesterId, requestStatus: requestStatus as never,
          startDate: new Date("2026-11-03T00:00:00Z"), endDate: new Date("2026-11-04T00:00:00Z"),
          location: "Hôtel Aurassi", city: "Alger", country: "Algérie", specialty: "Cardiologie",
          doctor: "Dr Benali · Dr Haddad", products: "Nivolex", estimatedBudget: 500000,
          responsibleId: u.d2, description: "Symposium régional",
        },
      })).id;
    };
    await cree("alpha", A, "AWAITING_PRELIMINARY", u.d2);
    await cree("beta", B, "AWAITING_PRELIMINARY", u.dm);
    await cree("betaDuD2", B, "AWAITING_PRELIMINARY", u.d2);
    await cree("decide", A, "APPROVED", u.d2);
    await cree("refuse", A, "REJECTED", u.d2);
    const gamme = await prisma.businessUnit.create({ data: { name: `${TAG}Gamme`, supervisorId: u.ns } });
    await prisma.event.update({ where: { id: ev.betaDuD2 }, data: { businessUnitId: gamme.id } });
    for (const [k, companyId] of [["promoA", A], ["promoB", B]] as const) {
      ev[k] = (await prisma.promoMaterial.create({ data: { reference: `${TAG}${k}`, title: `${TAG}${k}`, companyId, requesterId: u.dm } })).id;
    }
  });

  afterAll(async () => { await nettoyer(); });

  const budget = async (k: string) => Number((await prisma.event.findUniqueOrThrow({ where: { id: ev[k] }, select: { estimatedBudget: true } })).estimatedBudget);

  it("PRÉMISSE : le délégué CONTRIBUE aux événements (UPDATE) sans les trancher — c'est ce droit qui ouvrait tout", () => {
    expect(delegue1.access.modules.get("EVENTS")?.actions.has("UPDATE")).toBe(true);
    expect(delegue1.access.modules.get("EVENTS")?.actions.has("VALIDATE")).toBe(false);
    expect(dm.access.modules.get("EVENTS")?.actions.has("VALIDATE")).toBe(true);
  });

  it("la FICHE : sa société s'ouvre, une autre non — sauf à en être le demandeur ou à la trancher", async () => {
    expect(await canAccessEntity(delegue1, "EVENT", ev.alpha, "VIEW")).toBe(true);
    expect(await canAccessEntity(delegue1, "EVENT", ev.beta, "VIEW")).toBe(false);
    expect(await canAccessEntity(delegue1, "EVENT", ev.beta, "UPLOAD")).toBe(false);
    // Le demandeur garde SA demande, même posée sur une autre société.
    expect(await canAccessEntity(delegue2, "EVENT", ev.betaDuD2, "VIEW")).toBe(true);
    // Qui tranche ouvre ce qu'on lui demande de trancher, quelle que soit la société (§118.27).
    expect(await canAccessEntity(dm, "EVENT", ev.betaDuD2, "VIEW")).toBe(true);
    expect(await canAccessEntity(dm, "EVENT", ev.betaDuD2, "UPDATE")).toBe(true);
  });

  it("le SUPERVISEUR de la gamme lit la demande qu'il tranche, même d'une autre société — sans pouvoir l'écrire", async () => {
    const ns = await acteur(u.ns, "NATIONAL_SALES");
    expect(await canAccessEntity(ns, "EVENT", ev.betaDuD2, "VIEW")).toBe(true);
    expect(await canAccessEntity(ns, "EVENT", ev.betaDuD2, "UPDATE")).toBe(false);
    // Le témoin : une demande d'une autre société hors de sa gamme lui reste fermée.
    expect(await canAccessEntity(ns, "EVENT", ev.beta, "VIEW")).toBe(false);
  });

  it("ÉCRIRE dans l'événement d'un collègue exige de le trancher : contribuer, c'est écrire SES dossiers", async () => {
    expect(await canAccessEntity(delegue1, "EVENT", ev.alpha, "UPDATE")).toBe(false);
    expect(await canAccessEntity(delegue2, "EVENT", ev.alpha, "UPDATE")).toBe(true);
  });

  it("le FORMULAIRE COMPLET est refusé à un délégué — collègue ou demandeur — et rien n'est écrit", async () => {
    ACTEUR = delegue1;
    const r1 = await updateEvent(formulaire(ev.alpha, { estimatedBudget: "999999" }));
    expect(r1.ok).toBe(false);
    ACTEUR = delegue2;
    const r2 = await updateEvent(formulaire(ev.alpha, { estimatedBudget: "999999" }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/Modifier la demande/);
    expect(await budget("alpha")).toBe(500000);
  });

  it("qui tranche modifie tout AVANT la décision, et la modification est tracée", async () => {
    ACTEUR = dm;
    const r = await updateEvent(formulaire(ev.alpha, { estimatedBudget: "650000" }));
    expect(r).toEqual({ ok: true });
    expect(await budget("alpha")).toBe(650000);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: ev.alpha, module: "Events", action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(trace?.summary).toMatch(/budget estimé/);
    expect(trace?.actorId).toBe(u.dm);
  });

  it("APRÈS la décision, qui tranche sans vue globale ne réécrit plus ce qui a fondé l'accord — et le refus nomme les champs", async () => {
    ACTEUR = dm;
    const r = await updateEvent(formulaire(ev.decide, { estimatedBudget: "900000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/budget estimé/);
    expect(await budget("decide")).toBe(500000);
  });

  it("APRÈS la décision, l'organisation reste modifiable — même quand le formulaire renvoie les médecins dans un autre ordre", async () => {
    ACTEUR = dm;
    const r = await updateEvent(formulaire(ev.decide, {
      meetingLink: "https://meet.example/symposium", doctor: "", doctorIds: ["Dr Haddad", "Dr Benali"],
    }));
    expect(r).toEqual({ ok: true });
    const apres = await prisma.event.findUniqueOrThrow({ where: { id: ev.decide }, select: { meetingLink: true, estimatedBudget: true } });
    expect(apres.meetingLink).toBe("https://meet.example/symposium");
    expect(Number(apres.estimatedBudget)).toBe(500000);
  });

  it("la vue globale corrige même après la décision, et l'audit le dit", async () => {
    ACTEUR = direction;
    const r = await updateEvent(formulaire(ev.decide, { estimatedBudget: "720000" }));
    expect(r).toEqual({ ok: true });
    expect(await budget("decide")).toBe(720000);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: ev.decide, module: "Events", action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(trace?.summary).toMatch(/APRÈS DÉCISION/);
  });

  it("CORRIGER LA DEMANDE : le demandeur la sienne ; un collègue délégué, non ; une autre société, introuvable", async () => {
    const fd = (id: string, budgetDemande: string) => {
      const f = new FormData();
      f.set("kind", "EVENT"); f.set("id", id); f.set("estimatedBudget", budgetDemande);
      return f;
    };
    ACTEUR = delegue1;
    const collegue = await updateAdProRequest(fd(ev.alpha, "111111"));
    expect(collegue.ok).toBe(false);
    if (!collegue.ok) expect(collegue.error).toMatch(/pas le droit/);
    const autreSociete = await updateAdProRequest(fd(ev.beta, "111111"));
    expect(autreSociete).toEqual({ ok: false, error: "Demande introuvable." });
    ACTEUR = delegue2;
    const sienne = await updateAdProRequest(fd(ev.alpha, "640000"));
    expect(sienne.ok).toBe(true);
    expect(await budget("alpha")).toBe(640000);
  });

  it("MATÉRIEL PROMOTIONNEL : « toutes les lignes » s'arrête aux sociétés qu'on voit — sauf pour qui le tranche", async () => {
    const fin = await acteur(u.fin, "FINANCE_BUDGET_MANAGER");
    // PRÉMISSE : les Finances lisent le module en portée entière, sans le droit de le trancher.
    expect(fin.access.modules.get("PROMO_MATERIAL")?.scope).toBe("ALL");
    expect(fin.access.modules.get("PROMO_MATERIAL")?.actions.has("VALIDATE")).toBe(false);
    const lire = (k: string) => prisma.promoMaterial.findUniqueOrThrow({
      where: { id: ev[k] }, select: { id: true, requesterId: true, assistantId: true, requestValidatorId: true, marketingValidatorId: true, companyId: true },
    });
    expect(await peutOuvrirLeDossierPromo(fin, await lire("promoA"))).toBe(true);
    expect(await peutOuvrirLeDossierPromo(fin, await lire("promoB"))).toBe(false);
    expect(await canAccessEntity(fin, "PROMO_MATERIAL", ev.promoB, "VIEW")).toBe(false);
    // La Direction Marketing tranche le module : elle ouvre le dossier d'une autre société.
    expect(await peutOuvrirLeDossierPromo(dm, await lire("promoB"))).toBe(true);
  });

  it("POINTS D'APPEL : la fiche d'un événement passe par la porte AVANT de charger quoi que ce soit, et son bouton lit la règle de l'action", () => {
    const page = readFileSync("src/app/(app)/events/[id]/page.tsx", "utf8");
    const porte = page.indexOf('canAccessEntity(user, "EVENT", e.id, "VIEW")');
    expect(porte).toBeGreaterThan(0);
    expect(porte).toBeLessThan(page.indexOf("loadAdProItems("));
    expect(page).toMatch(/porteeModificationEvenement\(/);
    expect(page).not.toMatch(/const canManage = userCan\(user, "EVENTS", "UPDATE"\)/);
    const action = readFileSync("src/lib/actions/event-actions.ts", "utf8");
    const corps = action.slice(action.indexOf("export async function updateEvent"), action.indexOf("export async function deleteEvent"));
    expect(corps).toMatch(/porteeModificationEvenement\(/);
    expect(corps).toMatch(/canAccessEntity\(user, "EVENT", id, "UPDATE"\)/);
  });

  it("une demande REFUSÉE est tranchée : son demandeur ne la corrige plus (le refus s'écrit REJECTED)", async () => {
    ACTEUR = delegue2;
    const f = new FormData();
    f.set("kind", "EVENT"); f.set("id", ev.refuse); f.set("estimatedBudget", "123456");
    const r = await updateAdProRequest(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/décision est rendue/);
    expect(await budget("refuse")).toBe(500000);
  });
});
