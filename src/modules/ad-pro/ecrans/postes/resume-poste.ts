import type { AdProItemKind } from "@prisma/client";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { etapesDuPoste, faitsDuPoste, prochainPas, toutEstFacture, type RegardPoste } from "../../domaine/poste-etapes";
import { etapeAgence, LIBELLE_ETAPE_AGENCE, pasAgence, type FaitsPosteAgence, type RegardAgence } from "../../domaine/parcours-agence";
import type { ContexteDesPostes, ItemRow } from "../items-panel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN POSTE EN UNE LIGNE — ce que le tableau des postes de la fiche dit de chacun (maquette « Fiche Ad & Pro », 24/11/2026) :
 * son nom, où il en est (« chez qui »), son montant ; et la carte « À vous » de la fiche, le poste qui attend la personne
 * qui regarde.
 *
 * Aucune règle neuve : la ligne lit les MÊMES règles que la carte du poste (`prochainPas`, `pasAgence`, `etapesDuPoste`),
 * avec le MÊME regard (`regardDuPoste`, que la carte reçoit aussi). Module sans « use client » et sans React : la page
 * serveur l'appelle comme le panneau des postes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que la fiche sait de la personne qui regarde ses postes — les props du panneau (`AdProItemsPanel`). */
export interface DroitsDesPostes {
  canEdit: boolean;
  canAllocate: boolean;
  canViserBC: boolean;
  canIssueOrder: boolean;
  fige: boolean;
  decided: boolean;
  contexte: Pick<ContexteDesPostes, "validation" | "secondTempsParOperations" | "userId" | "superAdmin" | "porteDg" | "infoMed" | "suiviSimple">;
}

const STOCK: AdProItemKind = "STOCK_MATERIAL";

/** Les faits du parcours agence tels que la carte les lit — une seule traduction, celle de l'écran. */
export function faitsAgenceDuPoste(item: ItemRow): FaitsPosteAgence | null {
  if (!item.agence) return null;
  return {
    status: item.status, orderStage: item.orderStage,
    // UN BC ANNULÉ N'EST PAS LE BC DU POSTE (recette de bout en bout, 23/11/2026) : après « Annuler la demande de BC »,
    // le plus récent annulé se montre dans la case pièce, mais le parcours repart de « pas de BC vivant ».
    bc: item.pieces.bc && !item.pieces.bc.annulee ? (item.pieces.bc.etape ?? "HORS_CIRCUIT") : null,
    factures: item.pieces.factures.length, toutFacture: toutEstFacture(item.pieces), expenseOrderId: item.expenseOrderId,
    expenseOrderStatus: item.expenseOrder?.status ?? null, expenseOrderCentral: item.expenseOrder?.centralStatus ?? null,
    orderDecisionNote: item.orderDecisionNote ?? null,
    // Le paiement attend le budget, pas le BC (recette 24/11/2026).
    budgetChoisi: Boolean(item.budgetCategoryId),
    agence: item.agence.faits,
  };
}

/** Le titre d'un poste, dit UNE fois : la nature seule quand le libellé la redit mot pour mot. */
export function titreDuPoste(item: Pick<ItemRow, "kind" | "label">): { titre: string; nature: string | null } {
  const nature = ITEM_KIND_LABELS[item.kind];
  const pareil = item.label.trim().toLocaleLowerCase("fr") === nature.toLocaleLowerCase("fr");
  return pareil ? { titre: nature, nature: null } : { titre: item.label, nature };
}

/** LE REGARD SUR UN POSTE — celui que la carte reçoit (`PosteCarte`), construit en un seul endroit. */
export function regardDuPoste(it: ItemRow, d: DroitsDesPostes): RegardPoste {
  return {
    canEdit: d.canEdit, canAllocate: d.canAllocate, canViserBC: d.canViserBC,
    // ANNULER UN ORDRE ÉMIS non réglé : les Finances, ou qui arbitre.
    canEmettre: d.canIssueOrder || d.canAllocate,
    fige: d.fige, operationDecidee: d.decided,
    validation: d.contexte.validation,
    secondTempsParOperations: d.contexte.secondTempsParOperations,
    // C'est celle qui a DEMANDÉ le BC qui vérifie la pièce que l'assistante a déposée.
    verifieLeBC: Boolean(it.demandeBC) && it.demandeBC?.askedById === d.contexte.userId,
    // LE BC D'UN DEVIS se vérifie, se modifie et se valide par la personne qui a ajouté le devis (Direction, 11/2026).
    moiId: d.contexte.userId,
    superAdmin: d.contexte.superAdmin,
  };
}

/** Le regard du parcours agence — celui que la carte construit pour sa frise (`PosteCarte` → `ParcoursAgence`). */
function regardAgenceDuPoste(it: ItemRow, regard: RegardPoste, infoMed: boolean): RegardAgence {
  const assistante = Boolean(it.agence?.assistanteId && it.agence.assistanteId === regard.moiId);
  return { marketing: (regard.validation ?? { marketing: false }).marketing, assistante, infoMed, centre: regard.canViserBC, fige: regard.fige };
}

interface LigneDePoste {
  /** « Où il en est » — l'étape en cours et chez qui, en peu de mots. */
  phrase: string;
  /** La phrase entière de la carte (ce qu'on attend, et de qui), lue au survol. */
  detail: string | null;
  /** Le prochain geste est celui de la personne qui regarde. */
  aVous: boolean;
  /** Ce geste, nommé comme sur la carte. */
  geste: string | null;
}

/** « En attente — chez la Direction Marketing (montant et budget). » → « chez la Direction Marketing ». */
function chezQui(attente: string | null): string | null {
  const m = attente?.match(/chez ([^.;:(—–]+)/i);
  return m ? `chez ${m[1]!.trim()}` : null;
}

/** OÙ EN EST LE POSTE — la règle de la carte, dite en une ligne. */
export function ouEnEstLePoste(it: ItemRow, d: DroitsDesPostes): LigneDePoste {
  if (it.historique) return { phrase: "Payé (historique 2026)", detail: null, aVous: false, geste: null };
  const regard = regardDuPoste(it, d);
  const agence = it.voie === "AGENCE" ? faitsAgenceDuPoste(it) : null;
  if (agence) {
    const pa = pasAgence(agence, regardAgenceDuPoste(it, regard, d.contexte.infoMed === true));
    if (pa.geste) return { phrase: `${pa.geste.libelle} — chez vous`, detail: null, aVous: true, geste: pa.geste.libelle };
    const etape = LIBELLE_ETAPE_AGENCE[etapeAgence(agence)];
    const chez = chezQui(pa.attente);
    return { phrase: chez ? `${etape} — ${chez}` : etape, detail: pa.attente, aVous: false, geste: null };
  }
  const faits = { ...faitsDuPoste(it), porteDg: d.contexte.porteDg?.etat, porteDgPhrase: d.contexte.porteDg?.phrase ?? null };
  const pas = prochainPas(faits, regard);
  if (pas.geste) return { phrase: `${pas.geste.libelle} — chez vous`, detail: null, aVous: true, geste: pas.geste.libelle };
  if (it.status === "REJECTED") return { phrase: "Refusé", detail: pas.attente, aVous: false, geste: null };
  if (it.expenseOrder?.status === "PAID") return { phrase: "Payé", detail: null, aVous: false, geste: null };
  const etapes = it.kind === STOCK ? [] : etapesDuPoste(faits);
  const enCours = etapes.find((e) => e.etat === "EN_COURS")?.libelle ?? null;
  const chez = chezQui(pas.attente);
  const phrase = enCours && chez ? `${enCours} — ${chez}`
    : chez ? chez.replace(/^c/, "C")
      : enCours ?? pas.attente ?? (etapes.length > 0 && etapes.every((e) => e.etat === "FAIT") ? "Terminé" : "—");
  return { phrase, detail: pas.attente, aVous: false, geste: null };
}

/** LE POSTE QUI ATTEND LA PERSONNE QUI REGARDE — le premier, pour la carte « À vous » de la fiche. */
export function posteQuiVousAttend(items: ItemRow[], d: DroitsDesPostes): { id: string; titre: string; geste: string } | null {
  // Le délégué qui suit sans les détails n'a aucun geste sur les postes (`SuiviSimple`).
  if (d.contexte.suiviSimple) return null;
  for (const it of items) {
    const l = ouEnEstLePoste(it, d);
    if (l.aVous && l.geste) return { id: it.id, titre: titreDuPoste(it).titre, geste: l.geste };
  }
  return null;
}

/**
 * TOUS LES POSTES PASSENT PAR UNE AGENCE (15/11/2026) : le DG vise chaque BC au-dessus du seuil — la porte sur le total ne
 * fait que le signaler, sans geste (`CartePorteDg`).
 */
export function porteSignalSeule(items: Pick<ItemRow, "voie" | "kind" | "status">[]): boolean {
  return items.some((i) => i.voie === "AGENCE") && items.every((i) => i.voie === "AGENCE" || i.kind === STOCK || i.status === "REJECTED");
}

/** Le montant d'un poste dans le tableau : l'accordé, sinon l'estimé ; payé en historique, le montant payé. */
export function montantDuPoste(it: Pick<ItemRow, "historique" | "amountGranted" | "amountEstimated">): number | null {
  if (it.historique) return it.historique.montant;
  return it.amountGranted ?? it.amountEstimated ?? null;
}
