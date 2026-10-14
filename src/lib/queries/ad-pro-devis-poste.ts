import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import type { EtapeBC } from "@/lib/bons-de-commande/regle";
import {
  decisionBcDuDevis, ecartAvecLeTotalImprime, refusValidationLigne, totauxDuDevisLu, totauxValides, lignesValidees, reservesEncoreVraies, lignesDuBon,
  devisMisAPart, doublonsProbables,
  type BcActifDuDevis, type DevisAComparer, type EnteteDevisPoste, type EtatBcDuDevis, type LigneDevisPoste, type MiseAPart,
} from "@/lib/ad-pro/devis-poste";
import { IDENTITE_VIDE, identiteUtilisable, type IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import { montantLu } from "@/lib/pieces-lues/montants";
import { brouillonPerime, lireBrouillon, lignesEffectives, type BrouillonBc } from "@/lib/bons-de-commande/brouillon";
import type { LigneCommerciale } from "@/lib/artifact/factory/commercial";

/** L'identité gardée en base (JSON) → sa forme typée, ou `null` si elle ne nomme personne. */
function identiteGardee(brut: unknown): IdentiteEmetteur | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as Record<string, unknown>;
  const s = (k: keyof IdentiteEmetteur) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  const id: IdentiteEmetteur = { ...IDENTITE_VIDE, nom: s("nom"), adresse: s("adresse"), nif: s("nif"), rc: s("rc"), rib: s("rib"), telephone: s("telephone"), email: s("email") };
  return identiteUtilisable(id) ? id : null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS D'UN POSTE, LUS EN LOT, AVEC CE QU'ILS FONT GÉNÉRER (§118.206).
 *
 * Une lecture pour la carte du poste ET pour l'action qui génère : la carte n'offre que ce que
 * l'action acceptera, parce que les deux lisent la même décision (`decisionBcDuDevis`). Chaque
 * devis dit ses lignes, lesquelles sont validées POUR CE POSTE, le BC actif qu'il a (non annulé), et
 * ce qu'il reste à faire : générer, régénérer, rien — ou pourquoi c'est figé.
 *
 * En LOT, comme le reste de l'écran (§118.102b) : quelques requêtes pour tous les postes, jamais une
 * par devis. Des nombres et des chaînes, jamais un `Date` ni un `Decimal` : la carte est un composant client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneDevisVue {
  id: string;
  position: number;
  reference: string;
  unit: string | null;
  quantity: number | null;
  unitPrice: number | null;
  /** Prix total HT de la ligne — `null` tant qu'un chiffre manque. */
  totalHt: number | null;
  lue: number | null;
  aVerifier: string | null;
  /** Validée POUR CE POSTE. */
  validee: boolean;
  /** Validée pour un AUTRE poste de la demande : le libellé de ce poste. */
  valideeAilleurs: string | null;
  /** Complète, donc validable — `null` ; sinon ce qui manque. */
  refusValidation: string | null;
  /** La référence du BC (actif) qui porte la ligne, ou `null`. */
  bcReference: string | null;
}

export interface DevisDePosteVue {
  /** La pièce Legal du devis. */
  pieceId: string;
  titre: string;
  reference: string | null;
  fournisseur: string | null;
  fournisseurId: string | null;
  /** L'identité du fournisseur RECOPIÉE du devis (sans fiche d'annuaire) — ce que le bon de commande porte. */
  fournisseurLu: IdentiteEmetteur | null;
  annule: boolean;
  /** Le premier fichier du devis (un `Document`) — ce qu'on ouvre, et ce que Luna relit. */
  fichierId: string | null;
  /** Des lignes structurées existent (lues ou saisies). Sinon : le devis n'a que son fichier. */
  structure: boolean;
  entete: EnteteDevisPoste & { quoteDate: string | null; lectureNote: string | null; lectureId: string | null };
  lignes: LigneDevisVue[];
  ecartTotal: { annonce: number; calcule: number; ecart: number } | null;
  totalDevisHt: number;
  nbValidees: number;
  totalValideHt: number;
  totalValideTtc: number;
  /** Le BC actif de ce devis pour CE poste. */
  bc: (BcActifDuDevis & { etape: EtapeBC | null }) | null;
  etat: EtatBcDuDevis;
  nbAjoutees: number;
  nbRetirees: number;
  refus: string | null;
  /**
   * LE BROUILLON DU BC (« à vérifier par le demandeur ») de CE poste, s'il y en a un : aucun numéro n'est encore attribué. Ses lignes
   * sont celles qu'il imprimera (corrigées, ou celles des lignes validées).
   */
  brouillon: (BrouillonBc & { perime: boolean; lignesBc: LigneCommerciale[] }) | null;
  /**
   * NE COMPTE PAS (sans BC) : la copie d'une pièce déjà comptée, ou une proposition d'un voyageur qui n'est pas la retenue
   * (`devisMisAPart`). Ses lignes validées restent lisibles ; elles n'entrent ni dans le plafond, ni dans un BC.
   */
  miseAPart: MiseAPart | null;
  /** Mêmes lignes et même fournisseur qu'un autre devis, sans preuve que c'est la même pièce : le nom de l'autre. */
  doublonProbableDe: string | null;
  /** Le voyageur pour qui ce devis a été déposé (billetterie), s'il y en a un. */
  voyageur: { id: string; nom: string; retenu: boolean } | null;
}

/**
 * LES EMPREINTES (SHA-256 des octets) DES FICHIERS DE CHAQUE DEVIS — celles de ses documents (le blob chiffré garde
 * l'empreinte du clair) et celle de la lecture qui en a tiré les lignes. Deux devis qui partagent une empreinte ont été
 * déposés avec le MÊME fichier.
 */
export async function empreintesDesDevis(legalDocumentIds: readonly string[]): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>(legalDocumentIds.map((id) => [id, []]));
  if (legalDocumentIds.length === 0) return res;
  const ids = [...legalDocumentIds];
  const [docs, devis] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids }, fileKey: { not: null } }, select: { entityId: true, fileKey: true } }),
    prisma.adProDevis.findMany({ where: { legalDocumentId: { in: ids }, lectureId: { not: null } }, select: { legalDocumentId: true, lectureId: true } }),
  ]);
  const stockes = docs.length
    ? await prisma.storedFile.findMany({ where: { key: { in: docs.map((d) => d.fileKey as string) } }, select: { key: true, blobId: true } })
    : [];
  const [blobs, lectures] = await Promise.all([
    stockes.length ? prisma.fileBlob.findMany({ where: { id: { in: [...new Set(stockes.map((x) => x.blobId))] } }, select: { id: true, sha256: true } }) : Promise.resolve([]),
    devis.length ? prisma.lecturePiece.findMany({ where: { id: { in: devis.map((d) => d.lectureId as string) } }, select: { id: true, empreinte: true } }) : Promise.resolve([]),
  ]);
  const blobDeCle = new Map(stockes.map((x) => [x.key, x.blobId]));
  const shaDeBlob = new Map(blobs.map((b) => [b.id, b.sha256]));
  const empreinteDeLecture = new Map(lectures.map((l) => [l.id, l.empreinte]));
  const ajouter = (id: string, e: string | undefined) => {
    if (!e) return;
    const l = res.get(id) ?? [];
    if (!l.includes(e)) l.push(e);
    res.set(id, l);
  };
  for (const d of docs) ajouter(d.entityId, shaDeBlob.get(blobDeCle.get(d.fileKey as string) ?? ""));
  for (const d of devis) ajouter(d.legalDocumentId, empreinteDeLecture.get(d.lectureId as string));
  return res;
}

/** Une ligne en base → la forme que le module pur lit. */
function ligneDeBase(l: {
  id: string; position: number; reference: string; unit: string | null; quantity: unknown; unitPrice: unknown;
  lue: number | null; aVerifier: string | null; validatedItemId: string | null; bcId: string | null;
}): LigneDevisPoste {
  return {
    id: l.id, position: l.position, reference: l.reference, unit: l.unit,
    quantity: l.quantity != null ? toNumber(l.quantity as never) : null,
    unitPrice: l.unitPrice != null ? toNumber(l.unitPrice as never) : null,
    // Une réserve écrite par un lecteur plus ancien, que le lecteur actuel dément, n'est plus affichée.
    lue: l.lue, aVerifier: reservesEncoreVraies(l.aVerifier, montantLu), validatedItemId: l.validatedItemId, bcId: l.bcId,
  };
}

export async function devisDesPostes(itemIds: readonly string[]): Promise<Map<string, DevisDePosteVue[]>> {
  const res = new Map<string, DevisDePosteVue[]>(itemIds.map((id) => [id, []]));
  if (itemIds.length === 0) return res;
  const ids = [...itemIds];
  const [liensDevis, liensBc] = await Promise.all([
    prisma.adProItemPiece.findMany({
      where: { itemId: { in: ids }, nature: "DEVIS" },
      orderBy: { createdAt: "asc" },
      select: {
        itemId: true,
        voyageur: { select: { retenuLe: true, voyageur: { select: { id: true, nom: true, prenom: true } } } },
        legalDocument: {
          select: {
            id: true, title: true, reference: true, counterparty: true, status: true, cancelledAt: true,
            devisPoste: {
              select: {
                supplierId: true, tvaRate: true, extraTaxLabel: true, extraTaxRate: true, announcedTotal: true, fournisseurLu: true, bcBrouillon: true,
                quoteDate: true, lectureId: true, lectureNote: true,
                lignes: {
                  orderBy: { position: "asc" },
                  select: { id: true, position: true, reference: true, unit: true, quantity: true, unitPrice: true, lue: true, aVerifier: true, validatedItemId: true, bcId: true },
                },
              },
            },
          },
        },
      },
    }),
    prisma.adProItemPiece.findMany({
      where: { itemId: { in: ids }, nature: "BON_DE_COMMANDE" },
      select: { itemId: true, legalDocument: { select: { id: true, reference: true, title: true, chainFromId: true, status: true, cancelledAt: true, signedAt: true, signedById: true } } },
    }),
  ]);
  if (liensDevis.length === 0) return res;

  const bcVivants = liensBc.filter((l) => l.legalDocument.status !== "CANCELLED" && l.legalDocument.cancelledAt == null);
  const bcIds = [...new Set(bcVivants.map((l) => l.legalDocument.id))];
  const devisIds = [...new Set(liensDevis.map((l) => l.legalDocument.id))];
  const validesPour = new Set<string>();
  for (const l of liensDevis) for (const x of l.legalDocument.devisPoste?.lignes ?? []) if (x.validatedItemId) validesPour.add(x.validatedItemId);

  const [etats, factures, fichiers, postes, empreintes] = await Promise.all([
    etatsDesBC(bcIds),
    bcIds.length
      ? prisma.legalDocument.findMany({ where: { chainFromId: { in: bcIds }, kind: "INVOICE", status: { not: "CANCELLED" } }, select: { chainFromId: true, reference: true, title: true } })
      : Promise.resolve([]),
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: devisIds } }, orderBy: { createdAt: "asc" }, select: { id: true, entityId: true } }),
    validesPour.size ? prisma.adProItem.findMany({ where: { id: { in: [...validesPour] } }, select: { id: true, label: true } }) : Promise.resolve([]),
    empreintesDesDevis(devisIds),
  ]);
  const factureDe = new Map<string, string>();
  for (const f of factures) if (f.chainFromId && !factureDe.has(f.chainFromId)) factureDe.set(f.chainFromId, f.reference?.trim() || f.title);
  const premierFichier = new Map<string, string>();
  for (const f of fichiers) if (!premierFichier.has(f.entityId)) premierFichier.set(f.entityId, f.id);
  const libellePoste = new Map(postes.map((p) => [p.id, p.label]));

  for (const lien of liensDevis) {
    const d = lien.legalDocument;
    const entreeBase = d.devisPoste;
    const entete: EnteteDevisPoste = {
      // Jamais de 19 inventé : un devis sans TVA imprimée reste sans TVA (`null`) tant qu'on ne la saisit pas.
      tvaRate: entreeBase?.tvaRate != null ? toNumber(entreeBase.tvaRate as never) : null,
      extraTaxLabel: entreeBase?.extraTaxLabel ?? null,
      extraTaxRate: entreeBase?.extraTaxRate != null ? toNumber(entreeBase.extraTaxRate as never) : null,
      announcedTotal: entreeBase?.announcedTotal != null ? toNumber(entreeBase.announcedTotal as never) : null,
    };
    const lignes = (entreeBase?.lignes ?? []).map(ligneDeBase);
    // LE BC ACTIF de ce devis pour CE poste : celui que le poste porte et qui découle de ce devis.
    const bcLien = bcVivants.find((b) => b.itemId === lien.itemId && b.legalDocument.chainFromId === d.id) ?? null;
    const etatBc = bcLien ? etats.get(bcLien.legalDocument.id) : undefined;
    const bc: DevisDePosteVue["bc"] = bcLien && !(etatBc?.annule)
      ? {
          id: bcLien.legalDocument.id,
          reference: bcLien.legalDocument.reference?.trim() || bcLien.legalDocument.title,
          etape: etatBc?.etape ?? null,
          signe: bcLien.legalDocument.signedAt != null || bcLien.legalDocument.signedById != null,
          facture: factureDe.get(bcLien.legalDocument.id) ?? null,
        }
      : null;
    const decision = decisionBcDuDevis(lignes, lien.itemId, bc);
    const annule = d.status === "CANCELLED" || d.cancelledAt != null;
    const gardees = lignesValidees(lignes, lien.itemId);
    const t = totauxValides(entete, lignes, lien.itemId);
    const lue = totauxDuDevisLu(entete, lignes);
    const bcRefParId = new Map(bcVivants.map((b) => [b.legalDocument.id, b.legalDocument.reference?.trim() || b.legalDocument.title]));
    const vue: DevisDePosteVue = {
      pieceId: d.id, titre: d.title, reference: d.reference, fournisseur: d.counterparty, fournisseurId: entreeBase?.supplierId ?? null,
      fournisseurLu: identiteGardee(entreeBase?.fournisseurLu),
      annule, fichierId: premierFichier.get(d.id) ?? null, structure: lignes.length > 0,
      entete: {
        ...entete, quoteDate: entreeBase?.quoteDate ? entreeBase.quoteDate.toISOString().slice(0, 10) : null,
        lectureNote: entreeBase?.lectureNote ?? null, lectureId: entreeBase?.lectureId ?? null,
      },
      lignes: lignes.map((l) => ({
        id: l.id, position: l.position, reference: l.reference, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice,
        totalHt: l.quantity != null && l.unitPrice != null ? Math.round(l.quantity * l.unitPrice * 100) / 100 : null,
        lue: l.lue, aVerifier: l.aVerifier,
        validee: l.validatedItemId === lien.itemId,
        valideeAilleurs: l.validatedItemId && l.validatedItemId !== lien.itemId ? libellePoste.get(l.validatedItemId) ?? "un autre poste" : null,
        refusValidation: refusValidationLigne(l),
        bcReference: l.bcId ? bcRefParId.get(l.bcId) ?? null : null,
      })),
      ecartTotal: ecartAvecLeTotalImprime(entete, lignes),
      totalDevisHt: lue.ht,
      nbValidees: gardees.length, totalValideHt: t.ht, totalValideTtc: t.ttc,
      bc, etat: decision.etat, nbAjoutees: decision.ajoutees.length, nbRetirees: decision.retirees.length, refus: decision.refus,
      brouillon: null,
      miseAPart: null,
      doublonProbableDe: null,
      voyageur: lien.voyageur
        ? {
            id: lien.voyageur.voyageur.id,
            nom: [lien.voyageur.voyageur.prenom, lien.voyageur.voyageur.nom].filter((x) => x && x.trim()).join(" "),
            retenu: lien.voyageur.retenuLe != null,
          }
        : null,
    };
    const brut = lireBrouillon(entreeBase?.bcBrouillon);
    if (brut && brut.itemId === lien.itemId && (decision.etat === "A_GENERER" || decision.etat === "A_REGENERER")) {
      const lignesBc = lignesDuBon(entete, lignes, lien.itemId);
      vue.brouillon = { ...brut, perime: brouillonPerime(brut, lignesBc), lignesBc: lignesEffectives(brut, lignesBc) };
    }
    res.get(lien.itemId)?.push(vue);
  }

  // LA MÊME PIÈCE NE SE COMPTE QU'UNE FOIS, UNE PROPOSITION ÉCARTÉE NE SE COMMANDE PAS (`devisMisAPart`) — poste par poste.
  for (const vues of res.values()) {
    if (vues.length < 2) continue;
    const aComparer: DevisAComparer[] = vues.map((v) => ({
      pieceId: v.pieceId, nom: v.reference?.trim() || v.titre, annule: v.annule, empreintes: empreintes.get(v.pieceId) ?? [],
      reference: v.reference, fournisseur: v.fournisseurLu?.nom ?? v.fournisseur, lignes: v.lignes, aUnBc: v.bc !== null,
      nbValidees: v.nbValidees, voyageur: v.voyageur,
    }));
    const misAPart = devisMisAPart(aComparer);
    const probables = doublonsProbables(aComparer.filter((d) => !misAPart.has(d.pieceId)));
    for (const v of vues) {
      v.doublonProbableDe = probables.get(v.pieceId) ?? null;
      const m = misAPart.get(v.pieceId);
      if (!m || v.bc) continue;
      v.miseAPart = m;
      // Rien à générer pour lui : son état le dit, et aucun aperçu ne s'ouvre sur une pièce qui ne compte pas.
      if (v.etat === "A_GENERER") { v.etat = "MIS_A_PART"; v.nbAjoutees = 0; v.brouillon = null; }
    }
  }
  return res;
}
