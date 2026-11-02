/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MISE À JOUR DES DOSSIERS DEPUIS UN TABLEAU (lot T3) — règles PURES, zéro import.
 *
 * « Voici l'Excel, mets à jour le statut des dossiers. » Le tableau est lu sur le serveur ; ICI, sans base ni
 * modèle :
 *   1. les COLONNES se reconnaissent par leur en-tête (référence, intitulé, statut, échéance, priorité) ;
 *   2. chaque LIGNE se rapproche d'un dossier — par sa référence (DOS-AAAA-NNN), sinon par son intitulé exact, sinon
 *      par un intitulé APPROCHÉ contrôlé (similarité ≥ 0,82 ET une marge ≥ 0,12 sur le second candidat) ; en deçà,
 *      la ligne est AMBIGUË (les candidats sont nommés) ou INTROUVABLE — jamais devinée ;
 *   3. le STATUT écrit en français (« en cours », « clôturé », « bloqué »…) se lit en statut de l'ERP ; un libellé
 *      inconnu est une ERREUR de ligne, dite, pas une valeur inventée ;
 *   4. le PLAN : ce qui change (avant → après), ce qui ne change pas, ce qui ne se fait pas et pourquoi.
 *
 * Le modèle conversationnel ne voit que le plan (références, intitulés, statuts) ; la carte le montre ; la
 * confirmation l'applique EN UN GESTE (une annulation défait tout le lot).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type StatutDossier = "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "DONE" | "ARCHIVED";
export type PrioriteDossier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const LIBELLE_STATUT_DOSSIER: Readonly<Record<StatutDossier, string>> = {
  OPEN: "Ouvert", IN_PROGRESS: "En cours", ON_HOLD: "En attente", DONE: "Abouti", ARCHIVED: "Archivé",
};
export const LIBELLE_PRIORITE_DOSSIER: Readonly<Record<PrioriteDossier, string>> = {
  LOW: "Basse", MEDIUM: "Moyenne", HIGH: "Haute", CRITICAL: "Critique",
};

/** Minuscules, sans accents, ponctuation en espaces, espaces simples. */
export function replierTexte(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const STATUTS: readonly [RegExp, StatutDossier][] = [
  [/^(archive|archivee?s?|classe sans suite)$/, "ARCHIVED"],
  [/^(abouti|aboutie|termine|terminee|clos|close|cloture|cloturee|fait|faite|fini|finie|livre|livree|realise|realisee|done|ferme|fermee|resolu|resolue|complete|completee|valide|validee|ok)$/, "DONE"],
  [/^(en attente|attente|bloque|bloquee|suspendu|suspendue|en pause|pause|on hold|en suspens|a relancer|en attente de retour|en attente retour)$/, "ON_HOLD"],
  [/^(en cours|encours|demarre|demarree|commence|commencee|in progress|en traitement|traitement|en realisation|wip)$/, "IN_PROGRESS"],
  [/^(ouvert|ouverte|nouveau|nouvelle|a demarrer|a faire|a traiter|open|todo|non demarre|non commence|cree|creee)$/, "OPEN"],
];

/** Un statut écrit par une personne → le statut de l'ERP ; `null` : illisible (jamais deviné). */
export function lireStatutDossier(brut: string | null | undefined): StatutDossier | null {
  const s = replierTexte(String(brut ?? ""));
  if (!s) return null;
  for (const k of Object.keys(LIBELLE_STATUT_DOSSIER) as StatutDossier[]) if (s === k.toLowerCase().replace("_", " ")) return k;
  for (const [re, st] of STATUTS) if (re.test(s)) return st;
  return null;
}

/** Une priorité écrite → celle de l'ERP ; `null` : illisible. */
export function lirePrioriteDossier(brut: string | null | undefined): PrioriteDossier | null {
  const s = replierTexte(String(brut ?? ""));
  if (!s) return null;
  if (/^(basse|bas|faible|low|p4)$/.test(s)) return "LOW";
  if (/^(moyenne|moyen|normale|normal|medium|p3)$/.test(s)) return "MEDIUM";
  if (/^(haute|haut|elevee|eleve|high|importante|p2)$/.test(s)) return "HIGH";
  if (/^(urgente|urgent|critique|p1|tres haute)$/.test(s)) return "CRITICAL";
  return null;
}

/**
 * Une date de tableau → AAAA-MM-JJ. Accepte AAAA-MM-JJ, JJ/MM/AAAA (et JJ-MM-AAAA, JJ.MM.AAAA), un numéro de série
 * Excel (jours depuis le 30/12/1899) et un objet Date. `null` : illisible.
 */
export function lireDateTableau(brut: unknown): string | null {
  if (brut instanceof Date) return Number.isNaN(brut.getTime()) ? null : brut.toISOString().slice(0, 10);
  if (typeof brut === "number" && brut > 20_000 && brut < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(brut) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = String(brut ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valide(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return valide(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  return null;
}

function valide(a: number, mo: number, j: number): string | null {
  const d = new Date(Date.UTC(a, mo - 1, j));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== j) return null;
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────── Les colonnes ───────────────────────────────

export type ColonneDossier = "reference" | "titre" | "statut" | "echeance" | "priorite";
export type Colonnes = Partial<Record<ColonneDossier, number>>;

const EN_TETES: readonly [ColonneDossier, RegExp][] = [
  ["reference", /^(ref|reference|n|no|numero|num|code|id|dossier ref|ref dossier|n dossier|numero dossier|reference dossier)$/],
  ["statut", /^(statut|status|etat|avancement|etape|situation|statut dossier|etat dossier|nouveau statut)$/],
  ["echeance", /^(echeance|date echeance|date limite|deadline|due date|date butoir|pour le|a rendre le|delai)$/],
  ["priorite", /^(priorite|priority|urgence|importance)$/],
  ["titre", /^(titre|intitule|libelle|objet|sujet|dossier|nom|nom du dossier|designation|description courte)$/],
];

/** Les colonnes reconnues d'un en-tête (première correspondance gagne ; une colonne n'est prise qu'une fois). */
export function reperesColonnes(entetes: readonly unknown[]): Colonnes {
  const out: Colonnes = {};
  entetes.forEach((brut, i) => {
    const h = replierTexte(String(brut ?? ""));
    if (!h) return;
    for (const [col, re] of EN_TETES) if (out[col] === undefined && re.test(h)) { out[col] = i; return; }
  });
  return out;
}

// ─────────────────────────────── Le rapprochement ───────────────────────────────

export interface DossierConnu {
  id: string;
  reference: string;
  title: string;
  status: StatutDossier;
  dueDate: string | null;
  priority: PrioriteDossier;
  /** La personne peut le MODIFIER (créateur, responsable, Direction) — sinon elle le voit seulement. */
  modifiable: boolean;
}

export interface LigneTableau {
  /** Le numéro de ligne du tableau (1 = première ligne du fichier), pour le rapport. */
  numero: number;
  reference: string | null;
  titre: string | null;
  statut: string | null;
  echeance: unknown;
  priorite: string | null;
}

const REF = /\bDOS[\s-]?(\d{4})[\s-]?(\d{1,5})\b/i;
/** « dos 2026 7 », « DOS-2026-007 » → « DOS-2026-007 » (forme de l'ERP, trois chiffres au moins). */
export function normaliserReference(brut: string | null | undefined): string | null {
  const m = REF.exec(String(brut ?? ""));
  return m ? `DOS-${m[1]}-${m[2]!.padStart(3, "0")}` : null;
}

/** Similarité de deux intitulés : Dice sur les bigrammes de caractères des textes repliés (0 → 1). */
export function similarite(a: string, b: string): number {
  const x = replierTexte(a).replace(/ /g, "");
  const y = replierTexte(b).replace(/ /g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bi = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const bx = bi(x), by = bi(y);
  let commun = 0;
  for (const [k, n] of bx) commun += Math.min(n, by.get(k) ?? 0);
  return (2 * commun) / (x.length - 1 + y.length - 1 || 1);
}

export const SEUIL_APPROCHE = 0.82;
export const MARGE_APPROCHE = 0.12;

export type Rapprochement =
  | { ligne: LigneTableau; issue: "reference" | "titre" | "approche"; dossier: DossierConnu; score?: number }
  | { ligne: LigneTableau; issue: "ambigu"; candidats: DossierConnu[] }
  | { ligne: LigneTableau; issue: "introuvable" };

export function rapprocher(ligne: LigneTableau, dossiers: readonly DossierConnu[]): Rapprochement {
  const ref = normaliserReference(ligne.reference) ?? normaliserReference(ligne.titre);
  if (ref) {
    const d = dossiers.find((x) => x.reference.toUpperCase() === ref);
    // Une référence écrite qui n'est pas parmi ceux qu'on voit : introuvable — jamais un repli sur l'intitulé
    // (une ligne « DOS-2026-014 » ne doit pas toucher un dossier homonyme).
    return d ? { ligne, issue: "reference", dossier: d } : { ligne, issue: "introuvable" };
  }
  const titre = (ligne.titre ?? "").trim();
  if (!titre) return { ligne, issue: "introuvable" };
  const exacts = dossiers.filter((d) => replierTexte(d.title) === replierTexte(titre));
  if (exacts.length === 1) return { ligne, issue: "titre", dossier: exacts[0]! };
  if (exacts.length > 1) return { ligne, issue: "ambigu", candidats: exacts };
  const notes = dossiers.map((d) => ({ d, s: similarite(d.title, titre) })).sort((a, b) => b.s - a.s);
  const [premier, second] = notes;
  if (premier && premier.s >= SEUIL_APPROCHE && (!second || premier.s - second.s >= MARGE_APPROCHE)) {
    return { ligne, issue: "approche", dossier: premier.d, score: Math.round(premier.s * 100) / 100 };
  }
  const proches = notes.filter((n) => n.s >= 0.6).slice(0, 3).map((n) => n.d);
  return proches.length ? { ligne, issue: "ambigu", candidats: proches } : { ligne, issue: "introuvable" };
}

// ─────────────────────────────── Le plan ───────────────────────────────

export interface ChangementDossier {
  id: string;
  reference: string;
  titre: string;
  numero: number;
  /** Rapproché par un intitulé APPROCHÉ : la carte le signale. */
  approche: boolean;
  avant: { status: StatutDossier; dueDate: string | null; priority: PrioriteDossier };
  apres: { status?: StatutDossier; dueDate?: string; priority?: PrioriteDossier };
}

export interface PlanMiseAJour {
  changements: ChangementDossier[];
  inchanges: { numero: number; reference: string }[];
  ambigus: { numero: number; texte: string; candidats: string[] }[];
  introuvables: { numero: number; texte: string }[];
  /** Vu mais non modifiable par la personne (ni créateur, ni responsable, ni Direction). */
  lectureSeule: { numero: number; reference: string }[];
  erreurs: { numero: number; texte: string; raison: string }[];
  /** Deux lignes pour le même dossier : la seconde est écartée. */
  doublons: { numero: number; reference: string }[];
}

const texteLigne = (l: LigneTableau) => [l.reference, l.titre].filter(Boolean).join(" — ") || `ligne ${l.numero}`;

export function planDeMiseAJour(lignes: readonly LigneTableau[], dossiers: readonly DossierConnu[]): PlanMiseAJour {
  const plan: PlanMiseAJour = { changements: [], inchanges: [], ambigus: [], introuvables: [], lectureSeule: [], erreurs: [], doublons: [] };
  const vus = new Set<string>();
  for (const ligne of lignes) {
    if (!ligne.reference && !ligne.titre && !ligne.statut) continue;
    const r = rapprocher(ligne, dossiers);
    if (r.issue === "introuvable") { plan.introuvables.push({ numero: ligne.numero, texte: texteLigne(ligne) }); continue; }
    if (r.issue === "ambigu") { plan.ambigus.push({ numero: ligne.numero, texte: texteLigne(ligne), candidats: r.candidats.map((c) => `${c.reference} « ${c.title} »`) }); continue; }
    const d = r.dossier;
    if (vus.has(d.id)) { plan.doublons.push({ numero: ligne.numero, reference: d.reference }); continue; }
    vus.add(d.id);
    const apres: ChangementDossier["apres"] = {};
    const raisons: string[] = [];
    if (ligne.statut && String(ligne.statut).trim()) {
      const st = lireStatutDossier(ligne.statut);
      if (!st) raisons.push(`statut « ${String(ligne.statut).trim()} » illisible (attendu : ouvert, en cours, en attente, abouti ou archivé)`);
      else if (st !== d.status) apres.status = st;
    }
    if (ligne.echeance !== null && ligne.echeance !== undefined && String(ligne.echeance).trim() !== "") {
      const e = lireDateTableau(ligne.echeance);
      if (!e) raisons.push(`échéance « ${String(ligne.echeance).trim()} » illisible (attendu : JJ/MM/AAAA)`);
      else if (e !== d.dueDate) apres.dueDate = e;
    }
    if (ligne.priorite && String(ligne.priorite).trim()) {
      const p = lirePrioriteDossier(ligne.priorite);
      if (!p) raisons.push(`priorité « ${String(ligne.priorite).trim()} » illisible`);
      else if (p !== d.priority) apres.priority = p;
    }
    if (raisons.length) { plan.erreurs.push({ numero: ligne.numero, texte: `${d.reference} « ${d.title} »`, raison: raisons.join(" ; ") }); continue; }
    if (!Object.keys(apres).length) { plan.inchanges.push({ numero: ligne.numero, reference: d.reference }); continue; }
    if (!d.modifiable) { plan.lectureSeule.push({ numero: ligne.numero, reference: d.reference }); continue; }
    plan.changements.push({
      id: d.id, reference: d.reference, titre: d.title, numero: ligne.numero, approche: r.issue === "approche",
      avant: { status: d.status, dueDate: d.dueDate, priority: d.priority }, apres,
    });
  }
  return plan;
}

/** « En cours → Abouti · échéance → 15/11/2026 » — une ligne de la carte. */
export function phraseChangement(c: ChangementDossier): string {
  const morceaux: string[] = [];
  if (c.apres.status) morceaux.push(`${LIBELLE_STATUT_DOSSIER[c.avant.status]} → ${LIBELLE_STATUT_DOSSIER[c.apres.status]}`);
  if (c.apres.dueDate) morceaux.push(`échéance ${c.avant.dueDate ? jjmmaaaa(c.avant.dueDate) : "—"} → ${jjmmaaaa(c.apres.dueDate)}`);
  if (c.apres.priority) morceaux.push(`priorité ${LIBELLE_PRIORITE_DOSSIER[c.avant.priority]} → ${LIBELLE_PRIORITE_DOSSIER[c.apres.priority]}`);
  return `${c.reference} « ${c.titre} » : ${morceaux.join(" · ")}${c.approche ? " (rapproché par l'intitulé)" : ""}`;
}

export const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Les changements tels que l'action de lot les reçoit (JSON) — ce qui est confirmé, rien de plus. */
export interface ChangementApplique {
  id: string;
  /** L'état lu à la proposition : une ligne qui a bougé depuis est écartée (jamais écrasée). */
  avant: { status: StatutDossier; dueDate: string | null; priority: PrioriteDossier };
  status?: StatutDossier;
  dueDate?: string;
  priority?: PrioriteDossier;
}

export const LOT_MAX = 500;

export function lireChangementsAppliques(json: string | null | undefined): ChangementApplique[] | { erreur: string } {
  let brut: unknown;
  try { brut = JSON.parse(json ?? ""); } catch { return { erreur: "Le lot de changements est illisible." }; }
  if (!Array.isArray(brut) || brut.length === 0) return { erreur: "Aucun changement à appliquer." };
  if (brut.length > LOT_MAX) return { erreur: `Au plus ${LOT_MAX} dossiers par lot.` };
  const statuts = Object.keys(LIBELLE_STATUT_DOSSIER);
  const priorites = Object.keys(LIBELLE_PRIORITE_DOSSIER);
  const out: ChangementApplique[] = [];
  for (const x of brut as Record<string, unknown>[]) {
    const av = (x?.avant ?? {}) as Record<string, unknown>;
    if (typeof x?.id !== "string" || !statuts.includes(String(av.status)) || !priorites.includes(String(av.priority))) return { erreur: "Une ligne du lot est illisible." };
    if (x.status !== undefined && !statuts.includes(String(x.status))) return { erreur: "Un statut du lot est inconnu." };
    if (x.priority !== undefined && !priorites.includes(String(x.priority))) return { erreur: "Une priorité du lot est inconnue." };
    if (x.dueDate !== undefined && !lireDateTableau(x.dueDate)) return { erreur: "Une échéance du lot est illisible." };
    out.push({
      id: x.id, avant: { status: av.status as StatutDossier, dueDate: typeof av.dueDate === "string" ? av.dueDate : null, priority: av.priority as PrioriteDossier },
      ...(x.status !== undefined ? { status: x.status as StatutDossier } : {}),
      ...(x.dueDate !== undefined ? { dueDate: lireDateTableau(x.dueDate)! } : {}),
      ...(x.priority !== undefined ? { priority: x.priority as PrioriteDossier } : {}),
    });
  }
  return out;
}
