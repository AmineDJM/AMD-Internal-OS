import { describe, it, expect } from "vitest";
import { etatDemande, lireReponse, phraseBilan, type LigneConnue } from "./actualisation-soldes";

const A: LigneConnue = { id: "a", compte: "SGA Birkhadem", etat: "EN_ATTENTE", jourAncrageActuel: "2026-09-28" };
const B: LigneConnue = { id: "b", compte: "BNA", etat: "EN_ATTENTE", jourAncrageActuel: "2026-09-28" };
const AUJ = "2026-10-26";

describe("actualisation des soldes — la règle", () => {
  it("l'état de la demande se déduit de ses lignes", () => {
    expect(etatDemande(["EN_ATTENTE", "EN_ATTENTE"])).toBe("EN_ATTENTE");
    expect(etatDemande(["ACTUALISE", "NON_RECU"])).toBe("PARTIELLE");
    expect(etatDemande(["NON_RECU"])).toBe("PARTIELLE");
    expect(etatDemande(["ACTUALISE", "ACTUALISE"])).toBe("TERMINEE");
    expect(etatDemande([])).toBe("EN_ATTENTE");
  });

  it("une réponse complète passe : un solde daté, et « pas encore reçu »", () => {
    const r = lireReponse([A, B], [
      { ligneId: "a", choix: "ACTUALISE", solde: 2271953.456, date: AUJ },
      { ligneId: "b", choix: "NON_RECU" },
    ], AUJ);
    expect(r).toEqual({ ok: true, actualisees: [{ ligneId: "a", solde: 2271953.46, date: AUJ }], nonRecues: ["b"] });
  });

  it("un découvert est un solde : un montant négatif passe", () => {
    const r = lireReponse([A], [{ ligneId: "a", choix: "ACTUALISE", solde: -15000, date: AUJ }], AUJ);
    expect(r.ok).toBe(true);
  });

  it("un compte oublié est NOMMÉ — le demandeur lirait sinon un silence", () => {
    const r = lireReponse([A, B], [{ ligneId: "a", choix: "ACTUALISE", solde: 1, date: AUJ }], AUJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BNA/);
  });

  it("refuse en une fois : solde absent, date future, date antérieure au relevé actuel", () => {
    const C: LigneConnue = { id: "c", compte: "CPA", etat: "EN_ATTENTE", jourAncrageActuel: "2026-09-28" };
    const r = lireReponse([A, B, C], [
      { ligneId: "a", choix: "ACTUALISE", solde: null, date: AUJ },
      { ligneId: "b", choix: "ACTUALISE", solde: 10, date: "2026-12-01" },
      { ligneId: "c", choix: "ACTUALISE", solde: 10, date: "2026-09-01" },
    ], AUJ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/solde de « SGA Birkhadem »/);
      expect(r.error).toMatch(/futur pour « BNA »/);
      expect(r.error).toMatch(/28\/09\/2026 pour « CPA »/);
    }
  });

  it("un compte déjà actualisé ne se réécrit pas, et n'est plus exigé", () => {
    const fait: LigneConnue = { ...A, etat: "ACTUALISE" };
    const reecrit = lireReponse([fait, B], [
      { ligneId: "a", choix: "ACTUALISE", solde: 1, date: AUJ },
      { ligneId: "b", choix: "NON_RECU" },
    ], AUJ);
    expect(reecrit.ok).toBe(false);
    const complete = lireReponse([fait, { ...B, etat: "NON_RECU" }], [{ ligneId: "b", choix: "ACTUALISE", solde: 5, date: AUJ }], AUJ);
    expect(complete.ok).toBe(true);
  });

  it("une ligne étrangère à la demande est refusée", () => {
    const r = lireReponse([A], [{ ligneId: "a", choix: "NON_RECU" }, { ligneId: "zzz", choix: "NON_RECU" }], AUJ);
    expect(r.ok).toBe(false);
  });

  it("le bilan dit chaque compte", () => {
    const p = phraseBilan([
      { compte: "SGA", etat: "ACTUALISE", solde: 1000, date: "2026-10-26" },
      { compte: "BNA", etat: "NON_RECU", solde: null, date: null },
    ]);
    expect(p).toMatch(/SGA : 1.000 DZD au 26\/10\/2026/);
    expect(p).toMatch(/BNA : relevé pas encore reçu/);
  });
});
