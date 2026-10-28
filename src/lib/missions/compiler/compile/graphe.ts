/**
 * Compilateur de mission — PASSE 4 : LE GRAPHE. Disposition en vagues, cycle, profondeur, et le
 * livrable qui se produit une fois, quand les données sont là (§88).
 */
import { PLAN_LIMITS } from "@/lib/missions/planner/contract";
import { layout } from "@/lib/missions/compiler/graph";
import { issue } from "./outils";
import type { ContexteCompilation } from "./etape";

/** PASSE 4 — le graphe : un livrable produit une fois (§88), pas de cycle, une profondeur bornée, les vagues. */
export function poserLeGraphe(ctx: ContexteCompilation): ReturnType<typeof layout> {
  const { plan, issues, compiled } = ctx;
  // ── 4. LE GRAPHE ──────────────────────────────────────────────────────────────────────
  const g = layout(compiled.map((c) => ({ key: c.key, dependsOn: c.dependsOn })));

  /**
   * ── UN LIVRABLE SE PRODUIT UNE FOIS, QUAND LES DONNÉES SONT LÀ (§88) ────────────────
   *
   * MESURÉ live (chaîne budget). Le plan écrit DEUX étapes ARTIFACT au même format : un
   * « Dossier de révision budgétaire » avant les réponses, un second APRÈS — la seconde
   * descendant de la première. Résultat en base : deux fichiers Word, 1 519 et 2 735 octets.
   * Le premier ne porte AUCUN des chiffres collectés — il ne pouvait pas, ils n'étaient pas
   * encore arrivés. Deux pièces qui divergent, et le dirigeant a le choix entre un brouillon
   * et un livrable sans rien pour les distinguer.
   *
   * Le critère n'est PAS « deux pièces du même format », qui serait légitime (deux contrats,
   * deux comptes rendus). C'est la DESCENDANCE : quand la seconde dépend de la première, la
   * première n'est pas un livrable, c'est un état intermédiaire. Et un état intermédiaire est
   * un WORKER, pas un fichier déposé au Drive.
   *
   * `identiteDuLivrable` (#88) ne peut rien ici : elle réunit deux pièces de PLANS successifs,
   * pas deux pièces que le MÊME plan a délibérément demandées.
   */
  if (g.cycle.length === 0) {
    // Le format d'une pièce est ce que le plan DÉCLARE dans `expectedArtifacts.fromStep`.
    const formatDe = new Map<string, string>();
    for (const a of plan.expectedArtifacts ?? []) {
      if (a.fromStep && a.format) formatDe.set(a.fromStep, String(a.format).toUpperCase());
    }
    const pieces = compiled.filter((e) => e.nodeType === "ARTIFACT" && formatDe.has(e.key));
    const ancetres = new Map<string, Set<string>>();
    const remonter = (cle: string, vus = new Set<string>()): Set<string> => {
      const deja = ancetres.get(cle);
      if (deja) return deja;
      if (vus.has(cle)) return new Set();
      vus.add(cle);
      const out = new Set<string>();
      const noeud = compiled.find((c) => c.key === cle);
      for (const d of noeud?.dependsOn ?? []) {
        out.add(d);
        for (const a of remonter(d, vus)) out.add(a);
      }
      ancetres.set(cle, out);
      return out;
    };
    for (const aval of pieces) {
      const amonts = remonter(aval.key);
      for (const amont of pieces) {
        if (amont.key === aval.key) continue;
        if (!amonts.has(amont.key)) continue;
        const fmt = formatDe.get(amont.key) ?? "";
        if (fmt !== (formatDe.get(aval.key) ?? "")) continue;
        issues.push(issue("CARDINALITY", amont.key,
          `« ${amont.key} » et « ${aval.key} » déposent toutes deux un fichier ${fmt}, et la seconde `
          + `descend de la première : le premier fichier est donc un BROUILLON — il sera déposé avant `
          + `que les données de « ${aval.key} » n'arrivent, et il divergera du livrable définitif. `
          + `Un livrable se produit UNE fois, quand tout est là. Si tu as besoin d'un état intermédiaire, `
          + `écris une étape WORKER : elle porte le résultat sans déposer de pièce.`));
      }
    }
  }

  if (g.cycle.length > 0) {
    issues.push(issue("CYCLE", g.cycle[0],
      `le graphe contient un cycle (${g.cycle.join(" → ")}) : aucune de ces étapes ne pourra jamais partir.`));
  }
  if (g.depth > PLAN_LIMITS.depth) {
    issues.push(issue("LIMIT_EXCEEDED", null,
      `une chaîne de ${g.depth} étapes consécutives dépasse la limite de ${PLAN_LIMITS.depth}. `
      + `Une telle profondeur est presque toujours une séquence qui pouvait être parallèle.`));
  }
  for (const c of compiled) c.wave = g.wave.get(c.key) ?? 0;

  // POURQUOI IL N'Y A PAS DE VÉRIFICATION « LA SOURCE DE L'ÉVENTAIL EST-ELLE EN AMONT ? »
  //
  // Parce qu'elle ne pourrait jamais échouer : la dépendance implicite ajoutée plus haut fait de
  // `forEach.from` un ancêtre par construction. Si le planner désigne une étape située APRÈS,
  // cette même dépendance ferme un cycle — et c'est `CYCLE` qui est rapporté, ce qui est le bon
  // diagnostic. Ajouter une garde inatteignable donnerait l'illusion d'un contrôle de plus.
  return g;
}
