import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GESTE EST-IL BRANCHÉ ? — §118.49 appliqué au prochain geste (§118.126).
 *
 * POURQUOI CE BANC EXISTE. `daterLEntree` était écrite, commentée, et couverte par un test qui
 * lisait son CORPS. Son appel avait été perdu dans une édition, et un run live a rendu 53 étapes
 * abouties, 2 332 reçus, ZÉRO entrée datée — le test au vert sur du code mort. Ici c'est la même
 * forme : `gesteDuTour` est pur et couvert (7 cas), `carteDuProchainGeste` est couverte par le
 * banc de transport, et rien de tout cela ne prouve que le TOUR l'appelle. Un test d'architecture
 * qui affirme qu'un mécanisme existe doit chercher son POINT D'APPEL, et à l'endroit exact où il
 * doit être.
 *
 * LES DEUX CHEMINS, ET C'EST LA MOITIÉ QUI COMPTE. Le tour en flux sert l'écran ; le tour d'un
 * trait sert la VOIX et les appels internes. Brancher un seul laisserait une porte gardée à côté
 * d'une porte ouverte (§118.71) : le dirigeant verrait la carte en tapant et jamais en parlant,
 * sans qu'une seule ligne ne le dise.
 *
 * CE QU'IL NE PEUT PAS PROUVER, ET QUI EST DIT ICI PLUTÔT QUE TAIT (§118.82) : que le modèle
 * appelle réellement un outil d'intelligence sur une question d'état. C'est la sonde live qui le
 * mesure (`npm run sonde:conversation`), pas ce banc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// `assistant.ts` découpé (lot V4) : les deux tours (`boucle/tour.ts`, `boucle/flux.ts`) et la carte (`boucle/sources.ts`).
const SRC = ["tour", "flux", "sources"].map((f) => readFileSync(join(process.cwd(), `src/lib/assistant/boucle/${f}.ts`), "utf8")).join("\n");
// Les commentaires sont RETIRÉS avant lecture : trois fois dans ce dépôt, un cliquet s'est
// accroché à la prose qui DÉCRIT la forme qu'il cherche (§118.79d, §118.88, §118.112b) — et
// cette fonction-là est justement précédée de vingt lignes qui la nomment.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("le prochain geste est branché aux DEUX tours", () => {
  it("chaque retour de réponse finale porte le résultat de `carteDuProchainGeste`", () => {
    // Les retours de réponse FINALE : ceux qui rendent un `reply` après la boucle d'outils, donc
    // ceux qu'un tour de conversation ordinaire atteint. On les reconnaît au fait qu'ils portent
    // la seconde passe critique juste au-dessus — c'est le seul endroit du fichier où `reply` est
    // rendu sans proposition du modèle, et c'est là que la carte doit naître.
    const appels = CODE.match(/const gesteCartes = await carteDuProchainGeste\(/g) ?? [];
    expect(appels.length, "le geste doit être appelé par le tour en FLUX et par le tour D'UN TRAIT").toBe(2);

    // Et son résultat doit VOYAGER : un appel dont on jette la valeur est exactement le code mort
    // que ce banc existe pour attraper.
    const portes = CODE.match(/\.\.\.\(gesteCartes \? \{ proposal: gesteCartes\[0\], proposals: gesteCartes \} : \{\}\)/g) ?? [];
    expect(portes.length, "les quatre retours finaux (2 chemins × avec/sans seconde passe) doivent porter la carte").toBe(4);
  });

  it("l'appel lit les LECTURES du tour, et il passe par `buildProposal` — pas une carte écrite à la main", () => {
    expect(CODE).toMatch(/await carteDuProchainGeste\(lectures, user, opts\.origin \?\? "text"\)/);
    const corps = CODE.slice(CODE.indexOf("async function carteDuProchainGeste"));
    const fin = corps.indexOf("\n}\n");
    const fonction = corps.slice(0, fin);
    expect(fonction, "la carte passe par la MÊME porte que le modèle (§118.5)").toContain('buildProposal("create_task"');
    expect(fonction, "l'intention est persistée, sinon la carte n'est pas cliquable").toContain("persistActionIntents");
    expect(fonction, "le geste vient du sélecteur PUR, jamais de la prose du signal (§118.125)").toContain("gesteDuTour(");
  });

  it("elle ne lève jamais : les deux appels distants sont rattrapés", () => {
    const corps = CODE.slice(CODE.indexOf("async function carteDuProchainGeste"));
    const fonction = corps.slice(0, corps.indexOf("\n}\n"));
    // Un geste manqué coûte une proposition ; une exception coûterait la RÉPONSE, que le modèle
    // a déjà produite et que la personne attend.
    expect((fonction.match(/\.catch\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
