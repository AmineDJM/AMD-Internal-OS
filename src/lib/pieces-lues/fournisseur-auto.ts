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

import {
  candidatsFournisseur, normaliserNif, normaliserRc, type ContactAnnuaire, type IdentifiantsDuGroupe,
} from "@/lib/pieces-lues/fournisseur";
import { emetteurEtDestinataire, estDuGroupe, ficheDuGroupe } from "@/lib/pieces-lues/emetteur-destinataire";
import { fusionnerIdentite, identiteEmetteurDuTexte, type IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";

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
