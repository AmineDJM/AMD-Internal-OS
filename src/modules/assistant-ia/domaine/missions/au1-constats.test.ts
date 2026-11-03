import { describe, expect, it } from "vitest";
import { diagnostiquerMission, noteActionsNonVerifiees } from "./pilotage";

/**
 * AU1 (audit du 03/11/2026, `docs/assistant/audit-2026-11-03/au1-verite.md`) — deux CONSTATS épinglés, purs.
 * Ces tests décrivent le comportement ACTUEL, défectueux : ils s'inversent à l'étape de migration qui le corrige
 * (étapes 2 et 3 du rapport). Ils ne sont pas une spécification à préserver.
 */
const T0 = Date.parse("2026-11-03T12:00:00.000Z");
const vivant = { dernierPassage: new Date(T0 - 30_000).toISOString(), workerVu: null };
const etapes = [{ titre: "Lire les données", etat: "FILE", erreur: null }, { titre: "Rédiger la synthèse", etat: "FILE", erreur: null }];

describe("AU1 — constats", () => {
  it("C2 : une mission immobile depuis 2 h est annoncée « dans moins d'une minute » (l'âge de la mission n'est pas lu)", () => {
    const deuxHeures = { etat: "EN_COURS", attente: null, etapes, majLe: new Date(T0 - 2 * 3600_000).toISOString() };
    const d = diagnostiquerMission(deuxHeures, vivant, T0);
    // Le seul signal lu est le battement GLOBAL du balayage : 0/2 depuis 2 h et « prête » quand même.
    expect(d.phrase).toContain("moins d'une minute");
  });

  it("C6 : la garde de vérité, lexicale, reprend une autocorrection honnête et dit « aucune lecture » après une lecture réelle", () => {
    // Réponse réelle du rejeu S2.2 (vrai modèle), après un appel RÉUSSI à `mes_missions`.
    const reponse = "Non, je ne peux pas vous le garantir. J’ai repris un délai affiché par le système comme une certitude.";
    const note = noteActionsNonVerifiees(reponse, ["mes_missions"], false);
    expect(note?.familles).toEqual(["mission"]);
    expect(note?.texte).toMatch(/aucune action ni lecture/);
  });
});
