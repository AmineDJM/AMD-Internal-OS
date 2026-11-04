import { dureeLisible, observer, type Observation } from "./contrat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PROJECTEURS (lot I1, décision 0063) — un par NATURE d'objet, pas par outil : carte (et ses mails), fichier, mission,
 * effet sortant, lecture tabulaire. Règles PURES : ils projettent ce que l'infra a LU (intention, HTML et texte réellement
 * préparés, fichier, mission en base) ; ils ne lisent rien eux-mêmes.
 *
 * Ces fonctions sont STABLES : la session P1 (missions) branche sa vue de mission sur `projeterMission`, I3 (primitives) ses
 * observations de `produire` / `fichier` sur `natureDuRendu` et `projeterFichier`. Ajouter un attribut est permis ; en
 * retirer un se décide (le contrôle final de I5 compare ces attributs au message).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Le rendu d'un mail, lu sur le HTML et le texte RÉELS ───────────────────────────────

export interface RenduObserve {
  /** « texte brut », « HTML sobre », « HTML à la charte », « HTML mixte (charte en partie) ». */
  rendu: string;
  tableaux: number;
  bandeau: boolean;
  /** Les couleurs non neutres employées (accent de charte), au plus 4. */
  couleurs: string[];
  /** Éléments de texte (paragraphes, listes, cellules) portant une couleur d'accent. */
  elementsColores: number;
  paragraphes: number;
}

const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const developper = (h: string) => (h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h).toUpperCase();
/** Une couleur « d'accent » : saturée (écart entre canaux > 60) — les gris, les bleus ardoise du texte courant et les blancs n'en sont pas. */
function estAccent(hex: string): boolean {
  const h = developper(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 60;
}

/**
 * LA NATURE DU RENDU — calculée sur le HTML qui partira (ou son absence) : tableaux de données (une rangée d'en-tête),
 * bandeau (un fond coloré avant le premier paragraphe), couleurs d'accent, éléments colorés. Rien n'est supposé.
 */
export function natureDuRendu(html: string | null | undefined, texte: string): RenduObserve {
  if (!html || !html.trim()) {
    return { rendu: texte.trim() ? "texte brut (aucune mise en page)" : "vide", tableaux: 0, bandeau: false, couleurs: [], elementsColores: 0, paragraphes: texte.split(/\n{2,}/).filter((x) => x.trim()).length };
  }
  const corps = html.replace(/<head\b[\s\S]*?<\/head>/i, "");
  const tableaux = (corps.match(/<tr\b[^>]*>\s*<th\b/gi) ?? []).length;
  const premierP = corps.search(/<(p|ul|ol|h[1-6])\b/i);
  const avant = premierP >= 0 ? corps.slice(0, premierP) : corps;
  const fondsAvant = [...avant.matchAll(/background(?:-color)?\s*:\s*(#[0-9a-f]{3,6})\b/gi)].map((m) => m[1]!).filter(estAccent);
  const bandeau = fondsAvant.length > 0;
  const couleurs = [...new Set([...corps.matchAll(HEX)].map((m) => developper(m[0])).filter(estAccent))].slice(0, 4);
  const elements = [...corps.matchAll(/<(p|li|td|th|span|strong|h[1-6])\b[^>]*style="([^"]*)"/gi)];
  const elementsColores = elements.filter((m) => [...m[2]!.matchAll(HEX)].some((c) => estAccent(c[0]))).length;
  const paragraphes = (corps.match(/<p\b/gi) ?? []).length;
  const textuels = elements.filter((m) => /^(p|li)$/i.test(m[1]!)).length;
  const textuelsColores = elements.filter((m) => /^(p|li)$/i.test(m[1]!) && [...m[2]!.matchAll(HEX)].some((c) => estAccent(c[0]))).length;
  const charte = bandeau || couleurs.length > 0;
  const rendu = !charte ? "HTML sobre (sans couleur de charte)"
    : bandeau && (tableaux > 0 || textuelsColores > 0 || textuels === 0) ? "HTML à la charte"
      : bandeau ? "HTML mixte (bandeau à la charte, texte simple)"
        : "HTML mixte (charte en partie)";
  const details = [bandeau ? `bandeau ${fondsAvant.map(developper)[0]}` : null, tableaux ? `${tableaux} tableau${tableaux > 1 ? "x" : ""}` : null, couleurs.length ? `couleurs ${couleurs.join(", ")}` : null].filter(Boolean);
  return { rendu: details.length ? `${rendu} — ${details.join(", ")}` : rendu, tableaux, bandeau, couleurs, elementsColores, paragraphes };
}

// ─────────────────────────────── 1. La carte (et ses mails) ───────────────────────────────

export interface MailVu {
  /** L'expéditeur RÉEL (la boîte qui enverra), tel que l'envoi l'emploiera. */
  expediteur: string;
  a: readonly string[];
  cc?: readonly string[];
  objet: string;
  /** Le texte tel qu'il partira (partie text/plain, ou corps unique). */
  texte: string;
  /** Le HTML tel qu'il partira — `null` : aucun HTML (texte brut). Lu pour la nature du rendu, jamais recopié. */
  html: string | null;
}

export interface CarteVue {
  id: string;
  titre: string;
  /** Le statut de l'intention en base (PROPOSED, CONFIRMED, EXECUTING, EXECUTED, FAILED, CANCELLED, EXPIRED). */
  statut: string;
  champs?: readonly { label: string; value: string }[];
  avertissements?: readonly string[];
  /** Le message d'exécution (« Mail programmé… ») ou l'erreur. */
  resultat?: string | null;
  lien?: string | null;
  aCompleter?: boolean;
  mails?: readonly MailVu[];
  /** J7 : le diff réel de la simulation, résumé. */
  simulation?: string | null;
  /** Carte CRITIQUE : la valeur que la personne devra ressaisir pour confirmer. */
  ressaisie?: string | null;
}

const ETAT_INTENTION: Readonly<Record<string, string>> = {
  PROPOSED: "PROPOSEE", CONFIRMED: "CONFIRMEE", EXECUTING: "CONFIRMEE", EXECUTED: "EXECUTEE", FAILED: "ECHEC", CANCELLED: "ANNULEE", EXPIRED: "EXPIREE",
};
/** L'état observé d'une intention (statut de la base → vocabulaire du contrat). */
export const etatDIntention = (statut: string): string => ETAT_INTENTION[statut] ?? statut;

/** Les champs dits d'une carte : ni identifiant technique, ni valeur vide (la voix et l'écrit lisent les mêmes). */
const BRUT = /^(—|-|null|undefined|\[\]|\{\})$/;
const IDENTIFIANT = /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z0-9_-]{24,}$)/;
export const champsDits = (champs: readonly { label: string; value: string }[]): { label: string; value: string }[] =>
  champs.filter((ch) => ch.value && !BRUT.test(ch.value.trim()) && !IDENTIFIANT.test(ch.value.trim()));

export function projeterCarte(c: CarteVue, maintenant: Date = new Date()): Observation {
  const etat = c.aCompleter && c.statut === "PROPOSED" ? "A_COMPLETER" : etatDIntention(c.statut);
  const mails = c.mails ?? [];
  const premier = mails[0];
  const rendu = premier ? natureDuRendu(premier.html, premier.texte) : null;
  return observer("carte", { type: "intention", id: c.id, lien: c.lien ?? null }, etat, {
    titre: c.titre,
    ...(premier
      ? {
        expediteur: premier.expediteur,
        a: [...premier.a],
        cc: premier.cc?.length ? [...premier.cc] : undefined,
        objet: premier.objet,
        rendu: rendu!.rendu,
        texte: premier.texte,
        mails: mails.length > 1 ? mails.slice(1).map((m) => `à ${m.a.join(", ")} — « ${m.objet} » (${natureDuRendu(m.html, m.texte).rendu})`) : undefined,
      }
      : { champs: champsDits(c.champs ?? []).slice(0, 8).map((ch) => `${ch.label} : ${ch.value}`) }),
    avertissements: c.avertissements?.length ? [...c.avertissements] : undefined,
    simulation: c.simulation ?? undefined,
    ressaisie: c.ressaisie ? `la personne devra ressaisir « ${c.ressaisie} » pour confirmer` : undefined,
    resultat: c.resultat ?? undefined,
  }, maintenant);
}

/** Le RÉCIT d'une carte, pour la voix (`recitDeCarte`) — la même projection que l'écrit, dite en une phrase. */
export function recitDeProjection(o: Observation): string {
  const p = o.projection;
  const titre = String(p.titre ?? "");
  if (p.objet) {
    const a = Array.isArray(p.a) ? (p.a as string[]).join(", ") : "";
    return `${titre} : à ${a}, objet « ${String(p.objet)} », ${String(p.rendu ?? "").split(" — ")[0]}.`;
  }
  const champs = Array.isArray(p.champs) ? (p.champs as string[]).slice(0, 7).map((c) => {
    const i = c.indexOf(" : ");
    return i > 0 ? `${c.slice(0, i).toLowerCase()} ${c.slice(i + 3)}` : c;
  }) : [];
  return `${titre}${champs.length ? ` : ${champs.join(", ")}` : ""}.`;
}

// ─────────────────────────────── 2. Le fichier ───────────────────────────────

export interface FichierVu {
  id: string;
  nom: string;
  existe: boolean;
  format?: string | null;
  lignes?: number | null;
  colonnes?: readonly string[];
  /** D'où il vient (« export », « Word modèle », « pièce jointe »). */
  source?: string | null;
}

export const lienDeFichier = (id: string): string => `/api/drive/${id}/raw`;

export function projeterFichier(f: FichierVu, maintenant: Date = new Date()): Observation {
  return observer("fichier", { type: "fichier_drive", id: f.id, lien: f.existe ? lienDeFichier(f.id) : null }, f.existe ? "ECRIT" : "INTROUVABLE", {
    nom: f.nom, format: f.format ?? (/\.([a-z0-9]{2,5})$/i.exec(f.nom)?.[1]?.toLowerCase() ?? null),
    lignes: f.lignes ?? undefined, colonnes: f.colonnes?.length ? [...f.colonnes] : undefined, source: f.source ?? undefined,
  }, maintenant);
}

// ─────────────────────────────── 3. La mission ───────────────────────────────

export interface MissionVue {
  id: string;
  titre: string;
  /** L'état du moteur (A_APPROUVER, EN_COURS, EN_ATTENTE, TERMINE…). */
  etat: string;
  libelle?: string | null;
  etapes: { faites: number; total: number };
  /** Dernière écriture de la mission ou d'une étape (ISO). */
  majLe: string;
  /** Le diagnostic FACTUEL (`diagnostiquerMission`). */
  diagnostic: string;
}

export const lienDeMission = (id: string): string => `/missions/${id}`;

/** La mission telle qu'elle est — son âge est LU (`majLe`), son lien porté : la réponse peut la rendre cliquable. */
export function projeterMission(m: MissionVue, maintenant: Date = new Date()): Observation {
  const age = Date.parse(m.majLe);
  return observer("mission", { type: "mission", id: m.id, lien: lienDeMission(m.id) }, m.etat, {
    titre: m.titre, statut: m.libelle ?? undefined, etapes: `${m.etapes.faites}/${m.etapes.total}`,
    derniereActivite: Number.isNaN(age) ? undefined : `il y a ${dureeLisible(maintenant.getTime() - age)}`,
    diagnostic: m.diagnostic,
  }, maintenant);
}

// ─────────────────────────────── 4. L'effet sortant ───────────────────────────────

export interface EffetVu {
  id: string;
  /** « mail_adam », « mail_boite », « message »… */
  type: string;
  canal: string;
  /** BROUILLON, PROGRAMME, PARTI, ANNULEE, ECHEC, PROPOSEE. */
  etat: string;
  a?: readonly string[];
  objet?: string | null;
  depart?: string | null;
  erreur?: string | null;
}

export function projeterEffet(e: EffetVu, maintenant: Date = new Date()): Observation {
  return observer("effet", { type: e.type, id: e.id, lien: null }, e.etat, {
    canal: e.canal, a: e.a?.length ? [...e.a] : undefined, objet: e.objet ?? undefined, depart: e.depart ?? undefined, erreur: e.erreur ?? undefined,
  }, maintenant);
}

// ─────────────────────────────── 5. La lecture tabulaire ───────────────────────────────

export interface LectureVue {
  /** Le nom technique de l'outil (stable), et ce que la personne lit (« Missions lues »). */
  outil: string;
  libelle: string;
  lignes: number;
  colonnes?: readonly string[];
  /** Les identifiants des objets lus (les premiers) — relisibles au tour suivant. */
  ids?: readonly string[];
}

export function projeterLecture(l: LectureVue, maintenant: Date = new Date()): Observation {
  return observer("lecture", { type: "lecture", id: l.outil, lien: null }, "LU", {
    titre: l.libelle, lignes: l.lignes, colonnes: l.colonnes?.length ? [...l.colonnes] : undefined, ids: l.ids?.length ? [...l.ids] : undefined,
  }, maintenant);
}

/**
 * LIRE une sortie d'outil en lecture tabulaire — le premier tableau d'objets d'une sortie JSON (`missions`, `lignes`,
 * `resultats`…) : combien de lignes, quelles colonnes, quels identifiants. `null` : pas une lecture tabulaire.
 */
export function lectureDeSortie(outil: string, libelle: string, sortie: string): Observation | null {
  let o: unknown;
  try { o = JSON.parse(sortie); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const tableau = Array.isArray(o) ? o : Object.values(o as Record<string, unknown>).find((v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x)));
  if (!Array.isArray(tableau) || !tableau.length || !tableau.every((x) => x && typeof x === "object")) return null;
  const lignes = tableau as Record<string, unknown>[];
  const colonnes = [...new Set(lignes.slice(0, 5).flatMap((l) => Object.keys(l)))].slice(0, 10);
  const ids = lignes.map((l) => (typeof l.id === "string" ? l.id : null)).filter((x): x is string => !!x).slice(0, 8);
  const total = typeof (o as Record<string, unknown>).total === "number" ? Number((o as Record<string, unknown>).total) : lignes.length;
  return projeterLecture({ outil, libelle, lignes: total, colonnes, ids });
}


/**
 * CE QUI A ÉTÉ MONTRÉ (audit AU1 C6) — un bloc affiché sous une réponse (tableau, liste, fiche, frise) : son titre, combien
 * de lignes, quelles colonnes. La consigne demande de ne pas répéter dans le message ce qu'un composant montre : sans cette
 * observation, ce qui a été montré disparaissait de la mémoire du tour suivant.
 */
export function lectureDeBloc(b: unknown, rang: number, maintenant: Date = new Date()): Observation | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : null;
  const titre = typeof o.title === "string" ? o.title : null;
  if (!kind || !titre) return null;
  const liste = ["rows", "items", "people", "events", "steps", "messages", "docs", "fields", "gauges"].map((k) => o[k]).find(Array.isArray) as unknown[] | undefined;
  const colonnes = Array.isArray(o.columns) ? (o.columns as { label?: unknown; key?: unknown }[]).map((c) => String(c.label ?? c.key ?? "")).filter(Boolean) : [];
  const ids = (liste ?? []).map((x) => (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" ? (x as { id: string }).id : null)).filter((x): x is string => !!x).slice(0, 8);
  const total = typeof o.total === "number" ? o.total : liste?.length ?? 0;
  return observer("lecture", { type: "bloc", id: `${kind}-${rang + 1}`, lien: typeof o.href === "string" ? o.href : null }, "LU", {
    titre: `${kind === "table" ? "tableau" : kind} affiché « ${titre} »`, lignes: total, colonnes: colonnes.length ? colonnes : undefined, ids: ids.length ? ids : undefined,
  }, maintenant);
}
