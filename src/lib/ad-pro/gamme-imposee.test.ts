import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: () => { throw new Error("hors requête"); },
  headers: () => new Headers(),
}));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { businessUnitDuDemandeur, gammeImposee } from "@/lib/ad-pro/business-unit-auto";
import { businessUnitField, consultingCreateFields, adProOtherCreateFields, sponsoringCreateFields } from "@/lib/ad-pro/create-fields";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { createCongressRequest } from "@/lib/actions/congress-request-actions";
import { createEvent, updateEvent } from "@/lib/actions/event-actions";
import { createConsultingContract } from "@/lib/actions/consulting-actions";
import { createAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BUSINESS UNIT DÉDUITE N'EST PLUS DEMANDÉE — ET LE SERVEUR L'IMPOSE (Direction, 05/10).
 *
 * « Dans les formulaires Ad&Pro, ne pas proposer le champ Business Unit quand elle est déduite : un
 * KAM rattaché à sa BU, un superviseur national d'UNE gamme. »
 *
 * Masquer le champ ne protège de rien : un champ de formulaire se forge. Chaque porte qui LISAIT la
 * gamme postée (congrès, événement, consulting, « autre demande ») est donc passée par `gammeImposee`
 * AVANT que le champ disparaisse — et ce banc forge la gamme d'un AUTRE budget par les vrais points
 * d'entrée, avec des acteurs sans vue globale (§118.104).
 *
 *   kam    délégué médical rattaché à BU1 : la gamme se lit sur sa fiche de force de vente
 *   ns1    National Sales qui supervise UNE gamme (BU1) : la gamme se lit sur sa supervision
 *   ns2    National Sales qui en supervise DEUX : aucune des deux n'est déduite (on ne choisit pas pour lui)
 *   libre  délégué sans fiche force de vente : rien à déduire, la saisie reste libre
 *   pm     Direction Marketing : idem — la gamme se choisit
 *   pmkam  Direction Marketing qui est AUSSI KAM de BU1 (rôle secondaire) : il modifie un événement en entier ET sa gamme se déduit
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__gamme${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ids: Record<string, string> = {};
const roles: Record<string, UserRole> = {};
const bu: Record<string, string> = {};

const secondaires: Record<string, UserRole | null> = {};
async function comme(qui: string) {
  const id = ids[qui]!;
  const access = await getAccess(id, roles[qui] as SessionUser["role"]);
  ACTOR = { id, name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role: roles[qui] as SessionUser["role"], secondaryRole: secondaires[qui] ?? null, access, mustChangePassword: false } as CurrentUser;
  return ACTOR;
}
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "demande.pdf", { type: "application/pdf" });

function formSponsoring(nom: string, gamme: string): FormData {
  const f = new FormData();
  f.set("institution", `${TAG}${nom}`);
  f.append("doctorIds", `${TAG}Dr Benali`); f.append("productIds", `${TAG}Nivolex`);
  f.set("city", "Alger"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
  f.set("amountRequested", "120000"); f.set("amountProposed", "90000"); f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
  f.set("businessUnitId", gamme);
  f.append("files", pdf());
  return f;
}
function formCongres(type: "INTL" | "NATIONAL", nom: string, gamme: string): FormData {
  const f = new FormData();
  f.set("type", type); f.set("name", `${TAG}${nom}`); f.set(type === "INTL" ? "startDate" : "date", "2027-03-01"); f.set("endDate", "2027-03-04");
  f.set("estimatedBudget", "200000"); f.set("businessUnitId", gamme);
  return f;
}
function formEvenement(nom: string, gamme: string): FormData {
  const f = new FormData();
  f.set("name", `${TAG}${nom}`); f.set("type", "CONGRESS"); f.set("scope", "NATIONAL"); f.set("format", "PRESENTIEL");
  f.set("startDate", "2027-04-01"); f.set("endDate", "2027-04-02"); f.set("location", "Hôtel"); f.set("city", "Alger"); f.set("country", "Algérie");
  f.set("specialty", "Cardiologie"); f.append("doctorIds", `${TAG}Dr Amrani`); f.append("productIds", `${TAG}Nivolex`);
  f.set("estimatedBudget", "300000"); f.set("responsibleId", ids.kam!); f.set("description", "Test");
  f.set("businessUnitId", gamme);
  return f;
}
function formConsulting(nom: string, gamme: string): FormData {
  const f = new FormData();
  f.set("title", `${TAG}${nom}`); f.set("counterparty", `${TAG}Cabinet`); f.set("businessUnitId", gamme);
  return f;
}
function formAutre(nom: string, gamme: string): FormData {
  const f = new FormData();
  f.set("title", `${TAG}${nom}`); f.set("description", "Une demande d'essai"); f.set("businessUnitId", gamme);
  return f;
}

suite("La gamme déduite s'impose côté serveur — et le champ n'est plus proposé", () => {
  beforeAll(async () => {
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true } });
    for (const k of ["bu1", "bu2", "bu3", "bu4"]) bu[k] = (await prisma.businessUnit.create({ data: { name: `${TAG}${k}` } })).id;
    const comptes: [string, UserRole][] = [
      ["kam", "MEDICAL_DELEGATE"], ["ns1", "NATIONAL_SALES"], ["ns2", "NATIONAL_SALES"], ["libre", "MEDICAL_DELEGATE"], ["pm", "PRODUCT_MANAGER"], ["pmkam", "PRODUCT_MANAGER"],
    ];
    for (const [k, role] of comptes) {
      const u = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } });
      await prisma.employee.create({ data: { fullName: `${TAG}${k}`, userId: u.id, isActive: true, companyId: c!.id } });
      ids[k] = u.id; roles[k] = role;
    }
    await prisma.salesRepProfile.create({ data: { repId: ids.kam!, businessUnitId: bu.bu1! } });
    await prisma.salesRepProfile.create({ data: { repId: ids.pmkam!, businessUnitId: bu.bu1! } });
    secondaires.pmkam = "MEDICAL_DELEGATE";
    await prisma.user.update({ where: { id: ids.pmkam! }, data: { secondaryRole: "MEDICAL_DELEGATE" } });
    await prisma.businessUnit.update({ where: { id: bu.bu1! }, data: { supervisorId: ids.ns1! } });
    await prisma.businessUnit.update({ where: { id: bu.bu3! }, data: { supervisorId: ids.ns2! } });
    await prisma.businessUnit.update({ where: { id: bu.bu4! }, data: { supervisorId: ids.ns2! } });
  }, 60_000);

  afterAll(async () => {
    const nettoyer = async (type: "SPONSORING" | "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENT" | "CONSULTING_CONTRACT" | "AD_PRO_OTHER", lignes: { id: string }[]) => {
      for (const l of lignes) {
        await prisma.workflowInstance.deleteMany({ where: { entityType: type, entityId: l.id } }).catch(() => {});
        await prisma.adProGateVisa.deleteMany({ where: { entityId: l.id } }).catch(() => {});
        await prisma.notification.deleteMany({ where: { link: { contains: l.id } } }).catch(() => {});
      }
    };
    await nettoyer("SPONSORING", await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } }));
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    await nettoyer("CONGRESS_INTERNATIONAL", await prisma.congressInternational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }));
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await nettoyer("CONGRESS_NATIONAL", await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }));
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await nettoyer("EVENT", await prisma.event.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }));
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await nettoyer("CONSULTING_CONTRACT", await prisma.consultingContract.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } }));
    await prisma.consultingContract.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await nettoyer("AD_PRO_OTHER", await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } }));
    await prisma.adProOtherRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: [ids.kam!, ids.pmkam!] } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { id: { in: Object.values(bu) } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }).catch(() => {});
  }, 60_000);

  // ── LA DÉDUCTION : ce que le serveur lit sur la personne ─────────────────────────────────────

  it("PRÉMISSES — ce que la déduction dit de chacun, et qu'aucun n'a la vue globale", async () => {
    for (const k of ["kam", "ns1", "ns2", "libre", "pm", "pmkam"]) expect(hasGlobalView(await comme(k)), `${k} : pas de vue globale`).toBe(false);
    expect((await businessUnitDuDemandeur({ id: ids.kam!, role: "MEDICAL_DELEGATE" }))?.id, "le KAM : sa gamme").toBe(bu.bu1);
    expect((await businessUnitDuDemandeur({ id: ids.ns1!, role: "NATIONAL_SALES" }))?.id, "NS d'UNE gamme").toBe(bu.bu1);
    expect(await businessUnitDuDemandeur({ id: ids.ns2!, role: "NATIONAL_SALES" }), "NS de DEUX gammes : aucune").toBeNull();
    expect(await businessUnitDuDemandeur({ id: ids.libre!, role: "MEDICAL_DELEGATE" }), "délégué sans fiche : aucune").toBeNull();
    expect(await businessUnitDuDemandeur({ id: ids.pm!, role: "PRODUCT_MANAGER" }), "Direction Marketing : aucune").toBeNull();
  });

  it("`gammeImposee` : la déduite l'emporte sur la postée ; sans déduction, la postée est gardée ; rien de postée = null", async () => {
    expect(await gammeImposee({ id: ids.kam!, role: "MEDICAL_DELEGATE" }, bu.bu2!)).toBe(bu.bu1);
    expect(await gammeImposee({ id: ids.kam!, role: "MEDICAL_DELEGATE" }, null)).toBe(bu.bu1);
    expect(await gammeImposee({ id: ids.libre!, role: "MEDICAL_DELEGATE" }, bu.bu2!)).toBe(bu.bu2);
    expect(await gammeImposee({ id: ids.libre!, role: "MEDICAL_DELEGATE" }, null)).toBeNull();
    expect(await gammeImposee({ id: ids.libre!, role: "MEDICAL_DELEGATE" }, "")).toBeNull();
  });

  // ── LE CHAMP : proposé à qui doit choisir, jamais à qui est déduit ───────────────────────────

  it("LE CHAMP disparaît des formulaires quand la gamme est déduite, et reste quand elle ne l'est pas", () => {
    const gammes = [{ id: "b1", name: "A" }, { id: "b2", name: "B" }];
    const deduite = { id: "b1", name: "A", raison: "Votre gamme" };
    const noms = (f: { name: string }[]) => f.map((x) => x.name);
    expect(noms(businessUnitField(gammes, deduite)), "champ commun").not.toContain("businessUnitId");
    expect(noms(businessUnitField(gammes, null)), "champ commun, non déduit").toContain("businessUnitId");
    expect(noms(sponsoringCreateFields({ businessUnits: gammes, businessUnitDeduite: deduite }))).not.toContain("businessUnitId");
    expect(noms(sponsoringCreateFields({ businessUnits: gammes, businessUnitDeduite: null }))).toContain("businessUnitId");
    expect(noms(consultingCreateFields({ companies: [], businessUnits: gammes, businessUnitDeduite: deduite }))).not.toContain("businessUnitId");
    expect(noms(consultingCreateFields({ companies: [], businessUnits: gammes, businessUnitDeduite: null }))).toContain("businessUnitId");
    expect(noms(adProOtherCreateFields({ companies: [], businessUnits: gammes, businessUnitDeduite: deduite }))).not.toContain("businessUnitId");
    expect(noms(adProOtherCreateFields({ companies: [], businessUnits: gammes, businessUnitDeduite: null }))).toContain("businessUnitId");
  });

  // ── LE SERVEUR : une gamme forgée est ignorée, par chaque porte qui la lisait ────────────────

  it("UN KAM qui FORGE la gamme d'un autre budget : sponsoring, congrès international, congrès national, événement — la sienne est écrite", async () => {
    await comme("kam");
    const s = await createSponsoring(undefined, formSponsoring("S", bu.bu2!));
    expect(s.ok, JSON.stringify(s)).toBe(true);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: s.id! } })).businessUnitId, "sponsoring").toBe(bu.bu1);

    const ci = await createCongressRequest(undefined, formCongres("INTL", "CI", bu.bu2!));
    expect(ci.ok, JSON.stringify(ci)).toBe(true);
    expect((await prisma.congressInternational.findUniqueOrThrow({ where: { id: ci.id! } })).businessUnitId, "congrès international").toBe(bu.bu1);

    const cn = await createCongressRequest(undefined, formCongres("NATIONAL", "CN", bu.bu2!));
    expect(cn.ok, JSON.stringify(cn)).toBe(true);
    expect((await prisma.congressNational.findUniqueOrThrow({ where: { id: cn.id! } })).businessUnitId, "congrès national").toBe(bu.bu1);

    const e = await createEvent(formEvenement("E", bu.bu2!));
    expect(e.ok, JSON.stringify(e)).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: e.id! } })).businessUnitId, "événement").toBe(bu.bu1);
  }, 60_000);

  it("UN KAM qui N'ENVOIE PAS la gamme (le champ n'est plus à l'écran) : la sienne est écrite quand même", async () => {
    await comme("kam");
    const f = formCongres("INTL", "CI sans champ", bu.bu2!);
    f.delete("businessUnitId");
    const r = await createCongressRequest(undefined, f);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await prisma.congressInternational.findUniqueOrThrow({ where: { id: r.id! } })).businessUnitId).toBe(bu.bu1);
    const g = formEvenement("E sans champ", bu.bu2!);
    g.delete("businessUnitId");
    const e = await createEvent(g);
    expect(e.ok, JSON.stringify(e)).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: e.id! } })).businessUnitId).toBe(bu.bu1);
  }, 60_000);

  it("UN NATIONAL SALES d'UNE gamme qui forge une autre : consulting et « autre demande » écrivent la sienne", async () => {
    await comme("ns1");
    const c = await createConsultingContract(undefined, formConsulting("Consulting", bu.bu2!));
    expect(c.ok, JSON.stringify(c)).toBe(true);
    expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id! } })).businessUnitId, "consulting").toBe(bu.bu1);
    const a = await createAdProOtherRequest(undefined, formAutre("Autre", bu.bu2!));
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect((await prisma.adProOtherRequest.findUniqueOrThrow({ where: { id: a.id! } })).businessUnitId, "autre demande").toBe(bu.bu1);
  }, 60_000);

  // ── LE CHOIX RESTE LIBRE LÀ OÙ RIEN NE SE DÉDUIT (refuser à tort coûterait plus que le défaut) ───────

  it("SANS DÉDUCTION, la gamme postée est gardée — NS de deux gammes, délégué sans fiche, Direction Marketing", async () => {
    await comme("ns2");
    const c = await createConsultingContract(undefined, formConsulting("Libre NS2", bu.bu3!));
    expect(c.ok, JSON.stringify(c)).toBe(true);
    expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id! } })).businessUnitId, "NS de deux gammes : son choix").toBe(bu.bu3);

    await comme("libre");
    const ev = await createEvent(formEvenement("Libre", bu.bu2!));
    expect(ev.ok, JSON.stringify(ev)).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.id! } })).businessUnitId, "délégué sans fiche : son choix").toBe(bu.bu2);

    await comme("pm");
    const a = await createAdProOtherRequest(undefined, formAutre("Libre PM", bu.bu4!));
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect((await prisma.adProOtherRequest.findUniqueOrThrow({ where: { id: a.id! } })).businessUnitId, "Direction Marketing : son choix").toBe(bu.bu4);
  }, 60_000);

  // ── LA MODIFICATION D'UN ÉVÉNEMENT ───────────────────────────────────────────────────────────

  it("MODIFIER un événement : qui se déduit ne change pas sa gamme par un champ forgé ; qui doit choisir la change", async () => {
    await comme("kam");
    const e = await createEvent(formEvenement("À modifier", bu.bu1!));
    expect(e.ok, JSON.stringify(e)).toBe(true);
    const modif = (gamme: string | null) => {
      const f = formEvenement("À modifier", gamme ?? "");
      f.set("id", e.id!);
      if (gamme === null) f.delete("businessUnitId");
      return f;
    };
    // Seule la Direction et qui valide modifient un événement EN ENTIER : un KAM n'y a pas accès. La personne
    // qui cumule (Direction Marketing ET KAM de BU1) exerce la seule situation où la déduction sert ici.
    expect((await updateEvent(modif(bu.bu2!))).ok, "PRÉMISSE : un KAM seul ne modifie pas l'événement en entier").toBe(false);
    await comme("pmkam");
    const r = await updateEvent(modif(bu.bu2!));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: e.id! } })).businessUnitId, "forgée : ignorée").toBe(bu.bu1);
    // Le témoin : qui ne se déduit pas choisit — sans lui, une garde qui ignorerait TOUJOURS la gamme postée passerait.
    await comme("pm");
    const r2 = await updateEvent(modif(bu.bu2!));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: e.id! } })).businessUnitId, "non déduite : le choix de la personne").toBe(bu.bu2);
  }, 60_000);

  // ── LES POINTS D'APPEL (§118.49) ────────────────────────────────────────────────────────────

  it("CLIQUET — chaque action de création lit la gamme par `gammeImposee`, et le formulaire de l'événement masque le champ", () => {
    const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const lire = (f: string) => sansCommentaires(readFileSync(f, "utf8"));
    for (const f of ["congress-request-actions.ts", "event-actions.ts", "consulting-actions.ts", "ad-pro-other-actions.ts"]) {
      const src = lire(`src/lib/actions/${f}`);
      expect(src, `${f} : lit la gamme par gammeImposee`).toMatch(/gammeImposee\(\s*user\s*,\s*fdStr\(formData, "businessUnitId"\)/);
      // Les lectures postées restent LITTÉRALES (la dérivation des contrats lit ces clés, §118.143).
      expect(src, `${f} : la clé postée reste littérale`).toContain('fdStr(formData, "businessUnitId")');
    }
    const sponsoring = lire("src/lib/actions/sponsoring-actions.ts");
    expect(sponsoring, "le sponsoring la déduisait déjà").toMatch(/gammeDeduite\?\.id \?\? \(fdStr\(formData, "businessUnitId"\)/);
    const event = lire("src/lib/actions/event-actions.ts");
    const upd = event.slice(event.indexOf("export async function updateEvent"));
    expect(upd, "la modification ignore la gamme postée pour qui se déduit").toMatch(/businessUnitDuDemandeur\(user\)/);
    expect(upd).toMatch(/businessUnitId: gammeDeLEditeur \? undefined/);
    const form = lire("src/app/(app)/events/event-form.tsx");
    expect(form, "l'écran n'affiche le menu que si rien n'est déduit").toMatch(/!deduite && gammes\.length > 0/);
    const champ = lire("src/lib/ad-pro/create-fields.ts");
    expect(champ, "le champ commun se retire quand la gamme est déduite").toMatch(/if \(deduite\) return \[\];/);
  });
});
