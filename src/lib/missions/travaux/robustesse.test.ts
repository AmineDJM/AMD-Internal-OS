import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { approuverTravail, proposerTravail } from "@/lib/missions/travaux/service";
import { conduireTravail } from "@/lib/missions/travaux/conduite";
import { repondreDemande } from "@/lib/missions/travaux/delegation";
import { lireCarnet } from "@/lib/missions/travaux/carnet";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA ROBUSTESSE DES TRAVAUX (J8, décision 0023) — le critère de fin de la Direction, sur de VRAIS processus :
 *
 *   « un travail de 3 semaines (horloge factice) traverse 10 redéploiements forcés — arrêt brutal du processus
 *     entre ou pendant les étapes — sans doublon d'écriture ni étape refaite » ;
 *   « deux preneurs (web + worker) : un seul exécute ».
 *
 * Chaque passage est un processus Node (`scripts/bench/travail-processus.ts`) que le banc ABAT par `SIGKILL` à
 * une sonde : pendant une lecture, une analyse, le dépôt d'une demande, juste après un geste, pendant et juste
 * après le dépôt du livrable, ou au repos entre deux attentes. Rien ne se termine proprement : pas de `finally`,
 * pas de bail rendu. Le processus suivant arrive l'horloge avancée de 15 min (au-delà du bail d'une étape).
 *
 * Le double de persona inscrit chaque effet dans un journal sur disque qui survit aux processus : c'est sur lui
 * que portent les comptes (une lecture, un geste par étape de geste, un livrable, une analyse par lot sauf celle
 * tuée en route).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk && fs.existsSync("node_modules/.bin/tsx") ? describe : describe.skip;

const TAG = `__rob__${Date.now()}`;
const MIN = 60_000;
const JOUR = 1440 * MIN;
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "travaux-robustesse-"));

interface Processus { sortie: string[]; attendre: (re: RegExp, ms?: number) => Promise<string>; tuer: () => Promise<void>; fin: Promise<number | null> }

function lancer(env: Record<string, string>): Processus {
  const enfant: ChildProcess = spawn("node_modules/.bin/tsx", ["scripts/bench/travail-processus.ts"], {
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", MISTRAL_API_KEY: "", MIMO_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sortie: string[] = [];
  const erreurs: string[] = [];
  enfant.stdout!.on("data", (b: Buffer) => sortie.push(...b.toString().split("\n").filter(Boolean)));
  enfant.stderr!.on("data", (b: Buffer) => erreurs.push(b.toString()));
  const fin = new Promise<number | null>((r) => enfant.on("exit", (code) => r(code)));
  return {
    sortie,
    attendre: async (re, ms = 60_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const l = sortie.find((x) => re.test(x));
        if (l) return l;
        if (enfant.exitCode !== null) throw new Error(`le processus est sorti (${enfant.exitCode}) sans « ${re} » — ${sortie.join(" | ")} ${erreurs.join("").slice(-1500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`« ${re} » jamais vu — ${sortie.join(" | ")} ${erreurs.join("").slice(-1500)}`);
    },
    tuer: async () => { enfant.kill("SIGKILL"); await fin; },
    fin,
  };
}

const journal = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : []);
const statut = async (id: string) => (await prisma.mission.findUnique({ where: { id }, select: { status: true } }))?.status;

/** La persona du PARENT : proposer, approuver, répondre — les passages, eux, tournent dans les processus. */
const personaParent: PersonaTravaux = {
  persona: "ASSISTANT_IA", nom: "Assistant IA",
  refusTravail: async () => null,
  catalogue: async () => ({
    lectures: [{ nom: "lister_demandes", libelle: "Demandes listées" }],
    gestes: [{ nom: "relancer", libelle: "Relance envoyée", famille: "ECRITURES", libelleFamille: "Écritures métier" }],
  }),
  lire: async () => ({ ok: false, erreur: "non", reessayable: false }),
  refusGeste: async () => null,
  ecrire: async () => ({ ok: false, erreur: "non" }),
  raisonner: async () => ({ ok: false, erreur: "non" }),
  plafonds: async () => ({ travailUsd: 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
  pieces: { visibles: async (_u, ids) => ids.map((nodeId) => ({ nodeId, nom: `pièce ${nodeId}` })), partager: async () => undefined },
  responsable: async () => null,
  deposerLivrable: async () => ({ ok: false, erreur: "non" }),
};

let alice = "";
let bruno = "";
let carla = "";

suite("travaux — robustesse sur de vrais processus (J8)", () => {
  beforeAll(async () => {
    const creer = (n: string) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n.toLowerCase()}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    [alice, bruno, carla] = (await Promise.all([creer("Alice"), creer("Bruno"), creer("Carla")])).map((u) => u.id);
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.businessEvent.deleteMany({ where: { type: { startsWith: "TEST_ROB" } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
    fs.rmSync(dossier, { recursive: true, force: true });
  });

  it("un travail de 3 semaines traverse 10 redéploiements forcés (SIGKILL) sans doublon d'écriture ni étape refaite", { timeout: 300_000 }, async () => {
    const f = path.join(dossier, "trois-semaines.jsonl");
    const ref = `BC:${TAG}`;
    let t = Date.now();
    const p = await proposerTravail(alice, personaParent, {
      titre: "Dossier d'achat sur trois semaines", objectif: "Analyser, attendre la signature, demander le devis à Bruno, relancer, rendre le rapport.",
      etapes: [
        { cle: "demandes", titre: "Lister les demandes", type: "LECTURE", outil: "lister_demandes" },
        { cle: "lots", titre: "Découper en lots", type: "LOTS", lots: { etape: "demandes", chemin: "demandes", taille: 20 } },
        { cle: "analyse", titre: "Analyser un lot", type: "ANALYSE", consigne: "Repère les montants atypiques.", pourChaque: { etape: "lots" } },
        { cle: "synthese", titre: "Synthèse", type: "ANALYSE", consigne: "Synthèse des lots.", apres: ["analyse"] },
        { cle: "signature", titre: "Attendre la signature du BC", type: "ATTENTE", apres: ["synthese"],
          attente: { evenement: "TEST_ROB_BC", entite: ref, champs: { statut: "SIGNE" }, jours: 10, relance: { jours: 2 }, escalade: { jours: 3, a: "RESPONSABLE" } } },
        { cle: "relance-1", titre: "Relancer le fournisseur", type: "GESTE", outil: "relancer", entree: { n: 1 }, apres: ["signature"] },
        { cle: "devis", titre: "Demander le devis signé à Bruno", type: "DEMANDE", apres: ["relance-1"],
          demande: { a: bruno, question: "Peux-tu m'envoyer le devis signé du fournisseur ?", pieces: ["le devis signé"], partager: ["noeudpartage0001"], jours: 4 } },
        { cle: "delai", titre: "Attendre la livraison (17 jours)", type: "ATTENTE", attente: { jours: 17 }, apres: ["devis"] },
        { cle: "relance-2", titre: "Relancer la livraison", type: "GESTE", outil: "relancer", entree: { n: 2 }, apres: ["delai"] },
        { cle: "rapport", titre: "Rapport final", type: "LIVRABLE", consigne: "Rédige le rapport.", format: "docx", apres: ["relance-2"] },
      ],
    });
    if (!p.ok) throw new Error(p.fautes.join(" | "));
    const id = p.travailId;
    const a = await approuverTravail(id, alice, personaParent, { now: () => new Date(t) });
    expect(a.ok).toBe(true);
    const debut = t;
    let redeploiements = 0;
    const env = () => ({ TRAVAIL_ID: id, HORLOGE_MS: String(t), JOURNAL: f, RESPONSABLE_ID: carla });

    /** Un passage abattu à sa sonde — le redéploiement forcé — puis l'horloge avance au-delà du bail d'une étape. */
    const abattu = async (sonde: string) => {
      const pr = lancer({ ...env(), SONDE: sonde });
      await pr.attendre(/^BLOQUE /);
      await pr.tuer();
      redeploiements += 1;
      t += 15 * MIN;
    };
    /** Un passage qui va au bout (jusqu'à ce que le travail n'ait plus rien à faire maintenant). */
    const complet = async () => {
      const pr = lancer(env());
      await pr.attendre(/^FIN /, 90_000);
      await pr.fin;
    };

    await abattu("lire:lister_demandes:1");          //  1. pendant la lecture
    await abattu("raisonner:lot-02:1");              //  2. pendant l'analyse du lot 2
    await abattu("raisonner:Synthèse:1");            //  3. pendant la synthèse
    await abattu("fin::1");                          //  4. au repos, entre deux étapes (l'attente dort en base)
    expect(await statut(id)).toBe("WAITING_EVENT");
    t += 2 * JOUR;                                    // la relance tombe (jour 2), puis l'escalade au responsable (jour 3)
    await complet();
    t += 1 * JOUR;
    await complet();
    await recordEvent({ type: "TEST_ROB_BC", sourceDomain: "test", relatedRefs: [ref], payload: { statut: "SIGNE" } });
    await abattu("apresGeste:relance-1:1");          //  5. juste après le geste (reçu clos, étape pas encore écrite)
    await abattu("partager::1");                     //  6. pendant le dépôt de la demande (après l'inscription, avant l'avis)
    await complet();
    expect(await statut(id)).toBe("WAITING_INPUT");
    t += 1 * JOUR;
    const demande = await prisma.travailDemande.findFirstOrThrow({ where: { missionId: id } });
    expect((await repondreDemande(demande.id, bruno, { texte: "Voici le devis signé ci-joint.", pieces: [] }, personaParent.pieces, new Date(t))).ok).toBe(true);
    await abattu("fin::1");                          //  7. au repos, pendant la minuterie de 17 jours
    t += 17 * JOUR;
    await abattu("apresGeste:relance-2:1");          //  8. juste après le second geste
    await abattu("raisonner:Rapport final:1");       //  9. pendant la rédaction du livrable
    await abattu("livrable:Rapport final:1");        // 10. pendant le dépôt du livrable au Drive (reçu réclamé, jamais clos)
    await complet();

    expect(redeploiements).toBe(10);
    expect(await statut(id)).toBe("COMPLETED");
    expect(t - debut).toBeGreaterThanOrEqual(21 * JOUR);

    const j = journal(f);
    const n = (pred: (l: Record<string, string>) => boolean) => j.filter(pred).length;
    // LES ÉCRITURES : un geste par étape de geste, un dépôt de livrable, jamais deux. Le partage de la pièce, rejoué
    // après le kill 6, accorde le MÊME droit (idempotent : `skipDuplicates`) — une seule pièce, une seule personne.
    expect(j.filter((l) => l.effet === "ecrire").map((l) => l.n)).toEqual([1, 2]);
    expect(n((l) => l.effet === "livrable")).toBe(1);
    expect(new Set(j.filter((l) => l.effet === "partager").map((l) => JSON.stringify([l.ids, l.userId])))).toEqual(new Set([JSON.stringify([["noeudpartage0001"], bruno])]));
    expect(await prisma.travailEcriture.count({ where: { missionId: id } })).toBe(3);
    expect(await prisma.travailDemande.count({ where: { missionId: id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: bruno, link: `/assistant?demande=${demande.id}` } })).toBe(1);
    // AUCUNE ÉTAPE TERMINÉE N'A ÉTÉ REFAITE : seules celles tuées EN COURS ont recommencé (une fois chacune).
    expect(n((l) => l.effet === "lire")).toBe(2);
    const r = (re: RegExp) => n((l) => l.effet === "raisonner" && re.test(l.etape));
    expect([r(/lot-01/), r(/lot-02/), r(/lot-03/), r(/^Synthèse$/)]).toEqual([1, 2, 1, 2]);
    // Le livrable : rédigé pendant le kill 9, puis aux kills 10 et à la fin (le dépôt retrouvé, pas refait).
    expect(r(/Rapport final/)).toBe(3);
    expect(j.some((l) => l.effet === "raisonner" && /Rapport final/.test(l.etape) && l.voitReponse)).toBe(true);
    // LES JALONS, une fois chacun : la relance à la personne, l'escalade au responsable.
    expect(await prisma.notification.count({ where: { userId: alice, title: { startsWith: "Toujours en attente" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: carla, title: { startsWith: "Escalade" } } })).toBe(1);
    const carnet = lireCarnet((await prisma.mission.findUnique({ where: { id }, select: { carnet: true } }))?.carnet);
    expect(carnet.livrables).toHaveLength(1);
    expect(carnet.livrables[0]!.document?.format).toBe("docx");
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "STEP_RECLAIMED" } })).toBeGreaterThanOrEqual(6);
  });

  it("deux preneurs — un web et un worker — sur le même travail : un seul exécute chaque étape", { timeout: 180_000 }, async () => {
    const f = path.join(dossier, "concurrence.jsonl");
    const t = Date.now();
    const p = await proposerTravail(alice, personaParent, {
      titre: "Deux preneurs", objectif: "Lire, analyser par lots, relancer, rendre compte.",
      etapes: [
        { cle: "demandes", titre: "Lister les demandes", type: "LECTURE", outil: "lister_demandes" },
        { cle: "lots", titre: "Découper en lots", type: "LOTS", lots: { etape: "demandes", chemin: "demandes", taille: 10 } },
        { cle: "analyse", titre: "Analyser un lot", type: "ANALYSE", consigne: "x", pourChaque: { etape: "lots" } },
        { cle: "relance", titre: "Relancer", type: "GESTE", outil: "relancer", entree: { n: 1 }, apres: ["analyse"] },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", format: "docx", apres: ["relance"] },
      ],
    });
    if (!p.ok) throw new Error(p.fautes.join(" | "));
    expect((await approuverTravail(p.travailId, alice, personaParent, { now: () => new Date(t) })).ok).toBe(true);
    const env = { TRAVAIL_ID: p.travailId, HORLOGE_MS: String(t), JOURNAL: f, LENTEUR_MS: "800" };
    const [web, worker] = [lancer({ ...env, EXECUTEUR: "web" }), lancer({ ...env, EXECUTEUR: "worker" })];
    await Promise.all([web.attendre(/^FIN /, 120_000), worker.attendre(/^FIN /, 120_000)]);
    await Promise.all([web.fin, worker.fin]);
    expect(await statut(p.travailId)).toBe("COMPLETED");
    const j = journal(f);
    expect(j.filter((l) => l.effet === "lire")).toHaveLength(1);
    expect(j.filter((l) => l.effet === "ecrire")).toHaveLength(1);
    expect(j.filter((l) => l.effet === "livrable")).toHaveLength(1);
    for (const lot of ["lot-01", "lot-02", "lot-03", "lot-04", "lot-05"]) {
      expect(j.filter((l) => l.effet === "raisonner" && l.etape.includes(lot)), lot).toHaveLength(1);
    }
    expect(j.filter((l) => l.effet === "raisonner" && l.etape === "Compte rendu")).toHaveLength(1);
    // Les deux processus se sont réellement disputé le travail (sinon le banc ne prouverait rien) : l'un a buté
    // sur le bail de l'autre, ou tous deux ont exécuté des étapes.
    const bail = [...web.sortie, ...worker.sortie].includes("BAIL");
    expect(bail || new Set(j.map((l) => l.pid)).size === 2).toBe(true);
  });

  it("dans un même processus, deux conduites simultanées du même travail n'exécutent chaque étape qu'une fois", { timeout: 60_000 }, async () => {
    const appels: string[] = [];
    const persona: PersonaTravaux = {
      ...personaParent,
      lire: async (_p, outil) => { appels.push(`lire:${outil}`); await new Promise((r) => setTimeout(r, 50)); return { ok: true, sortie: JSON.stringify({ demandes: Array.from({ length: 30 }, (_, i) => ({ id: i })) }) }; },
      ecrire: async (_p, g) => { appels.push(`ecrire:${g}`); return { ok: true, resultat: {} }; },
      raisonner: async (_p, d) => {
        const etape = /── ÉTAPE : (.*) ──/.exec(d.texte)?.[1] ?? "?";
        appels.push(`raisonner:${etape}`);
        await new Promise((r) => setTimeout(r, 80));
        return { ok: true, texte: d.consigne.includes("LIVRABLE") ? "# CR" : JSON.stringify({ resultat: "ok", trouvailles: [], notes: [] }), usage: { entree: 1, sortie: 1, coutUsd: 0 } };
      },
      deposerLivrable: async (_p, d) => { appels.push(`livrable:${d.cle}`); return { ok: true, document: { nodeId: "n", nom: "cr.docx", format: "docx", lien: "/drive/n" } }; },
    };
    const p = await proposerTravail(alice, persona, {
      titre: "Deux conduites", objectif: "x",
      etapes: [
        { cle: "demandes", titre: "Lister", type: "LECTURE", outil: "lister_demandes" },
        { cle: "lots", titre: "Lots", type: "LOTS", lots: { etape: "demandes", chemin: "demandes", taille: 10 } },
        { cle: "analyse", titre: "Analyser un lot", type: "ANALYSE", consigne: "x", pourChaque: { etape: "lots" } },
        { cle: "relance", titre: "Relancer", type: "GESTE", outil: "relancer", apres: ["analyse"] },
        { cle: "cr", titre: "Compte rendu", type: "LIVRABLE", consigne: "x", apres: ["relance"] },
      ],
    });
    if (!p.ok) throw new Error(p.fautes.join(" | "));
    expect((await approuverTravail(p.travailId, alice, persona)).ok).toBe(true);
    const PAS_SUSPENDU = async () => ({ suspendues: false, depuis: null, parId: null }) as never;
    const deps = { persona, interrupteur: PAS_SUSPENDU, vagues: 40, dureeMaxMs: 30_000 };
    for (let i = 0; i < 6 && (await statut(p.travailId)) !== "COMPLETED"; i++) {
      await Promise.all([conduireTravail(p.travailId, deps), conduireTravail(p.travailId, deps)]);
    }
    expect(await statut(p.travailId)).toBe("COMPLETED");
    const fois = (x: string) => appels.filter((a) => a === x).length;
    expect(fois("lire:lister_demandes")).toBe(1);
    expect(fois("ecrire:relancer")).toBe(1);
    for (const lot of ["lot-01", "lot-02", "lot-03"]) expect(appels.filter((a) => a.startsWith("raisonner:") && a.includes(lot)), lot).toHaveLength(1);
    expect(appels.filter((a) => a.startsWith("livrable:"))).toHaveLength(1);
  });
});
