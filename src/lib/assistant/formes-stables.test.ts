import { describe, expect, it } from "vitest";
import fs from "node:fs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ONZE CAPACITÉS RENDAIENT UNE FORME DIFFÉRENTE SELON CE QU'ELLES TROUVAIENT (§118.20).
 *
 * Le recensement était écrit dans la doctrine, chiffré, et rien ne l'empêchait de se rouvrir :
 * la prochaine capacité qui renverrait `return "Aucun…"` au lieu d'un objet passerait sans un
 * mot, et le planificateur — qui écrit ses références AVANT de savoir ce que la lecture rendra —
 * paierait une étape morte plus une replanification complète.
 *
 * ── CE QUE CE TEST VÉRIFIE, ET POURQUOI IL LIT LA SOURCE ────────────────────────────────
 *
 * Appeler les onze capacités demanderait onze jeux de données ERP semés, et surtout leurs cas
 * ADVERSES (l'homonymie, la référence inconnue, la source éteinte) — précisément ceux qu'on
 * n'arrive jamais à reproduire tous. La propriété qu'on protège, elle, est LEXICALE : une
 * capacité qui rend une PHRASE au lieu d'un objet. On la lit donc dans le code, à l'endroit
 * exact où elle se réintroduirait.
 *
 * CE QUI FERAIT TOMBER CE TEST : écrire `return "Aucun dossier trouvé."` ou
 * `` return `Aucune trace de « ${x} »` `` dans l'une des capacités réparées. C'est exactement la
 * ligne qu'on a retirée onze fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les fichiers réparés, et la capacité qui y vivait. */
const REPAREES: { fichier: string; capacites: string[] }[] = [
  { fichier: "src/lib/assistant/what-changed.ts", capacites: ["what_changed"] },
  { fichier: "src/lib/assistant/document-discovery.ts", capacites: ["search_documents", "find_documents"] },
  { fichier: "src/lib/assistant/memory-tools.ts", capacites: ["recall_conversation", "list_commitments"] },
  { fichier: "src/lib/assistant/three-sixty.ts", capacites: ["person_report", "product_360", "supplier_360"] },
  { fichier: "src/lib/assistant/executive-brief-tools.ts", capacites: ["create_report"] },
  { fichier: "src/lib/assistant/regulatory-read.ts", capacites: ["regulatory_workload"] },
  { fichier: "src/lib/assistant/executive-tools/inspect-record.ts", capacites: ["inspect_record"] },
];

/**
 * UN REFUS RENDU EN PROSE. On cherche la forme exacte qui a coûté onze réparations : un `return`
 * dont la valeur est une chaîne commençant par une négation française.
 */
const REFUS_EN_PROSE = /return\s+[`"'](?:Aucun|Aucune|Rien|Pas de|Il n'y a)/;

/**
 * `executive-tools.ts` a été découpé (lot V4) : le balayage du refus en prose couvre TOUT le dossier,
 * comme il couvrait tout l'ancien fichier — pas seulement le morceau qui porte `inspect_record`.
 */
const DOSSIER_EXECUTIF = "src/lib/assistant/executive-tools";
const BALAYES: { fichier: string; capacites: string[] }[] = [
  ...REPAREES,
  ...fs.readdirSync(DOSSIER_EXECUTIF)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "inspect-record.ts")
    .map((f) => ({ fichier: `${DOSSIER_EXECUTIF}/${f}`, capacites: ["inspect_record"] })),
];

describe("§118.20 — la forme d'une sortie ne dépend jamais de la donnée", () => {
  it("aucune capacité réparée ne rend une PHRASE là où elle rendait un objet", () => {
    const fautes: string[] = [];
    for (const { fichier, capacites } of BALAYES) {
      const src = fs.readFileSync(fichier, "utf8");
      for (const [i, ligne] of src.split("\n").entries()) {
        if (ligne.trim().startsWith("*") || ligne.trim().startsWith("//")) continue;
        if (REFUS_EN_PROSE.test(ligne)) {
          fautes.push(`${fichier}:${i + 1} (${capacites.join(", ")}) — ${ligne.trim().slice(0, 90)}`);
        }
      }
    }
    expect(fautes, "une capacité est retombée dans le refus en prose (§118.20)").toEqual([]);
  });

  it("chaque capacité réparée porte bien une clé qui DIT l'absence dans les deux cas", () => {
    // Une liste vide, un `null`, ou une phrase `precision` : il faut au moins l'un des trois,
    // sans quoi « rien trouvé » redevient indistinguable de « je n'ai pas cherché ».
    for (const { fichier } of REPAREES) {
      const src = fs.readFileSync(fichier, "utf8");
      expect(/precision|resultatListe|retenu|repondre|vue360|fiche\(/.test(src), `${fichier} n'a plus d'enveloppe stable`).toBe(true);
    }
  });

  it("le cas VIDE et le cas PLEIN d'une liste partagent la même enveloppe", () => {
    // `resultatVide` existait seul : le cas plein rendait `{produits}`, `{collegues}`, `{taches}`
    // — jamais `items`, jamais `count`. Les deux sorties n'avaient pas UNE clé en commun.
    const src = fs.readFileSync("src/lib/assistant/empty-result.ts", "utf8");
    expect(src).toContain("export function resultatVide");
    expect(src, "le pendant du cas plein a disparu").toContain("export function resultatListe");
    for (const f of ["resultatVide", "resultatListe"]) {
      const corps = src.slice(src.indexOf(`export function ${f}`));
      expect(corps.slice(0, 400), `${f} doit rendre items + count + message`).toMatch(/items[^]*count[^]*message/);
    }
  });

  it("le contrôle de flux ne se décide plus sur un PRÉFIXE de chaîne", () => {
    /**
     * `inspect_record` relançait sa recherche en comparant le début de sa propre sortie
     * (« Aucun dossier ne porte la référence »). Deux défauts dans la même ligne : la forme
     * dépendait de la donnée, et le contrôle de flux tenait à une chaîne que n'importe quelle
     * reformulation aurait cassée en silence.
     */
    const src = fs.readFileSync("src/lib/assistant/executive-tools/inspect-record.ts", "utf8");
    expect(src).not.toMatch(/\.startsWith\(AUCUN\)/);
    expect(src, "`inspecter` doit DIRE s'il a trouvé").toMatch(/Promise<\{ trouve: boolean; charge: string \}>/);
  });
});
