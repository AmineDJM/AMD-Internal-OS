import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BASCULE « LECTURE DES PIÈCES » — coupée par défaut, et sous l'interrupteur général (lot D2-C).
 *
 * La lecture des lignes par un modèle a un COÛT : sans décision de la Direction, aucune pièce ne
 * part chez un fournisseur. Ce banc tient le défaut (sans ligne, base injoignable : coupée), la
 * hiérarchie (interrupteur coupé : coupée, même fonction allumée), l'accord du défaut du code avec
 * celui de la COLONNE (deux sources, un fait — §118.5), et la porte de l'écran qui la règle.
 *
 * La ligne `AiSetting` est GLOBALE et la suite tourne en parallèle sur une seule base : ce banc ne
 * l'écrit JAMAIS (§118.132). Le client de base est simulé — `findUnique` rend la ligne que le cas
 * décide, `upsert` enregistre ce que l'action aurait écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const base = vi.hoisted(() => ({ aiSetting: { findUnique: vi.fn(), upsert: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: base }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const AUDITS = vi.hoisted(() => [] as { summary?: string }[]);
vi.mock("@/lib/audit", () => ({ recordAudit: async (a: { summary?: string }) => { AUDITS.push(a); } }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR , requireUserAuNomDeLaVue: async () => ACTEUR}));

import { Prisma } from "@prisma/client";
import { aiFeatureEnabled, getAiSettings } from "@/lib/ai-settings";
import { accesAttribue, userCan, type LigneAccesAttribue, type SessionUser } from "@/lib/rbac";
import { updateAiSettings } from "@/lib/actions/ai-settings-actions";

/** Une ligne `AiSetting` complète, toutes fonctions allumées sauf la lecture des pièces (son défaut). */
function ligne(over: Partial<Record<"masterEnabled" | "lecturePiecesEnabled", boolean>> = {}) {
  return {
    id: "global", masterEnabled: true, assistantEnabled: true, proactiveNudgesEnabled: true, brainEnabled: true,
    processIntelEnabled: true, fieldReportAiEnabled: true, voiceTranscriptEnabled: true, siteWebAiEnabled: true,
    lecturePiecesEnabled: false, updatedAt: new Date(), updatedById: null, ...over,
  };
}

function acteur(id: string, role: SessionUser["role"], acces: LigneAccesAttribue[]): CurrentUser {
  return {
    id, name: id, email: `${id}@banc.dz`, role, mustChangePassword: false,
    access: { modules: accesAttribue(role, null, acces).modules, rowGrants: new Map() },
  };
}

const RACINE = join(__dirname, "..", "..");
/** La source sans ses commentaires — un cliquet ne doit pas s'accrocher à la prose qui le décrit (§118.79d). */
const code = (rel: string) =>
  readFileSync(join(RACINE, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function formulaire(cases: Record<string, boolean>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(cases)) if (v) f.set(k, "on");
  return f;
}

beforeEach(() => {
  base.aiSetting.findUnique.mockReset();
  base.aiSetting.upsert.mockReset().mockResolvedValue({});
  AUDITS.length = 0;
  ACTEUR = null;
});

describe("Le défaut : COUPÉE — sans décision de la Direction, aucune pièce ne part chez un fournisseur", () => {
  it("sans ligne : la lecture des pièces est coupée — et les autres fonctions restent allumées (témoin : ce n'est pas une panne générale)", async () => {
    base.aiSetting.findUnique.mockResolvedValue(null);
    expect((await getAiSettings()).lecturePiecesEnabled).toBe(false);
    expect(await aiFeatureEnabled("lecture_pieces")).toBe(false);
    expect(await aiFeatureEnabled("site_web")).toBe(true);
  });

  it("base injoignable : le même défaut — le doute ne fait rien partir", async () => {
    base.aiSetting.findUnique.mockRejectedValue(new Error("base injoignable"));
    expect(await aiFeatureEnabled("lecture_pieces")).toBe(false);
    expect(await aiFeatureEnabled("site_web")).toBe(true);
  });

  it("le défaut du code est celui de la colonne (`@default(false)`) — deux sources, un fait", async () => {
    const champ = Prisma.dmmf.datamodel.models.find((m) => m.name === "AiSetting")?.fields.find((f) => f.name === "lecturePiecesEnabled");
    expect(champ, "la colonne existe (migration 20270104090000_lecture_pieces)").toBeDefined();
    expect(champ!.default).toBe(false);
    base.aiSetting.findUnique.mockResolvedValue(null);
    expect((await getAiSettings()).lecturePiecesEnabled).toBe(champ!.default);
  });
});

describe("Sous l'interrupteur général — et sous sa propre bascule", () => {
  it("interrupteur général coupé : coupée même fonction allumée ; rallumé, c'est la bascule qui décide (témoin)", async () => {
    base.aiSetting.findUnique.mockResolvedValue(ligne({ masterEnabled: false, lecturePiecesEnabled: true }));
    expect(await aiFeatureEnabled("lecture_pieces")).toBe(false);
    base.aiSetting.findUnique.mockResolvedValue(ligne({ masterEnabled: true, lecturePiecesEnabled: true }));
    expect(await aiFeatureEnabled("lecture_pieces")).toBe(true);
  });

  it("fonction coupée sous un interrupteur allumé : coupée — et les autres fonctions passent", async () => {
    base.aiSetting.findUnique.mockResolvedValue(ligne({ masterEnabled: true, lecturePiecesEnabled: false }));
    expect(await aiFeatureEnabled("lecture_pieces")).toBe(false);
    expect(await aiFeatureEnabled("site_web")).toBe(true);
  });
});

describe("L'écran qui la règle — `updateAiSettings`, sans écrire la ligne partagée", () => {
  it("le Super Admin enregistre la bascule : cochée, elle s'allume ; absente du formulaire, elle est coupée", async () => {
    ACTEUR = acteur("__lecture__sa", "SUPER_ADMIN", []);
    expect((await updateAiSettings(formulaire({ masterEnabled: true, lecturePiecesEnabled: true }))).ok).toBe(true);
    const [premier] = base.aiSetting.upsert.mock.calls[0]!;
    expect(premier.where).toEqual({ id: "global" });
    expect(premier.create).toMatchObject({ id: "global", lecturePiecesEnabled: true, masterEnabled: true });
    expect(premier.update).toMatchObject({ lecturePiecesEnabled: true });

    // L'action réécrit TOUTES les colonnes : une case non envoyée vaut « coupée ».
    expect((await updateAiSettings(formulaire({ masterEnabled: true, siteWebAiEnabled: true }))).ok).toBe(true);
    const [second] = base.aiSetting.upsert.mock.calls[1]!;
    expect(second.update).toMatchObject({ lecturePiecesEnabled: false, siteWebAiEnabled: true });
  });

  it("un administrateur délégué (ADMIN en écriture) qui n'est pas Super Admin est refusé — rien n'est écrit", async () => {
    const delegue = acteur("__lecture__admin", "DIRECTION", [{
      module: "ADMIN", canView: true, canCreate: false, canUpdate: true, canDelete: false, canValidate: false,
      canExport: false, canUpload: false, scope: "ALL", sections: [],
    }]);
    // Prémisse : le droit du module EST là — le refus ne peut venir que de la règle du Super Admin (§118.104).
    expect(userCan(delegue, "ADMIN", "UPDATE")).toBe(true);
    ACTEUR = delegue;
    expect(await updateAiSettings(formulaire({ masterEnabled: true, lecturePiecesEnabled: true }))).toEqual({ ok: false, error: "Réservé au Super Admin." });
    expect(base.aiSetting.upsert).not.toHaveBeenCalled();
    expect(AUDITS).toHaveLength(0);
  });
});

describe("L'op d'Adam qui rejoue les réglages (FUSION)", () => {
  it("chaque bascule y est rejouée avec le défaut de SA colonne — sans ligne, couper une autre fonction n'allume pas la lecture des pièces", () => {
    const champs = Prisma.dmmf.datamodel.models.find((m) => m.name === "AiSetting")!.fields
      .filter((f) => f.type === "Boolean" && /Enabled$/.test(f.name));
    expect(champs.map((f) => f.name)).toContain("lecturePiecesEnabled"); // prémisse
    const op = code("src/lib/assistant/ops/impl-wave7d.ts");
    for (const f of champs) {
      // L'op réécrit TOUTES les bascules : un défaut faux ALLUMERAIT une fonction payante sans que personne l'ait décidé.
      const m = new RegExp(`\\b${f.name}: s\\?\\.${f.name} \\?\\? (true|false)\\b`).exec(op);
      expect(m, `op ← défaut de ${f.name}`).not.toBeNull();
      expect(m![1], `le défaut de ${f.name} dans l'op est celui de sa colonne`).toBe(String(f.default));
    }
  });
});
