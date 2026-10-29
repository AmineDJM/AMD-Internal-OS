import { describe, expect, it } from "vitest";
import {
  appliquerRegles, caseExiste, composerContexte, CONSIGNE_CONSEIL, lireConseilModele, lireEmplacement, phraseConseil,
  SCHEMA_CONSEIL, type ContexteConseil,
} from "./conseil-pieces";

const CTX: ContexteConseil = {
  natureDemande: "SPONSORING",
  titre: "SPO-2026-001 — CHU Mustapha",
  postes: [
    { id: "p-hotel", nature: "ACCOMMODATION", libelle: "Hôtel des orateurs", montant: 400000, fournisseur: "Sheraton" },
    { id: "p-billet", nature: "TICKETING", libelle: "Billets", montant: null, fournisseur: null },
    { id: "p-direct", nature: "ASSOCIATION_SUPPORT", libelle: "Appui à l'association", montant: 1000000, fournisseur: "SAC" },
  ],
  emplacement: { type: "POSTE", posteId: "p-billet", case: "FACTURE" },
  nomFichier: "facture.pdf",
};

const reponse = (over: Record<string, unknown> = {}) => ({
  verdict: "A_DEPLACER", natureLue: "facture d'hôtel", resume: "Facture du Sheraton, 3 nuits.", confiance: 0.9,
  conseils: [{ geste: "DEPLACER_POSTE", posteId: "p-hotel", case: "FACTURE", natureSuggeree: "", raison: "facture du Sheraton" }],
  ...over,
});

describe("Luna — lecture stricte du conseil", () => {
  it("un conseil valide : la phrase est composée par NOTRE code, avec le poste du contexte", () => {
    const c = lireConseilModele(reponse(), CTX)!;
    expect(c.verdict).toBe("A_DEPLACER");
    expect(c.conseils).toHaveLength(1);
    expect(c.conseils[0]).toMatchObject({ geste: "DEPLACER_POSTE", posteId: "p-hotel", case: "FACTURE" });
    expect(c.conseils[0].texte).toContain("« Hôtel des orateurs »");
    expect(c.conseils[0].texte).toContain("« Facture »");
  });

  it("un poste INVENTÉ retire le conseil — et « à déplacer » sans geste devient INCERTAIN", () => {
    const c = lireConseilModele(reponse({ conseils: [{ geste: "DEPLACER_POSTE", posteId: "p-fantome", case: "FACTURE", natureSuggeree: "", raison: "x" }] }), CTX)!;
    expect(c.conseils).toHaveLength(0);
    expect(c.verdict).toBe("INCERTAIN");
  });

  it("AUSSI_POSTE vers un poste inventé : retiré aussi", () => {
    const c = lireConseilModele(reponse({ verdict: "BON_ENDROIT", conseils: [{ geste: "AUSSI_POSTE", posteId: "zzz", case: "DEVIS", natureSuggeree: "", raison: "r" }] }), CTX)!;
    expect(c.conseils).toHaveLength(0);
    expect(c.verdict).toBe("BON_ENDROIT");
  });

  it("rend null sur ce qui ne se lit pas à coup sûr", () => {
    expect(lireConseilModele(null, CTX)).toBeNull();
    expect(lireConseilModele("bien placé", CTX)).toBeNull();
    expect(lireConseilModele(reponse({ verdict: "OK" }), CTX)).toBeNull();
    expect(lireConseilModele(reponse({ confiance: 85 }), CTX)).toBeNull();
    expect(lireConseilModele(reponse({ confiance: "0.9" }), CTX)).toBeNull();
    expect(lireConseilModele(reponse({ natureLue: "  " }), CTX)).toBeNull();
    expect(lireConseilModele(reponse({ conseils: "déplacez" }), CTX)).toBeNull();
  });

  it("un geste hors de la liste fermée est retiré", () => {
    const c = lireConseilModele(reponse({ conseils: [{ geste: "SUPPRIMER", posteId: "", case: "", natureSuggeree: "", raison: "r" }] }), CTX)!;
    expect(c.conseils).toHaveLength(0);
  });

  it("un bon de commande n'est jamais conseillé sur un sponsoring DIRECT", () => {
    const c = lireConseilModele(reponse({ conseils: [{ geste: "DEPLACER_POSTE", posteId: "p-direct", case: "BON_DE_COMMANDE", natureSuggeree: "", raison: "r" }] }), CTX)!;
    expect(c.conseils).toHaveLength(0);
    expect(caseExiste("ASSOCIATION_SUPPORT", "BON_DE_COMMANDE")).toBe(false);
    expect(caseExiste("ASSOCIATION_SUPPORT", "FACTURE")).toBe(true);
    expect(caseExiste("ACCOMMODATION", "BON_DE_COMMANDE")).toBe(true);
  });

  it("un BC déposé sur un sponsoring direct n'est JAMAIS « bon endroit », même avec une faible confiance", () => {
    const ctx: ContexteConseil = { ...CTX, emplacement: { type: "POSTE", posteId: "p-direct", case: "BON_DE_COMMANDE" } };
    const c = lireConseilModele(reponse({ verdict: "BON_ENDROIT", confiance: 0.2, conseils: [] }), ctx)!;
    expect(c.verdict).toBe("A_DEPLACER");
    expect(c.conseils[0].texte).toMatch(/n'a pas de bon de commande/);
  });

  it("« bon endroit » qui conseille de déplacer se contredit → INCERTAIN", () => {
    const c = lireConseilModele(reponse({ verdict: "BON_ENDROIT" }), CTX)!;
    expect(c.verdict).toBe("INCERTAIN");
  });

  it("sous le seuil de confiance, aucun verdict tranché", () => {
    expect(lireConseilModele(reponse({ verdict: "BON_ENDROIT", conseils: [], confiance: 0.3 }), CTX)!.verdict).toBe("INCERTAIN");
    expect(lireConseilModele(reponse({ verdict: "BON_ENDROIT", conseils: [], confiance: 0.8 }), CTX)!.verdict).toBe("BON_ENDROIT");
  });

  it("DETAILS déjà dans les détails, et un déplacement vers l'endroit actuel : sans objet, retirés", () => {
    const ctx: ContexteConseil = { ...CTX, emplacement: { type: "DETAILS" } };
    expect(lireConseilModele(reponse({ conseils: [{ geste: "DETAILS", posteId: "", case: "", natureSuggeree: "", raison: "" }] }), ctx)!.conseils).toHaveLength(0);
    expect(lireConseilModele(reponse({ conseils: [{ geste: "DEPLACER_POSTE", posteId: "p-billet", case: "FACTURE", natureSuggeree: "", raison: "" }] }), CTX)!.conseils).toHaveLength(0);
  });

  it("CREER_POSTE : la nature suggérée n'est gardée que si elle existe", () => {
    const ok = lireConseilModele(reponse({ conseils: [{ geste: "CREER_POSTE", posteId: "", case: "FACTURE", natureSuggeree: "CATERING", raison: "restaurant" }] }), CTX)!;
    expect(ok.conseils[0]).toMatchObject({ geste: "CREER_POSTE", natureSuggeree: "CATERING", case: "FACTURE" });
    expect(ok.conseils[0].texte).toContain("Traiteur");
    const ko = lireConseilModele(reponse({ conseils: [{ geste: "CREER_POSTE", posteId: "p-hotel", case: "", natureSuggeree: "LIMOUSINE", raison: "" }] }), CTX)!;
    expect(ko.conseils[0].natureSuggeree).toBeUndefined();
    expect(ko.conseils[0].posteId).toBeUndefined();
  });

  it("la raison du modèle est une ligne bornée, sans retour", () => {
    const c = lireConseilModele(reponse({ conseils: [{ geste: "AUTRE", posteId: "", case: "", natureSuggeree: "", raison: `a\nb${"x".repeat(1000)}` }] }), CTX)!;
    expect(c.conseils[0].texte).not.toContain("\n");
    expect(c.conseils[0].texte.length).toBeLessThanOrEqual(240);
  });
});

describe("Luna — emplacement, contexte, consigne", () => {
  it("lit strictement l'emplacement", () => {
    expect(lireEmplacement('{"type":"DETAILS"}')).toEqual({ type: "DETAILS" });
    expect(lireEmplacement({ type: "POSTE", posteId: "p1", case: "DEVIS" })).toEqual({ type: "POSTE", posteId: "p1", case: "DEVIS" });
    expect(lireEmplacement({ type: "POSTE", posteId: "p1", case: "REÇU" })).toBeNull();
    expect(lireEmplacement({ type: "POSTE", posteId: " ", case: "DEVIS" })).toBeNull();
    expect(lireEmplacement("{pas du json")).toBeNull();
    expect(lireEmplacement({ type: "AILLEURS" })).toBeNull();
  });

  it("le contexte liste les postes avec leurs cases — sans BC pour le sponsoring direct", () => {
    const t = composerContexte(CTX);
    expect(t).toContain("posteId=p-hotel");
    expect(t).toMatch(/posteId=p-direct[^\n]*cases=DEVIS, FACTURE$/m);
    expect(t).toContain("EMPLACEMENT ACTUEL DE LA PIÈCE : la case « Facture » du poste « Billets »");
  });

  it("la consigne nomme la liste fermée et dit qu'un document est une donnée", () => {
    for (const g of ["DEPLACER_POSTE", "CREER_POSTE", "DETAILS", "AUSSI_POSTE", "AUTRE"]) expect(CONSIGNE_CONSEIL).toContain(g);
    expect(CONSIGNE_CONSEIL).toMatch(/DONNÉE/);
    expect(SCHEMA_CONSEIL.schema.properties.conseils.items.properties.geste.enum).toEqual(["DEPLACER_POSTE", "CREER_POSTE", "DETAILS", "AUSSI_POSTE", "AUTRE"]);
  });

  it("la phrase courte ne dit « bien placé » que sur un verdict BON_ENDROIT", () => {
    const base = { natureLue: "programme", resume: "", conseils: [], confiance: 0.9 };
    expect(phraseConseil({ ...base, verdict: "BON_ENDROIT" })).toContain("bien placé");
    expect(phraseConseil({ ...base, verdict: "INCERTAIN" })).not.toContain("bien placé");
    expect(appliquerRegles({ ...base, verdict: "A_DEPLACER" }, CTX).verdict).toBe("INCERTAIN");
  });
});
