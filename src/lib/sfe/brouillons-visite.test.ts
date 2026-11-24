import { describe, expect, it } from "vitest";
import {
  aEnvoyer, apresEnvoi, champsDuFormulaire, CLE_BROUILLONS_VISITE, lireBrouillons, nouveauBrouillon, phraseAttente, rangerBrouillon,
} from "./brouillons-visite";
import { cleParPersonne } from "@/lib/vue-exacte-ui";
import { estModuleVisite, MODULE_AUDIT_VISITE, MODULES_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * LE RAPPORT DE VISITE SANS RÉSEAU (11/2026) — la file locale : ce qui part, ce qui attend, ce que le serveur refuse,
 * et ce qu'on ne renvoie pas d'office (une visite hors plan peut-être déjà créée).
 */

const b = (id: string, sorte: "RAPPORT" | "HORS_PLAN", visitId: string | null, maintenant = 1) =>
  nouveauBrouillon({ id, sorte, visitId, doctorId: "d1", praticien: "Dr Achour", champs: [["report", "Vu"]], maintenant });

describe("la file des rapports en attente", () => {
  it("un rapport réenregistré hors ligne REMPLACE le précédent ; une visite hors plan est un brouillon à elle", () => {
    let l = rangerBrouillon([], b("1", "RAPPORT", "v1"));
    l = rangerBrouillon(l, b("2", "RAPPORT", "v1"));
    expect(l.map((x) => x.id)).toEqual(["2"]);
    l = rangerBrouillon(l, b("3", "HORS_PLAN", null));
    l = rangerBrouillon(l, b("4", "HORS_PLAN", null));
    expect(l.map((x) => x.id)).toEqual(["2", "3", "4"]);
  });

  it("accepté → il part ; refusé → il reste, avec le motif du serveur (48 h dépassées), et ne repart plus seul", () => {
    expect(apresEnvoi(b("1", "RAPPORT", "v1"), { kind: "OK" }, true)).toBeNull();
    const refuse = apresEnvoi(b("1", "RAPPORT", "v1"), { kind: "REFUS", erreur: "Le rapport d'une visite se fait dans les 48 h…" }, true)!;
    expect(refuse).toMatchObject({ etat: "REFUSE", tentatives: 1, erreur: "Le rapport d'une visite se fait dans les 48 h…" });
    expect(aEnvoyer([refuse])).toEqual([]);
  });

  it("réseau coupé : un rapport attend le retour ; une visite hors plan partie « en ligne » est à VÉRIFIER", () => {
    expect(apresEnvoi(b("1", "RAPPORT", "v1"), { kind: "RESEAU" }, true)).toMatchObject({ etat: "EN_ATTENTE", tentatives: 1 });
    expect(apresEnvoi(b("2", "HORS_PLAN", null), { kind: "RESEAU" }, false)).toMatchObject({ etat: "EN_ATTENTE" });
    const douteux = apresEnvoi(b("3", "HORS_PLAN", null), { kind: "RESEAU" }, true)!;
    expect(douteux.etat).toBe("A_VERIFIER");
    expect(douteux.erreur).toMatch(/Vérifiez « Mes dernières visites »/);
    expect(aEnvoyer([douteux])).toEqual([]);
  });

  it("le plus ancien part d'abord, et l'indicateur dit combien attendent", () => {
    const l = [b("b", "RAPPORT", "v2", 20), b("a", "RAPPORT", "v1", 10), { ...b("c", "HORS_PLAN", null, 5), etat: "REFUSE" as const }];
    expect(aEnvoyer(l).map((x) => x.id)).toEqual(["a", "b"]);
    expect(phraseAttente(l)).toBe("2 rapports en attente d'envoi");
    expect(phraseAttente(l.slice(0, 1))).toBe("1 rapport en attente d'envoi");
    expect(phraseAttente([])).toBeNull();
  });

  it("la relecture du stockage ignore ce qui ne se lit pas, sans casser l'écran", () => {
    const ok = b("1", "RAPPORT", "v1");
    expect(lireBrouillons(JSON.stringify([ok, { id: 3 }, null, { ...ok, id: "x", sorte: "AUTRE" }]))).toEqual([ok]);
    expect(lireBrouillons("{pas du json")).toEqual([]);
    expect(lireBrouillons(null)).toEqual([]);
  });

  it("seuls les champs texte du formulaire sont gardés", () => {
    expect(champsDuFormulaire([["report", "Vu"], ["fichier", { taille: 3 }], ["productId", "p1"], ["productId", "p2"]]))
      .toEqual([["report", "Vu"], ["productId", "p1"], ["productId", "p2"]]);
  });

  it("le stockage est RANGÉ PAR PERSONNE : deux délégués sur un téléphone ne s'envoient pas leurs rapports", () => {
    expect(cleParPersonne(CLE_BROUILLONS_VISITE, "leila")).not.toBe(cleParPersonne(CLE_BROUILLONS_VISITE, "amine"));
  });
});

describe("le nom du module, d'aujourd'hui et d'hier", () => {
  it("« Visite médicale » est le nom ; « Promotion médicale » reste lu dans l'historique", () => {
    expect(MODULE_AUDIT_VISITE).toBe("Visite médicale");
    expect(MODULES_AUDIT_VISITE).toEqual(["Visite médicale", "Promotion médicale"]);
    expect(estModuleVisite("Promotion médicale")).toBe(true);
    expect(estModuleVisite("Visite médicale")).toBe(true);
    expect(estModuleVisite("Ad & Pro")).toBe(false);
    expect(estModuleVisite(null)).toBe(false);
  });
});
