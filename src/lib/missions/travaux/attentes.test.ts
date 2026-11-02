import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import { CATALOGUE } from "@/lib/events/catalogue";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { balayerTravaux, travauxAFaireAvancer } from "@/lib/missions/travaux/balayage";
import { reveillerTravauxSignales } from "@/lib/missions/travaux/reveil";
import { approuverTravail, listerTravaux, proposerTravail, reglerPrioriteTravail } from "@/lib/missions/travaux/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ATTENTES AVANCÉES (J8, décision 0023) — sur la vraie base et le vrai moteur :
 *
 *   • WAIT_EVENT sur PRÉDICAT de charge utile pour CHACUN des types du catalogue des faits (`events/catalogue.ts`) :
 *     un fait du bon type mais au mauvais prédicat ne règle rien ; le bon, oui ;
 *   • relance et escalade (au responsable) à leurs dates, une fois ; l'échéance règle l'attente en TIMEOUT ;
 *   • la REPRISE APRÈS L'ÉVÉNEMENT, MESURÉE : la boucle courte des réveils, à sa période de production (10 s),
 *     reprend chaque travail en moins de 90 s au p95 (critère de la Direction) ;
 *   • plusieurs travaux par personne : priorités, et chacun son tour au battement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__att__${Date.now()}`;
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
class Horloge implements Clock {
  t = Date.now();
  now() { return new Date(this.t); }
  avancer(min: number) { this.t += min * 60_000; }
}

let alice = "";
let bruno = "";
let carla = "";

function personaDeTest() {
  const gestes: string[] = [];
  const persona: PersonaTravaux = {
    persona: "ASSISTANT_IA", nom: "Assistant IA",
    refusTravail: async () => null,
    catalogue: async () => ({ lectures: [], gestes: [{ nom: "relancer", libelle: "Relance envoyée", famille: "ECRITURES", libelleFamille: "Écritures métier" }] }),
    lire: async () => ({ ok: true, sortie: "{}" }),
    refusGeste: async () => null,
    ecrire: async (_p, g, e) => { gestes.push(`${g}:${String(e.n ?? "")}`); return { ok: true, resultat: {} }; },
    raisonner: async () => ({ ok: true, texte: "# CR", usage: { entree: 1, sortie: 1, coutUsd: 0 } }),
    plafonds: async () => ({ travailUsd: 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
    pieces: { visibles: async () => [], partager: async () => undefined },
    responsable: async (u) => (u === alice ? carla : null),
    deposerLivrable: async (_p, d) => ({ ok: true, document: { nodeId: "doc", nom: `${d.titre}.docx`, format: "docx", lien: "/drive/doc" } }),
  };
  return { persona, gestes };
}

/** Un travail qui attend UN fait (type, prédicat), puis fait un geste et rend compte. */
const planAttente = (type: string, marqueur: string, extra: Record<string, unknown> = {}) => ({
  titre: `Attendre ${type}`, objectif: `Attendre le fait ${type}, puis agir.`,
  etapes: [
    { cle: "attente", titre: `Attendre ${type}`, type: "ATTENTE", attente: { evenement: type, champs: { marqueur }, jours: 30, ...extra } },
    { cle: "geste", titre: "Agir", type: "GESTE", outil: "relancer", entree: { n: marqueur }, apres: ["attente"] },
    { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", format: "md", apres: ["geste"] },
  ],
});

async function lancer(t: ReturnType<typeof personaDeTest>, h: Horloge, plan: unknown, qui = alice): Promise<string> {
  const r = await proposerTravail(qui, t.persona, plan);
  if (!r.ok) throw new Error(r.fautes.join(" | "));
  const a = await approuverTravail(r.travailId, qui, t.persona, h);
  if (!a.ok) throw new Error(a.erreur);
  await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [r.travailId] });
  return r.travailId;
}
const etapeAttente = (id: string) => prisma.missionStep.findFirstOrThrow({ where: { missionId: id, key: "attente" }, select: { status: true, result: true } });
const statut = async (id: string) => (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))?.status;

suite("travaux — attentes avancées (J8)", () => {
  beforeAll(async () => {
    const creer = (n: string) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n.toLowerCase()}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    [alice, bruno, carla] = (await Promise.all([creer("Alice"), creer("Bruno"), creer("Carla")])).map((u) => u.id);
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.businessEvent.deleteMany({ where: { payload: { path: ["marqueur"], string_starts_with: TAG } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it(`WAIT_EVENT sur prédicat, pour CHACUN des ${CATALOGUE.length} types du catalogue des faits`, { timeout: 180_000 }, async () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(34);
    const h = new Horloge();
    const t = personaDeTest();
    const travaux: { type: string; id: string; marqueur: string }[] = [];
    for (const [i, f] of CATALOGUE.entries()) {
      const marqueur = `${TAG}-${i}`;
      travaux.push({ type: f.type, marqueur, id: await lancer(t, h, planAttente(f.type, marqueur)) });
    }
    for (const w of travaux) {
      expect(await statut(w.id), w.type).toBe("WAITING_EVENT");
      // Le bon type, le mauvais prédicat : rien ne bouge.
      await recordEvent({ type: w.type, sourceDomain: "test", payload: { marqueur: `${w.marqueur}-autre` } });
      expect((await etapeAttente(w.id)).status, w.type).toBe("WAITING");
      // Le bon : l'attente se règle (issue EVENT), le travail est signalé au réveil rapide.
      await recordEvent({ type: w.type, sourceDomain: "test", payload: { marqueur: w.marqueur } });
      const e = await etapeAttente(w.id);
      expect(e.status, w.type).toBe("DONE");
      expect((e.result as { reveillePar?: string }).reveillePar, w.type).toBe(w.type);
    }
    const signales = await prisma.mission.count({ where: { id: { in: travaux.map((w) => w.id) }, reveilDemandeLe: { not: null } } });
    expect(signales).toBe(travaux.length);
    for (let i = 0; i < Math.ceil(travaux.length / 6) + 1; i++) {
      await reveillerTravauxSignales({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: travaux.map((w) => w.id) });
    }
    for (const w of travaux) expect(await statut(w.id), w.type).toBe("COMPLETED");
    // UN geste par travail, chacun le sien (aucun fait n'a réveillé le voisin).
    expect(t.gestes.sort()).toEqual(travaux.map((w) => `relancer:${w.marqueur}`).sort());
  });

  it("relance à la personne, escalade à son responsable — une fois chacune ; l'échéance règle en TIMEOUT", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await lancer(t, h, {
      ...planAttente("PAYMENT_RECEIVED", `${TAG}-esc`, { jours: 5, relance: { jours: 2 }, escalade: { jours: 4, a: "RESPONSABLE" } }),
    });
    const balayer = () => balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    const n = (u: string, debut: string) => prisma.notification.count({ where: { userId: u, title: { startsWith: debut } } });
    h.avancer(2.1 * 1440);
    await balayer();
    await balayer();
    expect(await n(alice, "Toujours en attente")).toBe(1);
    expect(await n(carla, "Escalade")).toBe(0);
    h.avancer(2 * 1440);
    await balayer();
    await balayer();
    expect(await n(carla, "Escalade")).toBe(1);
    expect(await statut(id)).toBe("WAITING_EVENT");
    h.avancer(1 * 1440);
    await balayer();
    expect((await etapeAttente(id)).result).toMatchObject({ reveillePar: "TEMPS" });
    expect(await statut(id)).toBe("COMPLETED");
  });

  it("la reprise après l'événement, MESURÉE avec la boucle courte à sa période de production : p95 < 90 s", { timeout: 180_000 }, async () => {
    const { BOUCLE_REVEILS_MS } = await import("@/lib/scheduled");
    expect(BOUCLE_REVEILS_MS).toBe(10_000);
    const h = new Horloge();
    const t = personaDeTest();
    const N = 10;
    const travaux: { id: string; marqueur: string }[] = [];
    for (let i = 0; i < N; i++) travaux.push({ marqueur: `${TAG}-lat-${i}`, id: await lancer(t, h, planAttente("INVOICE_RECEIVED", `${TAG}-lat-${i}`)) });
    // LA BOUCLE, telle que le worker l'arme (même période) — bornée à ces travaux.
    let enCours = false;
    const boucle = setInterval(() => {
      if (enCours) return;
      enCours = true;
      void reveillerTravauxSignales({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: travaux.map((w) => w.id) })
        .finally(() => { enCours = false; });
    }, BOUCLE_REVEILS_MS);
    const latences: number[] = [];
    try {
      // Les faits arrivent à des instants quelconques, sur ~35 s : la phase de la boucle est aléatoire.
      await Promise.all(travaux.map(async (w, i) => {
        await new Promise((r) => setTimeout(r, 1_000 + i * 2_500 + Math.floor(Math.random() * 900)));
        const t0 = Date.now();
        await recordEvent({ type: "INVOICE_RECEIVED", sourceDomain: "test", payload: { marqueur: w.marqueur } });
        for (;;) {
          const g = await prisma.missionStep.findFirst({ where: { missionId: w.id, key: "geste" }, select: { status: true } });
          if (g?.status === "DONE") break;
          if (Date.now() - t0 > 120_000) throw new Error(`jamais repris : ${w.id}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        latences.push(Date.now() - t0);
      }));
    } finally {
      clearInterval(boucle);
    }
    const tri = [...latences].sort((a, b) => a - b);
    const p95 = tri[Math.min(tri.length - 1, Math.ceil(tri.length * 0.95) - 1)]!;
    console.info(`[J8] reprise après l'événement (boucle ${BOUCLE_REVEILS_MS / 1000} s, ${N} faits) : médiane ${(tri[Math.floor(tri.length / 2)]! / 1000).toFixed(1)} s, p95 ${(p95 / 1000).toFixed(1)} s, max ${(tri.at(-1)! / 1000).toFixed(1)} s`);
    expect(latences).toHaveLength(N);
    expect(p95).toBeLessThan(90_000);
    // La borne réelle : une période de boucle plus la conduite — bien sous le critère.
    expect(p95).toBeLessThan(BOUCLE_REVEILS_MS + 10_000);
  });

  it("plusieurs travaux par personne : la priorité ordonne les siens, chacun son tour au battement", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const minuterie = (titre: string, priorite?: string) => ({
      titre, objectif: "x", ...(priorite ? { priorite } : {}),
      etapes: [{ cle: "m", titre: "Attendre", type: "ATTENTE", attente: { minutes: 5 } }, { cle: "cr", titre: "CR", type: "LIVRABLE", consigne: "x", format: "md", apres: ["m"] }],
    });
    const a1 = await lancer(t, h, minuterie("A1"));
    const a2 = await lancer(t, h, minuterie("A2", "HAUTE"));
    const a3 = await lancer(t, h, minuterie("A3", "BASSE"));
    const b1 = await lancer(t, h, minuterie("B1"), bruno);
    expect((await listerTravaux(alice)).filter((x) => [a1, a2, a3].includes(x.id)).map((x) => x.priorite)).toEqual(["HAUTE", "NORMALE", "BASSE"]);
    // Les minuteries échues : les quatre travaux ont à faire. Ordre : le premier de chacun (A2 haute, B1), puis A1, A3.
    h.avancer(6);
    await prisma.missionStep.updateMany({ where: { missionId: { in: [a1, a2, a3, b1] }, key: "m" }, data: { status: "DONE", result: { reveillePar: "TEMPS" } } });
    const ordre = (await travauxAFaireAvancer(100, [alice, bruno])).map((x) => x.id).filter((x) => [a1, a2, a3, b1].includes(x));
    expect(ordre.slice(0, 2).sort()).toEqual([a2, b1].sort());
    expect(ordre.slice(2)).toEqual([a1, a3]);
    expect((await reglerPrioriteTravail(a3, alice, "HAUTE")).ok).toBe(true);
    expect((await reglerPrioriteTravail(a3, bruno, "HAUTE")).ok).toBe(false);
    expect((await reglerPrioriteTravail(a3, alice, "URGENTISSIME")).ok).toBe(false);
  });
});
