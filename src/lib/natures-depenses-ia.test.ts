import { describe, it, expect } from "vitest";
import { classerLibelles, type DependancesNatures } from "./natures-depenses-ia";
import { NATURES_PAR_DEFAUT, type CategorieConnue } from "@/lib/general-means/natures";
import type { ModelReply } from "@/lib/models/contract";

const CATS: CategorieConnue[] = NATURES_PAR_DEFAUT.map((n, i) => ({ id: `c${i}`, nom: n.nom, cle: n.cle }));
const idDe = (cle: string) => CATS.find((c) => c.cle === cle)!.id;

function deps(reponse: unknown, opts: { coupee?: boolean; leve?: boolean } = {}): DependancesNatures & { appels: number; journal: unknown[] } {
  const d = {
    appels: 0,
    journal: [] as unknown[],
    coupee: async () => Boolean(opts.coupee),
    fonctionActive: async () => true,
    configure: () => true,
    cle: () => "OPENAI_API_KEY",
    appeler: async <T,>() => {
      d.appels++;
      if (opts.leve) throw new Error("panne");
      return { data: reponse as T, reply: { ok: true, configured: true, blocks: [], usage: undefined } as unknown as ModelReply };
    },
    journaliser: async (u: unknown) => { d.journal.push(u); },
  };
  return d;
}

describe("l'IA range les articles d'un ticket", () => {
  it("prend la réponse du modèle, ligne par ligne, et journalise l'appel", async () => {
    const d = deps({ lignes: [
      { index: 0, categorieId: idDe("MG_CUISINE"), nouvelle: null },
      { index: 1, categorieId: null, nouvelle: "Abonnements logiciels" },
    ] });
    const r = await classerLibelles({ libelles: ["Café", "Abonnement Canva"], categories: CATS, userId: "u" }, d);
    expect(r.ia).toBe(true);
    expect(r.propositions).toEqual([{ categorieId: idDe("MG_CUISINE") }, { nouvelle: "Abonnements logiciels" }]);
    expect(d.journal).toEqual([expect.objectContaining({ feature: "nature_depense", ok: true })]);
  });

  it("une ligne laissée sans réponse passe par les mots-clés", async () => {
    const d = deps({ lignes: [{ index: 0, categorieId: null, nouvelle: null }] });
    const r = await classerLibelles({ libelles: ["Recharge Mobilis"], categories: CATS, userId: "u" }, d);
    expect(r.propositions).toEqual([{ categorieId: idDe("MG_TELECOM") }]);
  });

  it("IA coupée : aucun appel, les mots-clés seuls — la saisie n'est jamais bloquée", async () => {
    const d = deps(null, { coupee: true });
    const r = await classerLibelles({ libelles: ["Taxi", "Chose inconnue"], categories: CATS, userId: "u" }, d);
    expect(d.appels).toBe(0);
    expect(r.ia).toBe(false);
    expect(r.propositions).toEqual([{ categorieId: idDe("MG_TRANSPORT") }, null]);
  });

  it("le modèle en panne : journalisé en échec, repli sur les mots-clés", async () => {
    const d = deps(null, { leve: true });
    const r = await classerLibelles({ libelles: ["Javel"], categories: CATS, userId: "u" }, d);
    expect(r.propositions).toEqual([{ categorieId: idDe("MG_ENTRETIEN") }]);
    expect(d.journal).toEqual([expect.objectContaining({ ok: false, errorCode: "exception" })]);
  });

  it("une ligne vide n'est ni envoyée ni rangée", async () => {
    const d = deps({ lignes: [{ index: 0, categorieId: idDe("MG_AUTRE"), nouvelle: null }] });
    const r = await classerLibelles({ libelles: ["", "Truc"], categories: CATS, userId: "u" }, d);
    expect(r.propositions).toEqual([null, { categorieId: idDe("MG_AUTRE") }]);
  });
});
