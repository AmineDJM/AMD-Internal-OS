import { describe, expect, it } from "vitest";
import { lireContenuMail, rendreMailHtml, rendreMailTexte, type CharteMail, type SignatureMail } from "./domaine/mails/gabarit";

/**
 * AUDIT AU2 (03/11/2026) — LES CONSTATS QUE CE TEST PROUVE, tels qu'ils sont aujourd'hui.
 * Rapport : docs/assistant/audit-2026-11-03/au2-primitives.md (constat C1). Ce test DÉCRIT un défaut : il devra être
 * retourné (ou retiré) par l'étape de migration qui rend la mise en page à la demande (étape M3 du rapport).
 *
 * C1 — la forme d'un mail ne dépend pas de la demande. Le contrat que le modèle remplit (`ContenuMail`) n'a AUCUN mot
 * pour « simple », « charte », « seulement le tableau » : la boîte choisit le rendu (`infra/mails/boites.ts`,
 * Gmail d'Adam / Microsoft → `rendreMailHtml` avec bandeau et signature aux couleurs ; SMTP / ERP → `rendreMailTexte`,
 * où le tableau demandé devient des puces).
 */
const signature: SignatureMail = { nom: "Amine HADDAD", fonction: "PDG", societe: "Adventum Pharma", telephone: null, email: null };
const charte: CharteMail = { societe: "Adventum Pharma", accent: "087084", texteSurAccent: "FFFFFF", police: "Calibri", coordonnees: [], mentions: [] };

describe("AU2 — C1 : le gabarit du mail ignore la forme demandée", () => {
  // « juste le planning en tableau aux couleurs, le reste en texte simple » : tout ce que le contrat sait porter.
  const demandeSimple = {
    salutation: "Bonjour Nadir,", paragraphes: ["Voici le planning de la semaine."], cloture: "Bien cordialement,",
    tableau: { colonnes: ["Jour", "Activité"], lignes: [["Lundi", "Réunion d'équipe"], ["Mardi", "Visite CHU Oran"]] },
    // Ce que le modèle voudrait dire — le contrat le jette sans le dire.
    style: "texte simple sauf le tableau", charte: false, bandeau: false,
  };

  it("le contrat lu n'a aucun champ de forme : « style », « charte », « bandeau » disparaissent en silence", () => {
    const lu = lireContenuMail(demandeSimple);
    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(Object.keys(lu.contenu).sort()).toEqual(["cloture", "paragraphes", "salutation", "tableau"]);
  });

  it("par une boîte HTML, le bandeau et la signature colorés partent toujours, quelle que soit la demande", () => {
    const lu = lireContenuMail(demandeSimple);
    if (!lu.ok) throw new Error("contenu refusé");
    const html = rendreMailHtml(lu.contenu, signature, charte, "Planning");
    expect(html).toContain('<td style="background:#087084;padding:18px 28px;">'); // le bandeau
    expect(html).toContain('border-top:2px solid #087084'); // la signature soulignée aux couleurs
    expect((html.match(/<p style=/g) ?? []).length).toBeGreaterThanOrEqual(3); // chaque paragraphe stylé
  });

  it("par une boîte texte (SMTP, envoi de l'ERP), le tableau demandé « aux couleurs » devient des puces", () => {
    const lu = lireContenuMail(demandeSimple);
    if (!lu.ok) throw new Error("contenu refusé");
    const texte = rendreMailTexte(lu.contenu, signature, charte);
    expect(texte).not.toMatch(/<table/);
    expect(texte).toContain("• Lundi — Activité : Réunion d'équipe");
  });
});
