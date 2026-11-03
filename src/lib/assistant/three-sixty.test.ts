import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";
import { yearsBetween, tenureLabel } from "./three-sixty";
import { indexDriveNodeText } from "./document-discovery";

/**
 * VUES 360° ET DÉCOUVERTE DOCUMENTAIRE — aller-retour réel.
 *
 * Les scénarios de la mission, joués contre la vraie base :
 *   • « Parle-moi de Khaled » → âge CALCULÉ au backend avec sa source, salaire visible
 *     UNIQUEMENT avec le module RH, activité marquée OBSERVÉ vs NON OBSERVABLE ;
 *   • le contrat MAL NOMMÉ (« scan_0234.txt ») retrouvé par son CONTENU (index textuel),
 *     jamais montré à qui n'a pas le droit Drive sur le fichier.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eaosc__${Date.now()}`;
let ceoId = "", strangerId = "", empId = "", nodeId = "";

function asUser(id: string, role: CurrentUser["role"], perms: Partial<Record<Module, Action[]>> = {}): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "T", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

suite("vues 360° et découverte documentaire — chemin réel", () => {
  beforeAll(async () => {
    const [ceo, stranger] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}ceo@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG}etranger`, email: `${TAG}etr@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    ceoId = ceo.id; strangerId = stranger.id;

    // Un employé complet : né le 15/03/1990, embauché le 01/02/2020, CDD jusqu'à fin 2026.
    const emp = await prisma.employee.create({
      data: {
        fullName: `${TAG} Khaled Benali`, position: "Chargé des affaires réglementaires",
        birthDate: new Date(Date.UTC(1990, 2, 15)), hireDate: new Date(Date.UTC(2020, 1, 1)),
        contractType: "CDD", contractStart: new Date(Date.UTC(2024, 0, 1)), contractEnd: new Date(Date.UTC(2026, 11, 31)),
        baseSalary: 180_000, netToPay: 145_000, employerCost: 240_000,
      },
    });
    empId = emp.id;

    // Le contrat MAL NOMMÉ dans le Drive du PDG : le nom ne dit rien, le CONTENU dit tout.
    const node = await prisma.driveNode.create({
      data: { name: "scan_0234.txt", type: "FILE", ownerId: ceoId, size: 220 },
    });
    nodeId = node.id;
    const blob = await prisma.fileBlob.create({
      data: { sha256: `${TAG}sha`, size: 220, iv: Buffer.alloc(12) },
    });
    const version = await prisma.fileVersion.create({
      data: { nodeId: node.id, blobId: blob.id, version: 1, size: 220 },
    });
    // L'index textuel a déjà « lu » ce fichier (comme après un read_document).
    await indexDriveNodeText(
      node.id, version.id,
      `CONTRAT DE TRAVAIL À DURÉE DÉTERMINÉE — Monsieur ${TAG} Khaled Benali, né le 15/03/1990, est engagé en qualité de chargé des affaires réglementaires…`,
    );
  });

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { nodeId } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { id: nodeId } }).catch(() => {});
    await prisma.fileBlob.deleteMany({ where: { sha256: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("l'âge se calcule au BACKEND, calendrier exact (anniversaire passé ou non)", () => {
    expect(yearsBetween(new Date(Date.UTC(1990, 2, 15)), new Date(Date.UTC(2026, 7, 24)))).toBe(36);
    expect(yearsBetween(new Date(Date.UTC(1990, 11, 31)), new Date(Date.UTC(2026, 7, 24)))).toBe(35); // pas encore fêté
    expect(tenureLabel(new Date(Date.UTC(2020, 1, 1)), new Date(Date.UTC(2026, 7, 24)))).toBe("6 ans et 6 mois");
  });

  it("employee_360 : âge AVEC SA SOURCE, contrat, salaire MASQUÉ sans le module RH", async () => {
    const r = await executePowerTool("employee_360", { name: `${TAG} Khaled` }, asUser(ceoId, "DIRECTION"));
    const data = JSON.parse(r!) as Record<string, never> & {
      age: { annees: number; source: string };
      remuneration: unknown;
      activiteObservee: string;
      contrat: { type: string };
    };
    expect(data.age.annees).toBe(yearsBetween(new Date(Date.UTC(1990, 2, 15)), new Date()));
    expect(data.age.source).toContain("1990-03-15"); // la provenance, toujours
    expect(data.contrat.type).toBe("CDD");
    // PAS de module RH dans ce compte → la rémunération est un refus, pas un chiffre.
    expect(String(data.remuneration)).toMatch(/réservée aux détenteurs du module RH/);
    // Pas de compte applicatif → l'outil DIT « non observable », il ne conclut pas.
    expect(String(data.activiteObservee)).toMatch(/NON OBSERVABLE/);
  });

  it("employee_360 : AVEC le module RH, le salaire sort — relu de la fiche, avec sa source", async () => {
    const r = await executePowerTool("employee_360", { name: `${TAG} Khaled` }, asUser(ceoId, "DIRECTION", { RH: ["VIEW"] }));
    const data = JSON.parse(r!) as { remuneration: { salaireDeBaseDzd: number; coutEmployeurDzd: number; source: string } };
    expect(data.remuneration.salaireDeBaseDzd).toBe(180000);
    expect(data.remuneration.coutEmployeurDzd).toBe(240000);
    expect(data.remuneration.source).toMatch(/fiche RH/);
  });

  it("find_documents : le contrat MAL NOMMÉ est retrouvé par son CONTENU, confiance HAUTE, preuve citée", async () => {
    const r = await executePowerTool("find_documents", { query: `contrat ${TAG} Benali` }, asUser(ceoId, "DIRECTION"));
    const data = JSON.parse(r!) as { resultats: { nom: string; confiance: string; preuve?: string }[]; rappel: string };
    const hit = data.resultats.find((x) => x.nom === "scan_0234.txt");
    expect(hit, "le fichier mal nommé doit sortir malgré son nom").toBeDefined();
    expect(hit!.confiance).toBe("HAUTE");
    expect(hit!.preuve).toContain("CONTRAT DE TRAVAIL");
    expect(data.rappel).toMatch(/indice, pas une preuve/i);
  });

  it("find_documents ne montre JAMAIS un fichier auquel le compte n'a pas droit — même indexé", async () => {
    // Le fichier appartient au PDG ; un AUTRE compte Direction, sans partage, ne doit pas le voir.
    const r = await executePowerTool("find_documents", { query: `contrat ${TAG} Benali` }, asUser(strangerId, "DIRECTION"));
    expect(r).not.toContain("scan_0234.txt");
  });

  it("supplier_360 dit l'absence plutôt que d'inventer ; process_insights ne fabrique pas de moyenne sans cas clos", async () => {
    // §118.20 : le refus garde la FORME de la réponse — mêmes clés, valeurs vides. Une phrase
    // nue tuerait toute référence qu'un plan aurait écrite sur `depensesPayees` ou `legal`.
    const none = JSON.parse((await executePowerTool("supplier_360", { name: `${TAG}-fournisseur-inconnu` }, asUser(ceoId, "DIRECTION"))) ?? "{}");
    expect(none.precision).toMatch(/Aucune trace/);
    expect(none.retenu).toEqual([]);
    expect(none.candidats).toEqual([]);
    expect(none, "les clés de la réponse pleine doivent exister, à null").toHaveProperty("depensesPayees");
    expect(none).toHaveProperty("legal");

    const proc = await executePowerTool("process_insights", {}, asUser(ceoId, "DIRECTION"));
    expect(proc).toContain("fenetre"); // la fenêtre est annoncée ; les sections vides disent « aucun cas clos »
  });

  it("les vues 360 restent fermées aux comptes non autorisés", async () => {
    const bare = asUser(strangerId, "DELEGATE" as CurrentUser["role"]);
    for (const name of ["employee_360", "supplier_360", "organization_insights", "process_insights", "find_documents"]) {
      const r = await executePowerTool(name, { name: "x", query: "xx", product: "x" }, bare);
      expect(r, name).toMatch(/ne vous est pas ouvert/i);
    }
    // product_360 s'ouvre par le DROIT Regulatory, pas par le rôle.
    const noReg = await executePowerTool("product_360", { product: "x" }, bare);
    expect(noReg).toMatch(/ne vous est pas ouvert/i);
  });
});
