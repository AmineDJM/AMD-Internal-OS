import type { z } from "zod";
import { libelleChamp, zodDe } from "./schema";
import type { ChampLu, TypeChampLu } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FORMULAIRE D'UNE CARTE, GÉNÉRÉ DEPUIS LE CONTRAT (lot J11, décision 0030) — pur, navigateur compris.
 *
 * Avant J11, la carte de confirmation d'une capacité R1–R4 MONTRAIT ce que l'assistant avait rempli : la personne
 * signait ou ignorait, sans pouvoir corriger une échéance ou un responsable. Ici, chaque champ du CONTRAT devient un
 * champ de formulaire — son type, ses valeurs admises, sa référence vers une autre entité (sélecteur filtré par les
 * droits, côté serveur) —, la valeur PROPOSÉE pré-remplie et marquée comme telle ; la personne corrige, puis signe.
 *
 * Une seule vérité, de bout en bout : la validation est `zodDe` (le schéma du registre J6, celui que l'adaptateur
 * applique au modèle). Le formulaire n'ajoute aucune règle et n'en retire aucune — le banc `formulaires.test.ts`
 * génère le formulaire de CHAQUE capacité R1–R4 et le valide contre son schéma : 0 écart.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que l'écran dessine pour un champ — dérivé du type du contrat, jamais déclaré à la main. */
export type Widget =
  | "texte" | "zone" | "nombre" | "date" | "case" | "choix" | "choix-multiple" | "etiquettes"
  /** Une référence vers une entité connue : sélecteur filtré par les droits. */
  | "reference" | "references"
  /** Une référence dont le contrat ne dit pas l'objet : un identifiant saisi (l'action le rejuge). */
  | "identifiant";

export interface ChampFormulaire {
  nom: string;
  libelle: string;
  type: TypeChampLu;
  widget: Widget;
  obligatoire: boolean;
  valeurs: string[] | null;
  modele: string | null;
  /** La valeur que l'assistant a proposée (déjà résolue : un identifiant pour une référence) — `null` : aucune. */
  propose: unknown;
  /** Ce que la personne lit d'une référence proposée (identifiant → « Karim B. — Délégué »). */
  etiquettes: Record<string, string>;
  /** Une aide courte sous le champ, quand elle sert (format, nature de la référence). */
  aide: string | null;
}

export interface FormulaireCarte {
  /** `fichier:fonction` — la capacité dont le contrat a donné les champs. */
  capacite: string;
  champs: ChampFormulaire[];
}

/** Ce que l'écran tient pour un champ pendant la saisie. */
export type Saisie = string | boolean | string[];
export type Saisies = Record<string, Saisie>;

/** Un texte long : une zone de plusieurs lignes plutôt qu'une ligne. */
const TEXTE_LONG = /(description|content|contenu|body|corps|message|notes?|comments?|commentaire|motif|reason|raison|justification|resume|summary|details?|texte|text|observations?|instructions?|objet|subject|ordreDuJour|agenda)$/i;

export function widgetDe(ch: Pick<ChampLu, "nom" | "type" | "valeurs" | "modele">): Widget {
  switch (ch.type) {
    case "booleen": return "case";
    case "nombre": return "nombre";
    case "date": return "date";
    case "liste": return ch.modele ? "references" : ch.valeurs?.length ? "choix-multiple" : "etiquettes";
    case "reference": return ch.modele ? "reference" : "identifiant";
    default: return ch.valeurs?.length ? "choix" : TEXTE_LONG.test(ch.nom) ? "zone" : "texte";
  }
}

function aideDe(ch: ChampLu, w: Widget): string | null {
  if (w === "date") return "Date au format AAAA-MM-JJ.";
  if (w === "etiquettes") return "Une valeur par ligne.";
  if (w === "identifiant") return "Identifiant de la fiche (l'action le revérifie).";
  if ((w === "reference" || w === "references") && ch.modele) return ch.modele === "User" ? "Cherchez une personne par son nom." : "Cherchez par nom ou référence — seules les fiches que vous voyez sont proposées.";
  return null;
}

/**
 * LE FORMULAIRE d'une capacité — un champ par champ du contrat, dans son ordre, la proposition de l'assistant dedans.
 * `etiquettes` : les noms lus des références que la préparation a résolues (identifiant → titre).
 */
export function formulaireDe(
  capacite: string,
  champs: readonly ChampLu[],
  propose: Readonly<Record<string, unknown>> = {},
  etiquettes: Readonly<Record<string, string>> = {},
): FormulaireCarte {
  return {
    capacite,
    champs: champs.map((ch) => {
      const widget = widgetDe(ch);
      const v = propose[ch.nom];
      const ids = v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
      return {
        nom: ch.nom, libelle: libelleChamp(ch.nom), type: ch.type, widget, obligatoire: ch.obligatoire,
        valeurs: ch.valeurs ? [...ch.valeurs] : null, modele: ch.modele,
        propose: v === undefined ? null : v,
        etiquettes: Object.fromEntries(ids.filter((id) => etiquettes[id]).map((id) => [id, etiquettes[id]!])),
        aide: aideDe(ch, widget),
      };
    }),
  };
}

/** Les champs du CONTRAT que porte un formulaire — la forme que `zodDe` lit. */
export const champsDuFormulaire = (f: FormulaireCarte): ChampLu[] =>
  f.champs.map((c) => ({ nom: c.nom, type: c.type, obligatoire: c.obligatoire, valeurs: c.valeurs, modele: c.modele }));

/** La saisie de départ d'un champ : la valeur proposée, dans la forme que l'écran tient. */
export function saisieInitiale(c: ChampFormulaire): Saisie {
  const v = c.propose;
  switch (c.widget) {
    case "case": return v === true || v === "true";
    case "references": case "choix-multiple": case "etiquettes":
      return v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
    case "date": return v === null || v === undefined ? "" : String(v).slice(0, 10);
    default: return v === null || v === undefined ? "" : String(v);
  }
}

export const saisiesInitiales = (f: FormulaireCarte): Saisies =>
  Object.fromEntries(f.champs.map((c) => [c.nom, saisieInitiale(c)]));

/** Un nombre écrit à la française (« 12 500,50 ») ou à l'anglaise. `NaN` : ce n'en est pas un. */
export function lireNombre(s: string): number {
  const t = s.replace(/[\s  ]/g, "").replace(",", ".");
  return t === "" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? Number.NaN : Number(t);
}

/**
 * LA SAISIE → L'ENTRÉE de l'action, typée comme le contrat l'attend. Un champ laissé vide n'est pas envoyé (zod dira
 * s'il était obligatoire) ; une case n'est envoyée que si elle est obligatoire, proposée, ou cochée — décocher une
 * proposition l'envoie à `false`.
 */
export function entreeDepuisSaisies(f: FormulaireCarte, saisies: Readonly<Saisies>): Record<string, unknown> {
  const entree: Record<string, unknown> = {};
  for (const c of f.champs) {
    const s = saisies[c.nom] ?? saisieInitiale(c);
    if (c.widget === "case") {
      const b = s === true;
      if (b || c.obligatoire || c.propose !== null) entree[c.nom] = b;
      continue;
    }
    if (Array.isArray(s)) {
      const l = s.map((x) => String(x).trim()).filter(Boolean);
      if (l.length) entree[c.nom] = l;
      continue;
    }
    const t = String(s ?? "").trim();
    if (!t) continue;
    // Un nombre illisible part tel quel : la validation le refuse en le nommant, au lieu de l'effacer en silence.
    entree[c.nom] = c.widget === "nombre" && !Number.isNaN(lireNombre(t)) ? lireNombre(t) : t;
  }
  return entree;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function phraseErreur(c: ChampFormulaire, issue: z.core.$ZodIssue, valeur: unknown): string {
  if (valeur === undefined) return "Champ obligatoire.";
  if (issue.code === "invalid_value") return "Choisissez une valeur de la liste.";
  if (issue.code === "invalid_type" && issue.expected === "number") return "Un nombre est attendu.";
  if (issue.code === "invalid_type" && issue.expected === "boolean") return "Oui ou non est attendu.";
  if (issue.code === "unrecognized_keys") return "Champ inconnu du contrat.";
  return `Valeur refusée pour « ${c.libelle} ».`;
}

export interface Verification {
  entree: Record<string, unknown>;
  /** Champ → la raison, en français. Vide : le formulaire respecte le schéma de la capacité. */
  erreurs: Record<string, string>;
}

/** VALIDE la saisie contre le SCHÉMA DU REGISTRE (`zodDe`) — la même règle que l'adaptateur applique au modèle. */
export function verifierFormulaire(f: FormulaireCarte, saisies: Readonly<Saisies>): Verification {
  const entree = entreeDepuisSaisies(f, saisies);
  const erreurs: Record<string, string> = {};
  const r = zodDe({ champs: champsDuFormulaire(f) }).safeParse(entree);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const nom = String(issue.path[0] ?? (issue.code === "unrecognized_keys" ? issue.keys[0] : ""));
      const c = f.champs.find((x) => x.nom === nom);
      if (c && !erreurs[nom]) erreurs[nom] = phraseErreur(c, issue, entree[nom]);
    }
  }
  // Le contrat type une date en texte ; l'écran exige la forme que l'action lit.
  for (const c of f.champs) {
    const v = entree[c.nom];
    if (c.widget === "date" && typeof v === "string" && !DATE.test(v) && !erreurs[c.nom]) erreurs[c.nom] = "Date au format AAAA-MM-JJ.";
  }
  return { entree, erreurs };
}

const egal = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Les champs que la personne a CHANGÉS par rapport à la proposition (la carte les marque « corrigé »). */
export function champsCorriges(f: FormulaireCarte, entree: Readonly<Record<string, unknown>>): string[] {
  return f.champs.filter((c) => {
    const avant = c.propose;
    const apres = entree[c.nom];
    if ((avant === null || avant === undefined) && (apres === undefined || apres === false)) return false;
    return !egal(Array.isArray(avant) ? avant.map(String) : avant, apres);
  }).map((c) => c.nom);
}
