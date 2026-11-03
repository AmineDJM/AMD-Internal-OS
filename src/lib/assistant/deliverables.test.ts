import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";
import { parseSpec, renderDocx, renderXlsx, renderPptx, type DeliverableSpec } from "./deliverables";

/**
 * LIVRABLES UNIVERSELS + SIMULATION — les garanties de la mission, testées sur le réel :
 *   • les fichiers générés sont de VRAIS .docx/.xlsx/.pptx (on les rouvre et on relit le contenu) ;
 *   • les trois formats sortent de LA MÊME spec → chiffres identiques par construction ;
 *   • la section Sources existe TOUJOURS (et signale son absence de contenu) ;
 *   • simulate_scenario N'ÉCRIT JAMAIS : la base est identique avant/après.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eaosd__${Date.now()}`;
let ceoId = "", otherId = "";

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

const SPEC: DeliverableSpec = {
  title: `${TAG} Marché insuline Algérie`,
  subtitle: "Synthèse de cadrage",
  sections: [
    {
      heading: "Synthèse exécutive",
      paragraphs: ["Le marché est estimé à 4 200 000 unités (ESTIMATION — méthode : extrapolation PCH 2025)."],
      bullets: ["Trois acteurs concentrent l'essentiel du volume."],
      table: null,
    },
    {
      heading: "Le marché en chiffres",
      paragraphs: [],
      bullets: [],
      table: { columns: ["Produit", "Volume", "Prix"], rows: [["Lantus", "1200000", "2 450"], ["Levemir", "800000", "2 310"]] },
    },
  ],
  sources: ["ERP — relevés de stock PCH (2026-08)", "ESTIMATION — méthode : extrapolation linéaire"],
};

suite("livrables universels + simulation — fichiers réels, zéro écriture simulée", () => {
  beforeAll(async () => {
    const [c, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    ceoId = c.id; otherId = o.id;
  });

  afterAll(async () => {
    await prisma.assistantArtifact.deleteMany({ where: { ownerId: { in: [ceoId, otherId] } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: [ceoId, otherId] } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("parseSpec borne tout et refuse le vide", () => {
    expect("error" in parseSpec({})).toBe(true);
    expect("error" in parseSpec({ title: "x", sections: [] })).toBe(true);
    const ok = parseSpec({ title: "x", sections: [{ heading: "H", paragraphs: ["p"] }] });
    expect("error" in ok).toBe(false);
  });

  it("le .docx est un vrai document Word : on le rouvre et on y relit titre, chiffre et Sources", () => {
    const buf = renderDocx(SPEC, { version: 1, generatedAt: new Date() });
    const zip = new PizZip(buf);
    const xml = zip.file("word/document.xml")!.asText();
    expect(xml).toContain("Marché insuline Algérie");
    expect(xml).toContain("1200000"); // le chiffre du tableau
    expect(xml).toContain("Sources");
    expect(xml).toContain("extrapolation PCH 2025"); // l'estimation reste marquée
  });

  it("le .xlsx est un vrai classeur : la cellule chiffrée est un NOMBRE, l'onglet Sources existe", async () => {
    const buf = await renderXlsx(SPEC, { version: 1, generatedAt: new Date() });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe("Synthèse");
    expect(names.some((n) => n.startsWith("Le marché en chiffres"))).toBe(true);
    expect(names).toContain("Sources");
    const table = wb.worksheets.find((w) => w.name.startsWith("Le marché en chiffres"))!;
    expect(table.getRow(2).getCell(2).value).toBe(1200000); // NOMBRE, pas texte : les formules marchent
  });

  it("une cellule AAAA-MM-JJ devient une VRAIE date Excel (tri et filtres du lecteur fonctionnels)", async () => {
    const spec = parseSpec({
      title: "Dates réelles", sections: [{
        heading: "Échéances", table: { columns: ["Dossier", "Cible"], rows: [["REG-2026-001", "2026-09-30"]] },
      }], sources: ["test"],
    });
    if ("error" in spec) throw new Error(spec.error);
    const buf = await renderXlsx(spec, { version: 1, generatedAt: new Date() });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets.find((w) => w.name.startsWith("Échéances"))!;
    const cell = ws.getRow(2).getCell(2);
    expect(cell.value).toBeInstanceOf(Date); // une date, pas une chaîne
    expect(cell.numFmt).toBe("yyyy-mm-dd");
  });

  it("le .pptx est un vrai PowerPoint : diapos de titre, de section et de Sources", async () => {
    const buf = await renderPptx(SPEC, { version: 1, generatedAt: new Date() });
    const zip = new PizZip(buf);
    expect(zip.file("[Content_Types].xml")!.asText()).toContain("presentationml");
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(4); // titre + 2 sections + sources
    const all = slides.map((f) => zip.file(f)!.asText()).join("");
    expect(all).toContain("Marché insuline Algérie");
    expect(all).toContain("Sources");
  });

  it("draft_deliverable ALL : trois fichiers de LA MÊME spec au Drive + registre v1, puis v2 via artifact_id", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    const r = await executePowerTool("draft_deliverable", {
      title: SPEC.title, subtitle: SPEC.subtitle, format: "ALL",
      sections: SPEC.sections.map((s) => ({ heading: s.heading, paragraphs: s.paragraphs, bullets: s.bullets, ...(s.table ? { table: s.table } : {}) })),
      sources: SPEC.sources,
    }, ceo);
    const out = JSON.parse(r!) as { version: number; fichiers: { format: string; lien: string; telechargement: string }[]; coherence?: string };
    expect(out.version).toBe(1);
    expect(out.fichiers.map((f) => f.format).sort()).toEqual(["DOCX", "PPTX", "XLSX"]);
    expect(out.coherence).toMatch(/MÊME spec/i);
    // GOLDEN I — « un Excel téléchargeable ICI » : chaque fichier porte son lien de
    // TÉLÉCHARGEMENT DIRECT (mêmes ACL que le Drive), pas seulement le lien Drive.
    for (const f of out.fichiers) {
      expect(f.telechargement).toMatch(/^\/api\/drive\/.+\/raw$/);
      expect(f.lien).toMatch(/^\/drive\//);
    }

    const row = await prisma.assistantArtifact.findFirst({ where: { ownerId: ceoId, title: SPEC.title } });
    expect(row?.version).toBe(1);

    // Nouvelle version — le registre s'incrémente, le fichier -v2 part au Drive.
    const r2 = await executePowerTool("draft_deliverable", {
      title: SPEC.title, format: "DOCX", artifact_id: row!.id,
      sections: [{ heading: "Synthèse exécutive", paragraphs: ["Version révisée."] }],
      sources: SPEC.sources,
    }, ceo);
    expect(JSON.parse(r2!).version).toBe(2);

    // Un AUTRE compte ne peut pas versionner le livrable d'autrui.
    const stolen = await executePowerTool("draft_deliverable", {
      title: "vol", artifact_id: row!.id, sections: [{ heading: "x", paragraphs: ["y"] }],
    }, asUser(otherId, "DIRECTION"));
    expect(stolen).toMatch(/introuvable dans VOTRE registre/i);

    const listed = await executePowerTool("list_artifacts", { query: "insuline" }, ceo);
    expect(listed).toContain(SPEC.title);
    expect(listed).toContain('"version":2');
  });

  it("simulate_scenario SALARY_CHANGE : hypothèses DITES, et AUCUNE écriture — le salaire en base ne bouge pas", async () => {
    const emp = await prisma.employee.create({
      data: { fullName: `${TAG} Sim Personne`, baseSalary: 100_000, employerCost: 140_000, isActive: true },
    });
    const r = await executePowerTool("simulate_scenario", {
      kind: "SALARY_CHANGE", employee_name: `${TAG} Sim`, new_base_salary: 120_000,
    }, asUser(ceoId, "DIRECTION", { RH: ["VIEW"] }));
    const out = JSON.parse(r!) as { simulation: string; estimation: { surcoutEmployeurMensuelDzd: number }; hypotheses: string[] };
    expect(out.simulation).toMatch(/AUCUNE écriture/);
    expect(out.estimation.surcoutEmployeurMensuelDzd).toBe(28000); // 20 % de 140 000 (ratio conservé)
    expect(out.hypotheses.length).toBeGreaterThan(0);

    const after = await prisma.employee.findUnique({ where: { id: emp.id }, select: { baseSalary: true } });
    expect(Number(after!.baseSalary)).toBe(100000); // RIEN n'a bougé
  });

  it("les scénarios salariaux exigent le module RH ; la trésorerie exige Finances", async () => {
    const noRh = await executePowerTool("simulate_scenario", { kind: "DEPARTURE", employee_name: "x" }, asUser(ceoId, "DIRECTION"));
    expect(noRh).toMatch(/module RH/);
    const noFin = await executePowerTool("simulate_scenario", { kind: "CASH_TREND" }, asUser(ceoId, "DIRECTION"));
    expect(noFin).toMatch(/module Finances/);
  });

  it("company_state dit qu'une section est FERMÉE plutôt que de la deviner", async () => {
    const r = await executePowerTool("company_state", {}, asUser(ceoId, "DIRECTION"));
    const out = JSON.parse(r!) as { effectifEtMasse: unknown; tresorerie: unknown };
    expect(String(out.effectifEtMasse)).toMatch(/fermée — exige le module RH/);
    expect(String(out.tresorerie)).toMatch(/fermée — exige le module Finances/);
  });
});
