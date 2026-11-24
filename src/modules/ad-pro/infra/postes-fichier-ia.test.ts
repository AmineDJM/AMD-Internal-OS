import { describe, expect, it, vi } from "vitest";

/**
 * LES POSTES LUS DANS UN FICHIER — le banc du chemin serveur (recette 24/11/2026), dépendances INJECTÉES : ni vraie
 * bascule, ni vrai lecteur, ni vrai fournisseur. On tient l'ordre des portes (rien n'est gardé quand l'IA est
 * coupée ou le format illisible ; le fichier est gardé AVANT la lecture), la relecture des montants contre le
 * texte transmis, et le journal.
 */

// Le lecteur et la passerelle réels ne sont jamais appelés (dépendances injectées) : on ne les charge pas.
vi.mock("@/lib/models/gateway", () => ({ askModelJson: async () => { throw new Error("non injecté"); } }));
vi.mock("@/lib/pieces-lues/lecture-fichier", () => ({ lireFichierUneFois: async () => { throw new Error("non injecté"); } }));
vi.mock("@/lib/pieces-lues/moteur-luna", () => ({ moteurLuna: () => async () => { throw new Error("non injecté"); } }));
vi.mock("@/lib/regulatory/intelligence/extract/texte-ou-ocr", () => ({ moteurParDefaut: async () => { throw new Error("non injecté"); } }));

import { proposerPostesDuFichier, type DependancesPostesFichier } from "./postes-fichier-ia";

const TEXTE = "Cahier des charges — congrès SAHO. 1) Stand 9 m², comptoir : 900 000 DA. 2) Impression de 4 kakémonos. 3) Pause-café pour 120 personnes.";

function banc(o: Partial<DependancesPostesFichier> & { reponse?: unknown } = {}) {
  const journal: { ok: boolean; errorCode: string | null | undefined; feature: string }[] = [];
  const prompts: string[] = [];
  const deps: DependancesPostesFichier = {
    coupee: async () => false,
    fonctionActive: async () => true,
    configure: () => true,
    cle: () => null,
    lire: async () => ({ ok: true, texte: TEXTE, scan: false }),
    appeler: async <T,>(_r: "worker", prompt: string) => {
      prompts.push(prompt);
      return {
        data: (o.reponse ?? null) as T | null,
        reply: { ok: true, configured: true, stop: "end", blocks: [], usage: { role: "worker", model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1 } } as never,
      };
    },
    journaliser: async (u) => { journal.push({ ok: u.ok, errorCode: u.errorCode, feature: u.feature }); },
    ...o,
  };
  return { deps, journal, prompts };
}

function entree(nomFichier = "CDC SAHO.pdf") {
  const gardes: number[] = [];
  return {
    gardes,
    e: { octets: Buffer.from("%PDF-1.4 …"), nomFichier, userId: "u1", natureDemande: "congrès national", garder: async () => { gardes.push(1); return { ok: true as const }; } },
  };
}

const REPONSE = {
  postes: [
    { nature: "STAND", libelle: "Stand 9 m²", description: "Avec comptoir.", quantite: 0, montantDzd: 900_000 },
    { nature: "PRINTING", libelle: "Kakémonos", description: "", quantite: 4, montantDzd: 60_000 },
    { nature: "CATERING", libelle: "Pause-café", description: "120 personnes.", quantite: 120, montantDzd: 0 },
  ],
  remarques: [],
};

describe("les postes d'une demande lus dans un fichier — chemin serveur", () => {
  it("IA coupée, désactivée, non configurée : rien n'est gardé, la phrase dit quoi faire", async () => {
    for (const o of [{ coupee: async () => true }, { fonctionActive: async () => false }, { configure: () => false }]) {
      const { deps, journal } = banc(o);
      const { e, gardes } = entree();
      const r = await proposerPostesDuFichier(e, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.garde).toBe(false); expect(r.error).toMatch(/un par un/); }
      expect(gardes).toHaveLength(0);
      expect(journal).toHaveLength(0);
    }
  });

  it("un format que le lecteur ne lit pas est refusé AVANT d'être gardé", async () => {
    const { deps } = banc();
    const { e, gardes } = entree("cahier.doc");
    const r = await proposerPostesDuFichier(e, deps);
    expect(r).toMatchObject({ ok: false, raison: "FORMAT", garde: false });
    expect(gardes).toHaveLength(0);
  });

  it("le fichier est gardé avant la lecture : une lecture qui échoue le dit", async () => {
    const { deps } = banc({ lire: async () => ({ ok: false, error: "Lecture impossible." }) });
    const { e, gardes } = entree();
    const r = await proposerPostesDuFichier(e, deps);
    expect(gardes).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, raison: "LECTURE", garde: true });
  });

  it("propose les postes relus — un montant qui ne se lit pas dans le document est écarté, et dit", async () => {
    const { deps, journal, prompts } = banc({ reponse: REPONSE });
    const { e, gardes } = entree();
    const r = await proposerPostesDuFichier(e, deps);
    expect(gardes).toHaveLength(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.postes.map((p) => [p.nature, p.quantite, p.montant])).toEqual([["STAND", null, 900_000], ["PRINTING", 4, null], ["CATERING", 120, null]]);
    expect(r.remarques.some((x) => x.includes("Kakémonos"))).toBe(true);
    expect(journal).toEqual([{ ok: true, errorCode: null, feature: "postes_luna" }]);
    // Le document voyage comme une DONNÉE, sous l'enclos.
    expect(prompts[0]).toContain("Nature de la demande : congrès national.");
    expect(prompts[0]).toContain("Pause-café pour 120 personnes");
  });

  it("une panne du fournisseur se dit et se journalise", async () => {
    const { deps, journal } = banc({ appeler: async () => { throw new Error("réseau"); } });
    const { e } = entree();
    const r = await proposerPostesDuFichier(e, deps);
    expect(r).toMatchObject({ ok: false, raison: "ECHEC", garde: true });
    expect(journal[0]).toMatchObject({ ok: false, errorCode: "exception" });
  });

  it("une réponse hors contrat est inexploitable", async () => {
    const { deps, journal } = banc({ reponse: { autre: 1 } });
    const { e } = entree();
    const r = await proposerPostesDuFichier(e, deps);
    expect(r).toMatchObject({ ok: false, raison: "INEXPLOITABLE" });
    expect(journal[0]).toMatchObject({ ok: false, errorCode: "relecture" });
  });
});
