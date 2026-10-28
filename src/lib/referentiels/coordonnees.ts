/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * R3 — DES CHAMPS D'UNE FICHE AUX ADRESSES ET POINTS DE CONTACT (refonte des données, lot V2-D).
 *
 * Les fiches métier portent leurs coordonnées en colonnes libres : `address`, `phone`, `phoneAlt`, `email`,
 * `contactEmail`, `website`… Ce module les traduit en lignes CANDIDATES de `Adresse` et `PointDeContact`, rattachées
 * à la Personne ou à l'Organisation de la fiche. Il ne lit ni n'écrit la base : les reprises (`reprises/adresses.ts`,
 * `reprises/points-de-contact.ts`) lui passent les champs et écrivent ce qu'il rend.
 *
 * ── UNE CLÉ PAR CHOSE RÉELLE ─────────────────────────────────────────────────────────────────
 * Chaque candidat porte une `cle` — titulaire + nature + valeur NORMALISÉE — dont la reprise tire un identifiant
 * déterministe. Le même mobile lu sur la fiche praticien ET sur le compte du Dr Benali (même Personne) donne la même
 * clé : une seule ligne, quel que soit l'ordre ou le nombre de passages. C'est ce qui rend la reprise rejouable
 * après les lots V2-B / V2-C, qui créent les Personnes et Organisations au fil de l'eau.
 *
 * ── CE QUI N'EST PAS REPRIS ──────────────────────────────────────────────────────────────────
 *   - un téléphone, un e-mail ou un site ILLISIBLE (la normalisation rend `null`) : une valeur fausse se répandrait
 *     dans les envois ; elle reste dans la fiche, où un humain la voit ;
 *   - une adresse vide : la seule ville n'est pas une adresse (la wilaya est déjà portée par la fiche) ;
 *   - une adresse à l'étranger : le code pays ISO ne se devine pas d'un texte libre (« Inde », « Chine pop. »).
 * Aucune ligne n'est marquée `principale` / `principal` : choisir le numéro à privilégier est un geste humain.
 *
 * Module PUR : n'importe que des modules purs (aucune base, aucun fichier).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { normaliserLieu } from "@/lib/lieux/normaliser";
import { estEnAlgerie } from "@/lib/lieux/rattachement";
import { emailNormalise } from "@/lib/quality/model";
import { extraireTelephones, normaliserEmail, plier } from "./normalisation";

export type Titulaire = { personneId: string; organisationId?: undefined } | { organisationId: string; personneId?: undefined };

export type TypeAdresseCandidate = "SIEGE" | "LIVRAISON" | "DOMICILE" | "AUTRE";
export type TypePointCandidat = "TELEPHONE" | "EMAIL" | "SITE";

export interface AdresseCandidate {
  cle: string;
  personneId: string | null;
  organisationId: string | null;
  type: TypeAdresseCandidate;
  ligne1: string;
  wilayaCode: string | null;
  codePostal: string | null;
  /** `IMPORT:<Table>:<id>` — d'où la ligne a été reprise. */
  source: string;
}

export interface PointCandidat {
  cle: string;
  personneId: string | null;
  organisationId: string | null;
  type: TypePointCandidat;
  valeur: string;
  valeurNormalisee: string;
  libelle: string | null;
  source: string;
}

function cleTitulaire(t: Titulaire): string {
  return t.personneId ? `P:${t.personneId}` : `O:${t.organisationId}`;
}

function titulaireColonnes(t: Titulaire): { personneId: string | null; organisationId: string | null } {
  return { personneId: t.personneId ?? null, organisationId: t.organisationId ?? null };
}

/** `IMPORT:<Table>:<id>` — la provenance écrite dans la colonne `source`. */
export function sourceImport(table: string, id: string): string {
  return `IMPORT:${table}:${id}`;
}

function nettoyer(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────── Adresses ───────────────────────────────

export interface ChampsAdresse {
  titulaire: Titulaire;
  type: TypeAdresseCandidate;
  adresse: string | null | undefined;
  ville?: string | null;
  wilaya?: string | null;
  /** Le code déjà lu sur la fiche (`wilayaCode`) : il prime, la fiche et son adresse disent la même wilaya. */
  wilayaCode?: string | null;
  codePostal?: string | null;
  pays?: string | null;
  source: string;
}

export type ResultatAdresse =
  | { adresse: AdresseCandidate }
  | { adresse: null; raison: "vide" | "etranger"; detail?: string };

/**
 * L'ADRESSE D'UNE FICHE, ou pourquoi il n'y en a pas. La wilaya vient du code de la fiche, sinon de ses champs
 * wilaya / ville, sinon du texte de l'adresse lui-même (« Cité 500 logements, Batna ») — jamais devinée.
 */
export function adresseDepuisFiche(c: ChampsAdresse): ResultatAdresse {
  const ligne1 = nettoyer(c.adresse);
  if (!ligne1 || ligne1.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return { adresse: null, raison: "vide" };
  if (!estEnAlgerie(c.pays)) return { adresse: null, raison: "etranger", detail: `pays « ${nettoyer(c.pays)} »` };
  let wilayaCode = c.wilayaCode ?? null;
  if (!wilayaCode) {
    const lieu = normaliserLieu({ wilaya: c.wilaya, ville: c.ville });
    wilayaCode = lieu.wilaya.code ?? normaliserLieu({ wilaya: ligne1 }).wilaya.code;
  }
  const cp = nettoyer(c.codePostal);
  return {
    adresse: {
      cle: `adresse|${cleTitulaire(c.titulaire)}|${plier(ligne1)}`,
      ...titulaireColonnes(c.titulaire),
      type: c.type,
      ligne1,
      wilayaCode,
      codePostal: /^\d{5}$/.test(cp) ? cp : null,
      source: c.source,
    },
  };
}

// ─────────────────────────────── Points de contact ───────────────────────────────

export interface ValeurLibellee {
  valeur: string | null | undefined;
  libelle?: string | null;
}

export interface ChampsContact {
  titulaire: Titulaire;
  telephones?: readonly ValeurLibellee[];
  emails?: readonly ValeurLibellee[];
  sites?: readonly ValeurLibellee[];
  source: string;
}

/** L'hôte d'un site (« https://www.saidal.dz/fr » → « saidal.dz »), ou `null` si ce n'est pas une adresse web. */
export function hoteDuSite(v: string | null | undefined): string | null {
  const s = nettoyer(v);
  if (!s || /\s/.test(s) || s.includes("@")) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && /[a-z]/.test(host.split(".").pop()!) ? host : null;
  } catch {
    return null;
  }
}

const NATURE_TEL: Record<string, string> = { MOBILE: "Mobile", FIXE: "Fixe", ETRANGER: "International" };

/**
 * LES POINTS DE CONTACT D'UNE FICHE — un par valeur lisible, dédoublonnés par (type, valeur normalisée) :
 * E.164 pour un téléphone (un champ « 0555 12 34 56 / 021 23 45 67 » en donne deux), minuscules pour un e-mail,
 * hôte pour un site. Rend aussi les valeurs ILLISIBLES, pour qu'on les compte et qu'on les montre.
 */
export function pointsDepuisFiche(c: ChampsContact): { points: PointCandidat[]; illisibles: string[] } {
  const parCle = new Map<string, PointCandidat>();
  const illisibles: string[] = [];
  const t = cleTitulaire(c.titulaire);
  const ajouter = (type: TypePointCandidat, valeur: string, valeurNormalisee: string, libelle: string | null) => {
    const cle = `contact|${t}|${type}|${valeurNormalisee}`;
    if (!parCle.has(cle)) parCle.set(cle, { cle, ...titulaireColonnes(c.titulaire), type, valeur, valeurNormalisee, libelle, source: c.source });
  };

  for (const { valeur, libelle } of c.telephones ?? []) {
    const brut = nettoyer(valeur);
    if (!brut) continue;
    const tels = extraireTelephones(brut);
    if (!tels.length) { illisibles.push(`téléphone « ${brut.slice(0, 40)} »`); continue; }
    for (const tel of tels) {
      ajouter("TELEPHONE", tels.length === 1 ? brut : tel.e164, tel.e164, libelle ?? NATURE_TEL[tel.nature] ?? null);
    }
  }
  for (const { valeur, libelle } of c.emails ?? []) {
    const brut = nettoyer(valeur);
    if (!brut) continue;
    if (!normaliserEmail(brut)) { illisibles.push(`e-mail « ${brut.slice(0, 60)} »`); continue; }
    ajouter("EMAIL", brut, emailNormalise(brut), libelle ?? null);
  }
  for (const { valeur, libelle } of c.sites ?? []) {
    const brut = nettoyer(valeur);
    if (!brut) continue;
    const hote = hoteDuSite(brut);
    if (!hote) { illisibles.push(`site « ${brut.slice(0, 60)} »`); continue; }
    ajouter("SITE", brut, hote, libelle ?? null);
  }
  return { points: [...parCle.values()], illisibles };
}
