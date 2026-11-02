import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import { reveillerAttentesTemporelles } from "@/lib/missions/events/router";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { conduireTravail } from "@/lib/missions/travaux/conduite";
import { balayerTravaux } from "@/lib/missions/travaux/balayage";
import { lireCarnet } from "@/lib/missions/travaux/carnet";
import {
  annulerTravail, approuverTravail, lireTravail, listerTravaux, pauserTravail, proposerTravail, reglerPlafondTravail, reprendreMonTravail,
} from "@/lib/missions/travaux/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TRAVAUX (J2) — le critère de fin de la Direction, éprouvé sur la vraie base et le vrai moteur :
 *
 *   « un travail de deux heures traverse trois redémarrages forcés sans refaire une étape ni
 *     dupliquer une écriture » ;
 *
 * et ce qui l'entoure : droits retirés en cours de route (l'écriture suivante est refusée), plafond
 * atteint (BUDGET_HOLD, puis reprise), attente réveillée par un fait métier (`recordEvent`), et le
 * cloisonnement (un collaborateur ne voit ni n'annule que SES travaux).
 *
 * LE REDÉMARRAGE FORCÉ, tel qu'il est simulé : une étape SE BLOQUE (sa promesse ne se résout jamais)
 * et l'on abandonne le passage en cours — exactement l'état qu'un processus tué laisse en base : une
 * étape « en cours », un bail tenu, aucun résultat écrit. Le passage suivant arrive avec l'horloge
 * avancée au-delà du bail des étapes (10 min) : le moteur reprend l'orpheline, et RIEN d'autre.
 *
 * La persona est un DOUBLE : elle compte chaque appel (lectures, raisonnements, gestes) — c'est sur
 * ces comptes que portent les assertions. Les droits, eux, sont lus en BASE (compte actif, réglage de
 * la console `AssistantIaAcces`), comme la vraie persona le fait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__trv__${Date.now()}`;
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);

class Horloge implements Clock {
  t = Date.now();
  now() { return new Date(this.t); }
  avancer(min: number) { this.t += min * 60_000; }
}

const JAMAIS = () => new Promise<never>(() => undefined);

/** Le double de persona : compte tout, lit les droits en base. */
function personaDeTest(o: {
  coutParAppel?: number;
  plafondTravailUsd?: number;
  demandes?: number;
  /** Rend VRAI pour bloquer CET appel (le « processus » meurt pendant l'étape). */
  bloquerRaisonnement?: (etape: string, n: number) => boolean;
} = {}) {
  const lectures: string[] = [];
  const raisonnements: string[] = [];
  const gestes: { geste: string; entree: Record<string, unknown> }[] = [];
  const persona: PersonaTravaux = {
    persona: "ASSISTANT_IA",
    nom: "Assistant IA",
    refusTravail: async (id) => ((await prisma.user.findUnique({ where: { id }, select: { isActive: true } }))?.isActive ? null : "Le compte n'est plus actif."),
    catalogue: async () => ({
      lectures: [{ nom: "lister_demandes", libelle: "Demandes listées" }],
      gestes: [{ nom: "relancer", libelle: "Relance envoyée", famille: "ECRITURES", libelleFamille: "Écritures métier" }],
    }),
    lire: async (_p, outil) => {
      lectures.push(outil);
      const n = o.demandes ?? 50;
      return { ok: true, sortie: JSON.stringify({ demandes: Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, montant: 1000 * (i + 1) })) }) };
    },
    refusGeste: async (id, geste) => {
      const r = await prisma.assistantIaAcces.findUnique({ where: { userId: id }, select: { fermees: true } });
      return r?.fermees.includes("ECRITURES") ? `« ${geste} » : la famille « Écritures métier » est fermée pour vous dans la console.` : null;
    },
    ecrire: async (_p, geste, entree) => {
      gestes.push({ geste, entree });
      return { ok: true, resultat: { envoye: true }, message: "Relance envoyée." };
    },
    raisonner: async (_p, d) => {
      const etape = /── ÉTAPE : (.*) ──/.exec(d.texte)?.[1] ?? "?";
      raisonnements.push(etape);
      if (o.bloquerRaisonnement?.(etape, raisonnements.filter((x) => x === etape).length)) return JAMAIS();
      const usage = { entree: 1000, sortie: 200, coutUsd: o.coutParAppel ?? 0.01 };
      if (d.consigne.includes("LIVRABLE")) return { ok: true, texte: `# Rapport\n\n${etape} — fait.`, usage };
      return { ok: true, texte: JSON.stringify({ resultat: `analyse de ${etape}`, trouvailles: [`trouvaille ${etape}`], notes: [] }), usage };
    },
    plafonds: async () => ({ travailUsd: o.plafondTravailUsd ?? 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
    // J8 : sans demande ni livrable au Drive dans ces plans (format Markdown par défaut des anciens plans → Word : le double le rend).
    pieces: { visibles: async () => [], partager: async () => undefined },
    responsable: async () => null,
    deposerLivrable: async (_p, d) => ({ ok: true, document: { nodeId: "doc", nom: `${d.titre}.docx`, format: "docx", lien: "/drive/doc" } }),
  };
  return { persona, lectures, raisonnements, gestes };
}

let alice = "";
let bruno = "";

async function creerEtApprouver(principalId: string, persona: PersonaTravaux, plan: unknown, h: Horloge): Promise<string> {
  const p = await proposerTravail(principalId, persona, plan);
  if (!p.ok) throw new Error(p.fautes.join(" | "));
  const a = await approuverTravail(p.travailId, principalId, persona, h);
  if (!a.ok) throw new Error(a.erreur);
  return p.travailId;
}

const conduire = (id: string, persona: PersonaTravaux, h: Horloge, sondes?: { apresGeste?: (k: string) => Promise<void> }) =>
  conduireTravail(id, { persona, clock: h, interrupteur: PAS_SUSPENDU, vagues: 40, dureeMaxMs: 60_000, ...(sondes ? { sondes } : {}) });

/** Laisse tourner le passage jusqu'à ce qu'il se BLOQUE (le processus « meurt ») — sans jamais l'attendre. */
async function jusquAuBlocage(declencheur: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !declencheur(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(declencheur(), "le redémarrage simulé n'a pas eu lieu").toBe(true);
  await new Promise((r) => setTimeout(r, 150));
}

const statut = async (id: string) => (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))?.status;

suite("travaux — le Mission Runtime pour tous (J2)", () => {
  beforeAll(async () => {
    alice = (await prisma.user.create({ data: { name: `${TAG}Alice`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SALES_USER" } })).id;
    bruno = (await prisma.user.create({ data: { name: `${TAG}Bruno`, email: `${TAG}b@t.dz`, passwordHash: "x", role: "SALES_USER" } })).id;
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.assistantIaAcces.deleteMany({ where: { userId: { in: [alice, bruno] } } }).catch(() => undefined);
    await prisma.businessEvent.deleteMany({ where: { type: { startsWith: "TEST_TRV" } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("refuse un plan faux en disant pourquoi — lecture inconnue, dépendance en avant, pas de livrable", async () => {
    const { persona } = personaDeTest();
    const r = await proposerTravail(alice, persona, {
      titre: "x", objectif: "y",
      etapes: [
        { cle: "a", titre: "A", type: "LECTURE", outil: "inventee" },
        { cle: "b", titre: "B", type: "ANALYSE", consigne: "c", apres: ["z"] },
      ],
    });
    expect(r.ok).toBe(false);
    const fautes = r.ok ? [] : r.fautes.join(" ");
    expect(fautes).toMatch(/inventee/);
    expect(fautes).toMatch(/« z »/);
    expect(fautes).toMatch(/LIVRABLE/);
  });

  it("un travail de deux heures traverse TROIS redémarrages forcés sans refaire une étape ni dupliquer une écriture", { timeout: 60_000 }, async () => {
    const h = new Horloge();
    let bloquerGeste = true;
    const t = personaDeTest({
      demandes: 50,
      // Redémarrage 1 : pendant l'analyse du lot 2 (premier essai). Redémarrage 3 : pendant la rédaction du livrable.
      bloquerRaisonnement: (etape, n) => n === 1 && (/lot-02/.test(etape) || /Rapport final/.test(etape)),
    });
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Analyse des demandes de l'année", objectif: "Analyser toutes les demandes, relancer, puis rendre un rapport.",
      etapes: [
        { cle: "demandes", titre: "Lister les demandes", type: "LECTURE", outil: "lister_demandes" },
        { cle: "lots", titre: "Découper en lots", type: "LOTS", lots: { etape: "demandes", chemin: "demandes", taille: 20 } },
        { cle: "analyse", titre: "Analyser un lot", type: "ANALYSE", consigne: "Repère les montants atypiques.", pourChaque: { etape: "lots" } },
        { cle: "synthese", titre: "Synthèse", type: "ANALYSE", consigne: "Fais la synthèse des lots.", apres: ["analyse"] },
        { cle: "pause", titre: "Attendre 30 minutes", type: "ATTENTE", attente: { minutes: 30 }, apres: ["synthese"] },
        { cle: "relance", titre: "Relancer le service", type: "GESTE", outil: "relancer", entree: { a: "service" }, apres: ["pause"] },
        { cle: "delai", titre: "Attendre une heure", type: "ATTENTE", attente: { minutes: 60 }, apres: ["relance"] },
        { cle: "rapport", titre: "Rapport final", type: "LIVRABLE", consigne: "Rédige le rapport.", apres: ["delai"] },
      ],
    }, h);
    const debut = h.t;

    // ── Passage 1 : lecture, lots, trois analyses — dont une qui « meurt » (redémarrage 1).
    void conduire(id, t.persona, h);
    await jusquAuBlocage(() => t.raisonnements.some((e) => /lot-02/.test(e)));
    expect(await prisma.missionStep.findFirst({ where: { missionId: id, key: "analyse#lot-02" }, select: { status: true } })).toMatchObject({ status: "RUNNING" });

    // ── Redémarrage 1 : quinze minutes plus tard, un autre passage reprend l'orpheline, et elle seule.
    h.avancer(15);
    await conduire(id, t.persona, h);
    expect(await statut(id)).toBe("WAITING_EVENT"); // la minuterie de 30 min dort en base
    h.avancer(31);
    await reveillerAttentesTemporelles(h.now(), [id]);

    // ── Le geste est fait, son reçu clos — puis le processus meurt avant d'écrire l'étape (redémarrage 2).
    const sonde = { apresGeste: async () => { if (bloquerGeste) { bloquerGeste = false; await JAMAIS(); } } };
    void conduire(id, t.persona, h, sonde);
    await jusquAuBlocage(() => t.gestes.length === 1);
    h.avancer(15);
    await conduire(id, t.persona, h, sonde);
    expect(t.gestes).toHaveLength(1); // LE GESTE N'EST PAS REFAIT : son reçu a rendu le résultat
    expect(await statut(id)).toBe("WAITING_EVENT");

    // ── L'heure passe ; le livrable s'écrit — et le processus meurt pendant sa rédaction (redémarrage 3).
    h.avancer(61);
    await reveillerAttentesTemporelles(h.now(), [id]);
    void conduire(id, t.persona, h);
    await jusquAuBlocage(() => t.raisonnements.includes("Rapport final"));
    h.avancer(15);
    await conduire(id, t.persona, h);

    expect(await statut(id)).toBe("COMPLETED");
    expect(h.t - debut).toBeGreaterThanOrEqual(2 * 3600_000);
    // AUCUNE ÉTAPE TERMINÉE N'A ÉTÉ REFAITE : une lecture, une analyse par lot (deux pour celle qui est
    // morte en route, jamais terminée la première fois), une synthèse, un geste, deux rédactions du livrable.
    expect(t.lectures).toEqual(["lister_demandes"]);
    const compte = (re: RegExp) => t.raisonnements.filter((e) => re.test(e)).length;
    expect(compte(/lot-01/)).toBe(1);
    expect(compte(/lot-02/)).toBe(2);
    expect(compte(/lot-03/)).toBe(1);
    expect(compte(/^Synthèse$/)).toBe(1);
    expect(compte(/Rapport final/)).toBe(2);
    expect(t.gestes).toHaveLength(1);
    expect(await prisma.travailEcriture.count({ where: { missionId: id, NOT: { geste: { startsWith: "livrable:" } } } })).toBe(1);
    // J8 : le livrable est déposé au Drive sous son propre reçu — une fois, malgré sa rédaction recommencée.
    expect(await prisma.travailEcriture.count({ where: { missionId: id, geste: { startsWith: "livrable:" } } })).toBe(1);
    const reprises = await prisma.missionEvent.count({ where: { missionId: id, kind: "STEP_RECLAIMED" } });
    expect(reprises).toBe(3);
    // Le carnet porte les trouvailles des trois lots et le livrable — une seule fois chacun.
    const carnet = lireCarnet((await prisma.mission.findUnique({ where: { id }, select: { carnet: true } }))?.carnet);
    expect(carnet.trouvailles.filter((x) => x.etape.startsWith("analyse#"))).toHaveLength(3);
    expect(carnet.livrables).toHaveLength(1);
    expect(carnet.livrables[0]!.contenu).toMatch(/# Rapport/);
    // Fin de travail : la personne est notifiée, une fois.
    expect(await prisma.notification.count({ where: { userId: alice, link: `/assistant?travail=${id}` } })).toBe(1);
  });

  it("des droits retirés en cours de route : l'écriture suivante est REFUSÉE, la précédente reste faite", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Deux relances", objectif: "Relancer deux fois.",
      etapes: [
        { cle: "r1", titre: "Première relance", type: "GESTE", outil: "relancer", entree: { n: 1 } },
        { cle: "r2", titre: "Seconde relance", type: "GESTE", outil: "relancer", entree: { n: 2 }, apres: ["r1"] },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "Dis ce qui a été fait.", apres: ["r2"] },
      ],
    }, h);
    // Entre les deux gestes, la Direction ferme la famille « Écritures » pour Alice dans la console.
    await conduire(id, t.persona, h, {
      apresGeste: async () => {
        await prisma.assistantIaAcces.upsert({ where: { userId: alice }, update: { fermees: ["ECRITURES"] }, create: { userId: alice, fermees: ["ECRITURES"] } });
      },
    });
    expect(t.gestes.map((g) => g.entree.n)).toEqual([1]);
    const r2 = await prisma.missionStep.findFirst({ where: { missionId: id, key: "r2" }, select: { status: true, errorKind: true, error: true } });
    expect(r2).toMatchObject({ status: "FAILED", errorKind: "MISSING_PERMISSION" });
    expect(r2?.error).toMatch(/fermée/);
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "GESTE_REFUSE" } })).toBe(1);
    expect(["BLOCKED", "PARTIAL", "FAILED"]).toContain(await statut(id));
    await prisma.assistantIaAcces.deleteMany({ where: { userId: alice } });
  });

  it("un geste hors du plan approuvé est refusé, même ouvert dans la console", async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Relance", objectif: "Relancer.",
      etapes: [
        { cle: "r", titre: "Relance", type: "GESTE", outil: "relancer" },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["r"] },
      ],
    }, h);
    await prisma.mission.update({ where: { id }, data: { gestesAutorises: [] } });
    await conduire(id, t.persona, h);
    expect(t.gestes).toHaveLength(0);
    expect(await prisma.missionStep.findFirst({ where: { missionId: id, key: "r" }, select: { errorKind: true } })).toMatchObject({ errorKind: "MISSING_PERMISSION" });
  });

  it("le plafond atteint : le travail DORT (BUDGET_HOLD), refuse de reprendre, puis repart seul quand le plafond est relevé", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest({ coutParAppel: 0.6, plafondTravailUsd: 1 });
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Trois analyses", objectif: "Analyser trois fois.",
      etapes: [
        { cle: "a1", titre: "Analyse 1", type: "ANALYSE", consigne: "x" },
        { cle: "a2", titre: "Analyse 2", type: "ANALYSE", consigne: "x", apres: ["a1"] },
        { cle: "a3", titre: "Analyse 3", type: "ANALYSE", consigne: "x", apres: ["a2"] },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["a3"] },
      ],
    }, h);
    const b = await conduire(id, t.persona, h);
    expect(b.arret).toBe("BUDGET");
    const m = await prisma.mission.findUnique({ where: { id }, select: { status: true, pausedReason: true, costUsd: true } });
    expect(m?.status).toBe("PAUSED");
    expect(m?.pausedReason).toMatch(/^BUDGET_HOLD/);
    expect(t.raisonnements).toEqual(["Analyse 1", "Analyse 2"]);
    expect((await listerTravaux(alice)).find((x) => x.id === id)?.etat).toBe("BUDGET_HOLD");
    expect(await prisma.notification.count({ where: { userId: alice, link: `/assistant?travail=${id}`, title: { startsWith: "Travail en sommeil" } } })).toBe(1);

    // Reprendre pour se rendormir n'apprendrait rien : refusé, motif dit.
    const refus = await reprendreMonTravail(id, alice, t.persona);
    expect(refus.ok).toBe(false);
    // Un battement de plus ne réveille rien, et ne renotifie pas.
    await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(await statut(id)).toBe("PAUSED");

    // Le plafond relevé : le battement suivant le réveille, il reprend AU MÊME POINT.
    expect((await reglerPlafondTravail(id, alice, 10)).ok).toBe(true);
    await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(await statut(id)).toBe("COMPLETED");
    expect(t.raisonnements).toEqual(["Analyse 1", "Analyse 2", "Analyse 3", "Compte rendu"]);
  });

  it("une attente d'événement métier, réveillée par recordEvent — le prédicat sur la charge utile compte, la relance ne part pas", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const ref = `BC:${TAG}`;
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Suivre la signature du BC", objectif: "Attendre la signature du BC, relancer si rien sous 21 jours.",
      etapes: [
        { cle: "signature", titre: "Attendre la signature du BC", type: "ATTENTE", attente: { evenement: "TEST_TRV_BC", entite: ref, champs: { statut: "SIGNE" }, jours: 21 } },
        { cle: "relance", titre: "Relancer le signataire", type: "GESTE", outil: "relancer", si: { etape: "signature", issue: "TIMEOUT" } },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["relance"] },
      ],
    }, h);
    await conduire(id, t.persona, h);
    expect(await statut(id)).toBe("WAITING_EVENT");
    const vue = (await listerTravaux(alice)).find((x) => x.id === id);
    expect(vue?.attente).toMatch(/attend « la signature du BC » depuis/);

    // Un BC seulement transmis ne règle pas l'attente.
    await recordEvent({ type: "TEST_TRV_BC", sourceDomain: "test", relatedRefs: [ref], payload: { statut: "TRANSMIS" } });
    expect(await prisma.missionStep.findFirst({ where: { missionId: id, key: "signature" }, select: { status: true } })).toMatchObject({ status: "WAITING" });
    // Signé : l'attente se règle, le travail reprend, la relance (« si rien sous 21 jours ») est écartée.
    await recordEvent({ type: "TEST_TRV_BC", sourceDomain: "test", relatedRefs: [ref], payload: { statut: "SIGNE" } });
    expect(await prisma.missionStep.findFirst({ where: { missionId: id, key: "signature" }, select: { status: true } })).toMatchObject({ status: "DONE" });
    await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(await statut(id)).toBe("COMPLETED");
    expect(t.gestes).toHaveLength(0);
    expect(await prisma.missionStep.findFirst({ where: { missionId: id, key: "relance" }, select: { status: true } })).toMatchObject({ status: "SKIPPED" });
  });

  it("…et sans réponse sous 21 jours, la minuterie règle l'attente et la relance part", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await creerEtApprouver(alice, t.persona, {
      titre: "Relance à 21 jours", objectif: "Relancer si pas de réponse.",
      etapes: [
        { cle: "reponse", titre: "Attendre la réponse", type: "ATTENTE", attente: { evenement: "TEST_TRV_REPONSE", entite: `X:${TAG}`, jours: 21 } },
        { cle: "relance", titre: "Relancer", type: "GESTE", outil: "relancer", si: { etape: "reponse", issue: "TIMEOUT" } },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["relance"] },
      ],
    }, h);
    await conduire(id, t.persona, h);
    h.avancer(20 * 1440);
    await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(await statut(id)).toBe("WAITING_EVENT");
    h.avancer(2 * 1440);
    await balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(t.gestes).toHaveLength(1);
    expect(await statut(id)).toBe("COMPLETED");
  });

  it("chacun ne voit, ne suspend et n'annule que SES travaux — un compte désactivé met son travail en pause", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const plan = {
      titre: "Le travail de Bruno", objectif: "x",
      etapes: [
        { cle: "a", titre: "Lire", type: "LECTURE", outil: "lister_demandes" },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["a"] },
      ],
    };
    const p = await proposerTravail(bruno, t.persona, plan);
    if (!p.ok) throw new Error(p.fautes.join());
    // Alice ne peut ni l'approuver, ni le lire, ni le suspendre, ni l'annuler ; elle ne le voit pas dans sa liste.
    expect((await approuverTravail(p.travailId, alice, t.persona, h)).ok).toBe(false);
    expect(await lireTravail(p.travailId, alice)).toBeNull();
    expect((await pauserTravail(p.travailId, alice)).ok).toBe(false);
    expect((await annulerTravail(p.travailId, alice)).ok).toBe(false);
    expect((await listerTravaux(alice)).some((x) => x.id === p.travailId)).toBe(false);
    expect((await listerTravaux(bruno)).find((x) => x.id === p.travailId)?.etat).toBe("A_APPROUVER");
    // Rien ne tourne avant l'approbation.
    expect((await conduire(p.travailId, t.persona, h)).arret).toBe("NON_APPROUVE");
    expect(t.lectures).toHaveLength(0);

    expect((await approuverTravail(p.travailId, bruno, t.persona, h)).ok).toBe(true);
    // Le compte de Bruno est désactivé : son travail se met en pause au lieu de tourner sous des droits perdus.
    await prisma.user.update({ where: { id: bruno }, data: { isActive: false } });
    const b = await conduire(p.travailId, t.persona, h);
    expect(b.arret).toBe("DROITS");
    expect(t.lectures).toHaveLength(0);
    expect((await listerTravaux(bruno)).find((x) => x.id === p.travailId)?.etat).toBe("EN_PAUSE");
    await prisma.user.update({ where: { id: bruno }, data: { isActive: true } });
    expect((await annulerTravail(p.travailId, bruno)).ok).toBe(true);
    expect(await statut(p.travailId)).toBe("CANCELLED");
  });
});
