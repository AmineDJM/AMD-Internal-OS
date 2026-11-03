import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE EXIGENCE DÉDUITE D'UN MOT NE TUE PAS UNE MISSION — mais une faute de plan, si.
 *
 * ── REPRODUIT EN DIRECT, SUR LE VRAI FOURNISSEUR ────────────────────────────────────────
 *
 *   « Sors-moi, pour chaque contrat en cours, la date d'échéance, la clause de renouvellement
 *     et la pénalité de retard. UN TABLEAU, et dis-moi combien de contrats n'ont pas ces
 *     informations. »
 *
 * `exigencesFermes` lit « tableau » + un verbe de production et exige DOCUMENT. Le
 * planificateur comprend un tableau À L'ÉCRAN — lecture au moins aussi juste — et n'écrit pas
 * d'étape ARTIFACT. Le compilateur refuse, le planificateur refait le même plan, la mission
 * meurt : zéro valeur rendue sur une demande parfaitement réalisable.
 *
 * Le plan est pourtant EXÉCUTABLE. Il part donc, et la lacune est DÉCLARÉE avec le résultat.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `exig${Date.now().toString(36)}`;
let pdg: CurrentUser;

const etape = (o: { key: string; capability: string | null }) => ({
  key: o.key, title: o.key, workstream: "principal",
  nodeType: "CAPABILITY" as const, capability: o.capability,
  inputs: [{ key: "query", kind: "TEXT" as const, value: "contrats en cours" }],
  dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
  waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
  outputFields: [], completionCondition: "c'est lu.", reasoningRequirement: "NONE" as const,
  approvalRequirement: "NONE" as const, maxAttempts: null,
});

const planDe = (capacite: string | null) => planScripte({
  goal: "Sortir les échéances des contrats en cours.",
  reasoningComplexity: "B", executionScale: "S",
  acceptanceCriteria: ["Les échéances sont restituées."],
  workstreams: [{ id: "principal", title: "Contrats", outcome: "Les échéances sont connues." }],
  steps: [etape({ key: "recherche:contrats", capability: capacite })],
  expectedArtifacts: [], approvalStrategy: "BUNDLE",
  completionCriteria: "Les échéances sont restituées.", gaps: [], rationale: "lecture",
});

const DEMANDE = "Sors-moi, pour chaque contrat en cours, la date d'échéance. Un tableau.";

suite("une exigence déduite d'un mot ne tue pas une mission", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
  }, 60_000);
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: pdg.id } }).catch(() => {});
  }, 60_000);

  it("« un tableau » sans étape ARTIFACT : la mission PART, et la lacune est dite", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planDe("search_everything") }))]);
    const r = await lancerMission(pdg, DEMANDE, { reasoner: cerveau, sansEnquete: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    // La lacune voyage AVEC le plan : le dirigeant la lit avec le résultat, pas à la place.
    expect(r.gaps.join(" ")).toContain("DOCUMENT");
    const journal = await prisma.missionEvent.findMany({ where: { missionId: r.missionId, kind: "GAP_DECLARED" }, select: { summary: true } });
    expect(journal.length).toBe(1);
    expect(journal[0].summary).toContain("reste ouvert");
  }, 120_000);

  /**
   * LE CAS QUI FAIT TOMBER LA TOLÉRANCE (§118.17) : une faute de PLAN reste mortelle. Sans
   * cette moitié, on aurait échangé un refus à tort contre l'exécution de n'importe quoi.
   */
  it("une capacité INVENTÉE tue toujours la mission — la tolérance ne porte que sur la couverture", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planDe("outil_qui_nexiste_pas") }))]);
    const r = await lancerMission(pdg, DEMANDE, { reasoner: cerveau, sansEnquete: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(`${r.error}`).toMatch(/outil_qui_nexiste_pas|capacit/i);
  }, 120_000);
});
