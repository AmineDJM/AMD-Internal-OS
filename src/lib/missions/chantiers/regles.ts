/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES PURES DES CHANTIERS (lot C1, décision 0042) — zéro import : le serveur ET le tableau « Missions »
 * (composant client) les lisent. Anti-boucle, budgets, délai croissant : ce qui empêche un chantier de tourner
 * en rond en dépensant, décidé ici, une fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe du motif de pause « plafond » — le même que les travaux (`travaux/regles.ts`), l'état affiché suit. */
export const MOTIF_BUDGET_CHANTIER = "BUDGET_HOLD";

/** Les réglages de la console (Administration › IA › Chantiers) — défauts quand elle n'en dit rien. */
export interface ReglagesChantiers {
  /** Dollars de modèles (MiMo, Terra, Sol) au plus par chantier — journal K8 par `missionId`. */
  plafondUsd: number;
  /** Lancements Claude Code (premier + relances) au plus par chantier. */
  lancementsMax: number;
  deploiementsMax: number;
  /** Tentatives au plus par étape (essais métier, délai croissant). */
  tentativesMax: number;
  /** Plafonds GLOBAUX, tous chantiers confondus, par jour (Africa/Algiers). */
  jourUsdMax: number;
  jourLancementsMax: number;
  jourDeploiementsMax: number;
  /** Chantiers conduits en même temps au plus (les réservations sérialisent le reste). */
  enParallele: number;
}

export const REGLAGES_CHANTIERS_DEFAUT: ReglagesChantiers = {
  plafondUsd: 5, lancementsMax: 4, deploiementsMax: 4, tentativesMax: 3,
  jourUsdMax: 20, jourLancementsMax: 20, jourDeploiementsMax: 12, enParallele: 3,
};

const BORNES: Record<keyof ReglagesChantiers, [number, number]> = {
  plafondUsd: [0.1, 200], lancementsMax: [1, 20], deploiementsMax: [0, 20], tentativesMax: [1, 5],
  jourUsdMax: [0.5, 1000], jourLancementsMax: [1, 100], jourDeploiementsMax: [0, 100], enParallele: [1, 10],
};

/** Des réglages lus de la base (ou d'un formulaire) — chaque valeur bornée, l'absente prend le défaut. */
export function lireReglagesChantiers(v: unknown): ReglagesChantiers {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out = { ...REGLAGES_CHANTIERS_DEFAUT };
  for (const k of Object.keys(BORNES) as (keyof ReglagesChantiers)[]) {
    const n = typeof o[k] === "number" ? (o[k] as number) : typeof o[k] === "string" ? Number(String(o[k]).replace(",", ".")) : NaN;
    if (!Number.isFinite(n)) continue;
    const [min, max] = BORNES[k];
    out[k] = Math.min(max, Math.max(min, k === "plafondUsd" || k === "jourUsdMax" ? Math.round(n * 100) / 100 : Math.round(n)));
  }
  return out;
}

/** Ce qu'un chantier a consommé — et ce que tous les chantiers ont consommé aujourd'hui. */
export interface ConsommationChantier {
  coutUsd: number;
  lancements: number;
  deploiements: number;
  jourUsd: number;
  jourLancements: number;
  jourDeploiements: number;
}

const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;

/**
 * LE CHANTIER DOIT-IL DORMIR ? Rend le motif (dit à la Direction, avec les chiffres) ou `null`. `prochain` : le geste
 * qu'on s'apprête à faire — un lancement de plus, un déploiement de plus — compte AVANT d'être fait.
 */
export function motifBudgetChantier(
  c: ConsommationChantier, r: ReglagesChantiers, plafondChantierUsd: number | null, prochain?: "lancement" | "deploiement",
): string | null {
  const plafond = plafondChantierUsd ?? r.plafondUsd;
  if (c.coutUsd >= plafond) return `plafond du chantier atteint (${usd(c.coutUsd)} sur ${usd(plafond)})`;
  if (c.jourUsd >= r.jourUsdMax) return `plafond du jour des chantiers atteint (${usd(c.jourUsd)} sur ${usd(r.jourUsdMax)})`;
  if (prochain === "lancement") {
    if (c.lancements >= r.lancementsMax) return `${c.lancements} lancements de Claude Code sur ${r.lancementsMax} permis pour ce chantier`;
    if (c.jourLancements >= r.jourLancementsMax) return `${c.jourLancements} lancements de Claude Code aujourd'hui sur ${r.jourLancementsMax}`;
  }
  if (prochain === "deploiement") {
    if (c.deploiements >= r.deploiementsMax) return `${c.deploiements} déploiements sur ${r.deploiementsMax} permis pour ce chantier`;
    if (c.jourDeploiements >= r.jourDeploiementsMax) return `${c.jourDeploiements} déploiements aujourd'hui sur ${r.jourDeploiementsMax}`;
  }
  return null;
}

/** LE DÉLAI CROISSANT entre deux essais : 1 min, 2, 4, 8… plafonné (30 min par défaut). */
export function delaiCroissantMs(essai: number, baseMs = 60_000, maxMs = 30 * 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, essai - 1));
}

/**
 * LA SIGNATURE D'UN ÉCHEC — étape, check, première ligne d'erreur NORMALISÉE : ni SHA, ni nombres, ni chemins
 * temporaires, ni horodatage. Deux échecs qui ne diffèrent que par là SONT le même échec.
 */
export function signatureEchec(d: { etape: string; check?: string | null; erreur?: string | null }): string {
  const ligne = (d.erreur ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const normale = ligne
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "#")
    .replace(/\d{4}-\d{2}-\d{2}t?[\d:.]*z?/g, "#")
    .replace(/(\/tmp|\/var|c:\\)[^\s:'"]*/g, "/…")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return `${d.etape}|${(d.check ?? "").toLowerCase().trim()}|${normale}`;
}

export type DecisionAntiBoucle =
  | { action: "CORRIGER"; occurrences: number }
  /** Même signature DEUX fois : Sol, une fois, pour comprendre ce qu'on rate. */
  | { action: "ESCALADER_SOL"; occurrences: number }
  /** TROIS fois, ou les tentatives épuisées : blocage RÉEL — on s'arrête et on le dit. */
  | { action: "BLOQUER"; occurrences: number; raison: string };

/**
 * L'ANTI-BOUCLE — sur l'historique des signatures DÉJÀ vues (sans la nouvelle) et le nombre de tours faits.
 * 1ʳᵉ occurrence → corriger ; 2ᵉ → Sol une fois (si Sol a déjà vu CETTE signature : bloquer) ; 3ᵉ → bloquer.
 */
export function deciderAntiBoucle(d: {
  historique: readonly string[]; nouvelle: string; tours: number; tentativesMax: number; solDejaPour?: readonly string[];
}): DecisionAntiBoucle {
  const occurrences = d.historique.filter((s) => s === d.nouvelle).length + 1;
  if (occurrences >= 3) return { action: "BLOQUER", occurrences, raison: `le même échec s'est produit ${occurrences} fois (${d.nouvelle.split("|").slice(1).join(" — ")})` };
  if (d.tours >= d.tentativesMax) return { action: "BLOQUER", occurrences, raison: `${d.tours} tours de correction sur ${d.tentativesMax} permis, toujours rouge` };
  if (occurrences === 2) {
    if (d.solDejaPour?.includes(d.nouvelle)) return { action: "BLOQUER", occurrences, raison: "Sol a déjà été consulté sur cet échec, sans effet" };
    return { action: "ESCALADER_SOL", occurrences };
  }
  return { action: "CORRIGER", occurrences };
}

/** Les mots qui disent qu'une migration DÉTRUIT (validation de la Direction exigée). */
const DESTRUCTIF = /\b(drop\s+(table|column|index|schema|type)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop|alter\s+column\s+\S+\s+type)\b/i;
export const migrationDestructive = (sql: string): boolean => DESTRUCTIF.test(sql);
