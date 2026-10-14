import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA LIGNE `AiSetting` EST GLOBALE — CE BANC NE L'ÉCRIT PLUS (vague « restes 2 », §118.132, §118.196f).
 *
 * L'ancien banc enregistrait les bascules pour de vrai, puis relisait la ligne. Toute la suite la lit et
 * tourne en parallèle sur une seule base : pendant sa fenêtre, et APRÈS lui, chaque banc voisin lisait les
 * réglages qu'il avait posés. Mesuré en base locale : `brainEnabled = false`, `updatedById` = un compte de
 * banc supprimé depuis — l'IA « cerveau » coupée pour toute la suite, par un test, sans que personne
 * l'ait décidé.
 *
 * Ce qu'il prouvait, il le prouve toujours, sans rien laisser derrière lui :
 *   • l'écriture de `updateAiSettings` est JOUÉE contre la vraie base — le schéma l'éprouve, colonne par
 *     colonne — dans une transaction REJETÉE : sous READ COMMITTED, personne ne voit la pose, et la ligne
 *     partagée est comparée avant et après (un témoin, pas une promesse) ;
 *   • la ligne que cette écriture RENDRAIT devient celle que relit `getAiSettings` — dont la requête est
 *     jouée elle aussi contre la vraie base ;
 *   • le reste du client est le vrai : les comptes du banc, le journal d'audit, et le journal d'usage
 *     (`logAiUsage`), qui écrit sa ligne pour de bon — elle porte le TAG, et elle est retirée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const banc = vi.hoisted(() => ({
  /** La ligne que l'action aurait écrite — c'est elle que relit `getAiSettings`. */
  ligne: null as Record<string, unknown> | null,
  /** Combien d'écritures l'action a TENTÉES (jouées, puis rejetées). */
  ecritures: 0,
  /** Le vrai client, pour lire la ligne PARTAGÉE sans passer par la simulation. */
  reel: null as unknown,
}));

vi.mock("@/lib/prisma", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/prisma")>();
  const reel = mod.prisma;
  banc.reel = reel;
  /** Le rejet qui annule la transaction de l'écriture — reconnu par son identité, jamais par son texte.
   *  Déclaré ICI : la fabrique de `vi.mock` s'exécute avant le corps du module (TDZ). */
  class Rejet extends Error {}
  const aiSetting = {
    findUnique: async (args: Parameters<typeof reel.aiSetting.findUnique>[0]) => {
      await reel.aiSetting.findUnique(args); // la requête du lecteur, éprouvée par la vraie base
      return banc.ligne;
    },
    upsert: async (args: Parameters<typeof reel.aiSetting.upsert>[0]) => {
      let rendu: Record<string, unknown> | null = null;
      await reel.$transaction(async (tx) => {
        rendu = await tx.aiSetting.upsert(args);
        throw new Rejet("écriture du banc, rejetée");
      }).catch((e: unknown) => { if (!(e instanceof Rejet)) throw e; });
      banc.ligne = rendu;
      banc.ecritures += 1;
      return rendu;
    },
  };
  const prisma = new Proxy(reel, {
    get(cible, cle) {
      if (cle === "aiSetting") return aiSetting;
      const v = Reflect.get(cible, cle);
      return typeof v === "function" ? v.bind(cible) : v;
    },
  });
  return { ...mod, prisma };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { aiFeatureEnabled, logAiUsage, getAiSettings } from "./ai-settings";
import { updateAiSettings } from "./actions/ai-settings-actions";

const reel = () => banc.reel as PrismaClient;

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__aitest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

function fd(obj: Record<string, boolean>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) if (v) f.set(k, "on");
  return f;
}

suite("Centre de contrôle IA — bascules & journal d'usage", () => {
  let adminId = "", userId = "";
  /** La ligne PARTAGÉE telle qu'elle était avant le banc — elle doit l'être encore après. */
  let partageeAvant: unknown = undefined;

  beforeAll(async () => {
    partageeAvant = await reel().aiSetting.findUnique({ where: { id: "global" } });
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [admin, user] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("user", "VIEWER")]);
    adminId = admin.id; userId = user.id;
  });

  afterAll(async () => {
    await prisma.aiUsageLog.deleteMany({ where: { feature: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le Super Admin enregistre les bascules ; un non-admin est refusé", async () => {
    ACTOR = await actorFor(userId, "VIEWER");
    expect((await updateAiSettings(fd({ masterEnabled: true, assistantEnabled: true }))).ok).toBe(false);
    expect(banc.ecritures, "un refus n'écrit rien").toBe(0);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await updateAiSettings(fd({
      masterEnabled: true, assistantEnabled: true, brainEnabled: false,
      proactiveNudgesEnabled: true, processIntelEnabled: true, fieldReportAiEnabled: true, voiceTranscriptEnabled: true,
      siteWebAiEnabled: true,
    }));
    expect(r.ok).toBe(true);
    expect(banc.ecritures).toBe(1);
    // La ligne que la VRAIE base a rendue à l'écriture (puis oubliée avec la transaction).
    const row = banc.ligne!;
    expect(row, "la vraie base a accepté l'écriture — colonne par colonne").not.toBeNull();
    expect(row.id).toBe("global");
    expect(row.masterEnabled).toBe(true);
    expect(row.assistantEnabled).toBe(true);
    expect(row.brainEnabled).toBe(false);
    expect(row.updatedById).toBe(adminId);
  });

  it("aiFeatureEnabled respecte la bascule de fonction (master ON, brain OFF)", async () => {
    // État posé par le test précédent : master ON, assistant ON, brain OFF.
    const s = await getAiSettings();
    expect(s.masterEnabled).toBe(true);
    expect(await aiFeatureEnabled("assistant")).toBe(true);
    expect(await aiFeatureEnabled("brain")).toBe(false);
  });

  it("logAiUsage écrit une ligne (best-effort)", async () => {
    await logAiUsage({ feature: `${TAG}feat` as never, userId: adminId, ok: true, latencyMs: 123, model: "claude-test" });
    const row = await prisma.aiUsageLog.findFirst({ where: { feature: `${TAG}feat` } });
    expect(row).not.toBeNull();
    expect(row!.ok).toBe(true);
    expect(row!.latencyMs).toBe(123);
  });

  it("TÉMOIN : la ligne PARTAGÉE n'a pas bougé — aucun banc voisin n'a lu les réglages de celui-ci", async () => {
    expect(banc.ecritures, "prémisse : le banc a bien enregistré des bascules").toBeGreaterThan(0);
    const apres = await reel().aiSetting.findUnique({ where: { id: "global" } });
    expect(apres, "la ligne partagée a été écrite par le banc").toEqual(partageeAvant);
  });
});
