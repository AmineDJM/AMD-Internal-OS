import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { courtIaNonConfiguree, phraseIaNonConfiguree } from "./cle-manquante";

/** Chemin relatif au dépôt, toujours écrit avec `/` (Windows rend des `\`). */
const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, "/");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUCUN ÉCRAN NE NOMME LA CLÉ DE RAISONNEMENT DE MÉMOIRE (§118.128).
 *
 * LE DÉFAUT MESURÉ : huit écrans annonçaient « Ajoutez la clé ANTHROPIC_API_KEY » sur un
 * déploiement qui tourne chez OpenAI. L'administrateur pose la variable que l'écran nomme, rien
 * ne change, et il conclut que le produit est cassé — un refus qui nomme un remède FAUX est pire
 * qu'un refus qui n'en nomme aucun (§118.121).
 *
 * Et `cleModeleRequise()` existait POUR ÇA, avec un en-tête qui annonçait « évite la quatrième
 * recopie ». Il y en avait huit : le mécanisme était écrit, juste, et le chemin naturel passait à
 * côté (§118.14). Réparer les huit à la main ne protège pas la neuvième — il faut l'endroit où
 * TOUTES les instances passent (§118.58), et ici c'est une règle sur la SOURCE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINES = ["src/app", "src/components", "src/modules"];

function ecrans(): string[] {
  const out: string[] = [];
  const marche = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) marche(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  };
  for (const r of RACINES) marche(join(process.cwd(), r));
  return out;
}

describe("le nom de la clé d'IA ne se recopie plus dans un écran", () => {
  const fichiers = ecrans();

  it("la prémisse : le parc d'écrans est lu", () => {
    // Sans elle, un balayage cassé rendrait 0 fichier et les deux cas suivants passeraient au
    // vert sur du vide — la tautologie que §118.17 nomme.
    expect(fichiers.length).toBeGreaterThan(200);
  });

  it("AUCUN écran ne nomme la clé du fournisseur de RAISONNEMENT", () => {
    // Règle ABSOLUE, prose comprise : trois fois dans ce dépôt un cliquet s'est accroché au
    // commentaire qui le décrivait (§118.79d, §118.88, §118.112b). Ici on inverse le piège —
    // le littéral est interdit PARTOUT, donc la documentation ne peut pas le citer, donc aucune
    // exception n'est à écrire. Le nom se lit dans le registre (`cleModeleRequise`) et voyage en
    // prop ou dans une réponse de route.
    const fautifs = fichiers
      .filter((f) => readFileSync(f, "utf8").includes("ANTHROPIC_API_KEY"))
      .map(rel);
    expect(
      fautifs,
      `ces écrans gravent un nom de clé que le registre seul connaît — passer par cleModeleRequise() côté serveur, et le recevoir en prop côté client :\n${fautifs.join("\n")}`,
    ).toEqual([]);
  });

  it("la clé de TRANSCRIPTION reste nommable, et seulement là où elle est lue", () => {
    // `whisper` n'existe que chez OpenAI : il n'y a aucun choix de registre à lire, donc nommer
    // `OPENAI_API_KEY` y est JUSTE. Interdire par symétrie remplacerait un nom exact par une
    // périphrase — un refus à tort, plus coûteux que le défaut corrigé (§118.27). L'exception
    // porte donc sur un FAIT du fichier : il parle de transcription.
    const fautifs = fichiers
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes("OPENAI_API_KEY") && !src.includes("sttConfigured");
      })
      .map(rel);
    expect(
      fautifs,
      `ces écrans nomment OPENAI_API_KEY hors du contexte de transcription — le fournisseur de raisonnement se lit dans le registre :\n${fautifs.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÊME DÉFAUT PAR LA PORTE DU SERVEUR — les refus que rendent les actions et les routes.
 *
 * Le cliquet ci-dessus ne lisait que les `.tsx`. Or un refus d'IA s'écrit plus souvent dans une
 * ACTION que dans un écran : l'écran se contente d'afficher `error`. Mesuré au 10/2026 : HUIT
 * refus d'actions gravaient encore « ajoutez la clé <nom d'Anthropic> » (analyse d'un appel
 * d'offres PCH, d'un contrat de travail, compte rendu de réunion, présentation d'étude, Adventum
 * Brain), sur un déploiement qui tourne chez OpenAI — et huit autres dans les modules qu'elles
 * appellent (revue réglementaire, diagnostic de plateforme…), réparés avec eux. Le cliquet des
 * écrans était vert pendant que la même phrase fausse arrivait à l'écran par la réponse de
 * l'action (§118.71).
 *
 * Même règle que pour les écrans, prose comprise — le littéral est interdit PARTOUT dans ces
 * fichiers, donc la documentation ne peut pas le citer, donc aucune exception de commentaire
 * n'est à écrire (§118.79d). Le nom se lit dans le registre : `cleModeleRequise()`, et la phrase
 * se compose avec `phraseIaNonConfiguree` / `courtIaNonConfiguree`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const NOM_EN_DUR = "ANTHROPIC_API_KEY";

/** Les racines où vivent les refus qu'une personne lit : les actions (celles de `src/lib/actions/` et celles rangées
 * dans les modules) et les routes. */
const RACINES_SERVEUR = ["src/lib/actions", "src/modules", "src/app"];

/**
 * CE QUI N'EST PAS UNE RECOPIE, et pourquoi la règle ne le juge pas.
 *
 *  - `src/lib/ai.ts` : `cleModeleRequise()` y DÉFINIT le nom — c'est la source que tous les
 *    autres lisent. Le refuser là retournerait la règle contre ce qu'elle protège.
 *  - `src/lib/ia/` : le socle de la phrase, dont l'en-tête raconte le défaut en le nommant (et
 *    ce banc, qui doit écrire le littéral pour le chercher).
 *  - les TESTS : ils ne parlent à personne ; ils posent et retirent la variable pour exercer
 *    l'abstention.
 *
 * Aucune des deux premières n'est sous les racines aujourd'hui : elles sont écrites pour qu'un
 * élargissement des racines (à `src/lib`, par exemple) ne les juge pas par accident — et un cas
 * plus bas vérifie que le filtre tient sur un balayage qui les rencontre.
 *
 * Le module qui LIT l'environnement n'est pas exclu en entier : sa LECTURE l'est
 * (`lectureRetiree`). Un fichier qui lirait la variable par son nom ET recopierait ce nom dans
 * une phrase tomberait quand même — exempter le fichier laisserait passer la phrase.
 */
const EXCLUS = ["src/lib/ai.ts", "src/lib/ia/"];

function sources(racines: string[], extension: string): string[] {
  const out: string[] = [];
  const marche = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) marche(p);
      else if (e.name.endsWith(extension) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const r of racines) marche(join(process.cwd(), r));
  return out
    .map(rel)
    .filter((f) => !EXCLUS.some((x) => (x.endsWith("/") ? f.startsWith(x) : f === x)));
}

/**
 * La source, privée de ses LECTURES de la variable (`process.env.<nom>`, `process.env["<nom>"]`).
 * Lire l'environnement a besoin du nom exact ; ce n'est pas un refus adressé à une personne.
 */
function lectureRetiree(src: string): string {
  return src.replace(new RegExp(`process\\.env(?:\\.${NOM_EN_DUR}\\b|\\[\\s*["'\`]${NOM_EN_DUR}["'\`]\\s*\\])`, "g"), "process.env.<lecture>");
}

const recopieLeNom = (src: string): boolean => lectureRetiree(src).includes(NOM_EN_DUR);

describe("le nom de la clé d'IA ne se recopie plus dans un refus du serveur (actions, routes)", () => {
  const fichiers = sources(RACINES_SERVEUR, ".ts");

  it("la prémisse : les actions ET les routes sont lues", () => {
    // Sans elle, un balayage cassé rendrait 0 fichier et le cas suivant passerait au vert sur du
    // vide (§118.17). Mesuré à l'écriture : 148 actions, 105 fichiers `.ts` sous `src/app` — une
    // racine perdue fait tomber le compte sous le plancher, quelle que soit celle qui manque.
    expect(fichiers.length).toBeGreaterThan(200);
    expect(fichiers.some((f) => f.startsWith("src/lib/actions/"))).toBe(true);
    expect(fichiers.some((f) => f.startsWith("src/app/"))).toBe(true);
  });

  it("AUCUNE action ni route ne nomme la clé du fournisseur de RAISONNEMENT de mémoire", () => {
    const fautifs = fichiers.filter((f) => recopieLeNom(readFileSync(f, "utf8")));
    expect(
      fautifs,
      `ces fichiers serveur gravent un nom de clé que le registre seul connaît — composer le refus avec phraseIaNonConfiguree(cleModeleRequise(), "<le geste>") :\n${fautifs.join("\n")}`,
    ).toEqual([]);
  });

  it("LIRE la variable n'est pas la recopier — et la lecture ne couvre pas la phrase du même fichier", () => {
    // Les deux sens, sinon le cas ci-dessus serait désarmé en ayant l'air armé : une lecture qui
    // passe, une phrase qui tombe, et les deux ensemble qui tombent encore.
    expect(recopieLeNom(`const k = process.env.${NOM_EN_DUR} ?? "";`)).toBe(false);
    expect(recopieLeNom(`const k = process.env["${NOM_EN_DUR}"];`)).toBe(false);
    expect(recopieLeNom(`return { error: "Ajoutez la clé ${NOM_EN_DUR} (Render)." };`)).toBe(true);
    expect(recopieLeNom(`const k = process.env.${NOM_EN_DUR}; if (!k) return "Ajoutez ${NOM_EN_DUR}";`)).toBe(true);
    // Un nom qui commence pareil n'est pas une lecture de CETTE variable.
    expect(recopieLeNom(`process.env.${NOM_EN_DUR}_BIS`)).toBe(true);
  });

  it("la source du nom et le socle de la phrase restent hors du jugement, même si les racines s'élargissent", () => {
    // Le cas qui le ferait tomber : un filtre d'exclusion vidé, ou qui ne comparerait plus que le
    // nom de fichier — `src/lib/ai.ts` serait alors jugé, et refusé, pour avoir DÉFINI le nom.
    const large = sources(["src/lib"], ".ts");
    expect(large.length).toBeGreaterThan(fichiers.length);
    expect(large).not.toContain("src/lib/ai.ts");
    expect(large.some((f) => f.startsWith("src/lib/ia/"))).toBe(false);
    // …et le filtre ne retire pas plus que ce qu'il nomme : un voisin au nom proche reste jugé.
    expect(large.some((f) => f.startsWith("src/lib/ai-"))).toBe(true);
  });
});

describe("le module qui LIT l'environnement ne recopie pas non plus le nom dans ses propres refus", () => {
  // `src/lib/ai.ts` est exclu des deux jugements ci-dessus parce qu'il DÉFINIT le nom
  // (`cleModeleRequise`). Ce n'est pas un permis : « Clé ANTHROPIC_API_KEY non configurée. »
  // y survivait dans deux refus (analyse d'un rapport terrain, compte rendu de réunion) sur
  // un déploiement qui raisonne chez OpenAI — le geste nommé était faux (§118.128).
  const lignes = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf8").split("\n");
  const refus = lignes.map((l, i) => ({ l, i })).filter(({ l }) => /non configurée/.test(l) && !/^\s*(\/\/|\*)/.test(l));

  it("la prémisse : les refus du module sont lus", () => {
    expect(refus.length).toBeGreaterThanOrEqual(3);
  });

  it("aucun refus ne nomme la clé de RAISONNEMENT en dur — il la lit par `cleModeleRequise()`", () => {
    expect(refus.filter(({ l }) => l.includes("ANTHROPIC_API_KEY")).map(({ i }) => `ai.ts:${i + 1}`)).toEqual([]);
  });

  it("la clé de TRANSCRIPTION ne se nomme que là où le module la LIT, juste au-dessus", () => {
    const fautifs = refus
      .filter(({ l }) => l.includes("OPENAI_API_KEY"))
      .filter(({ i }) => !lignes.slice(Math.max(0, i - 3), i).some((x) => x.includes("process.env.OPENAI_API_KEY")))
      .map(({ i }) => `ai.ts:${i + 1}`);
    expect(fautifs).toEqual([]);
  });
});

describe("l'analyse d'un contrat de travail se nomme pareil partout où elle se refuse", () => {
  it("les deux écrans RH et l'action disent « contrat de travail » — jamais « CV »", () => {
    // Le défaut mesuré : le bouton « Analyser le contrat » expliquait, désactivé, qu'il faudrait
    // une clé pour activer « l'analyse automatique d'un CV ». La personne cherchait une analyse de
    // CV qui n'existe pas ici. Le geste se nomme UNE fois, à l'identique, aux trois endroits où il
    // se refuse : la création d'un salarié, sa fiche, et l'action elle-même.
    const geste = "l'analyse automatique d'un contrat de travail";
    for (const f of ["src/app/(app)/rh/equipe/page.tsx", "src/app/(app)/rh/[id]/employee-form.tsx", "src/modules/rh/actions.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src.includes(`"${geste}"`), `${f} : le refus doit nommer « ${geste} »`).toBe(true);
      expect(src.includes("l'analyse automatique d'un CV"), `${f} : nomme encore une analyse de CV`).toBe(false);
    }
  });
});

describe("la phrase du refus", () => {
  it("nomme le geste EXACT quand la clé est connue", () => {
    const p = phraseIaNonConfiguree("OPENAI_API_KEY", "l'assistant");
    expect(p).toContain("OPENAI_API_KEY");
    expect(p).toContain("Render");
    expect(p).toContain("l'assistant");
  });

  it("ne FABRIQUE aucun nom quand il n'a pas traversé", () => {
    // Ce qui la ferait tomber : un repli qui écrit « ANTHROPIC_API_KEY » par défaut — le défaut
    // qu'on répare, réintroduit par son propre repli.
    for (const vide of [null, undefined, "", "   "]) {
      const p = phraseIaNonConfiguree(vide, "l'assistant");
      expect(p).not.toContain("API_KEY");
      expect(p).toContain("fournisseur de raisonnement");
      expect(courtIaNonConfiguree(vide)).not.toContain("API_KEY");
    }
  });

  it("la forme courte reste une ligne, pour une infobulle", () => {
    expect(courtIaNonConfiguree("OPENAI_API_KEY")).toBe("IA non configurée (OPENAI_API_KEY absente)");
    expect(courtIaNonConfiguree("OPENAI_API_KEY").includes("\n")).toBe(false);
  });
});
