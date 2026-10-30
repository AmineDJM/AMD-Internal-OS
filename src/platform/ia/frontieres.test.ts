import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cibleInterne, specificateurs } from "@/platform/imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEUX PRODUITS, UN SOCLE — la frontière entre Adam et l'Assistant IA (lot J0, décision 0013).
 *
 *   • ADAM, le « Chief of Staff » du Super Admin : `lib/assistant*`, son écran (`components/chief/`,
 *     la page `/chief-of-staff`, les routes `/api/assistant/`), son pont `platform/in-process/`.
 *   • L'ASSISTANT IA, « Adventum Brain », ouvert à chacun selon ses droits : `lib/agent/`, la page
 *     `/assistant`, `components/assistant-beta/`, les routes `/api/assistant-ia/`, ses actions.
 *   • Le SOCLE IA, `src/platform/ia/` : ce que les deux utilisent. Il n'appartient à aucun.
 *
 * Trois règles, imports RELATIFS compris (`../imports`), tests compris :
 *   1. l'Assistant IA n'importe jamais Adam ;
 *   2. Adam n'importe jamais l'Assistant IA ;
 *   3. le socle n'importe ni l'un ni l'autre.
 *
 * Le jour où la frontière a été posée (base b42a952c, avec les droits métier V4-G), l'Assistant IA
 * importait Adam à 38 endroits hors tests (24 fichiers ; 45 avec les tests). Ce qui reste est la liste EXACTE ci-dessous : elle ne peut que
 * rétrécir — une entrée neuve est un couplage ajouté, une entrée disparue se RETIRE d'ici.
 * ESLint (`.eslintrc.json`, `@typescript-eslint/no-restricted-imports`) dit la même chose pendant
 * qu'on écrit ; ce test voit en plus les imports relatifs et la liste exacte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ADAM = [
  "src/lib/assistant/", "src/lib/assistant.ts", "src/lib/assistant-",
  "src/components/chief/", "src/app/(app)/chief-of-staff/", "src/app/api/assistant/",
  "src/platform/in-process/",
  // Le fichier d'actions serveur d'Adam (cartes, mémoire, pièces jointes de sa conversation).
  "src/lib/actions/assistant-actions.ts",
];
const ASSISTANT_IA = [
  "src/lib/agent/", "src/app/(app)/assistant/", "src/components/assistant-beta/", "src/app/api/assistant-ia/",
  "src/lib/actions/assistant-ia-actions.ts", "src/lib/actions/assistant-ia-consommation-actions.ts",
];
const SOCLE = ["src/platform/ia/"];

/**
 * CE QUI RESTE — chaque entrée nommée, avec la raison pour laquelle elle ne se défait pas sans
 * changer de comportement. Phase B (le déménagement de l'Assistant IA en module) les reprend.
 */
const RESIDUS = [
  // LE CATALOGUE D'OUTILS D'ADAM, emprunté tel quel par l'Assistant IA (décisions 0001 Q7/Q20 et 0012) :
  //   • `outils-v1.ts` — les schémas et les conditions d'accès (`assistantToolsFor`), les lectures
  //     (`executeReadTool`, et `executePowerTool` pour les lectures ouvertes par droit), les cartes d'écriture
  //     (`buildProposal`) et les outils de domaine (`DOMAIN_TOOLS`) ;
  //   • `assistant-ia-actions.ts` — l'exécution, à la confirmation, de ces mêmes cartes (`performAction`).
  // Leur fermeture fait 284 fichiers, 92 % d'Adam : les sortir est une décision d'architecture (rapport de
  // phase B, décision 0013 §4), pas un déménagement mécanique.
  "src/lib/actions/assistant-ia-actions.ts → src/lib/assistant",
  "src/lib/agent/outils-v1.ts → src/lib/assistant",
  "src/lib/agent/outils-v1.ts → src/lib/assistant/ops",
  "src/lib/agent/outils-v1.ts → src/lib/assistant/power-tools",
  // Un TEST de bout en bout : la carte `send_message`, confirmée sans le droit, est refusée par `performAction`.
  "src/lib/agent/limites.test.ts → src/lib/assistant",
];

const dans = (f: string, perimetre: string[]): boolean =>
  perimetre.some((p) => f.startsWith(p) || `${f}/`.startsWith(p) || (/\.tsx?$/.test(p) && f === p.replace(/\.tsx?$/, "")));

function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

interface Arete { from: string; to: string }

function aretes(): Arete[] {
  const out: Arete[] = [];
  for (const from of fichiers("src")) {
    for (const spec of specificateurs(fs.readFileSync(from, "utf8"))) {
      const to = cibleInterne(spec, from);
      if (to) out.push({ from, to: to.replace(/\/index$/, "") });
    }
  }
  return out;
}

describe("Adam, l'Assistant IA et leur socle — la frontière (décision 0013)", () => {
  const toutes = aretes();
  const fautes = (de: string[], vers: string[]): string[] =>
    [...new Set(toutes.filter((a) => dans(a.from, de) && dans(a.to, vers)).map((a) => `${a.from} → ${a.to}`))].sort();

  const iaVersAdam = fautes(ASSISTANT_IA, ADAM);
  const adamVersIa = fautes(ADAM, ASSISTANT_IA);
  const socle = fautes(SOCLE, [...ADAM, ...ASSISTANT_IA]);

  it("3 · le socle n'importe ni Adam ni l'Assistant IA — zéro, sans exception", () => {
    expect(socle, "src/platform/ia/ est SOUS les deux produits : déplacer ici ce dont il a besoin, ou passer par un port").toEqual([]);
  });

  it("1 et 2 · aucun import croisé hors la liste nommée des résidus — et la liste reste exacte", () => {
    expect(
      [...iaVersAdam, ...adamVersIa].sort(),
      "un import croisé neuf : ce que les deux partagent va au socle (src/platform/ia/) ; un résidu défait se retire de RESIDUS",
    ).toEqual([...RESIDUS].sort());
  });

  it("Adam n'importe plus rien de l'Assistant IA (phase B : la confirmation de l'IA a quitté le fichier d'Adam)", () => {
    expect(adamVersIa).toEqual([]);
  });

  it("les périmètres désignent des fichiers qui existent — une frontière sur un chemin mort ne garde rien", () => {
    const tous = fichiers("src");
    for (const p of [...ADAM, ...ASSISTANT_IA, ...SOCLE]) {
      expect(tous.some((f) => f.startsWith(p)), p).toBe(true);
    }
    // L'écran d'Adam est sorti de `/assistant` : ce dossier ne porte plus que l'Assistant IA.
    expect(fichiers("src/app/(app)/assistant").filter((f) => !f.startsWith("src/app/(app)/assistant/beta/") && f !== "src/app/(app)/assistant/page.tsx")).toEqual([]);
  });
});
