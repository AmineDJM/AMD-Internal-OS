import type { WorkspaceBlock, WorkspaceGauge } from "@/platform/ia/workspace/protocol";

/**
 * LES VISUELS DE L'UI GÉNÉRATIVE (lot K1, ajout de la Direction du 31/10/2026) — « qu'il utilise plus de graphiques,
 * de visuels ». Trois composants de plus, dessinés par des blocs qui existent déjà :
 *
 *   • `kpi`      des indicateurs (un montant, un nombre, un taux) → bloc `viz` de forme `cartes` ;
 *   • `gauge`    une jauge consommé / engagé / disponible, un avancement → bloc `progress` ;
 *   • `timeline` une chronologie datée (l'histoire d'un dossier) → bloc `timeline`.
 *
 * La règle des nombres est celle de `composants.ts` : chaque chiffre doit venir d'un outil du tour (`prouve`) ; un
 * composant dont un chiffre ne se retrouve pas est retiré. Une jauge sans total ne prétend pas un pourcentage qu'elle
 * n'a pas lu. Pur.
 */

export const COMPOSANTS_VISUELS = ["kpi", "gauge", "timeline"] as const;
export type ComposantVisuel = (typeof COMPOSANTS_VISUELS)[number];

export const CONSIGNE_VISUELS = [
  '- {"type":"kpi","title":"…","items":[{"label":"Disponible","value":"3 931 306,05 DZD","detail":"sur 4 442 306,05 DZD restants"}]} — 1 à 4 indicateurs clés (un montant, un nombre, un taux), copiés de tes outils.',
  '- {"type":"gauge","title":"…","gauges":[{"label":"Engagé","value":511000,"total":4442306.05,"unit":"DZD"}]} — une jauge : consommé / engagé / disponible d\'une enveloppe, avancement d\'un dossier ; value et total viennent de tes outils.',
  '- {"type":"timeline","title":"…","events":[{"date":"2026-10-12","label":"Dépôt ANPP","detail":"…"}]} — une chronologie DATÉE (histoire d\'un dossier, d\'une demande).',
].join("\n");

/** QUAND UN VISUEL — dit au modèle, une règle par forme (la Direction veut le visuel dès qu'il aide, et pas avant). */
export const CHOIX_DU_VISUEL = [
  "CHOISIS LE VISUEL dès qu'il aide à lire — sinon aucun :",
  "- un montant d'enveloppe, un budget, un reste → kpi (le chiffre clé) + gauge (consommé / engagé / disponible) ;",
  "- une comparaison entre catégories ou une série dans le temps → chart (ou l'analyse calculée, si tu as appelé analyser_donnees) ;",
  "- une liste de demandes, de dossiers, de tâches (3 lignes et plus) → table ;",
  "- un circuit, une procédure → steps ; l'histoire datée d'un dossier → timeline ;",
  "- une personne, un dossier, un produit → card ;",
  "- une question simple, une salutation, une réponse d'une phrase ou une définition → AUCUN composant.",
].join("\n");

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const tab = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const t = v.replace(/[\s  ]/g, "").replace(/(DZD|DA|%)$/i, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

export type Retrait = "vide" | "chiffre-non-source";

/**
 * UN VISUEL EN BLOC — ou la raison de son retrait. `prouve(texte)` : tous les chiffres du texte viennent des outils ;
 * `connu(n)` : ce nombre-là en vient.
 */
export function visuelEnBloc(
  type: ComposantVisuel, c: Record<string, unknown>, titre: string,
  prouve: (texte: string) => boolean, connu: (n: number) => boolean,
): WorkspaceBlock | Retrait {
  switch (type) {
    case "kpi": {
      const items = tab(c.items ?? c.kpis ?? c.indicateurs).map(obj).filter((x): x is Record<string, unknown> => !!x)
        .map((x) => ({ titre: str(x.label, 60), valeur: [str(x.value ?? x.valeur, 60), str(x.unit ?? x.unite, 10)].filter(Boolean).join(" "), detail: str(x.detail, 160) || null }))
        .filter((x) => x.titre && x.valeur).slice(0, 4);
      if (!items.length) return "vide";
      if (!prouve(items.flatMap((x) => [x.valeur, x.detail ?? ""]).join("\n"))) return "chiffre-non-source";
      return { kind: "viz", title: titre || "Indicateurs", type: "cartes", donnees: { cartes: items } };
    }
    case "gauge": {
      const gauges: WorkspaceGauge[] = [];
      for (const x of tab(c.gauges ?? c.jauges).map(obj)) {
        if (!x) continue;
        const valeur = num(x.value ?? x.valeur);
        const total = num(x.total);
        const label = str(x.label, 60);
        if (!label || valeur === null) continue;
        // Sans total, `valeur` est lue comme un pourcentage : elle doit l'être (0–100) et venir d'un outil.
        if (total === null && (valeur < 0 || valeur > 100)) continue;
        if (!connu(valeur) || (total !== null && !connu(total))) return "chiffre-non-source";
        const detail = str(x.detail, 120) || null;
        if (detail && !prouve(detail)) return "chiffre-non-source";
        gauges.push({ label, valeur, total, unite: str(x.unit ?? x.unite, 12) || null, detail });
      }
      if (!gauges.length) return "vide";
      return { kind: "progress", title: titre || "Avancement", gauges: gauges.slice(0, 6) };
    }
    case "timeline": {
      const steps = tab(c.events ?? c.evenements ?? c.steps).map(obj).filter((x): x is Record<string, unknown> => !!x)
        .map((x) => ({ date: str(x.date, 20) || null, label: str(x.label, 160), detail: str(x.detail, 300) || null }))
        .filter((x) => x.label).slice(0, 20);
      if (steps.length < 2) return "vide";
      // Les DATES d'une chronologie viennent elles aussi des outils (une année, un jour inventés sont des chiffres).
      if (!prouve(steps.flatMap((x) => [x.date ?? "", x.label, x.detail ?? ""]).join("\n"))) return "chiffre-non-source";
      return { kind: "timeline", title: titre || "Chronologie", steps };
    }
  }
}
