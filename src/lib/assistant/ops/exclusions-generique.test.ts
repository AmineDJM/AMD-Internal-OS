// L'AIGUILLAGE D'ABORD — même cycle connu et même remède que `capabilite-parc.test.ts`.
import "@/lib/assistant";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CAPABILITY_OPS_IMPL, refusDuCheminGenerique } from "./impl-capabilite";
import { ACTION_CLASSIFICATION } from "@/lib/assistant/action-registry";
import { CONTRATS_ACTIONS, CONTRAT_PAR_ID, interdictionGenerique } from "@/platform/in-process/capacites";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE DÉCISION ÉCRITE N'EST PAS ROUVERTE PAR LE CHEMIN GÉNÉRIQUE (§118.158).
 *
 * Mesuré avant ce banc : 95 actions classées EXCLUDED sur 125 étaient appelables par l'op
 * générique d'Adam — dont `startImpersonation`, la purge irréversible des règlements, les fiches
 * de coaching et la publication sur le site public. Le registre DISAIT « pas un travail
 * d'assistant », et rien ne le lisait au moment d'agir.
 *
 * Quatre propriétés, et chacune a le cas qui la ferait tomber :
 *   1. toute action EXCLUDED lisible est refusée, et son refus CITE la décision ;
 *   2. dans l'autre sens, rien d'autre n'est refusé en plus — une règle qui refuserait TOUT
 *      passerait la première propriété (§118.17) ;
 *   3. la proposition ET l'exécution refusent, par le vrai point d'entrée de l'op ;
 *   4. la règle est lue aux trois portes, et l'op reste le SEUL appelant de production de
 *      l'exécuteur — un second appelant contournerait tout ceci sans une ligne d'erreur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const run = CAPABILITY_OPS_IMPL.run!;
const ACTEUR = {
  id: "banc-exclusions", name: "Banc", email: "banc-exclusions@t.dz", role: "SUPER_ADMIN",
  access: {}, mustChangePassword: false,
} as unknown as CurrentUser;

const EXCLUES = Object.entries(ACTION_CLASSIFICATION)
  .filter(([, c]) => c.status === "EXCLUDED")
  .map(([id, c]) => ({ id, note: (c.note ?? "").trim(), contrat: CONTRAT_PAR_ID.get(id) }))
  .filter((e) => e.contrat && !e.contrat.illisible);

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

describe("Le chemin générique honore EXCLUDED", () => {
  it("toute action EXCLUDED lisible est refusée, et le refus cite SA décision", () => {
    // PLANCHER : un registre qu'on ne lit plus rendrait ce banc vert sur une liste vide.
    expect(EXCLUES.length, "moins de 100 actions EXCLUDED lisibles : le banc ne mesure plus ce qu'il dit").toBeGreaterThanOrEqual(100);
    const ouvertes: string[] = [];
    const muettes: string[] = [];
    for (const e of EXCLUES) {
      const refus = refusDuCheminGenerique(e.contrat!);
      if (!refus) { ouvertes.push(e.id); continue; }
      // Quand les trois faits de `generique.ts` refusaient déjà, leur phrase suffit ; sinon le
      // refus doit dire la DÉCISION — c'est elle qui nomme l'écran où le geste se fait.
      if (!interdictionGenerique(e.contrat!) && !refus.includes(e.note.slice(0, 60))) muettes.push(e.id);
    }
    expect(ouvertes, "actions EXCLUDED encore appelables par Adam").toEqual([]);
    expect(muettes, "refus qui ne citent pas la décision écrite").toEqual([]);
  });

  it("rien d'autre n'est refusé EN PLUS : hors EXCLUDED, la règle est exactement celle de `generique.ts`", () => {
    const ecarts: string[] = [];
    let comparees = 0;
    for (const c of CONTRATS_ACTIONS) {
      if (c.illisible || ACTION_CLASSIFICATION[c.id]?.status === "EXCLUDED") continue;
      comparees += 1;
      if (refusDuCheminGenerique(c) !== interdictionGenerique(c)) ecarts.push(c.id);
    }
    expect(comparees).toBeGreaterThan(500);
    expect(ecarts).toEqual([]);
  });
});

describe("Par le vrai point d'entrée de l'op", () => {
  const ARTICLE = "site-web-actions:enregistrerArticle";

  it("la PROPOSITION de publier un article est refusée, et le refus nomme l'écran", async () => {
    expect(CONTRAT_PAR_ID.get(ARTICLE), "prémisse : l'action est décrite").toBeTruthy();
    // PRÉMISSE : sans la décision écrite, rien ne la refusait — sinon ce cas ne prouve rien.
    expect(interdictionGenerique(CONTRAT_PAR_ID.get(ARTICLE)!)).toBeNull();
    const r = await run.propose({ action: ARTICLE, champs: JSON.stringify({ title: "Banc", body: "## Contexte\ntexte" }) }, ACTEUR);
    expect(r && "error" in r ? r.error : "une carte a été construite").toMatch(/hors du champ d'Adam/);
    expect(r && "error" in r ? r.error : "").toContain("/site-web");
  });

  it("l'EXÉCUTION d'arguments forgés est refusée avant tout appel de l'action", async () => {
    const r = await run.execute(
      { action: ARTICLE, champs: JSON.stringify({ title: "Banc forgé", body: "## Contexte\ntexte", intention: "publier" }) },
      ACTEUR,
    );
    expect(r.ok).toBe(false);
    // LE MOTIF, pas seulement l'échec : sans la relecture, l'action serait appelée et échouerait
    // pour une AUTRE raison (aucune session dans ce banc) — un `ok: false` qui passerait au vert
    // sur le défaut même que ce cas existe pour attraper (§118.111).
    expect(r.ok ? "" : r.error).toMatch(/hors du champ d'Adam/);
  });

  it("l'usurpation d'identité, OUVERTE jusqu'ici au chemin générique, est refusée par sa décision écrite", async () => {
    const usurper = CONTRAT_PAR_ID.get("impersonation-actions:startImpersonation");
    expect(usurper, "prémisse : l'action est décrite").toBeTruthy();
    // PRÉMISSE : les trois faits de `generique.ts` la laissaient passer — c'est ce qui rend ce cas utile.
    expect(interdictionGenerique(usurper!)).toBeNull();
    const r = await run.propose({ action: "impersonation-actions:startImpersonation", champs: "{}" }, ACTEUR);
    expect(r && "error" in r ? r.error : "une carte a été construite").toMatch(/hors du champ d'Adam/);
  });
});

describe("Points d'appel (§118.49)", () => {
  const SRC = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/assistant/ops/impl-capabilite.ts"), "utf8"));

  it("la règle est lue à la fiche, à la proposition, et à l'exécution AVANT l'appel de l'action", () => {
    // Une seule lecture des trois faits de `generique.ts`, dans la règle combinée : un appel
    // direct ailleurs rouvrirait EXCLUDED à cette porte-là.
    expect(SRC.match(/interdictionGenerique\(/g) ?? []).toHaveLength(1);
    const debutRegle = SRC.indexOf("export function refusDuCheminGenerique(");
    expect(debutRegle).toBeGreaterThan(-1);
    expect(SRC.indexOf("interdictionGenerique(")).toBeGreaterThan(debutRegle);

    const fiche = SRC.slice(SRC.indexOf("const fiche ="), SRC.indexOf("const fiche =") + 300);
    expect(fiche).toMatch(/refusDuCheminGenerique\(c\)/);

    const propose = SRC.slice(SRC.indexOf("async propose("), SRC.indexOf("async execute("));
    expect(propose).toMatch(/refusDuCheminGenerique\(contrat\)/);

    const execute = SRC.slice(SRC.indexOf("async execute("));
    const lecture = execute.indexOf("refusDuCheminGenerique(");
    const appel = execute.indexOf("executerAction(");
    expect(lecture, "l'exécution ne relit pas la décision").toBeGreaterThan(-1);
    expect(appel).toBeGreaterThan(-1);
    expect(lecture, "la décision est relue APRÈS l'appel de l'action").toBeLessThan(appel);
  });

  it("l'op générique est le SEUL appelant de production de l'exécuteur", () => {
    const racine = join(process.cwd(), "src");
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) fichiers.push(p);
      }
    };
    parcourir(racine);
    const appelants = fichiers
      .filter((p) => /\bexecuterAction\s*\(/.test(sansCommentaires(readFileSync(p, "utf8"))))
      .map((p) => relative(process.cwd(), p).replace(/\\/g, "/"))
      .filter((p) => p !== "src/lib/actions/executer.ts")
      .sort();
    // PLANCHER implicite : si la définition a été renommée, l'op elle-même disparaît de la liste.
    expect(appelants).toEqual(["src/lib/assistant/ops/impl-capabilite.ts"]);
  });
});
