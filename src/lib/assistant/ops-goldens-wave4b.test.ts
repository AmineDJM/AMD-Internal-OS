import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 4b — Annuaire médical (FUSION intégrale de la fiche praticien — délégué
 * compris —, cellule de feuille validée, suppression CRITIQUE avec visites comptées, visite
 * champ-par-champ, annuaires nommés avec accès REMPLACÉ, plans de tournée en FUSION),
 * Gammes (entité obligatoire, rangement borné à l'entité, rattachement de personne REMPLACÉ),
 * Études de marché (lignes / acteurs par nom, FUSION des valeurs, suppression CRITIQUE en
 * cascade, présentations IA versionnées).
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

const PREFIXE = "__ops4b__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let delegateId = "";
let doctorId = "";
let visitId = "";
let directoryId = "";
let planId = "";
let companyId = "";
let rangeId = "";
let productId = "";
let researchId = "";
let rowId = "";
let playerId = "";
let presentationId = "";

const sa = () => userWith({
  MEDICAL: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  ADMIN: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  BUSINESS_DEVELOPMENT: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  REGULATORY: ["VIEW", "CREATE", "UPDATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 4b — Annuaire médical, Gammes, Études de marché", () => {
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
    await prisma.marketResearchPresentationVersion.deleteMany({ where: { presentation: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.marketResearchPresentation.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.marketResearchPlayer.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.marketResearchRow.deleteMany({ where: { product: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.marketResearch.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalVisit.deleteMany({ where: { doctor: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalDirectory.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalDelegatePlan.deleteMany({ where: { delegate: { email: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.productRange.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, d] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Yacine`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; delegateId = d.id;

    const doctor = await prisma.medicalDoctor.create({
      data: {
        name: `${TAG} Dr Benali`, title: "PROFESSEUR", specialty: "Cardiologie", sector: "HOSPITAL",
        institution: "CHU Mustapha", city: "Alger", phone: "0550 11 22 33",
        influence: "HIGH", potential: "VERY_HIGH", affinity: "MEDIUM",
        targetProducts: "Bisoprolol", comments: "KOL cardio", delegateId: d.id,
      },
    });
    doctorId = doctor.id;
    const visit = await prisma.medicalVisit.create({
      data: { doctorId: doctor.id, delegateId: d.id, date: new Date("2026-08-18T00:00:00Z"), status: "PLANNED", objective: "Présentation gamme cardio" },
    });
    visitId = visit.id;
    const directory = await prisma.medicalDirectory.create({ data: { name: `${TAG} Cardiologues Centre` } });
    directoryId = directory.id;
    const plan = await prisma.medicalDelegatePlan.create({
      data: { delegateId: d.id, weekStart: new Date("2026-08-03T00:00:00Z"), region: "Centre", productTarget: "Bisoprolol", visitsTarget: 40, keyDoctorsTarget: 8 },
    });
    planId = plan.id;

    const company = await prisma.company.create({ data: { name: `${TAG} Adventum Test` } });
    companyId = company.id;
    const range = await prisma.productRange.create({ data: { companyId: company.id, name: `${TAG} Cardio`, description: "Gamme cardio", color: "#a00" } });
    rangeId = range.id;
    const product = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-9`, dci: `${TAG} BISOPROLOL`, status: "SUBMITTED", companyId: company.id },
    });
    productId = product.id;

    const research = await prisma.marketResearch.create({ data: { title: `${TAG} Étude cardio 2026`, notes: "Périmètre ville", sources: "IQVIA 2025" } });
    researchId = research.id;
    const row = await prisma.marketResearchRow.create({
      data: { researchId: research.id, product: `${TAG} Bisoprolol 5 mg`, marketVolume: 1_200_000, marketValueUsd: 4_000_000, sortOrder: 0 },
    });
    rowId = row.id;
    const player = await prisma.marketResearchPlayer.create({
      data: { rowId: row.id, rank: 1, name: `${TAG} Biopharm`, marketShareValue: 38, status: "MANUFACTURING" },
    });
    playerId = player.id;
    const presentation = await prisma.marketResearchPresentation.create({
      data: {
        researchId: research.id, title: `${TAG} Présentation cardio`,
        versions: { create: { version: 1, analysis: {} } },
      },
    });
    presentationId = presentation.id;
  });


  describe("Annuaire — praticiens en FUSION, visites champ-par-champ", () => {
    it("update_doctor : changer le SEUL téléphone rejoue grade, segmentation, produits cibles ET délégué", async () => {
      const p = await buildProposal("medical_operation", {
        op: "update_doctor", doctor: "Dr Benali", phone: "0770 99 88 77",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(doctorId);
      expect(a.phone).toBe("0770 99 88 77");
      expect(a.title).toBe("PROFESSEUR");
      expect(a.potential).toBe("VERY_HIGH");
      expect(a.targetProducts).toBe("Bisoprolol");
      expect(a.delegateId).toBe(delegateId);
      expect(a.institution).toBe("CHU Mustapha");
    });

    it("delete_doctor : CRITIQUE — confirmText = nom, visites emportées comptées", async () => {
      const p = await buildProposal("medical_operation", { op: "delete_doctor", doctor: "Dr Benali" }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG} Dr Benali`);
      expect(p.fields.map((f) => f.value).join(" ")).toContain("1");
    });

    it("set_doctor_cell : colonne + valeur — l'écriture d'UNE cellule comme dans la feuille", async () => {
      const p = await buildProposal("medical_operation", {
        op: "set_doctor_cell", doctor: "Dr Benali", field: "wilaya", value: "Alger",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).field).toBe("wilaya");
        expect(domainArgs(p).value).toBe("Alger");
      }
    });

    it("update_visit : la visite se résout par praticien+date ; SEULS les champs donnés partent", async () => {
      const p = await buildProposal("medical_operation", {
        op: "update_visit", doctor: "Dr Benali", date: "2026-08-18", notes: "Revoir après le congrès",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(visitId);
      expect(a.status ?? null).toBeNull();
      expect(a.objective).toBe("Revoir après le congrès");
      expect(a.report).toBeNull();
    });

    it("update_visit : reportée ou annulée ne passe pas par elle — le refus vient AVANT la carte et nomme « Ma journée » (§118.193)", async () => {
      // L'action refuse ce changement (motif et fenêtre de 48 h vivent dans « Ma journée ») : construire la carte
      // quand même offrirait un geste qu'on retire au clic (§118.83).
      const p = await buildProposal("medical_operation", {
        op: "update_visit", doctor: "Dr Benali", date: "2026-08-18", status: "reportée", notes: "Revoir après le congrès",
      }, sa());
      expect("error" in p).toBe(true);
      if ("error" in p) expect(p.error).toMatch(/Ma journée/);
    });

    it("update_visit / create_visit : une visite FAITE ne passe pas par elles — le refus vient AVANT la carte et nomme log_visit", async () => {
      // §118.71 : l'action refuse désormais le statut « réalisée » (ni fenêtre de 48 h, ni gamme, ni
      // matériel remis). Construire la carte quand même offrirait un geste qu'on retire au clic.
      const u = await buildProposal("medical_operation", {
        op: "update_visit", doctor: "Dr Benali", date: "2026-08-18", status: "réalisée", report: "RAS, très intéressé",
      }, sa());
      expect("error" in u).toBe(true);
      if ("error" in u) expect(u.error).toMatch(/log_visit/);
      const c = await buildProposal("medical_operation", {
        op: "create_visit", doctor: "Dr Benali", date: "2026-08-18", status: "réalisée",
      }, sa());
      expect("error" in c).toBe(true);
      if ("error" in c) expect(c.error).toMatch(/log_visit/);
    });

    it("set_directory_access : liste RESTREINTE par noms ; « tous » lève la restriction", async () => {
      const p = await buildProposal("medical_operation", {
        op: "set_directory_access", directory: "Cardiologues Centre", people: `${TAG} Yacine`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(directoryId);
        expect(domainArgs(p).userIds).toBe(delegateId);
        expect(p.warnings.join(" ")).toMatch(/REMPLACE/);
      }
      const open = await buildProposal("medical_operation", {
        op: "set_directory_access", directory: "Cardiologues Centre", people: "tous",
      }, sa());
      expect("error" in open).toBe(false);
      if (!("error" in open)) expect(domainArgs(open).userIds).toBe("");
    });

    it("update_plan : FUSION — changer les visites cibles rejoue région, produit et médecins clés", async () => {
      const p = await buildProposal("medical_operation", {
        op: "update_plan", person: `${TAG} Yacine`, quantity: "50",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(planId);
      expect(a.visitsTarget).toBe("50");
      expect(a.region).toBe("Centre");
      expect(a.productTarget).toBe("Bisoprolol");
      expect(a.keyDoctorsTarget).toBe("8");
    });
  });

  describe("Gammes — clé de lecture de la plateforme", () => {
    it("create_range : l'entité est OBLIGATOIRE et résolue par nom", async () => {
      const noEntity = await buildProposal("org_operation", { op: "create_range", range: "Onco" }, sa());
      expect("error" in noEntity).toBe(true);
      const p = await buildProposal("org_operation", {
        op: "create_range", range: "Onco", entity: `${TAG} Adventum`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).companyId).toBe(companyId);
    });

    it("set_products_range : produits par référence, gamme résolue ; « aucune » = sortir", async () => {
      const p = await buildProposal("org_operation", {
        op: "set_products_range", products: `${TAG}-REG-9`, range: `${TAG} Cardio`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).rangeId).toBe(rangeId);
      expect(domainArgs(p).productIds).toBe(productId);

      const out = await buildProposal("org_operation", {
        op: "set_products_range", products: `${TAG}-REG-9`, range: "aucune",
      }, sa());
      expect("error" in out).toBe(false);
      if (!("error" in out)) expect(domainArgs(out).rangeId).toBeNull();
    });

    it("set_user_ranges : liste REMPLACÉE ; « aucune » détache tout", async () => {
      const p = await buildProposal("org_operation", {
        op: "set_user_ranges", person: `${TAG} Yacine`, range: `${TAG} Cardio`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).userId).toBe(delegateId);
        expect(domainArgs(p).rangeIds).toBe(rangeId);
      }
      const detach = await buildProposal("org_operation", {
        op: "set_user_ranges", person: `${TAG} Yacine`, range: "aucune",
      }, sa());
      expect("error" in detach).toBe(false);
      if (!("error" in detach)) expect(domainArgs(detach).rangeIds).toBe("");
    });
  });

  describe("Études de marché — lignes, acteurs, présentations", () => {
    it("update_research_row : FUSION — corriger la valeur rejoue le volume existant", async () => {
      const p = await buildProposal("bd_operation", {
        op: "update_research_row", research: "Étude cardio", row: "Bisoprolol", amount: "4500000",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(rowId);
      expect(a.marketValueUsd).toBe("4500000");
      expect(a.marketVolume).toBe("1200000");
    });

    it("update_research_player : part et origine existantes REJOUÉES quand on ne change que le nom", async () => {
      const p = await buildProposal("bd_operation", {
        op: "update_research_player", research: "Étude cardio", row: "Bisoprolol", player: "Biopharm", newName: `${TAG} Biopharm Algérie`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(playerId);
      expect(a.marketShareValue).toBe("38");
      expect(a.status).toBe("MANUFACTURING");
    });

    it("delete_research : CRITIQUE — confirmText = titre, cascade lignes + présentations annoncée", async () => {
      const p = await buildProposal("bd_operation", { op: "delete_research", research: "Étude cardio" }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG} Étude cardio 2026`);
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/1 ligne\(s\).*1 présentation\(s\)/);
    });

    it("regenerate_presentation : la CONSIGNE est obligatoire (c'est elle qui justifie une version)", async () => {
      const noInstruction = await buildProposal("bd_operation", {
        op: "regenerate_presentation", presentation: "Présentation cardio",
      }, sa());
      expect("error" in noInstruction && noInstruction.error).toMatch(/consigne/i);
      const p = await buildProposal("bd_operation", {
        op: "regenerate_presentation", presentation: "Présentation cardio", notes: "Insister sur le marché hospitalier",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).presentationId).toBe(presentationId);
        expect(p.warnings.join(" ")).toMatch(/NOUVELLE VERSION/);
      }
    });

    it("create_research : les molécules données deviennent des lignes (virgules acceptées)", async () => {
      const p = await buildProposal("bd_operation", {
        op: "create_research", research: `${TAG} Étude anti-infectieux`, molecules: "amoxicilline, ceftriaxone",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).molecules).toBe("amoxicilline\nceftriaxone");
        expect(p.title).toContain("Étude anti-infectieux");
      }
    });
  });
});
