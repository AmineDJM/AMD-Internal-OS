import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * C1 (décisions 0042, 0044) — LA VALIDATION D'UN CHANTIER, RÉVERSIBLE : `validerMonChantier` EXÉCUTÉE (le bouton
 * « Valider » du tableau « Missions »), puis ANNULÉE (le bouton « Annuler »), contre la base locale :
 *   • le geste n'a pas encore agi → la validation est retirée, l'étape attend de nouveau la Direction ;
 *   • la fusion a eu lieu → COMPENSÉE : une PR de revert est demandée (jamais un force-push).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { validerMonChantier } from "@/modules/assistant-ia/actions-travaux";
import { conduireChantier } from "@/lib/missions/chantiers/conduite";
import { approuverChantier, proposerChantier } from "@/lib/missions/chantiers/service";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { REGLAGES_CHANTIERS_DEFAUT } from "@/lib/missions/chantiers/regles";

/** Les plafonds du JOUR sont communs à toute la suite : relevés au banc (les plafonds par chantier restent ceux par défaut). */
const REGLAGES = { ...REGLAGES_CHANTIERS_DEFAUT, jourLancementsMax: 100, jourDeploiementsMax: 100, jourUsdMax: 1000 };
import { fauxPortsDev, type FauxPorts } from "@/lib/missions/chantiers/faux-test-outils";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zc1rev${Date.now()}`;
let moi: CurrentUser;
let n = 0;
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
const cerveau: CerveauChantier = { disponibles: () => ({ mimo: false, terra: false, sol: false }), executer: async () => ({ ok: false, erreur: "aucun modèle au banc" }) };

const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};

async function chantierQuiAttendLaFusion(ports: FauxPorts): Promise<string> {
  const r = await proposerChantier(moi.id, {
    titre: `${TAG} ${++n}`, objectif: "Une route de santé.", depot: { proprietaire: "aminedjm", nom: `depot-${TAG}-${n}` }, branche: `claude/${TAG}-${n}`,
    perimetre: ["src/lib/missions/chantiers/**"], criteres: ["la route rend 200"], services: [],
  });
  if (!r.ok) throw new Error(r.fautes.join(" "));
  const a = await approuverChantier(r.chantierId, moi.id);
  if (!a.ok) throw new Error(a.erreur);
  await conduire(r.chantierId, ports, 4);
  return r.chantierId;
}

const horloge = { t: Date.now(), now() { return new Date(this.t); } };
async function conduire(id: string, ports: FauxPorts, fois: number): Promise<void> {
  for (let i = 0; i < fois; i++) {
    await conduireChantier(id, { ports, cerveau, clock: horloge, reglages: REGLAGES, interrupteur: PAS_SUSPENDU });
    horloge.t += 31 * 60_000;
  }
}
const dossier = async (id: string) => lireDossier((await prisma.mission.findUniqueOrThrow({ where: { id }, select: { carnet: true } })).carnet)!;

suite("C1 — valider un chantier : exécuter, annuler (retirer ou compenser)", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Direction`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as CurrentUser;
    ACTOR = moi;
  }, 60_000);

  afterAll(async () => {
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: moi.id } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: moi.id } }).catch(() => undefined);
    await prisma.mission.deleteMany({ where: { ownerId: moi.id } }).catch(() => undefined);
    await prisma.memoireTechnique.deleteMany({ where: { cle: { contains: TAG.toLowerCase() } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: moi.id } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: moi.id } }).catch(() => undefined);
  }, 60_000);

  it("avant la fusion : la validation est retirée, l'étape attend de nouveau la Direction", async () => {
    const ports = fauxPortsDev({ surSession: () => ({ sha: "c1c1000000000001", checks: "vert" }) });
    const id = await chantierQuiAttendLaFusion(ports);
    const g = gesteDe(await validerMonChantier(id, true));
    expect((await dossier(id)).validations.fusionner?.decision).toBe("ACCORDEE");
    const r = await annulerGeste(g, moi);
    if ("refus" in r) throw new Error(r.refus);
    expect(r.details.map((x) => x.issue)).toContain("ANNULE");
    expect((await dossier(id)).validations.fusionner).toBeUndefined();
    expect((await prisma.missionStep.findFirstOrThrow({ where: { missionId: id, key: "fusionner" } })).status).toBe("WAITING");
    await conduire(id, ports, 2);
    expect(ports.journal.some((j) => j.quoi === "fusionner")).toBe(false);
  }, 60_000);

  it("après la fusion : COMPENSÉE — une PR de revert est demandée puis ouverte, jamais un force-push", async () => {
    const ports = fauxPortsDev({ surSession: () => ({ sha: "c2c2000000000001", checks: "vert" }) });
    const id = await chantierQuiAttendLaFusion(ports);
    const g = gesteDe(await validerMonChantier(id, true));
    await conduire(id, ports, 4);
    expect((await dossier(id)).fusion?.pr).toBe(1);
    const r = await annulerGeste(g, moi);
    if ("refus" in r) throw new Error(r.refus);
    expect(r.details.map((x) => x.issue)).toContain("COMPENSE");
    expect((await dossier(id)).revertDemande?.par).toBe(moi.id);
    await conduire(id, ports, 1);
    expect((await dossier(id)).revert?.numero).toBe(101);
    expect(ports.journal.filter((j) => j.quoi === "revert")).toHaveLength(1);
  }, 60_000);
});
