import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { PieceLue } from "@/lib/pieces-lues/structure";
import { identiteEmetteurDuTexte } from "@/lib/pieces-lues/emetteur";
import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";
import { htDesLignesLues, tvaCorroboree } from "@/lib/pieces-lues/prerempli-devis-promo";
import { cleSociete, plierTexte } from "@/lib/quality/model";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IDENTITÉ D'UNE FACTURE — « pas de double source de vérité, pas deux factures » (Direction, 14/10/2026).
 *
 * Une facture arrive par cinq portes : la demande de paiement, le poste Ad & Pro, le registre Legal, la fin d'une
 * demande au secrétariat, le dépôt libre d'un fichier « Facture ». Rien ne les comparait : la même facture pouvait
 * partir deux fois au paiement, une fois par porte. Ce module dit CE QU'EST une facture (son identité) et QUAND deux
 * factures sont la même — sans base, sans réseau : la décision est du CODE, jamais un avis de Luna.
 *
 * ── LA LECTURE VIENT DE LUNA, LA COMPARAISON DU CODE ────────────────────────────────────────
 *
 * Luna recopie la pièce (`pieces-lues/structure.ts`) ; le repérage sur le papier (`entetes.ts`, `emetteur.ts`) lit
 * l'en-tête et les totaux avec leur preuve. L'identité ne garde que ce qui TIENT :
 *   • le NUMÉRO repéré sur le papier, sinon celui du modèle s'il est imprimé tel quel (un numéro que le texte ne porte
 *     pas a été inventé : il est écarté) ;
 *   • le FOURNISSEUR par ses étiquettes imprimées (NIF, RC, raison sociale), le modèle en complément — jamais un
 *     identifiant du groupe (le client de la pièce n'en est pas l'émetteur) ;
 *   • le TTC imprimé (« Total TTC », « Net à payer ») ; celui du modèle seulement s'il est cohérent : pas inférieur au
 *     HT, et sa TVA corroborée par le papier (`tvaCorroboree`) — une TVA que le modèle a seul vue n'entre pas ;
 *   • la NATURE : facture, pro forma, avoir, acompte — lue au titre de la pièce, pas à une mention en passant
 *     (« suivant facture proforma n° … », « acompte versé ») ;
 *   • la DATE d'émission.
 * Un champ illisible vaut `null` : on ne devine rien.
 *
 * ── LES TROIS NIVEAUX ───────────────────────────────────────────────────────────────────────
 *
 *   CERTAIN   même fichier (empreinte SHA-256) ; ou même fournisseur (NIF, sinon RC, sinon nom normalisé) + même
 *             numéro, fournisseur et numéro LUS des deux côtés (jamais saisis), + même nature. Un TTC ou une date qui
 *             se contredisent ramènent à PROBABLE.
 *             C'est le SEUL niveau qui bloque un dépôt.
 *   PROBABLE  même numéro mais un doute (NIF à un caractère près, numéro saisi à la main, nature inconnue d'un côté) ;
 *             ou, faute de numéro d'un côté, même fournisseur + même TTC + même date. Avertit, marque, ne bloque pas.
 *   AUCUN     le reste — et en particulier deux NATURES différentes (une pro forma face à sa facture finale, un avoir),
 *             deux acomptes sans numéro commun, le même numéro chez deux fournisseurs.
 *
 * L'OBJECTIF EST ZÉRO FAUX CERTAIN : bloquer à tort une vraie facture arrête un paiement dû. Le banc
 * `identite.banc.test.ts` rejoue les pièges réels (papier rescanné, photo floue, pro forma, avoir, acomptes, NIF mal lu,
 * TVA hallucinée, TTC pris pour HT) à chaque modification.
 *
 * Module PUR : aucun accès base. Le serveur (`factures/connues.ts`) charge les factures et appelle ces règles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_FACTURE = ["FACTURE", "PRO_FORMA", "AVOIR", "ACOMPTE"] as const;
export type NatureFacture = (typeof NATURES_FACTURE)[number];

export const LIBELLE_NATURE: Record<NatureFacture, string> = {
  FACTURE: "facture",
  PRO_FORMA: "facture pro forma",
  AVOIR: "avoir",
  ACOMPTE: "facture d'acompte",
};

/** D'où vient un champ : LU sur la pièce (Luna + repérage), ou SAISI à la main dans un formulaire. */
export type SourceChamp = "LU" | "SAISI";

export interface FournisseurFacture {
  nom: string | null;
  /** `cleSociete(nom)` — formes juridiques et casse mises à part ; `null` si vide. */
  cle: string | null;
  /** Chiffres seulement (15 à 20). */
  nif: string | null;
  rc: string | null;
}

export interface IdentiteFacture {
  /** SHA-256 des fichiers (hexadécimal, le format de `FileBlob.sha256`). */
  empreintes: string[];
  fournisseur: FournisseurFacture;
  /** D'où vient le fournisseur : un fournisseur SAISI (le bénéficiaire d'une demande) ne fait jamais un CERTAIN. */
  fournisseurSource: SourceChamp | null;
  /** Le numéro tel qu'imprimé. */
  numero: string | null;
  /** Le numéro tel qu'il se compare (`cleNumero`). */
  numeroCle: string | null;
  numeroSource: SourceChamp | null;
  /** ISO `AAAA-MM-JJ`. */
  date: string | null;
  ttc: number | null;
  nature: NatureFacture | null;
  /** Ce que les garde-fous ont écarté, dit en clair — jamais montré comme une donnée. */
  reserves: string[];
}

export const IDENTITE_FACTURE_VIDE: IdentiteFacture = {
  empreintes: [], fournisseur: { nom: null, cle: null, nif: null, rc: null }, fournisseurSource: null,
  numero: null, numeroCle: null, numeroSource: null, date: null, ttc: null, nature: null, reserves: [],
};

// ─────────────────────────────── Normalisations ───────────────────────────────

/** Les mots qui précèdent un numéro sans en faire partie (« N° », « Facture n° », « Réf. »). */
const MOTS_AVANT_NUMERO = new Set(["N", "NO", "NUM", "NUMERO", "FACTURE", "FACT", "REF", "REFERENCE"]);

/**
 * LE NUMÉRO TEL QU'IL SE COMPARE — ses groupes de lettres et de chiffres, zéros de tête retirés : « FA-2026/0012 »,
 * « FA 2026 12 » et « fa2026-012 » sont le même ; « 12/2026 » et « 2026/12 » ne le sont pas. Sans aucun chiffre, ce
 * n'est pas un numéro : `null`.
 */
export function cleNumero(v: string | null | undefined): string | null {
  const groupes = plierTexte(v).toUpperCase().match(/[A-Z]+|\d+/g) ?? [];
  while (groupes.length > 0 && MOTS_AVANT_NUMERO.has(groupes[0] as string)) groupes.shift();
  if (!groupes.some((g) => /\d/.test(g))) return null;
  return groupes.map((g) => (/^\d+$/.test(g) ? g.replace(/^0+(?=\d)/, "") : g)).join("-");
}

/** Lettres et chiffres seulement, pliés — pour vérifier qu'une valeur est IMPRIMÉE dans le texte. */
const compact = (s: string | null | undefined): string => plierTexte(s).replace(/[^a-z0-9]/g, "");

/** La valeur est-elle imprimée telle quelle dans le texte ? (au moins deux caractères utiles) */
export function imprimeDansLeTexte(valeur: string | null | undefined, texte: string | null | undefined): boolean {
  const v = compact(valeur);
  return v.length >= 2 && compact(texte).includes(v);
}

/**
 * LE NUMÉRO DU MODÈLE EST-IL IMPRIMÉ COMME UN NUMÉRO ? — sur une ligne qui parle de numéro (« N° », « Facture »,
 * « Réf. »). Imprimé n'importe où ne suffit pas : « 145 » se retrouve dans « 145 000,00 ».
 */
export function imprimeCommeNumero(valeur: string | null | undefined, texte: string | null | undefined): boolean {
  const v = compact(valeur);
  if (v.length < 2) return false;
  return (texte ?? "").split(/\r?\n/).some((l) => {
    const p = plierTexte(l);
    return compact(l).includes(v) && /(?:^|[^a-z])(?:n\s*[°o]|no|num|numero|facture|fact|ref|reference)(?:[^a-z]|$)/.test(p);
  });
}

/** Deux chaînes de même longueur qui diffèrent d'au plus un caractère (un chiffre mal lu). */
export function aUnCaracterePres(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let ecarts = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++ecarts > 1) return false;
  return true;
}

// ─────────────────────────────── La nature ───────────────────────────────

/** Les premières lignes non vides, pliées : le TITRE de la pièce s'y trouve, les mentions en passant plus bas. */
function lignesDeTete(texte: string | null | undefined, n = 25): string[] {
  return (texte ?? "").split(/\r?\n/).map((l) => plierTexte(l).replace(/^[^a-z0-9]+/, "")).filter(Boolean).slice(0, n);
}

/**
 * LA NATURE DE LA PIÈCE, lue à son TITRE — une ligne qui COMMENCE par « Facture pro forma », « Avoir n° »,
 * « Facture d'acompte » —, ou au type que repérage et modèle ont lu. « Suivant facture proforma n° PF-12 » et
 * « Acompte versé : 50 000 » sur une facture finale ne commencent pas une ligne par le titre : elles ne changent pas sa
 * nature. Sans titre ni type : `null` (inconnue).
 */
export function natureDeLaPiece(i: {
  texte?: string | null; typeRepere?: string | null; typeModele?: string | null; extraitNumero?: string | null;
}): NatureFacture | null {
  const lignes = [plierTexte(i.extraitNumero ?? "").replace(/^[^a-z0-9]+/, ""), ...lignesDeTete(i.texte)].filter(Boolean);
  const une = (re: RegExp) => lignes.some((l) => re.test(l));
  if (une(/^(?:facture\s*)?pro\s*-?\s*forma\b/) || une(/^proforma/)) return "PRO_FORMA";
  if (i.typeRepere === "AVOIR" || i.typeModele === "AVOIR" || une(/^(?:facture|note)\s+d\s*avoir\b/) || une(/^avoir\s+n\b/)) return "AVOIR";
  if (une(/^facture\s+d\s*acompte\b/) || une(/^acompte\s+n\b/) || une(/^facture\s+d\s*avance\b/)) return "ACOMPTE";
  if (i.typeRepere === "FACTURE" || i.typeModele === "FACTURE" || une(/^facture\b/)) return "FACTURE";
  return null;
}

/** Une nature écrite dans un TITRE de registre (« Facture d'acompte — … ») ; `null` si le titre n'en dit rien. */
export function natureDuTitre(titre: string | null | undefined): NatureFacture | null {
  const t = plierTexte(titre);
  if (/pro\s*-?\s*forma/.test(t)) return "PRO_FORMA";
  if (/\bavoir\b/.test(t)) return "AVOIR";
  if (/\bacompte\b/.test(t)) return "ACOMPTE";
  return null;
}

// ─────────────────────────────── Le TTC ───────────────────────────────

/**
 * LE TTC QUI TIENT. Le papier d'abord (« Total TTC », sinon « Net à payer », repérés avec leur preuve). Celui du
 * modèle n'est repris que cohérent : en dinars, pas inférieur au HT, et — s'il porte une TVA — une TVA que le papier
 * corrobore (`tvaCorroboree`). Une TVA hallucinée fabriquerait un TTC qui n'existe pas ; un TTC égal au HT sous une TVA
 * non nulle dit que le modèle a confondu les deux colonnes : écarté.
 */
export function ttcFiable(entetes: EntetesReperes | null, piece: PieceLue | null, reserves: string[] = []): number | null {
  const papier = entetes?.totalTtc?.valeur ?? entetes?.netAPayer?.valeur ?? null;
  if (typeof papier === "number" && papier > 0) return papier;
  if (!piece) return null;
  const t = piece.totaux;
  if (t.ttc == null || !(t.ttc > 0)) return null;
  if (piece.devise && piece.devise !== "DZD") { reserves.push(`TTC en ${piece.devise} : non comparé.`); return null; }
  const tauxLignes = piece.lignes.map((l) => l.tva).filter((x): x is number => typeof x === "number" && x > 0);
  const taux = piece.tvaDefaut ?? (tauxLignes.length > 0 ? tauxLignes[0] : null) ?? (t.tva && t.ht ? t.tva / t.ht : null);
  const avecTva = (t.tva ?? 0) > 0 || (taux ?? 0) > 0;
  if (avecTva) {
    if (!entetes || taux == null || !tvaCorroboree(entetes, taux, htDesLignesLues(piece))) {
      reserves.push("TVA proposée par la lecture mais absente du papier : le TTC de la lecture est écarté.");
      return null;
    }
  }
  if (t.ht != null && t.ht > 0) {
    if (t.ttc + 0.005 < t.ht) { reserves.push("TTC lu inférieur au HT lu : colonnes confondues, TTC écarté."); return null; }
    if (avecTva && Math.abs(t.ttc - t.ht) < 1) { reserves.push("TTC lu égal au HT malgré une TVA : colonnes confondues, TTC écarté."); return null; }
  }
  return t.ttc;
}

// ─────────────────────────────── L'identité d'une lecture ───────────────────────────────

export interface LectureDeFacture {
  /** L'empreinte du fichier lu (et d'autres fichiers de la même pièce, s'il y en a). */
  empreintes: readonly (string | null | undefined)[];
  /** Le texte lu (natif ou OCR) — c'est contre lui qu'on vérifie que le modèle n'invente rien. `null` si perdu. */
  texte: string | null;
  entetes: EntetesReperes | null;
  /** La recopie du modèle (Luna), `null` sans modèle. */
  piece: PieceLue | null;
  /** Les identifiants des sociétés du GROUPE : le client, jamais l'émetteur. */
  groupe?: { nifs?: readonly (string | null | undefined)[]; rcs?: readonly (string | null | undefined)[] };
}

const uniques = (xs: readonly (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))];

/**
 * L'IDENTITÉ D'UNE FACTURE LUE — chaque champ passé par son garde-fou. Ce qui ne tient pas reste `null`, et la raison
 * va dans `reserves`.
 */
export function identiteDepuisLecture(l: LectureDeFacture): IdentiteFacture {
  const reserves: string[] = [];
  const texte = l.texte ?? null;
  const e = l.entetes;
  const p = l.piece;

  // LE NUMÉRO — repéré sur le papier, sinon celui du modèle s'il est IMPRIMÉ tel quel.
  let numero: string | null = null;
  if (e?.numero?.valeur && cleNumero(e.numero.valeur)) numero = e.numero.valeur;
  else if (p?.numero) {
    if (imprimeCommeNumero(p.numero, texte)) numero = p.numero;
    else reserves.push("Numéro proposé par la lecture mais absent du texte de la pièce : écarté.");
  }
  const numeroCle = cleNumero(numero);

  // LE FOURNISSEUR — les étiquettes imprimées d'abord ; le modèle pour ce qu'elles ne portent pas, s'il est imprimé.
  const papier = texte ? identiteEmetteurDuTexte(texte) : null;
  const nifsGroupe = new Set(uniques((l.groupe?.nifs ?? []).map(normaliserNif)));
  const rcsGroupe = new Set(uniques((l.groupe?.rcs ?? []).map(normaliserRc)));
  const horsGroupeNif = (v: string | null) => (v && !nifsGroupe.has(v) ? v : null);
  const horsGroupeRc = (v: string | null) => (v && !rcsGroupe.has(v) ? v : null);
  const nifModele = normaliserNif(p?.fournisseur.nif ?? null);
  const rcModele = normaliserRc(p?.fournisseur.rc ?? null);
  // Le repérage lit TOUS les identifiants imprimés (fournisseur ET client) : hors ceux du groupe, s'il n'en reste qu'UN,
  // c'est celui de l'émetteur. Deux restants : on ne choisit pas.
  const seul = (xs: readonly (string | null)[]) => { const u = uniques(xs); return u.length === 1 ? (u[0] as string) : null; };
  const nifRepere = seul((e?.nif ?? []).map((r) => horsGroupeNif(normaliserNif(r.valeur))));
  const rcRepere = seul((e?.rc ?? []).map((r) => horsGroupeRc(normaliserRc(r.valeur))));
  const nif = horsGroupeNif(normaliserNif(papier?.nif ?? null))
    ?? nifRepere
    ?? (nifModele && imprimeDansLeTexte(nifModele, (texte ?? "").replace(/\D/g, "")) ? horsGroupeNif(nifModele) : null);
  const rc = rcRepere
    ?? horsGroupeRc(((r) => (r && r.length <= 20 ? r : null))(normaliserRc(papier?.rc ?? null)))
    ?? (rcModele && imprimeDansLeTexte(rcModele, texte) ? horsGroupeRc(rcModele) : null);
  const nomModele = p?.fournisseur.nom?.trim() || null;
  const nom = papier?.nom?.trim() || (nomModele && imprimeDansLeTexte(nomModele, texte) ? nomModele : null);
  if (!papier?.nom && nomModele && !nom) reserves.push("Fournisseur proposé par la lecture mais absent du texte : écarté.");

  return {
    empreintes: uniques(l.empreintes),
    fournisseur: { nom, cle: cleSociete(nom) || null, nif, rc },
    fournisseurSource: nom || nif || rc ? "LU" : null,
    numero,
    numeroCle,
    numeroSource: numeroCle ? "LU" : null,
    date: e?.date?.valeur ?? p?.date ?? null,
    ttc: ttcFiable(e, p, reserves),
    nature: natureDeLaPiece({ texte, typeRepere: e?.type ?? null, typeModele: p?.type ?? null, extraitNumero: e?.numero?.extrait ?? null }),
    reserves,
  };
}

/**
 * L'IDENTITÉ D'UNE FACTURE QU'ON N'A PAS LUE — ce que le formulaire a saisi (n° de facture, partie, montant). Un champ
 * SAISI ne fait jamais un CERTAIN par le numéro : une saisie peut porter le numéro du BC, ou celui d'une autre pièce.
 */
export function identiteDepuisSaisie(s: {
  empreintes?: readonly (string | null | undefined)[];
  numero?: string | null; fournisseur?: string | null; nif?: string | null; ttc?: number | null; date?: string | null; titre?: string | null;
}): IdentiteFacture {
  const numeroCle = cleNumero(s.numero ?? null);
  const nom = s.fournisseur?.trim() || null;
  return {
    empreintes: uniques(s.empreintes ?? []),
    fournisseur: { nom, cle: cleSociete(nom) || null, nif: normaliserNif(s.nif ?? null), rc: null },
    fournisseurSource: nom || s.nif ? "SAISI" : null,
    numero: numeroCle ? (s.numero ?? null) : null,
    numeroCle,
    numeroSource: numeroCle ? "SAISI" : null,
    date: s.date ?? null,
    ttc: typeof s.ttc === "number" && s.ttc > 0 ? s.ttc : null,
    nature: natureDuTitre(s.titre),
    reserves: [],
  };
}

/** Deux identités de la MÊME pièce (un fichier lu, et ce qu'on en a saisi) : le lu l'emporte, la saisie complète. */
export function completerIdentite(lue: IdentiteFacture, saisie: IdentiteFacture | null): IdentiteFacture {
  if (!saisie) return lue;
  const numeroLu = lue.numeroCle !== null;
  const fournisseurLu = lue.fournisseurSource === "LU";
  return {
    empreintes: uniques([...lue.empreintes, ...saisie.empreintes]),
    fournisseur: {
      nom: lue.fournisseur.nom ?? saisie.fournisseur.nom,
      cle: lue.fournisseur.cle ?? saisie.fournisseur.cle,
      nif: lue.fournisseur.nif ?? saisie.fournisseur.nif,
      rc: lue.fournisseur.rc ?? saisie.fournisseur.rc,
    },
    fournisseurSource: fournisseurLu ? "LU" : saisie.fournisseurSource,
    numero: numeroLu ? lue.numero : saisie.numero,
    numeroCle: numeroLu ? lue.numeroCle : saisie.numeroCle,
    numeroSource: numeroLu ? lue.numeroSource : saisie.numeroSource,
    date: lue.date ?? saisie.date,
    ttc: lue.ttc ?? saisie.ttc,
    nature: lue.nature ?? saisie.nature,
    reserves: lue.reserves,
  };
}

// ─────────────────────────────── La comparaison ───────────────────────────────

export type NiveauDoublon = "CERTAIN" | "PROBABLE" | "AUCUN";
export type MotifDoublon = "MEME_FICHIER" | "MEME_NUMERO" | "NUMERO_A_CONFIRMER" | "MEME_MONTANT_ET_DATE";

export interface Rapprochement {
  niveau: NiveauDoublon;
  motif: MotifDoublon | null;
  /** La raison, en une phrase lisible par les Finances. */
  raison: string;
}

type MemeFournisseur = "NIF" | "RC" | "NOM" | "PROCHE" | "DIFFERENT" | "INCONNU";

/**
 * LE MÊME FOURNISSEUR ? Par le NIF quand les deux en ont un ; sinon par le RC ; sinon par le nom normalisé. Deux NIF (ou
 * RC) qui ne diffèrent que d'un caractère, sous le MÊME nom, sont un identifiant mal lu : PROCHE — jamais certain.
 */
export function memeFournisseur(a: FournisseurFacture, b: FournisseurFacture): MemeFournisseur {
  const memeNom = Boolean(a.cle && b.cle && a.cle === b.cle);
  if (a.nif && b.nif) {
    if (a.nif === b.nif) return "NIF";
    return memeNom && aUnCaracterePres(a.nif, b.nif) ? "PROCHE" : "DIFFERENT";
  }
  if (a.rc && b.rc) {
    if (a.rc === b.rc) return "RC";
    return memeNom && aUnCaracterePres(a.rc, b.rc) ? "PROCHE" : "DIFFERENT";
  }
  if (a.cle && b.cle) return memeNom ? "NOM" : "DIFFERENT";
  return "INCONNU";
}

const TOLERANCE_TTC = 1; // un dinar, la tolérance de toutes les retranscriptions du dépôt

const aucun = (raison: string): Rapprochement => ({ niveau: "AUCUN", motif: null, raison });

/**
 * DEUX FACTURES SONT-ELLES LA MÊME ? — la règle, dans l'ordre. Symétrique : `comparerFactures(a, b)` et
 * `comparerFactures(b, a)` rendent le même niveau.
 */
export function comparerFactures(a: IdentiteFacture, b: IdentiteFacture): Rapprochement {
  // 1 — LE MÊME FICHIER, octet pour octet : la même pièce, quoi qu'en dise la lecture.
  const fichiers = new Set(a.empreintes);
  if (b.empreintes.some((e) => fichiers.has(e))) {
    return { niveau: "CERTAIN", motif: "MEME_FICHIER", raison: "Le même fichier (même empreinte SHA-256)." };
  }

  // 2 — DEUX NATURES DIFFÉRENTES ne sont jamais la même pièce : la pro forma et sa facture finale, l'avoir et la facture.
  if (a.nature && b.nature && a.nature !== b.nature) {
    return aucun(`Natures différentes (${LIBELLE_NATURE[a.nature]} / ${LIBELLE_NATURE[b.nature]}).`);
  }

  // 3 — LE MÊME FOURNISSEUR, ou rien ne se compare.
  const f = memeFournisseur(a.fournisseur, b.fournisseur);
  if (f === "DIFFERENT") return aucun("Fournisseurs différents.");
  if (f === "INCONNU") return aucun("Le fournisseur de l'une des deux pièces ne se lit pas.");

  const ttcContredit = a.ttc != null && b.ttc != null && Math.abs(a.ttc - b.ttc) > TOLERANCE_TTC;
  const dateContredite = a.date != null && b.date != null && a.date !== b.date;

  // 4 — LES DEUX NUMÉROS SE LISENT.
  if (a.numeroCle && b.numeroCle) {
    if (a.numeroCle !== b.numeroCle) return aucun("Numéros différents.");
    const sur = (f === "NIF" || f === "RC" || f === "NOM")
      && a.numeroSource === "LU" && b.numeroSource === "LU"
      && a.fournisseurSource === "LU" && b.fournisseurSource === "LU"
      && a.nature !== null && a.nature === b.nature
      && !ttcContredit && !dateContredite;
    if (sur) {
      return { niveau: "CERTAIN", motif: "MEME_NUMERO", raison: `Même fournisseur (${f === "NOM" ? "même raison sociale" : `même ${f}`}) et même numéro de facture.` };
    }
    const doutes = [
      f === "PROCHE" ? "identifiant fiscal à un caractère près" : null,
      a.numeroSource !== "LU" || b.numeroSource !== "LU" ? "numéro saisi à la main" : null,
      a.fournisseurSource !== "LU" || b.fournisseurSource !== "LU" ? "fournisseur saisi à la main" : null,
      a.nature === null || b.nature === null ? "nature de la pièce non lue" : null,
      ttcContredit ? "montants TTC différents" : null,
      dateContredite ? "dates différentes" : null,
    ].filter(Boolean);
    return { niveau: "PROBABLE", motif: "NUMERO_A_CONFIRMER", raison: `Même numéro de facture, mais à confirmer : ${doutes.join(", ")}.` };
  }

  // 5 — UN NUMÉRO MANQUE : même fournisseur, même TTC, même date — probable, jamais certain. Deux ACOMPTES du même
  //     fournisseur portent souvent le même montant : sans numéro commun, ils ne se rapprochent pas.
  if (a.nature === "ACOMPTE" || b.nature === "ACOMPTE") return aucun("Deux acomptes sans numéro commun.");
  if (f !== "PROCHE" && a.ttc != null && b.ttc != null && !ttcContredit && a.date && b.date && !dateContredite) {
    return { niveau: "PROBABLE", motif: "MEME_MONTANT_ET_DATE", raison: "Même fournisseur, même montant TTC et même date, numéro illisible ou absent." };
  }
  return aucun("Rien ne permet de dire que c'est la même pièce.");
}

// ─────────────────────────────── Le recensement ───────────────────────────────

/** Une facture connue, telle que le recensement la groupe. */
export interface FacturePourRecensement {
  cle: string;
  /** La maison où elle vit (registre, pièce d'une demande, fichier d'un dossier). */
  maison: string;
  /**
   * LES CLÉS D'INSTANCE — l'ordre de dépense qu'elle paie, la fiche qui la porte. Deux enregistrements de MAISONS
   * différentes qui partagent une clé sont la MÊME facture vue à deux endroits (la facture du poste et sa copie dans le
   * dossier compagnon de son ordre) : ce n'est pas un doublon.
   */
  instances: readonly string[];
  identite: IdentiteFacture;
}

export interface GroupeDeDoublons<T> {
  niveau: "CERTAIN" | "PROBABLE";
  membres: T[];
  raisons: string[];
}

/** Même facture vue à deux endroits (maisons différentes, une instance commune) ? */
export function memeInstance(a: Pick<FacturePourRecensement, "maison" | "instances">, b: Pick<FacturePourRecensement, "maison" | "instances">): boolean {
  if (a.maison === b.maison) return false;
  const s = new Set(a.instances);
  return b.instances.some((x) => s.has(x));
}

function trouver(parent: Map<string, string>, x: string): string {
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r) as string;
  parent.set(x, r);
  return r;
}

/**
 * LES GROUPES DE DOUBLONS d'une liste de factures — CERTAINS d'abord, puis PROBABLES (une paire probable dont les deux
 * membres sont déjà dans le même groupe certain n'en refait pas un). Les paires ne se cherchent que là où elles
 * peuvent exister — même empreinte, même numéro, ou même TTC à la même date —, jamais en comparant tout à tout.
 */
export function groupesDeDoublons<T extends FacturePourRecensement>(liste: readonly T[]): GroupeDeDoublons<T>[] {
  const seaux = new Map<string, number[]>();
  const poser = (k: string, i: number) => seaux.set(k, [...(seaux.get(k) ?? []), i]);
  liste.forEach((f, i) => {
    for (const e of f.identite.empreintes) poser(`F:${e}`, i);
    if (f.identite.numeroCle) poser(`N:${f.identite.numeroCle}`, i);
    if (f.identite.ttc != null && f.identite.date) poser(`M:${Math.round(f.identite.ttc)}|${f.identite.date}`, i);
  });
  const vues = new Set<string>();
  const aretes: { a: number; b: number; r: Rapprochement }[] = [];
  for (const membres of seaux.values()) {
    for (let x = 0; x < membres.length; x++) {
      for (let y = x + 1; y < membres.length; y++) {
        const [a, b] = membres[x] < membres[y] ? [membres[x], membres[y]] : [membres[y], membres[x]];
        const k = `${a}|${b}`;
        if (vues.has(k)) continue;
        vues.add(k);
        if (memeInstance(liste[a], liste[b])) continue;
        const r = comparerFactures(liste[a].identite, liste[b].identite);
        if (r.niveau !== "AUCUN") aretes.push({ a, b, r });
      }
    }
  }
  const grouper = (niveau: "CERTAIN" | "PROBABLE", exclure: (a: number, b: number) => boolean): GroupeDeDoublons<T>[] => {
    const parent = new Map<string, string>();
    const raisons = new Map<string, Set<string>>();
    for (const { a, b, r } of aretes) {
      if (r.niveau !== niveau || exclure(a, b)) continue;
      for (const i of [a, b]) if (!parent.has(String(i))) parent.set(String(i), String(i));
      const ra = trouver(parent, String(a));
      const rb = trouver(parent, String(b));
      if (ra !== rb) parent.set(ra, rb);
      const racine = trouver(parent, String(b));
      raisons.set(racine, new Set([...(raisons.get(ra) ?? []), ...(raisons.get(rb) ?? []), r.raison]));
    }
    const groupes = new Map<string, number[]>();
    for (const i of parent.keys()) {
      const r = trouver(parent, i);
      groupes.set(r, [...(groupes.get(r) ?? []), Number(i)]);
    }
    return [...groupes.entries()].map(([r, idx]) => ({
      niveau,
      membres: idx.sort((x, y) => x - y).map((i) => liste[i]),
      raisons: [...(raisons.get(r) ?? [])],
    }));
  };
  const certains = grouper("CERTAIN", () => false);
  const groupeCertain = new Map<number, number>();
  certains.forEach((g, gi) => g.membres.forEach((m) => groupeCertain.set(liste.indexOf(m), gi)));
  const probables = grouper("PROBABLE", (a, b) => groupeCertain.has(a) && groupeCertain.get(a) === groupeCertain.get(b));
  return [...certains, ...probables];
}
