import { describe, expect, it } from "vitest";
import { gesteVisaPoste, memePrestataire, type EtatBcPoste } from "./bc-poste";

/**
 * LE VISA D'UN BC DE POSTE NE COUVRE QUE CE QU'IL A VU (§118.187) — chaque branche avec son cas,
 * et chaque « RIEN » avec le cas qui le distingue d'un « ROUVRIR ».
 */

const SEUIL = 500_000;
const vise = (over: Partial<EtatBcPoste> = {}): EtatBcPoste => ({
  etape: "DIRECTION_OK", viseParLeCentre: true, montantVise: 600_000, fournisseurVise: "Imprimerie Alpha",
  montantAvant: 600_000, fournisseurAvant: "Imprimerie Alpha", ...over,
});

describe("gesteVisaPoste — ce que le centre a vu, et rien de plus", () => {
  it("VISÉ, montant RELEVÉ au-delà de l'empreinte → le visa rouvre, et le motif dit de combien", () => {
    const g = gesteVisaPoste(vise(), { montant: 900_000, fournisseur: "Imprimerie Alpha" }, SEUIL);
    expect(g.geste).toBe("ROUVRIR");
    expect(g.geste === "ROUVRIR" ? g.motif : "").toMatch(/Montant relevé de 600\s000 DZD à 900\s000 DZD/);
  });

  it("VISÉ, montant BAISSÉ → rien : c'est un geste qui réduit", () => {
    expect(gesteVisaPoste(vise(), { montant: 550_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste).toBe("RIEN");
  });

  it("VISÉ, montant inchangé, PRESTATAIRE changé → le visa rouvre : c'est à lui que l'argent part", () => {
    const g = gesteVisaPoste(vise(), { montant: 600_000, fournisseur: "Imprimerie Beta" }, SEUIL);
    expect(g.geste).toBe("ROUVRIR");
    expect(g.geste === "ROUVRIR" ? g.motif : "").toMatch(/« Imprimerie Alpha » → « Imprimerie Beta »/);
  });

  it("un prestataire d'abord VIDE qu'on renseigne change le bénéficiaire → il rouvre", () => {
    const g = gesteVisaPoste(vise({ fournisseurVise: null, fournisseurAvant: null }), { montant: 600_000, fournisseur: "Imprimerie Beta" }, SEUIL);
    expect(g.geste).toBe("ROUVRIR");
    expect(g.geste === "ROUVRIR" ? g.motif : "").toMatch(/le bénéficiaire de l'opération → « Imprimerie Beta »/);
  });

  it("la même chose écrite autrement n'est pas un autre prestataire (casse, accents, espaces)", () => {
    expect(memePrestataire("Imprimerie  ÉLITE", "imprimerie elite")).toBe(true);
    expect(gesteVisaPoste(vise({ fournisseurVise: "Imprimerie ÉLITE" }), { montant: 600_000, fournisseur: " imprimerie  elite " }, SEUIL).geste).toBe("RIEN");
  });

  it("l'EMPREINTE fait foi, pas la valeur d'avant : un relèvement en deux fois rouvre au second pas", () => {
    // Empreinte 600 000 ; une baisse à 550 000 a été acceptée ; remonter à 580 000 ne dépasse pas ce que le centre a vu.
    expect(gesteVisaPoste(vise({ montantAvant: 550_000 }), { montant: 580_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste).toBe("RIEN");
    expect(gesteVisaPoste(vise({ montantAvant: 550_000 }), { montant: 610_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste).toBe("ROUVRIR");
  });

  it("l'EMPREINTE fait foi pour le PRESTATAIRE aussi : revenir à celui que le centre a vu ne rouvre rien", () => {
    // Le prestataire a bougé par un chemin non surveillé (une correction en base) : la valeur d'AVANT est
    // « Beta », l'empreinte « Alpha ». Revenir à Alpha, c'est revenir à ce qui a été visé.
    const derive = vise({ fournisseurAvant: "Imprimerie Beta" });
    expect(gesteVisaPoste(derive, { montant: 600_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste).toBe("RIEN");
    expect(gesteVisaPoste(derive, { montant: 600_000, fournisseur: "Imprimerie Beta" }, SEUIL).geste, "Beta n'a jamais été visé").toBe("ROUVRIR");
  });

  it("une empreinte ABSENTE (visa d'avant la règle) se lit sur la valeur d'avant la modification", () => {
    const ancien = vise({ montantVise: null, fournisseurVise: null });
    expect(gesteVisaPoste(ancien, { montant: 650_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste).toBe("ROUVRIR");
    expect(gesteVisaPoste(ancien, { montant: 600_000, fournisseur: "Imprimerie Alpha" }, SEUIL).geste, "à l'émission, rien n'a changé : rien n'est refusé").toBe("RIEN");
  });

  it("passé SOUS LE SEUIL puis porté AU-DESSUS → il rouvre : aucun centre ne l'avait vu", () => {
    const sous = vise({ viseParLeCentre: false, montantVise: 400_000, montantAvant: 400_000 });
    const g = gesteVisaPoste(sous, { montant: 700_000, fournisseur: "Imprimerie Alpha" }, SEUIL);
    expect(g.geste).toBe("ROUVRIR");
    expect(g.geste === "ROUVRIR" ? g.motif : "").toMatch(/au-dessus du seuil de validation des bons de commande \(500\s000 DZD\)/);
  });

  it("passé sous le seuil et toujours sous le seuil → rien, même si le prestataire change : aucun centre n'a à le voir", () => {
    const sous = vise({ viseParLeCentre: false, montantVise: 400_000, montantAvant: 400_000 });
    expect(gesteVisaPoste(sous, { montant: 450_000, fournisseur: "Imprimerie Beta" }, SEUIL).geste).toBe("RIEN");
  });

  it("VISÉ puis relevé mais désormais SOUS le seuil (seuil relevé entre-temps) → rien", () => {
    expect(gesteVisaPoste(vise(), { montant: 700_000, fournisseur: "Imprimerie Alpha" }, 800_000).geste).toBe("RIEN");
  });

  it("EN ATTENTE au centre et passé SOUS le seuil → la validation n'a plus d'objet", () => {
    const g = gesteVisaPoste(vise({ etape: "REQUESTED", viseParLeCentre: false }), { montant: 300_000, fournisseur: "Imprimerie Alpha" }, SEUIL);
    expect(g.geste).toBe("SOUS_LE_SEUIL");
  });

  it("EN ATTENTE au centre, montant changé mais toujours au-dessus → rien : le centre lit le poste en direct", () => {
    expect(gesteVisaPoste(vise({ etape: "REQUESTED", viseParLeCentre: false }), { montant: 900_000, fournisseur: "Imprimerie Beta" }, SEUIL).geste).toBe("RIEN");
  });

  it("aucun seuil fixé : tout BC exige un centre — un BC en attente ne passe jamais sous le seuil", () => {
    expect(gesteVisaPoste(vise({ etape: "REQUESTED", viseParLeCentre: false }), { montant: 10, fournisseur: null }, 0).geste).toBe("RIEN");
    expect(gesteVisaPoste(vise(), { montant: 900_000, fournisseur: "Imprimerie Alpha" }, 0).geste).toBe("ROUVRIR");
  });

  it("REFUSÉ, émis ou jamais demandé → rien : un refus ne se contourne pas en retouchant le montant", () => {
    for (const etape of ["REFUSED", "ISSUED", "NONE"] as const) {
      expect(gesteVisaPoste(vise({ etape }), { montant: 9_000_000, fournisseur: "Autre" }, SEUIL).geste, etape).toBe("RIEN");
    }
  });
});
