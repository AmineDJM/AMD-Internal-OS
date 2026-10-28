import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN `catch` NE TAIT PAS SON ERREUR (lot V3-E « Fiabilité », audit 27/10 INFRA-07).
 *
 * Mesuré sur la base du lot : 1 211 `.catch(() => valeur)` hors tests. Chacun jetait l'erreur sans
 * un mot ; une base en panne se lisait « rien à faire » dans l'écran du DG. Ils passent désormais
 * par un `catch` NOMMÉ (`src/lib/journal.ts`) :
 *
 *   .catch(sansBloquer("centre-adpro.visas", []))    // panne tolérée : journalisée, comptée, alertée
 *   .catch(attendu("fichier facultatif", null))       // rejet normal : la raison est écrite
 *
 * Deux règles :
 *   1. CÔTÉ SERVEUR, ZÉRO — sauf les exceptions NOMMÉES ci-dessous, chacune motivée ;
 *   2. CÔTÉ CLIENT (`"use client"`), un CLIQUET au chiffre mesuré : ce qui reste convertit l'échec
 *      en un état VISIBLE (« Le Drive n'a pas répondu. ») — l'erreur n'est pas tue pour la
 *      personne, seulement pour la console. Il ne peut que baisser.
 *
 * Un `catch` qui ignore son paramètre se reconnaît à sa flèche sans argument : `.catch(() => …)`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) {
      if (nom !== "__tests__") fichiers(chemin, acc);
    } else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

/** Commentaires retirés : la prose qui CITE l'ancien geste ne compte pas (§118.79d). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const CATCH_MUET = /\.catch\(\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\))/g;

/**
 * LES EXCEPTIONS SERVEUR — chemin exact, nombre exact, raison. Une ligne de plus ici est une
 * décision de revue, pas un contournement.
 */
const EXCEPTIONS_SERVEUR: Record<string, { n: number; raison: string }> = {
  "src/lib/mail.ts": {
    n: 1,
    raison: "fermeture d'une connexion IMAP inactive : si `logout` échoue, on ferme la socket — l'erreur n'a plus de destinataire",
  },
  "src/lib/storage/zip-reponse.ts": {
    n: 1,
    raison: "le cache oublie une lecture d'archive en échec ; l'erreur elle-même est rendue à l'appelant qui attend la même promesse",
  },
};

/**
 * Mesuré à la fin du lot V3-E : 10 `catch` muets dans les composants client, tous convertis en un
 * état visible à l'écran (message d'erreur, liste vide annoncée). Il ne peut que baisser — 9 après le lot V4
 * « code mort » (un composant client orphelin supprimé).
 */
const PLAFOND_CLIENT = 9;

describe("les `catch` muets", () => {
  const parc = fichiers(SRC).map((f) => {
    const brut = readFileSync(f, "utf8");
    return {
      f: relative(process.cwd(), f).split("\\").join("/"),
      client: /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(brut),
      n: (sansCommentaires(brut).match(CATCH_MUET) ?? []).length,
    };
  });

  it("la garde lit bien le parc (plancher de fichiers)", () => {
    expect(parc.length).toBeGreaterThan(1000);
  });

  it("le motif reconnaît la flèche sans argument, et pas un `catch` qui lit son erreur", () => {
    const n = (s: string) => (s.match(CATCH_MUET) ?? []).length;
    expect(n("p.catch(() => [])")).toBe(1);
    expect(n("p.catch( () => { }")).toBe(1);
    expect(n("p.catch(function () { return 0 })")).toBe(1);
    expect(n('p.catch(sansBloquer("x", []))')).toBe(0);
    expect(n("p.catch((e) => journal.erreur('x', {}, e))")).toBe(0);
  });

  it("côté serveur : zéro, hors exceptions nommées et motivées", () => {
    const fautes = parc
      .filter((x) => !x.client && x.n > 0)
      .filter((x) => EXCEPTIONS_SERVEUR[x.f]?.n !== x.n)
      .map((x) => `${x.f} : ${x.n} \`.catch(() => …)\` — passer par sansBloquer("nom", repli) ou attendu("raison", repli) (src/lib/journal.ts)`);
    expect(fautes).toEqual([]);
  });

  it("une exception serveur qui n'a plus lieu d'être se retire de la liste", () => {
    const perimees = Object.keys(EXCEPTIONS_SERVEUR).filter((f) => !parc.some((x) => x.f === f && x.n > 0));
    expect(perimees).toEqual([]);
  });

  it(`côté client : le cliquet ne remonte pas (plafond ${PLAFOND_CLIENT})`, () => {
    const client = parc.filter((x) => x.client && x.n > 0);
    const total = client.reduce((s, x) => s + x.n, 0);
    expect(
      total,
      `${total} \`.catch(() => …)\` côté client (plafond ${PLAFOND_CLIENT}) :\n${client.map((x) => `  ${x.n}  ${x.f}`).join("\n")}\n` +
        "Un écran neuf passe par sansBloquer/attendu, ou montre l'échec. Si le chiffre a BAISSÉ, abaisser le plafond.",
    ).toBeLessThanOrEqual(PLAFOND_CLIENT);
    expect(total, `le parc client est descendu à ${total} : abaisser PLAFOND_CLIENT au chiffre mesuré`).toBe(PLAFOND_CLIENT);
  });
});
