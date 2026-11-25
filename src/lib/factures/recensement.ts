import { createHash } from "node:crypto";
import { chargerFacturesConnues, type FactureConnue } from "@/lib/factures/connues";
import { groupesDeDoublons, LIBELLE_NATURE } from "@/lib/factures/identite";
import { PHRASE_ETAT_PAIEMENT } from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RECENSEMENT UNIQUE DES DOUBLONS DÉJÀ EN BASE (Direction, 14/10/2026) — « on fait un passage unique sur les
 * factures déjà en base pour lister aux Finances les doublons existants ».
 *
 * LECTURE SEULE : il charge toutes les factures connues (`chargerFacturesConnues` — registre, pièces des demandes,
 * fichiers « Facture » des dossiers), les groupe par la règle du blocage (`groupesDeDoublons`) et rend des lignes
 * lisibles. Il ne relit AUCUNE pièce (pas d'appel à Luna) : l'identité d'une facture déjà déposée est sa lecture gardée
 * (`LecturePiece`), à défaut ce qui a été saisi, et toujours l'empreinte de son fichier. Rien n'est corrigé, fusionné ni
 * annulé : les Finances examinent, pièce en main.
 *
 * Lecteurs : le script `npm run factures:doublons` (passage unique, base en lecture seule) et la Comptabilité (« ressemble
 * à »). L'écran « Doublons de factures » est supprimé (Super Admin, 25/11/2026) : la détection, elle, reste — ici, au centre
 * de paiement (« doublon possible ») et dans la Comptabilité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MembreRecense {
  cle: string;
  module: string;
  piece: string;
  documentId: string | null;
  dossier: { type: string; id: string; titre: string; lien: string | null };
  numero: string | null;
  fournisseur: string | null;
  date: string | null;
  ttc: number | null;
  nature: string | null;
  /** La référence du paiement (ordre ou demande), et où il en est. */
  paiement: string | null;
  etat: string;
  creeLe: string;
}

export interface GroupeRecense {
  /** Stable d'un passage à l'autre : l'empreinte des clés de ses membres. */
  signature: string;
  niveau: "CERTAIN" | "PROBABLE";
  raisons: string[];
  membres: MembreRecense[];
}

export interface Recensement {
  facturesExaminees: number;
  groupes: GroupeRecense[];
}

function membre(f: FactureConnue): MembreRecense {
  return {
    cle: f.cle, module: f.module, piece: f.pieceNom, documentId: f.documentId,
    dossier: { type: f.dossier.type, id: f.dossier.id, titre: f.dossier.titre, lien: f.dossier.lien },
    numero: f.identite.numero, fournisseur: f.identite.fournisseur.nom, date: f.identite.date,
    ttc: f.identite.ttc ?? f.dossier.montant, nature: f.identite.nature ? LIBELLE_NATURE[f.identite.nature] : null,
    paiement: f.ordre?.reference ?? f.demande?.reference ?? null,
    etat: PHRASE_ETAT_PAIEMENT[f.etat], creeLe: f.creeLe,
  };
}

export function signatureDuGroupe(cles: readonly string[]): string {
  return createHash("sha256").update([...cles].sort().join("|")).digest("hex").slice(0, 24);
}

/** LE RECENSEMENT — les groupes CERTAINS d'abord, puis les PROBABLES ; les plus récents en tête dans chaque niveau. */
export async function recenserDoublonsFactures(): Promise<Recensement> {
  const factures = await chargerFacturesConnues();
  const groupes = groupesDeDoublons(factures).map((g) => {
    const membres = g.membres.map(membre).sort((a, b) => a.creeLe.localeCompare(b.creeLe));
    return { signature: signatureDuGroupe(membres.map((m) => m.cle)), niveau: g.niveau, raisons: g.raisons, membres };
  });
  const recent = (g: GroupeRecense) => g.membres.reduce((m, x) => (x.creeLe > m ? x.creeLe : m), "");
  groupes.sort((a, b) => (a.niveau === b.niveau ? recent(b).localeCompare(recent(a)) : a.niveau === "CERTAIN" ? -1 : 1));
  return { facturesExaminees: factures.length, groupes };
}
