import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { balayerTravaux } from "@/lib/missions/travaux/balayage";
import { reveillerTravauxSignales } from "@/lib/missions/travaux/reveil";
import { annulerTravail, approuverTravail, lireTravail, proposerTravail } from "@/lib/missions/travaux/service";
import { declinerDemande, deposerDemande, lireDemandeRecue, listerDemandesRecues, repondreDemande } from "@/lib/missions/travaux/delegation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉLÉGATION (J8, décision 0023) — « DEMANDER_A(personne, question, pièces attendues, échéance) », sur la vraie
 * base et le vrai moteur :
 *
 *   • le travail d'Alice dépose UNE demande chez Bruno (notification, lien vers SON assistant) et attend (WAIT_INPUT) ;
 *   • Bruno ne voit que la question, les pièces attendues et les pièces partagées — jamais le carnet ni le plan ;
 *   • il répond (texte + pièces de SON Drive, accordées en lecture à Alice) : l'étape se règle, le travail est
 *     signalé au réveil rapide et reprend ; le livrable lit la réponse ;
 *   • relance (à mi-délai), escalade (à l'échéance, au responsable de Bruno), abandon (issue TIMEOUT → la suite
 *     prévue par le plan) — une fois chacune, même battement rejoué ;
 *   • décliner, annuler le travail (la demande est retirée), cloisonnement (Carla ne répond pas à la place de Bruno).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__dlg__${Date.now()}`;
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
  const raisonnements: { etape: string; texte: string }[] = [];
  const partages: { ids: readonly string[]; userId: string; parId: string }[] = [];
  const persona: PersonaTravaux = {
    persona: "ASSISTANT_IA", nom: "Assistant IA",
    refusTravail: async () => null,
    catalogue: async () => ({ lectures: [], gestes: [{ nom: "relancer", libelle: "Relance envoyée", famille: "ECRITURES", libelleFamille: "Écritures métier" }] }),
    lire: async () => ({ ok: true, sortie: "{}" }),
    refusGeste: async () => null,
    ecrire: async (_p, g) => { gestes.push(g); return { ok: true, resultat: {} }; },
    raisonner: async (_p, d) => {
      raisonnements.push({ etape: /── ÉTAPE : (.*) ──/.exec(d.texte)?.[1] ?? "?", texte: d.texte });
      return { ok: true, texte: "# Compte rendu\n\nfait.", usage: { entree: 10, sortie: 10, coutUsd: 0.001 } };
    },
    plafonds: async () => ({ travailUsd: 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
    pieces: {
      // Alice voit « piece-alice » ; Bruno voit « piece-bruno » : la règle du Drive, jouée par le double.
      visibles: async (u, ids) => ids.filter((id) => (u === alice && id === "piece-alice-0001") || (u === bruno && id === "piece-bruno-0001")).map((nodeId) => ({ nodeId, nom: `${nodeId}.pdf` })),
      partager: async (ids, userId, parId) => { partages.push({ ids, userId, parId }); },
    },
    responsable: async (u) => (u === bruno ? carla : null),
    deposerLivrable: async (_p, d) => ({ ok: true, document: { nodeId: "doc", nom: `${d.titre}.docx`, format: "docx", lien: "/drive/doc" } }),
  };
  return { persona, gestes, raisonnements, partages };
}

const plan = (jours = 4, extra: Record<string, unknown> = {}) => ({
  titre: "Le devis du congrès", objectif: "Obtenir le devis signé de Bruno, puis rendre compte.",
  etapes: [
    { cle: "devis", titre: "Demander le devis à Bruno", type: "DEMANDE",
      demande: { a: `${TAG}bruno@t.dz`, question: "Peux-tu m'envoyer le devis signé de l'agence ?", pieces: ["le devis signé"], partager: ["piece-alice-0001"], jours, ...extra } },
    { cle: "relance", titre: "Relancer l'agence", type: "GESTE", outil: "relancer", si: { etape: "devis", issue: "TIMEOUT" } },
    { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "Dis ce que Bruno a répondu.", apres: ["devis", "relance"] },
  ],
});

async function lancer(t: ReturnType<typeof personaDeTest>, h: Horloge, p: unknown = plan()): Promise<string> {
  const r = await proposerTravail(alice, t.persona, p);
  if (!r.ok) throw new Error(r.fautes.join(" | "));
  const a = await approuverTravail(r.travailId, alice, t.persona, h);
  if (!a.ok) throw new Error(a.erreur);
  await balayer(t, h, r.travailId);
  return r.travailId;
}
const balayer = (t: ReturnType<typeof personaDeTest>, h: Horloge, id: string) =>
  balayerTravaux({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
const statut = async (id: string) => (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))?.status;
const notes = (userId: string, debut: string) => prisma.notification.count({ where: { userId, title: { startsWith: debut } } });

suite("travaux — la délégation (J8)", () => {
  beforeAll(async () => {
    const creer = (n: string) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n.toLowerCase()}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    [alice, bruno, carla] = (await Promise.all([creer("Alice"), creer("Bruno"), creer("Carla")])).map((u) => u.id);
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("refuse une demande à une personne inconnue, à soi-même, ou qui partage une pièce qu'on ne voit pas", async () => {
    const t = personaDeTest();
    const faux = async (a: string, partager: string[] = []) => {
      const r = await proposerTravail(alice, t.persona, { ...plan(), etapes: [{ ...plan().etapes[0], demande: { ...plan().etapes[0]!.demande, a, partager } }, { ...plan().etapes[2], apres: ["devis"] }] });
      return r.ok ? "" : r.fautes.join(" ");
    };
    expect(await faux("Personne Inconnue")).toMatch(/personne de ce nom/);
    expect(await faux(`${TAG}alice@t.dz`)).toMatch(/soi-même/);
    expect(await faux(`${TAG}bruno@t.dz`, ["piece-de-quelqu-un"])).toMatch(/introuvable/);
  });

  it("dépose UNE demande chez Bruno, qui ne voit que la question et les pièces ; sa réponse fait reprendre le travail", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await lancer(t, h);
    expect(await statut(id)).toBe("WAITING_INPUT");
    const d = await prisma.travailDemande.findFirstOrThrow({ where: { missionId: id } });
    expect(d).toMatchObject({ destinataireId: bruno, demandeurId: alice, statut: "OUVERTE" });
    // Notifié une fois, avec le lien vers SON assistant ; la pièce partagée lui est accordée en lecture.
    expect(await prisma.notification.count({ where: { userId: bruno, link: `/assistant?demande=${d.id}` } })).toBe(1);
    expect(t.partages).toEqual([{ ids: ["piece-alice-0001"], userId: bruno, parId: alice }]);
    // Un dépôt rejoué (redémarrage) ne double ni la demande ni l'avis.
    const step = await prisma.missionStep.findFirstOrThrow({ where: { missionId: id, key: "devis" }, select: { input: true } });
    await deposerDemande({ travailId: id, stepKey: "devis", principalId: alice, demande: (step.input as { demande: never }).demande, pieces: t.persona.pieces, maintenant: h.now() });
    expect(await prisma.travailDemande.count({ where: { missionId: id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: bruno, link: `/assistant?demande=${d.id}` } })).toBe(1);

    // CE QUE BRUNO VOIT : rien du travail d'Alice (ni titre, ni carnet, ni plan).
    const vue = (await listerDemandesRecues(bruno)).find((x) => x.id === d.id)!;
    expect(Object.keys(vue).sort()).toEqual(["creeLe", "de", "echeance", "enRetard", "id", "piecesAttendues", "piecesFournies", "piecesPartagees", "question", "reponse", "statut"]);
    expect(vue).toMatchObject({ question: "Peux-tu m'envoyer le devis signé de l'agence ?", piecesAttendues: ["le devis signé"], piecesPartagees: [{ nodeId: "piece-alice-0001", nom: "piece-alice-0001.pdf" }] });
    expect(JSON.stringify(vue)).not.toMatch(/congrès|Compte rendu|objectif/i);
    // Carla ne la voit pas, et ne peut pas y répondre à la place de Bruno.
    expect(await lireDemandeRecue(d.id, carla)).toBeNull();
    expect((await repondreDemande(d.id, carla, { texte: "moi" }, t.persona.pieces)).ok).toBe(false);
    // Une pièce que Bruno ne voit pas est refusée.
    expect((await repondreDemande(d.id, bruno, { texte: "ci-joint", pieces: ["piece-alice-0001"] }, t.persona.pieces)).ok).toBe(false);

    // LA RÉPONSE : l'étape se règle, le travail est signalé au réveil rapide, la pièce va à Alice en lecture.
    const r = await repondreDemande(d.id, bruno, { texte: "Le devis signé est joint : 1 250 000 DZD.", pieces: ["piece-bruno-0001"] }, t.persona.pieces);
    expect(r.ok).toBe(true);
    expect(t.partages.at(-1)).toEqual({ ids: ["piece-bruno-0001"], userId: alice, parId: bruno });
    expect((await prisma.mission.findUnique({ where: { id }, select: { reveilDemandeLe: true } }))?.reveilDemandeLe).not.toBeNull();
    expect((await repondreDemande(d.id, bruno, { texte: "encore" }, t.persona.pieces)).ok).toBe(false);
    const rev = await reveillerTravauxSignales({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(rev.pris).toBe(1);
    expect(await statut(id)).toBe("COMPLETED");
    expect(t.gestes).toHaveLength(0); // la relance « si TIMEOUT » est écartée
    expect(t.raisonnements.at(-1)?.texte).toMatch(/1 250 000 DZD/);
    expect(await notes(alice, `${TAG}Bruno a répondu`)).toBe(1);
    const detail = await lireTravail(id, alice);
    expect(detail?.demandes).toMatchObject([{ a: `${TAG}Bruno`, statut: "REPONDUE", piecesFournies: [{ nodeId: "piece-bruno-0001" }] }]);
  });

  it("relance à mi-délai, escalade au responsable à l'échéance, abandon ensuite : la suite « si TIMEOUT » part", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await lancer(t, h, plan(4));
    const d = await prisma.travailDemande.findFirstOrThrow({ where: { missionId: id } });
    h.avancer(1 * 1440);
    await balayer(t, h, id);
    expect(await notes(bruno, "Rappel")).toBe(0);
    h.avancer(1.1 * 1440); // mi-délai passé : un rappel à Bruno, un seul même si le battement repasse
    await balayer(t, h, id);
    await balayer(t, h, id);
    expect(await notes(bruno, "Rappel")).toBe(1);
    expect(await notes(carla, "Escalade")).toBe(0);
    h.avancer(2 * 1440); // l'échéance : Carla (N+1 de Bruno) est prévenue, Alice le sait ; la demande reste ouverte
    await balayer(t, h, id);
    await balayer(t, h, id);
    expect(await notes(carla, "Escalade")).toBe(1);
    expect(await notes(alice, "Pas encore de réponse")).toBe(1);
    expect((await prisma.travailDemande.findUniqueOrThrow({ where: { id: d.id } })).statut).toBe("OUVERTE");
    expect(await statut(id)).toBe("WAITING_INPUT");
    h.avancer(4.1 * 1440); // l'abandon (un second délai) : la demande expire, l'étape se règle en TIMEOUT
    await balayer(t, h, id);
    expect((await prisma.travailDemande.findUniqueOrThrow({ where: { id: d.id } })).statut).toBe("EXPIREE");
    expect(t.gestes).toEqual(["relancer"]);
    expect(await statut(id)).toBe("COMPLETED");
    expect((await repondreDemande(d.id, bruno, { texte: "trop tard" }, t.persona.pieces)).ok).toBe(false);
  });

  it("Bruno décline avec un motif : le travail reprend sans la réponse, Alice lit le motif", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await lancer(t, h);
    const d = await prisma.travailDemande.findFirstOrThrow({ where: { missionId: id } });
    expect((await declinerDemande(d.id, bruno, "")).ok).toBe(false);
    expect((await declinerDemande(d.id, bruno, "Je ne gère plus ce fournisseur, voir avec Carla.")).ok).toBe(true);
    await reveillerTravauxSignales({ personas: { ASSISTANT_IA: t.persona }, clock: h, interrupteur: PAS_SUSPENDU, seulement: [id] });
    expect(await statut(id)).toBe("COMPLETED");
    expect(t.raisonnements.at(-1)?.texte).toMatch(/voir avec Carla/);
    expect(await notes(alice, `${TAG}Bruno a décliné`)).toBe(1);
  });

  it("le travail annulé retire sa demande : Bruno le sait, et ne peut plus y répondre", { timeout: 30_000 }, async () => {
    const h = new Horloge();
    const t = personaDeTest();
    const id = await lancer(t, h);
    const d = await prisma.travailDemande.findFirstOrThrow({ where: { missionId: id } });
    expect((await annulerTravail(id, alice)).ok).toBe(true);
    expect((await prisma.travailDemande.findUniqueOrThrow({ where: { id: d.id } })).statut).toBe("ANNULEE");
    expect(await notes(bruno, "Demande retirée")).toBe(1);
    expect((await repondreDemande(d.id, bruno, { texte: "x" }, t.persona.pieces)).ok).toBe(false);
  });
});
