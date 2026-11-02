import { describe, expect, it } from "vitest";
import { choisirEnveloppe, etatBCDevis, natureDeLaCommande, refusTransitionBC, phraseProvenance, phraseTaxes, sansRedite, type EnveloppeCandidate } from "./bc-devis";

/** CE QUE LA CARTE DU BC DIT (lot B1, décision 0049) : l'enveloppe selon la nature, les taxes une fois, sans redite. */
const env = (o: Partial<EnveloppeCandidate> & { name: string }): EnveloppeCandidate =>
  ({ id: o.name, modules: [], domaine: "GENERAL", isActive: true, periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-12-31T23:59:59Z", ...o });
const AUJ = new Date("2026-11-02T10:00:00Z");

describe("la carte du BC depuis un devis", () => {
  it("du matériel promotionnel va à l'enveloppe promo/marketing — jamais à Regulatory, même plus récente", () => {
    const nature = natureDeLaCommande(["Conception ADV", "Fiche posologique A5", "Banner roll-up 85 × 200 cm", "Stylo bille métal gravé"]);
    expect(nature).toBe("PROMO_MATERIAL");
    const envs = [
      env({ name: "Budget Regulatory 2026", domaine: "REGULATORY", modules: ["REGULATORY"], periodStart: "2026-10-01T00:00:00Z" }),
      env({ name: "Budget Marketing 2026", domaine: "MARKETING", modules: ["PROMO_MATERIAL", "EVENTS"] }),
    ];
    expect(choisirEnveloppe(envs, nature, null, AUJ)?.enveloppe.name).toBe("Budget Marketing 2026");
    // Seule une enveloppe Regulatory : on ne propose RIEN plutôt que la mauvaise.
    expect(choisirEnveloppe([envs[0]], nature, null, AUJ)).toBeNull();
    // La personne peut changer.
    expect(choisirEnveloppe(envs, nature, "regulatory", AUJ)?.enveloppe.name).toBe("Budget Regulatory 2026");
  });

  it("un stand et des pauses-café sont un événement", () => {
    expect(natureDeLaCommande(["Surface nue 18 m²", "Pause-café matin", "Hôtesses d'accueil", "Montage du stand", "Congrès SAC"])).toBe("EVENTS");
  });

  it("les taxes recalculées se comparent UNE fois au papier ; concordantes, rien n'est dit", () => {
    const f = (n: number) => `${n}`;
    expect(phraseTaxes({ tva: 150_955, taxe: 15_890, ttc: 961_345 }, { tva: 150_955, taxe: 15_890, ttc: 961_345 }, f)).toBeNull();
    expect(phraseTaxes({ tva: 169_765, taxe: 17_870, ttc: 1_081_135 }, { tva: 150_955, taxe: 15_890, ttc: 961_345 }, f)).toMatch(/^Taxes : TVA 169765 recalculée, 150955 imprimée ; taxe/);
  });

  it("la provenance se dit une fois, et une redite disparaît", () => {
    expect(phraseProvenance("positions")).toBe("Lignes et montants lus sur le tableau du PDF, à vérifier contre le papier.");
    expect(sansRedite(["Contrôle des totaux : écart", "Contrôle des totaux : écart", null, "Contrôle des totaux : écart de 99 000 DZD"])).toEqual(["Contrôle des totaux : écart de 99 000 DZD"]);
  });
});


describe("le cycle du BC depuis un devis — préconditions tenues par le code", () => {
  it("CRÉER n'exige pas de validateur ; il refuse une lecture illisible et un fournisseur du groupe", () => {
    expect(refusTransitionBC("CREER", null, { lecture: "FIABLE", lignesChiffrees: true })).toBeNull();
    expect(refusTransitionBC("CREER", null, { lecture: "A_VERIFIER", lignesChiffrees: true, validateurId: null })).toBeNull();
    expect(refusTransitionBC("CREER", null, { lecture: "ILLISIBLE" })).toMatch(/Aucune ligne/);
    expect(refusTransitionBC("CREER", null, { lecture: "FIABLE", fournisseurDuGroupe: true })).toMatch(/société du groupe/);
  });
  it("ENVOYER exige un brouillon ET un validateur", () => {
    const brouillon = etatBCDevis({ annule: false, signe: false, demande: null });
    expect(brouillon).toBe("BROUILLON");
    expect(refusTransitionBC("ENVOYER_EN_VALIDATION", brouillon, {})).toMatch(/qui doit valider/);
    expect(refusTransitionBC("ENVOYER_EN_VALIDATION", brouillon, { validateurId: "u1" })).toBeNull();
    const enCours = etatBCDevis({ annule: false, signe: false, demande: { statut: "PENDING" } });
    expect(enCours).toBe("EN_VALIDATION");
    expect(refusTransitionBC("ENVOYER_EN_VALIDATION", enCours, { validateurId: "u1" })).toMatch(/déjà en validation/);
    expect(etatBCDevis({ annule: false, signe: false, demande: { statut: "APPROVED" } })).toBe("VALIDE");
    expect(etatBCDevis({ annule: false, signe: true, demande: { statut: "APPROVED" } })).toBe("SIGNE");
    expect(refusTransitionBC("ENVOYER_EN_VALIDATION", "ANNULE", { validateurId: "u1" })).toMatch(/annulé/);
  });
});
