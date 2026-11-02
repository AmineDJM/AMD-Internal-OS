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
import { type SocieteDuGroupe, emetteurEtDestinataire, estDuGroupe, ficheDuGroupe } from "@/lib/pieces-lues/emetteur-destinataire";
import {
  PHRASE_FOURNISSEUR_A_CREER, phraseFournisseurAmbigu, phraseFournisseurCertain, phraseFournisseurProbable,
} from "@/lib/pieces-lues/phrases";
import { fusionnerIdentite, identiteEmetteurDuTexte, type IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FOURNISSEUR D'UN DEVIS DÉPOSÉ ENTRE DANS L'ANNUAIRE (Direction, 02/11/2026).
 *
 * « Quand on dépose un devis, on vérifie s'il existe dans l'annuaire ; s'il n'existe pas, il est
 * ajouté automatiquement. » Le devis d'un poste Ad & Pro et le devis de « Nouveau document » (Legal)
 * seulement — les autres circuits gardent la règle de `fournisseur.ts` (on propose, une personne crée).
 *
 *   même NIF ou même RC qu'une fiche (une seule)        → RATTACHER, certain
 *   le nom seul (`cleSociete`), une seule fiche          → RATTACHER, probable : DIT, à vérifier — jamais un quasi-doublon
 *   plusieurs fiches à égalité                           → RIEN : on ne choisit pas entre deux fiches
 *   aucune fiche, un nom lu                               → CRÉER (« Fournisseur »), avec ce que le papier imprime
 *   aucune fiche, pas de nom lisible                      → RIEN : une fiche sans nom ne se retrouve jamais
 *
 * Un nom tiré du seul NOM DU FICHIER (« Devis INSIGNE.pdf ») sert à reconnaître une fiche, jamais à en créer une :
 * le minimum pour créer, c'est un nom imprimé sur la pièce.
 *
 * L'annuaire confronté est l'annuaire ENTIER, pas celui que la personne voit : une fiche d'une autre
 * société du groupe recréée parce qu'on ne la voyait pas serait un doublon. Les fiches et les noms du
 * GROUPE sont écartés : le client d'un devis n'en est jamais le fournisseur.
 *
 * Module PUR : la décision se teste sans base ; l'écriture (verrou, création, audit) est dans
 * `fournisseur-annuaire.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


/** Le genre des fiches nées d'un devis : celui que l'annuaire filtre sous « Fournisseur ». */
export const GENRE_FOURNISSEUR = "Fournisseur";

/** Une raison sociale plus longue n'en est pas une : c'est une ligne du devis lue de travers. */
const NOM_MAX = 120;

export interface FicheACreer {
  name: string;
  nif: string | null;
  rc: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  rib: string | null;
}

export type DecisionFournisseurAuto =
  | { geste: "RATTACHER"; contactId: string; nom: string; certitude: "CERTAIN" | "PROBABLE" }
  | { geste: "CREER"; fiche: FicheACreer }
  | { geste: "RIEN"; raison: "AMBIGU"; noms: string[] }
  | { geste: "RIEN"; raison: "SANS_NOM" };

const propre = (v: string | null | undefined, max = 200): string | null => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * QUE FAIRE DU FOURNISSEUR LU — `annuaire` est l'annuaire ENTIER (fiches actives et mises de côté : une fiche mise de
 * côté reste la fiche de ce NIF, en recréer une serait un doublon).
 */
export function decisionFournisseurAuto(
  lu: IdentiteEmetteur,
  annuaire: readonly ContactAnnuaire[],
  groupe: IdentifiantsDuGroupe = {},
  opts: { nomDuFichierSeul?: boolean } = {},
): DecisionFournisseurAuto {
  const societes = groupe.societes ?? [];
  const nomLu = propre(lu.nom, NOM_MAX + 1);
  const nom = nomLu && nomLu.length <= NOM_MAX && !estDuGroupe(nomLu, societes) ? nomLu : null;
  const r = candidatsFournisseur(
    { nom, nifs: [lu.nif], rcs: [lu.rc] },
    societes.length ? annuaire.filter((c) => !ficheDuGroupe(c, societes)) : annuaire,
    groupe,
  );
  if (r.statut === "CERTAIN" || r.statut === "PROBABLE") {
    const c = r.candidats[0];
    return { geste: "RATTACHER", contactId: c.id, nom: c.nom, certitude: r.statut };
  }
  if (r.statut === "AMBIGU") return { geste: "RIEN", raison: "AMBIGU", noms: r.candidats.map((c) => c.nom) };
  if (!nom || opts.nomDuFichierSeul) return { geste: "RIEN", raison: "SANS_NOM" };
  // Les identifiants recopiés sont ceux du FOURNISSEUR : un NIF ou un RC du groupe (écarté par `candidatsFournisseur`)
  // ne s'écrit pas sur sa fiche.
  const nifs = new Set(r.aCreer?.nifs ?? []);
  const rcs = new Set(r.aCreer?.rcs ?? []);
  const nif = normaliserNif(lu.nif);
  const rc = normaliserRc(lu.rc);
  return {
    geste: "CREER",
    fiche: {
      name: nom,
      nif: nif && nifs.has(nif) ? propre(lu.nif, 40) : null,
      rc: rc && rcs.has(rc) ? propre(lu.rc, 60) : null,
      address: propre(lu.adresse),
      phone: propre(lu.telephone, 60),
      email: propre(lu.email, 120),
      rib: propre(lu.rib, 40),
    },
  };
}

/** Ce que l'ajout a fait, pour le message du dépôt et la fiche du devis. */
export type IssueFournisseurAuto =
  | { statut: "CREE" | "RECONNU" | "PROBABLE"; contactId: string; nom: string }
  | { statut: "AMBIGU"; noms: string[] }
  | { statut: "SANS_NOM" };

/** LA PHRASE DU DÉPÔT — une rédaction, que l'upload Ad & Pro et la création Legal disent pareil. */
export function phraseFournisseurAuto(i: IssueFournisseurAuto): string {
  switch (i.statut) {
    case "CREE": return `Nouveau fournisseur ajouté à l'annuaire : « ${i.nom} ».`;
    case "RECONNU": return `Fournisseur reconnu dans l'annuaire : « ${i.nom} ».`;
    case "PROBABLE":
      return `Fournisseur rattaché à « ${i.nom} » de l'annuaire par son nom seul (ni NIF ni RC ne le confirment) : vérifiez que c'est bien lui.`;
    case "AMBIGU":
      return `Plusieurs fiches de l'annuaire correspondent à ce fournisseur (${i.noms.slice(0, 3).map((n) => `« ${n} »`).join(", ")}) : aucune n'a été choisie ni créée — rattachez la bonne au devis.`;
    case "SANS_NOM":
      return "Le nom du fournisseur ne se lit pas sur ce devis : il n'a pas été ajouté à l'annuaire.";
  }
}

/** La note de la fiche créée : d'où elle vient, quand, par qui — une fiche automatique se reconnaît. */
export function noteFicheAutomatique(i: { titreDevis: string | null; deposant: string | null; le: Date }): string {
  const jour = `${String(i.le.getUTCDate()).padStart(2, "0")}/${String(i.le.getUTCMonth() + 1).padStart(2, "0")}/${i.le.getUTCFullYear()}`;
  const devis = i.titreDevis ? ` « ${i.titreDevis} »` : "";
  return `Ajouté automatiquement à l'annuaire depuis le devis${devis}, déposé le ${jour}${i.deposant ? ` par ${i.deposant}` : ""} — à compléter (contact, wilaya) au besoin.`;
}

/**
 * L'IDENTITÉ DE L'ÉMETTEUR, LUE LOCALEMENT sur le texte d'une pièce — la même composition que la lecture des pièces
 * (`service.ts`) : le nom par l'en-tête, le pied de page ou l'étiquette, hors du bloc client ; l'adresse, le
 * téléphone, l'e-mail et le RIB par leurs étiquettes. Aucun modèle : une pièce confidentielle se lit pareil.
 */
export function identiteLocaleDuDevis(
  texte: string, nomFichier: string, groupe: IdentifiantsDuGroupe = {},
): { identite: IdentiteEmetteur; nomDuFichierSeul: boolean } {
  const etiquete = identiteEmetteurDuTexte(texte);
  const ed = emetteurEtDestinataire({ texte, nomFichier, groupe: groupe.societes ?? [], nomEtiquete: etiquete.nom });
  return {
    identite: { ...fusionnerIdentite(etiquete, null), nom: ed.emetteur.nom, nif: ed.emetteur.nif ?? etiquete.nif, rc: ed.emetteur.rc ?? etiquete.rc },
    nomDuFichierSeul: SOURCE_NOM_DU_FICHIER === ed.emetteur.source,
  };
}

/** La source d'un nom tiré du nom du fichier (`emetteurEtDestinataire`). */
export const SOURCE_NOM_DU_FICHIER = "nom du fichier";
