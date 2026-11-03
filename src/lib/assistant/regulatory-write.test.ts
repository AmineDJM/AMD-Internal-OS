import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal } from "@/lib/assistant";

/**
 * GOLDEN RÉGRESSION — la SURFACE D'ACTION Regulatory du Chief (§18) :
 * tout ce que l'UI autorisée sait faire, le Chief sait le PROPOSER — même porte, même règle —
 * et la parité est un PLANCHER, pas un plafond (le Chief résout par référence là où l'écran
 * exige de naviguer jusqu'à la fiche).
 *
 *   • CONFIER un dossier (« Chargé du dossier ») : champ STRUCTUREL → Super Admin seulement,
 *     exactement comme l'écran (`setRegulatoryResponsible` réutilisée à l'exécution).
 *   • Mettre à jour UNE étape ANPP (statut / avis de présoumission) : droit REGULATORY UPDATE.
 *   • SUPPRIMER définitivement (bouton rouge des fiches, Super Admin) : le Chief PROPOSE la
 *     même suppression via `delete_record` — niveau CRITIQUE (référence à ressaisir), exécutée
 *     par l'action canonique `superAdminDelete` (instantané en corbeille, restaurable). Le
 *     premier audit avait affirmé le contraire (« l'UI ne supprime pas ») : FAUX — le bouton
 *     vit dans le composant PARTAGÉ `SuperAdminDeleteButton`, pas dans les pages Regulatory.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "PDG", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__rw__${Date.now()}`;
let adminId = "";
let raihanaId = "";

suite("surface d'action Regulatory — proposer tout ce que l'écran autorise, rien de plus", () => {
  beforeAll(async () => {
    const [admin, raihana] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Raihana`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "HEAD_OF_REGULATORY" } }),
    ]);
    adminId = admin.id;
    raihanaId = raihana.id;
    await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-1`, dci: `${TAG} Pembrolizumab`, status: "SUBMITTED" },
    });
  });

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("CONFIER un dossier : proposition complète (dossier, avant → après, avertissement notification)", async () => {
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("assign_regulatory_responsible", { reference: `${TAG}-REG-1`, personName: `${TAG} Raihana` }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("assign_regulatory_responsible");
    expect(p.title).toContain("Raihana");
    expect(JSON.stringify(p.fields)).toContain("Pembrolizumab");
    expect(p.warnings?.join(" ")).toMatch(/NOTIFIÉE/);
    const payload = p.payload as { responsibleId: string; before: string };
    expect(payload.responsibleId).toBe(raihanaId);
    expect(payload.before).toBe("(personne)");
  });

  it("LA MÊME PORTE QUE L'ÉCRAN : un non-Super-Admin ne propose PAS l'assignation (champ structurel)", async () => {
    const direction = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "DIRECTION", raihanaId);
    const p = await buildProposal("assign_regulatory_responsible", { reference: `${TAG}-REG-1`, personName: `${TAG} Raihana` }, direction);
    expect("error" in p && p.error).toMatch(/Super Admin/);
  });

  it("personne AMBIGUË → candidats listés, jamais un choix silencieux", async () => {
    await prisma.user.create({ data: { name: `${TAG} Raihana Bis`, email: `${TAG}rb@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } });
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("assign_regulatory_responsible", { reference: `${TAG}-REG-1`, personName: `${TAG} Raihana` }, admin);
    expect("error" in p && p.error).toMatch(/Plusieurs personnes/);
  });

  it("étape ANPP : statut proposé avec libellé réel ; avis de présoumission par outcome uniquement", async () => {
    const chef = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "HEAD_OF_REGULATORY", raihanaId);
    const p = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "depot", status: "DONE" }, chef);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.title).toContain("Dépôt du dossier");
    // L'avis ne vaut que pour presub_ans — et presub_ans exige un avis.
    const bad = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "depot", outcome: "FAVORABLE" }, chef);
    expect("error" in bad && bad.error).toMatch(/presub_ans/);
    const bad2 = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "presub_ans" }, chef);
    expect("error" in bad2 && bad2.error).toMatch(/AVIS/);
  });

  it("étape inconnue / statut invalide → refus net (validation AVANT la carte, jamais après)", async () => {
    const chef = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "HEAD_OF_REGULATORY", raihanaId);
    const p1 = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "etape_fantome", status: "DONE" }, chef);
    expect("error" in p1 && p1.error).toMatch(/inconnue/);
    const p2 = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "depot", status: "TERMINÉ" }, chef);
    expect("error" in p2 && p2.error).toMatch(/Statut invalide/);
  });

  it("SANS le droit REGULATORY UPDATE, l'étape ne se propose pas — le droit de l'écran fait foi", async () => {
    const viewer = userWith({ REGULATORY: ["VIEW"] }, "DIRECTION", raihanaId);
    const p = await buildProposal("set_regulatory_step", { reference: `${TAG}-REG-1`, stepKey: "depot", status: "DONE" }, viewer);
    expect("error" in p && p.error).toMatch(/pas le droit/);
  });

  it("référence HORS périmètre → introuvable (deviner une référence ne donne aucun pouvoir)", async () => {
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("assign_regulatory_responsible", { reference: `${TAG}-FANTOME`, personName: `${TAG} Admin` }, admin);
    expect("error" in p && p.error).toMatch(/introuvable/);
  });

  it("SUPPRIMER : le Super Admin obtient une proposition CRITIQUE complète (même suppression que le bouton rouge)", async () => {
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("delete_record", { kind: "REGULATORY_PRODUCT", reference: `${TAG}-REG-1` }, admin);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.kind).toBe("delete_record");
    expect(p.level).toBe("CRITICAL");
    // La confirmation forte exige de RESSAISIR la référence du dossier — pas un simple clic.
    expect(p.confirmText).toBe(`${TAG}-REG-1`);
    expect(p.title).toContain("SUPPRIMER");
    expect(p.title).toContain("Pembrolizumab");
    // La carte dit l'impact ET la réversibilité réelle (corbeille) — pas de fausse irréversibilité.
    expect(JSON.stringify(p.fields)).toContain("pièces jointes");
    expect(p.warnings.join(" ")).toMatch(/corbeille/i);
    expect(p.warnings.join(" ")).toMatch(/cascade/i);
    const payload = p.payload as { deleteKind: string; targetId: string; redirect: string };
    expect(payload.deleteKind).toBe("REGULATORY_PRODUCT");
    expect(payload.redirect).toBe("/regulatory");
    const row = await prisma.regulatoryProduct.findUnique({ where: { reference: `${TAG}-REG-1` }, select: { id: true } });
    expect(payload.targetId).toBe(row?.id);
  });

  it("SUPPRIMER : refusé à quiconque n'est pas Super Admin — la même porte que le bouton", async () => {
    const direction = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "DIRECTION", raihanaId);
    const p = await buildProposal("delete_record", { kind: "REGULATORY_PRODUCT", reference: `${TAG}-REG-1` }, direction);
    expect("error" in p && p.error).toMatch(/Super Admin/);
  });

  it("SUPPRIMER : type inconnu ou cible introuvable → refus net, jamais une carte approximative", async () => {
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p1 = await buildProposal("delete_record", { kind: "TABLE_FANTOME", reference: `${TAG}-REG-1` }, admin);
    expect("error" in p1 && p1.error).toMatch(/non supprimable/);
    const p2 = await buildProposal("delete_record", { kind: "REGULATORY_PRODUCT", reference: `${TAG}-INEXISTANT` }, admin);
    expect("error" in p2 && p2.error).toMatch(/Aucun élément/);
  });

  it("SUPPRIMER : plusieurs candidats sans correspondance exacte → candidats listés, jamais un choix silencieux", async () => {
    await prisma.regulatoryProduct.createMany({
      data: [
        { reference: `${TAG}-REG-2`, dci: `${TAG} Fosfomycine sachet`, status: "SUBMITTED" },
        { reference: `${TAG}-REG-3`, dci: `${TAG} Fosfomycine IV`, status: "SUBMITTED" },
      ],
    });
    const admin = userWith({ REGULATORY: ["VIEW", "UPDATE"] }, "SUPER_ADMIN", adminId);
    const p = await buildProposal("delete_record", { kind: "REGULATORY_PRODUCT", reference: `${TAG} Fosfomycine` }, admin);
    expect("error" in p && p.error).toMatch(/Plusieurs éléments/);
    expect("error" in p && p.error).toContain(`${TAG}-REG-2`);
    expect("error" in p && p.error).toContain(`${TAG}-REG-3`);
    // La référence EXACTE, elle, tranche même au milieu d'homonymes.
    const exact = await buildProposal("delete_record", { kind: "REGULATORY_PRODUCT", reference: `${TAG}-REG-2` }, admin);
    expect("error" in exact).toBe(false);
    if (!("error" in exact)) expect((exact.payload as { deleteKind: string }).deleteKind).toBe("REGULATORY_PRODUCT");
  });
});
