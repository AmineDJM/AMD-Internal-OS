import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 7d — administration profonde : FUSION de la fiche d'entité, département
 * (rattachement et responsable rejoués, suppression au remontage annoncée), accès aux entités
 * (auto-modification interdite), Centre de contrôle IA (couper l'interrupteur général prévient
 * qu'il éteint AUSSI l'assistant, bascules rejouées), seuil du Risk Radar borné et grille
 * rejouée, suppression DÉFINITIVE Drive armée par la ressaisie du nom, carte d'identité légale
 * par libellé (FUSION), champ personnalisé par libellé (FUSION, FICHIER refusé), lignes
 * accordées en FUSION, suppression de SON courrier par référence.
 */

/**
 * « RH » EN SOUS-MODULES (7dece361, Direction 06/10) : Employés, Demandes RH et Formations sont des modules à part, et chaque
 * rôle qui tenait « RH » y a reçu EXACTEMENT ses gestes de « RH » (défauts de `rbac.ts`, accès personnalisés recopiés par la
 * migration `20270114180000_sous_modules_rh`). Une fixture qui écrit ses droits à la main reçoit la même recopie.
 */
function avecSousModulesRh(actions: Action[]): Partial<Record<Module, Action[]>> {
  return { RH: actions, EMPLOYEES: actions, HR_REQUESTS: actions, TRAINING: actions };
}

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

const PREFIXE = "__ops7d__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let memberId = "";
let companyId = "";
let parentDeptId = "";
let childDeptId = "";
let headEmployeeId = "";
let productAId = "";
let productBId = "";
let driveNodeId = "";
let mailEntryId = "";
let aiBefore: { masterEnabled: boolean } | null = null;

const sa = () => userWith({ ADMIN: ["VIEW", "CREATE", "UPDATE"], ...avecSousModulesRh(["VIEW", "UPDATE"]), LEGAL: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 7d — administration profonde", () => {
  beforeAll(async () => {
    const [s, m] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Walid Ventes`, email: `${TAG}m@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; memberId = m.id;

    const company = await prisma.company.create({
      data: { name: `${TAG} Entite Alpha`, shortName: "ALPHA", color: "#2266cc", createdById: s.id },
    });
    companyId = company.id;
    await prisma.companyLegalIdentity.create({
      data: { companyId: company.id, legalName: `${TAG} ALPHA PHARMA SPA`, rcNumber: "16/00-123456" },
    });

    const head = await prisma.employee.create({ data: { fullName: `${TAG} Karim Chef` } });
    headEmployeeId = head.id;
    const parent = await prisma.department.create({ data: { name: `${TAG} Direction Commerciale`, code: `${TAG}A` } });
    parentDeptId = parent.id;
    const child = await prisma.department.create({
      data: { name: `${TAG} Ventes Sud`, code: `${TAG}B`, parentId: parent.id, description: "Couvre le grand sud", headId: head.id },
    });
    childDeptId = child.id;
    await prisma.department.create({ data: { name: `${TAG} Ventes Tamanrasset`, code: `${TAG}C`, parentId: child.id } });
    await prisma.employee.create({ data: { fullName: `${TAG} Louiza Rep`, departmentId: child.id, department: child.name } });

    const [pa, pb] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-REG-A`, dci: `${TAG} RIFAMPICINE`, status: "SUBMITTED" } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-REG-B`, dci: `${TAG} NINTEDANIB`, status: "SUBMITTED" } }),
    ]);
    productAId = pa.id; productBId = pb.id;
    await prisma.rowGrant.create({ data: { userId: m.id, entityType: "REGULATORY_PRODUCT", entityId: pb.id } });

    await prisma.customFieldDef.createMany({
      data: [
        { entityType: "REGULATORY_PRODUCT", key: `${TAG}_code_douane`.toLowerCase(), label: `${TAG} Code douane`, type: "TEXT", order: 90 },
        { entityType: "REGULATORY_PRODUCT", key: `${TAG}_fiche_scan`.toLowerCase(), label: `${TAG} Fiche scannée`, type: "FILE", order: 91 },
      ],
    });

    const node = await prisma.driveNode.create({ data: { name: `${TAG} rapport-audit.pdf`, type: "FILE", ownerId: s.id, size: 10 } });
    driveNodeId = node.id;

    const mail = await prisma.mailEntry.create({
      data: { reference: `${TAG}-CRR-9`, title: `${TAG} Mise en demeure DGI`, direction: "INCOMING" },
    });
    mailEntryId = mail.id;

    aiBefore = await prisma.aiSetting.findUnique({ where: { id: "global" }, select: { masterEnabled: true } });
    await prisma.aiSetting.upsert({
      where: { id: "global" }, create: { id: "global", masterEnabled: true }, update: { masterEnabled: true },
    });
  });

  afterAll(async () => {
    if (aiBefore) await prisma.aiSetting.update({ where: { id: "global" }, data: { masterEnabled: aiBefore.masterEnabled } }).catch(() => {});
    await prisma.customFieldDef.deleteMany({ where: { label: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.rowGrant.deleteMany({ where: { entityId: { in: [productAId, productBId] } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { company: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  });

  it("update_company : renommer SEUL rejoue nom court, couleur et activation (FUSION)", async () => {
    const p = await buildProposal("org_operation", {
      op: "update_company", name: `${TAG} Entite Alpha`, newName: `${TAG} Entite Alpha Groupe`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).id).toBe(companyId);
      expect(domainArgs(p).shortName).toBe("ALPHA");
      expect(domainArgs(p).color).toBe("#2266cc");
      expect(domainArgs(p).isActive).toBe("on");
    }
  });

  it("update_department : renommer SEUL rejoue le rattachement, le responsable et la description (FUSION)", async () => {
    const p = await buildProposal("org_operation", {
      op: "update_department", department: "Ventes Sud", newName: `${TAG} Ventes Grand Sud`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).id).toBe(childDeptId);
      expect(domainArgs(p).parentId).toBe(parentDeptId);
      expect(domainArgs(p).headId).toBe(headEmployeeId);
      expect(domainArgs(p).description).toBe("Couvre le grand sud");
    }
  });

  it("delete_department : le remontage des sous-départements et le détachement des membres sont annoncés", async () => {
    const p = await buildProposal("org_operation", { op: "delete_department", department: "Ventes Sud" }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const text = p.fields.map((f) => `${f.label} ${f.value}`).join(" ");
      expect(text).toMatch(/remontent d'un cran/);
      expect(text).toMatch(/non affectés/);
    }
  });

  it("set_company_access : un non-SA ne touche JAMAIS ses propres accès ; le mode FR se traduit", async () => {
    const rh = userWith({ RH: ["VIEW", "UPDATE"] }, "MEDICAL_DELEGATE", memberId, "Walid");
    const self = await buildProposal("org_operation", {
      op: "set_company_access", person: "Walid Ventes", company: "Entite Alpha", mode: "voir",
    }, rh);
    expect("error" in self && self.error).toMatch(/PROPRES accès/);

    const p = await buildProposal("org_operation", {
      op: "set_company_access", person: "Walid Ventes", company: "Entite Alpha", mode: "voir et modifier",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).userId).toBe(memberId);
      expect(domainArgs(p).companyId).toBe(companyId);
      expect(domainArgs(p).mode).toBe("edit");
    }
  });

  it("update_ai_settings : couper l'interrupteur général prévient qu'il éteint AUSSI l'assistant — bascules rejouées", async () => {
    const p = await buildProposal("org_operation", {
      op: "update_ai_settings", feature: "interrupteur général", value: "couper",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).masterEnabled).toBe("off");
      expect(domainArgs(p).assistantEnabled).toMatch(/^(on|off)$/);
      expect(p.warnings.join(" ")).toMatch(/y compris cet assistant/);
    }
  });

  it("update_risk_thresholds : la valeur est BORNÉE et la grille entière rejouée (FUSION)", async () => {
    const p = await buildProposal("org_operation", {
      op: "update_risk_thresholds", field: "Budget — seuil d'alerte", value: "250",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).budgetWarnPct).toBe("100");
      expect(p.warnings.join(" ")).toMatch(/BORNÉE/);
      expect(Object.keys(domainArgs(p))).toContain("stockLowThreshold");
    }
  });

  it("permanently_delete_drive_node : la confirmation exige la RESSAISIE du nom, l'irréversibilité est dite", async () => {
    const p = await buildProposal("org_operation", {
      op: "permanently_delete_drive_node", name: `${TAG} rapport-audit.pdf`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).id).toBe(driveNodeId);
      expect(p.confirmText).toBe(`${TAG} rapport-audit.pdf`);
      expect(p.warnings.join(" ")).toMatch(/IRRÉVERSIBLE/);
    }
  });

  it("save_company_identity : le champ se donne par LIBELLÉ, la carte existante est rejouée (FUSION)", async () => {
    const p = await buildProposal("legal_operation", {
      op: "save_company_identity", company: "Entite Alpha", field: "NIF", value: "099916000123456",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).companyId).toBe(companyId);
      expect(domainArgs(p).nif).toBe("099916000123456");
      expect(domainArgs(p).legalName).toBe(`${TAG} ALPHA PHARMA SPA`);
      expect(domainArgs(p).rcNumber).toBe("16/00-123456");
    }
  });

  it("set_custom_field : champ par libellé + FUSION ; un champ FICHIER renvoie vers l'écran", async () => {
    const p = await buildProposal("task_operation", {
      op: "set_custom_field", kind: "REGULATORY_PRODUCT", target: `${TAG}-REG-A`,
      field: `${TAG} Code douane`, value: "TARIF 3004",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).entityId).toBe(productAId);
      expect(domainArgs(p)[`cf_${TAG.toLowerCase()}_code_douane`]).toBe("TARIF 3004");
    }

    const file = await buildProposal("task_operation", {
      op: "set_custom_field", kind: "REGULATORY_PRODUCT", target: `${TAG}-REG-A`,
      field: `${TAG} Fiche scannée`, value: "x",
    }, sa());
    expect("error" in file && file.error).toMatch(/FICHIER/);
  });

  it("set_row_grants : l'ajout d'une ligne REJOUE les lignes déjà accordées (FUSION)", async () => {
    const p = await buildProposal("org_operation", {
      op: "set_row_grants", person: "Walid Ventes", type: "REGULATORY_PRODUCT", record: `${TAG}-REG-A`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const ids = JSON.parse(domainArgs(p).rowIds ?? "[]") as string[];
      expect(ids).toContain(productAId);
      expect(ids).toContain(productBId);
      expect(domainArgs(p).entityType).toBe("REGULATORY_PRODUCT");
    }
  });

  it("delete_own_record : MON courrier se résout par référence, la réversibilité (corbeille) est dite", async () => {
    const p = await buildProposal("task_operation", {
      op: "delete_own_record", kind: "courrier", target: `${TAG}-CRR-9`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).kind).toBe("MAIL_ENTRY");
      expect(domainArgs(p).id).toBe(mailEntryId);
      expect(p.warnings.join(" ")).toMatch(/corbeille/);
    }
  });
});
