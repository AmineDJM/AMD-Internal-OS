import { describe, expect, it } from "vitest";
import { evaluerControle, VARIABLES_DU_WORKER } from "./sante";

const toutes = Object.fromEntries(VARIABLES_DU_WORKER.map((v) => [v.cle, "x"]));
const moteurOk = { pret: true, manquants: [], detail: null, erreur: null };

describe("contrôle au démarrage du worker (décision 0019)", () => {
  it("tout présent, moteur complet : prêt, aucun message", () => {
    const r = evaluerControle(toutes, { detenteur: "worker@h", mode: "les-deux", moteur: moteurOk });
    expect(r.pret).toBe(true);
    expect(r.messages).toEqual([]);
  });

  it("une clé facultative absente : prêt quand même, mais DIT en clair", () => {
    const r = evaluerControle({ ...toutes, GOOGLE_CLIENT_ID: "" }, { detenteur: "w", mode: "les-deux", moteur: moteurOk });
    expect(r.pret).toBe(true);
    expect(r.manquantes).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(r.messages[0]).toMatch(/GOOGLE_CLIENT_ID absente : la synchronisation Google/);
  });

  it("clé maître absente ou moteur incomplet : pas prêt, et la raison est écrite — jamais une valeur", () => {
    const r = evaluerControle({ ...toutes, AUTH_SECRET: undefined }, { detenteur: "w", mode: "web", moteur: { pret: false, manquants: ["tesseract-ara"], detail: null, erreur: null } });
    expect(r.pret).toBe(false);
    expect(r.messages.join("\n")).toMatch(/CRITIQUE — AUTH_SECRET/);
    expect(r.messages.join("\n")).toMatch(/tesseract-ara/);
    expect(JSON.stringify(r)).not.toContain('"x"');
  });
});
