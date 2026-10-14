import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { ensureInstance as ensureInstanceDuMoteur, lectureDeLApprobation, stepCreate } from "./engine";
import { defaultDefinition } from "./defaults";
import { adProInit } from "./origin";
import type { StepInput } from "./types";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { advanceWorkflow } from "@/lib/actions/workflow-actions";
import { createCongressRequest } from "@/lib/actions/congress-request-actions";
import { createEvent, submitEventForApproval } from "@/lib/actions/event-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA ROUTE COUPÉE DU RANG 2 — la Direction des opérations conclut, et fixe le budget qu'elle tranche.
 *
 *   pm    Direction Marketing (rôle PRODUCT_MANAGER, SANS vue globale) : demandeur de rang 2
 *   mpm   Manager Promotion médicale (rang 2, sans vue globale) : l'autre demandeur de rang 2
 *   kam   délégué médical : le TÉMOIN, dont la demande est tranchée par Direction Marketing
 *   ns    National Sales : le préliminaire du KAM
 *   gm    Directeur Général : la porte des grosses dépenses
 *   dir   Direction des opérations : l'étape `final`, qui TRANCHE la demande d'un rang 2
 *
 * MESURÉ AVANT LA RÉPARATION, par ces mêmes portes (création, écran de l'étape, `advanceWorkflow`) :
 * 12 demandes de rang 2 sur 12 — congrès international, national, événement ; Direction Marketing et
 * Manager Promotion médicale ; sous et au-dessus du seuil — sortaient APPROUVÉES sans budget accordé,
 * sans ordre de dépense ni déclaration, et l'écran ne proposait ni montant ni catégorie. Le même
 * dossier déposé par un KAM émettait son ordre de dépense 6 fois sur 6.
 *
 * Les demandes naissent par les vraies actions de création ; leur circuit est une COPIE PRIVÉE de la
 * colonne vertébrale par défaut (même raison que `renvoi-flow.test.ts` : un banc voisin réécrit le
 * circuit partagé le temps d'un cas). Les montants se lisent contre le seuil RÉEL des réglages.
 *
 * L'émission se juge « une déclaration OU un ordre de dépense » : `emitFinancials` choisit la
 * déclaration dès qu'un pharmacien est actif, et un banc voisin (`medical-info-circuits.test.ts`) en
 * crée un le temps de ses cas. Ce banc n'en crée pas : il troublerait les autres de la même façon.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__argcoupe${Date.now()}__`;
const ids: Record<string, string> = {};
const ROLES: Record<string, UserRole> = {
  pm: "PRODUCT_MANAGER", mpm: "MEDICAL_PROMOTION_MANAGER", kam: "MEDICAL_DELEGATE",
  ns: "NATIONAL_SALES", gm: "GENERAL_MANAGER", dir: "DIRECTION",
};
let catId = "";
let SEUIL = 1_000_000;

type ET = "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENT" | "SPONSORING";
type Categorie = "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENTS" | "SPONSORING";
const CATEGORIE: Record<ET, Categorie> = { CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", EVENT: "EVENTS", SPONSORING: "SPONSORING" };

async function actorFor(qui: string): Promise<CurrentUser> {
  const id = ids[qui]!;
  const access = await getAccess(id, ROLES[qui] as SessionUser["role"]);
  return { id, name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role: ROLES[qui] as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
}
async function comme(qui: string) { ACTOR = await actorFor(qui); }
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/** Le circuit du banc — la colonne vertébrale par défaut, éventuellement retouchée « à la main ». */
const CIRCUITS: string[] = [];
const PAR_DEFAUT: Partial<Record<Categorie, string>> = {};
async function circuit(categorie: Categorie, retouche?: (s: StepInput) => StepInput): Promise<string> {
  if (!retouche && PAR_DEFAUT[categorie]) return PAR_DEFAUT[categorie]!;
  const d = defaultDefinition(categorie);
  const steps = retouche ? d.steps.map(retouche) : d.steps;
  const def = await prisma.workflowDefinition.create({
    data: { category: `${TAG}${categorie}${CIRCUITS.length}`, name: `${TAG}${d.name}`, steps: { create: steps.map(stepCreate) } },
  });
  CIRCUITS.push(def.id);
  if (!retouche) PAR_DEFAUT[categorie] = def.id;
  return def.id;
}
/** `ensureInstance` du moteur, puis la demande est liée au circuit du banc. */
async function lier(entityType: ET, entityId: string, definitionId?: string) {
  const inst = await ensureInstanceDuMoteur(entityType, entityId);
  if (!inst) throw new Error("instance introuvable");
  return prisma.workflowInstance.update({ where: { id: inst.id }, data: { definitionId: definitionId ?? (await circuit(CATEGORIE[entityType])) } });
}
const instanceDe = (entityType: ET, entityId: string) =>
  prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType, entityId } } });

type Nature = "INTL" | "NATIONAL" | "EVENT";
const ENTITE: Record<Nature, ET> = { INTL: "CONGRESS_INTERNATIONAL", NATIONAL: "CONGRESS_NATIONAL", EVENT: "EVENT" };
const LIBELLE: Record<Nature, string> = { INTL: "congrès international", NATIONAL: "congrès national", EVENT: "événement" };

/** Dépose la demande par l'ACTION de l'écran, au nom de `qui`. */
async function deposer(nature: Nature, qui: string, budget: number, definitionId?: string): Promise<string> {
  await comme(qui);
  let id: string;
  if (nature === "EVENT") {
    const cree = await createEvent(fd({
      name: `${TAG}ev-${qui}-${budget}`, type: "CONGRESS", scope: "NATIONAL", format: "PRESENTIAL", startDate: "2026-12-01", endDate: "2026-12-02",
      location: "Salle", city: "Alger", country: "Algérie", specialty: "Cardiologie", doctor: "Dr Banc", product: "Produit du banc",
      estimatedBudget: String(budget), responsibleId: ids[qui]!, description: "Banc de la route coupée",
    }));
    expect(cree.ok, cree.ok ? "" : cree.error).toBe(true);
    id = cree.ok ? cree.id! : "";
    const soumis = await submitEventForApproval(fd({ id }));
    expect(soumis.ok, soumis.ok ? "" : soumis.error).toBe(true);
  } else {
    const cree = await createCongressRequest(undefined, fd({ type: nature, name: `${TAG}${nature}-${qui}-${budget}`, estimatedBudget: String(budget), date: "2026-11-02", startDate: "2026-11-02", endDate: "2026-11-04" }));
    expect(cree.ok, cree.ok ? "" : cree.error).toBe(true);
    id = cree.ok ? cree.id! : "";
  }
  await lier(ENTITE[nature], id, definitionId);
  return id;
}

/** Approuve par l'ACTION du panneau, avec exactement les champs donnés. */
async function approuver(qui: string, entityType: ET, entityId: string, champs: { amount?: number; budgetCategoryId?: string } = {}) {
  await comme(qui);
  const f: Record<string, string> = { entityType, entityId, action: "APPROVE", note: "Accord du banc" };
  if (champs.amount != null) f.amount = String(champs.amount);
  if (champs.budgetCategoryId) f.budgetCategoryId = champs.budgetCategoryId;
  return advanceWorkflow(fd(f));
}

/** Ce que la demande a réellement produit : budget accordé, catégorie, pièce financière. */
async function constat(entityType: ET, id: string) {
  const inst = await instanceDe(entityType, id);
  const sel = { requestStatus: true, finalAmount: true, expenseOrderId: true } as const;
  const ligne = entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUniqueOrThrow({ where: { id }, select: sel })
    : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUniqueOrThrow({ where: { id }, select: sel })
      : await prisma.event.findUniqueOrThrow({ where: { id }, select: sel });
  const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: id }, select: { amount: true, budgetCategoryId: true } });
  // Une déclaration née APRÈS l'ordre (aucun pharmacien actif, Direction 10/2026) PORTE cet ordre : elle
  // n'engage rien de plus — seule compte celle qui engage la dépense à la place de l'ordre.
  const declarations = (await prisma.medicalInfoDeclaration.findMany({ where: { sourceId: id }, select: { amount: true, budgetCategoryId: true, expenseOrderId: true } }))
    .filter((d) => !d.expenseOrderId);
  return { inst, ligne, ordres, declarations };
}

suite("Route coupée — l'étape qui conclut la demande d'un rang 2 fixe le montant et la catégorie", () => {
  beforeAll(async () => {
    const crees = await Promise.all(Object.entries(ROLES).map(([qui, role]) =>
      prisma.user.create({ data: { name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role, passwordHash: "x" } })));
    Object.keys(ROLES).forEach((qui, i) => { ids[qui] = crees[i]!.id; });
    const [env, reglages] = await Promise.all([
      prisma.budgetEnvelope.create({
        data: {
          name: `${TAG}Ad&Pro`, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000, isActive: true,
          modules: ["CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS"], accessUserIds: Object.values(ids),
          categories: { create: [{ name: `${TAG}Congrès`, module: "CONGRESS_INTERNATIONAL", allocated: 5_000_000 }] },
        },
        include: { categories: true },
      }),
      getAppSettings(),
    ]);
    catId = env.categories[0]!.id;
    SEUIL = reglages.adProDgThreshold;
  });

  afterAll(async () => {
    const instances = await prisma.workflowInstance.findMany({ where: { definitionId: { in: CIRCUITS } }, select: { id: true, entityId: true } });
    const entites = instances.map((i) => i.entityId);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: entites } }, select: { id: true } });
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: entites } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: entites } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: instances.map((i) => i.id) } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: instances.map((i) => i.id) } } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { id: { in: CIRCUITS } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }).catch(() => {});
  });

  it("PRÉMISSES : deux demandeurs de rang 2 sans vue globale, et une définition où la Direction des opérations ne fixe RIEN", async () => {
    expect(hasGlobalView({ role: "PRODUCT_MANAGER" }), "Direction Marketing n'a pas la vue globale").toBe(false);
    expect(hasGlobalView({ role: "MEDICAL_PROMOTION_MANAGER" }), "le Manager Promotion médicale non plus").toBe(false);
    expect(SEUIL, "le seuil du DG se lit dans les réglages").toBeGreaterThan(0);
    // SANS CETTE PRÉMISSE, LE BANC NE MESURERAIT RIEN : si la définition donnait déjà le montant à la
    // Direction des opérations, l'héritage ne jouerait pas, et chaque cas passerait sans lui.
    const def = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: await circuit("CONGRESS_INTERNATIONAL") }, include: { steps: true } });
    const final = def.steps.find((s) => s.slug === "final")!;
    expect([final.requireAmount, final.requireCategory, final.powers.includes("SET_AMOUNT"), final.powers.includes("SET_CATEGORY")]).toEqual([false, false, false, false]);
    const marketing = def.steps.find((s) => s.slug === "marketing")!;
    expect([marketing.requireAmount, marketing.requireCategory]).toEqual([true, true]);
  });

  for (const nature of ["INTL", "NATIONAL", "EVENT"] as const) {
    for (const qui of ["pm", "mpm"] as const) {
      it(`${LIBELLE[nature]} déposé par ${qui === "pm" ? "Direction Marketing" : "le Manager Promotion médicale"} : la Direction des opérations tranche ET fixe le budget — accordé, dépense engagée`, async () => {
        const entityType = ENTITE[nature];
        const id = await deposer(nature, qui, Math.round(SEUIL / 2));
        const avant = await instanceDe(entityType, id);
        expect(avant.finalSlug, "PRÉMISSE : sa route s'arrête chez la Direction des opérations").toBe("final");
        expect(avant.currentSlug, "PRÉMISSE : la porte du DG est franchie sous le seuil").toBe("final");

        // UN ACCORD SANS MONTANT N'EST PLUS UN ACCORD : c'est exactement ce qui sortait avant, en silence.
        const sansMontant = await approuver("dir", entityType, id, { budgetCategoryId: catId });
        expect(sansMontant.ok, "sans montant, la Direction des opérations ne tranche plus").toBe(false);
        expect(sansMontant.ok ? "" : sansMontant.error).toMatch(/montant est obligatoire/);
        const sansCategorie = await approuver("dir", entityType, id, { amount: Math.round(SEUIL / 3) });
        expect(sansCategorie.ok, "sans catégorie non plus").toBe(false);
        expect(sansCategorie.ok ? "" : sansCategorie.error).toMatch(/catégorie budgétaire est obligatoire/);
        expect((await instanceDe(entityType, id)).status, "les deux refus n'ont rien fait avancer").toBe("IN_PROGRESS");
        expect(await prisma.expenseOrder.count({ where: { sourceId: id } }), "et rien n'a été engagé").toBe(0);

        const accorde = Math.round(SEUIL / 3);
        const r = await approuver("dir", entityType, id, { amount: accorde, budgetCategoryId: catId });
        expect(r.ok, r.ok ? "" : r.error).toBe(true);
        const { inst, ligne, ordres, declarations } = await constat(entityType, id);
        expect(inst.status).toBe("APPROVED");
        expect(ligne.requestStatus).toBe("APPROVED");
        expect(Number(ligne.finalAmount), "le budget accordé est celui que la Direction des opérations a fixé").toBe(accorde);
        expect(inst.budgetCategoryId, "et la catégorie qu'elle a choisie").toBe(catId);
        expect(ordres.length + declarations.length, "la dépense est ENGAGÉE — un ordre, ou une déclaration à l'information médicale").toBe(1);
        const piece = ordres[0] ?? declarations[0]!;
        expect(Number(piece.amount)).toBe(accorde);
        expect(piece.budgetCategoryId).toBe(catId);
      });
    }
  }

  it("AU-DESSUS DU SEUIL, le DG valide sans chiffrer — seule l'étape qui CONCLUT hérite des pouvoirs d'argent", async () => {
    const id = await deposer("INTL", "pm", Math.round(SEUIL * 1.5));
    expect((await instanceDe("CONGRESS_INTERNATIONAL", id)).currentSlug, "PRÉMISSE : au-dessus du seuil, la porte du DG reste ouverte").toBe("dg");
    // Ce qui le ferait tomber : hériter à une étape qui NE conclut PAS — le DG se verrait exiger un
    // montant qu'il n'a pas à fixer, et la demande resterait à sa porte.
    const porte = await approuver("gm", "CONGRESS_INTERNATIONAL", id);
    expect(porte.ok, porte.ok ? "" : porte.error).toBe(true);
    const montant = Math.round(SEUIL * 1.2);
    const r = await approuver("dir", "CONGRESS_INTERNATIONAL", id, { amount: montant, budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { ligne, ordres, declarations } = await constat("CONGRESS_INTERNATIONAL", id);
    expect(Number(ligne.finalAmount)).toBe(montant);
    expect(ordres.length + declarations.length).toBe(1);
  });

  it("LE TÉMOIN : le même congrès déposé par un KAM — Direction Marketing tranche avec SES pouvoirs, rien n'est hérité", async () => {
    const id = await deposer("INTL", "kam", Math.round(SEUIL / 2));
    expect((await approuver("ns", "CONGRESS_INTERNATIONAL", id)).ok).toBe(true);
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", id);
    expect(inst.currentSlug).toBe("marketing");
    const def = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: inst.definitionId }, include: { steps: true } });
    const marketing = def.steps.find((s) => s.slug === "marketing")!;
    expect(lectureDeLApprobation(def, marketing, inst.finalSlug, inst.skippedSlugs).etape, "l'étape qui tranche porte déjà l'argent : elle reste ELLE-MÊME").toBe(marketing);
    const r = await approuver("pm", "CONGRESS_INTERNATIONAL", id, { amount: 250_000, budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { ligne, ordres, declarations } = await constat("CONGRESS_INTERNATIONAL", id);
    expect(Number(ligne.finalAmount)).toBe(250_000);
    expect(ordres.length + declarations.length).toBe(1);
  });

  it("UNE ÉTAPE CONFIGURÉE À LA MAIN garde sa configuration : la Direction des opérations « fixe un montant » sans l'exiger — rien n'y est ajouté", async () => {
    // Le Super Admin a donné à la Direction des opérations le pouvoir de fixer un montant, sans
    // l'exiger ni la catégorie. C'est SA décision pour cette étape : l'héritage n'y fusionne pas les
    // exigences de Direction Marketing (§118.16). Ce qui le ferait tomber : fusionner au lieu de
    // s'abstenir — l'approbation sans montant serait refusée.
    const retouche = await circuit("CONGRESS_INTERNATIONAL", (s) => (s.slug === "final" ? { ...s, powers: [...s.powers, "SET_AMOUNT"] } : s));
    const id = await deposer("INTL", "pm", Math.round(SEUIL / 2), retouche);
    const r = await approuver("dir", "CONGRESS_INTERNATIONAL", id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", id)).status).toBe("APPROVED");
  });

  it("LE SPONSORING EN EST EXEMPT : sa décision pré-valide la TENUE sans argent — rien à hériter, la tenue reste pré-validée", async () => {
    // Le sponsoring d'un rang 2 conclut chez la Direction des opérations comme les trois autres
    // natures ; mais l'étape qu'elle remplace ne fixe aucun argent (§118.151). Ce qui le ferait
    // tomber : exiger un montant ici — l'argent d'un sponsoring se fixe à la clôture, poste par poste.
    const init = adProInit({ role: "PRODUCT_MANAGER" }, "SPONSORING", null);
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO`, institution: `${TAG}Société savante`, type: "Association", requesterId: ids.pm!, status: init.status as "PRELIMINARY_APPROVED", amountRequested: Math.round(SEUIL / 2) },
    });
    const inst = await lier("SPONSORING", spo.id);
    expect(inst.currentSlug, "PRÉMISSE : la route s'arrête chez la Direction des opérations").toBe("final");
    const r = await approuver("dir", "SPONSORING", spo.id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ligne = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo.id } });
    expect(ligne.status).toBe("PRE_VALIDATED");
    expect(ligne.amountGranted, "aucun montant accordé avant la clôture").toBeNull();
  });

  it("…SAUF si le Super Admin a laissé l'argent à Direction Marketing : l'étape qui conclut l'hérite et ACCORDE, comme celle qu'elle remplace", async () => {
    // Un circuit de sponsoring REMODELÉ, où la décision fixe encore l'argent (l'ancienne règle) :
    // `issueTerminaleSponsoring` lit la configuration — et c'est l'étape TELLE QU'ELLE DÉCIDE qu'il
    // faut lui donner, sinon la tenue serait « pré-validée » alors qu'un montant vient d'être exigé.
    const retouche = await circuit("SPONSORING", (s) => (s.slug === "marketing"
      ? { ...s, powers: ["APPROVE", "REJECT", "SET_AMOUNT", "SET_CATEGORY", "COMMENT"], requireAmount: true, requireCategory: true, emitExpenseOrder: true }
      : s));
    const init = adProInit({ role: "PRODUCT_MANAGER" }, "SPONSORING", null);
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO2`, institution: `${TAG}Société remodelée`, type: "Association", requesterId: ids.pm!, status: init.status as "PRELIMINARY_APPROVED", amountRequested: Math.round(SEUIL / 2) },
    });
    await lier("SPONSORING", spo.id, retouche);
    const sansMontant = await approuver("dir", "SPONSORING", spo.id, { budgetCategoryId: catId });
    expect(sansMontant.ok, "l'argent se fixe ici, donc il s'exige ici").toBe(false);
    const montant = Math.round(SEUIL / 4);
    const r = await approuver("dir", "SPONSORING", spo.id, { amount: montant, budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ligne = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo.id } });
    expect(ligne.status, "l'étape fixe l'argent : elle accorde").toBe("APPROVED");
    expect(Number(ligne.amountGranted)).toBe(montant);
    const notif = await prisma.notification.findFirst({ where: { userId: ids.pm!, link: { contains: spo.id } }, orderBy: { createdAt: "desc" } });
    expect(notif?.title, "le demandeur lit un accord, pas une tenue pré-validée").toMatch(/pris en charge/);
  });

  it("L'ÉCRAN de la Direction des opérations OFFRE le montant et la catégorie — et l'écran du DG, qui ne conclut pas, ne les offre pas", async () => {
    // Un champ exigé que le panneau ne montre pas serait un bouton offert puis refusé (§118.83) :
    // l'écran lit la MÊME réponse que le moteur (`lectureDeLApprobation`).
    const id = await deposer("NATIONAL", "mpm", Math.round(SEUIL * 1.5));
    const vueDg = (await getWorkflowForEntity(await actorFor("gm"), "CONGRESS_NATIONAL", id, null))!;
    expect(vueDg.action?.slug, "PRÉMISSE : la demande est à la porte du DG").toBe("dg");
    expect([vueDg.action?.requireAmount, vueDg.action?.powers.includes("SET_AMOUNT")], "le DG ne fixe pas le budget").toEqual([false, false]);
    expect((await approuver("gm", "CONGRESS_NATIONAL", id)).ok).toBe(true);

    const vue = (await getWorkflowForEntity(await actorFor("dir"), "CONGRESS_NATIONAL", id, null))!;
    expect(vue.action?.slug, "PRÉMISSE : la Direction des opérations a la main").toBe("final");
    expect(vue.action?.requireAmount, "le montant est demandé, et obligatoire").toBe(true);
    expect(vue.action?.requireCategory, "la catégorie aussi").toBe(true);
    expect(vue.action?.powers).toEqual(expect.arrayContaining(["SET_AMOUNT", "SET_CATEGORY"]));
    expect(vue.budgetCategories.map((c) => c.id), "et ses catégories sont proposées").toContain(catId);

    // L'écran joué tel qu'il se présente : il offre les champs, on les remplit, la dépense part.
    const r = await approuver("dir", "CONGRESS_NATIONAL", id, { amount: Math.round(SEUIL * 1.1), budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { ordres, declarations } = await constat("CONGRESS_NATIONAL", id);
    expect(ordres.length + declarations.length).toBe(1);
  });
});
