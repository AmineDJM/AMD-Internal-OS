import { describe, expect, it } from "vitest";
import {
  blocsSupprimes, changerType, cocher, compteCases, deplacerA, deplacerApres, deplacerDUnCran, desindenter, indenter,
  memesBlocs, normaliserBlocs, nouvelIdBloc, raccourci, retirer, sousArbre, type BlocNote,
} from "./blocs";

const b = (id: string, texte: string, niveau = 0, type: BlocNote["type"] = "puce", fait?: boolean): BlocNote =>
  ({ id, type, texte, niveau, ...(type === "tache" ? { fait: !!fait } : {}) });
const ids = (xs: BlocNote[]) => xs.map((x) => `${x.id}${x.niveau}`).join(" ");

describe("blocs — normalisation", () => {
  it("borne les types, les textes, les niveaux, et refait un identifiant en double", () => {
    const n = normaliserBlocs([
      { id: "aaaaaaaa", type: "inconnu", texte: "un\nseul", niveau: 3 },
      { id: "aaaaaaaa", type: "tache", texte: "x".repeat(3000), fait: true, niveau: 9 },
      "n'importe quoi",
    ]);
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({ type: "texte", texte: "un seul", niveau: 0 });
    expect(n[1].id).not.toBe("aaaaaaaa");
    expect(n[1]).toMatchObject({ type: "tache", fait: true, niveau: 1 });
    expect(n[1].texte).toHaveLength(2000);
  });

  it("un identifiant court, en minuscules et chiffres", () => {
    expect(nouvelIdBloc()).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("blocs — raccourcis de début de ligne", () => {
  it("« - » et « * » font une puce, « [] » une case, « [x] » une case cochée, « # » un titre", () => {
    expect(raccourci(b("a", "- acheter", 0, "texte"))).toMatchObject({ type: "puce", texte: "acheter" });
    expect(raccourci(b("a", "* acheter", 1, "texte"))).toMatchObject({ type: "puce", texte: "acheter", niveau: 1 });
    expect(raccourci(b("a", "[] appeler", 0, "texte"))).toMatchObject({ type: "tache", texte: "appeler", fait: false });
    expect(raccourci(b("a", "[ ] appeler", 0, "texte"))).toMatchObject({ type: "tache", fait: false });
    expect(raccourci(b("a", "[x] fait", 0, "texte"))).toMatchObject({ type: "tache", fait: true });
    expect(raccourci(b("a", "# Cette semaine", 0, "texte"))).toMatchObject({ type: "titre", texte: "Cette semaine" });
  });

  it("rien sans l'espace, rien sur un bloc déjà typé, rien au milieu d'une ligne", () => {
    expect(raccourci(b("a", "-acheter", 0, "texte"))).toBeNull();
    expect(raccourci(b("a", "- acheter", 0, "tache"))).toBeNull();
    expect(raccourci(b("a", "prix - 10 %", 0, "texte"))).toBeNull();
  });
});

describe("blocs — imbrication (Tab / Maj+Tab)", () => {
  const page = [b("a", "A"), b("b", "B"), b("c", "C", 1), b("d", "D")];

  it("Tab : un cran sous la ligne d'au-dessus, avec son sous-arbre ; jamais deux crans", () => {
    expect(ids(indenter(page, "b"))).toBe("a0 b1 c2 d0");
    expect(ids(indenter(indenter(page, "b"), "b"))).toBe("a0 b1 c2 d0");
    expect(ids(indenter(page, "a"))).toBe("a0 b0 c1 d0");
  });

  it("Maj+Tab : un cran à gauche, le sous-arbre suit", () => {
    const imbrique = indenter(page, "b");
    expect(ids(desindenter(imbrique, "b"))).toBe("a0 b0 c1 d0");
    expect(ids(desindenter(page, "a"))).toBe("a0 b0 c1 d0");
  });

  it("le sous-arbre d'une ligne : elle et ceux qui la suivent plus à droite", () => {
    expect(sousArbre(page, 1)).toEqual([1, 3]);
    expect(sousArbre(page, 3)).toEqual([3, 4]);
  });
});

describe("blocs — déplacer (glisser, Alt+↑/↓, l'assistant)", () => {
  const page = [b("a", "A"), b("b", "B"), b("c", "C", 1), b("d", "D")];

  it("glisser une ligne : elle et ses enfants arrivent ensemble", () => {
    expect(ids(deplacerA(page, "b", 2))).toBe("a0 d0 b0 c1");
    expect(ids(deplacerA(page, "d", 0))).toBe("d0 a0 b0 c1");
  });

  it("Alt+↓ / Alt+↑ passent par-dessus le voisin et son sous-arbre", () => {
    expect(ids(deplacerDUnCran(page, "a", 1))).toBe("b0 c1 a0 d0");
    expect(ids(deplacerDUnCran(page, "d", -1))).toBe("a0 d0 b0 c1");
    expect(ids(deplacerDUnCran(page, "a", -1))).toBe("a0 b0 c1 d0");
  });

  it("après une ligne : après son sous-arbre, à son niveau ; jamais dans son propre sous-arbre", () => {
    expect(ids(deplacerApres(page, "d", "b"))).toBe("a0 b0 c1 d0");
    expect(ids(deplacerApres(page, "a", "c"))).toBe("b0 c1 a1 d0");
    expect(ids(deplacerApres(page, "b", "c"))).toBe("a0 b0 c1 d0");
    expect(ids(deplacerApres(page, "d", null))).toBe("d0 a0 b0 c1");
  });
});

describe("blocs — cocher, type, corbeille", () => {
  it("cocher une case barre la ligne ; changer de type retire ou pose la case", () => {
    const p = cocher([b("a", "A", 0, "tache")], "a", true);
    expect(p[0].fait).toBe(true);
    expect(changerType(p, "a", "puce")[0]).not.toHaveProperty("fait");
    expect(changerType([b("a", "A")], "a", "tache")[0]).toMatchObject({ type: "tache", fait: false });
    expect(compteCases([...p, b("z", "Z", 0, "tache")])).toEqual({ total: 2, faites: 1 });
  });

  it("une ligne retirée garde ses enfants ; seules les lignes NON VIDES vont à la corbeille", () => {
    const avant = [b("a", "A"), b("b", "B", 1), b("v", "", 0)];
    const apres = retirer(retirer(avant, "a"), "v");
    expect(ids(apres)).toBe("b0");
    expect(blocsSupprimes(avant, apres)).toEqual([{ bloc: avant[0], position: 0 }]);
    expect(memesBlocs(avant, [...avant])).toBe(true);
    expect(memesBlocs(avant, apres)).toBe(false);
  });
});
