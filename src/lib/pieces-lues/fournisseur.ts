/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI A ÉMIS LA PIÈCE ? — proposer un fournisseur de l'annuaire, sans jamais en choisir un
 * qui n'est pas sûr, ni en créer un (lot D2, décision 13, §118.34).
 *
 *   NIF ou RC identique à une fiche (espaces, points et casse mis à part)  → CERTAIN
 *   le nom seul (`cleSociete` : « Hetero Labs SARL » = « Hetero Labs »)       → PROBABLE
 *   plusieurs fiches à égalité (homonymes, ou deux fiches du même NIF)      → AMBIGU : aucun choix
 *   aucune                                                                  → « à créer par une personne »
 *
 * Une pièce porte DEUX identités : celle du fournisseur et celle du client (la société du
 * groupe). On ne devine pas laquelle est laquelle : les identifiants du GROUPE, quand l'appelant
 * les donne, sont écartés ; chaque autre identifiant lu est confronté à l'annuaire VISIBLE de la
 * personne, et si deux fiches distinctes répondent, c'est AMBIGU.
 *
 * Seul CERTAIN désigne `retenu` : c'est le seul cas où un écran peut préremplir le
 * fournisseur. Un nom seul ne le permet pas — deux sociétés peuvent le partager, et le BC
 * prendrait l'adresse, le RC et le NIF de la mauvaise.
 *
 * Module PUR : la normalisation des noms vient du moteur de qualité (`quality/model.ts`), pas
 * d'une seconde règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { cleSociete } from "@/lib/quality/model";
import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { PieceLue } from "@/lib/pieces-lues/structure";
import type { SocieteDuGroupe } from "@/lib/pieces-lues/emetteur-destinataire";
import {
  PHRASE_FOURNISSEUR_A_CREER, phraseFournisseurAmbigu, phraseFournisseurCertain, phraseFournisseurProbable,
} from "@/lib/pieces-lues/phrases";

/**
 * LE NIF, tel qu'il se compare : ses chiffres. Un NIF algérien en porte 15 (les plus récents 20) ;
 * « 001 916 012 345 678 » et « 001916012345678 » sont le même. `null` hors de cette forme.
 */
export function normaliserNif(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s || /[^\d\s.-]/.test(s)) return null;
  const chiffres = s.replace(/\D/g, "");
  return chiffres.length >= 15 && chiffres.length <= 20 ? chiffres : null;
}

/**
 * LE RC, tel qu'il se compare : lettres et chiffres, en majuscules. « 16/00-1234567 B 21 » et
 * « 16/00-1234567B21 » sont le même registre. Au moins cinq chiffres, sinon ce n'en est pas un.
 */
export function normaliserRc(v: string | null | undefined): string | null {
  const s = (v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return (s.match(/\d/g)?.length ?? 0) >= 5 ? s : null;
}

/** Une fiche de l'annuaire VISIBLE par la personne (portée déjà appliquée par l'appelant). */
export interface ContactAnnuaire {
  id: string;
  nom: string;
  nif?: string | null;
  rc?: string | null;
}

/** Ce que la lecture dit de l'émetteur : un nom (le modèle), des identifiants (le repérage et le modèle). */
export interface IdentiteLue {
  nom?: string | null;
  nifs?: readonly (string | null | undefined)[];
  rcs?: readonly (string | null | undefined)[];
}

export type StatutFournisseur = "CERTAIN" | "PROBABLE" | "AMBIGU" | "AUCUN";

export interface CandidatFournisseur {
  id: string;
  nom: string;
  par: "NIF" | "RC" | "NOM";
}

export interface ResultatFournisseur {
  statut: StatutFournisseur;
  /** La fiche à préremplir — seulement quand le statut est CERTAIN. */
  retenu: string | null;
  candidats: CandidatFournisseur[];
  phrase: string;
  /**
   * Ce qui a été lu, proposé à « Créer un contact » quand rien ne correspond — TOUS les identifiants
   * lus hors ceux du groupe : en retenir un choisirait l'identité à la place de la personne. Jamais créé ici.
   */
  aCreer: { nom: string | null; nifs: string[]; rcs: string[] } | null;
}

/** Les identifiants des sociétés du GROUPE : le client de la pièce, jamais son émetteur. */
export interface IdentifiantsDuGroupe {
  nifs?: readonly (string | null | undefined)[];
  rcs?: readonly (string | null | undefined)[];
  /** Les sociétés du groupe, avec leurs noms (lot B1) : un nom du groupe n'est jamais celui du fournisseur. */
  societes?: readonly SocieteDuGroupe[];
}

const uniques = (xs: readonly (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

export function candidatsFournisseur(
  lu: IdentiteLue,
  annuaireVisible: readonly ContactAnnuaire[],
  groupe: IdentifiantsDuGroupe = {},
): ResultatFournisseur {
  const nifsGroupe = new Set(uniques((groupe.nifs ?? []).map(normaliserNif)));
  const rcsGroupe = new Set(uniques((groupe.rcs ?? []).map(normaliserRc)));
  const nifs = new Set(uniques((lu.nifs ?? []).map(normaliserNif)).filter((x) => !nifsGroupe.has(x)));
  const rcs = new Set(uniques((lu.rcs ?? []).map(normaliserRc)).filter((x) => !rcsGroupe.has(x)));

  // 1 — LES IDENTIFIANTS. Une fiche répond par son NIF, sinon par son RC ; plusieurs fiches distinctes → AMBIGU.
  const parId: CandidatFournisseur[] = [];
  for (const c of annuaireVisible) {
    const nif = normaliserNif(c.nif);
    const rc = normaliserRc(c.rc);
    if (nif && nifs.has(nif)) parId.push({ id: c.id, nom: c.nom, par: "NIF" });
    else if (rc && rcs.has(rc)) parId.push({ id: c.id, nom: c.nom, par: "RC" });
  }
  if (parId.length === 1) {
    const [c] = parId;
    return { statut: "CERTAIN", retenu: c.id, candidats: parId, phrase: phraseFournisseurCertain(c.nom, c.par as "NIF" | "RC"), aCreer: null };
  }
  if (parId.length > 1) return { statut: "AMBIGU", retenu: null, candidats: parId, phrase: phraseFournisseurAmbigu(parId.map((c) => c.nom)), aCreer: null };

  // 2 — LE NOM SEUL : probable, jamais certain ; des homonymes à égalité ne désignent personne.
  const cle = cleSociete(lu.nom);
  const parNom: CandidatFournisseur[] = cle
    ? annuaireVisible.filter((c) => cleSociete(c.nom) === cle).map((c) => ({ id: c.id, nom: c.nom, par: "NOM" as const }))
    : [];
  if (parNom.length === 1) return { statut: "PROBABLE", retenu: null, candidats: parNom, phrase: phraseFournisseurProbable(parNom[0].nom), aCreer: null };
  if (parNom.length > 1) return { statut: "AMBIGU", retenu: null, candidats: parNom, phrase: phraseFournisseurAmbigu(parNom.map((c) => c.nom)), aCreer: null };

  // 3 — PERSONNE : on ne crée rien ; on propose ce qui a été lu à la personne qui créera la fiche.
  return {
    statut: "AUCUN", retenu: null, candidats: [], phrase: PHRASE_FOURNISSEUR_A_CREER,
    aCreer: { nom: lu.nom?.trim() || null, nifs: [...nifs], rcs: [...rcs] },
  };
}

/**
 * L'IDENTITÉ LUE d'une pièce, pour `candidatsFournisseur` : le nom de l'émetteur (le modèle, quand il a lu),
 * ses identifiants (le modèle) et TOUS ceux du repérage (fournisseur et client confondus — l'annuaire tranche).
 */
export function identiteLue(piece: Pick<PieceLue, "fournisseur"> | null, entetes: Pick<EntetesReperes, "nif" | "rc"> | null): IdentiteLue {
  return {
    nom: piece?.fournisseur.nom ?? null,
    nifs: [piece?.fournisseur.nif ?? null, ...(entetes?.nif ?? []).map((r) => r.valeur)],
    rcs: [piece?.fournisseur.rc ?? null, ...(entetes?.rc ?? []).map((r) => r.valeur)],
  };
}
