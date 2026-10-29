import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AD_PRO_KINDS, AD_PRO_ENTITY_TYPE } from "./unified";
import { DISCUSSION_TITRE, DISCUSSION_AIDE, DISCUSSION_VIDE } from "./discussion";

const lire = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^[ \t]*\/\/.*$/gm, " ");

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SECTION DISCUSSION — montée sur les SEPT natures, et sur AUCUNE porte de plus.
 *
 * « Toutes ces demandes […] aussi dans une section discussion en bas de toutes les demandes
 * Ad&Pro, sponsoring, événements, prises en charge, matériel promotionnel etc. »
 *
 * CE QUE CE BANC TIENT, et c'est le POINT D'APPEL et non le corps (§118.49) : les sept écrans de
 * fiche du pôle montent la carte. Mesuré avant d'écrire : le matériel promotionnel était le SEUL
 * à porter un fil, et il le portait en propre — six portes fermées à côté d'une ouverte
 * (§118.71). Un écran ajouté demain sans la carte fait tomber ce test en le nommant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("la section discussion d'une demande Ad & Pro", () => {
  /** L'écran de fiche de chaque nature — le SEUL endroit où la carte peut être montée. */
  const ECRANS: Record<string, string> = {
    SPONSORING: "src/app/(app)/sponsoring/[id]/page.tsx",
    CONGRESS_INTERNATIONAL: "src/app/(app)/congress-international/[id]/page.tsx",
    CONGRESS_NATIONAL: "src/app/(app)/congress-national/[id]/page.tsx",
    EVENT: "src/app/(app)/events/[id]/page.tsx",
    PROMO_MATERIAL: "src/app/(app)/promo-material/[id]/page.tsx",
    CONSULTING: "src/app/(app)/consulting/[id]/page.tsx",
    OTHER: "src/app/(app)/ad-pro/autres/[id]/page.tsx",
  };

  it("LES SEPT natures du pôle montent la carte — aucune exception", () => {
    // LA PRÉMISSE : le registre canonique en compte bien sept, et la table ci-dessus les couvre
    // TOUTES. Sans elle, une nature ajoutée au registre et oubliée ici passerait au vert en ne
    // mesurant rien (§118.104).
    expect(Object.keys(ECRANS).sort(), "la table des écrans doit couvrir le registre canonique")
      .toEqual(AD_PRO_KINDS.map((k) => k.kind).sort());
    for (const [kind, ecran] of Object.entries(ECRANS)) {
      const src = lire(ecran);
      expect(src, `${kind} : l'écran doit monter <AdProDiscussionCard>`).toContain("<AdProDiscussionCard");
      // …avec l'entité CANONIQUE de sa nature, pas une chaîne écrite à la main qui divergerait.
      expect(src, `${kind} : la carte doit viser l'entité ${AD_PRO_ENTITY_TYPE[kind as keyof typeof AD_PRO_ENTITY_TYPE]}`)
        .toContain(`entityType="${AD_PRO_ENTITY_TYPE[kind as keyof typeof AD_PRO_ENTITY_TYPE]}"`);
    }
  });

  it("AUCUN écran ne monte le fil BRUT — un seul chemin, donc une seule porte", () => {
    /*
     * Le matériel promotionnel montait `<CommentThread>` en direct, avec son titre, son
     * écrivain et sa porte de modération écrits sur place. Deux montages du même fil finissent
     * par diverger sur la porte, et le symptôme est un bouton que l'action refuse (§118.5).
     *
     * Ce qui le ferait tomber : remonter `CommentThread` dans un écran Ad & Pro au lieu de la
     * carte partagée.
     */
    for (const [kind, ecran] of Object.entries(ECRANS)) {
      expect(lire(ecran), `${kind} : le fil passe par la carte partagée, jamais par <CommentThread> nu`)
        .not.toContain("<CommentThread");
    }
  });

  it("l'ÉCRIVAIN borne l'entité au pôle — il n'est pas un écrivain générique", () => {
    /*
     * L'entité arrive du formulaire, donc du navigateur. Sans le filtre sur le registre
     * canonique, cette action écrirait un commentaire sur N'IMPORTE QUELLE entité de l'ERP avec
     * une porte pensée pour Ad & Pro — la porte dérobée que §118.7 ferme.
     */
    const src = lire("src/modules/ad-pro/actions-discussion.ts");
    expect(src, "l'écrivain doit lire le registre canonique des natures").toContain("AD_PRO_ENTITY_TYPE");
    expect(src, "et garder par ENREGISTREMENT, jamais par module").toContain("canAccessEntity");
    expect(src, "un droit de MODULE ouvrirait le fil de la demande d'un autre service")
      .not.toMatch(/userCan\(\s*user\s*,/);
  });

  it("la MODÉRATION n'est pas réécrite — les actions canoniques font foi", () => {
    /*
     * Deux jumelles avaient été écrites avant de mesurer, et elles étaient FAUSSES : le composant
     * envoie `id` et `path` sur le chemin de modération, pas `commentId` ni l'entité. Elles
     * auraient refusé « Message non précisé » à chaque geste, en silence (§118.127a). Le remède
     * n'est pas de corriger les noms de champs, c'est de ne pas écrire la seconde vérité.
     */
    const src = lire("src/modules/ad-pro/actions-discussion.ts");
    expect(src.match(/export async function/g) ?? [], "un seul export : l'écrivain").toHaveLength(1);
    const carte = lire("src/modules/ad-pro/ecrans/discussion-card.tsx");
    expect(carte, "la carte emploie les modérations canoniques").toContain('from "@/lib/actions/comment-actions"');
    /*
     * …et le MÊME fait que l'action pour AFFICHER le bouton : un prédicat à part montrerait un
     * bouton que l'action refuse.
     *
     * ON JUGE L'APPEL, PAS UNE MENTION. La première version cherchait la chaîne
     * « canModerateEntity » n'importe où : le sabotage qui remplace l'APPEL par `true` laissait
     * l'IMPORT en place, donc la chaîne était toujours là et le test passait. Quatrième fois que
     * ce piège se referme dans ce dépôt (§118.79d, §118.88, §118.137) : un mécanisme qui cherche
     * une forme trouve la ligne qui la NOMME. On exige donc le SITE D'APPEL, avec ses arguments.
     */
    expect(carte, "l'affichage doit APPELER `canModerateEntity` sur l'entité de la fiche")
      .toMatch(/canModerateEntity\(\s*user\s*,\s*entityType\s*,\s*entityId\s*\)/);
  });

  it("le vocabulaire de la section est écrit UNE fois, et il DIT ce qu'une section vide veut dire", () => {
    // Sept titres écrits à la main auraient divergé, et une section qui s'appelle autrement d'un
    // écran à l'autre se lit comme une autre section.
    expect(DISCUSSION_TITRE).toBe("Discussion");
    expect(DISCUSSION_AIDE).toContain("devis");
    expect(DISCUSSION_AIDE).toContain("bon de commande");
    expect(DISCUSSION_AIDE).toContain("facture");
    // §118.30 : un bloc vide qui ne dit rien fait chercher ce qu'on est censé y faire.
    expect(DISCUSSION_VIDE).toContain("messagerie");
  });
});
