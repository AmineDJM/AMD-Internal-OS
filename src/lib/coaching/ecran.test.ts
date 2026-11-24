import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MEDICAL_TABS, NAVIGATION } from "@/lib/labels";

/**
 * LA FICHE DE COACHING A UN ÉCRAN, ET ON Y ARRIVE (§118.157, §118.50).
 *
 * Une vue parfaite que rien n'affiche est du code mort. Ce banc tient ce que le typecheck ne voit
 * pas : l'onglet est dans la Promotion médicale — donc aussi dans le menu latéral, qui lit la même
 * liste —, la page qu'il vise existe et rend les onglets du module, et les deux téléchargements
 * que la fiche offre visent des routes qui existent.
 *
 * Et l'ÉDITEUR de grille donne à un axe AJOUTÉ une clé PROVISOIRE. C'est le défaut que le banc de
 * flux a trouvé : `cleLibre` calculé sur les axes À L'ÉCRAN rendait « E » après avoir retiré E, et
 * le serveur — qui lit « clé de la version courante = même axe » — prenait l'ajout pour une
 * reformulation de E, dont l'axe neuf héritait l'historique dans la synthèse. Le serveur attribue
 * la vraie clé ; l'écran ne doit donc JAMAIS en proposer une qui puisse coïncider.
 */

const RACINE = path.resolve(__dirname, "../../..");
const lire = (p: string) => readFileSync(path.join(RACINE, p), "utf8");
// Les commentaires sont retirés avant de juger : un commentaire qui CITE une fonction n'en est pas
// un appel — quatre cliquets de ce dépôt se sont accrochés à leur propre prose (§118.79d, §118.88).
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("l'onglet Coaching de la Promotion médicale", () => {
  it("est dans la liste des onglets du module, gardé par le module, et vise une page qui existe", () => {
    const onglet = MEDICAL_TABS.find((t) => t.href === "/medical/coaching");
    expect(onglet, "l'onglet a disparu de la Promotion médicale").toMatchObject({ module: "MEDICAL", label: "Coaching" });
    expect(existsSync(path.join(RACINE, "src/app/(app)/medical/coaching/page.tsx"))).toBe(true);
  });

  it("le menu latéral de la Promotion médicale porte cette même liste — un seul endroit à tenir", () => {
    const entree = NAVIGATION.find((n) => n.tabs === MEDICAL_TABS);
    expect(entree?.label).toBe("Visite médicale");
  });

  it("la page du coaching rend les onglets du module, filtrés par les droits de la personne", () => {
    expect(sansCommentaires(lire("src/app/(app)/medical/coaching/page.tsx"))).toMatch(/visibleTabs\(\s*user\s*,\s*MEDICAL_TABS\s*\)/);
  });

  it("la fiche offre le classeur et la version imprimable, et les deux routes existent", () => {
    const fiche = sansCommentaires(lire("src/app/(app)/medical/coaching/[id]/page.tsx"));
    expect(fiche).toContain("/api/medical/coaching/${fiche.id}/export");
    expect(fiche).toContain("/impression/coaching/${fiche.id}");
    expect(existsSync(path.join(RACINE, "src/app/api/medical/coaching/[id]/export/route.ts"))).toBe(true);
    expect(existsSync(path.join(RACINE, "src/app/impression/coaching/[id]/page.tsx"))).toBe(true);
  });
});

describe("l'éditeur de grille", () => {
  it("un axe AJOUTÉ reçoit une clé provisoire — jamais une clé « libre » calculée sur les axes à l'écran", () => {
    const src = sansCommentaires(lire("src/components/coaching/grille-editor.tsx"));
    expect(src).toMatch(/cle:\s*cleProvisoire\(/);
    expect(src, "une clé libre calculée à l'écran peut coïncider avec un axe retiré de la version courante").not.toMatch(/\bcleLibre\b/);
  });
});
