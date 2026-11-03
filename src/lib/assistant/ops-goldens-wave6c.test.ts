import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 6c — planning force de vente : cycles en FRANÇAIS (« septembre 2026 »),
 * FUSION des upserts à défauts-pièges (prévision FTE→0, profil KAM FTE→1, paramètres SFE aux
 * défauts), affectation 0 visite sans note = RETRAIT annoncé, report de cycle qui ne comble
 * que les vides, canal produit à défaut-piège BOTH.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops6c__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let kamId = "";
let buId = "";
let productId = "";
let cycleId = "";

const sa = () => userWith({
  SALES_PLANNING: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  // LE MONTAGE (BU, produits, KAM, secteurs, paramètres) est le module « Business Units » (Direction, 08/10).
  BUSINESS_UNITS: ["VIEW", "CREATE", "UPDATE", "DELETE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 6c — planning force de vente (SFE)", () => {
  beforeAll(async () => {
    const [s, kam] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Mounir KAM`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; kamId = kam.id;

    const bu = await prisma.businessUnit.create({ data: { name: `${TAG} BU Cardio`, code: "CAR" } });
    buId = bu.id;
    const product = await prisma.promoProduct.create({
      data: { name: `${TAG} Tensiofix`, channel: "RETAIL", businessUnitId: bu.id, code: "TFX" },
    });
    productId = product.id;
    // LA BU EST L'ÉQUIPE : le KAM s'y rattache directement, sans étage intermédiaire.
    await prisma.businessUnit.update({ where: { id: bu.id }, data: { supervisorId: s.id } });
    await prisma.salesRepProfile.create({
      data: { repId: kam.id, businessUnitId: bu.id, region: "Centre", fteBudget: 0.8, seniority: "Senior", isActive: true, note: "Bilingue" },
    });
    const cycle = await prisma.promoCycle.create({ data: { year: 2033, month: 9, label: "Septembre 2033" } });
    cycleId = cycle.id;
    await prisma.promotionAssignment.create({
      data: { cycleId: cycle.id, repId: kam.id, productId: product.id, position: 2, plannedVisits: 10, note: "Focus CHU" },
    });
    await prisma.productForecast.create({
      data: { cycleId: cycle.id, productId: product.id, targetFte: 2.5, coverageTargetPct: 70, plannedVisits: 300, budget: 400_000, note: "Lancement" },
    });
  });

  afterAll(async () => {
    await prisma.productForecast.deleteMany({ where: { product: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.promotionAssignment.deleteMany({ where: { product: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.promoCycle.deleteMany({ where: { year: 2033 } }).catch(() => {});
    const testUsers = await prisma.user.findMany({ where: { email: { startsWith: "__ops6c__" } }, select: { id: true } }).catch(() => []);
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: testUsers.map((u) => u.id) } } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: "__ops6c__" } } }).catch(() => {});
  });

  it("update_promo_product : sans canal donné, le canal EXISTANT est rejoué (le défaut-piège BOTH ne s'applique pas)", async () => {
    const p = await buildProposal("planning_operation", {
      op: "update_promo_product", product: "Tensiofix", newName: `${TAG} Tensiofix LP`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.id).toBe(productId);
      expect(a.channel).toBe("RETAIL");
      expect(a.code).toBe("TFX");
      expect(a.businessUnitId).toBe(buId);
    }
  });

  it("save_forecast : changer le SEUL budget rejoue FTE, couverture et visites (l'upsert mettrait le FTE à 0)", async () => {
    const p = await buildProposal("planning_operation", {
      op: "save_forecast", product: "Tensiofix", date: "septembre 2033", amount: "500000",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.productId).toBe(productId);
      expect(a.year).toBe("2033");
      expect(a.month).toBe("9");
      expect(a.targetFte).toBe("2.5");
      expect(a.coverageTargetPct).toBe("70");
      expect(a.plannedVisits).toBe("300");
      expect(a.budget).toBe("500000");
      expect(a.note).toBe("Lancement");
    }
  });

  it("save_rep_profile : changer la SEULE région rejoue équipe, FTE 0.8 (le défaut serait 1), séniorité et note", async () => {
    const p = await buildProposal("planning_operation", {
      op: "save_rep_profile", person: "Mounir KAM", location: "Est",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.repId).toBe(kamId);
      expect(a.region).toBe("Est");
      expect(a.businessUnitId).toBe(buId);
      expect(a.fteBudget).toBe("0.8");
      expect(a.seniority).toBe("Senior");
      expect(a.note).toBe("Bilingue");
      expect(a.isActive).toBe("on");
    }
  });

  it("save_assignment : sans visites données, l'existant (P2, 10 visites, note) est rejoué — pas de retrait accidentel", async () => {
    const p = await buildProposal("planning_operation", {
      op: "save_assignment", person: "Mounir KAM", product: "Tensiofix", date: "2033-09", mode: "1",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.position).toBe("1");
      expect(a.plannedVisits).toBe("10");
      expect(a.note).toBe("Focus CHU");
    }
  });

  it("save_assignment : 0 visite SANS note = RETRAIT annoncé de la matrice", async () => {
    const other = await prisma.promoProduct.create({ data: { name: `${TAG} Vitaplus`, channel: "BOTH" } });
    const p = await buildProposal("planning_operation", {
      op: "save_assignment", person: "Mounir KAM", product: "Vitaplus", date: "septembre 2033", visits: "0",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/RETIRÉE/);
    await prisma.promoProduct.delete({ where: { id: other.id } }).catch(() => {});
  });

  it("carry_forward_assignments : source comptée, cible annoncée créée au besoin, les cases saisies priment", async () => {
    const p = await buildProposal("planning_operation", {
      op: "carry_forward_assignments", date: "septembre 2033", endDate: "octobre 2033",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/1 affectation/);
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/créé à l'exécution/);
      expect(p.warnings.join(" ")).toMatch(/priment/);
      expect(domainArgs(p).toYear).toBe("2033");
      expect(domainArgs(p).toMonth).toBe("10");
    }
  });

  it("save_sfe_settings : porte BUSINESS_UNITS — un délégué sans droits est refusé par le catalogue", async () => {
    const delegate = userWith({}, "MEDICAL_DELEGATE", kamId, "KAM");
    const denied = await buildProposal("planning_operation", { op: "save_sfe_settings", days: "22" }, delegate);
    expect("error" in denied && denied.error).toMatch(/droit/);

    const p = await buildProposal("planning_operation", { op: "save_sfe_settings", days: "22" }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).daysPerMonth).toBe("22");
      expect(domainArgs(p).visitsPerDay).toBe("7");
      expect(domainArgs(p).p1).toBe("1");
    }
  });

  it("delete_business_unit : REFUSÉ tant que la BU porte des KAM ou des produits", async () => {
    // Supprimer une BU peuplée laisserait ses KAM sans superviseur et ses produits sans terrain —
    // invisibles au pilotage, sans qu'aucune erreur ne se produise. Le refus NOMME ce qui reste.
    const p = await buildProposal("planning_operation", { op: "delete_business_unit", target: "BU Cardio" }, sa());
    expect("error" in p).toBe(true);
    if ("error" in p) {
      expect(p.error).toMatch(/1 KAM/);
      expect(p.error).toMatch(/1 produit/);
      expect(p.error).toMatch(/d[ée]sactiv/i);
    }
  });

  it("create_business_unit : le SUPERVISEUR et le TERRAIN se posent dès la création", async () => {
    const p = await buildProposal("planning_operation", {
      // La personne est nommée en ENTIER : « Amine » seul est un prénom que d'autres comptes de la base partagée portent
      // (le monde du banc d'audit sème « Amine HADDAD ») — le résolveur a raison de demander lequel (F1).
      op: "create_business_unit", name: `${TAG} BU Onco`, person: `${TAG} Amine`, mode: "hospitalier",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.supervisorId).toBe(saId);
      expect(a.channel).toBe("HOSPITAL");
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/Hospitali/i);
    }
  });

  it("create_business_unit sans superviseur : ça passe, mais le message le DIT", async () => {
    const p = await buildProposal("planning_operation", { op: "create_business_unit", name: `${TAG} BU Derma` }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).supervisorId).toBeNull();
      // Le défaut « les deux » n'exclut rien : il ne bloque pas la création.
      expect(domainArgs(p).channel).toBe("BOTH");
    }
  });

  it("update_business_unit : le terrain NON demandé est rejoué, il ne retombe pas sur « les deux »", async () => {
    await prisma.businessUnit.update({ where: { id: buId }, data: { channel: "HOSPITAL" } });
    const p = await buildProposal("planning_operation", {
      op: "update_business_unit", target: "BU Cardio", newName: `${TAG} BU Cardiologie`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(domainArgs(p).channel).toBe("HOSPITAL");
    await prisma.businessUnit.update({ where: { id: buId }, data: { channel: "BOTH" } });
  });
});
