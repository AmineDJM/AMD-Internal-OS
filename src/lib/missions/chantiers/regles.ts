/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES PURES DES CHANTIERS (lot C1, décision 0042) — zéro import : le serveur ET le tableau « Missions »
 * (composant client) les lisent. Anti-boucle, budgets, délai croissant : ce qui empêche un chantier de tourner
 * en rond en dépensant, décidé ici, une fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe du motif de pause « plafond » — le même que les travaux (`travaux/regles.ts`), l'état affiché suit. */
export const MOTIF_BUDGET_CHANTIER = "BUDGET_HOLD";
/**
 * Le préfixe du motif de pause « attend tes consignes » (Direction, 02/11) : jamais d'échec sec quand Adam ne sait plus
 * avancer seul (24 h sans commit, plafond de corrections, même panne après Sol). La branche reste réservée ; une
 * consigne de la Direction (`consigne_chantier`) la transmet à la session et reprend le chantier.
 */
export const MOTIF_CONSIGNES_CHANTIER = "ATTEND_CONSIGNES";

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
  /**
   * L'AUTO-FIX D'ABORD (décision de la Direction, 01/11/2026) : sur un rouge, attendre ce temps qu'une correction native
   * de la session (Auto-fix de la PR) pousse un commit — gratuit — avant de relancer quoi que ce soit. 0 = coupé.
   */
  autofixMinutes: number;
  /** Heures sans commit avant de demander les consignes de la Direction (Direction, 02/11 : 24 h, l'ERP est gros). */
  attenteCommitHeures: number;
  /** Toutes les N heures sans commit : « où en es-tu ? » à la MÊME session ; sans réponse au tour suivant, relance. */
  relanceSansCommitHeures: number;
  /** Corrections (relances sur un rouge) au plus ; au-delà : pause « attend tes consignes », jamais un échec silencieux. */
  correctionsMax: number;
  /** Au N-ième rouge, la Direction est PRÉVENUE (ce qui casse, ce qui a été essayé, ce qui va l'être) — sans arrêt. */
  alerteApresEchecs: number;
}

export const REGLAGES_CHANTIERS_DEFAUT: ReglagesChantiers = {
  // `lancementsMax` 4 (Direction, 01/11) : seules les sessions NEUVES comptent — corrections dans la même session, commentaires
  // de PR et « où en es-tu ? » n'en consomment pas.
  plafondUsd: 5, lancementsMax: 4, deploiementsMax: 4, tentativesMax: 3,
  jourUsdMax: 20, jourLancementsMax: 20, jourDeploiementsMax: 12, enParallele: 3, autofixMinutes: 15,
  attenteCommitHeures: 24, relanceSansCommitHeures: 4, correctionsMax: 8, alerteApresEchecs: 3,
};

const BORNES: Record<keyof ReglagesChantiers, [number, number]> = {
  plafondUsd: [0.1, 200], lancementsMax: [1, 40], deploiementsMax: [0, 20], tentativesMax: [1, 5],
  jourUsdMax: [0.5, 1000], jourLancementsMax: [1, 100], jourDeploiementsMax: [0, 100], enParallele: [1, 10], autofixMinutes: [0, 120],
  attenteCommitHeures: [6, 72], relanceSansCommitHeures: [1, 24], correctionsMax: [3, 30], alerteApresEchecs: [1, 10],
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
/**
 * LE PLUS STRICT DU PLAN ET DE LA CONSOLE (C2) — le budget écrit dans le plan approuvé (`budget.usd`, `lancements`,
 * `deploiements`, `tentatives`) ne peut que RESSERRER les réglages de la console, jamais les relâcher. Pur.
 */
export function reglagesDuPlan(r: ReglagesChantiers, b: { usd?: number; lancements?: number; deploiements?: number; tentatives?: number } | null | undefined): ReglagesChantiers {
  const min = (x: number, y: number | undefined) => (typeof y === "number" && Number.isFinite(y) && y > 0 ? Math.min(x, y) : x);
  return {
    ...r,
    plafondUsd: min(r.plafondUsd, b?.usd),
    lancementsMax: min(r.lancementsMax, b?.lancements),
    deploiementsMax: min(r.deploiementsMax, b?.deploiements),
    tentativesMax: min(r.tentativesMax, b?.tentatives),
    correctionsMax: min(r.correctionsMax, b?.tentatives),
  };
}

export function motifBudgetChantier(
  c: ConsommationChantier, r: ReglagesChantiers, plafondChantierUsd: number | null, prochain?: "lancement" | "deploiement",
): string | null {
  // Le plafond du chantier (fixé à la proposition) ne dépasse jamais celui des réglages en vigueur.
  const plafond = Math.min(plafondChantierUsd ?? r.plafondUsd, r.plafondUsd);
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
  | { action: "CORRIGER"; occurrences: number; alerte: boolean }
  /** Même signature DEUX fois : Sol, une fois, pour changer d'approche. */
  | { action: "ESCALADER_SOL"; occurrences: number; alerte: boolean }
  /** Plafond de corrections, ou même panne APRÈS Sol : pause « attend tes consignes » (jamais un échec sec). */
  | { action: "CONSIGNES"; occurrences: number; raison: string };

/**
 * L'ANTI-BOUCLE (Direction, 02/11 : « autonome, réessayer si c'est rouge, me prévenir au bout de la 3, suivre mes
 * consignes ») — sur l'historique des signatures DÉJÀ vues (sans la nouvelle) et le nombre de corrections faites :
 *   • la boucle CONTINUE seule : 1ʳᵉ occurrence d'une panne → corriger ; 2ᵉ → Sol, une fois, pour changer d'approche ;
 *   • `alerte` au N-ième rouge (défaut 3ᵉ) : la Direction est prévenue, la boucle continue ;
 *   • CONSIGNES : la même panne revient APRÈS Sol (l'approche ne marche pas), ou le plafond de corrections est atteint.
 */
export function deciderAntiBoucle(d: {
  historique: readonly string[]; nouvelle: string; tours: number; correctionsMax: number; alerteApresEchecs?: number; solDejaPour?: readonly string[];
}): DecisionAntiBoucle {
  const occurrences = d.historique.filter((s) => s === d.nouvelle).length + 1;
  if (d.tours >= d.correctionsMax) return { action: "CONSIGNES", occurrences, raison: `${d.tours} corrections sur ${d.correctionsMax} permises, toujours rouge` };
  if (occurrences >= 2 && d.solDejaPour?.includes(d.nouvelle)) {
    return { action: "CONSIGNES", occurrences, raison: `le même échec revient après l'analyse de Sol (${occurrences} fois : ${d.nouvelle.split("|").slice(1).join(" — ")}) — il faut changer d'approche` };
  }
  // Le N-ième ROUGE : le premier contrôle (tour 0) puis chaque correction ratée.
  const alerte = d.tours + 1 === (d.alerteApresEchecs ?? 3);
  if (occurrences >= 2) return { action: "ESCALADER_SOL", occurrences, alerte };
  return { action: "CORRIGER", occurrences, alerte };
}

/** Les mots qui disent qu'une migration DÉTRUIT (validation de la Direction exigée). */
const DESTRUCTIF = /\b(drop\s+(table|column|index|schema|type)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop|alter\s+column\s+\S+\s+type)\b/i;
export const migrationDestructive = (sql: string): boolean => DESTRUCTIF.test(sql);
/** Le premier geste destructeur d'un SQL (« DROP TABLE », « TRUNCATE »…), pour le dire sur la carte ; `null` sinon. */
export const gesteDestructif = (sql: string): string | null => sql.match(DESTRUCTIF)?.[0]?.replace(/\s+/g, " ").toUpperCase() ?? null;
/** Un fichier de migration SQL (Prisma : `prisma/migrations/<nom>/migration.sql`, et tout `migrations/…/*.sql`). */
export const estMigrationSql = (chemin: string): boolean => /(^|\/)migrations?\/.+\.sql$/i.test(chemin);
