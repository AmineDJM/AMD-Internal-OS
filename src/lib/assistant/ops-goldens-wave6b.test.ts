import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 6b — VALIDATIONS (règle en FUSION avec « aucun » qui retire le validateur 2,
 * décision d'étape résolue sur la bonne personne, verdict pièce par pièce RETIRABLE, relance
 * réservée à la vue globale), RAPPORTS TERRAIN (« mon dernier », FUSION de la fiche, envoi
 * refusé sans synthèse), CATALOGUE D'ARTICLES (FUSION du prix estimé qui serait effacé,
 * uniformisation dont la proposition EST la prévisualisation).
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

const PREFIXE = "__ops6b__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let val1Id = "";
let val2Id = "";
let ruleId = "";
let requestId = "";
let stepId = "";
let docId = "";
let reportId = "";
let articleId = "";

const sa = () => userWith({
  VALIDATIONS: ["VIEW", "CREATE", "VALIDATE"],
  FIELD_REPORTS: ["VIEW", "CREATE", "UPDATE"],
  GENERAL_MEANS: ["VIEW", "UPDATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 6b — validations, rapports terrain, catalogue d'articles", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.officeSupplyArticle.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.fieldReport.deleteMany({ where: { summary: { contains: "Pr Hamidi" }, delegate: { email: { startsWith: PREFIXE } } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.validationStep.deleteMany({ where: { request: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.validationRule.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, v1, v2] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Walid Finances`, email: `${TAG}v1@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
      prisma.user.create({ data: { name: `${TAG} Sara Direction`, email: `${TAG}v2@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    saId = s.id; val1Id = v1.id; val2Id = v2.id;

    const rule = await prisma.validationRule.create({
      data: {
        name: `${TAG} Achats > 100k`, module: "GENERAL_MEANS", minAmount: 100_000,
        validator1Id: v1.id, validator2Id: v2.id, mode: "SEQUENTIAL", active: true,
        description: "Achats significatifs", department: "Moyens généraux",
      },
    });
    ruleId = rule.id;

    const req = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-VAL-1`, module: "GENERAL_MEANS", title: `${TAG} Achat mobilier bureau`,
        status: "PENDING", mode: "SEQUENTIAL", currentOrder: 1, requesterId: s.id, priority: "MEDIUM",
        steps: { create: [{ order: 1, validatorId: v1.id, status: "PENDING" }] },
      },
      include: { steps: true },
    });
    requestId = req.id;
    stepId = req.steps[0].id;

    const doc = await prisma.document.create({
      data: {
        name: `${TAG} Devis mobilier.pdf`, category: "OTHER", entityType: "VALIDATION_REQUEST",
        entityId: req.id, fileKey: `${TAG}/devis.pdf`, confidentiality: "INTERNAL",
      },
    });
    docId = doc.id;

    const report = await prisma.fieldReport.create({
      data: {
        delegateId: s.id, status: "DRAFT", visitDate: new Date("2026-08-20T00:00:00Z"),
        summary: "Visite du Pr Hamidi, intérêt pour la gamme cardio.", transcript: "Visite du Pr Hamidi…",
        doctorName: "Pr Hamidi", institution: "CHU Beni Messous", specialty: "Cardiologie", doctorIds: [],
      },
    });
    reportId = report.id;

    const article = await prisma.officeSupplyArticle.create({
      data: { name: `${TAG} Ramette A4`, category: "Papeterie", unit: "Ramette", estimatedPrice: 650, supplierHint: "Papeterie El Feth", notes: "80 g" },
    });
    articleId = article.id;
  });


  describe("validations — règles, décision, revue granulaire, relance", () => {
    it("update_validation_rule : changer le SEUL mode rejoue module, seuils, description (FUSION) ; « aucun » retire le validateur 2", async () => {
      const p = await buildProposal("validation_operation", {
        op: "update_validation_rule", target: "Achats > 100k", mode: "parallèle",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const a = domainArgs(p);
        expect(a.id).toBe(ruleId);
        expect(a.mode).toBe("PARALLEL");
        expect(a.module).toBe("GENERAL_MEANS");
        expect(a.minAmount).toBe("100000");
        expect(a.description).toBe("Achats significatifs");
        expect(a.validator1Id).toBe(val1Id);
        expect(a.validator2Id).toBe(val2Id);
        expect(a.active).toBe("1");
      }

      const cleared = await buildProposal("validation_operation", {
        op: "update_validation_rule", target: "Achats > 100k", person2: "aucun",
      }, sa());
      expect("error" in cleared).toBe(false);
      if (!("error" in cleared)) expect(domainArgs(cleared).validator2Id).toBeNull();
    });

    it("create_validation_request : sans validateur NI module, la proposition refuse en expliquant le routage", async () => {
      const p = await buildProposal("validation_operation", {
        op: "create_validation_request", label: "Contrat imprimeur",
      }, sa());
      expect("error" in p && p.error).toMatch(/routage/);

      const ok = await buildProposal("validation_operation", {
        op: "create_validation_request", label: "Contrat imprimeur", person: "Walid Finances", person2: "Sara Direction",
      }, sa());
      expect("error" in ok).toBe(false);
      if (!("error" in ok)) {
        expect(domainArgs(ok).validator1Id).toBe(val1Id);
        expect(domainArgs(ok).validator2Id).toBe(val2Id);
      }
    });

    it("decide_validation : l'étape EN ATTENTE se résout (validateur nommé), le refus annonce la clôture", async () => {
      const p = await buildProposal("validation_operation", {
        op: "decide_validation", target: `${TAG}-VAL-1`, decision: "refuser", note: "Budget dépassé",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).stepId).toBe(stepId);
        expect(domainArgs(p).decision).toBe("REJECTED");
        expect(p.warnings.join(" ")).toMatch(/clôt/i);
      }
    });

    it("review_validation_item : la pièce se désigne par son NOM ; « retire le verdict » bascule en retrait", async () => {
      const p = await buildProposal("validation_operation", {
        op: "review_validation_item", target: `${TAG}-VAL-1`, label: "Devis mobilier", decision: "approuver",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).itemKey).toBe(docId);
        expect(domainArgs(p).decision).toBe("APPROVED");
        expect(domainArgs(p).clear).toBeNull();
      }

      const clearing = await buildProposal("validation_operation", {
        op: "review_validation_item", target: `${TAG}-VAL-1`, label: "Devis mobilier", decision: "retire le verdict",
      }, sa());
      expect("error" in clearing).toBe(false);
      if (!("error" in clearing)) expect(domainArgs(clearing).clear).toBe("1");
    });

    it("remind_validator : porte réservée à la vue globale — un délégué est refusé par la porte du catalogue", async () => {
      const delegate = userWith({}, "MEDICAL_DELEGATE", "d1", "Délégué");
      const denied = await buildProposal("validation_operation", {
        op: "remind_validator", target: `${TAG}-VAL-1`,
      }, delegate);
      expect("error" in denied && denied.error).toMatch(/droit/);

      const p = await buildProposal("validation_operation", { op: "remind_validator", target: `${TAG}-VAL-1` }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).stepId).toBe(stepId);
    });
  });

  describe("rapports terrain — « mon dernier », FUSION, envoi", () => {
    it("update_field_report : changer la SEULE spécialité rejoue synthèse, médecin, établissement et date (FUSION)", async () => {
      const p = await buildProposal("field_report_operation", {
        op: "update_field_report", target: "mon dernier", specialty: "Cardiologie interventionnelle",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const a = domainArgs(p);
        expect(a.id).toBe(reportId);
        expect(a.specialty).toBe("Cardiologie interventionnelle");
        expect(a.summary).toBe("Visite du Pr Hamidi, intérêt pour la gamme cardio.");
        expect(a.doctorName).toBe("Pr Hamidi");
        expect(a.institution).toBe("CHU Beni Messous");
        expect(a.visitDate).toBe("2026-08-20");
      }
    });

    it("submit_field_report : la synthèse existante suffit ; un rapport VIDE serait refusé en le disant", async () => {
      const p = await buildProposal("field_report_operation", {
        op: "submit_field_report", target: "Hamidi",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(reportId);
        expect(domainArgs(p).summary).toContain("Pr Hamidi");
        expect(p.warnings.join(" ")).toMatch(/VALIDE/);
      }
    });

    it("delete_field_report : ce qui part avec le rapport est lu par l'aperçu du registre, et la carte dit « réversible » (§118.212)", async () => {
      const p = await buildProposal("field_report_operation", {
        op: "delete_field_report", target: "mon dernier",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        // Le rapport du décor n'a aucune pièce jointe : l'aperçu le dit (« rien d'autre »).
        expect(p.fields.map((f) => `${f.label}: ${f.value}`).join(" | ")).toContain("Part aussi: rien d'autre");
        expect(p.warnings.join(" ")).toMatch(/Réversible/);
        expect(p.warnings.join(" ")).not.toMatch(/DÉFINITIVE/);
      }
    });
  });

  describe("catalogue d'articles — FUSION et uniformisation montrée", () => {
    it("update_supply_article : changer le SEUL fournisseur rejoue catégorie, unité, PRIX ESTIMÉ et notes (sinon effacés)", async () => {
      const p = await buildProposal("supply_operation", {
        op: "update_supply_article", name: "Ramette A4", supplier: "Maison de la papeterie",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const a = domainArgs(p);
        expect(a.id).toBe(articleId);
        expect(a.supplierHint).toBe("Maison de la papeterie");
        expect(a.category).toBe("Papeterie");
        expect(a.unit).toBe("Ramette");
        expect(a.estimatedPrice).toBe("650");
        expect(a.notes).toBe("80 g");
      }
    });

    it("normalize_supply_catalog : la proposition EST la prévisualisation (réécritures listées ou « rien à réécrire »)", async () => {
      const p = await buildProposal("supply_operation", { op: "normalize_supply_catalog" }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(p.title).toMatch(/Uniformiser le catalogue/);
        expect(p.title).toMatch(/réécrit|rien à réécrire/);
      }
    });
  });
});
