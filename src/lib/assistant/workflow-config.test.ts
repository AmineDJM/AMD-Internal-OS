import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { buildProposal } from "@/lib/assistant";
import { missingRequiredValues, fileCustomValue, formatCustomValue } from "@/lib/custom-fields";

/**
 * GOLDEN RÉGRESSION — le Chief ADMINISTRE les circuits et les formulaires (mission « il doit
 * pouvoir tout faire ») :
 *
 *   • CIRCUITS : « Ajoute Finance après Information Médicale » = configure_workflow avec la
 *     liste COMPLÈTE recomposée (AVANT → APRÈS sur la carte) — même builder que l'écran,
 *     mêmes règles (au moins un APPROVE, titres obligatoires), Super Admin uniquement.
 *   • ÉTAPES : approuver / refuser / SAUTER une personne — SKIP sans raison refusé DÈS la
 *     proposition (la raison est tracée et notifiée) ; résolution de la demande par référence.
 *   • CHAMPS : « Rends ce champ obligatoire » = manage_custom_field UPDATE required=true,
 *     avant → après ; le serveur refuse ensuite toute fiche sans ce champ
 *     (`missingRequiredValues`, pur — un Oui/Non n'est jamais « manquant »).
 */

function userWith(role: CurrentUser["role"], id: string, name = "PDG"): CurrentUser {
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__wfc__${Date.now()}`;
let adminId = "";
let sponsoId = "";

suite("administration des circuits et des formulaires par le Chief", () => {
  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    adminId = admin.id;
    // Circuit SPONSORING personnalisé : 2 étapes (Information Médicale → Direction).
    const def = await prisma.workflowDefinition.upsert({
      where: { category: "SPONSORING" },
      update: { name: `${TAG} Circuit sponsoring` },
      create: { category: "SPONSORING", name: `${TAG} Circuit sponsoring` },
    });
    await prisma.workflowStep.deleteMany({ where: { definitionId: def.id } });
    await prisma.workflowStep.createMany({
      data: [
        { definitionId: def.id, position: 0, slug: "info-med", title: "Information Médicale", actorScope: "ROLE", actorRoles: ["MEDICAL_INFO"], powers: ["APPROVE", "REJECT", "COMMENT"] },
        { definitionId: def.id, position: 1, slug: "direction", title: "Direction", actorScope: "GLOBAL_VIEW", actorRoles: [], powers: ["APPROVE", "REJECT"] },
      ],
    });
    // Une demande engagée dans ce circuit, en attente à l'étape Information Médicale.
    const sponso = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}-SPO-1`, institution: `${TAG} CHU Oran`, type: "Sponsoring scientifique", requesterId: adminId },
    });
    sponsoId = sponso.id;
    await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType: "SPONSORING", entityId: sponso.id, category: "SPONSORING", status: "IN_PROGRESS", currentSlug: "info-med" },
    });
  });

  afterAll(async () => {
    await prisma.workflowInstance.deleteMany({ where: { entityId: sponsoId } }).catch(() => {});
    const def = await prisma.workflowDefinition.findUnique({ where: { category: "SPONSORING" }, select: { id: true, name: true } });
    if (def?.name.startsWith(TAG)) {
      await prisma.workflowStep.deleteMany({ where: { definitionId: def.id } }).catch(() => {});
      await prisma.workflowDefinition.delete({ where: { id: def.id } }).catch(() => {});
    }
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.customFieldDef.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("GOLDEN « Ajoute Finance après Information Médicale » : carte AVANT → APRÈS, liste complète recomposée", async () => {
    const admin = userWith("SUPER_ADMIN", adminId);
    const steps = JSON.stringify([
      { slug: "info-med", title: "Information Médicale", actorScope: "ROLE", actorRoles: ["MEDICAL_INFO"], powers: ["APPROVE", "REJECT", "COMMENT"] },
      { title: "Finance", actorScope: "ROLE", actorRoles: ["FINANCE_BUDGET_MANAGER"], powers: ["APPROVE", "REJECT", "SET_AMOUNT"] },
      { slug: "direction", title: "Direction", actorScope: "GLOBAL_VIEW", actorRoles: [], powers: ["APPROVE", "REJECT"] },
    ]);
    const p = await buildProposal("configure_workflow", { category: "sponsoring", steps }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("configure_workflow");
    expect(p.level).toBe("SENSITIVE");
    const json = JSON.stringify(p.fields);
    expect(json).toContain("1. Information Médicale · 2. Finance · 3. Direction");
    expect(json).toContain("1. Information Médicale · 2. Direction"); // l'AVANT
    expect(p.warnings.join(" ")).toMatch(/slug/i);
    const payload = p.payload as { category: string; payloadJson: string | null };
    expect(payload.category).toBe("SPONSORING");
    expect(JSON.parse(payload.payloadJson ?? "{}").steps).toHaveLength(3);
  });

  it("CIRCUITS : les règles du builder tiennent dès la proposition (Super Admin, ≥1 APPROVE, titres)", async () => {
    const direction = userWith("DIRECTION", adminId);
    const refused = await buildProposal("configure_workflow", { category: "SPONSORING", steps: "[]" }, direction);
    expect("error" in refused && refused.error).toMatch(/Super Admin/);

    const admin = userWith("SUPER_ADMIN", adminId);
    const noApprove = await buildProposal("configure_workflow", {
      category: "SPONSORING",
      steps: JSON.stringify([{ title: "Avis seul", actorScope: "ROLE", actorRoles: ["MEDICAL_INFO"], powers: ["COMMENT"] }]),
    }, admin);
    expect("error" in noApprove && noApprove.error).toMatch(/approuver/i);
    const noTitle = await buildProposal("configure_workflow", {
      category: "SPONSORING",
      steps: JSON.stringify([{ actorScope: "ROLE", actorRoles: ["MEDICAL_INFO"], powers: ["APPROVE"] }]),
    }, admin);
    expect("error" in noTitle && noTitle.error).toMatch(/titre/i);
  });

  it("ÉTAPES : sauter une personne exige une RAISON — et la carte dit l'étape courante et ses acteurs", async () => {
    const admin = userWith("SUPER_ADMIN", adminId);
    const noReason = await buildProposal("advance_workflow", { category: "SPONSORING", reference: `${TAG}-SPO-1`, action: "SKIP" }, admin);
    expect("error" in noReason && noReason.error).toMatch(/RAISON/i);

    const p = await buildProposal("advance_workflow", {
      category: "SPONSORING", reference: `${TAG}-SPO-1`, action: "SKIP", note: "Titulaire absent cette semaine — décision urgente",
    }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.title).toContain("SAUTER");
    const json = JSON.stringify(p.fields);
    expect(json).toContain("Information Médicale");
    expect(json).toContain(`${TAG}-SPO-1`);
    expect(p.warnings.join(" ")).toMatch(/TRACÉ/i);
    const payload = p.payload as { action: string; entityId: string };
    expect(payload.action).toBe("SKIP");
    expect(payload.entityId).toBe(sponsoId);

    const ghost = await buildProposal("advance_workflow", { category: "SPONSORING", reference: `${TAG}-FANTOME`, action: "APPROVE" }, admin);
    expect("error" in ghost && ghost.error).toMatch(/Aucune demande/);
  });

  it("GOLDEN « Rends ce champ obligatoire » : UPDATE required=true, avant → après, avertissement d'effet immédiat", async () => {
    await prisma.customFieldDef.create({
      data: { entityType: "ADMIN_REQUEST", key: `${TAG}_motif`, label: `${TAG} Motif détaillé`, type: "TEXT", required: false },
    });
    const admin = userWith("SUPER_ADMIN", adminId);
    const p = await buildProposal("manage_custom_field", {
      op: "UPDATE", module: "Demande administrative", label: `${TAG} Motif détaillé`, required: true,
    }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("manage_custom_field");
    expect(JSON.stringify(p.fields)).toContain("devient OBLIGATOIRE");
    expect(p.warnings.join(" ")).toMatch(/ne s'enregistrent plus sans/);
    const payload = p.payload as { op: string; required: boolean; defId: string | null };
    expect(payload.op).toBe("UPDATE");
    expect(payload.required).toBe(true);
    expect(payload.defId).toBeTruthy();
  });

  it("CHAMPS : créer (SELECT exige ses choix), supprimer (les valeurs restent), porte Super Admin", async () => {
    const admin = userWith("SUPER_ADMIN", adminId);
    const noOpts = await buildProposal("manage_custom_field", { op: "CREATE", module: "Regulatory", label: `${TAG} Zone`, type: "SELECT" }, admin);
    expect("error" in noOpts && noOpts.error).toMatch(/choix/i);

    const create = await buildProposal("manage_custom_field", {
      op: "CREATE", module: "Regulatory", label: `${TAG} Zone`, type: "SELECT", options: "Nord, Sud", required: true,
    }, admin);
    expect("error" in create).toBe(false);
    if (!("error" in create)) expect(JSON.stringify(create.fields)).toContain("OUI — la fiche ne s'enregistre plus");

    await prisma.customFieldDef.create({
      data: { entityType: "REGULATORY_PRODUCT", key: `${TAG}_lot`, label: `${TAG} Numéro de lot`, type: "TEXT" },
    });
    const del = await buildProposal("manage_custom_field", { op: "DELETE", module: "Regulatory", label: `${TAG} Numéro de lot` }, admin);
    expect("error" in del).toBe(false);
    if (!("error" in del)) expect(del.warnings.join(" ")).toMatch(/RESTENT/);

    const direction = userWith("DIRECTION", adminId);
    const refused = await buildProposal("manage_custom_field", { op: "CREATE", module: "Regulatory", label: "X" }, direction);
    expect("error" in refused && refused.error).toMatch(/Super Admin/);
  });
});

describe("missingRequiredValues — la règle serveur du champ obligatoire (pure)", () => {
  const defs = [
    { key: "motif", label: "Motif détaillé", type: "TEXT", required: true },
    { key: "montant", label: "Montant", type: "NUMBER", required: false },
    { key: "urgent", label: "Urgent", type: "BOOLEAN", required: true },
  ];
  it("liste les obligatoires vides — et eux seuls", () => {
    expect(missingRequiredValues(defs, { motif: null, montant: null })).toEqual(["Motif détaillé"]);
    expect(missingRequiredValues(defs, { motif: "  " })).toEqual(["Motif détaillé"]);
    expect(missingRequiredValues(defs, { motif: "Renouvellement AMM" })).toEqual([]);
  });
  it("un Oui/Non n'est jamais « manquant » : décoché est une réponse", () => {
    expect(missingRequiredValues(defs, { motif: "ok", urgent: false })).toEqual([]);
  });

  it("champ FICHIER obligatoire : rempli = une référence Drive VALIDE, pas n'importe quel objet", () => {
    const fileDefs = [{ key: "piece", label: "Pièce justificative", type: "FILE", required: true }];
    expect(missingRequiredValues(fileDefs, {})).toEqual(["Pièce justificative"]);
    expect(missingRequiredValues(fileDefs, { piece: "abc" })).toEqual(["Pièce justificative"]); // un id nu n'est pas une référence stockée
    expect(missingRequiredValues(fileDefs, { piece: { nodeId: "", name: "x" } })).toEqual(["Pièce justificative"]);
    expect(missingRequiredValues(fileDefs, { piece: { nodeId: "n1", name: "Contrat.pdf" } })).toEqual([]);
  });
});

describe("fileCustomValue / formatCustomValue — la valeur FICHIER (pure, partagée client/serveur)", () => {
  it("lit une référence stockée, tolère le nom manquant, refuse le malformé sans jamais lever", () => {
    expect(fileCustomValue({ nodeId: "n1", name: "Contrat.pdf" })).toEqual({ nodeId: "n1", name: "Contrat.pdf" });
    expect(fileCustomValue({ nodeId: "n1" })).toEqual({ nodeId: "n1", name: "document" });
    expect(fileCustomValue(null)).toBeNull();
    expect(fileCustomValue("n1")).toBeNull();
    expect(fileCustomValue({ name: "sans-id.pdf" })).toBeNull();
  });
  it("l'affichage montre le NOM du document (jamais un id brut ni « [object Object] »)", () => {
    expect(formatCustomValue("FILE", { nodeId: "n1", name: "Contrat.pdf" })).toBe("Contrat.pdf");
    expect(formatCustomValue("FILE", null)).toBe("—");
    expect(formatCustomValue("FILE", "n1")).toBe("—");
  });
});
