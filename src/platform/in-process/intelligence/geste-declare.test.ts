import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TOUT SIGNAL QUI DIT « CE QU'IL Y A À FAIRE » EST CLASSÉ (§118.126).
 *
 * Le marqueur `tache` est posé À LA MAIN par l'auteur du signal, parce que `action` est de la
 * prose et qu'en déduire un geste serait deviner (§118.125). Une décision manuelle se périme :
 * un signal ajouté demain porterait une action et AUCUN classement, et le silence se lirait
 * comme « pas de geste » alors qu'il veut dire « personne n'a tranché » (§118.26).
 *
 * Ce banc lit donc la SOURCE et exige la partition : marqué, ou exclu NOMMÉMENT avec sa raison.
 * Les commentaires sont retirés avant lecture — quatre fois dans ce dépôt un mécanisme a
 * accroché la prose qui le documente (§118.79d, §118.88, §118.107, §118.112b).
 *
 * ── IL Y AVAIT DEUX ÉMETTEURS, ET CE BANC N'EN LISAIT QU'UN (§118.127) ────────────────────
 *
 * Première version : un chemin écrit à la main. Elle affirmait une partition sur 24 littéraux
 * avec l'assurance d'avoir vu le parc, pendant que `src/modules/finances/domaine/intelligence.ts` en émettait
 * six autres — dont `justificatif_manquant`, que la mesure live a vu sortir en constat HAUTE
 * sans proposer quoi que ce soit. Complet sur le fichier qu'il lisait, aveugle au parc : c'est
 * « 712 avec l'assurance d'en avoir vu 715 » (§118.73) et une garde qui ne s'arme pas sur la
 * forme qu'on lui donne (§118.88).
 *
 * LES ÉMETTEURS SONT DONC DÉCOUVERTS, sur un fait du code : un fichier qui importe le
 * vocabulaire CANONIQUE (`utils/signaux`) et qui écrit des littéraux portant `code:` ET
 * `gravite:`. Un troisième émetteur ajouté demain doit importer ce type — c'est le seul
 * vocabulaire des signaux — donc il entre sans que personne ait pensé à lui. Mesuré : la règle
 * rend exactement les deux émetteurs réels ; la variante « tout littéral code+gravite »,
 * essayée d'abord, ramassait `src/lib/sandbox/viz.ts`, qui n'a aucun rapport.
 */

/** Un fichier émetteur : il parle le vocabulaire canonique ET écrit des signaux. */
function emetteurs(): string[] {
  const trouves: string[] = [];
  const parcourir = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const chemin = join(dir, e.name);
      if (e.isDirectory()) { parcourir(chemin); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const src = readFileSync(chemin, "utf8");
      if (!src.includes("utils/signaux")) continue;
      if (!/code: "[a-z_]+"/.test(src) || !/gravite: /.test(src)) continue;
      trouves.push(chemin);
    }
  };
  parcourir(join(process.cwd(), "src"));
  return trouves.sort();
}

/** Les signaux qui DISENT quoi faire et qui n'auront JAMAIS de tâche — chacun avec sa raison. */
const EXCLUS: Record<string, string> = {
  contrat_echeance: "la suite est une DÉCISION de la personne (renouveler, renégocier, laisser expirer) — inscrire une tâche déplacerait l'arbitrage",
  denonciation_a_decider: "une DÉCISION, et datée : une tâche ferait croire qu'un geste suffit là où il faut trancher",
  dossier_en_erreur: "« relancer l'analyse » est un rejeu TECHNIQUE, pas un pas humain : la tâche n'aurait rien à dire à qui la reçoit",
};

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

/**
 * Chaque littéral de signal : son code, s'il porte une action, s'il porte le marqueur.
 *
 * LA FENÊTRE VA D'UN `code:` AU SUIVANT, et pas du `code:` à la fin du littéral. Première
 * version : elle s'arrêtait au premier `})`, or ce terminateur apparaît DANS les littéraux
 * (`graviteParJours(jd, { haute: 14, normale: 45 })`) — 11 actions lues sur 18, et les quatre
 * autres cas passaient au vert sur une lecture amputée. C'est l'assertion de prémisse qui l'a
 * dit, et c'est exactement ce qu'elle existe pour attraper (§118.17).
 */
function litteraux(src: string): { code: string; action: boolean; tache: boolean }[] {
  const bornes = [...src.matchAll(/code: "([a-z_]+)"/g)];
  return bornes.map((m, i) => {
    const debut = m.index! + m[0].length;
    const fin = i + 1 < bornes.length ? bornes[i + 1]!.index! : src.length;
    const corps = src.slice(debut, fin);
    return { code: m[1]!, action: /\baction: /.test(corps), tache: /\btache: true\b/.test(corps) };
  });
}

describe("le geste déclaré, sur TOUT le parc de signaux", () => {
  const fichiers = emetteurs();
  const sites = fichiers.flatMap((f) => litteraux(sansCommentaires(readFileSync(f, "utf8"))));

  it("la prémisse : TOUS les émetteurs sont lus, et le parc n'est pas vide", () => {
    // Sans ces assertions, un motif cassé rendrait 0 site et TOUS les cas suivants passeraient
    // au vert sur du vide — la tautologie que §118.17 nomme. Et le PLANCHER d'émetteurs est celui
    // qui a manqué : à un seul fichier, ce banc était complet sur ce qu'il lisait et aveugle au
    // reste. Au chiffre MESURÉ, une découverte cassée tombe ici.
    expect(fichiers.length, `émetteurs découverts : ${fichiers.map((f) => f.replace(process.cwd() + "/", "")).join(", ")}`).toBeGreaterThanOrEqual(2);
    expect(sites.length).toBeGreaterThanOrEqual(28);
    expect(sites.filter((s) => s.action).length).toBeGreaterThanOrEqual(16);
    expect(sites.filter((s) => s.tache).length).toBeGreaterThanOrEqual(11);
  });

  it("aucun faux positif : tout fichier découvert PRODUIT réellement des signaux", () => {
    // POURQUOI CETTE ASSERTION EXISTE, et pourquoi elle est une ASSERTION et non un filtre.
    // J'ai d'abord ajouté « et le fichier déclare `Signal[]` » comme TROISIÈME condition de la
    // découverte, en écrivant à côté qu'elle rendait la narrowness exerçable. C'était FAUX, et
    // le sabotage l'a dit : retirer une condition ÉLARGIT la découverte, et un plancher ne peut
    // pas tomber parce qu'on lui ajoute des sites. Un commentaire qui affirme un comportement
    // sans l'avoir exercé est une dette, pas une documentation (§118.116).
    //
    // La narrowness se garde donc par une assertion, dans le sens où un faux positif la fait
    // TOMBER : mesuré, `src/lib/sandbox/viz.ts` porte des littéraux `code:`+`gravite:` sans le
    // moindre rapport avec les signaux métier et ne déclare aucun `Signal[]`. Ce que coûterait
    // son entrée n'est pas théorique : ses sites gonfleraient le plancher ci-dessus, qui serait
    // alors satisfait tout en ayant perdu de VRAIS signaux — un contrôle qui ne peut plus
    // échouer (§118.17), obtenu en élargissant une découverte.
    const faussaires = fichiers.filter((f) => !readFileSync(f, "utf8").includes("Signal[]"));
    expect(
      faussaires.map((f) => f.replace(process.cwd() + "/", "")),
      "ces fichiers sont découverts comme émetteurs et ne produisent aucun Signal[] — la découverte est trop large",
    ).toEqual([]);
  });

  it("tout signal qui dit quoi faire est MARQUÉ ou EXCLU nommément", () => {
    const orphelins = sites
      .filter((s) => s.action && !s.tache && !(s.code in EXCLUS))
      .map((s) => s.code);
    expect(
      [...new Set(orphelins)],
      `ces signaux portent une action et aucun classement — poser « tache: true », ou les exclure dans EXCLUS avec la raison :\n${[...new Set(orphelins)].join("\n")}`,
    ).toEqual([]);
  });

  it("aucun signal EXCLU ne porte le marqueur — les deux listes ne se contredisent pas", () => {
    const contradictoires = sites.filter((s) => s.tache && s.code in EXCLUS).map((s) => s.code);
    expect([...new Set(contradictoires)]).toEqual([]);
  });

  it("aucun signal SANS action ne porte le marqueur — une tâche sans intitulé n'existe pas", () => {
    const vides = sites.filter((s) => s.tache && !s.action).map((s) => s.code);
    expect([...new Set(vides)]).toEqual([]);
  });

  it("chaque exclusion nomme une raison, et vise un signal qui EXISTE", () => {
    const codes = new Set(sites.map((s) => s.code));
    for (const [code, raison] of Object.entries(EXCLUS)) {
      expect(raison.length, `l'exclusion de ${code} n'explique rien`).toBeGreaterThan(40);
      // Une exclusion qui vise un signal disparu est du poids mort qui rassure (§118.17).
      expect(codes.has(code), `EXCLUS nomme « ${code} », absent du parc — exclusion périmée`).toBe(true);
    }
  });
});
