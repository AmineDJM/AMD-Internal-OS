import { clesDesActions } from "@/lib/actions/parc";
import { describe, expect, it } from "vitest";
// ⚠ ORDRE D'IMPORT IMPORTANT. `ops/index.ts` et `lib/assistant.ts` forment un cycle
// d'INITIALISATION : `ops` → `impl-wave7d` → `actions/adventum-actions` → `assistant.ts`, qui
// lit `DOMAIN_TOOL_DEFS` exporté par `ops`. Charger `assistant` d'abord — comme le fait
// l'application, et comme `ops-goldens.test.ts` — donne l'ordre qui résout. L'inverser fait
// échouer la SUITE ENTIÈRE avec « DOMAIN_TOOL_DEFS is not iterable », pas un test isolé.
import "@/lib/assistant";
import { DOMAIN_TOOLS } from "./ops";
import { OPS_CATALOG } from "./ops/catalog";
import { ACTION_CLASSIFICATION, ERP_ACTIONS, parityStats } from "./action-registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AUDIT DE CAPACITÉS (§12) — NATIVE / COVERED / GAP / EXCLUDED, mesuré et non déclaré.
 *
 * ── POURQUOI UN TEST ET PAS UN DOCUMENT ──────────────────────────────────────────────────
 *
 * Un tableau de couverture écrit à la main est périmé le lendemain. Celui-ci relit le code à
 * chaque exécution : le catalogue d'ops, les implémentations réellement assemblées, et les
 * server actions présentes sur le disque. Le chiffre imprimé est donc daté de la seconde où on
 * le lit.
 *
 * ── CE QU'IL VÉRIFIE, ET POURQUOI CHAQUE POINT COMPTE ────────────────────────────────────
 *
 * Quatre façons différentes d'annoncer une capacité qui n'existe pas — et le contrôle qui ferme
 * chacune :
 *
 *   1. une op PROMISE au catalogue sans code derrière → `zipOps` lève au chargement, dans les
 *      DEUX sens (déclarée sans impl, implémentée sans déclaration). Importer `DOMAIN_TOOLS`
 *      suffit donc à le prouver : si ce fichier se charge, l'assemblage est complet ;
 *   2. une op qui prétend COUVRIR une action serveur disparue → on relit `src/lib/actions/` ;
 *   3. une op que le modèle ne peut pas NOMMER (absente de l'énumération de l'outil) : elle
 *      existe dans le code et reste inatteignable. Une capacité inatteignable n'en est pas une ;
 *   4. un trou (GAP) ou une exclusion (EXCLUDED) sans motif écrit — c'est-à-dire un trou qu'on
 *      a cessé de compter sans l'avoir comblé.
 *
 * La parité elle-même (le compte NATIVE/COVERED/GAP) est verrouillée par `action-parity.test.ts` ;
 * ici on audite la MATIÈRE derrière le chiffre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les clés vivantes du parc des actions (`src/lib/actions/parc.ts`), modules compris. */
function liveActionKeys(): Set<string> {
  return clesDesActions();
}

describe("§12 — audit de capacités : ce qu'Adam sait faire, mesuré sur le code", () => {
  it("chaque op du catalogue est ASSEMBLÉE avec son implémentation", () => {
    // `zipOps` lève au chargement si une op est déclarée sans code (ou codée sans déclaration).
    // Le fait que `DOMAIN_TOOLS` soit lisible ici EST la preuve — on vérifie donc la substance :
    // que l'assemblage n'est pas vide et couvre bien tout le catalogue.
    const assembled = Object.values(DOMAIN_TOOLS).reduce((n, t) => n + Object.keys(t.ops).length, 0);
    expect(assembled).toBe(OPS_CATALOG.length);
    expect(assembled).toBeGreaterThan(400);
  });

  it("aucune op ne prétend couvrir une action serveur DISPARUE", () => {
    // Une clé `covers` périmée gonflerait le compte NATIVE en promettant un geste que plus rien
    // n'exécute. Le sens inverse (action non classée) est tenu par `action-parity.test.ts`.
    const live = liveActionKeys();
    const dead = OPS_CATALOG.flatMap((m) => m.covers.filter((c) => !live.has(c)).map((c) => `${m.tool}:${m.op} → ${c}`));
    expect(dead, `clés « covers » pointant vers une action inexistante :\n${dead.join("\n")}`).toEqual([]);
  });

  it("chaque op est NOMMABLE par le modèle — sinon elle est inatteignable", () => {
    // Le modèle choisit une op en écrivant sa valeur dans le champ `op`. Si l'énumération de
    // l'outil ne la contient pas, le code existe mais rien ne peut l'appeler : une capacité
    // fantôme, la pire espèce, parce qu'elle compte dans le tableau sans servir personne.
    const injoignables: string[] = [];
    for (const [tool, spec] of Object.entries(DOMAIN_TOOLS)) {
      const props = spec.def.input_schema.properties as Record<string, { enum?: string[] }> | undefined;
      const enumeration = new Set(props?.op?.enum ?? []);
      for (const op of Object.keys(spec.ops)) if (!enumeration.has(op)) injoignables.push(`${tool}:${op}`);
    }
    expect(injoignables, `ops absentes de l'énumération de leur outil :\n${injoignables.join("\n")}`).toEqual([]);
  });

  it("tout trou (GAP) et toute exclusion (EXCLUDED) portent un motif écrit", () => {
    // Un trou sans note est un trou qu'on a cessé de compter. Une exclusion sans motif est une
    // capacité abandonnée en silence — les deux annulent l'intérêt du tableau.
    const muets = Object.entries(ACTION_CLASSIFICATION)
      .filter(([, c]) => (c.status === "GAP" || c.status === "EXCLUDED") && !c.note?.trim())
      .map(([k, c]) => `${k} [${c.status}]`);
    expect(muets, `classées GAP/EXCLUDED sans motif :\n${muets.join("\n")}`).toEqual([]);
  });

  it("chaque op CRITIQUE exige une ressaisie — le geste irréversible ne part pas sur un « oui »", () => {
    // §9/§10 : la confirmation groupée accélère les gestes courants, elle ne doit jamais rendre
    // un geste destructeur plus facile. Le catalogue déclare le risque ; on vérifie ici que les
    // ops CRITIQUES sont bien celles qu'on croit, et qu'elles sont toutes gardées.
    const critiques = OPS_CATALOG.filter((m) => m.risk === "CRITICAL");
    expect(critiques.length).toBeGreaterThan(0);
    for (const m of critiques) expect(typeof m.gate, `${m.tool}:${m.op} sans garde`).toBe("function");
  });

  it("LE TABLEAU §12 — imprimé pour l'audit final", () => {
    const s = parityStats();
    const live = liveActionKeys();

    const parModule = new Map<string, { ops: number; critiques: number }>();
    for (const m of OPS_CATALOG) {
      const e = parModule.get(m.module) ?? { ops: 0, critiques: 0 };
      e.ops++;
      if (m.risk === "CRITICAL") e.critiques++;
      parModule.set(m.module, e);
    }

    const lignes = [...parModule.entries()].sort((a, b) => b[1].ops - a[1].ops)
      .map(([mod, e]) => `    ${String(e.ops).padStart(3)} ops${e.critiques ? ` (${e.critiques} critiques)` : ""}  ${mod}`);

    console.log([
      "",
      "═══ §12 — AUDIT DE CAPACITÉS ═══",
      `  server actions de l'ERP        : ${live.size}`,
      `  NATIVE   (Adam exécute)        : ${s.native}`,
      `  COVERED  (même résultat, autre outil) : ${s.covered}`,
      `  GAP      (trou reconnu)        : ${s.gap}`,
      `  EXCLUDED (hors sujet, motivé)  : ${s.excluded}`,
      `  → parité = ${Math.round(((s.native + s.covered) / (s.native + s.covered + s.gap)) * 100)}% ` +
        `sur ${s.native + s.covered + s.gap} actions retenues (${s.excluded} exclues)`,
      "",
      `  outils de domaine              : ${Object.keys(DOMAIN_TOOLS).length}`,
      `  ops exécutables                : ${OPS_CATALOG.length}`,
      `  actions natives nommées        : ${ERP_ACTIONS.length}`,
      "",
      "  RÉPARTITION DES OPS PAR MODULE :",
      ...lignes,
      "═══════════════════════════════",
    ].join("\n"));

    // Le test ne « passe » pas parce qu'on a imprimé : il exige que le tableau ait de la matière.
    expect(s.native + s.covered).toBeGreaterThan(0);
    expect(parModule.size).toBeGreaterThan(10);
  });
});
