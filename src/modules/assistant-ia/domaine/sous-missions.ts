/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SOUS-MISSIONS — les RÈGLES (K3, décision 0033). Pur, navigateur compris (le tableau de bord les lit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La clé d'un titre de plan : minuscules, sans accents ni ponctuation — deux reformulations du même plan se reconnaissent. */
export function cleDeTitre(titre: unknown): string {
  return typeof titre === "string"
    ? titre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    : "";
}

/**
 * DÉMARRER D'OFFICE un plan sans geste ? La préférence de la personne, sinon la console (personne, puis rôle), sinon le
 * défaut de la Direction : OUI pour le Super Admin, NON pour les autres.
 */
export function reglageDOffice(r: { preference: boolean | null; personne: boolean | null; role: boolean | null; superAdmin: boolean }): boolean {
  return r.preference ?? r.personne ?? r.role ?? r.superAdmin;
}

/** Un statut du moteur où la sous-mission ne bougera plus sans la personne : la synthèse peut s'écrire. */
export const statutFini = (status: string): boolean => ["COMPLETED", "CANCELLED", "FAILED", "PARTIAL", "BLOCKED"].includes(status);

export interface IssueSousMission {
  titre: string;
  statut: string;
  coutUsd: number;
  extrait: string;
  document: { nom: string; lien: string } | null;
  dureeMs: number | null;
}

const ISSUE: Record<string, string> = { COMPLETED: "terminée", CANCELLED: "annulée", FAILED: "en échec", PARTIAL: "terminée en partie", BLOCKED: "bloquée" };

export const usd = (n: number): string => `${n.toFixed(2).replace(".", ",")} $`;

/** « 3 min 20 s », « 45 s », « 1 h 05 » — une durée dite. */
export function duree(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, "0")} s` : ""}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** LA RÉPONSE DE SYNTHÈSE écrite dans la conversation — un en-tête, un « en bref » éventuel, puis chaque sous-mission. */
export function phraseSynthese(issues: readonly IssueSousMission[], enBref: string | null): string {
  const faites = issues.filter((i) => i.statut === "COMPLETED").length;
  const cout = issues.reduce((s, i) => s + i.coutUsd, 0);
  const tete = issues.length > 1
    ? `**Les sous-missions sont finies** — ${faites}/${issues.length} terminée${faites > 1 ? "s" : ""}, coût total ${usd(cout)}.`
    : `**La mission « ${issues[0]?.titre ?? ""} » est ${ISSUE[issues[0]?.statut ?? ""] ?? "finie"}** — coût ${usd(cout)}.`;
  const blocs = issues.map((i, n) => {
    const lignes = [`${issues.length > 1 ? `**${n + 1}. ${i.titre}** — ${ISSUE[i.statut] ?? i.statut.toLowerCase()}` : ""}${i.dureeMs != null && issues.length > 1 ? ` (${duree(i.dureeMs)})` : ""}`];
    if (i.extrait) lignes.push(i.extrait.length >= 700 ? `${i.extrait.slice(0, 697)}…` : i.extrait);
    if (i.document) lignes.push(`Livrable : [${i.document.nom}](${i.document.lien})`);
    return lignes.filter(Boolean).join("\n\n");
  });
  return [tete, enBref ? `En bref : ${enBref}` : null, ...blocs].filter(Boolean).join("\n\n");
}

// ─────────────────────────────── Ce que le tableau de bord affiche ───────────────────────────────

export const LIBELLE_ETAPE: Record<string, string> = { FILE: "En file", EN_COURS: "En cours", FAITE: "Faite", ATTENTE: "En attente", ECHEC: "Échec", ECARTEE: "Écartée" };

/** Une mission est-elle VIVANTE (compte dans « 3 missions en cours ») ? */
export const missionVivante = (etat: string): boolean => ["EN_COURS", "EN_ATTENTE", "BUDGET_HOLD"].includes(etat);

/** L'indicateur discret de l'en-tête : « 3 missions en cours », « 1 plan à approuver », ou rien. */
export function phraseIndicateur(enCours: number, aApprouver: number): string | null {
  const p: string[] = [];
  if (enCours) p.push(`${enCours} mission${enCours > 1 ? "s" : ""} en cours`);
  if (aApprouver) p.push(`${aApprouver} à approuver`);
  return p.length ? p.join(" · ") : null;
}

/** Le pourcentage d'avancement d'une mission (les lots d'un éventail comptent à leur part). */
export function avancement(etapes: readonly { etat: string; lots: { faits: number; total: number } | null }[]): number {
  if (!etapes.length) return 0;
  const part = etapes.reduce((s, e) => s + (e.etat === "FAITE" || e.etat === "ECARTEE" ? 1 : e.lots && e.lots.total ? e.lots.faits / e.lots.total : 0), 0);
  return Math.round((part / etapes.length) * 100);
}

/** L'état d'une mission tel que le tableau de bord le dit (les états affichés du moteur des travaux). */
export const LIBELLE_MISSION: Readonly<Record<string, string>> = {
  A_APPROUVER: "À approuver", EN_COURS: "En cours", EN_ATTENTE: "En attente", BUDGET_HOLD: "Plafond atteint", EN_PAUSE: "En pause",
  BLOQUE: "Bloquée", TERMINE: "Terminée", ANNULE: "Annulée", ECHEC: "Échec",
};

/** Ce que la personne peut faire d'une mission dans cet état : la pause, la reprise, l'annulation. */
export function gestesPermis(etat: string): { pause: boolean; reprise: boolean; annuler: boolean } {
  return {
    pause: etat === "EN_COURS" || etat === "EN_ATTENTE",
    reprise: etat === "EN_PAUSE" || etat === "BUDGET_HOLD" || etat === "BLOQUE",
    annuler: etat !== "TERMINE" && etat !== "ANNULE",
  };
}
