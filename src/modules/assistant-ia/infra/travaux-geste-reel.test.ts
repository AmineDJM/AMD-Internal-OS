// EN PREMIER, comme le worker (`scripts/worker.ts`) : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { conduireTravail } from "@/lib/missions/travaux/conduite";
import { approuverTravail, proposerTravail } from "@/lib/missions/travaux/service";
import { createCalendarEvent } from "@/lib/actions/calendar-actions";
import { PERSONA_ASSISTANT_IA } from "./travaux";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN VRAI GESTE MÉTIER, DEPUIS LE WORKER (J8, constat remonté par J12) — AUCUN `vi.mock` ici : ni `requireUser`,
 * ni `revalidatePath`. Le geste approuvé d'un travail (« prendre un rendez-vous ») passe par la persona réelle de
 * l'Assistant IA → `executerOperationIA` → l'action de l'ÉCRAN `createCalendarEvent`, hors de toute requête.
 *
 *   • sans le contexte d'exécution (`contexte-geste.ts`), l'action de l'écran ne peut pas tourner hors requête ;
 *   • avec lui : le rendez-vous est créé UNE fois, l'étape est faite, la double signature est au journal ;
 *   • rejoué (processus tué après le geste, avant l'écriture de l'étape) : le reçu rend le résultat, aucun second
 *     rendez-vous.
 * Seul le MODÈLE est remplacé (le livrable) : aucune clé, aucun appel réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__gst__${Date.now()}`;
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
class Horloge implements Clock {
  t = Date.now();
  now() { return new Date(this.t); }
  avancer(min: number) { this.t += min * 60_000; }
}
const JAMAIS = () => new Promise<never>(() => undefined);

let moi = "";
const persona: PersonaTravaux = {
  ...PERSONA_ASSISTANT_IA,
  raisonner: async () => ({ ok: true, texte: "# Compte rendu\n\nRendez-vous pris.", usage: { entree: 1, sortie: 1, coutUsd: 0 } }),
  plafonds: async () => ({ travailUsd: 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
};
const rdv = () => prisma.calendarEvent.count({ where: { title: { startsWith: TAG } } });

suite("un vrai geste métier exécuté par un travail, hors requête (J8)", () => {
  beforeAll(async () => {
    moi = (await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
  });
  afterAll(async () => {
    await prisma.calendarEvent.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("le défaut d'origine : l'action de l'écran, appelée nue hors requête, ne passe pas", async () => {
    const fd = new FormData();
    fd.set("title", `${TAG} nu`);
    fd.set("start", "2026-11-20T10:00");
    await expect(createCalendarEvent(undefined, fd)).rejects.toThrow();
    expect(await rdv()).toBe(0);
  });

  it("par le travail : le rendez-vous est créé UNE fois, et un rejeu après un processus tué ne le double pas", { timeout: 60_000 }, async () => {
    const h = new Horloge();
    const p = await proposerTravail(moi, persona, {
      titre: "Préparer le comité", objectif: "Prendre le rendez-vous du comité, puis rendre compte.",
      etapes: [
        { cle: "rdv", titre: "Prendre le rendez-vous", type: "GESTE", outil: "preparer_rendez_vous", entree: { titre: `${TAG} Comité`, debut: "2026-11-20 10:00", fin: "2026-11-20 11:00" } },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", format: "md", apres: ["rdv"] },
      ],
    });
    if (!p.ok) throw new Error(p.fautes.join(" | "));
    expect((await approuverTravail(p.travailId, moi, persona, h)).ok).toBe(true);

    // Le processus « meurt » juste après le geste (reçu clos, étape pas encore écrite).
    let tuer = true;
    void conduireTravail(p.travailId, { persona, clock: h, interrupteur: PAS_SUSPENDU, vagues: 20, dureeMaxMs: 30_000, sondes: { apresGeste: async () => { if (tuer) { tuer = false; await JAMAIS(); } } } });
    for (let i = 0; i < 200 && tuer; i++) await new Promise((r) => setTimeout(r, 50));
    expect(tuer, "le geste n'a pas eu lieu").toBe(false);
    const fait = await prisma.travailEcriture.findFirst({ where: { missionId: p.travailId, stepKey: "rdv" }, select: { statut: true, resultat: true } });
    expect(fait, JSON.stringify(fait)).toMatchObject({ statut: "FAIT" });
    expect(await rdv()).toBe(1);
    const recu = await prisma.travailEcriture.findFirstOrThrow({ where: { missionId: p.travailId, stepKey: "rdv" } });
    expect(recu.statut).toBe("FAIT");

    // Le rejeu, quinze minutes plus tard : l'étape orpheline est reprise, le reçu rend le résultat — rien n'est refait.
    h.avancer(15);
    await conduireTravail(p.travailId, { persona, clock: h, interrupteur: PAS_SUSPENDU, vagues: 20, dureeMaxMs: 30_000 });
    expect((await prisma.mission.findUnique({ where: { id: p.travailId }, select: { status: true } }))?.status).toBe("COMPLETED");
    expect(await rdv()).toBe(1);
    expect(await prisma.missionStep.findFirst({ where: { missionId: p.travailId, key: "rdv" }, select: { status: true } })).toMatchObject({ status: "DONE" });
    const trace = await prisma.missionEvent.findFirst({ where: { missionId: p.travailId, kind: "ACTION_TRACED" }, select: { detail: true } });
    expect(trace?.detail).toMatchObject({ ok: true, initiatedBy: moi });
    expect(await prisma.calendarEvent.findFirst({ where: { title: `${TAG} Comité` }, select: { createdById: true } })).toMatchObject({ createdById: moi });
  });
});
