import { describe, expect, it } from "vitest";
import type { AiUsageInput } from "@/lib/ai-settings";
import type { LunaResult } from "@/lib/openai-luna";
import { lireContratPourAttestation, type DependancesLectureContrat } from "./attestation-travail-luna";

const TEXTE = `Entre les soussignés : la SARL ADVENTUM PHARMA, représentée par Monsieur SAIDI Karim en qualité de Gérant,
Et Madame KACI Lina, née le 05/03/1990 à Tizi Ouzou, d'autre part.
Article 2 : Madame KACI Lina est recrutée en qualité de Déléguée médicale.
Article 3 : Le présent contrat prend effet à compter du 1er juillet 2025.`;
const MANQUANTS = ["civilite", "dateNaissance", "lieuNaissance", "poste", "dateEmbauche"] as const;
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.0001 };

function deps(p: Partial<DependancesLectureContrat> & { journal?: AiUsageInput[]; appels?: { n: number } } = {}): DependancesLectureContrat {
  return {
    coupee: async () => false,
    fonctionActive: async () => true,
    configure: () => true,
    lire: async () => ({ ok: true, texte: TEXTE }),
    appeler: async () => { if (p.appels) p.appels.n++; return { ok: true, configured: true, text: "", usage, data: {} } as LunaResult<unknown>; },
    journaliser: async (u) => { p.journal?.push(u); },
    ...p,
  };
}
const entree = { octets: Buffer.from("x"), nomFichier: "Contrat.docx", manquants: MANQUANTS, userId: "u1" };

describe("Luna lit le contrat pour l'attestation — et ne bloque jamais", () => {
  it("IA COUPÉE : aucun appel, la lecture déterministe remplit, la note le dit", async () => {
    const appels = { n: 0 };
    const r = await lireContratPourAttestation(entree, deps({ coupee: async () => true, appels }));
    expect(appels.n).toBe(0);
    expect(r.parLuna).toEqual([]);
    expect(r.lu).toEqual({ civilite: "Madame", dateNaissance: "1990-03-05", lieuNaissance: "Tizi Ouzou", poste: "Déléguée médicale", dateEmbauche: "2025-07-01" });
    expect(r.note).toMatch(/sans Luna \(l'IA est coupée/);
  });
  it("bascule fermée ou clé absente : même repli, aucun appel", async () => {
    for (const d of [deps({ fonctionActive: async () => false }), deps({ configure: () => false })]) {
      const appels = { n: 0 };
      const r = await lireContratPourAttestation(entree, { ...d, appeler: async (...a) => { appels.n++; return d.appeler(...a); } });
      expect(appels.n).toBe(0);
      expect(r.lu.poste).toBe("Déléguée médicale");
    }
  });
  it("Luna répond : ses valeurs l'emportent champ par champ, la lecture déterministe comble ce qu'elle tait ; l'appel est journalisé", async () => {
    const journal: AiUsageInput[] = [];
    const r = await lireContratPourAttestation(entree, deps({
      journal,
      appeler: async () => ({ ok: true, configured: true, text: "", usage, data: { civilite: "Madame", dateNaissance: "1990-03-05", lieuNaissance: "Tizi-Ouzou (wilaya)", poste: "", dateEmbauche: "" } }),
    }));
    expect(r.lu.lieuNaissance).toBe("Tizi-Ouzou (wilaya)");
    expect(r.lu.poste).toBe("Déléguée médicale"); // la lecture déterministe
    expect(r.parLuna.sort()).toEqual(["civilite", "dateNaissance", "lieuNaissance"]);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ feature: "attestation_travail", ok: true, userId: "u1" });
  });
  it("seuls les champs MANQUANTS reviennent — la fiche n'est jamais contredite", async () => {
    const r = await lireContratPourAttestation({ ...entree, manquants: ["lieuNaissance"] }, deps({ coupee: async () => true }));
    expect(r.lu).toEqual({ lieuNaissance: "Tizi Ouzou" });
  });
  it("Luna en panne : repli déterministe, échec journalisé ; contrat illisible : rien, sans lever", async () => {
    const journal: AiUsageInput[] = [];
    const r = await lireContratPourAttestation(entree, deps({ journal, appeler: async () => { throw new Error("réseau"); } }));
    expect(r.parLuna).toEqual([]);
    expect(r.lu.dateEmbauche).toBe("2025-07-01");
    expect(r.note).toMatch(/Luna n'a pas répondu/);
    expect(journal[0]).toMatchObject({ ok: false, errorCode: "exception" });
    const vide = await lireContratPourAttestation(entree, deps({ lire: async () => ({ ok: false, error: "scan illisible" }) }));
    expect(vide).toMatchObject({ lu: {}, parLuna: [] });
    expect(vide.note).toMatch(/scan illisible/);
  });
});
