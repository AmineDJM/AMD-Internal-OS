import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decouperTexte, focusInitial, peutConfirmer, preparerDialogue, verbeDuBouton } from "./dialogue-regle";
import { AVIS_MAX, dureeDuRetour, empiler, roleDuRetour } from "./retour-regle";
import { DialogueConfirmation } from "./dialogue-fenetre";
import { Retour } from "./retour";
import { RetoursProvider } from "./retours-porteur";

/**
 * LES PRIMITIVES UI DE V3-B — le dialogue de confirmation et le retour d'un geste.
 *
 * Deux étages, comme partout dans le dépôt : la RÈGLE pure (ce que la fenêtre affiche, comment un
 * avis est annoncé, combien de temps il reste) éprouvée cas par cas ; puis le BALISAGE rendu, qui
 * porte les promesses d'accessibilité (rôles, liens titre/détail, régions `aria-live` présentes avant
 * le premier message). Le comportement au clavier (focus piégé, Échap, retour du focus) est éprouvé
 * au navigateur — voir `docs/knowledge-base/05-frontend-ui-ux.md` § Primitives.
 */

describe("dialogue — ce que la fenêtre affiche (règle pure)", () => {
  it("une question seule devient le titre, sans détail", () => {
    expect(decouperTexte("Supprimer ce message ?")).toEqual({ titre: "Supprimer ce message ?", detail: null });
  });

  it("le premier paragraphe est le titre, la suite le détail", () => {
    expect(decouperTexte("Supprimer le dossier « A » ?\n\n2 sous-dossiers\n3 documents")).toEqual({
      titre: "Supprimer le dossier « A » ?",
      detail: "2 sous-dossiers\n3 documents",
    });
    expect(decouperTexte("Supprimer DÉFINITIVEMENT « x » ?\nCette action est irréversible.")).toEqual({
      titre: "Supprimer DÉFINITIVEMENT « x » ?",
      detail: "Cette action est irréversible.",
    });
  });

  it("le bouton porte le verbe du geste quand il est connu, « Confirmer » sinon", () => {
    expect(verbeDuBouton("Supprimer ce document ?")).toBe("Supprimer");
    expect(verbeDuBouton("Retirer « Dupont » des voyageurs ?")).toBe("Retirer");
    expect(verbeDuBouton("Mettre ces 3 éléments à la corbeille ?")).toBe("Confirmer");
    expect(verbeDuBouton("Voulez-vous désactiver l'entité ?")).toBe("Confirmer");
  });

  it("« Retour » renonce — jamais « Annuler », qui se confondrait avec « Annuler la course ? »", () => {
    const d = preparerDialogue("Annuler la course « Alger » ?");
    expect(d.confirmer).toBe("Annuler");
    expect(d.annuler).toBe("Retour");
  });

  it("un geste qui supprime ou retire est un geste à risque : bouton rouge, focus sur « Retour »", () => {
    expect(preparerDialogue("Supprimer cette règle ?").ton).toBe("danger");
    expect(preparerDialogue("Mettre cet élément à la corbeille ?").ton).toBe("danger");
    expect(focusInitial(preparerDialogue("Supprimer cette règle ?"))).toBe("annuler");
    expect(preparerDialogue("Soumettre la version 2 ?").ton).toBe("neutre");
    expect(focusInitial(preparerDialogue("Soumettre la version 2 ?"))).toBe("confirmer");
  });

  it("l'appelant garde la main sur tout", () => {
    const d = preparerDialogue({ titre: "Clôturer ?", message: "Plus rien ne se modifie.", confirmer: "Clôturer la mission", ton: "neutre" });
    expect(d).toMatchObject({ titre: "Clôturer ?", detail: "Plus rien ne se modifie.", confirmer: "Clôturer la mission", ton: "neutre" });
  });

  it("un motif obligatoire vide bloque le bouton ; facultatif, non — et le champ prend le focus", () => {
    const obligatoire = preparerDialogue({ titre: "Annuler ?", saisie: { libelle: "Motif", obligatoire: true } });
    expect(peutConfirmer(obligatoire, "  ")).toBe(false);
    expect(peutConfirmer(obligatoire, "doublon")).toBe(true);
    expect(peutConfirmer(preparerDialogue({ titre: "Rejeter ?", saisie: { libelle: "Motif" } }), "")).toBe(true);
    expect(focusInitial(obligatoire)).toBe("saisie");
  });
});

describe("retour — annonce et durée (règle pure)", () => {
  it("une erreur interrompt le lecteur d'écran, un succès attend", () => {
    expect(roleDuRetour("erreur")).toBe("alert");
    expect(roleDuRetour("alerte")).toBe("alert");
    expect(roleDuRetour("succes")).toBe("status");
    expect(roleDuRetour("info")).toBe("status");
  });

  it("une erreur ne s'efface jamais seule ; un succès reste le temps d'être lu (4 à 10 s)", () => {
    expect(dureeDuRetour("erreur", "x")).toBeNull();
    expect(dureeDuRetour("succes", "Fait.")).toBe(4_000);
    expect(dureeDuRetour("info", "x".repeat(100))).toBe(6_000);
    expect(dureeDuRetour("succes", "x".repeat(1000))).toBe(10_000);
  });

  it("le même message n'est pas empilé deux fois, et la pile est bornée", () => {
    let pile = empiler([], { id: 1, ton: "erreur", message: "Refusé." });
    pile = empiler(pile, { id: 2, ton: "erreur", message: "Refusé." });
    expect(pile.map((a) => a.id)).toEqual([2]);
    for (let i = 3; i < 10; i++) pile = empiler(pile, { id: i, ton: "info", message: `m${i}` });
    expect(pile).toHaveLength(AVIS_MAX);
    expect(pile.at(-1)?.id).toBe(9);
  });
});

describe("balisage accessible", () => {
  it("le dialogue est un alertdialog modal, titre et détail reliés, deux boutons nommés", () => {
    const html = renderToStaticMarkup(
      React.createElement(DialogueConfirmation, { dialogue: preparerDialogue("Supprimer ce document ?\n\nIl part à la corbeille."), onRepondre: () => {} }),
    );
    expect(html).toMatch(/role="alertdialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    const titre = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const detail = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${titre}"`);
    expect(html).toContain(`id="${detail}"`);
    expect(html).toMatch(/>Retour<\/button>/);
    expect(html).toMatch(/>Supprimer<\/button>/);
  });

  it("le champ de motif a un libellé relié", () => {
    const html = renderToStaticMarkup(
      React.createElement(DialogueConfirmation, { dialogue: preparerDialogue({ titre: "Rejeter ?", saisie: { libelle: "Motif", obligatoire: true } }), onRepondre: () => {} }),
    );
    const pour = html.match(/<label for="([^"]+)"/)?.[1];
    expect(pour).toBeTruthy();
    expect(html).toMatch(new RegExp(`<textarea[^>]*id="${pour}"[^>]*required`));
  });

  it("le bandeau prend le rôle de son ton, et ne rend rien sans message", () => {
    expect(renderToStaticMarkup(React.createElement(Retour, { ton: "erreur" }, "Refusé."))).toMatch(/^<div role="alert"/);
    expect(renderToStaticMarkup(React.createElement(Retour, { ton: "succes" }, "Fait."))).toMatch(/^<div role="status"/);
    expect(renderToStaticMarkup(React.createElement(Retour, { ton: "erreur" }, null))).toBe("");
  });

  it("les régions d'annonce existent AVANT le premier avis (sinon le lecteur d'écran se tait)", () => {
    const html = renderToStaticMarkup(React.createElement(RetoursProvider, null, "page"));
    expect(html).toMatch(/role="alert" aria-live="assertive"/);
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });
});
