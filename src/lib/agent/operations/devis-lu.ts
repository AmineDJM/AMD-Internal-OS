import { annuaireDeLecture, proposerLecture, type PropositionDeLecture } from "@/lib/pieces-lues/service";
import { lectureDevisPromo } from "@/lib/pieces-lues/prerempli-devis-promo";
import type { CurrentUser } from "@/lib/session";
import { fichiersDepuisDrive, resoudrePiece, type PieceResolue } from "./pieces";
import { arrondirAuCentime } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UN DEVIS OU UNE FACTURE — par la lecture des pièces de l'ERP, jamais par l'assistant.
 *
 * Le fichier (Drive ou glissé dans la conversation) doit être VISIBLE par la personne. Il est lu par
 * le service de lecture des pièces (`proposerLecture`) : une fois par empreinte, en-tête et totaux
 * repérés par des règles, lignes proposées par la lecture que la Direction a ouverte (ou rien, dit).
 * Le TEXTE du fichier ne sort jamais vers le modèle de l'assistant : il reçoit des LIGNES et des
 * TOTAUX déjà structurés, plus le nom du fournisseur — ni RIB, ni téléphone, ni adresse.
 *
 * Les chiffres d'un bon de commande composé depuis ce devis viennent d'ICI, pas de ce que le modèle
 * en répète : une ligne illisible le reste, et se complète par la personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneDuDevis {
  rang: number;
  designation: string;
  unite: string | null;
  /** `null` : illisible — à compléter depuis le papier. */
  quantite: number | null;
  /** Prix unitaire HT ; `null` : illisible, remisé ou dans une autre devise. */
  prixUnitaire: number | null;
  aVerifier: string[];
}

export interface DevisLu {
  piece: PieceResolue;
  empreinte: string;
  nature: string | null;
  numero: string | null;
  /** ISO AAAA-MM-JJ. */
  date: string | null;
  fournisseur: { id: string | null; nom: string | null; reconnu: string; candidats: string[] };
  lignes: LigneDuDevis[];
  /** En pour cent, seulement si le papier l'imprime. */
  tvaPct: number | null;
  taxe: { libelle: string; pct: number } | null;
  totalHtImprime: number | null;
  totalHtLignes: number | null;
  doutes: string[];
  reserves: string[];
  note: string;
  sansLignes: string | null;
  /** L'identité de l'émetteur recopiée du papier — pour le bon de commande, JAMAIS pour le modèle. */
  emetteur: PropositionDeLecture["emetteur"];
}

export async function lireDevis(user: CurrentUser, ref: string): Promise<DevisLu | { erreur: string }> {
  const piece = await resoudrePiece(user, ref);
  if ("erreur" in piece) return piece;
  const fichiers = await fichiersDepuisDrive(user, [piece.id]);
  if (!Array.isArray(fichiers) || !fichiers[0]) return { erreur: Array.isArray(fichiers) ? "Fichier introuvable." : fichiers.erreur };
  const octets = Buffer.from(await fichiers[0].arrayBuffer());
  const { annuaireVisible, groupe } = await annuaireDeLecture(user.id);
  // Un devis, une facture : des pièces commerciales INTERNES — la lecture suit la règle de l'ERP
  // (Luna si la Direction l'a ouverte, le moteur local sinon), comme le devis déposé sur un poste.
  const r = await proposerLecture({
    user: { id: user.id }, octets, nomFichier: piece.nom,
    contexte: { cible: "LEGAL_DOCUMENT", sortieCloudPermise: true, annuaireVisible, groupe },
  });
  if (!r.ok) return { erreur: r.error };
  const p = r.proposition;
  const l = lectureDevisPromo(p, annuaireVisible.map((c) => c.id));
  const pre = l.prerempli;
  const lignes: LigneDuDevis[] = pre.lignes.map((x) => ({
    rang: x.rang, designation: x.reference, unite: x.unit, quantite: x.quantity, prixUnitaire: x.unitPrice,
    aVerifier: [...x.notes, ...(x.suspecte.length ? ["désignation suspecte : vérifiez-la sur le papier"] : [])],
  }));
  const chiffrees = lignes.filter((x) => x.quantite != null && x.prixUnitaire != null);
  const retenu = pre.fournisseurId ? annuaireVisible.find((c) => c.id === pre.fournisseurId) : null;
  return {
    piece,
    empreinte: p.empreinte,
    nature: p.entetes.type ?? p.piece?.type ?? null,
    numero: pre.reference,
    date: pre.quoteDate,
    fournisseur: {
      id: retenu?.id ?? null,
      nom: retenu?.nom ?? p.emetteur.nom ?? null,
      reconnu: l.fournisseur.phrase,
      candidats: p.fournisseur.candidats.map((c) => c.nom),
    },
    lignes,
    tvaPct: pre.tvaRate,
    taxe: pre.extraTaxRate != null && pre.extraTaxLabel ? { libelle: pre.extraTaxLabel, pct: pre.extraTaxRate } : null,
    totalHtImprime: pre.announcedTotal,
    totalHtLignes: chiffrees.length === lignes.length && lignes.length ? arrondirAuCentime(chiffrees.reduce((s, x) => s + x.quantite! * x.prixUnitaire!, 0)) : null,
    doutes: l.controle ? [...l.controle.ecarts, ...l.controle.manques, ...l.controle.desaccords] : [],
    reserves: pre.reserves,
    note: l.noteMethode,
    sansLignes: l.sansLignes,
    emetteur: p.emetteur,
  };
}

/** Ce que le MODÈLE reçoit d'une lecture : des lignes et des totaux — pas d'identifiants, pas de coordonnées. */
export function devisPourModele(d: DevisLu) {
  return {
    fichier: d.piece.nom,
    nature: d.nature,
    numero: d.numero,
    date: d.date,
    fournisseur: d.fournisseur.nom,
    fournisseurDansAnnuaire: Boolean(d.fournisseur.id),
    reconnaissance: d.fournisseur.reconnu,
    lignes: d.lignes,
    tvaPct: d.tvaPct,
    taxe: d.taxe,
    totalHtImprime: d.totalHtImprime,
    totalHtDesLignes: d.totalHtLignes,
    doutes: d.doutes,
    reserves: d.reserves,
    methode: d.note,
    sansLignes: d.sansLignes,
  };
}
