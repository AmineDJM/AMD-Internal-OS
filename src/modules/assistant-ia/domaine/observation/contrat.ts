/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT OBSERVATION (lot I1, décision 0063 ; audit AU1 §4) — règles PURES, zéro import.
 *
 * Un geste du tour (carte, mail, fichier, mission, effet sortant, lecture tabulaire) rend UNE observation, construite par
 * le SERVEUR depuis l'état réel — jamais par le modèle :
 *
 *   { nature, objet: { type, id, lien }, etat, projection, empreinte, observeLe }
 *
 *   • `objet`      : ce qui a été touché, NOMMABLE (identifiant) et, s'il a un écran, son lien (`/missions/<id>`) ;
 *   • `etat`       : l'état ACTUEL lu en base (PROPOSEE, EXECUTEE, ANNULEE, PROGRAMME, PARTI, EN_COURS, LU…) ;
 *   • `projection` : des attributs TYPÉS et bornés (destinataires, objet, rendu, lignes, colonnes, diagnostic…) — du texte,
 *                    jamais du HTML (un mail reçu piégé ne devient pas une instruction relue à chaque tour) ;
 *   • `empreinte`  : l'empreinte de la projection — deux observations du même objet se comparent sans relire le texte.
 *
 * La même observation sert trois lecteurs : la SORTIE de l'outil qui a fait le geste (le modèle voit ce qu'il a fait), le
 * bloc « Observé » de l'HISTORIQUE (re-projeté depuis la base à chaque tour : le statut est celui d'aujourd'hui), et la
 * VOIX (`recitDeCarte`). Un contrôle final (lot I5) les confrontera au message ; P1 et I3 s'y branchent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures d'objet — un projecteur par nature, pas par outil. */
export type NatureObservation = "carte" | "mail" | "fichier" | "mission" | "effet" | "lecture";

export const NATURES_OBSERVATION: readonly NatureObservation[] = ["carte", "mail", "fichier", "mission", "effet", "lecture"];

export type ValeurObservee = string | number | boolean | null | readonly string[];

export interface ObjetObserve {
  /** Le type métier de l'objet (« intention », « mail_adam », « fichier_drive », « mission », « lecture »). */
  type: string;
  id: string;
  /** L'écran de l'objet, quand il en a un — la réponse peut le rendre cliquable. */
  lien: string | null;
}

export interface Observation {
  nature: NatureObservation;
  objet: ObjetObserve;
  /** L'état ACTUEL, en majuscules (`ETATS_OBSERVES`) — relu en base, jamais déduit du texte. */
  etat: string;
  /** Les attributs observés, typés et bornés : le petit vocabulaire que le contrôle final comparera au message. */
  projection: Readonly<Record<string, ValeurObservee>>;
  /** Empreinte de `nature + objet + etat + projection` (FNV-1a 32 bits, hexadécimal). */
  empreinte: string;
  /** Quand le serveur l'a observée (ISO). */
  observeLe: string;
}

/** Les états d'objet que les projecteurs emploient (libellé lisible pour le modèle et la personne). */
export const ETATS_OBSERVES: Readonly<Record<string, string>> = {
  PROPOSEE: "proposée — attend la confirmation de la personne ; rien n'est exécuté",
  A_COMPLETER: "à compléter sur la carte ; rien n'est exécuté",
  CONFIRMEE: "confirmée, en cours d'exécution",
  EXECUTEE: "exécutée",
  ECHEC: "échouée",
  ANNULEE: "annulée — rien n'a été exécuté",
  EXPIREE: "expirée — rien n'a été exécuté",
  RETIREE: "retirée — rien n'a été exécuté",
  BROUILLON: "brouillon — rien n'est parti",
  PROGRAMME: "programmé — part à l'heure dite, annulable jusque-là",
  PARTI: "parti",
  ECRIT: "écrit",
  INTROUVABLE: "introuvable (supprimé ou hors de portée)",
  LU: "lu",
};

export const BORNES_OBSERVATION = {
  /** Une valeur de texte de la projection. */
  valeur: 300,
  /** Le texte d'un mail tel qu'il partira (projection `texte`). */
  texteMail: 1_200,
  /** Un élément de liste. */
  element: 120,
  /** Les éléments d'une liste. */
  elements: 12,
  /** Les observations retenues pour un tour (le journal en garde davantage ; l'historique, ces seules-là). */
  parTour: 6,
  /** Le bloc « Observé » d'un tour dans l'historique (≈ 300 jetons). */
  blocHistorique: 1_400,
} as const;

/** FNV-1a 32 bits — stable d'une machine à l'autre, sans dépendance (le navigateur la calcule aussi). */
export function empreinteDe(texte: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Une durée dite (« 45 s », « 12 min », « 2 h 05 », « 3 j ») — un fait daté, jamais une prévision. */
export function dureeLisible(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}`;
  return `${Math.floor(h / 24)} j`;
}

/** JAMAIS DE HTML dans une observation : balises retirées, entités courantes rendues, espaces tassés. */
export function texteObservable(v: unknown, max: number = BORNES_OBSERVATION.valeur): string {
  if (v === null || v === undefined) return "";
  const brut = String(v)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<!--[\s\S]*?-->|<![^>]*>/g, " ")
    // Une BALISE seulement (`<td style=…>`, `</p>`) : « Radia <r@x.dz> » garde son adresse.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return brut.length > max ? `${brut.slice(0, max - 1)}…` : brut;
}

function valeurBornee(v: ValeurObservee | undefined, cle: string): ValeurObservee {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, BORNES_OBSERVATION.elements).map((x) => texteObservable(x, BORNES_OBSERVATION.element)).filter(Boolean);
  return texteObservable(v, cle === "texte" ? BORNES_OBSERVATION.texteMail : BORNES_OBSERVATION.valeur);
}

/** Construire une observation — la projection est bornée et débarrassée de tout balisage ; l'empreinte en découle. */
export function observer(
  nature: NatureObservation, objet: ObjetObserve, etat: string, projection: Record<string, ValeurObservee | undefined>, maintenant: Date = new Date(),
): Observation {
  const p: Record<string, ValeurObservee> = {};
  for (const [k, v] of Object.entries(projection)) {
    const b = valeurBornee(v, k);
    if (b === null || b === "" || (Array.isArray(b) && !b.length)) continue;
    p[k] = b;
  }
  const o = { type: texteObservable(objet.type, 40), id: texteObservable(objet.id, 80), lien: objet.lien ? texteObservable(objet.lien, 200) : null };
  const e = etat.toUpperCase();
  return { nature, objet: o, etat: e, projection: p, empreinte: empreinteDe(JSON.stringify([nature, o, e, p])), observeLe: maintenant.toISOString() };
}

/** Relire une observation stockée (JSON de la base) — ce qui n'a pas la forme du contrat est écarté, jamais deviné. */
export function lireObservation(brut: unknown): Observation | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as Record<string, unknown>;
  const objet = o.objet as Record<string, unknown> | undefined;
  if (!NATURES_OBSERVATION.includes(o.nature as NatureObservation) || !objet || typeof objet.id !== "string" || typeof objet.type !== "string" || typeof o.etat !== "string") return null;
  const projection = o.projection && typeof o.projection === "object" && !Array.isArray(o.projection) ? (o.projection as Record<string, ValeurObservee>) : {};
  return observer(o.nature as NatureObservation, { type: objet.type, id: objet.id, lien: typeof objet.lien === "string" ? objet.lien : null }, o.etat, projection, typeof o.observeLe === "string" && !Number.isNaN(Date.parse(o.observeLe)) ? new Date(o.observeLe) : new Date());
}

export const lireObservations = (brut: unknown): Observation[] => (Array.isArray(brut) ? brut.map(lireObservation).filter((x): x is Observation => !!x) : []);

/** Une observation par objet — la DERNIÈRE l'emporte (un objet re-touché dans le tour). */
export function dedoublonner(obs: readonly Observation[]): Observation[] {
  const parObjet = new Map<string, Observation>();
  for (const o of obs) parObjet.set(`${o.nature}:${o.objet.type}:${o.objet.id}`, o);
  return [...parObjet.values()];
}

const LIBELLES_NATURE: Record<NatureObservation, string> = { carte: "carte", mail: "mail", fichier: "fichier", mission: "mission", effet: "effet", lecture: "lecture" };
const LIBELLES_CLES: Readonly<Record<string, string>> = {
  titre: "titre", expediteur: "expéditeur", a: "à", cc: "cc", objet: "objet", rendu: "rendu", texte: "texte tel qu'il partira",
  champs: "champs", avertissements: "avertissements", resultat: "résultat", diagnostic: "où elle en est", etapes: "étapes",
  derniereActivite: "dernière activité", nom: "nom", format: "format", lignes: "lignes", colonnes: "colonnes", source: "source",
  canal: "canal", depart: "départ", erreur: "erreur", mails: "autres mails", statut: "statut", ids: "identifiants",
};

const dire = (v: ValeurObservee): string => (Array.isArray(v) ? v.join(" ; ") : typeof v === "boolean" ? (v ? "oui" : "non") : String(v));

/** UNE observation, en une ligne lisible (le modèle et la personne la lisent ; aucun HTML, bornée). */
export function texteDObservation(o: Observation, opts: { sansTexte?: boolean } = {}): string {
  const etat = ETATS_OBSERVES[o.etat] ?? o.etat.toLowerCase();
  const attributs = Object.entries(o.projection)
    .filter(([k]) => !(opts.sansTexte && k === "texte"))
    .map(([k, v]) => `${LIBELLES_CLES[k] ?? k} : ${dire(v)}`);
  const lien = o.objet.lien ? ` [${o.objet.lien}]` : "";
  return `${LIBELLES_NATURE[o.nature]} (id ${o.objet.id})${lien} — état : ${etat}${attributs.length ? ` ; ${attributs.join(" ; ")}` : ""}`;
}

/**
 * LE BLOC « OBSERVÉ » d'une réponse dans l'historique — re-projeté depuis la base au tour suivant. Borné : le texte d'un
 * mail cède la place quand le bloc déborde (la carte reste nommée, relisible par son identifiant).
 */
export function blocObserve(obs: readonly Observation[], max: number = BORNES_OBSERVATION.blocHistorique): string | null {
  const retenues = dedoublonner(obs).slice(-BORNES_OBSERVATION.parTour);
  if (!retenues.length) return null;
  const tete = "[Observé par le serveur — état actuel, relu en base :";
  const complet = retenues.map((o) => `- ${texteDObservation(o)}`);
  const court = retenues.map((o) => `- ${texteDObservation(o, { sansTexte: true })}`);
  const essai = (lignes: string[]) => `${tete}\n${lignes.join("\n")}]`;
  const plein = essai(complet);
  if (plein.length <= max) return plein;
  const reduit = essai(court);
  return reduit.length <= max ? reduit : `${reduit.slice(0, max - 2)}…]`;
}
