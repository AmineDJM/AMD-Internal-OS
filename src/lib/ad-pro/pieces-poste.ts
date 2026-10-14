import type { AdProPieceNature, LegalDocKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { buildRef, createWithRetry } from "@/lib/refs";
import { moneyEntityOf } from "@/lib/company";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import type { EtapeBC } from "@/lib/bons-de-commande/regle";
import { etapeDEnsemble } from "@/lib/ad-pro/devis-poste";
import { fichiersEmis } from "@/lib/lecteurs/fichiers-emis";
import type { EtatDemandeBC } from "@/lib/ad-pro/poste-etapes";
import { ETAPE_COPIE_SIGNEE, controleFactureDe, phraseVerdictSignature, verdictSignatureDe, type ControleFacture } from "@/lib/bons-de-commande/copie-signee";


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UN POSTE — devis / pro forma → bon de commande → facture (§118.204).
 *
 * « Il y a plein d'endroits où on peut mettre des documents : dans les postes, dans les pièces liées,
 * devis, bon de commande, facture, engagements, courriers… c'est pas bon. Dans les postes, il faut
 * qu'il y ait les factures pro forma ou les devis, après le bon de commande, après la facture »
 * (Direction, 04/10). La chaîne d'achat d'une demande Ad & Pro vit désormais SUR SES POSTES, dans
 * l'ordre où elle se lit ; le reste de la demande (lettres, programme, conventions, courriers) a son
 * propre espace.
 *
 * ── LA PIÈCE VIT DANS LEGAL, LE POSTE LA DÉSIGNE ─────────────────────────────────────────────
 *
 * Un devis, un BC et une facture sont des engagements : ils vivent au registre (§17 — un seul
 * registre), avec la chaîne « fait suite à », la signature des Finances, le règlement, l'avoir. Le
 * poste les DÉSIGNE (`AdProItemPiece`) : recopier leurs fichiers sur le poste ferait deux domiciles
 * pour un fichier, et le jour où l'un est remplacé, l'autre ment. Un DEVIS peut couvrir plusieurs
 * postes (« deux, trois, quatre natures pour un seul et même devis ») : une ligne par poste couvert.
 *
 * ── LE BON DE COMMANDE PASSE PAR L'ASSISTANTE ────────────────────────────────────────────────
 *
 * « Lors de l'émission du bon de commande, la demande va chez l'assistante de direction ; quand elle
 * l'uploade, ça vient ici, dans la demande. » Le défaut corrigé : la demande d'émission ouvrait une
 * demande GÉNÉRIQUE au secrétariat, où l'assistante déposait le BC… qui restait là, et le bouton
 * « Émettre le bon de commande » des Finances créait un ORDRE DE DÉPENSE — « émis », sans BC. La
 * demande devient une DEMANDE DE PIÈCE de nature « bon de commande » (`DocumentRequest`), le mécanisme
 * qui ramène déjà un fichier déposé au registre Legal à son acceptation ; acceptée, la pièce se
 * rattache au poste, passe à la signature des Finances, et le poste la montre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature d'une pièce de poste selon sa nature au registre. `null` : ce n'est pas une pièce d'achat. */
export function natureDePiece(kind: LegalDocKind | string): AdProPieceNature | null {
  if (kind === "QUOTE") return "DEVIS";
  if (kind === "PURCHASE_ORDER") return "BON_DE_COMMANDE";
  if (kind === "INVOICE") return "FACTURE";
  return null;
}

/** Une pièce telle que la carte d'un poste la montre. */
export interface PieceDePoste {
  id: string;
  titre: string;
  reference: string | null;
  montant: number | null;
  annulee: boolean;
  fichiers: number;
  /** Le premier fichier de la pièce (un `Document`) — ce que Luna lit, et ce qu'on ouvre. */
  fichierId: string | null;
  /** Pour un devis commun : les AUTRES postes qu'il couvre (libellés). */
  aussiPour: string[];
  /**
   * Les fichiers que la FABRIQUE a produits pour cette pièce (un BC généré : son Word et son PDF) — ils s'ouvrent sous la
   * porte de la PIÈCE (`/api/legal/<id>/fichier`), pas du Drive de celui qui l'a émise (§118.152). Faux pour une pièce déposée.
   */
  emis: { docx: boolean; pdf: boolean };
  /** Une FACTURE déposée sur le poste : son contrôle contre le(s) BC qu'elle couvre (Direction, 06/10). `null` ailleurs. */
  controle: ControleFacture | null;
  /** TOUS les fichiers de la pièce, cliquables (Direction, 07/10 : « on doit retrouver les pièces jointes cliquables »). */
  fichiersListe: { id: string; nom: string }[];
}

/**
 * CE QUE L'ÉDITEUR NATIF D'UN BC REPREND — la même forme que `SpecRevisable` (`legal/piece-emise.ts`), écrite ici parce
 * qu'un domaine n'importe pas un autre, même pour un type (`platform/domains.ts`). La façade (`queries/ad-pro-items.ts`)
 * la remplit avec `specRevisable` ; le compilateur vérifie que les deux formes coïncident.
 */
export interface RevisionBcSpec {
  lignes: { designation: string; details: string[]; quantite: number; prixUnitaire: number; remise: number | null; tva: number | null; section: boolean }[];
  objet: string | null;
  notes: string | null;
  validiteJours: number | null;
  livraison: { adresse: string | null; delai: string | null } | null;
  contact: { nom: string | null; telephone: string | null } | null;
}

/**
 * CE QUE LE COMPOSEUR REPREND pour modifier le BC « de A à Z » (Direction, 10/2026) — la même forme que
 * `ValeursComposables` (`legal/piece-emise.ts`), écrite ici pour la même raison que `RevisionBcSpec` : le domaine Ad & Pro
 * n'importe pas Legal. La façade la remplit avec `valeursComposables`, et le compilateur vérifie que les formes coïncident.
 */
export interface ValeursBcPoste {
  tiers: { nom: string; adresse: string; telephone: string; email: string; rc: string; nif: string; ai: string; nis: string };
  champs: {
    numeroClient: string; date: string; echeance: string; validiteJours: string; objet: string; referenceAmont: string; referenceAmontDate: string;
    contactNom: string; contactTelephone: string; livraisonAdresse: string; livraisonDelai: string; modePaiement: string; conditionsPaiement: string;
    tvaDefaut: string; remiseGlobale: string; notes: string;
  };
  lignes: { designation: string; details: string; quantite: string; prix: string; remise: string; tva: string; section: boolean }[];
  taxes: { libelle: string; taux: string }[];
  letterheadId: string;
  emetteur: { adresse: string; telephone: string; email: string } | null;
  signataire: { nom: string; qualite: string } | null;
  mentions: string;
}

/** Un bon de commande du poste : sa pièce, et OÙ IL EN EST (circuit des centres et des Finances). */
export type BcDePoste = PieceDePoste & {
  etape: EtapeBC | null;
  /**
   * LA COPIE SIGNÉE que les Finances ont téléversée (Direction, 06/10) — elle REMPLACE le BC non signé sur la case :
   * c'est elle qu'on ouvre. `null` tant que le BC n'est pas signé par copie.
   */
  copieSignee: { documentId: string; signataire: string | null; constat: string | null } | null;
  /** Ce que l'éditeur natif reprend (version, lignes, objet…) — `null` si la pièce n'est pas de la fabrique ou ne se modifie plus. */
  revision: { version: number; numero: string; spec: RevisionBcSpec; valeurs: ValeursBcPoste } | null;
  /** Les DATES de sa frise sur la carte du poste (Direction, 07/10 : « je ne sais pas si le BC a été envoyé aux Finances ») — ISO. */
  creeLe: string;
  signeLe: string | null;
};

/**
 * Les pièces d'un poste, rangées dans l'ordre de la chaîne.
 *
 * `bcs` : TOUS les bons de commande vivants du poste, du plus ancien au plus récent — un poste en porte un PAR DEVIS
 * quand ils sont générés d'après des lignes validées (§118.206). `bc` : celui qui REPRÉSENTE le poste pour les lecteurs
 * d'avant (la frise, le dépôt de la facture) — le MOINS avancé des vivants, de sorte qu'« un BC signé » ne veuille dire
 * « tous signés » : la facture se dépose après la signature de TOUT ce qui a été commandé (`etapeDEnsemble`). Sans BC
 * vivant, le plus récent annulé, pour que la case le dise.
 */
export interface PiecesDuPoste {
  devis: PieceDePoste[];
  bc: BcDePoste | null;
  bcs: BcDePoste[];
  factures: PieceDePoste[];
}

const VIDE = (): PiecesDuPoste => ({ devis: [], bc: null, bcs: [], factures: [] });

/**
 * LES PIÈCES DES POSTES — en LOT (une poignée de requêtes pour tout l'écran, jamais une par poste,
 * §118.102b). Le BC retenu pour un poste est le plus récent NON ANNULÉ ; un BC annulé reste lisible au
 * registre mais ne décide plus de l'étape du poste.
 */
export async function piecesDesPostes(itemIds: readonly string[]): Promise<Map<string, PiecesDuPoste>> {
  const res = new Map<string, PiecesDuPoste>(itemIds.map((id) => [id, VIDE()]));
  if (itemIds.length === 0) return res;
  const liens = await prisma.adProItemPiece.findMany({
    where: { itemId: { in: [...itemIds] } },
    orderBy: { createdAt: "asc" },
    select: {
      itemId: true, nature: true,
      legalDocument: { select: { id: true, title: true, reference: true, amount: true, status: true, cancelledAt: true, createdAt: true, custom: true, signedAt: true, signedByName: true, signatureCheck: true } },
    },
  });
  if (liens.length === 0) return res;
  const docIds = [...new Set(liens.map((l) => l.legalDocument.id))];
  const [fichiers, autres, etats] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docIds } }, orderBy: { createdAt: "asc" }, select: { id: true, entityId: true, stepKey: true, name: true },
    }),
    // Les autres postes couverts par un même devis — pour dire « commun à : Imprimerie, Hôtellerie ».
    prisma.adProItemPiece.findMany({
      where: { legalDocumentId: { in: docIds }, nature: "DEVIS" },
      select: { legalDocumentId: true, itemId: true, item: { select: { label: true } } },
    }),
    etatsDesBC(liens.filter((l) => l.nature === "BON_DE_COMMANDE").map((l) => l.legalDocument.id)),
  ]);
  const nbFichiers = new Map<string, number>();
  const premierFichier = new Map<string, string>();
  // La copie signée la plus récente d'un BC (un BC re-signé après révision en a une nouvelle).
  const copieSignee = new Map<string, string>();
  const listeFichiers = new Map<string, { id: string; nom: string }[]>();
  for (const f of fichiers) {
    listeFichiers.set(f.entityId, [...(listeFichiers.get(f.entityId) ?? []), { id: f.id, nom: f.name }]);
    nbFichiers.set(f.entityId, (nbFichiers.get(f.entityId) ?? 0) + 1);
    if (!premierFichier.has(f.entityId)) premierFichier.set(f.entityId, f.id);
    if (f.stepKey === ETAPE_COPIE_SIGNEE) copieSignee.set(f.entityId, f.id);
  }
  const couverts = new Map<string, { itemId: string; label: string }[]>();
  for (const a of autres) {
    const l = couverts.get(a.legalDocumentId) ?? [];
    l.push({ itemId: a.itemId, label: a.item.label });
    couverts.set(a.legalDocumentId, l);
  }
  for (const l of liens) {
    const p = res.get(l.itemId);
    if (!p) continue;
    const d = l.legalDocument;
    const annulee = d.status === "CANCELLED" || d.cancelledAt != null;
    const piece: PieceDePoste = {
      id: d.id, titre: d.title, reference: d.reference, montant: d.amount != null ? toNumber(d.amount) : null, annulee,
      fichiers: nbFichiers.get(d.id) ?? 0, fichierId: premierFichier.get(d.id) ?? null,
      aussiPour: (couverts.get(d.id) ?? []).filter((c) => c.itemId !== l.itemId).map((c) => c.label),
      emis: (() => { const f = fichiersEmis(d.custom); return { docx: f.docx !== null, pdf: f.pdf !== null }; })(),
      controle: l.nature === "FACTURE" ? controleFactureDe((d.custom as { facturePoste?: { controle?: unknown } } | null)?.facturePoste?.controle) : null,
      fichiersListe: listeFichiers.get(d.id) ?? [],
    };
    if (l.nature === "DEVIS") p.devis.push(piece);
    else if (l.nature === "FACTURE") p.factures.push(piece);
    else {
      const copie = d.signedAt ? copieSignee.get(d.id) ?? null : null;
      const verdict = verdictSignatureDe(d.signatureCheck);
      const bc: BcDePoste = {
        ...piece, etape: annulee ? null : etats.get(d.id)?.etape ?? null,
        copieSignee: copie ? { documentId: copie, signataire: d.signedByName, constat: verdict ? phraseVerdictSignature(verdict) : null } : null,
        revision: null,
        creeLe: d.createdAt.toISOString(), signeLe: d.signedAt ? d.signedAt.toISOString() : null,
      };
      if (!annulee) p.bcs.push(bc);
      // Sans BC vivant, le plus récent annulé : la case dit « annulé » au lieu de se taire.
      else if (p.bcs.length === 0) p.bc = bc;
    }
  }
  for (const p of res.values()) {
    if (p.bcs.length === 0) continue;
    // Le moins avancé des vivants représente le poste — à égalité, le plus ancien.
    const pire = etapeDEnsemble(p.bcs.map((b) => b.etape));
    p.bc = p.bcs.find((b) => (b.etape ?? "HORS_CIRCUIT") === pire) ?? p.bcs[0];
  }
  return res;
}

/** La demande de BC envoyée à l'assistante, telle que le poste la lit. */
export interface DemandeBCDuPoste {
  id: string;
  etat: EtatDemandeBC;
  /** Celui qui a demandé — c'est lui qui vérifie la pièce déposée (`canDecide`). */
  askedById: string;
  assistante: string | null;
}

/** Les statuts d'une demande de pièce encore OUVERTE (déposée, à déposer, ou refusée et à redéposer). */
const OUVERTES = ["PENDING", "SUBMITTED", "DECLINED"] as const;

/** Les demandes de BC OUVERTES des postes — en lot. */
export async function demandesBCDesPostes(itemIds: readonly string[]): Promise<Map<string, DemandeBCDuPoste>> {
  const res = new Map<string, DemandeBCDuPoste>();
  if (itemIds.length === 0) return res;
  const rows = await prisma.documentRequest.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: { in: [...itemIds] }, kind: "PURCHASE_ORDER", status: { in: [...OUVERTES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, entityId: true, status: true, askedById: true, askedTo: { select: { name: true } } },
  });
  for (const r of rows) {
    if (res.has(r.entityId)) continue;
    res.set(r.entityId, {
      id: r.id, etat: r.status === "SUBMITTED" ? "DEPOSE" : "CHEZ_ASSISTANTE", askedById: r.askedById, assistante: r.askedTo?.name ?? null,
    });
  }
  return res;
}

/** Les assistantes de direction ACTIVES — à qui la demande de BC peut partir. */
export async function assistantesDeDirection(): Promise<{ id: string; name: string }[]> {
  return prisma.user.findMany({
    where: { isActive: true, OR: [{ role: "DIRECTION_ASSISTANT" }, { secondaryRole: "DIRECTION_ASSISTANT" }] },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

async function prochaineReferencePiece(): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await prisma.documentRequest.findMany({ where: { reference: { startsWith: `PIE-${year}-` } }, select: { reference: true } });
  return buildRef("PIE", year, rows.map((r) => r.reference));
}

/**
 * ENVOYER (ou mettre à jour) LA DEMANDE DE BC à l'assistante. UNE demande ouverte par poste : un BC
 * redemandé ne lui fait pas deux demandes pour la même pièce — l'ouverte reçoit le nouveau message.
 * Rend l'identifiant de la demande, et si elle vient d'être CRÉÉE.
 */
export async function demanderBcAAssistante(i: {
  itemId: string; assistantId: string; demandeurId: string; libelle: string; note: string | null; lien: string;
}): Promise<{ id: string; creee: boolean }> {
  const ouverte = await prisma.documentRequest.findFirst({
    where: { entityType: "AD_PRO_ITEM", entityId: i.itemId, kind: "PURCHASE_ORDER", status: { in: [...OUVERTES] } },
    select: { id: true },
  });
  if (ouverte) {
    await prisma.documentRequest.update({ where: { id: ouverte.id }, data: { note: i.note, label: i.libelle } });
    return { id: ouverte.id, creee: false };
  }
  const r = await createWithRetry(async () => prisma.documentRequest.create({
    data: {
      reference: await prochaineReferencePiece(),
      entityType: "AD_PRO_ITEM", entityId: i.itemId, link: i.lien,
      label: i.libelle, note: i.note, kind: "PURCHASE_ORDER",
      askedById: i.demandeurId, askedToId: i.assistantId, status: "PENDING",
    },
    select: { id: true },
  }));
  return { id: r.id, creee: true };
}

/**
 * ANNULER les demandes de pièce OUVERTES d'un poste — de BC seulement, ou toutes. Une demande déjà
 * acceptée n'est pas touchée : sa pièce vit au registre, et elle se gère là.
 */
export async function annulerDemandesPiecesDuPoste(itemId: string, portee: "BC" | "TOUTES"): Promise<{ id: string; askedToId: string }[]> {
  const ouvertes = await prisma.documentRequest.findMany({
    where: {
      entityType: "AD_PRO_ITEM", entityId: itemId, status: { in: [...OUVERTES] },
      ...(portee === "BC" ? { kind: "PURCHASE_ORDER" } : {}),
    },
    select: { id: true, askedToId: true },
  });
  if (ouvertes.length === 0) return [];
  await prisma.documentRequest.updateMany({
    where: { id: { in: ouvertes.map((o) => o.id) }, status: { in: [...OUVERTES] } },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
  return ouvertes;
}

/**
 * RATTACHER UNE PIÈCE DU REGISTRE À UN POSTE — idempotent (une ligne par couple). Pour un BC né d'une
 * demande de pièce, le registre reçoit ce que le POSTE sait déjà (montant accordé, prestataire) et la
 * chaîne vers SON devis quand il n'y en a qu'un : on ne devine rien, on recopie ce qui est décidé.
 */
export async function rattacherPieceAuPoste(i: {
  itemId: string; legalDocumentId: string; nature: AdProPieceNature; acteurId: string | null;
}): Promise<void> {
  await prisma.adProItemPiece.upsert({
    where: { itemId_legalDocumentId: { itemId: i.itemId, legalDocumentId: i.legalDocumentId } },
    create: { itemId: i.itemId, legalDocumentId: i.legalDocumentId, nature: i.nature, createdById: i.acteurId },
    update: {},
  });
  if (i.nature !== "BON_DE_COMMANDE") return;
  const [poste, doc, devis] = await Promise.all([
    prisma.adProItem.findUnique({ where: { id: i.itemId }, select: { amountGranted: true, supplier: true } }),
    prisma.legalDocument.findUnique({ where: { id: i.legalDocumentId }, select: { amount: true, counterparty: true, chainFromId: true } }),
    prisma.adProItemPiece.findMany({
      where: { itemId: i.itemId, nature: "DEVIS", legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } },
      select: { legalDocumentId: true },
    }),
  ]);
  if (!poste || !doc) return;
  await prisma.legalDocument.update({
    where: { id: i.legalDocumentId },
    data: {
      ...(doc.amount == null && poste.amountGranted != null ? { amount: poste.amountGranted } : {}),
      ...(!doc.counterparty && poste.supplier ? { counterparty: poste.supplier } : {}),
      ...(!doc.chainFromId && devis.length === 1 ? { chainFromId: devis[0].legalDocumentId } : {}),
    },
  });
}

/**
 * LA SOCIÉTÉ D'UNE PIÈCE DE POSTE (§118.204) — celle de la DEMANDE qui porte le poste, sinon celle où
 * travaille son demandeur : la même règle que le devis et la facture du poste. Sans elle, un BC classé
 * depuis une demande de pièce prenait la société de qui l'accepte, et la chaîne d'un même poste
 * pouvait porter deux sociétés. `null` si rien ne se lit à coup sûr.
 */
export async function societeDuPoste(itemId: string): Promise<string | null> {
  const p = await prisma.adProItem.findUnique({
    where: { id: itemId },
    select: {
      sponsoring: { select: { companyId: true, requesterId: true } },
      congressNational: { select: { companyId: true, requesterId: true } },
      congressInternational: { select: { companyId: true, requesterId: true } },
      event: { select: { companyId: true, requesterId: true } },
    },
  });
  const parent = p?.sponsoring ?? p?.congressNational ?? p?.congressInternational ?? p?.event ?? null;
  if (!parent) return null;
  if (parent.companyId) return parent.companyId;
  return parent.requesterId ? moneyEntityOf(parent.requesterId) : null;
}
