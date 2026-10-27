import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

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
 * LA ROUTE DU RANG 2 DEPUIS LE 27/10/2026 — plus de route coupée, plus d'argent sur la demande.
 *
 *   pm    Direction Marketing (rôle PRODUCT_MANAGER, SANS vue globale) : sa demande est
 *         prévalidée D'OFFICE à la naissance de l'instance ; elle prévalide celle des autres
 *   mpm   Manager Promotion médicale (rang 2, sans vue globale) : il n'est PAS la Direction
 *         Marketing — sa demande passe par le Directeur des opérations, puis la prévalidation
 *   kam   délégué médical : le TÉMOIN — National Sales, Directeur des opérations, prévalidation
 *   ns    National Sales : le préliminaire du KAM
 *   gm    Directeur Général : il n'est plus une étape — il valide le TOTAL des postes, à la fin
 *   od    Directeur des opérations : l'étape `final`, qui ne fixe aucun argent
 *
 * L'HISTOIRE DE CE BANC. Avant le 27/10/2026, la demande d'un rang 2 s'arrêtait chez la Direction
 * des opérations, qui héritait des pouvoirs d'argent de la Direction Marketing (§118.197g) : 12
 * demandes sur 12 sortaient approuvées sans budget avant cette réparation. La règle du 27/10/2026
 * retire l'argent de la demande ENTIÈRE : la Direction Marketing PRÉVALIDE (le fond et le montant
 * demandé), les postes portent la dépense, et le DG valide leur total au-dessus du seuil. Ce banc
 * prouve donc l'inverse de ce qu'il prouvait : AUCUNE étape du circuit par défaut ne fixe un
 * montant, n'exige une catégorie ni n'émet d'ordre global — et un circuit REMODELÉ à la main, où
 * la prévalidation fixe encore l'argent, garde le comportement d'avant (l'héritage reste éprouvé).
 *
 * Les demandes naissent par les vraies actions de création (qui ouvrent le circuit,
 * `ouvrirLeCircuit`) ; leur circuit est ensuite une COPIE PRIVÉE de la colonne vertébrale par défaut
 * (même raison que `renvoi-flow.test.ts` : un banc voisin réécrit le circuit partagé le temps d'un
 * cas). Les montants se lisent contre le seuil RÉEL des réglages.
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
  ns: "NATIONAL_SALES", gm: "GENERAL_MANAGER", od: "OPERATIONS_DIRECTOR",
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

suite("La route du rang 2 (27/10/2026) — la Direction Marketing prévalide, aucune étape ne fixe l'argent de la demande", () => {
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

  it("PRÉMISSES : deux demandeurs de rang 2 sans vue globale, et une définition où AUCUNE étape ne fixe d'argent", async () => {
    expect(hasGlobalView({ role: "PRODUCT_MANAGER" }), "Direction Marketing n'a pas la vue globale").toBe(false);
    expect(hasGlobalView({ role: "MEDICAL_PROMOTION_MANAGER" }), "le Manager Promotion médicale non plus").toBe(false);
    expect(SEUIL, "le seuil du DG se lit dans les réglages").toBeGreaterThan(0);
    // SANS CETTE PRÉMISSE, LE BANC NE MESURERAIT RIEN : une étape qui fixerait encore l'argent
    // ferait passer les cas « sans montant » pour la mauvaise raison.
    const def = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: await circuit("CONGRESS_INTERNATIONAL") }, include: { steps: true } });
    for (const st of def.steps) {
      expect([st.requireAmount, st.requireCategory, st.powers.includes("SET_AMOUNT"), st.powers.includes("SET_CATEGORY"), st.emitExpenseOrder], st.slug)
        .toEqual([false, false, false, false, false]);
    }
    expect(def.steps.find((s) => s.slug === "final")!.actorRoles, "l'étape `final` est celle du Directeur des opérations").toEqual(["OPERATIONS_DIRECTOR"]);
    expect(def.steps.find((s) => s.slug === "marketing")!.emitDeclaration, "la déclaration part à la prévalidation").toBe(true);
  });

  for (const nature of ["INTL", "NATIONAL", "EVENT"] as const) {
    it(`${LIBELLE[nature]} déposé par Direction Marketing : prévalidé D'OFFICE à la création — aucun montant, aucun ordre global`, async () => {
      // Ce qui le ferait tomber : l'ancienne route coupée (la Direction des opérations tranchait à
      // sa place, montant et catégorie compris) — ou une demande qui attendrait que la Direction
      // Marketing se prévalide elle-même.
      const entityType = ENTITE[nature];
      const id = await deposer(nature, "pm", Math.round(SEUIL / 2));
      const { inst, ligne, ordres } = await constat(entityType, id);
      expect(inst.status, "prévalidée dès la naissance").toBe("APPROVED");
      expect(inst.finalSlug, "plus de borne").toBeNull();
      expect(inst.skippedSlugs).toEqual(["preliminary", "dg", "final"]);
      expect(ligne.requestStatus).toBe("APPROVED");
      expect(ligne.finalAmount, "aucun montant accordé : l'argent se décide poste par poste").toBeNull();
      expect(ordres.length, "aucun ordre GLOBAL").toBe(0);
      const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, stepSlug: "marketing", action: "APPROVE" } });
      expect(ev?.actorId, "au nom de sa créatrice").toBe(ids.pm);
      expect(ev?.note).toMatch(/^Prévalidée d'office/);
      if (nature === "EVENT") {
        const ev2 = await prisma.event.findUniqueOrThrow({ where: { id }, select: { status: true } });
        expect(ev2.status, "l'état de vie suit le circuit").toBe("VALIDATED");
      }
    });

    it(`${LIBELLE[nature]} déposé par le Manager Promotion médicale : Directeur des opérations, puis prévalidation — sans montant ni ordre global`, async () => {
      // Le Manager Promotion médicale est de rang 2 mais n'est PAS la Direction Marketing : rien ne
      // le prévalide d'office. Ce qui le ferait tomber : la prévalidation d'office étendue au rang 2
      // entier — ou l'ancienne route coupée, qui exigeait un montant au Directeur des opérations.
      const entityType = ENTITE[nature];
      const id = await deposer(nature, "mpm", Math.round(SEUIL / 2));
      const avant = await instanceDe(entityType, id);
      expect(avant.finalSlug, "PRÉMISSE : plus de borne").toBeNull();
      expect(avant.currentSlug, "PRÉMISSE : son N+1, le Directeur des opérations").toBe("final");
      expect(avant.skippedSlugs).toEqual(["preliminary", "dg"]);

      const tropTot = await approuver("pm", entityType, id);
      expect(tropTot.ok, "la Direction Marketing attend son tour").toBe(false);
      const od = await approuver("od", entityType, id);
      expect(od.ok, od.ok ? "" : od.error).toBe(true);
      expect((await instanceDe(entityType, id)).currentSlug).toBe("marketing");
      expect(await prisma.expenseOrder.count({ where: { sourceId: id } }), "rien n'est engagé avant la prévalidation").toBe(0);

      const r = await approuver("pm", entityType, id);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const { inst, ligne, ordres } = await constat(entityType, id);
      expect(inst.status).toBe("APPROVED");
      expect(ligne.requestStatus).toBe("APPROVED");
      expect(ligne.finalAmount, "aucun montant écrit").toBeNull();
      expect(ordres.length, "aucun ordre GLOBAL : les postes portent la dépense").toBe(0);
      expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: id } }), "la déclaration d'information médicale part").toBe(1);
    });
  }

  it("AU-DESSUS DU SEUIL, le DG n'est PLUS une étape : la demande va au Directeur des opérations, quel que soit le montant", async () => {
    // Ce qui le ferait tomber : la porte du DG laissée sur la route — un DG qui validerait la
    // DEMANDE alors que la règle lui donne le TOTAL de ses postes, à la fin.
    const id = await deposer("INTL", "mpm", Math.round(SEUIL * 1.5));
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", id);
    expect(inst.currentSlug, "la porte du DG est dans le tamis").toBe("final");
    const porte = await approuver("gm", "CONGRESS_INTERNATIONAL", id);
    expect(porte.ok, "le DG n'a rien à valider ici").toBe(false);
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, stepSlug: "dg" } }), "rien n'est tracé sur la porte du DG").toBe(0);
  });

  it("LE TÉMOIN : le même congrès déposé par un KAM — National Sales, Directeur des opérations, prévalidation ; rien n'est hérité", async () => {
    const id = await deposer("INTL", "kam", Math.round(SEUIL / 2));
    expect((await approuver("ns", "CONGRESS_INTERNATIONAL", id)).ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", id)).currentSlug, "le second filtre du délégué").toBe("final");
    expect((await approuver("od", "CONGRESS_INTERNATIONAL", id)).ok).toBe(true);
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", id);
    expect(inst.currentSlug).toBe("marketing");
    const def = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: inst.definitionId }, include: { steps: true } });
    const marketing = def.steps.find((s) => s.slug === "marketing")!;
    expect(lectureDeLApprobation(def, marketing, inst.finalSlug, inst.skippedSlugs).etape, "rien à hériter de la porte du DG : l'étape reste ELLE-MÊME").toBe(marketing);
    const r = await approuver("pm", "CONGRESS_INTERNATIONAL", id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { ligne, ordres } = await constat("CONGRESS_INTERNATIONAL", id);
    expect(ligne.requestStatus).toBe("APPROVED");
    expect(ligne.finalAmount).toBeNull();
    expect(ordres.length).toBe(0);
  });

  it("UN CIRCUIT REMODELÉ où la prévalidation fixe encore l'argent garde son comportement d'avant : montant et catégorie exigés, demande ACCORDÉE, dépense engagée", async () => {
    // « Un circuit dont l'étape qui conclut fixe encore un montant (remodelé à la main) garde son
    // comportement d'avant » (engine.ts). C'est la décision du Super Admin pour CE circuit.
    const retouche = await circuit("CONGRESS_INTERNATIONAL", (s) => (s.slug === "marketing"
      ? { ...s, powers: ["APPROVE", "REJECT", "SET_AMOUNT", "SET_CATEGORY", "COMMENT"], requireAmount: true, requireCategory: true, emitExpenseOrder: true }
      : s));
    const id = await deposer("INTL", "mpm", Math.round(SEUIL / 2), retouche);
    expect((await approuver("od", "CONGRESS_INTERNATIONAL", id)).ok).toBe(true);
    const sansMontant = await approuver("pm", "CONGRESS_INTERNATIONAL", id, { budgetCategoryId: catId });
    expect(sansMontant.ok, "l'argent se fixe ici, donc il s'exige ici").toBe(false);
    expect(sansMontant.ok ? "" : sansMontant.error).toMatch(/montant est obligatoire/);
    const sansCategorie = await approuver("pm", "CONGRESS_INTERNATIONAL", id, { amount: Math.round(SEUIL / 3) });
    expect(sansCategorie.ok ? "" : sansCategorie.error).toMatch(/catégorie budgétaire est obligatoire/);
    const accorde = Math.round(SEUIL / 3);
    const r = await approuver("pm", "CONGRESS_INTERNATIONAL", id, { amount: accorde, budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { inst, ligne, ordres, declarations } = await constat("CONGRESS_INTERNATIONAL", id);
    expect(inst.status).toBe("APPROVED");
    expect(Number(ligne.finalAmount), "le budget accordé est celui que la Direction Marketing a fixé").toBe(accorde);
    expect(inst.budgetCategoryId).toBe(catId);
    expect(ordres.length + declarations.length, "la dépense est ENGAGÉE — un ordre, ou une déclaration à l'information médicale").toBe(1);
    const piece = ordres[0] ?? declarations[0]!;
    expect(Number(piece.amount)).toBe(accorde);
  });

  it("LE SPONSORING : la Direction Marketing pré-valide la TENUE — d'office pour sa propre demande, après le Directeur des opérations pour le Manager Promotion médicale", async () => {
    // Ce qui le ferait tomber : exiger un montant ici — l'argent d'un sponsoring se fixe poste par
    // poste, puis à la clôture (§118.151).
    const creer = async (qui: "pm" | "mpm", ref: string) => {
      const role = ROLES[qui]!;
      const init = adProInit({ role }, "SPONSORING", null);
      return prisma.sponsoringRequest.create({
        data: { reference: `${TAG}${ref}`, institution: `${TAG}Société ${ref}`, type: "Association", requesterId: ids[qui]!, status: init.status as "PRELIMINARY_APPROVED", amountRequested: Math.round(SEUIL / 2) },
      });
    };
    const spoPm = await creer("pm", "SPO-DM");
    const instPm = await lier("SPONSORING", spoPm.id);
    expect(instPm.status, "prévalidée d'office").toBe("APPROVED");
    const lignePm = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoPm.id } });
    expect(lignePm.status).toBe("PRE_VALIDATED");
    expect(lignePm.amountGranted, "aucun montant accordé avant la clôture").toBeNull();

    const spoMpm = await creer("mpm", "SPO-MPM");
    const instMpm = await lier("SPONSORING", spoMpm.id);
    expect(instMpm.currentSlug, "PRÉMISSE : le Directeur des opérations d'abord").toBe("final");
    expect((await approuver("od", "SPONSORING", spoMpm.id)).ok).toBe(true);
    const r = await approuver("pm", "SPONSORING", spoMpm.id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ligne = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoMpm.id } });
    expect(ligne.status).toBe("PRE_VALIDATED");
    expect(ligne.amountGranted).toBeNull();
    const notif = await prisma.notification.findFirst({ where: { userId: ids.mpm!, link: { contains: spoMpm.id } }, orderBy: { createdAt: "desc" } });
    expect(notif?.title, "le demandeur lit ce qui l'attend — les postes").toMatch(/prévalidée : les postes se préparent/);
  });

  it("…SAUF si le Super Admin a laissé l'argent à Direction Marketing : l'étape ACCORDE, comme avant", async () => {
    // Un circuit de sponsoring REMODELÉ, où la décision fixe encore l'argent (l'ancienne règle) :
    // `issueTerminaleSponsoring` lit la configuration de l'étape TELLE QU'ELLE DÉCIDE.
    const retouche = await circuit("SPONSORING", (s) => (s.slug === "marketing"
      ? { ...s, powers: ["APPROVE", "REJECT", "SET_AMOUNT", "SET_CATEGORY", "COMMENT"], requireAmount: true, requireCategory: true, emitExpenseOrder: true }
      : s));
    const init = adProInit({ role: "MEDICAL_PROMOTION_MANAGER" }, "SPONSORING", null);
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO2`, institution: `${TAG}Société remodelée`, type: "Association", requesterId: ids.mpm!, status: init.status as "PRELIMINARY_APPROVED", amountRequested: Math.round(SEUIL / 2) },
    });
    await lier("SPONSORING", spo.id, retouche);
    expect((await approuver("od", "SPONSORING", spo.id)).ok).toBe(true);
    const sansMontant = await approuver("pm", "SPONSORING", spo.id, { budgetCategoryId: catId });
    expect(sansMontant.ok, "l'argent se fixe ici, donc il s'exige ici").toBe(false);
    const montant = Math.round(SEUIL / 4);
    const r = await approuver("pm", "SPONSORING", spo.id, { amount: montant, budgetCategoryId: catId });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ligne = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo.id } });
    expect(ligne.status, "l'étape fixe l'argent : elle accorde").toBe("APPROVED");
    expect(Number(ligne.amountGranted)).toBe(montant);
    const notif = await prisma.notification.findFirst({ where: { userId: ids.mpm!, link: { contains: spo.id } }, orderBy: { createdAt: "desc" } });
    expect(notif?.title, "le demandeur lit un accord, pas une tenue pré-validée").toMatch(/pris en charge/);
  });

  it("L'ÉCRAN n'OFFRE ni montant ni catégorie — ni au Directeur des opérations, ni à la prévalidation ; le DG n'a aucune action", async () => {
    // Un champ offert que le moteur ignorerait serait un mensonge d'écran ; un champ exigé que le
    // panneau ne montre pas, un bouton offert puis refusé (§118.83). L'écran lit la MÊME réponse que
    // le moteur (`lectureDeLApprobation`).
    const id = await deposer("NATIONAL", "mpm", Math.round(SEUIL * 1.5));
    const vueDg = (await getWorkflowForEntity(await actorFor("gm"), "CONGRESS_NATIONAL", id, null))!;
    expect(vueDg.action ?? null, "le DG n'a rien à faire sur la demande").toBeNull();

    const vueOd = (await getWorkflowForEntity(await actorFor("od"), "CONGRESS_NATIONAL", id, null))!;
    expect(vueOd.action?.slug, "PRÉMISSE : le Directeur des opérations a la main").toBe("final");
    expect([vueOd.action?.requireAmount, vueOd.action?.powers.includes("SET_AMOUNT")]).toEqual([false, false]);
    expect((await approuver("od", "CONGRESS_NATIONAL", id)).ok).toBe(true);

    const vue = (await getWorkflowForEntity(await actorFor("pm"), "CONGRESS_NATIONAL", id, null))!;
    expect(vue.action?.slug, "PRÉMISSE : la Direction Marketing a la main").toBe("marketing");
    expect(vue.action?.requireAmount, "aucun montant à la prévalidation").toBe(false);
    expect(vue.action?.requireCategory, "aucune catégorie non plus").toBe(false);
    expect(vue.action?.powers).not.toEqual(expect.arrayContaining(["SET_AMOUNT"]));
    expect(vue.action?.powers).not.toEqual(expect.arrayContaining(["SET_CATEGORY"]));

    // L'écran joué tel qu'il se présente : on approuve, rien n'est engagé.
    const r = await approuver("pm", "CONGRESS_NATIONAL", id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const { ordres } = await constat("CONGRESS_NATIONAL", id);
    expect(ordres.length).toBe(0);
  });
});
