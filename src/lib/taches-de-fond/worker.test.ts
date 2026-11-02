import { describe, expect, it } from "vitest";
import { demarrerWorker, dormir } from "./worker";
import type { BilanPassage, ContexteExecution } from "./executer";
import type { Journal } from "./journal";

/**
 * LA BOUCLE DU WORKER (refonte V2-F), sans processus : un signal à la place de SIGTERM, un passage
 * factice à la place de la table des tâches.
 */

const PASSAGE_VIDE: BilanPassage = { dureeMs: 0, interrompu: false, taches: [] };

function journalMemoire() {
  const evenements: { niveau: string; evenement: string; champs?: Record<string, unknown> }[] = [];
  const journal: Journal = (niveau, evenement, champs) => { evenements.push({ niveau, evenement, champs }); };
  return { journal, evenements };
}

describe("la boucle du worker", () => {
  it("sous TACHES_DE_FOND=web : n'exécute RIEN, attend le signal sans sortir (pas de redémarrage en boucle)", async () => {
    const { journal, evenements } = journalMemoire();
    const controleur = new AbortController();
    let passages = 0;
    const fin = demarrerWorker({
      signal: controleur.signal, mode: "web", detenteur: "worker@t#1", tickMs: 10, journal,
      passage: async () => { passages += 1; return PASSAGE_VIDE; },
    });
    await new Promise((r) => setTimeout(r, 50));
    controleur.abort();
    expect(await fin).toEqual({ passages: 0, enAttente: true });
    expect(passages).toBe(0);
    expect(evenements.map((e) => e.evenement)).toEqual(["worker.en-attente"]);
  });

  it("SCHEDULER_DISABLED=1 (soupape) le met aussi en attente, même sous TACHES_DE_FOND=worker", async () => {
    const controleur = new AbortController();
    controleur.abort();
    const bilan = await demarrerWorker({
      signal: controleur.signal, mode: "worker", suspendu: true, detenteur: "worker@t#1", tickMs: 10, journal: () => undefined,
      passage: async () => { throw new Error("ne doit pas tourner"); },
    });
    expect(bilan.enAttente).toBe(true);
  });

  it("sous worker : un passage tout de suite, puis au rythme ; l'arrêt coupe la sieste et sort proprement", async () => {
    const { journal, evenements } = journalMemoire();
    const controleur = new AbortController();
    const contextes: ContexteExecution[] = [];
    const fin = demarrerWorker({
      signal: controleur.signal, mode: "worker", detenteur: "worker@t#1", tickMs: 60_000, journal,
      passage: async (ctx) => { contextes.push(ctx); return PASSAGE_VIDE; },
    });
    await new Promise((r) => setTimeout(r, 30));
    const avant = Date.now();
    controleur.abort();
    const bilan = await fin;
    expect(Date.now() - avant).toBeLessThan(1_000); // la sieste de 60 s n'est pas attendue
    expect(bilan).toEqual({ passages: 1, enAttente: false });
    expect(contextes[0]).toMatchObject({ detenteur: "worker@t#1", executeur: "worker" });
    expect(contextes[0].doitSArreter?.()).toBe(true); // le passage voit l'arrêt demandé
    expect(evenements.map((e) => e.evenement)).toEqual(["worker.demarrage", "worker.arret"]);
  });

  it("sous les-deux : le worker bat aussi", async () => {
    const controleur = new AbortController();
    let passages = 0;
    const fin = demarrerWorker({
      signal: controleur.signal, mode: "les-deux", detenteur: "worker@t#1", tickMs: 1_000, journal: () => undefined,
      passage: async () => { passages += 1; controleur.abort(); return PASSAGE_VIDE; },
    });
    expect((await fin).passages).toBe(1);
    expect(passages).toBe(1);
  });

  it("un passage qui lève ne tue pas la boucle", async () => {
    const { journal, evenements } = journalMemoire();
    const controleur = new AbortController();
    let passages = 0;
    const bilan = await demarrerWorker({
      signal: controleur.signal, mode: "worker", detenteur: "worker@t#1", tickMs: 1_000, journal,
      passage: async () => {
        passages += 1;
        if (passages === 2) controleur.abort();
        if (passages === 1) throw new Error("boum");
        return PASSAGE_VIDE;
      },
    });
    expect(bilan.passages).toBe(2);
    expect(evenements.some((e) => e.evenement === "worker.passage-echoue" && e.niveau === "erreur")).toBe(true);
  });

  it("attend que la base porte les migrations de son code avant le premier passage", async () => {
    const { journal, evenements } = journalMemoire();
    const controleur = new AbortController();
    const reponses = [["20990101000000_neuve"], ["20990101000000_neuve"], []];
    let verifications = 0;
    let passageApres = -1;
    await demarrerWorker({
      signal: controleur.signal, mode: "worker", detenteur: "worker@t#1", tickMs: 1_000, journal, attenteMigrationsMs: 5,
      migrationsManquantes: async () => reponses[verifications++] ?? [],
      passage: async () => { passageApres = verifications; controleur.abort(); return PASSAGE_VIDE; },
    });
    expect(passageApres).toBe(3); // pas un passage avant que la base soit à jour
    expect(evenements.filter((e) => e.evenement === "worker.attente-migrations")).toHaveLength(1); // pas de bruit à chaque essai
    expect(evenements.some((e) => e.evenement === "worker.base-a-jour")).toBe(true);
  });

  it("un arrêt pendant l'attente des migrations sort sans aucun passage", async () => {
    const controleur = new AbortController();
    setTimeout(() => controleur.abort(), 20);
    const bilan = await demarrerWorker({
      signal: controleur.signal, mode: "worker", detenteur: "worker@t#1", tickMs: 1_000, journal: () => undefined, attenteMigrationsMs: 60_000,
      migrationsManquantes: async () => ["20990101000000_neuve"],
      passage: async () => { throw new Error("ne doit pas tourner"); },
    });
    expect(bilan.passages).toBe(0);
  });

  it("dormir rend la main dès que le signal tombe", async () => {
    const controleur = new AbortController();
    const debut = Date.now();
    setTimeout(() => controleur.abort(), 20);
    await dormir(60_000, controleur.signal);
    expect(Date.now() - debut).toBeLessThan(1_000);
  });
});
