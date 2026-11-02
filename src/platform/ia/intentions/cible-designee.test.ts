import { describe, expect, it } from "vitest";
import { demandeNomme, estDeictique, motsDistinctifs, verdictCible, type Candidat } from "./cible-designee";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CORRIGE ÇA » NE DOIT PAS DEVENIR « ANNULE CELUI-LÀ ».
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Banc des intentions courtes : après une liste de documents Legal, « Corrige ça. » rendait
 * « Je propose : ANNULER le document légal "Devis n° DEV-2026-0038 — CHU de Tizi Ouzou".
 * Confirmez-vous ? » Une cible choisie sans raison, et un verbe transformé — « corrige »
 * devenu « annule ». La carte de confirmation empêchait le pire ; un clic réflexe ne
 * l'aurait pas fait.
 *
 * ── CE QUE CES TESTS TIENNENT, ET LE SECOND COMPTE AUTANT QUE LE PREMIER ────────────────
 *
 *   1. la cible devinée est refusée, et la question NOMME les candidats ;
 *   2. TOUT LE RESTE PASSE. Une porte qui refuserait « Annule DEV-2026-0455 » sous prétexte
 *      que la phrase contient « ce » rendrait Adam inutilisable — et la première chose qu'on
 *      ferait serait de la désactiver. Le refus doit être RARE et JUSTE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const DOCS: Candidat[] = [
  { label: "Devis n° DEV-2026-0455 — Imprimerie El Djazaïr (étiquetage Nivolex)", href: "/legal/1" },
  { label: "Bon de commande n° BC-2026-0231 — Imprimerie El Djazaïr", href: "/legal/2" },
  { label: "Facture n° 2026-0891 — Imprimerie El Djazaïr", href: "/legal/3" },
  { label: "Accord de confidentialité — Julphar", href: "/legal/4" },
];

describe("une cible devinée est refusée, et la question nomme les candidats", () => {
  it("LE CAS MESURÉ : « Corrige ça » sur quatre documents ne propose rien", () => {
    const v = verdictCible("Corrige ça.", "Annuler le document légal Devis n° DEV-2026-0455", DOCS);
    expect(v.designee).toBe(false);
    if (v.designee) return;
    // La question doit être UTILISABLE : les candidats y sont, nommés.
    expect(v.candidats).toHaveLength(4);
    expect(v.question).toContain("DEV-2026-0455");
    expect(v.question).toContain("Julphar");
    expect(v.question).toContain("Corrige ça");
    // Et elle doit dire que RIEN n'a bougé — sans quoi la personne se demande ce qui a été fait.
    expect(v.question).toMatch(/rien modifi/i);
  });

  it("la liste des candidats est bornée, et le reste est COMPTÉ, pas caché", () => {
    const beaucoup: Candidat[] = Array.from({ length: 11 }, (_, i) => ({ label: `Pièce Alpha${i}`, href: `/x/${i}` }));
    const v = verdictCible("Supprime ça", "Supprimer la pièce Alpha3", beaucoup, 4);
    expect(v.designee).toBe(false);
    if (v.designee) return;
    expect(v.candidats).toHaveLength(4);
    expect(v.question).toContain("j'en ai 11");
    expect(v.question).toContain("7 autre(s)");
  });
});

describe("LE TEST QUI COMPTE : le travail normal n'est jamais bloqué", () => {
  it.each([
    ["une référence explicite tranche", "Annule le devis DEV-2026-0455", "Annuler le document légal Devis n° DEV-2026-0455 — Imprimerie El Djazaïr"],
    ["un mot distinctif suffit", "Corrige ce document Julphar", "Annuler l'accord de confidentialité — Julphar"],
    ["une demande sans déictique", "Annule le bon de commande BC-2026-0231", "Annuler le bon de commande n° BC-2026-0231"],
    ["« ce » suivi de la référence", "Mets ce dossier BC-2026-0231 à jour", "Modifier le bon de commande n° BC-2026-0231"],
  ])("%s", (_nom, demande, cible) => {
    expect(verdictCible(demande, cible, DOCS).designee, `« ${demande} » refusée à tort`).toBe(true);
  });

  it("EXACTEMENT UN candidat = désigné ; zéro = on demande", () => {
    // « Corrige ça » après UN document affiché est parfaitement clair : refuser ferait perdre
    // un tour pour rien, ce qui est le défaut inverse de celui qu'on corrige.
    expect(verdictCible("Corrige ça.", "Modifier le devis", [DOCS[0]!]).designee).toBe(true);

    /**
     * ZÉRO CANDIDAT NE VEUT PAS DIRE « UNE SEULE CIBLE POSSIBLE » — et cette ligne a changé de
     * sens après une mesure. La première version rendait `true` ici (« moins de deux, donc pas
     * d'ambiguïté »). L'A/B avec témoin, quatre passages de chaque côté, a montré que les
     * échecs restants portaient TOUS la mention « 0 candidat » alors qu'Adam proposait
     * d'annuler un devis précis : la liste avait été montrée en BLOCS, hors du texte relu.
     * Le compte à zéro signifiait « le code n'a rien vu », pas « il n'y a qu'une pièce ».
     */
    expect(verdictCible("Corrige ça.", "Modifier le devis", []).designee).toBe(false);
  });

  it("deux candidats portant le MÊME lien ne font qu'une cible", () => {
    // La même pièce lue deux fois dans le tour (deux outils, un document) n'est pas une ambiguïté.
    const doublon: Candidat[] = [{ label: "Devis A", href: "/legal/1" }, { label: "Devis A", href: "/legal/1" }];
    expect(verdictCible("Annule ça", "Annuler le devis A", doublon).designee).toBe(true);
  });

  it("les mots de CATÉGORIE n'identifient rien — c'est ce qui rend l'ambiguïté détectable", () => {
    // « Corrige ce devis » quand il y a trois devis ne désigne pas : « devis » est la catégorie.
    expect(motsDistinctifs("Devis n° DEV-2026-0455 — Imprimerie El Djazaïr")).not.toContain("devis");
    expect(motsDistinctifs("Devis n° DEV-2026-0455 — Imprimerie El Djazaïr")).toContain("imprimerie");
    expect(verdictCible("Corrige ce devis", "Annuler le devis n° DEV-2026-0455", DOCS).designee).toBe(false);
  });

  it("les briques nues font ce qu'elles disent", () => {
    expect(estDeictique("Corrige ça")).toBe(true);
    expect(estDeictique("Occupe-toi de ce dossier")).toBe(true);
    expect(estDeictique("Annule le devis DEV-2026-0455")).toBe(false);
    expect(demandeNomme("annule julphar", "Accord de confidentialité — Julphar")).toBe(true);
    expect(demandeNomme("annule le devis", "Accord de confidentialité — Julphar")).toBe(false);
  });

  it("mesure consignée — cibles devinées refusées, travail normal préservé", () => {
    /**
     * Deux jeux OPPOSÉS, et le score n'a de sens que si les deux sont bons : une porte qui
     * refuse tout obtiendrait 5/5 sur le premier et 0/6 sur le second.
     */
    const aRefuser: [string, string][] = [
      ["Corrige ça.", "Annuler le devis n° DEV-2026-0455"],
      ["Supprime ce document", "Supprimer la facture n° 2026-0891"],
      ["Occupe-toi de ça", "Modifier le bon de commande"],
      ["Change cette pièce", "Modifier le devis"],
      ["Annule ceci", "Annuler l'accord de confidentialité"],
    ];
    const aPasser: [string, string][] = [
      ["Annule le devis DEV-2026-0455", "Annuler le devis n° DEV-2026-0455 — Imprimerie El Djazaïr"],
      ["Corrige le document Julphar", "Modifier l'accord de confidentialité — Julphar"],
      ["Supprime la facture 2026-0891", "Supprimer la facture n° 2026-0891"],
      ["Mets à jour BC-2026-0231", "Modifier le bon de commande n° BC-2026-0231"],
      ["Crée une tâche pour Raihana", "Créer une tâche — Raihana Cherif"],
      ["Corrige ce devis DEV-2026-0455", "Modifier le devis n° DEV-2026-0455"],
    ];
    const refuses = aRefuser.filter(([d, c]) => !verdictCible(d, c, DOCS).designee).length;
    const passes = aPasser.filter(([d, c]) => verdictCible(d, c, DOCS).designee).length;

    consignerMesure("cible_ambigue_rend_des_candidats", { n: aRefuser.length + aPasser.length, ok: refuses + passes },
      "lib/assistant/cible-designee.test.ts",
      "écritures jugées correctement sur la désignation de leur cible — refus quand le PDG n'a nommé personne et que plusieurs candidats existent, passage dès qu'il a désigné");

    expect(aRefuser.filter(([d, c]) => verdictCible(d, c, DOCS).designee).map(([d]) => d),
      "ces cibles devinées sont passées").toEqual([]);
    expect(aPasser.filter(([d, c]) => !verdictCible(d, c, DOCS).designee).map(([d]) => d),
      "ces demandes légitimes ont été bloquées").toEqual([]);
  });
});
