/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES RAPPELS » — TOUS LES RAPPELS D'UNE PERSONNE, EN UNE VUE (recette du 23/11/2026).
 *
 * « Mes rappels doit marcher et montrer tous les rappels. » Le bloc ne lisait que les rappels
 * personnels en attente (50 au plus, sans suite) : ni ceux que l'assistant a posés pour la personne,
 * ni les rappels que la plateforme lui envoie (échéances proches ou dépassées, relances). Trois
 * sources, une seule liste, quatre onglets :
 *
 *   · À venir  — personnels en attente et rappels de l'assistant actifs, le plus proche d'abord ;
 *   · Échus    — personnels dont l'heure est passée et non traités, le plus ancien d'abord ;
 *   · Reçus    — échéances et relances envoyées par la plateforme (30 jours), non lues d'abord ;
 *   · Terminés — personnels terminés ou annulés, rappels de l'assistant arrêtés, le plus récent d'abord.
 *
 * Module PUR (aucun import) : la page serveur le nourrit, les composants clients le relisent (la page
 * complète `/mon-espace/rappels` et l'encart d'« Aujourd'hui »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type SourceRappel = "perso" | "assistant" | "recu";
export type OngletRappels = "a_venir" | "echus" | "recus" | "termines";

export interface RappelVue {
  /** Unique sur toute la vue : `perso:…`, `assistant:…`, `recu:…`. */
  key: string;
  id: string;
  source: SourceRappel;
  titre: string;
  note: string | null;
  lien: string | null;
  /** ISO — l'heure du rappel (personnel, assistant) ou de réception (reçu). */
  quand: string;
  /** Statut brut : PENDING, SENT, DONE, CANCELLED (personnel) ; ACTIVE, INACTIVE (assistant) ; LU, NON_LU (reçu). */
  statut: string;
  /** « toutes les semaines » — les rappels récurrents de l'assistant. */
  recurrence: string | null;
}

export const ONGLETS_RAPPELS: { cle: OngletRappels; libelle: string; vide: string }[] = [
  { cle: "a_venir", libelle: "À venir", vide: "Aucun rappel à venir. Ajoutez-en un ci-dessous, ou « Me rappeler » sur un dossier." },
  { cle: "echus", libelle: "Échus", vide: "Aucun rappel échu en attente : tout est traité." },
  { cle: "recus", libelle: "Reçus", vide: "Aucune échéance ni relance reçue ces 30 derniers jours." },
  { cle: "termines", libelle: "Terminés", vide: "Aucun rappel terminé ou annulé." },
];

export function ongletDe(r: RappelVue, maintenant: number): OngletRappels {
  if (r.source === "recu") return "recus";
  if (r.source === "assistant") return r.statut === "ACTIVE" ? "a_venir" : "termines";
  if (r.statut === "DONE" || r.statut === "CANCELLED") return "termines";
  if (r.statut === "SENT" || new Date(r.quand).getTime() <= maintenant) return "echus";
  return "a_venir";
}

/** Les rappels rangés par onglet, chaque onglet dans son ordre utile. */
export function classerRappels(rappels: readonly RappelVue[], maintenant: number): Record<OngletRappels, RappelVue[]> {
  const out: Record<OngletRappels, RappelVue[]> = { a_venir: [], echus: [], recus: [], termines: [] };
  for (const r of rappels) out[ongletDe(r, maintenant)].push(r);
  const t = (r: RappelVue) => new Date(r.quand).getTime();
  out.a_venir.sort((a, b) => t(a) - t(b));
  out.echus.sort((a, b) => t(a) - t(b));
  out.recus.sort((a, b) => Number(a.statut === "LU") - Number(b.statut === "LU") || t(b) - t(a));
  out.termines.sort((a, b) => t(b) - t(a));
  return out;
}

/** L'onglet à ouvrir d'abord : ce qui demande un geste (échus), sinon ce qui vient. */
export function ongletInitial(c: Record<OngletRappels, RappelVue[]>): OngletRappels {
  if (c.echus.length) return "echus";
  if (c.a_venir.length) return "a_venir";
  if (c.recus.some((r) => r.statut === "NON_LU")) return "recus";
  return "a_venir";
}

/** Le compte affiché dans l'en-tête du bloc : ce qui reste à traiter (à venir + échus). */
export function rappelsActifs(c: Record<OngletRappels, RappelVue[]>): number {
  return c.a_venir.length + c.echus.length;
}

// ───────────────────────────── L'encart « Mes rappels » d'Aujourd'hui ─────────────────────────────

/**
 * L'ENCART DE « AUJOURD'HUI » (maquette validée, 24/11/2026) : une seule liste, sans onglets — d'abord ce
 * qui est passé et non traité (le plus ancien d'abord), puis ce qui vient (le plus proche d'abord). Les
 * reçus et les terminés restent dans « Tous mes rappels ». `epingle` : la clé du rappel qu'on vient
 * d'ajouter — il se montre même au-delà de `limite` (un rappel créé qu'on ne voit pas semble perdu).
 */
export function rappelsDuJour(
  rappels: readonly RappelVue[], maintenant: number, limite: number, epingle?: string | null,
): { lignes: { rappel: RappelVue; passe: boolean }[]; caches: number } {
  const c = classerRappels(rappels, maintenant);
  const tous = [...c.echus.map((r) => ({ rappel: r, passe: true })), ...c.a_venir.map((r) => ({ rappel: r, passe: false }))];
  const lignes = tous.slice(0, limite);
  const nouveau = epingle ? tous.find((x) => x.rappel.key === epingle) : undefined;
  if (nouveau && !lignes.includes(nouveau)) lignes.push(nouveau);
  return { lignes, caches: tous.length - lignes.length };
}

const ALGER_MS = 3_600_000; // Alger : UTC+1, sans heure d'été.
const JOUR_MS = 86_400_000;
const JOURS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « Hier, 9 h », « Aujourd'hui, 14 h 30 », « Jeudi, 10 h », « 12 déc., 9 h » — à l'heure d'Alger. */
export function quandLisible(iso: string, maintenant: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = new Date(t + ALGER_MS);
  const m = d.getUTCMinutes();
  const heure = m ? `${d.getUTCHours()} h ${String(m).padStart(2, "0")}` : `${d.getUTCHours()} h`;
  const ecart = Math.floor((t + ALGER_MS) / JOUR_MS) - Math.floor((maintenant + ALGER_MS) / JOUR_MS);
  const memeAnnee = d.getUTCFullYear() === new Date(maintenant + ALGER_MS).getUTCFullYear();
  const jour = ecart === 0 ? "Aujourd'hui"
    : ecart === -1 ? "Hier"
      : ecart === 1 ? "Demain"
        : ecart > 1 && ecart < 7 ? JOURS[d.getUTCDay()]
          : `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}${memeAnnee ? "" : ` ${d.getUTCFullYear()}`}`;
  return `${jour}, ${heure}`;
}
