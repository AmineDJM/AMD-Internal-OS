import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  createBusinessUnit, updateBusinessUnit, enregistrerSpecialitesBu,
} from "@/lib/actions/sales-planning-actions";
import { deleteSpecialty, fusionnerSpecialite } from "@/lib/actions/medical-actions";
import { chargerSpecialites } from "@/lib/queries/specialites";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE BUSINESS UNIT VISE PLUSIEURS SPÉCIALITÉS (§118.183) — par les vrais points d'entrée.
 *
 * « BU ≠ spécialité » : la BU Specialty Care vise la neurologie, la dermatologie et l'urologie, avec une
 * principale FACULTATIVE. Les acteurs n'ont PAS la vue globale (§118.104) : le Manager Promotion médicale
 * (Force de vente et Annuaire en gestion — c'est lui qui monte les BU) et un délégué (Force de vente
 * fermée en écriture). Une vue globale rendrait vrais des cas que la garde de module devait trancher.
 * Les noms portent le préfixe du banc : la base est partagée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "ZZBUSPE";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

suite("Les spécialités d'une Business Unit (§118.183)", () => {
  let gestionnaire = "", delegue = "";
  let neuro = "", dermato = "", uro = "";
  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, name: `${TAG}${role}`, access: await getAccess(id, role as never) } as unknown as SessionUser);

  const nettoyer = async () => {
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG.toLowerCase() } }, select: { id: true } }).catch(() => []);
    await prisma.businessUnitSpecialty.deleteMany({ where: { businessUnit: { name: { startsWith: TAG, mode: "insensitive" } } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG, mode: "insensitive" } } }).catch(() => {});
    await prisma.medicalSpecialty.deleteMany({ where: { name: { startsWith: TAG, mode: "insensitive" } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG.toLowerCase()}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [ges, del] = await Promise.all([mk("gestionnaire", "MEDICAL_PROMOTION_MANAGER"), mk("delegue", "MEDICAL_DELEGATE")]);
    gestionnaire = ges.id; delegue = del.id;
    const [n, d, u] = await Promise.all([
      prisma.medicalSpecialty.create({ data: { name: `${TAG}Neurologie` } }),
      prisma.medicalSpecialty.create({ data: { name: `${TAG}Dermatologie` } }),
      prisma.medicalSpecialty.create({ data: { name: `${TAG}Urologie` } }),
    ]);
    neuro = n.id; dermato = d.id; uro = u.id;
  });

  afterAll(nettoyer);

  const liens = (buId: string) =>
    prisma.businessUnitSpecialty.findMany({ where: { businessUnitId: buId }, select: { specialtyId: true, principale: true }, orderBy: { specialtyId: "asc" } });

  it("les acteurs sont ce que le banc croit qu'ils sont", async () => {
    const g = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    expect(hasGlobalView(g), "sans vue globale : c'est le droit de module qui décide").toBe(false);
    expect(userCan(g, "SALES_PLANNING", "UPDATE")).toBe(true);
    expect(userCan(g, "MEDICAL", "DELETE"), "le retrait et la fusion du référentiel lui sont ouverts").toBe(true);
    expect(userCan(await acteur(delegue, "MEDICAL_DELEGATE"), "SALES_PLANNING", "UPDATE")).toBe(false);
  });

  it("créer une BU AVEC ses spécialités : trois liens, une principale — en une écriture", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const r = await createBusinessUnit(fd({ name: `${TAG}Specialty Care`, specialtyIds: [neuro, dermato, uro], principaleId: neuro }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const l = await liens(r.ok ? (r.id ?? "") : "");
    expect(l.length).toBe(3);
    expect(l.filter((x) => x.principale).map((x) => x.specialtyId)).toEqual([neuro]);
    // L'HISTOIRE DIT CE QUE LA BU VISE DÈS SA NAISSANCE — pas seulement son nom.
    const journal = await prisma.auditLog.findFirst({ where: { entityType: "BUSINESS_UNIT", entityId: r.ok ? (r.id ?? "") : "", action: "CREATE" } });
    expect(journal?.summary).toContain(`principale : ${TAG}Neurologie`);
  });

  it("la principale doit être cochée ; une spécialité disparue est refusée — et RIEN n'est écrit", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const avant = await prisma.businessUnit.count({ where: { name: { startsWith: TAG } } });
    const horsEnsemble = await createBusinessUnit(fd({ name: `${TAG}Refusée`, specialtyIds: [dermato], principaleId: neuro }));
    expect(horsEnsemble.ok).toBe(false);
    expect(horsEnsemble.ok ? "" : horsEnsemble.error).toContain("principale");
    const disparue = await createBusinessUnit(fd({ name: `${TAG}Refusée`, specialtyIds: [dermato, `${TAG}inexistante`] }));
    expect(disparue.ok).toBe(false);
    expect(disparue.ok ? "" : disparue.error).toContain("n'existent plus");
    expect(await prisma.businessUnit.count({ where: { name: { startsWith: TAG } } })).toBe(avant);
  });

  it("enregistrer REMPLACE l'ensemble : décocher retire, la principale change, l'historique le dit", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    const r = await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [neuro, dermato], principaleId: dermato }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const l = await liens(bu.id);
    expect(l.map((x) => x.specialtyId).sort()).toEqual([neuro, dermato].sort());
    expect(l.filter((x) => x.principale).map((x) => x.specialtyId)).toEqual([dermato]);
    const journal = await prisma.auditLog.findFirst({ where: { entityType: "BUSINESS_UNIT", entityId: bu.id, summary: { contains: "Spécialités" } }, orderBy: { createdAt: "desc" } });
    expect(journal?.summary).toContain(`− ${TAG}Urologie`);
    expect(journal?.summary).toContain(`principale : ${TAG}Dermatologie`);
  });

  it("sans principale, c'est permis — la principale est facultative ; et un ensemble vide aussi", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    expect((await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [neuro, dermato] }))).ok).toBe(true);
    expect((await liens(bu.id)).some((x) => x.principale)).toBe(false);
    expect((await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id }))).ok).toBe(true);
    expect(await liens(bu.id)).toEqual([]);
    await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [neuro, dermato, uro], principaleId: neuro }));
  });

  it("six enregistrements SIMULTANÉS de la même BU se succèdent — jamais deux principales, jamais d'erreur brute", async () => {
    // Croisés, l'index partiel « une principale par BU » refuserait le second en erreur brute : chacun
    // retire la principale qu'il voit, et pose la sienne pendant que l'autre n'a pas encore validé.
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    const enregistrer = (principaleId: string) =>
      enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [neuro, dermato, uro], principaleId }));
    const rs = await Promise.all([neuro, dermato, uro, neuro, dermato, uro].map(enregistrer));
    expect(rs.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect((await liens(bu.id)).filter((x) => x.principale)).toHaveLength(1);
    await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [neuro, dermato, uro], principaleId: neuro }));
  });

  it("le délégué n'y touche pas : la Force de vente ne lui est pas ouverte en écriture", async () => {
    ACTEUR = await acteur(delegue, "MEDICAL_DELEGATE");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    const r = await enregistrerSpecialitesBu(fd({ businessUnitId: bu.id, specialtyIds: [uro] }));
    expect(r.ok).toBe(false);
    expect((await liens(bu.id)).length).toBe(3);
  });

  it("modifier la BU par une partie de ses champs ne touche pas aux autres", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    await prisma.businessUnit.update({ where: { id: bu.id }, data: { code: `${TAG}SC`, color: "#123456", supervisorId: gestionnaire, channel: "HOSPITAL" } });
    const r = await updateBusinessUnit(fd({ id: bu.id, name: `${TAG}Specialty Care` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await prisma.businessUnit.findUniqueOrThrow({ where: { id: bu.id } });
    expect([apres.code, apres.color, apres.supervisorId, String(apres.channel)]).toEqual([`${TAG}SC`, "#123456", gestionnaire, "HOSPITAL"]);
    // Ce que le formulaire PORTE, vide, s'efface : c'est l'autre moitié de la règle.
    await updateBusinessUnit(fd({ id: bu.id, code: "" }));
    expect((await prisma.businessUnit.findUniqueOrThrow({ where: { id: bu.id } })).code).toBeNull();
  });

  it("le référentiel : une spécialité visée par une BU ne se RETIRE pas — le refus nomme la BU", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const r = await deleteSpecialty(fd({ id: uro }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(`${TAG}Specialty Care`);
    expect(await prisma.medicalSpecialty.findUnique({ where: { id: uro } })).not.toBeNull();
  });

  it("le référentiel : FUSIONNER fait suivre les BU — sans doublon, la principale tient", async () => {
    ACTEUR = await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER");
    const bu = await prisma.businessUnit.findFirstOrThrow({ where: { name: `${TAG}Specialty Care` } });
    // La BU vise neuro (principale), dermato et uro. On fusionne la PRINCIPALE dans dermato, qu'elle vise
    // déjà : un seul lien reste, et c'est lui qui devient la principale.
    const r = await fusionnerSpecialite(fd({ id: neuro, cibleId: dermato }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const l = await liens(bu.id);
    expect(l.map((x) => x.specialtyId).sort()).toEqual([dermato, uro].sort());
    expect(l.filter((x) => x.principale).map((x) => x.specialtyId)).toEqual([dermato]);
  });

  it("l'écran des spécialités dit quelles BU visent chacune", async () => {
    const vue = await chargerSpecialites(await acteur(gestionnaire, "MEDICAL_PROMOTION_MANAGER"));
    const d = vue.specialites.find((s) => s.id === dermato);
    expect(d?.bu).toEqual([{ nom: `${TAG}Specialty Care`, principale: true }]);
  });
});
