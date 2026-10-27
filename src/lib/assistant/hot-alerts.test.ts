import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { MODULES, ACTIONS } from "@/lib/rbac";
import { POWER_TOOLS } from "@/lib/assistant/power-tools";
import { ETAT_ALERTES, alertesExecutivesChaudes, rechaufferAlertes } from "@/lib/assistant/hot-alerts";
import { recordEvent } from "@/lib/events/ledger";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SIGNAUX EXÉCUTIFS CHAUDS (fabric F5) — prouvés par les VRAIS points d'entrée (§14).
 *
 * Trois branchements, trois preuves :
 *   1. le BATTEMENT réchauffe les dirigeants récemment actifs (rechaufferAlertes) ;
 *   2. les OUTILS (company_state) servent l'état précalculé et DISENT sa fraîcheur ;
 *   3. le REGISTRE D'ÉVÉNEMENTS invalide l'état — un fait métier inscrit après le calcul
 *      interdit de servir le calcul tel quel. Ce test épingle aussi la constante `kind`
 *      utilisée par le ledger : si elle divergeait de ETAT_ALERTES, il tomberait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__hotal_${Date.now().toString(36)}`;

function direction(id: string): CurrentUser {
  const modules = new Map(MODULES.map((m) => [
    m as Module,
    { module: m as Module, actions: new Set(ACTIONS as readonly Action[]), scope: "ALL" as const },
  ]));
  return {
    id, name: "PDG", email: `${TAG}@t.dz`, role: "DIRECTION",
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

suite("assistant/hot-alerts — les signaux précalculés, branchés partout", () => {
  let dirigeantId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}d`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    dirigeantId = u.id;
    // Une session RÉCENTE : c'est le critère du réchauffage (pas de travail pour les absents).
    await prisma.userSession.create({
      data: { userId: dirigeantId, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.assistantHotState.deleteMany({ where: { subjectId: dirigeantId } }).catch(() => {});
    await prisma.userSession.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("le BATTEMENT réchauffe le dirigeant récemment actif — l'état existe AVANT la question", async () => {
    const r = await rechaufferAlertes();
    expect(r.rechauffes).toBeGreaterThanOrEqual(1);
    const ligne = await prisma.assistantHotState.findUnique({
      where: { kind_subjectId: { kind: ETAT_ALERTES, subjectId: dirigeantId } },
    });
    expect(ligne, "le réchauffage doit avoir persisté l'état de ce dirigeant").toBeTruthy();
    expect(ligne!.costMs).toBeGreaterThanOrEqual(0);
  });

  it("company_state SERT le précalculé et DIT sa fraîcheur — par le vrai outil", async () => {
    const tool = POWER_TOOLS.find((t) => t.def.name === "company_state")!;
    const out = JSON.parse(await tool.run({}, direction(dirigeantId)));
    expect(out.signaux.fraicheur, "la fraîcheur des signaux doit être DITE dans la réponse")
      .toMatch(/précalculés .* coût mesuré \d+ ms/);
  });

  it("un FAIT MÉTIER inscrit au registre INVALIDE l'état — la lecture suivante recalcule et le dit", async () => {
    // L'état est chaud (réchauffé ci-dessus). Un fait métier arrive :
    await recordEvent({ type: `${TAG}.fait`, sourceDomain: "TEST" });
    const ligne = await prisma.assistantHotState.findUnique({
      where: { kind_subjectId: { kind: ETAT_ALERTES, subjectId: dirigeantId } },
    });
    expect(ligne?.staleAt, "le registre d'événements doit avoir marqué l'état périmé").not.toBeNull();

    // La lecture suivante refuse le précalculé démenti : elle recalcule, et le DIT.
    const lecture = await alertesExecutivesChaudes(direction(dirigeantId));
    expect(lecture.voie).toBe("CALCULE");
  });

  it("SABOTAGE — le réchauffage est appelé par le battement (scheduled.ts), pas seulement par ses tests", () => {
    const src = readFileSync("src/lib/scheduled.ts", "utf8");
    expect(src).toMatch(/etape\("rechaufferAlertes", rechaufferAlertes\)/);
  });
});
