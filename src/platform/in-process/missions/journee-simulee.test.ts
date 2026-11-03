import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { PLAFOND_QUOTIDIEN } from "@/lib/missions/attention/policy";
import type { NiveauSignal, SignalAttention } from "@/lib/missions/ports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE JOURNÉE SIMULÉE — l'anti-spam de la porte d'attention, mesuré sur la VRAIE porte.
 *
 * « Mon attention est une ressource rare. » Douze missions vivantes, une journée chargée : douze
 * fins partielles, douze alertes de surveillance, douze blocages — trente-six signaux qui, chacun
 * pris à part, méritent une information ou une attention. Puis cinq arbitrages. Puis les mêmes
 * faits redits. Puis le lendemain.
 *
 * Ce que la porte doit tenir, et que ce banc compte (par `porteAttentionPour`, horloge injectée,
 * journal réel — jamais un test de `classer` seule) :
 *   • au plus PLAFOND_QUOTIDIEN signaux POUSSÉS hors arbitrage sur vingt-quatre heures ; au-delà,
 *     la ligne existe au centre de notifications (JOURNAL) et l'appareil ne vibre pas ;
 *   • un ARBITRAGE n'est JAMAIS rétrogradé, même le plafond atteint : ce que seule sa décision
 *     débloque ne se met pas en file ;
 *   • le même fait ne se redit pas (cadence par clé) ;
 *   • le lendemain, le compteur rouvre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__jour${Date.now().toString(36)}`;
const N_MISSIONS = 12;
let pdgId = "";
const missions: string[] = [];

let horloge = new Date("2026-09-07T06:00:00Z");
const avancer = (minutes: number) => { horloge = new Date(horloge.getTime() + minutes * 60_000); };
const porte = porteAttentionPour({ envoyerMail: async () => "sans-boite", maintenant: () => horloge });

interface Emis { kind: SignalAttention["kind"]; mission: string; niveau: NiveauSignal; canaux: string[]; supprime: boolean }
async function emettre(signal: Omit<SignalAttention, "ownerId">): Promise<Emis> {
  const r = await porte.signaler({ ...signal, ownerId: pdgId });
  return { kind: signal.kind, mission: signal.missionId, niveau: r.niveau, canaux: r.canaux, supprime: r.supprime };
}
const pousse = (e: Emis) => e.canaux.includes("push");

suite("UNE JOURNÉE SIMULÉE — la porte d'attention ne devient jamais du bruit", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true },
    });
    pdgId = u.id;
    for (let i = 0; i < N_MISSIONS; i++) {
      const m = await prisma.mission.create({
        data: {
          kind: "RUNTIME", status: "RUNNING", title: `${TAG} mission ${i + 1}`,
          objective: `Mission ${i + 1}`, goalRaw: `Mission ${i + 1}`, ownerId: pdgId, planVersion: 1,
        },
        select: { id: true },
      });
      missions.push(m.id);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: pdgId } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: pdgId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: pdgId } }).catch(() => {});
  }, 60_000);

  it("trente-six signaux dignes d'attention, cinq arbitrages, des redites, puis le lendemain", async () => {
    const emis: Emis[] = [];

    // ── LE MATIN : douze missions partiellement faites (INFO), toutes les dix minutes ────────
    for (const [i, m] of missions.entries()) {
      emis.push(await emettre({ kind: "MISSION_PARTIAL", missionId: m, titre: `Mission ${i + 1}`, raison: "une étape reste ouverte", bilan: { faites: 4, total: 6, echouees: 0 }, planVersion: 1 }));
      avancer(10);
    }
    // ── MIDI : douze alertes de surveillance (ATTENTION) ────────────────────────────────
    for (const [i, m] of missions.entries()) {
      emis.push(await emettre({ kind: "WATCH_ALERT", missionId: m, titre: `Mission ${i + 1}`, raison: "échéance dans 3 jours", stepKey: `alerte-${i}`, planVersion: 1 }));
      avancer(10);
    }
    // ── L'APRÈS-MIDI : douze blocages (ATTENTION) ─────────────────────────────────────────
    for (const [i, m] of missions.entries()) {
      emis.push(await emettre({ kind: "MISSION_BLOCKED", missionId: m, titre: `Mission ${i + 1}`, raison: "la cible a disparu", bilan: { faites: 2, total: 6, echouees: 1 }, planVersion: 1 }));
      avancer(10);
    }

    const candidats = emis.filter((e) => !e.supprime);
    expect(candidats).toHaveLength(3 * N_MISSIONS);
    const pousses = candidats.filter(pousse);
    // LE PLAFOND EST ATTEINT ET TENU : exactement PLAFOND_QUOTIDIEN poussés, le reste au journal.
    expect(pousses).toHaveLength(PLAFOND_QUOTIDIEN);
    const retrogrades = candidats.filter((e) => !pousse(e));
    expect(retrogrades).toHaveLength(3 * N_MISSIONS - PLAFOND_QUOTIDIEN);
    for (const e of retrogrades) {
      expect(e.niveau).toBe("JOURNAL");
      expect(e.canaux).toEqual(["notification"]);
    }
    // Les premiers passent, les derniers sont journalisés : l'ordre d'arrivée fait foi, pas le genre.
    expect(candidats.slice(0, PLAFOND_QUOTIDIEN).every(pousse)).toBe(true);
    expect(candidats.slice(PLAFOND_QUOTIDIEN).some(pousse)).toBe(false);

    // ── LE SOIR : cinq arbitrages, plafond dépassé — JAMAIS rétrogradés ─────────────────
    const arbitrages: Emis[] = [];
    for (const [i, m] of missions.slice(0, 5).entries()) {
      arbitrages.push(await emettre({ kind: "APPROVAL_REQUIRED", missionId: m, titre: `Mission ${i + 1}`, niveauApprobation: "SENSITIVE", raison: "3 étapes à autoriser", planVersion: 1 }));
      avancer(5);
    }
    for (const a of arbitrages) {
      expect(a.niveau).toBe("ARBITRAGE");
      expect(a.supprime).toBe(false);
      expect(a.canaux).toContain("push");
    }

    // ── LES REDITES : le même fait, une heure plus tard, ne se redit pas ────────────────
    avancer(60);
    const redites = [
      await emettre({ kind: "MISSION_PARTIAL", missionId: missions[0], titre: "Mission 1", raison: "une étape reste ouverte", bilan: { faites: 4, total: 6, echouees: 0 }, planVersion: 1 }),
      await emettre({ kind: "WATCH_ALERT", missionId: missions[3], titre: "Mission 4", raison: "échéance dans 3 jours", stepKey: "alerte-3", planVersion: 1 }),
      // Un arbitrage ne se redemande pas : la décision attend.
      await emettre({ kind: "APPROVAL_REQUIRED", missionId: missions[0], titre: "Mission 1", niveauApprobation: "SENSITIVE", raison: "3 étapes à autoriser", planVersion: 1 }),
    ];
    for (const r of redites) {
      expect(r.supprime).toBe(true);
      expect(r.canaux).toEqual([]);
    }
    // Un fait NOUVEAU sur la même mission (autre clé) n'est pas une redite — mais le plafond
    // du jour est atteint : il rejoint le journal, sans vibrer.
    const nouveau = await emettre({ kind: "WATCH_ALERT", missionId: missions[0], titre: "Mission 1", raison: "statut passé à REFUSÉ", stepKey: "alerte-neuve", planVersion: 1 });
    expect(nouveau.supprime).toBe(false);
    expect(nouveau.niveau).toBe("JOURNAL");

    // ── LE LENDEMAIN : le compteur rouvre, la cadence par clé aussi ────────────────────
    avancer(24 * 60);
    const lendemain = await emettre({ kind: "MISSION_PARTIAL", missionId: missions[0], titre: "Mission 1", raison: "une étape reste ouverte", bilan: { faites: 5, total: 6, echouees: 0 }, planVersion: 1 });
    expect(lendemain.supprime).toBe(false);
    expect(lendemain.niveau).toBe("INFO");
    expect(lendemain.canaux).toContain("push");

    // ── LE JOURNAL DIT TOUT, y compris ce qui n'a pas vibré ────────────────────────────
    const journal = await prisma.missionEvent.count({ where: { mission: { ownerId: pdgId }, kind: "NOTIFIED" } });
    expect(journal).toBe(3 * N_MISSIONS + 5 + 1 + 1);
  }, 120_000);
});
