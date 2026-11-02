import { afterAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { prendreBailTache, rendreBailTache } from "./bail";
import { executerPassage, executerTache, ignoree, type ContexteExecution, type TachePlanifiee } from "./executer";
import type { EntreeJournal, Journal } from "./journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BAIL DES TÂCHES DE FOND (refonte V2-F) — sur la vraie base, pas sur un double.
 *
 * Ce qu'on prouve : (1) deux exécutants qui se présentent EN MÊME TEMPS ne font qu'une exécution —
 * c'est Postgres qui tranche, pas un drapeau en mémoire ; (2) un exécutant mort (bail expiré)
 * n'immobilise pas sa tâche ; (3) un bail vivant, lui, est respecté, et renouvelé pendant une
 * tâche longue ; (4) l'issue (OK, ÉCHEC, IGNORÉE), la durée et le message arrivent en base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = `test-v2f-${crypto.randomBytes(3).toString("hex")}`;
let n = 0;
const cleUnique = () => `${PREFIXE}.${++n}`;

function journalMemoire(): { journal: Journal; entrees: EntreeJournal[] } {
  const entrees: EntreeJournal[] = [];
  return {
    entrees,
    journal: (niveau, evenement, champs) => {
      entrees.push({ ts: new Date().toISOString(), source: "taches-de-fond", niveau, evenement, ...champs });
    },
  };
}

function ctx(detenteur: string, journal?: Journal): ContexteExecution {
  return { detenteur, executeur: detenteur.startsWith("worker") ? "worker" : "web", journal: journal ?? (() => undefined) };
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await prisma.tacheDeFond.deleteMany({ where: { cle: { startsWith: PREFIXE } } });
});

describe("le verrou est exclusif", () => {
  it("deux exécutants simultanés → UNE seule exécution", async () => {
    const cle = cleUnique();
    let executions = 0;
    const tache: TachePlanifiee = { cle, executer: async () => { executions += 1; await attendre(80); } };

    const [a, b] = await Promise.all([
      executerTache(tache, ctx("web@a#1")),
      executerTache(tache, ctx("worker@b#2")),
    ]);

    expect(executions).toBe(1);
    expect([a.issue, b.issue].sort()).toEqual(["occupee", "ok"]);
    const ligne = await prisma.tacheDeFond.findUniqueOrThrow({ where: { cle } });
    expect(ligne.executions).toBe(1);
    expect(ligne.detenteur).toBeNull(); // rendu à la fin
    expect(ligne.dernierStatut).toBe("OK");
  });

  it("huit prétendants au même instant, sur une ligne qui n'existe pas encore → toujours une seule", async () => {
    const cle = cleUnique();
    let executions = 0;
    const tache: TachePlanifiee = { cle, executer: async () => { executions += 1; await attendre(30); } };
    const bilans = await Promise.all(Array.from({ length: 8 }, (_, i) => executerTache(tache, ctx(`worker@x#${i}`))));
    expect(executions).toBe(1);
    expect(bilans.filter((b) => b.issue === "ok")).toHaveLength(1);
  });

  it("deux passages concurrents se partagent la table : chaque tâche une fois, aucune deux fois", async () => {
    const compteurs = new Map<string, number>();
    const taches: TachePlanifiee[] = Array.from({ length: 6 }, () => {
      const cle = cleUnique();
      return { cle, executer: async () => { compteurs.set(cle, (compteurs.get(cle) ?? 0) + 1); await attendre(15); } };
    });
    const [p1, p2] = await Promise.all([executerPassage(taches, ctx("web@a#1")), executerPassage(taches, ctx("worker@b#2"))]);
    for (const t of taches) expect(compteurs.get(t.cle), t.cle).toBe(1);
    const faites = (p: typeof p1) => p.taches.filter((b) => b.issue === "ok").length;
    expect(faites(p1) + faites(p2)).toBe(taches.length);
  });

  it("une tâche rendue ne repart pas aussitôt chez l'autre exécutant (écart minimal entre deux départs)", async () => {
    const cle = cleUnique();
    let executions = 0;
    const tache: TachePlanifiee = { cle, executer: async () => { executions += 1; } };
    expect((await executerTache(tache, ctx("web@a#1"))).issue).toBe("ok");
    expect((await executerTache(tache, ctx("worker@b#2"))).issue).toBe("occupee");
    expect(executions).toBe(1);
    // Écart nul : la même tâche repart (c'est l'intervalle qui retenait, pas le bail).
    expect((await executerTache({ ...tache, intervalleMs: 0 }, ctx("worker@b#2"))).issue).toBe("ok");
    expect(executions).toBe(2);
  });
});

describe("reprise après plantage", () => {
  it("un bail EXPIRÉ (processus mort) se reprend, et la tâche s'exécute", async () => {
    const cle = cleUnique();
    const ilYA = (ms: number) => new Date(Date.now() - ms);
    await prisma.tacheDeFond.create({
      data: { cle, detenteur: "worker@mort#99", executeur: "worker", bailJusqua: ilYA(1_000), dernierDebutA: ilYA(200_000), dernierStatut: "EN_COURS" },
    });
    let executions = 0;
    const bilan = await executerTache({ cle, executer: async () => { executions += 1; } }, ctx("web@a#1"));
    expect(bilan.issue).toBe("ok");
    expect(executions).toBe(1);
    const ligne = await prisma.tacheDeFond.findUniqueOrThrow({ where: { cle } });
    expect(ligne.executeur).toBe("web");
    expect(ligne.dernierStatut).toBe("OK");
  });

  it("un bail VIVANT d'un autre processus est respecté, même si son départ est ancien", async () => {
    const cle = cleUnique();
    await prisma.tacheDeFond.create({
      data: { cle, detenteur: "worker@vivant#7", executeur: "worker", bailJusqua: new Date(Date.now() + 60_000), dernierDebutA: new Date(Date.now() - 200_000), dernierStatut: "EN_COURS" },
    });
    let executions = 0;
    const bilan = await executerTache({ cle, executer: async () => { executions += 1; } }, ctx("web@a#1"));
    expect(bilan.issue).toBe("occupee");
    expect(executions).toBe(0);
  });

  it("le bail se RENOUVELLE pendant une tâche longue : elle ne paraît jamais morte à son voisin", async () => {
    const cle = cleUnique();
    let voisin: string | null = null;
    // Bail d'une seconde et demie, renouvelé chaque seconde ; la tâche dure 2,5 s. Sans
    // renouvellement, le voisin la prendrait à 2 s.
    const tache: TachePlanifiee = {
      cle, bailMs: 1_500, intervalleMs: 0,
      executer: async () => {
        await attendre(2_000);
        voisin = (await executerTache({ cle, intervalleMs: 0, executer: async () => undefined }, ctx("worker@b#2"))).issue;
        await attendre(500);
      },
    };
    expect((await executerTache(tache, ctx("web@a#1"))).issue).toBe("ok");
    expect(voisin).toBe("occupee");
  });

  it("on ne rend que SON bail : rendre celui d'un autre le lui volerait", async () => {
    const cle = cleUnique();
    expect(await prendreBailTache(cle, { detenteur: "worker@b#2", executeur: "worker" })).toBe(true);
    expect(await rendreBailTache(cle, "web@a#1", { statut: "OK", dureeMs: 1 })).toBe(false);
    const ligne = await prisma.tacheDeFond.findUniqueOrThrow({ where: { cle } });
    expect(ligne.detenteur).toBe("worker@b#2");
    expect(await rendreBailTache(cle, "worker@b#2", { statut: "OK", dureeMs: 1 })).toBe(true);
  });
});

describe("issue, durée et journal", () => {
  it("un échec est compté, son message gardé, le bail rendu — et le passage continue", async () => {
    const { journal, entrees } = journalMemoire();
    const casse = cleUnique();
    const suivante = cleUnique();
    let suivanteFaite = false;
    const bilan = await executerPassage([
      { cle: casse, executer: async () => { throw new Error("base indisponible"); } },
      { cle: suivante, executer: async () => { suivanteFaite = true; } },
    ], ctx("worker@b#2", journal));

    expect(bilan.taches.map((b) => b.issue)).toEqual(["echec", "ok"]);
    expect(suivanteFaite).toBe(true);
    const ligne = await prisma.tacheDeFond.findUniqueOrThrow({ where: { cle: casse } });
    expect(ligne).toMatchObject({ dernierStatut: "ECHEC", echecs: 1, executions: 1, detenteur: null, bailJusqua: null });
    expect(ligne.dernierMessage).toContain("base indisponible");
    expect(ligne.derniereDureeMs).not.toBeNull();

    const echec = entrees.find((e) => e.evenement === "tache.echec");
    expect(echec).toMatchObject({ niveau: "erreur", tache: casse, executeur: "worker" });
    const fin = entrees.find((e) => e.evenement === "passage.fin");
    expect(fin).toMatchObject({ executees: 2, echecs: 1, occupees: 0 });
    expect(Object.keys(fin!.durees as object)).toEqual([casse, suivante]);
  });

  it("une tâche qui se déclare ignorée est IGNOREE, avec sa raison", async () => {
    const cle = cleUnique();
    const bilan = await executerTache({ cle, executer: async () => ignoree("pas encore livrée") }, ctx("web@a#1"));
    expect(bilan.issue).toBe("ignoree");
    const ligne = await prisma.tacheDeFond.findUniqueOrThrow({ where: { cle } });
    expect(ligne).toMatchObject({ dernierStatut: "IGNOREE", dernierMessage: "pas encore livrée", echecs: 0 });
  });

  it("l'arrêt demandé est respecté ENTRE deux tâches : rien de nouveau n'est pris", async () => {
    let arret = false;
    const faites: string[] = [];
    const taches: TachePlanifiee[] = [cleUnique(), cleUnique(), cleUnique()].map((cle, i) => ({
      cle, executer: async () => { faites.push(cle); if (i === 0) arret = true; },
    }));
    const bilan = await executerPassage(taches, { ...ctx("worker@b#2"), doitSArreter: () => arret });
    expect(faites).toEqual([taches[0].cle]);
    expect(bilan.interrompu).toBe(true);
  });
});
