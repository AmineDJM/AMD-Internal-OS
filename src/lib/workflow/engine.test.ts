import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { advanceWorkflowInstance, ensureInstance, getDefinition, orderedSteps, ouvrirLeCircuit } from "./engine";
import { defaultDefinition } from "./defaults";
import { getWorkflowForEntity } from "@/lib/queries/workflow";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__wftest__";
const viewer = (id: string, role: UserRole) => ({ id, role, secondaryRole: null, name: role });
const asSession = (id: string, role: UserRole): SessionUser => ({ id, role, secondaryRole: null, access: { modules: new Map(), rowGrants: new Map(), secondaryRole: null } });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT DU 27/10/2026 — par le VRAI moteur, une chaîne par branche du parcours.
 *
 * « Peu importe le créateur, la demande passe d'abord par son N+1 — le National Sales si c'est un
 * délégué, sinon le Directeur des opérations —, puis la Direction Marketing, qui PRÉVALIDE. » La
 * prévalidation ne fixe ni montant ni catégorie et n'émet aucun ordre global : les postes portent
 * la dépense, et le DG valide leur TOTAL à la fin, au-dessus du seuil (`ad-pro/porte-dg.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Moteur — le parcours d'un délégué (KAM) : National Sales → Directeur des opérations → Direction Marketing, qui PRÉVALIDE", () => {
  let nsId = "", pmId = "", odId = "", dgId = "", delegId = "", otherId = "", congressId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, pm, od, gm, dg, ot] = await Promise.all([
      mk("ns", "NATIONAL_SALES"), mk("pm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR"), mk("gm", "GENERAL_MANAGER"),
      mk("deleg", "MEDICAL_DELEGATE"), mk("other", "SALES_USER"),
    ]);
    nsId = ns.id; pmId = pm.id; odId = od.id; dgId = gm.id; delegId = dg.id; otherId = ot.id;

    const congress = await prisma.congressInternational.create({
      data: { name: `${TAG}Congrès`, requestStatus: "AWAITING_PRELIMINARY", requesterId: delegId, estimatedBudget: 40000 },
    });
    congressId = congress.id;
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: congressId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: congressId } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("AUCUNE borne, et un TAMIS qui ne retire que la porte du DG", async () => {
    // LES DEUX FAITS (§118.142). La borne dit OÙ la chaîne s'arrête — nulle part avant la fin,
    // puisque Direction Marketing est la dernière étape. Le tamis dit ce qu'elle NE TRAVERSE PAS —
    // depuis le 27/10/2026, la seule porte du DG : le délégué a DEUX filtres hiérarchiques.
    //
    // Ce qui le ferait tomber : garder la règle du 22/09 (`final` dans le tamis) — le délégué
    // échapperait au Directeur des opérations que la Direction lui impose désormais.
    await advanceWorkflowInstance({ viewer: viewer(otherId, "SALES_USER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "COMMENT", note: "ouvre l'instance" });
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.finalSlug, "Direction Marketing prévalide, et c'est la dernière étape").toBeNull();
    expect(inst.skippedSlugs, "seule la porte du DG est hors route").toEqual(["dg"]);
    expect(inst.currentSlug).toBe("preliminary");
  });

  it("le demandeur (KAM) ne peut pas agir à l'étape préliminaire", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(delegId, "MEDICAL_DELEGATE"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE" });
    expect(r.ok).toBe(false);
  });

  it("le National Sales approuve le préliminaire — la demande va au Directeur des opérations, SANS passer par le DG", async () => {
    // La désignation exigeait de remplir une étape à portée « personne désignée » ; plus rien à
    // désigner. Et la porte du DG n'est plus franchie (ni à la main, ni par seuil) : elle n'est
    // pas SUR la route. Ce qui le ferait tomber : oublier le tamis dans `nextStepAfter` — la
    // demande se poserait devant un DG qui valide désormais le total des postes, à la fin.
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK" });
    expect(r.ok).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug, "le second filtre du délégué : le Directeur des opérations").toBe("final");
    // UNE ÉTAPE HORS ROUTE N'EST PAS « FRANCHIE » : rien n'est tracé à son nom. Ce qui le ferait
    // tomber : un AUTO_SKIP sur `dg` — le demandeur lirait qu'un DG a laissé passer sa demande.
    const traces = await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, stepSlug: "dg" } });
    expect(traces, "la porte du DG n'a RIEN à tracer").toBe(0);
    const c = await prisma.congressInternational.findUniqueOrThrow({ where: { id: congressId } });
    expect(c.requestStatus).toBe("PRELIMINARY_APPROVED");
  });

  it("ni le DG ni la Direction Marketing ne tiennent l'étape du Directeur des opérations", async () => {
    // « Il faut que ce soit lui, l'Operations Director » (27/10/2026).
    const dg = await advanceWorkflowInstance({ viewer: viewer(dgId, "GENERAL_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK DG" });
    expect(dg.ok, "le DG n'est plus une étape du circuit").toBe(false);
    const dm = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "trop tôt" });
    expect(dm.ok, "la Direction Marketing attend son tour").toBe(false);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug).toBe("final");
  });

  it("le Directeur des opérations valide SANS chiffrer — rien n'est engagé, la demande passe à la prévalidation", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "Accord du Directeur des opérations" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug).toBe("marketing");
    expect(inst.status).toBe("IN_PROGRESS");
    const c = await prisma.congressInternational.findUniqueOrThrow({ where: { id: congressId } });
    expect(c.requestStatus).toBe("AWAITING_FINAL");
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } }), "rien n'est engagé avant la prévalidation").toBe(0);
  });

  it("l'ÉCRAN d'un KAM montre SA route : National Sales, Directeur des opérations, Direction Marketing — pas le DG", async () => {
    // LE DÉFAUT LE PLUS COÛTEUX DE CET ÉCRAN, dans un sens comme dans l'autre : une frise qui
    // annonce une validation qui n'aura pas lieu, ou qui CACHE une étape que la demande devra
    // franchir. L'écran et le moteur lisent le MÊME tamis.
    const vue = await getWorkflowForEntity(asSession(delegId, "MEDICAL_DELEGATE"), "CONGRESS_INTERNATIONAL", congressId, delegId);
    expect(vue?.steps.map((st) => st.slug)).toEqual(["preliminary", "final", "marketing"]);
  });

  it("un tiers ne prévalide pas", async () => {
    const bad = await advanceWorkflowInstance({ viewer: viewer(otherId, "SALES_USER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "je valide" });
    expect(bad.ok).toBe(false);
  });

  it("Direction Marketing PRÉVALIDE sans montant ni catégorie → circuit CLÔTURÉ, demande APPROUVÉE, AUCUN ordre global, la déclaration part", async () => {
    // Ce qui le ferait tomber : l'ancienne décision à montant (montant + sous-catégorie exigés,
    // ordre de dépense global émis). Un ordre global partirait AVANT les postes, qui portent la
    // dépense — l'argent serait payé deux fois, et sans la porte du DG sur le total.
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "Prévalidée par Direction Marketing" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.status, "la prévalidation CLÔTURE le circuit").toBe("APPROVED");
    expect(inst.currentSlug).toBeNull();
    const c = await prisma.congressInternational.findUniqueOrThrow({ where: { id: congressId } });
    expect(c.requestStatus).toBe("APPROVED");
    expect(c.finalAmount, "aucun montant accordé : l'argent se décide poste par poste").toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } }), "aucun ordre GLOBAL").toBe(0);
    // L'ÉVÉNEMENT SE DÉCLARE AVANT D'AVOIR LIEU : la déclaration d'information médicale part ici.
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: congressId } }), "la déclaration est émise").toBe(1);
    const avis = await prisma.notification.findFirst({ where: { userId: delegId, title: { contains: "prévalidée : les postes se préparent" } } });
    expect(avis, "le demandeur lit ce qui l'attend — les postes, pas un financement").not.toBeNull();
  });

  it("la prévalidation est VISIBLE du demandeur — l'étape n'est pas confidentielle", async () => {
    // La vue caviardée n'expose pas le SLUG (c'est un détail de moteur) : on reconnaît l'étape
    // par son titre, celui que la définition porte réellement en base.
    const vue = await getWorkflowForEntity(asSession(delegId, "MEDICAL_DELEGATE"), "CONGRESS_INTERNATIONAL", congressId, delegId);
    const decision = vue?.events.find((e) => e.stepTitle.includes("Direction Marketing") && e.action === "APPROVE");
    expect(decision?.note).toContain("Direction Marketing");
    expect(decision?.amount ?? null, "aucun montant n'a été fixé").toBeNull();
  });

  it("le circuit clôturé refuse toute nouvelle action", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "encore" });
    expect(r.ok).toBe(false);
  });
});

const TAG1B = "__wfnonkam__";

/**
 * LA SECONDE CHAÎNE. Une chaîne qui marche ne prouve rien ; deux chaînes qui marchent prouvent le
 * moteur (§118.21). Celle-ci ne partage RIEN avec la première : un autre demandeur (hors force de
 * vente), une autre ENTRÉE (le Directeur des opérations, posée DÈS LA NAISSANCE de l'instance
 * alors que son statut legacy désigne d'abord la porte du DG), un TAMIS de deux étapes.
 *
 * « Si c'est quelqu'un d'AUTRE, son N+1 est le Directeur des opérations » (27/10/2026) — l'ancien
 * « direct chez la Direction Marketing » (22/09/2026) n'existe plus.
 */
suite("Moteur — le parcours d'un demandeur ORDINAIRE : Directeur des opérations → Direction Marketing", () => {
  let pmId = "", odId = "", reqId = "", congressId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG1B}${s}`, email: `${TAG1B}${s}@t.dz`, role, passwordHash: "x" } });
    const [pm, od, req] = await Promise.all([mk("pm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR"), mk("req", "DIRECTION_ASSISTANT")]);
    pmId = pm.id; odId = od.id; reqId = req.id;
    const c = await prisma.congressInternational.create({
      data: { name: `${TAG1B}Congrès`, requestStatus: "PRELIMINARY_APPROVED", requesterId: reqId, estimatedBudget: 60000 },
    });
    congressId = c.id;
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: congressId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: congressId } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG1B } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG1B } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG1B } } }).catch(() => {});
  });

  it("LA DEMANDE NAÎT CHEZ LE DIRECTEUR DES OPÉRATIONS — jamais posée sur la porte du DG hors route", async () => {
    // LE DÉFAUT QUE CE CAS FERME. Le statut legacy « préliminaire faite » désigne la PREMIÈRE
    // étape qui le porte — la porte du DG. Elle n'est plus sur la route : la demande s'y serait
    // posée devant un DG qui n'a rien à y valider, sans une étape en échec (§118.113).
    const vue = await getWorkflowForEntity(asSession(reqId, "DIRECTION_ASSISTANT"), "CONGRESS_INTERNATIONAL", congressId, reqId);
    expect(vue?.currentSlug, "posée sur la première étape réellement traversée").toBe("final");
    // L'ÉCRAN NE MONTRE QUE SA ROUTE : deux étapes sur quatre.
    expect(vue?.steps.map((st) => st.slug)).toEqual(["final", "marketing"]);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.finalSlug, "aucune borne : la dernière étape conclut").toBeNull();
    expect(inst.skippedSlugs, "ni superviseur national, ni porte du DG").toEqual(["preliminary", "dg"]);
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, stepSlug: "dg" } }), "rien n'est tracé sur une étape hors route").toBe(0);
  });

  it("LA DIRECTION MARKETING N'A RIEN À PRÉVALIDER AVANT LE DIRECTEUR DES OPÉRATIONS", async () => {
    // Ce qui le ferait tomber : l'ancien « direct chez la Direction Marketing » — la demande
    // échapperait au N+1 que la Direction impose à tout demandeur hors délégué.
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "trop tôt" });
    expect(r.ok).toBe(false);
    const ok = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK" });
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug).toBe("marketing");
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } })).toBe(0);
  });

  it("DIRECTION MARKETING PRÉVALIDE : demande approuvée, aucun montant écrit, aucun ordre global", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "Prévalidée" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.status, "la prévalidation CLÔTURE le circuit").toBe("APPROVED");
    const c = await prisma.congressInternational.findUniqueOrThrow({ where: { id: congressId } });
    expect(c.requestStatus).toBe("APPROVED");
    expect(c.finalAmount).toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } })).toBe(0);
  });

  it("la prévalidation se LIT — l'étape n'est pas confidentielle", async () => {
    const vue = await getWorkflowForEntity(asSession(reqId, "DIRECTION_ASSISTANT"), "CONGRESS_INTERNATIONAL", congressId, reqId);
    const decision = vue?.events.find((e) => e.stepTitle.includes("Direction Marketing") && e.action === "APPROVE");
    expect(decision?.note).toBe("Prévalidée");
  });
});

const TAG1C = "__wfns__";

/**
 * LA TROISIÈME CHAÎNE — le National Sales lui-même : « si c'est LUI-MÊME, ça passe par le
 * directeur des opérations » (22/09/2026), et c'est resté vrai le 27/10/2026. Son propre
 * préliminaire n'a pas d'objet ; la porte du DG non plus.
 */
suite("Moteur — le parcours du NATIONAL SALES lui-même : Directeur des opérations → Direction Marketing", () => {
  let nsId = "", pmId = "", odId = "", congressId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG1C}${s}`, email: `${TAG1C}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, pm, od] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("pm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR")]);
    nsId = ns.id; pmId = pm.id; odId = od.id;
    const c = await prisma.congressInternational.create({
      data: { name: `${TAG1C}Congrès`, requestStatus: "PRELIMINARY_APPROVED", requesterId: nsId, estimatedBudget: 30000 },
    });
    congressId = c.id;
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: congressId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: congressId } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG1C } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG1C } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG1C } } }).catch(() => {});
  });

  it("SON préliminaire disparaît, le Directeur des opérations RESTE — le tamis, pas une borne", async () => {
    // Ce qui le ferait tomber, dans les deux sens : garder `preliminary` (il s'approuverait
    // lui-même, une validation qui ne mesure rien) ou retirer `final` (plus AUCUN filtre
    // au-dessus de lui, alors que la Direction a nommé celui-là).
    const vue = await getWorkflowForEntity(asSession(nsId, "NATIONAL_SALES"), "CONGRESS_INTERNATIONAL", congressId, nsId);
    expect(vue?.steps.map((st) => st.slug)).toEqual(["final", "marketing"]);
    expect(vue?.currentSlug).toBe("final");
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.skippedSlugs).toEqual(["preliminary", "dg"]);
    expect(inst.finalSlug, "Direction Marketing conclut : c'est la dernière étape").toBeNull();
  });

  it("il ne s'approuve pas lui-même — son étape préliminaire n'est pas sur sa route", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "je valide ma propre demande" });
    expect(r.ok).toBe(false);
  });

  it("le Directeur des opérations valide SANS chiffrer — rien n'est engagé avant la prévalidation", async () => {
    // Ce qui le ferait tomber : des émissions financières sur cette étape — l'ordre de dépense
    // partirait avant même la prévalidation de la Direction Marketing.
    const r = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "Accord du Directeur des opérations" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug).toBe("marketing");
    expect(inst.status).toBe("IN_PROGRESS");
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } }), "rien n'est engagé avant la prévalidation").toBe(0);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: congressId } }), "ni déclaré").toBe(0);
  });

  it("Direction Marketing prévalide → clôturé, aucun ordre global", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "Prévalidée" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.status).toBe("APPROVED");
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } })).toBe(0);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: congressId } }), "la déclaration part à la prévalidation").toBe(1);
  });
});

const TAG1D = "__wfoffice__";

/**
 * LA QUATRIÈME ET LA CINQUIÈME CHAÎNE — les deux branches nées le 27/10/2026.
 *
 *   • la Direction Marketing : sa demande est prévalidée D'OFFICE à la naissance de l'instance,
 *     au nom de sa créatrice, et le journal le dit (personne ne prévalide sa propre demande, et
 *     personne au-dessus d'elle n'a à le faire) ;
 *   • le rang 3 (Direction, DG, Directeur des opérations, Super Admin) : la prévalidation seule.
 *
 * Et `ouvrirLeCircuit` : à la création, l'acteur de l'étape courante reçoit « à vous d'agir », les
 * rôles des étapes suivantes de SON parcours sont prévenus pour information.
 */
suite("Moteur — prévalidée d'office (Direction Marketing), prévalidation seule (rang 3), et l'ouverture du circuit", () => {
  let pmId = "", dirId = "", odId = "", nsId = "", kamId = "", dmCongressId = "", dirCongressId = "", kamCongressId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG1D}${s}`, email: `${TAG1D}${s}@t.dz`, role, passwordHash: "x" } });
    const [pm, dir, od, ns, kam] = await Promise.all([
      mk("pm", "PRODUCT_MANAGER"), mk("dir", "DIRECTION"), mk("od", "OPERATIONS_DIRECTOR"), mk("ns", "NATIONAL_SALES"), mk("kam", "MEDICAL_DELEGATE"),
    ]);
    pmId = pm.id; dirId = dir.id; odId = od.id; nsId = ns.id; kamId = kam.id;
    // Les statuts de départ que pose `adProInit` : AWAITING_FINAL pour la Direction Marketing et le
    // rang 3, AWAITING_PRELIMINARY pour un délégué.
    const [dm, d, k] = await Promise.all([
      prisma.congressNational.create({ data: { name: `${TAG1D}DM`, requestStatus: "AWAITING_FINAL", requesterId: pmId, estimatedBudget: 2_000_000 } }),
      prisma.congressNational.create({ data: { name: `${TAG1D}Dir`, requestStatus: "AWAITING_FINAL", requesterId: dirId, estimatedBudget: 50_000 } }),
      prisma.congressNational.create({ data: { name: `${TAG1D}Kam`, requestStatus: "AWAITING_PRELIMINARY", requesterId: kamId, estimatedBudget: 50_000 } }),
    ]);
    dmCongressId = dm.id; dirCongressId = d.id; kamCongressId = k.id;
  });

  afterAll(async () => {
    const ids = [dmCongressId, dirCongressId, kamCongressId];
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG1D } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG1D } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG1D } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG1D } } }).catch(() => {});
  });

  it("LA DEMANDE DE LA DIRECTION MARKETING EST PRÉVALIDÉE D'OFFICE à la naissance — tracé à son nom, sans montant ni ordre global", async () => {
    // Ce qui le ferait tomber : l'ancienne route du rang 2 (la Direction des opérations tranchait
    // à sa place, montant compris) — ou une demande posée sur la prévalidation, à attendre que la
    // Direction Marketing se prévalide elle-même. 2 000 000 DZD dépassent le seuil du DG : peu
    // importe, le DG valide le total des POSTES, à la fin, pas la demande.
    const inst = await ensureInstance("CONGRESS_NATIONAL", dmCongressId);
    expect(inst?.status, "la prévalidation est faite d'office").toBe("APPROVED");
    expect(inst?.currentSlug).toBeNull();
    expect(inst?.skippedSlugs).toEqual(["preliminary", "dg", "final"]);
    const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst!.id, stepSlug: "marketing", action: "APPROVE" } });
    expect(ev?.actorId, "au nom de sa créatrice").toBe(pmId);
    expect(ev?.note).toMatch(/^Prévalidée d'office/);
    const c = await prisma.congressNational.findUniqueOrThrow({ where: { id: dmCongressId } });
    expect(c.requestStatus).toBe("APPROVED");
    expect(c.finalAmount).toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceId: dmCongressId } })).toBe(0);
    // RELUE, L'INSTANCE NE REJOUE RIEN : `ensureInstance` est idempotent.
    await ensureInstance("CONGRESS_NATIONAL", dmCongressId);
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst!.id, action: "APPROVE" } })).toBe(1);
  });

  it("LE RANG 3 va à la prévalidation SEULE — et n'est PAS prévalidé d'office", async () => {
    // Ce qui le ferait tomber : étendre l'office à tout demandeur sans N+1. La Direction n'a
    // personne au-dessus d'elle dans la ligne, mais la Direction Marketing prévalide toujours.
    const inst = await ensureInstance("CONGRESS_NATIONAL", dirCongressId);
    expect(inst?.status).toBe("IN_PROGRESS");
    expect(inst?.currentSlug).toBe("marketing");
    expect(inst?.skippedSlugs).toEqual(["preliminary", "dg", "final"]);
    const od = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_NATIONAL", entityId: dirCongressId, action: "APPROVE", note: "pas mon tour" });
    expect(od.ok, "le Directeur des opérations n'est pas sur la route d'un rang 3").toBe(false);
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_NATIONAL", entityId: dirCongressId, action: "APPROVE", note: "Prévalidée" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const c = await prisma.congressNational.findUniqueOrThrow({ where: { id: dirCongressId } });
    expect(c.requestStatus).toBe("APPROVED");
  });

  it("OUVRIR LE CIRCUIT À LA CRÉATION : le National Sales doit agir, le Directeur des opérations et la Direction Marketing sont prévenus", async () => {
    // « À la création, ça doit notifier tous les acteurs concernés, puis chaque personne à son
    // tour » (27/10/2026). Ce qui le ferait tomber : une instance née paresseusement — personne
    // n'est prévenu, ou des rôles écrits à la main (la Direction pour une demande que le
    // Directeur des opérations devait voir).
    await ouvrirLeCircuit("CONGRESS_NATIONAL", kamCongressId);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_NATIONAL", entityId: kamCongressId } } });
    expect(inst.currentSlug).toBe("preliminary");
    const titres = async (userId: string) =>
      (await prisma.notification.findMany({ where: { userId, link: { contains: kamCongressId } }, select: { title: true } })).map((n) => n.title);
    expect((await titres(nsId)).some((t) => t.includes("à vous d'agir")), "l'acteur de l'étape courante").toBe(true);
    expect((await titres(odId)).some((t) => t.includes("nouvelle demande (pour information)")), "l'étape suivante de SON parcours").toBe(true);
    expect((await titres(pmId)).some((t) => t.includes("nouvelle demande (pour information)")), "la prévalidation, à la fin").toBe(true);
    expect((await titres(odId)).some((t) => t.includes("à vous d'agir")), "son tour n'est pas venu").toBe(false);
    // RAPPELÉE SUR UNE INSTANCE DÉJÀ NÉE, ELLE NE PRÉVIENT PERSONNE UNE SECONDE FOIS.
    const avant = await prisma.notification.count({ where: { userId: { in: [nsId, odId, pmId] }, link: { contains: kamCongressId } } });
    await ouvrirLeCircuit("CONGRESS_NATIONAL", kamCongressId);
    expect(await prisma.notification.count({ where: { userId: { in: [nsId, odId, pmId] }, link: { contains: kamCongressId } } })).toBe(avant);
  });
});

const TAG2 = "__wfevt__";

suite("Moteur — avis défavorable non éliminatoire + refus final d'événement (sans crash)", () => {
  let nsId = "", pmId = "", odId = "", eventId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG2}${s}`, email: `${TAG2}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, pm, od] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("pm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR")]);
    nsId = ns.id; pmId = pm.id; odId = od.id;
    // UN ÉVÉNEMENT SANS DEMANDEUR : aucun parcours n'est figé (on n'ampute jamais un circuit sur
    // une absence de donnée), la chaîne ENTIÈRE s'applique — porte du DG comprise, la seule route
    // où elle subsiste. Budget estimé sous le seuil : elle se franchit seule, et l'avis défavorable
    // du National Sales fait donc atterrir la demande chez le Directeur des opérations.
    const e = await prisma.event.create({ data: { name: `${TAG2}Event`, type: "ROUND_TABLE", scope: "NATIONAL", format: "PRESENTIAL", status: "DRAFT", requestStatus: "AWAITING_PRELIMINARY", estimatedBudget: 80000 } });
    eventId = e.id;
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: eventId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG2 } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG2 } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG2 } } }).catch(() => {});
  });

  it("l'avis défavorable du National Sales n'est PAS éliminatoire : le circuit avance", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "EVENT", entityId: eventId, action: "REJECT", note: "avis défavorable" });
    expect(r.ok).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "EVENT", entityId: eventId } } });
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug, "la porte du DG est franchie seule sous le seuil").toBe("final");
    const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, action: "OPINION_AGAINST" } });
    expect(ev).not.toBeNull();
  });

  it("l'avis défavorable du DIRECTEUR DES OPÉRATIONS avance vers Direction Marketing, qui conclut", async () => {
    // Le Directeur des opérations ne fixe aucun montant : son avis défavorable est un AVIS, et la
    // décision revient à Direction Marketing. Ce qui le ferait tomber : rendre ce refus
    // éliminatoire — la demande mourrait avant d'atteindre celle qui décide.
    const r = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "EVENT", entityId: eventId, action: "REJECT", note: "réserve du Directeur des opérations" });
    expect(r.ok).toBe(true);
    const e = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(e.requestStatus).toBe("AWAITING_FINAL");
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "EVENT", entityId: eventId } } });
    expect(inst.currentSlug).toBe("marketing");
    const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, stepSlug: "final", action: "OPINION_AGAINST" } });
    expect(ev).not.toBeNull();
  });

  it("le refus de DIRECTION MARKETING (étape qui conclut) est définitif — sans exception serveur (Event sans updatedById)", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "EVENT", entityId: eventId, action: "REJECT", note: "refus définitif" });
    expect(r.ok).toBe(true);
    const e = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(e.requestStatus).toBe("REJECTED");
    // ET L'ÉTAT DE VIE NE MENT PAS : un financement refusé n'annule pas l'événement (il peut se
    // tenir autrement), donc `status` reste ce qu'il était — jamais « Validé » (§118.138).
    // Ni « Annulé » (on n'a refusé que la prise en charge) ni « En attente de validation » (plus
    // rien n'est attendu) : `DRAFT`, le seul état neutre (§118.138).
    expect(e.status, "un refus de prise en charge ne décide pas de la tenue de l'événement").toBe("DRAFT");
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "EVENT", entityId: eventId } } });
    expect(inst.status).toBe("REJECTED");
  });
});

const TAG3 = "__wfskip__";

suite("Moteur — sauter une étape (tracé & noté, anti-bureaucratie)", () => {
  let nsId = "", pmId = "", odId = "", dgId = "", delegId = "", otherId = "", dirId = "", congressId = "", dirCongressId = "";

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG3}${s}`, email: `${TAG3}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, pm, od, gm, deleg, ot, dir] = await Promise.all([
      mk("ns", "NATIONAL_SALES"), mk("pm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR"), mk("dg", "GENERAL_MANAGER"),
      mk("deleg", "MEDICAL_DELEGATE"), mk("other", "SALES_USER"), mk("dir", "DIRECTION"),
    ]);
    nsId = ns.id; pmId = pm.id; odId = od.id; dgId = gm.id; delegId = deleg.id; otherId = ot.id; dirId = dir.id;
    // `marketing` est la DERNIÈRE étape et CONCLUT : elle ne se saute jamais. Les étapes
    // intermédiaires se sautent, elles. Depuis le 27/10/2026, la route d'un délégué porte LES DEUX
    // étapes intermédiaires (préliminaire puis Directeur des opérations) : une seule demande suffit
    // à éprouver les deux sauts manuels. Montant laissé à ZÉRO : aucun franchissement par seuil ne
    // se mêle de la mesure.
    const c = await prisma.congressInternational.create({ data: { name: `${TAG3}Congrès`, requestStatus: "AWAITING_PRELIMINARY", requesterId: delegId } });
    congressId = c.id;
    // LE TÉMOIN DU RANG 3 : sa route ne porte que la prévalidation.
    const d = await prisma.congressInternational.create({ data: { name: `${TAG3}Dir`, requestStatus: "AWAITING_FINAL", requesterId: dirId } });
    dirCongressId = d.id;
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: [congressId, dirCongressId] } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: [congressId, dirCongressId] } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG3 } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG3 } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG3 } } }).catch(() => {});
  });

  it("le préliminaire n'est plus une désignation : il se saute AVEC raison, et c'est tracé", async () => {
    // Il ne se sautait pas parce qu'il DÉSIGNAIT le responsable de la suite : sauter aurait
    // laissé l'étape suivante sans acteur. Les étapes suivantes sont portées par un RÔLE — plus
    // rien à protéger. La raison, elle, reste obligatoire.
    const sansRaison = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "" });
    expect(sansRaison.ok).toBe(false);
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "Déjà arbitré en réunion" });
    expect(r.ok).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    // LE SAUT MANUEL ET LE TAMIS SE RENCONTRENT ICI : l'étape suivante n'est PAS la porte du DG,
    // hors route. Ce qui le ferait tomber : oublier `ignorees` dans `nextStepAfter` côté SKIP.
    expect(inst.currentSlug, "on arrive chez le Directeur des opérations, pas devant le DG").toBe("final");
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, stepSlug: "dg" } }), "rien n'est tracé sur une étape hors route").toBe(0);
  });

  it("le saut exige une raison et n'est ouvert qu'à l'acteur de l'étape", async () => {
    // SUR UNE ÉTAPE INTERMÉDIAIRE, et c'est la moitié du cas : posé sur `marketing`, le refus
    // viendrait de « la décision ne se saute pas » et l'assertion serait vraie sans mesurer ni la
    // raison ni l'acteur (§118.111).
    const noReason = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "" });
    expect(noReason.ok, "l'acteur de l'étape, mais sans raison").toBe(false);
    const thirdParty = await advanceWorkflowInstance({ viewer: viewer(otherId, "SALES_USER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "je saute" });
    expect(thirdParty.ok, "une raison, mais pas l'acteur de l'étape").toBe(false);
  });

  it("LE DG N'A RIEN À SAUTER : sa porte n'est plus sur la route, et l'étape courante n'est pas la sienne", async () => {
    // Avant le 27/10/2026, le DG sautait sa porte à la main. Ce qui le ferait tomber : un DG qui
    // pourrait encore faire avancer la demande — une validation qu'aucune règle ne lui donne plus.
    const r = await advanceWorkflowInstance({ viewer: viewer(dgId, "GENERAL_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "Montant sans enjeu pour la DG" });
    expect(r.ok).toBe(false);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug).toBe("final");
  });

  it("le Directeur des opérations saute son étape → avance vers Direction Marketing, tracé", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "Rien à redire, on file à Direction Marketing" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug).toBe("marketing");
    const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, action: "SKIP", stepSlug: "final" } });
    expect(ev).not.toBeNull();
    expect(ev?.note).toContain("Direction Marketing");
  });

  it("on ne peut pas sauter la PRÉVALIDATION — c'est l'étape qui conclut", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "SKIP", note: "raison" });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("finale");
  });

  it("SUR UNE DEMANDE DE RANG 3, la prévalidation est la SEULE étape — et ne se saute pas non plus", async () => {
    // Le cas symétrique : la route la plus courte. Cette garde ne coûte pas une ligne : elle tombe
    // de `nextStepAfter` — pas de successeur, donc étape qui conclut, donc saut refusé.
    await ensureInstance("CONGRESS_INTERNATIONAL", dirCongressId);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: dirCongressId } } });
    expect(inst.finalSlug, "aucune borne").toBeNull();
    expect(inst.currentSlug).toBe("marketing");
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: dirCongressId, action: "SKIP", note: "on saute" });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("finale");
  });
});

const TAG4 = "__wfauto__";

suite("Moteur — franchissement automatique par seuil de montant (anti-bureaucratie configurable)", () => {
  let nsId = "", delegId = "", lowId = "", highId = "", kamLowId = "";
  let seuilOriginal: unknown = null;

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG4}${s}`, email: `${TAG4}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, dg] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("deleg", "MEDICAL_DELEGATE")]);
    nsId = ns.id; delegId = dg.id;
    // Petit budget estimé (5 000) sous le seuil / gros budget (50 000) au-dessus.
    //
    // LA PORTE DU DG N'EST PLUS SUR AUCUNE ROUTE (27/10/2026) : le seuil GLOBAL ne franchit donc
    // plus rien dans le circuit — il gouverne la porte sur le TOTAL des postes, ailleurs. Reste le
    // seuil ÉCRIT SUR UNE ÉTAPE, qu'un Super Admin peut poser sur le Directeur des opérations.
    //
    // DEUX POINTS D'ENTRÉE DE `settleAutoSkips`, et les deux sont de nouveau atteignables : À LA
    // NAISSANCE pour le National Sales (sa route COMMENCE chez le Directeur des opérations), EN
    // TRANSIT pour un délégué (le Directeur des opérations vient APRÈS son National Sales).
    const [low, high, kamLow] = await Promise.all([
      prisma.congressInternational.create({ data: { name: `${TAG4}Low`, requestStatus: "PRELIMINARY_APPROVED", requesterId: nsId, estimatedBudget: 5000 } }),
      prisma.congressInternational.create({ data: { name: `${TAG4}High`, requestStatus: "PRELIMINARY_APPROVED", requesterId: nsId, estimatedBudget: 50000 } }),
      prisma.congressInternational.create({ data: { name: `${TAG4}Kam`, requestStatus: "AWAITING_PRELIMINARY", requesterId: delegId, estimatedBudget: 5000 } }),
    ]);
    lowId = low.id; highId = high.id; kamLowId = kamLow.id;
    // Configure un seuil de 10 000 sur l'étape du DIRECTEUR DES OPÉRATIONS (partagée) — restauré
    // en afterAll à sa valeur LUE, pas à une valeur supposée. Jamais sur « marketing » : c'est
    // elle qui conclut, et une décision ne se franchit jamais seule.
    const def = await getDefinition("CONGRESS_INTERNATIONAL");
    seuilOriginal = def.steps.find((s) => s.slug === "final")?.autoSkipMaxAmount ?? null;
    await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "final" }, data: { autoSkipMaxAmount: 10000 } });
  });

  afterAll(async () => {
    const def = await getDefinition("CONGRESS_INTERNATIONAL").catch(() => null);
    if (def) await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "final" }, data: { autoSkipMaxAmount: seuilOriginal as never } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: [lowId, highId, kamLowId] } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: [lowId, highId, kamLowId] } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG4 } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG4 } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG4 } } }).catch(() => {});
  });

  it("À LA NAISSANCE, montant estimé ≤ seuil de l'étape : le Directeur des opérations est franchi (tracé) → on se pose sur la prévalidation", async () => {
    const vue = await getWorkflowForEntity(asSession(nsId, "NATIONAL_SALES"), "CONGRESS_INTERNATIONAL", lowId, nsId);
    expect(vue?.steps.map((st) => st.slug), "sa route : Directeur des opérations, prévalidation").toEqual(["final", "marketing"]);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: lowId } } });
    expect(inst.currentSlug).toBe("marketing");
    expect(inst.status, "franchi n'est pas clôturé : Direction Marketing doit encore prévalider").toBe("IN_PROGRESS");
    const sauts = await prisma.workflowStepEvent.findMany({ where: { instanceId: inst.id, action: "AUTO_SKIP" }, select: { stepSlug: true } });
    expect(sauts.map((x) => x.stepSlug), "la porte du DG, hors route, n'est pas « franchie »").toEqual(["final"]);
  });

  it("montant estimé > seuil de l'étape : la validation humaine du Directeur des opérations est CONSERVÉE", async () => {
    // 50 000 > 10 000 : l'étape reste. Et le seuil GLOBAL (celui du DG) ne s'y applique pas — il ne
    // gouverne que la porte du DG (`seuilFranchissement`), qui n'est plus sur la route.
    await getWorkflowForEntity(asSession(nsId, "NATIONAL_SALES"), "CONGRESS_INTERNATIONAL", highId, nsId);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: highId } } });
    expect(inst.currentSlug).toBe("final");
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, action: "AUTO_SKIP" } }), "rien n'est franchi").toBe(0);
  });

  it("EN TRANSIT, le Directeur des opérations est franchi — mais JAMAIS l'étape qui conclut, même sous le seuil", async () => {
    // Le seuil anti-bureaucratie et la fin de la route se rencontrent ici. La Direction Marketing
    // prévalide : la franchir automatiquement ouvrirait les postes sans que PERSONNE n'ait
    // prévalidé. Cette garde tombe de `nextStepAfter` — pas de successeur, donc étape qui conclut,
    // donc jamais de franchissement automatique.
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: kamLowId, action: "APPROVE", note: "OK" });
    expect(r.ok).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: kamLowId } } });
    expect(inst.currentSlug, "la demande ATTEND la prévalidation de Direction Marketing").toBe("marketing");
    expect(inst.status).toBe("IN_PROGRESS");
    const sauts = await prisma.workflowStepEvent.findMany({ where: { instanceId: inst.id, action: "AUTO_SKIP" }, select: { stepSlug: true } });
    expect(sauts.map((x) => x.stepSlug), "5 000 ≤ 10 000 : le Directeur des opérations est franchi, et c'est tracé").toEqual(["final"]);
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, action: "AUTO_SKIP", stepSlug: "marketing" } }), "l'étape qui conclut n'est JAMAIS franchie").toBe(0);
  });
});

const TAG6 = "__wfemis__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉMISSION FINANCIÈRE D'UNE ÉTAPE QUE LE TAMIS A SAUTÉE — le cas qu'un SABOTAGE a nommé.
 *
 * Un sabotage qui ramenait la lecture à la BORNE (`estDecisionnaire`) au lieu de « y a-t-il une
 * suite ? » est passé au VERT tant que le circuit par défaut ne portait l'émission que sur
 * l'étape qui conclut — ce n'était pas « le code est bon », c'était « je ne teste pas ce que je
 * crois » (§118.111).
 *
 * LE DÉCOR REMODÈLE LE CIRCUIT, ce qu'un Super Admin a le droit de faire : la porte du DG — hors
 * de TOUTE route depuis le 27/10/2026 — reçoit l'argent (montant et catégorie exigés) et l'ordre de
 * dépense ; la prévalidation n'émet plus rien. Un délégué ne traverse pas `dg` : sans l'héritage,
 * sa demande sortirait APPROUVÉE et Finance ne recevrait RIEN, sans une étape en échec. Et ce
 * circuit remodelé « garde son comportement d'avant » : l'étape qui conclut ACCORDE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Moteur — une émission portée par une étape HORS ROUTE est honorée par celle qui conclut", () => {
  let nsId = "", odId = "", pmId = "", delegId = "", congressId = "", catId = "";
  let dgOriginal: { powers: string[]; requireAmount: boolean; requireCategory: boolean; emitExpenseOrder: boolean } | null = null;
  let mkOriginal: { emitExpenseOrder: boolean; emitDeclaration: boolean } | null = null;

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG6}${s}`, email: `${TAG6}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, od, pm, deleg] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("od", "OPERATIONS_DIRECTOR"), mk("pm", "PRODUCT_MANAGER"), mk("deleg", "MEDICAL_DELEGATE")]);
    nsId = ns.id; odId = od.id; pmId = pm.id; delegId = deleg.id;
    const c = await prisma.congressInternational.create({
      data: { name: `${TAG6}Congrès`, requestStatus: "AWAITING_PRELIMINARY", requesterId: delegId, estimatedBudget: 40000 },
    });
    congressId = c.id;
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG6}Env`, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1000000, modules: ["CONGRESS_INTERNATIONAL"], isActive: true },
    });
    const cat = await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG6}Cat`, module: "CONGRESS_INTERNATIONAL", allocated: 500000 } });
    catId = cat.id;
    // LE REMODELAGE — restauré en afterAll à ce qui était LU, pas à une valeur supposée : une
    // restauration écrite en dur avait laissé l'ancienne graine (ordre global) sur la base partagée.
    const def = await getDefinition("CONGRESS_INTERNATIONAL");
    const dg = def.steps.find((s) => s.slug === "dg")!;
    const mkt = def.steps.find((s) => s.slug === "marketing")!;
    dgOriginal = { powers: [...dg.powers], requireAmount: dg.requireAmount, requireCategory: dg.requireCategory, emitExpenseOrder: dg.emitExpenseOrder };
    mkOriginal = { emitExpenseOrder: mkt.emitExpenseOrder, emitDeclaration: mkt.emitDeclaration };
    await prisma.workflowStep.updateMany({
      where: { definitionId: def.id, slug: "dg" },
      data: { powers: ["APPROVE", "REJECT", "SET_AMOUNT", "SET_CATEGORY", "COMMENT"], requireAmount: true, requireCategory: true, emitExpenseOrder: true },
    });
    await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "marketing" }, data: { emitExpenseOrder: false, emitDeclaration: false } });
  });

  afterAll(async () => {
    const def = await getDefinition("CONGRESS_INTERNATIONAL").catch(() => null);
    if (def) {
      if (dgOriginal) await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "dg" }, data: dgOriginal }).catch(() => {});
      if (mkOriginal) await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "marketing" }, data: mkOriginal }).catch(() => {});
    }
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: congressId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: congressId } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: congressId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG6 } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG6 } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG6 } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG6 } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG6 } } }).catch(() => {});
  });

  it("LA PRÉMISSE : le décor porte bien l'argent et l'émission sur l'étape que le délégué ne traverse pas", async () => {
    // Sans cette vérification, le cas suivant serait vrai pour la mauvaise raison si le décor
    // n'avait pas pris (§118.104) — et c'est justement un décor qui MUTE la définition partagée.
    const def = await getDefinition("CONGRESS_INTERNATIONAL");
    const parSlug = new Map(orderedSteps(def).map((s) => [s.slug, s]));
    expect(parSlug.get("dg")?.emitExpenseOrder, "l'émission est sur la porte du DG").toBe(true);
    expect(parSlug.get("marketing")?.emitExpenseOrder, "et PAS sur la prévalidation").toBe(false);
    await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "COMMENT", note: "ouvre l'instance" });
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.skippedSlugs, "un délégué ne traverse pas cette étape").toEqual(["dg"]);
  });

  it("la dépense EST engagée — l'héritage se lit sur « y a-t-il une suite », pas sur la borne", async () => {
    // Ce qui le ferait tomber : `conclut = estDecisionnaire(step.slug, borne)`. Un délégué n'a
    // aucune borne, donc `conclut` serait FAUX à l'étape qui conclut pourtant, l'héritage ne se
    // ferait pas, et l'ordre de dépense de l'étape sautée disparaîtrait — sans une étape en échec.
    const prelim = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK" });
    expect(prelim.ok, prelim.ok === false ? prelim.error : "").toBe(true);
    const od = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK" });
    expect(od.ok, od.ok === false ? od.error : "").toBe(true);
    const enTransit = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(enTransit.currentSlug, "`dg` hors route").toBe("marketing");
    expect(await prisma.expenseOrder.count({ where: { sourceId: congressId } }), "rien n'est engagé avant la décision").toBe(0);

    // LES POUVOIRS D'ARGENT SUIVENT L'ÉMISSION : sans montant, l'étape qui conclut refuse.
    const sansMontant = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", budgetCategoryId: catId, note: "sans montant" });
    expect(sansMontant.ok, "un circuit remodelé à montant exige le montant").toBe(false);
    const r = await advanceWorkflowInstance({ viewer: viewer(pmId, "PRODUCT_MANAGER"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", amount: 38000, budgetCategoryId: catId, note: "Accordé" });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const order = await prisma.expenseOrder.findFirst({ where: { sourceId: congressId } });
    expect(order, "l'émission de l'étape HORS ROUTE est honorée par celle qui conclut").not.toBeNull();
    expect(Number(order?.amount)).toBe(38000);
    const c = await prisma.congressInternational.findUniqueOrThrow({ where: { id: congressId } });
    expect(Number(c.finalAmount), "le circuit remodelé ACCORDE, comme avant la règle").toBe(38000);
  });
});

const TAG5 = "__wfreqauth__";

suite("Moteur — auto-accord si le demandeur détient l'autorité de l'étape (skip-demandeur généralisé)", () => {
  let nsId = "", reqId = "", congressId = "";
  let original: { actorScope: string; actorRoles: string[]; autoApproveIfRequester: boolean } | null = null;

  beforeAll(async () => {
    const mk = (s: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG5}${s}`, email: `${TAG5}${s}@t.dz`, role, passwordHash: "x" } });
    const [ns, req] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("req", "MEDICAL_DELEGATE")]);
    nsId = ns.id; reqId = req.id;
    // Le DEMANDEUR est un délégué ; budget AU-DESSUS DU SEUIL GLOBAL du DG (1 000 000) pour que
    // rien d'autre que l'AUTORITÉ ne puisse faire avancer la demande (§118.111).
    const c = await prisma.congressInternational.create({ data: { name: `${TAG5}Congrès`, requestStatus: "AWAITING_PRELIMINARY", requesterId: reqId, estimatedBudget: 5_000_000 } });
    congressId = c.id;
    // Reconfigure temporairement l'étape du DIRECTEUR DES OPÉRATIONS en portée ROLE[MEDICAL_DELEGATE]
    // + auto-accord si demandeur. Ce n'est plus la porte du DG : elle n'est sur aucune route depuis le
    // 27/10/2026. Ni « marketing » : elle conclut, et l'auto-accord ne franchit jamais l'étape qui conclut.
    const def = await getDefinition("CONGRESS_INTERNATIONAL");
    const a = await prisma.workflowStep.findFirstOrThrow({ where: { definitionId: def.id, slug: "final" } });
    original = { actorScope: a.actorScope, actorRoles: a.actorRoles, autoApproveIfRequester: a.autoApproveIfRequester };
    await prisma.workflowStep.update({ where: { id: a.id }, data: { actorScope: "ROLE", actorRoles: ["MEDICAL_DELEGATE"], autoApproveIfRequester: true } });
  });

  afterAll(async () => {
    const def = await getDefinition("CONGRESS_INTERNATIONAL").catch(() => null);
    if (def && original) await prisma.workflowStep.updateMany({ where: { definitionId: def.id, slug: "final" }, data: original }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: congressId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: congressId } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG5 } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG5 } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG5 } } }).catch(() => {});
  });

  it("l'étape dont le demandeur détient déjà le rôle est approuvée automatiquement en son nom (tracé), sans franchir l'étape qui CONCLUT", async () => {
    // Le National Sales approuve le préliminaire ; l'étape suivante, dont le DEMANDEUR détient le
    // rôle, est auto-accordée en son nom → on se pose sur la prévalidation. On ne fait pas valider
    // à quelqu'un sa propre demande, et l'on ne franchit jamais pour autant l'étape qui conclut.
    const r = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "CONGRESS_INTERNATIONAL", entityId: congressId, action: "APPROVE", note: "OK" });
    expect(r.ok).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_INTERNATIONAL", entityId: congressId } } });
    expect(inst.currentSlug).toBe("marketing");
    expect(inst.status).toBe("IN_PROGRESS");
    const ev = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, action: "AUTO_APPROVE_REQUESTER", stepSlug: "final" } });
    expect(ev, "le motif est l'AUTORITÉ du demandeur").not.toBeNull();
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: inst.id, action: "AUTO_SKIP" } }), "et aucun franchissement par MONTANT ne s'est mêlé de la mesure").toBe(0);
  });
});

// ─────────────────────────── Validation par le N+1 (départements) ───────────────────────────

const TAG_MGR = "__wfmgr__";

/**
 * Étape à portée `DEPARTMENT_MANAGER` : c'est le **responsable hiérarchique du demandeur**
 * qui valide — résolu depuis les départements (et non depuis un rôle figé). On vérifie
 * qu'un collègue du même département ne peut pas valider, que le N+1 le peut, et que la
 * hiérarchie au-dessus (escalade) le peut aussi.
 */
suite("Moteur — étape validée par le N+1 réel du demandeur", () => {
  let deptId = "", subId = "";
  let chefUser = "", dgUser = "", agentUser = "", collegueUser = "";
  let eventId = "", instanceId = "", stepSlug = "";
  let originalStep: { id: string; actorScope: string; powers: string[]; assignRole: string | null } | null = null;

  beforeAll(async () => {
    const mkUser = (s: string, role: UserRole) =>
      prisma.user.create({ data: { name: `${TAG_MGR}${s}`, email: `${TAG_MGR}${s}@t.dz`, role, passwordHash: "x" } });
    const [dg, chef, agent, collegue] = await Promise.all([
      mkUser("dg", "SALES_USER"), mkUser("chef", "SALES_USER"), mkUser("agent", "SALES_USER"), mkUser("collegue", "SALES_USER"),
    ]);
    dgUser = dg.id; chefUser = chef.id; agentUser = agent.id; collegueUser = collegue.id;

    const dept = await prisma.department.create({ data: { name: `${TAG_MGR} Direction`, code: `${TAG_MGR}_DIR` } });
    const sub = await prisma.department.create({ data: { name: `${TAG_MGR} Équipe`, code: `${TAG_MGR}_EQ`, parentId: dept.id } });
    deptId = dept.id; subId = sub.id;

    const mkEmp = (s: string, userId: string, departmentId: string) =>
      prisma.employee.create({ data: { fullName: `${TAG_MGR} ${s}`, userId, departmentId } });
    const [empDg, empChef] = await Promise.all([mkEmp("DG", dgUser, deptId), mkEmp("Chef", chefUser, subId)]);
    await Promise.all([mkEmp("Agent", agentUser, subId), mkEmp("Collègue", collegueUser, subId)]);
    await prisma.department.update({ where: { id: deptId }, data: { headId: empDg.id } });
    await prisma.department.update({ where: { id: subId }, data: { headId: empChef.id } });

    // Un événement demandé par l'agent, positionné sur une étape « N+1 ».
    const ev = await prisma.event.create({
      data: { name: `${TAG_MGR}Event`, type: "ROUND_TABLE", scope: "NATIONAL", format: "PRESENTIAL", status: "DRAFT", requestStatus: "AWAITING_PRELIMINARY", requesterId: agentUser },
    });
    eventId = ev.id;

    const def = await getDefinition("EVENTS");
    const first = [...def.steps].sort((a, b) => a.position - b.position)[0];
    stepSlug = first.slug;
    // La définition EVENTS est PARTAGÉE avec les autres suites (et persiste en base) :
    // on mémorise la configuration d'origine pour la restaurer intégralement après.
    originalStep = { id: first.id, actorScope: first.actorScope, powers: [...first.powers], assignRole: first.assignRole };
    await prisma.workflowStep.update({ where: { id: first.id }, data: { actorScope: "DEPARTMENT_MANAGER", powers: ["APPROVE", "REJECT"], assignRole: null } });
    const inst = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType: "EVENT", entityId: eventId, category: "EVENTS", currentSlug: stepSlug, status: "IN_PROGRESS" },
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    // Restauration INTÉGRALE de l'étape partagée (portée, pouvoirs, désignation) :
    // sans cela, les autres suites — et les exécutions suivantes — héritent d'un circuit modifié.
    if (originalStep) {
      await prisma.workflowStep.update({
        where: { id: originalStep.id },
        data: { actorScope: originalStep.actorScope, powers: originalStep.powers, assignRole: originalStep.assignRole },
      }).catch(() => {});
    }
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG_MGR } } }).catch(() => {});
    await prisma.department.updateMany({ where: { code: { startsWith: TAG_MGR } }, data: { headId: null, deputyId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG_MGR } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG_MGR } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG_MGR } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG_MGR } } }).catch(() => {});
  });

  it("un COLLÈGUE du même département ne peut pas valider", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(collegueUser, "SALES_USER"), entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "ok" });
    expect(r.ok).toBe(false);
  });

  it("le DEMANDEUR ne peut pas se valider lui-même", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(agentUser, "SALES_USER"), entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "auto" });
    expect(r.ok).toBe(false);
  });

  it("le N+1 (responsable du sous-département) voit l'action dans sa vue", async () => {
    const view = await getWorkflowForEntity(asSession(chefUser, "SALES_USER"), "EVENT", eventId, agentUser);
    expect(view?.action?.slug).toBe(stepSlug);
    // Le collègue, lui, n'a aucune action disponible.
    const collegueView = await getWorkflowForEntity(asSession(collegueUser, "SALES_USER"), "EVENT", eventId, agentUser);
    expect(collegueView?.action).toBeNull();
  });

  it("la hiérarchie AU-DESSUS du N+1 peut aussi trancher (escalade)", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer(dgUser, "SALES_USER"), entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "escalade" });
    expect(r.ok).toBe(true);
  });
});

// ─────────────────── Une définition SANS ÉTAPE n'est pas un circuit ───────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MESURÉ EN BASE : une ligne `WorkflowDefinition` avec ZÉRO `WorkflowStep`.
 *
 * `getDefinition` ne regardait que la présence de la LIGNE (`if (existing) return existing`) et
 * rendait donc ce circuit vide comme s'il était configuré. Le prix : `ensureInstance` pose la
 * demande sur un `currentSlug` qu'aucune étape ne porte — la demande existe, apparaît dans les
 * listes, n'a AUCUNE étape en échec, et personne, à aucun rôle, ne peut la faire avancer.
 *
 * Ce que ce banc EXIGE, et ce qui le ferait tomber :
 *   • le resemis remet la colonne vertébrale par défaut (mesurée sur `defaults.ts`), avec des
 *     POSITIONS correctes — passer `stepCreate` sans son index rendait `position: undefined`,
 *     et un circuit sans ordre n'a pas de première étape ;
 *   • une définition DÉJÀ pourvue n'est jamais touchée : resemer par-dessus une configuration
 *     voulue (l'écran d'administration en pose de sur mesure) écraserait la décision d'un humain ;
 *   • et la demande créée après resemis est RÉELLEMENT actionnable — c'est le seul critère qui
 *     compte, le reste n'étant que du comptage de lignes (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Moteur — une définition VIDE est resemée, jamais rendue telle quelle", () => {
  const TAGV = "__wfvide__";
  let categorie: "CONGRESS_NATIONAL" = "CONGRESS_NATIONAL";
  let defId = "";
  // LA RÉFÉRENCE VIENT DE `defaults.ts`, PAS DE LA BASE — et c'est la moitié qui compte.
  // La première version lisait la colonne vertébrale ATTENDUE dans la base juste avant de la
  // vider : une base laissée sale par un run précédent devenait donc à la fois l'état de départ
  // ET l'attendu, et l'assertion ne pouvait plus tomber. C'est §118.91 (« un banc partagé n'est
  // pas reproductible ») appliqué à mon propre banc, et c'est un sabotage qui l'a montré :
  // resemer toutes les étapes en `position: 0` passait au vert.
  const attendu = defaultDefinition("CONGRESS_NATIONAL").steps.map((st) => st.slug);

  beforeAll(async () => {
    // On part de la définition RÉELLE de la catégorie, puis on la vide — c'est l'état mesuré.
    const def = await getDefinition(categorie);
    defId = def.id;
    await prisma.workflowStep.deleteMany({ where: { definitionId: def.id } });
  });

  afterAll(async () => {
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { startsWith: TAGV } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { startsWith: TAGV } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAGV } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAGV } } }).catch(() => {});
  });

  it("le circuit vidé est RESEMÉ à la lecture suivante — avec ses positions", async () => {
    // Le point de départ est bien l'état fautif : zéro étape en base.
    expect(await prisma.workflowStep.count({ where: { definitionId: defId } }), "le décor doit partir d'un circuit VIDE").toBe(0);

    const def = await getDefinition(categorie);
    const etapes = orderedSteps(def);
    expect(etapes.length, "un circuit sans étape ne peut rien approuver").toBeGreaterThan(0);
    expect(etapes.map((st) => st.slug)).toEqual(attendu);
    // Les POSITIONS, et non seulement le compte : sans index, `stepCreate` rendait la même
    // position pour toutes les étapes, et un circuit sans ordre n'a pas de PREMIÈRE étape.
    // Le tri de `orderedSteps` étant stable, les slugs seraient restés justes — seule cette
    // ligne fait tomber ce défaut.
    expect(etapes.map((st) => st.position)).toEqual(attendu.map((_, i) => i));
  });

  it("une demande créée ensuite est RÉELLEMENT posée sur une étape qui existe", async () => {
    const dem = await prisma.user.create({
      data: { name: `${TAGV}kam`, email: `${TAGV}kam@t.dz`, role: "MEDICAL_DELEGATE" as never, passwordHash: "x" },
    });
    const c = await prisma.congressNational.create({
      data: { name: `${TAGV}Séminaire`, requestStatus: "AWAITING_PRELIMINARY", requesterId: dem.id },
    });
    const inst = await ensureInstance("CONGRESS_NATIONAL", c.id);
    expect(inst, "l'instance doit naître").not.toBeNull();
    const def = await getDefinition(categorie);
    // LE CRITÈRE : le slug porté par l'instance est un slug que le circuit CONNAÎT. Sans cela,
    // la demande est vivante et inavançable — aucune étape en échec, aucun signal.
    expect(orderedSteps(def).map((st) => st.slug)).toContain(inst?.currentSlug ?? "");
  });

  it("une définition DÉJÀ pourvue n'est pas retouchée — on n'écrase pas une configuration voulue", async () => {
    const avantLecture = await prisma.workflowStep.findMany({ where: { definitionId: defId }, select: { id: true }, orderBy: { position: "asc" } });
    await getDefinition(categorie);
    const apres = await prisma.workflowStep.findMany({ where: { definitionId: defId }, select: { id: true }, orderBy: { position: "asc" } });
    expect(apres.map((x) => x.id)).toEqual(avantLecture.map((x) => x.id));
  });
});
