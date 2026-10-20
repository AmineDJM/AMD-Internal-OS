import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { entreesMenu, iconesLigne, libellePartage, pastilleCompteur, dossierDuFichier, type ContexteMenu } from "./menu-fichier";

const base: ContexteMenu = { isFile: true, canEdit: true, trash: false, convertible: true, peutDeplacer: true, ouvert: false, champs: false };
const plat = (c: Partial<ContexteMenu>) => entreesMenu({ ...base, ...c }).flat();

describe("menu « ⋯ » d'un fichier du Drive", () => {
  it("un éditeur voit tout ce que demandait la Direction, corbeille SEULE et en dernier", () => {
    const g = entreesMenu(base);
    expect(g.flat()).toEqual(expect.arrayContaining(["pdf", "version", "historique", "telecharger", "renommer", "corbeille"]));
    expect(g[g.length - 1]).toEqual(["corbeille"]);
  });

  it("un lecteur ne se voit proposer que ce qu'il peut faire", () => {
    const e = plat({ canEdit: false });
    expect(e).toEqual(expect.arrayContaining(["historique", "telecharger", "messagerie"]));
    for (const interdit of ["version", "renommer", "deplacer", "corbeille", "legal", "courrier"]) expect(e).not.toContain(interdit);
  });

  it("la conversion PDF n'apparaît que pour un format convertible", () => {
    expect(plat({ convertible: false })).not.toContain("pdf");
    expect(plat({ isFile: false })).not.toContain("pdf");
  });

  it("un dossier n'a ni versions ni historique, mais se télécharge et part à la corbeille", () => {
    const e = plat({ isFile: false });
    expect(e).not.toContain("version");
    expect(e).not.toContain("historique");
    expect(e).toEqual(expect.arrayContaining(["telecharger", "renommer", "corbeille"]));
  });

  it("la corbeille ne propose que restaurer et supprimer — et rien à qui ne peut pas modifier", () => {
    expect(entreesMenu({ ...base, trash: true })).toEqual([["restaurer"], ["supprimer"]]);
    expect(entreesMenu({ ...base, trash: true, canEdit: false })).toEqual([]);
  });

  it("plein écran et champs personnalisés n'existent que dans le fichier ouvert", () => {
    expect(plat({})).not.toContain("plein-ecran");
    expect(plat({ ouvert: true })).toContain("plein-ecran");
    expect(plat({ ouvert: true, champs: false })).not.toContain("champs");
    expect(plat({ ouvert: true, champs: true })).toContain("champs");
  });

  it("aucun groupe vide (sinon deux traits de séparation se suivent)", () => {
    for (const c of [base, { ...base, canEdit: false, convertible: false }, { ...base, isFile: false, canEdit: false }]) {
      expect(entreesMenu(c).every((g) => g.length > 0)).toBe(true);
    }
  });
});

describe("icônes et libellés de la ligne", () => {
  it("Partage partout hors corbeille ; Commentaires sur les fichiers seulement", () => {
    expect(iconesLigne({ isFile: true, trash: false })).toEqual({ partage: true, commentaires: true });
    expect(iconesLigne({ isFile: false, trash: false })).toEqual({ partage: true, commentaires: false });
    expect(iconesLigne({ isFile: true, trash: true })).toEqual({ partage: false, commentaires: false });
  });

  it("partage et pastille", () => {
    expect(libellePartage(0)).toBe("Privé");
    expect(libellePartage(1)).toBe("1 personne");
    expect(libellePartage(4)).toBe("4 personnes");
    expect(pastilleCompteur(0)).toBeNull();
    expect(pastilleCompteur(7)).toBe("7");
    expect(pastilleCompteur(140)).toBe("99+");
  });

  it("on revient au dossier du fichier, dans sa catégorie s'il en a une", () => {
    expect(dossierDuFichier({ parentId: null, spaceId: null })).toBe("/drive");
    expect(dossierDuFichier({ parentId: "f1", spaceId: null })).toBe("/drive?folder=f1");
    expect(dossierDuFichier({ parentId: null, spaceId: "s1" })).toBe("/drive/espace/s1");
    expect(dossierDuFichier({ parentId: "f1", spaceId: "s1" })).toBe("/drive/espace/s1?folder=f1");
  });
});

/**
 * OUVRIR UN FICHIER NE CHARGE QUE CE QUI S'AFFICHE. La lenteur mesurée venait de là : partages, vingt versions,
 * tout le fil de commentaires et la liste de tous les utilisateurs, lus avant l'éditeur ; puis un second
 * aller-retour pour sa configuration. Ce garde-fou empêche d'y revenir sans s'en apercevoir.
 */
describe("la page d'un fichier reste légère", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/drive/[id]/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("aucune lecture de partages, commentaires ou utilisateurs avec la page", () => {
    expect(page).not.toMatch(/shares:\s*\{\s*include/);
    expect(page).not.toMatch(/comments:\s*\{\s*orderBy/);
    expect(page).not.toContain("prisma.user.findMany");
    expect(page).toContain("_count");
  });

  it("la configuration de l'éditeur est préparée par la page, avec ce qu'elle a déjà lu", () => {
    expect(page).toMatch(/sessionEditeur\(user, \{ type: "drive", id: node\.id \}, \{ acces: level/);
    expect(page).toContain("session={session}");
  });
});
