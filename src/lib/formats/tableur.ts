/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE ET ÉCRIRE UN TABLEAU (mandat 5 §41) — pur.
 *
 * `lireTableur` applique ce que `detection.ts` a trouvé : le bon encodage, le bon séparateur,
 * l'en-tête s'il y en a un, et la locale pour typer les colonnes. Il rend les lignes ET le
 * RAPPORT de lecture — combien de lignes mal formées, quelles colonnes ont un type mêlé, ce qui
 * n'a pas pu être converti. Une lecture qui ne dit pas ce qu'elle a raté n'est pas une lecture.
 *
 * `ecrireCsv` fait le chemin inverse en le disant aussi : écrire un nombre français dans un CSV
 * à virgules casse le fichier, et le code choisit un séparateur COMPATIBLE avec la locale plutôt
 * que de produire un fichier que le tableur de la personne lira de travers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  type DetectionLocale, type Encodage, type LocaleNombre, type Separateur,
  decouperLigne, detecterEncodage, detecterEntete, detecterLocale, detecterSeparateur, nomSeparateur, versDateIso, versNombre,
} from "./detection";
import { neutraliserFormuleCsv } from "@/lib/formats/csv-cellule";

export const LIGNES_TABLEUR_MAX = 200_000;

export type TypeColonne = "nombre" | "date" | "texte" | "booleen" | "vide" | "mele";

export interface Colonne {
  nom: string;
  type: TypeColonne;
  /** Quand le type est « mêlé », ce qui s'y trouve — c'est un DÉFAUT DE DONNÉE, pas un détail. */
  detail?: string;
  remplies: number;
  vides: number;
  distinctes: number;
  exemples: (string | number | null)[];
}

export interface RapportLecture {
  encodage: Encodage;
  separateur: Separateur;
  entete: boolean;
  locale: DetectionLocale;
  lignesLues: number;
  lignesMalFormees: { ligne: number; colonnes: number; attendu: number }[];
  tronque: boolean;
  confiance: number;
  decisions: string[];
  avertissements: string[];
}

export interface Tableur {
  ok: true;
  colonnes: Colonne[];
  lignes: Record<string, string | number | null>[];
  rapport: RapportLecture;
}
export type ResultatTableur = Tableur | { ok: false; erreur: string };

export interface OptionsLecture {
  separateur?: Separateur;
  entete?: boolean;
  encodage?: Encodage;
  localeNombres?: LocaleNombre;
  max?: number;
  /** Convertir les nombres et les dates, ou tout laisser en texte (une référence « 007 » n'est pas 7). */
  typer?: boolean;
}

/** LIT UN TABLEAU TEXTE en appliquant les détections, et rend ce qu'il a raté. */
export function lireTableur(octets: Buffer | string, options: OptionsLecture = {}): ResultatTableur {
  const brut = typeof octets === "string" ? { encodage: "utf-8" as Encodage, texte: octets, confiance: 1, raison: "texte fourni directement", caracteresPerdus: 0 } : detecterEncodage(octets);
  const decisions: string[] = [];
  const avertissements: string[] = [];
  const encodage = options.encodage ?? brut.encodage;
  const texte = options.encodage && typeof octets !== "string" ? decoder(octets, options.encodage) : brut.texte;
  decisions.push(`Encodage : ${encodage} — ${options.encodage ? "imposé par l'appel" : brut.raison}.`);
  if (brut.caracteresPerdus > 0) avertissements.push(`${brut.caracteresPerdus} caractère(s) illisible(s) après décodage : le fichier est abîmé ou son encodage n'est ni UTF-8 ni latin-1.`);
  if (!texte.trim()) return { ok: false, erreur: "Fichier vide." };

  const detSep = detecterSeparateur(texte);
  const separateur = options.separateur ?? detSep.separateur;
  decisions.push(`Séparateur : ${nomSeparateur(separateur)} — ${options.separateur ? "imposé par l'appel" : detSep.raison}.`);
  if (!options.separateur && detSep.concurrents.length) {
    avertissements.push(`Séparateur AMBIGU : ${detSep.concurrents.map((c) => `${nomSeparateur(c.separateur)} donnerait ${c.colonnes} colonnes`).join(", ")}. Vérifier le nombre de colonnes lu.`);
  }

  const max = Math.max(1, Math.min(options.max ?? 50_000, LIGNES_TABLEUR_MAX));
  const brutes = texte.split(/\r?\n/).filter((l, i, t) => l.trim() !== "" || i < t.length - 1).filter((l) => l.trim() !== "");
  const decoupees = brutes.slice(0, max + 1).map((l) => decouperLigne(l, separateur).map((c) => c.trim()));
  if (!decoupees.length) return { ok: false, erreur: "Aucune ligne exploitable." };

  const detEntete = options.entete === undefined ? detecterEntete(decoupees) : { entete: options.entete, confiance: 1, raison: "imposé par l'appel" };
  decisions.push(`En-tête : ${detEntete.entete ? "oui" : "non"} — ${detEntete.raison}.`);

  const enTete = detEntete.entete ? decoupees[0]! : [];
  const corps = detEntete.entete ? decoupees.slice(1) : decoupees;
  // LA LARGEUR DE RÉFÉRENCE : l'en-tête quand il y en a un (c'est lui qui déclare le schéma),
  // sinon la largeur la PLUS FRÉQUENTE. Prendre le maximum ferait qu'une seule ligne à un champ
  // de trop classerait tout le reste du fichier comme « mal formé » — un bruit qui masque le vrai
  // défaut au lieu de le montrer.
  const largeurs = new Map<number, number>();
  for (const l of corps) largeurs.set(l.length, (largeurs.get(l.length) ?? 0) + 1);
  const modale = [...largeurs.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1;
  const nbColonnes = detEntete.entete ? Math.max(enTete.length, 1) : modale;
  const noms = Array.from({ length: nbColonnes }, (_, i) => {
    const propose = (enTete[i] ?? "").trim();
    return propose || `colonne_${i + 1}`;
  });
  // Deux colonnes du même nom rendraient l'une invisible : on les distingue en le disant.
  const vus = new Map<string, number>();
  for (let i = 0; i < noms.length; i += 1) {
    const base = noms[i]!;
    const n = (vus.get(base) ?? 0) + 1;
    vus.set(base, n);
    if (n > 1) { noms[i] = `${base}_${n}`; avertissements.push(`Colonne « ${base} » présente ${n} fois : les suivantes sont renommées (${base}_${n}).`); }
  }

  const malFormees: RapportLecture["lignesMalFormees"] = [];
  const brutesParColonne: string[][] = noms.map(() => []);
  for (const [i, l] of corps.entries()) {
    if (l.length !== nbColonnes) malFormees.push({ ligne: i + 1 + (detEntete.entete ? 1 : 0), colonnes: l.length, attendu: nbColonnes });
    for (let c = 0; c < nbColonnes; c += 1) brutesParColonne[c]!.push(l[c] ?? "");
  }
  const enTrop = corps.filter((l) => l.length > nbColonnes).length;
  if (enTrop) avertissements.push(`${enTrop} ligne(s) ont des valeurs AU-DELÀ de la ${nbColonnes}ᵉ colonne : elles ne sont pas lues. Vérifier un séparateur non protégé dans une valeur.`);
  if (malFormees.length) avertissements.push(`${malFormees.length} ligne(s) au mauvais nombre de colonnes (première : ligne ${malFormees[0]!.ligne}, ${malFormees[0]!.colonnes} au lieu de ${nbColonnes}) — souvent un séparateur non protégé dans une valeur.`);

  const echantillon = brutesParColonne.flatMap((col) => col.slice(0, 60));
  const locale = detecterLocale(echantillon);
  if (options.localeNombres) locale.nombres = options.localeNombres;
  decisions.push(`Locale : ${locale.raison}.`);
  if (locale.nombres === "indetermine" && /,/.test(echantillon.join(""))) {
    avertissements.push("Locale des nombres INDÉTERMINÉE : « 1,234 » n'est pas décidable. Les valeurs ambiguës restent en TEXTE plutôt que d'être converties au hasard.");
  }
  if (locale.dates === "indetermine" && echantillon.some((v) => /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(v))) {
    avertissements.push("Ordre des dates INDÉTERMINÉ (aucun jour > 12 dans l'échantillon) : « 03/04/2026 » reste du texte, pas une date devinée.");
  }

  const typer = options.typer !== false;
  const colonnes: Colonne[] = noms.map((nom, c) => {
    const valeurs = brutesParColonne[c]!;
    const remplies = valeurs.filter((v) => v !== "").length;
    let nombres = 0, dates = 0, booleens = 0, autres = 0;
    for (const v of valeurs) {
      if (v === "") continue;
      if (versNombre(v, locale.nombres) !== null) nombres += 1;
      else if (versDateIso(v, locale.dates) !== null) dates += 1;
      else if (/^(oui|non|true|false|vrai|faux|o|n|y)$/i.test(v)) booleens += 1;
      else autres += 1;
    }
    let type: TypeColonne = "texte", detail: string | undefined;
    if (remplies === 0) type = "vide";
    else if (nombres === remplies) type = "nombre";
    else if (dates === remplies) type = "date";
    else if (booleens === remplies) type = "booleen";
    else if (autres === remplies) type = "texte";
    else {
      type = "mele";
      detail = `${nombres} nombre(s), ${dates} date(s), ${autres} texte(s) sur ${remplies} valeur(s) remplies`;
    }
    return {
      nom, type, ...(detail ? { detail } : {}),
      remplies, vides: valeurs.length - remplies,
      distinctes: new Set(valeurs.filter((v) => v !== "")).size,
      exemples: valeurs.filter((v) => v !== "").slice(0, 3),
    };
  });
  for (const c of colonnes) {
    if (c.type === "mele") avertissements.push(`Colonne « ${c.nom} » de type MÊLÉ (${c.detail}) : elle reste en texte, et un calcul dessus serait faux.`);
    if (c.type === "vide") avertissements.push(`Colonne « ${c.nom} » entièrement vide.`);
  }

  const lignes: Record<string, string | number | null>[] = [];
  for (let i = 0; i < corps.length && lignes.length < max; i += 1) {
    const l = corps[i]!;
    const obj: Record<string, string | number | null> = {};
    for (let c = 0; c < nbColonnes; c += 1) {
      const brutVal = l[c] ?? "";
      if (brutVal === "") { obj[noms[c]!] = null; continue; }
      if (!typer) { obj[noms[c]!] = brutVal; continue; }
      const col = colonnes[c]!;
      if (col.type === "nombre") obj[noms[c]!] = versNombre(brutVal, locale.nombres);
      else if (col.type === "date") obj[noms[c]!] = versDateIso(brutVal, locale.dates) ?? brutVal;
      else if (col.type === "booleen") obj[noms[c]!] = /^(oui|true|vrai|o|y)$/i.test(brutVal) ? 1 : 0;
      else obj[noms[c]!] = brutVal;
    }
    lignes.push(obj);
  }

  return {
    ok: true, colonnes, lignes,
    rapport: {
      encodage, separateur, entete: detEntete.entete, locale,
      lignesLues: lignes.length, lignesMalFormees: malFormees.slice(0, 20),
      tronque: brutes.length - (detEntete.entete ? 1 : 0) > lignes.length,
      confiance: Math.min(brut.confiance, options.separateur ? 1 : detSep.confiance, detEntete.confiance),
      decisions, avertissements,
    },
  };
}

function decoder(octets: Buffer, encodage: Encodage): string {
  if (encodage === "latin-1") return octets.toString("latin1");
  if (encodage === "utf-16le") return octets.toString("utf16le");
  if (encodage === "utf-8-bom") return octets.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? octets.subarray(3).toString("utf8") : octets.toString("utf8");
  return octets.toString("utf8");
}

export interface OptionsEcriture {
  separateur?: Separateur;
  /** La locale du FICHIER produit : « fr » écrit 1 234,56 (et impose alors le point-virgule). */
  locale?: LocaleNombre;
  /** Une marque d'ordre UTF-8 : Excel en a besoin pour lire les accents d'un CSV. */
  bom?: boolean;
  colonnes?: readonly string[];
}

export interface EcritureCsv { texte: string; separateur: Separateur; note: string }

/**
 * ÉCRIT UN CSV — et refuse le piège : en locale française, un nombre s'écrit « 1 234,56 », donc
 * la virgule ne peut PAS être le séparateur de colonnes. Le code impose le point-virgule et le
 * DIT, plutôt que de produire un fichier que le tableur de la personne lira de travers.
 */
export function ecrireCsv(lignes: readonly Record<string, unknown>[], options: OptionsEcriture = {}): EcritureCsv {
  const locale = options.locale ?? "fr";
  let separateur = options.separateur ?? (locale === "fr" ? ";" : ",");
  const notes: string[] = [];
  if (locale === "fr" && separateur === ",") {
    separateur = ";";
    notes.push("Séparateur forcé au point-virgule : en locale française le nombre porte déjà une virgule décimale, une colonne séparée par la virgule couperait les montants en deux.");
  }
  const colonnes = options.colonnes?.length ? [...options.colonnes] : [...new Set(lignes.flatMap((l) => Object.keys(l)))];
  const format = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return locale === "fr" ? String(v).replace(".", ",") : String(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    // Un TEXTE qui commence par `= + - @` serait une formule dans le tableur de qui ouvre le fichier.
    return neutraliserFormuleCsv(String(v));
  };
  const echapper = (s: string): string => (s.includes(separateur) || s.includes('"') || /[\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out = [colonnes.map((c) => echapper(neutraliserFormuleCsv(c))).join(separateur)];
  for (const l of lignes) out.push(colonnes.map((c) => echapper(format(l[c]))).join(separateur));
  const corps = out.join("\r\n");
  if (options.bom !== false) notes.push("Marque d'ordre UTF-8 ajoutée : sans elle, un tableur ouvre les accents de travers.");
  return {
    texte: (options.bom !== false ? "﻿" : "") + corps,
    separateur,
    note: notes.join(" ") || `CSV ${nomSeparateur(separateur)}, locale ${locale}.`,
  };
}

/** Des lignes en JSON par ligne (JSONL) — le format des exports volumineux et des journaux. */
export const ecrireJsonl = (lignes: readonly Record<string, unknown>[]): string => lignes.map((l) => JSON.stringify(l)).join("\n");

/** Lit du JSON ou du JSONL, en le disant. Le tableau d'objets le plus profond est retenu, à trois niveaux au plus. */
export function lireJson(texte: string): { ok: true; lignes: Record<string, unknown>[]; forme: "json" | "jsonl" } | { ok: false; erreur: string } {
  const t = texte.trim();
  if (!t) return { ok: false, erreur: "Contenu vide." };
  try {
    const data = JSON.parse(t) as unknown;
    if (Array.isArray(data)) return { ok: true, lignes: data.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)), forme: "json" };
    if (typeof data === "object" && data !== null) {
      let meilleur: Record<string, unknown>[] = [];
      const visiter = (v: unknown, prof: number): void => {
        if (prof > 3 || !v || typeof v !== "object") return;
        if (Array.isArray(v)) {
          const objets = v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x));
          if (objets.length > meilleur.length) meilleur = objets;
          return;
        }
        for (const x of Object.values(v)) visiter(x, prof + 1);
      };
      visiter(data, 0);
      return meilleur.length ? { ok: true, lignes: meilleur, forme: "json" } : { ok: true, lignes: [data as Record<string, unknown>], forme: "json" };
    }
    return { ok: false, erreur: "Le JSON ne contient ni objet ni tableau d'objets." };
  } catch {
    // JSONL : chaque ligne est un objet.
    const lignes: Record<string, unknown>[] = [];
    let echecs = 0;
    for (const l of t.split(/\r?\n/)) {
      const s = l.trim();
      if (!s) continue;
      try { const o = JSON.parse(s) as unknown; if (typeof o === "object" && o !== null && !Array.isArray(o)) lignes.push(o as Record<string, unknown>); else echecs += 1; }
      catch { echecs += 1; }
    }
    if (lignes.length && echecs < lignes.length) return { ok: true, lignes, forme: "jsonl" };
    return { ok: false, erreur: `JSON invalide, et ${echecs} ligne(s) illisible(s) en JSONL : le contenu n'est ni l'un ni l'autre.` };
  }
}
