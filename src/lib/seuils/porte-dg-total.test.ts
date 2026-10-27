import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { etatPorteDg, porteDgOuverte, phrasePorteDg, refusPorteDg, type DecisionDg } from "@/lib/seuils/porte-dg-total";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DU DG SUR LE TOTAL D'UNE DEMANDE Ad & Pro — la règle PURE (Direction, 27/10/2026).
 *
 * « Le seuil, ce n'est pas 1 million par poste : c'est pour toute la demande, la somme des postes. »
 * Chaque cas nomme ce qui ferait tomber la règle (§118.17) : un seuil lu « à partir de » au lieu de
 * « au-dessus de », une validation qui couvrirait une rallonge, un renvoi qui survivrait à la
 * correction des postes. Le banc en base (`ad-pro/porte-dg-flow.test.ts`) tient le reste : le total
 * calculé sur les vrais postes, et les actions qui refusent porte fermée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SEUIL = 1_000_000;
const valide = (montant: number): DecisionDg => ({ statut: "VALIDEE", montant });
const aRevoir = (montant: number): DecisionDg => ({ statut: "A_REVOIR", montant });
// Les montants s'écrivent à la française (espace fine insécable) : le juge formate comme la règle.
const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

describe("la porte du DG sur le total d'une demande — l'état", () => {
  it("SANS SEUIL (absent, nul ou négatif) : aucune porte, quel que soit le total", () => {
    for (const seuil of [null, undefined, 0, -5]) {
      expect(etatPorteDg(50_000_000, seuil, null), String(seuil)).toBe("NON_REQUISE");
    }
  });

  it("« au-dessus du seuil » se lit STRICTEMENT : le total ÉGAL au seuil n'ouvre pas la porte", () => {
    expect(etatPorteDg(SEUIL, SEUIL, null)).toBe("NON_REQUISE");
    expect(etatPorteDg(SEUIL - 1, SEUIL, null)).toBe("NON_REQUISE");
    expect(etatPorteDg(SEUIL + 1, SEUIL, null)).toBe("EN_ATTENTE");
    // Aucun poste (ou que des refusés) : un total nul n'attend personne.
    expect(etatPorteDg(0, SEUIL, null)).toBe("NON_REQUISE");
  });

  it("VALIDÉE : le DG couvre le total qu'il a validé — et toute BAISSE ensuite", () => {
    expect(etatPorteDg(1_200_000, SEUIL, valide(1_200_000))).toBe("VALIDEE");
    expect(etatPorteDg(1_100_000, SEUIL, valide(1_200_000)), "une baisse reste couverte").toBe("VALIDEE");
    // Repassé sous le seuil, la porte n'est plus requise — la décision ne la « garde » pas ouverte pour rien.
    expect(etatPorteDg(900_000, SEUIL, valide(1_200_000))).toBe("NON_REQUISE");
  });

  it("UNE RALLONGE ROUVRE LA PORTE (décision #25) : un total au-delà de ce que le DG a validé l'attend de nouveau", () => {
    expect(etatPorteDg(1_200_001, SEUIL, valide(1_200_000))).toBe("EN_ATTENTE");
    expect(etatPorteDg(3_000_000, SEUIL, valide(1_200_000))).toBe("EN_ATTENTE");
  });

  it("RENVOYÉE EN RÉVISION : elle le reste pour CE total — dès que les postes changent, elle attend de nouveau le DG", () => {
    expect(etatPorteDg(1_500_000, SEUIL, aRevoir(1_500_000))).toBe("A_REVOIR");
    expect(etatPorteDg(1_400_000, SEUIL, aRevoir(1_500_000)), "corrigé à la baisse, encore au-dessus").toBe("EN_ATTENTE");
    expect(etatPorteDg(1_600_000, SEUIL, aRevoir(1_500_000))).toBe("EN_ATTENTE");
    expect(etatPorteDg(800_000, SEUIL, aRevoir(1_500_000)), "corrigé sous le seuil : plus de porte").toBe("NON_REQUISE");
  });

  it("ce que chaque état permet : seuls NON_REQUISE et VALIDEE laissent engager", () => {
    expect(porteDgOuverte("NON_REQUISE")).toBe(true);
    expect(porteDgOuverte("VALIDEE")).toBe(true);
    expect(porteDgOuverte("EN_ATTENTE")).toBe(false);
    expect(porteDgOuverte("A_REVOIR")).toBe(false);
  });
});

describe("la porte du DG — la phrase et le refus, les mêmes partout", () => {
  it("NON REQUISE : ni phrase ni refus", () => {
    expect(phrasePorteDg("NON_REQUISE", 500_000, SEUIL, null)).toBeNull();
    expect(refusPorteDg("NON_REQUISE", 500_000, SEUIL, null)).toBeNull();
  });

  it("EN ATTENTE : le total, le seuil, et ce qui est bloqué — dit par le refus de toute action qui engagerait", () => {
    const phrase = phrasePorteDg("EN_ATTENTE", 1_100_000, SEUIL, null);
    expect(phrase).toBe(`Total de ${dzd(1_100_000)} au-dessus du seuil de ${dzd(SEUIL)} : la validation du Directeur Général est requise avant tout bon de commande ou paiement.`);
    expect(refusPorteDg("EN_ATTENTE", 1_100_000, SEUIL, null)).toBe(`${phrase} Aucun bon de commande, engagement ni paiement n'est possible d'ici là.`);
  });

  it("UNE RALLONGE : la phrase dit le total validé qu'elle dépasse", () => {
    expect(phrasePorteDg("EN_ATTENTE", 1_300_000, SEUIL, valide(1_200_000)))
      .toBe(`Total porté à ${dzd(1_300_000)}, au-delà des ${dzd(1_200_000)} validés par le Directeur Général : sa validation est de nouveau requise (seuil ${dzd(SEUIL)}).`);
  });

  it("VALIDÉE : une phrase, aucun refus ; RENVOYÉE : une phrase ET un refus", () => {
    expect(phrasePorteDg("VALIDEE", 1_200_000, SEUIL, valide(1_200_000))).toBe(`Total de ${dzd(1_200_000)} validé par le Directeur Général (seuil ${dzd(SEUIL)}).`);
    expect(refusPorteDg("VALIDEE", 1_200_000, SEUIL, valide(1_200_000))).toBeNull();
    const renvoi = phrasePorteDg("A_REVOIR", 1_500_000, SEUIL, aRevoir(1_500_000));
    expect(renvoi).toBe(`Total de ${dzd(1_500_000)} renvoyé en révision par le Directeur Général (seuil ${dzd(SEUIL)}).`);
    expect(refusPorteDg("A_REVOIR", 1_500_000, SEUIL, aRevoir(1_500_000))).toBe(`${renvoi} Aucun bon de commande, engagement ni paiement n'est possible d'ici là.`);
  });

  it("CLIQUET — le module est PUR, sans aucun import : la carte des postes (composant client) le lit", () => {
    // Un import lourd ici casserait le build de production du navigateur (CLAUDE.md, frontière client / serveur).
    const src = readFileSync("src/lib/seuils/porte-dg-total.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
});
