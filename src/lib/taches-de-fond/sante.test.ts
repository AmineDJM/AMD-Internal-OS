import { describe, expect, it } from "vitest";
import { evaluerSante, SEUIL_SILENCE_MS } from "./sante";

/** LE SIGNAL DE SANTÉ (refonte V2-F) : pur, des lignes de bail à l'état lisible. */

const MAINTENANT = new Date("2026-10-27T12:00:00Z");
const ilYA = (ms: number) => new Date(MAINTENANT.getTime() - ms);

function ligne(cle: string, champs: Partial<Parameters<typeof evaluerSante>[0][number]> = {}) {
  return {
    cle, detenteur: null, executeur: "worker", bailJusqua: null, dernierDebutA: ilYA(30_000), dernierFinA: ilYA(29_000),
    derniereDureeMs: 1_000, dernierStatut: "OK" as const, dernierMessage: null, executions: 3, echecs: 0, ...champs,
  };
}

const opts = { maintenant: MAINTENANT, mode: "worker" as const, modeInconnu: false, detail: false };

describe("santé des tâches de fond", () => {
  it("vivant quand une tâche est partie récemment ; exécutants récents listés", () => {
    const s = evaluerSante([ligne("b"), ligne("a", { executeur: "web" })], opts);
    expect(s.vivant).toBe(true);
    expect(s.executeursRecents).toEqual(["web", "worker"]);
    expect(s.taches.map((t) => t.cle)).toEqual(["a", "b"]);
    expect(s.dernierBattementA).toBe(ilYA(30_000).toISOString());
  });

  it("silencieux au-delà du seuil : plus vivant, tâches en retard, exécutant ancien non compté", () => {
    const s = evaluerSante([ligne("a", { dernierDebutA: ilYA(SEUIL_SILENCE_MS + 1) })], opts);
    expect(s.vivant).toBe(false);
    expect(s.taches[0].enRetard).toBe(true);
    expect(s.executeursRecents).toEqual([]);
  });

  it("aucune ligne : pas vivant, pas de dernier battement", () => {
    const s = evaluerSante([], opts);
    expect(s).toMatchObject({ vivant: false, dernierBattementA: null, taches: [] });
  });

  it("EN_COURS avec bail vivant = en cours ; bail expiré = interrompue (processus tué)", () => {
    const s = evaluerSante([
      ligne("vivante", { dernierStatut: "EN_COURS", bailJusqua: new Date(MAINTENANT.getTime() + 60_000) }),
      ligne("morte", { dernierStatut: "EN_COURS", bailJusqua: ilYA(1) }),
    ], opts);
    const [morte, vivante] = s.taches;
    expect(vivante).toMatchObject({ enCours: true, interrompue: false });
    expect(morte).toMatchObject({ enCours: false, interrompue: true });
  });

  it("le détail (détenteur, message) n'est rendu qu'à la demande — jamais dans la réponse publique", () => {
    const l = ligne("a", { detenteur: "worker@h#1-abc", dernierStatut: "ECHEC", dernierMessage: "Error: secret de connexion" });
    const publique = evaluerSante([l], opts).taches[0];
    expect(publique).not.toHaveProperty("detenteur");
    expect(publique).not.toHaveProperty("message");
    const detail = evaluerSante([l], { ...opts, detail: true }).taches[0];
    expect(detail).toMatchObject({ detenteur: "worker@h#1-abc", message: "Error: secret de connexion" });
  });
});
