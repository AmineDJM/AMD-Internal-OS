import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { simulerGeste } from "./simulation";
import { estHoteDeModele } from "./reseau";
import { differerEffetSortant } from "./fenetre";
import { etatDuGeste } from "./magasin";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODE ESSAI D'UNE SIMULATION — ce que « Essayer l'agent de… » exige du socle des effets.
 *
 *   • le modèle répond, et lui seul sort : tout autre appel qui écrit reste neutralisé ;
 *   • une requête refusée et rattrapée n'interrompt pas la suite (point de sauvegarde) — sans lui, la transaction de la
 *     simulation était perdue à la première erreur, et l'essai répondait moins bien que la production ;
 *   • un envoi DIFFÉRÉ ne se programme pas sous une simulation (la file s'écrit hors de la transaction annulée) ;
 *   • un geste imbriqué reste en essai.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__essai_socle_${Date.now().toString(36)}_`;
const moi = { id: "essai-socle", name: "Essai", email: "essai@t.dz", role: "SUPER_ADMIN", access: {}, mustChangePassword: false } as unknown as CurrentUser;
const reseau = vi.fn(async () => new Response("{}", { status: 200 }));

describe("un fournisseur de modèles (l'hôte de l'appel qui part à l'essai)", () => {
  it("les domaines connus et l'hôte d'une URL de base réglée — rien d'autre", () => {
    expect(estHoteDeModele("api.openai.com")).toBe(true);
    expect(estHoteDeModele("console.anthropic.com")).toBe(true);
    expect(estHoteDeModele("token-plan-ams.xiaomimimo.com")).toBe(true);
    expect(estHoteDeModele("generativelanguage.googleapis.com")).toBe(true);
    expect(estHoteDeModele("hooks.exemple.dz")).toBe(false);
    expect(estHoteDeModele("openai.com.exemple.dz")).toBe(false);
    const avant = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://passerelle.adventum.dz/v1";
    try {
      expect(estHoteDeModele("passerelle.adventum.dz")).toBe(true);
    } finally {
      if (avant === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = avant;
    }
  });
});

suite("le mode essai d'une simulation", () => {
  beforeAll(() => {
    // Le port réseau se pose sur le `fetch` présent : on y met un espion AVANT qu'il ne s'installe (comme `ports.test.ts`).
    delete (globalThis as { __amdPortReseau?: true }).__amdPortReseau;
    globalThis.fetch = reseau as unknown as typeof fetch;
  });
  afterAll(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => {});
  });

  it("À L'ESSAI, le modèle répond — et lui seul : un webhook reste neutralisé ; hors essai, le modèle l'est aussi", async () => {
    reseau.mockClear();
    const statuts: number[] = [];
    const essai = await simulerGeste(moi, { origine: "test" }, async () => {
      statuts.push((await fetch("https://api.openai.com/v1/essai", { method: "POST", body: "{}" })).status);
      statuts.push((await fetch("https://hooks.exemple.dz/commande", { method: "POST", body: "{}" })).status);
    }, { essai: true });
    expect(essai.ok, essai.erreur).toBe(true);
    expect(statuts).toEqual([200, 202]);
    expect(reseau).toHaveBeenCalledTimes(1);
    expect(essai.capture.effets).toEqual([expect.objectContaining({ acte: "RESEAU", cible: "POST hooks.exemple.dz/commande", neutralise: true })]);

    reseau.mockClear();
    const simple = await simulerGeste(moi, { origine: "test" }, async () => {
      statuts.push((await fetch("https://api.openai.com/v1/essai", { method: "POST", body: "{}" })).status);
    });
    expect(simple.ok).toBe(true);
    expect(statuts.at(-1)).toBe(202);
    expect(reseau).not.toHaveBeenCalled();
  });

  it("À L'ESSAI, une requête refusée et rattrapée n'interrompt pas la suite ; sans point de sauvegarde, la transaction était perdue", async () => {
    const cle = `${TAG}unique`;
    const geste = async () => {
      await prisma.featureFlag.create({ data: { key: cle, label: cle, stage: "TEST" } });
      // Le doublon est refusé par l'unicité, et rattrapé — comme `.catch(sansBloquer…)` dans le code ordinaire.
      await prisma.featureFlag.create({ data: { key: cle, label: cle, stage: "TEST" } }).catch(() => null);
      return prisma.featureFlag.count({ where: { key: cle } });
    };
    const essai = await simulerGeste(moi, { origine: "test" }, geste, { essai: true });
    expect(essai.ok, essai.erreur).toBe(true);
    expect(essai.resultat, "l'écriture d'avant le refus est toujours là, et la requête suivante a répondu").toBe(1);
    // TÉMOIN — la simulation ordinaire, une seule transaction sans point de sauvegarde : la requête suivante échoue.
    const simple = await simulerGeste(moi, { origine: "test" }, geste);
    expect(simple.ok).toBe(false);
    expect(simple.erreur).toMatch(/current transaction is aborted|25P02/i);
    // Et rien n'est resté : les deux simulations sont annulées.
    expect(await prisma.featureFlag.count({ where: { key: cle } })).toBe(0);
  });

  it("aucun point de sauvegarde n'apparaît dans ce que le geste a écrit", async () => {
    const cle = `${TAG}capture`;
    const essai = await simulerGeste(moi, { origine: "test" }, async () => {
      await prisma.featureFlag.create({ data: { key: cle, label: cle, stage: "TEST" } });
    }, { essai: true });
    expect(essai.ok, essai.erreur).toBe(true);
    expect(essai.capture.ecritures.map((e) => `${e.modele}:${e.operation}`)).toEqual(["FeatureFlag:CREATE"]);
  });

  it("SOUS UNE SIMULATION, un envoi différé ne se programme pas : noté, neutralisé, aucune ligne en file", async () => {
    const cible = `${TAG}destinataire@exemple.dz`;
    const issue = await simulerGeste(moi, { origine: "test" }, async () => {
      const p = await differerEffetSortant({ type: "courriel.smtp", acte: "COURRIEL", cible, charge: {}, principalId: null });
      return p.id;
    });
    expect(issue.ok, issue.erreur).toBe(true);
    expect(issue.resultat).toBe("simulation");
    expect(issue.capture.effets).toEqual([expect.objectContaining({ acte: "COURRIEL", cible, neutralise: true })]);
    expect(await prisma.effetSortantDiffere.count({ where: { cible } }), "une ligne en file partirait pour de bon").toBe(0);
  });

  it("un geste imbriqué sous un essai reste un essai (le modèle y répond aussi)", async () => {
    const issue = await simulerGeste(moi, { origine: "test" }, async () => {
      const dedans = await simulerGeste(moi, { origine: "imbrique" }, async () => etatDuGeste()?.essai ?? false);
      return { dehors: etatDuGeste()?.essai ?? false, dedans: dedans.resultat };
    }, { essai: true });
    expect(issue.resultat).toEqual({ dehors: true, dedans: true });
  });
});
