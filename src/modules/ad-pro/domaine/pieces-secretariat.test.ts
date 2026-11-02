import { describe, expect, it } from "vitest";
import { lireSources } from "@/platform/source";
import {
  NATURES_PIECE_SECRETARIAT, PIECE_SECRETARIAT, peutDemanderPiece, titrePiece,
} from "./pieces-secretariat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENCHAÎNEMENT DEVIS → BON DE COMMANDE → FACTURE, et les deux façons de le rater.
 *
 * « On peut également demander un devis, pas que un BC ; après le devis on peut demander un BC,
 * après le BC une facture. » Une lecture trop stricte (« le devis est obligatoire ») et une
 * lecture trop lâche (« la facture se réclame quand on veut ») sont toutes deux défendables à la
 * lecture de la phrase : les deux cas sont donc ÉCRITS, dans les deux sens.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("Pièces commerciales du secrétariat — l'enchaînement", () => {
  it("le DEVIS ne demande rien : il n'est PAS un préalable, il est une option", () => {
    // Ce qui le ferait tomber : exiger le bon de commande, ou un état du poste. Le cas le plus
    // courant — un prestataire habituel dont le prix est connu — se passe de devis, et un refus
    // à tort coûte plus cher que le défaut qu'il prétend éviter (§118.27).
    expect(peutDemanderPiece("DEVIS", { ouvertes: [], bcDemande: false })).toEqual({ ok: true });
    expect(peutDemanderPiece("DEVIS", { ouvertes: ["FACTURE"], bcDemande: true })).toEqual({ ok: true });
  });

  it("la FACTURE exige que le bon de commande ait été demandé — et le refus nomme le geste", () => {
    const r = peutDemanderPiece("FACTURE", { ouvertes: [], bcDemande: false });
    expect(r.ok, "une facture sans engagement est l'anomalie que le contrôle financier lève ailleurs").toBe(false);
    // §118.30 : un refus qui nomme la faute sans nommer le remède fait payer un aller-retour.
    expect(r.ok === false ? r.raison : "").toContain("bon de commande");
    expect(peutDemanderPiece("FACTURE", { ouvertes: [], bcDemande: true })).toEqual({ ok: true });
  });

  it("une demande DÉJÀ OUVERTE de la même nature ferme la sienne, et elle SEULE", () => {
    // Deux demandes identiques dans la file du secrétariat font traiter deux fois la même chose.
    expect(peutDemanderPiece("DEVIS", { ouvertes: ["DEVIS"], bcDemande: false }).ok).toBe(false);
    // Mais la nature VOISINE reste ouverte : sans ce second cas, une garde trop large passerait
    // pour armée (§118.17) et l'on ne pourrait jamais réclamer la facture après avoir demandé
    // un devis, ce qui est exactement l'enchaînement demandé.
    expect(peutDemanderPiece("FACTURE", { ouvertes: ["DEVIS"], bcDemande: true })).toEqual({ ok: true });
  });

  it("les DEUX natures portent un type de secrétariat DISTINCT et un libellé", () => {
    // Deux natures qui tomberaient dans la même file du secrétariat seraient indiscernables pour
    // l'assistante, qui filtre par type.
    const types = NATURES_PIECE_SECRETARIAT.map((n) => String(PIECE_SECRETARIAT[n].type));
    expect(new Set(types).size).toBe(NATURES_PIECE_SECRETARIAT.length);
    for (const n of NATURES_PIECE_SECRETARIAT) {
      expect(PIECE_SECRETARIAT[n].libelle.length, n).toBeGreaterThan(2);
      expect(PIECE_SECRETARIAT[n].aide, `${n} : le champ de message doit DIRE quoi y écrire`).toMatch(/référence/i);
    }
  });

  it("le titre se lit SEUL dans la file : la pièce, le poste et l'opération", () => {
    // L'assistante voit trente demandes dans sa journée. « Facture » ne lui dit ni de quoi ni
    // pour qui, et elle doit alors ouvrir chacune pour savoir laquelle traiter.
    const t = titrePiece("FACTURE", "Traiteur : cocktail d'ouverture", "SPO-2026-014");
    expect(t).toContain("Facture");
    expect(t).toContain("cocktail d'ouverture");
    expect(t).toContain("SPO-2026-014");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POINT D'APPEL, PAS LE CORPS (§118.49).
 *
 * `daterLEntree` était écrite, commentée, et couverte par un test qui lisait son corps — son
 * APPEL avait été perdu dans une édition, et le test passait au vert sur du code mort. Ici la
 * question n'est pas « la règle est-elle juste ? » (les cas ci-dessus y répondent) mais :
 * *une personne qui ouvre un poste peut-elle joindre une pièce et demander la facture ?*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("l'écran des postes MONTE ce que le code offre", () => {
  const PANNEAU = "src/modules/ad-pro/ecrans/items-panel.tsx";

  it("le poste porte ses PROPRES pièces jointes, sur SON entité", async () => {
    const src = lireSources(PANNEAU, "src/modules/ad-pro/ecrans/postes/");
    // « On peut mettre une PJ ou plusieurs à chaque poste. » Ce qui le ferait tomber : poser le
    // téléverseur sur l'OPÉRATION — la facture du traiteur et celle de l'agence se mélangeraient
    // alors sur un seul tas, et il faudrait rouvrir chacune pour savoir laquelle justifie quoi.
    expect(src, "le téléverseur doit viser le POSTE").toMatch(
      /<DocumentUpload\s+entityType="AD_PRO_ITEM"\s+entityId=\{item\.id\}/,
    );
    // Et sa liste de catégories est celle du pôle, pas le repli sur la table entière — dont la
    // première entrée est « CTD complet », la nomenclature d'un dossier d'enregistrement.
    expect(src).toContain("AD_PRO_DOC_CATEGORIES");
  });

  it("les DEUX natures sont proposées par la liste canonique, jamais écrites à la main", async () => {
    const src = lireSources(PANNEAU, "src/modules/ad-pro/ecrans/postes/");
    // Deux boutons écrits à la main divergeraient sur le message — et le message est
    // précisément ce que le circuit doit transporter (§118.5).
    expect(src).toMatch(/NATURES_PIECE_SECRETARIAT\.map/);
    expect(src, "la garde d'enchaînement est celle du module pur").toContain("peutDemanderPiece(");
    expect(src).not.toMatch(/"DEVIS"\s*,\s*"FACTURE"/);
  });

  it("les DEUX paroles du bon de commande sont AFFICHÉES — sinon la perte est indétectable", async () => {
    const src = lireSources(PANNEAU, "src/modules/ad-pro/ecrans/postes/");
    /*
     * Mesuré : `orderNote` avait TROIS écrivains et AUCUN lecteur. Séparer les champs sans les
     * afficher aurait laissé le circuit transporter un message que personne ne lit (§118.45).
     *
     * ON EXIGE LA VALEUR RENDUE, pas la simple présence du symbole. La première version de ce
     * cas s'écrivait `toContain("item.orderNote")` — et le sabotage qui RETIRE l'affichage en
     * laissant la CONDITION (`{item.orderNote && …}`) est passé au vert : l'assertion visait le
     * test d'existence, pas la lecture. §118.111 mot pour mot — un sabotage qui passe ne dit pas
     * « le code est bon », il dit « je ne teste pas ce que je crois ».
     */
    for (const champ of ["orderNote", "orderDecisionNote"] as const) {
      const rendu = new RegExp(`\\{\\s*item\\.${champ}\\s*\\}`);
      expect(rendu.test(src), `« ${champ} » doit être RENDU, pas seulement testé`).toBe(true);
    }
  });
});
