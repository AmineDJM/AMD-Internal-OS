import { Prisma, type EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyRoles } from "@/lib/notify";
import { createDirectValidation } from "@/lib/validation";
import { centreValidatorFrom } from "@/lib/validations/centre";
import { TYPES_ENTITE_AD_PRO } from "@/modules/ad-pro/partage";
import { poleDe } from "@/lib/lecteurs/consulting";
import { getAppSettings } from "@/lib/settings";
import { CHEMIN_BONS_DE_COMMANDE, lienBonDeCommande } from "@/lib/chemins/bons-de-commande";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { notifierSignatairesBC } from "./signataires";
import {
  centreDeLOrigine, etatDepuisPoste, etatDepuisValidation, etatDepuisVisa, gesteAiguillage,
  validationRequiseBC, etapeBC, seuilDuCentre,
  LIBELLE_CENTRE_BC,
  type CentreBC, type EtapeBC, type PorteBC,
} from "./regle";
import { sansBloquer } from "@/lib/journal";

/**
 * L'écran où un BC « à signer » attend — les notifications y mènent. Le module « Bons de commande »
 * est à part depuis §118.176 : l'adresse vit au socle (`chemins/bons-de-commande`), lue aussi par
 * le menu ; ce nom reste celui que les écrivains citent déjà.
 */
export const CHEMIN_BC_A_SIGNER = CHEMIN_BONS_DE_COMMANDE;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AIGUILLAGE DES BONS DE COMMANDE — poser la porte, la lire, la déplacer, la retirer.
 *
 * La règle vit dans `regle.ts` (pure, au socle). Ici, on LIT les faits qu'elle attend et on
 * ÉCRIT ce qu'elle décide — rien de plus. Un bon de commande est un `LegalDocument` de nature
 * `PURCHASE_ORDER` : c'est le registre canonique où la fabrique les émet, où les demandes de
 * pièce les classent, où Legal les enregistre (§17 : pas de second registre).
 *
 * ── LES DEUX CENTRES, ET LEURS DEUX FORMES DE PORTE ─────────────────────────────────────────
 *
 *   • AD & PRO → un VISA (`AdProGateVisa` sur `LEGAL_DOCUMENT`), la table unique du centre
 *     Ad & Pro. Sans seuil : TOUT bon de commande né d'Ad & Pro y passe, quel que soit son
 *     montant — c'est la décision de la Direction, et le seuil ne concerne que les DEMANDES.
 *   • VALIDATIONS → une demande de validation (`ValidationRequest`, `objectType` = BC) adressée
 *     au siège du centre (`centreValidatorFrom`), que `/centre-de-validations` liste déjà.
 *
 * Et une troisième, qui n'en est pas une : le BC qui MATÉRIALISE la demande d'un poste Ad & Pro
 * porte déjà sa décision — le visa du poste (voir `PorteBC.source`).
 *
 * ── CE QUI N'EST JAMAIS FAIT ICI ─────────────────────────────────────────────────────────────
 *
 * Aucune permission n'est accordée ni vérifiée : qui peut CRÉER un BC reste la garde de son
 * écrivain (`legalWriteAllowed`), qui peut le VALIDER reste celle du centre. Y glisser une garde
 * en ferait une seconde vérité en retard (§118.119a).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature d'objet qui signe une demande de validation de BC — c'est ELLE qu'on relit, pas le titre. */
export const OBJET_BC = "BON_DE_COMMANDE";
/** Le libellé de module affiché au centre de validations. */
export const MODULE_BC = "Bons de commande";

/**
 * LES TYPES D'ENTITÉ QUI FONT D'UN BC UN BC « AD & PRO » — dérivés du registre canonique.
 *
 * Les sept natures, plus le POSTE d'une opération, qui n'est pas une nature mais en fait partie.
 * Une huitième nature ajoutée au registre entre ici sans que personne y pense (§118.73). La liste
 * vit UNE fois, dans le registre : le secrétariat pose la même question pour l'imputation, et la
 * recopie qu'il en avait faite à la main avait déjà divergé (§118.150).
 */
export const TYPES_AD_PRO: ReadonlySet<string> = TYPES_ENTITE_AD_PRO;

// ───────────────────────── L'origine ─────────────────────────

export interface MaillonOrigine { type: string; id: string }
export interface OrigineBC {
  /** Du plus proche au plus lointain : la source directe d'abord. */
  chemin: MaillonOrigine[];
  /** Le poste Ad & Pro traversé, s'il y en a un — c'est lui qui porte alors la décision. */
  posteId: string | null;
}

/** Au-delà, un chemin tourne en rond ou n'a plus rien d'une origine : on s'arrête. */
const SAUTS_MAX = 6;

/**
 * UN PAS VERS L'ORIGINE — chaque type dit où il pointe, et c'est une liste FERMÉE.
 *
 * On ne suit que des liens déclarés au schéma (la demande de pièce vers son objet, l'ordre de
 * dépense vers sa source, le dossier de paiement vers son objet, la demande administrative vers
 * ce qu'elle sert). Deviner un lien par ressemblance de nom rattacherait un BC à la mauvaise
 * fiche, donc au mauvais centre (§118.36).
 */
async function suivant(m: MaillonOrigine): Promise<MaillonOrigine | null> {
  switch (m.type) {
    case "DOCUMENT_REQUEST": {
      const r = await prisma.documentRequest.findUnique({ where: { id: m.id }, select: { entityType: true, entityId: true } }).catch(sansBloquer("aiguillage.suivant.documentRequest", null));
      return r ? { type: r.entityType, id: r.entityId } : null;
    }
    case "EXPENSE_ORDER": {
      const o = await prisma.expenseOrder.findUnique({ where: { id: m.id }, select: { sourceType: true, sourceId: true } }).catch(sansBloquer("aiguillage.suivant.expenseOrder", null));
      return o?.sourceType && o.sourceId ? { type: o.sourceType, id: o.sourceId } : null;
    }
    case "PAYMENT_REQUEST": {
      const p = await prisma.paymentRequest.findUnique({ where: { id: m.id }, select: { entityType: true, entityId: true } }).catch(sansBloquer("aiguillage.suivant.paymentRequest", null));
      return p?.entityType && p.entityId ? { type: p.entityType, id: p.entityId } : null;
    }
    case "ADMIN_REQUEST": {
      const a = await prisma.administrativeRequest.findUnique({ where: { id: m.id }, select: { linkedEntityType: true, linkedEntityId: true } }).catch(sansBloquer("aiguillage.suivant.administrativeRequest", null));
      return a?.linkedEntityType && a.linkedEntityId ? { type: a.linkedEntityType, id: a.linkedEntityId } : null;
    }
    case "LEGAL_DOCUMENT": {
      const d = await prisma.legalDocument.findUnique({ where: { id: m.id }, select: { sourceType: true, sourceId: true } }).catch(sansBloquer("aiguillage.suivant.legalDocument", null));
      return d?.sourceType && d.sourceId ? { type: d.sourceType, id: d.sourceId } : null;
    }
    default:
      return null;
  }
}

/**
 * D'OÙ VIENT CE BC ? — sa source directe, et à défaut celle de la pièce dont il DÉCOULE (le devis).
 *
 * Un BC composé par la fabrique ne porte pas de source : c'est son DEVIS, lui, qui a été créé
 * depuis la fiche du sponsoring. « Le bon de commande vers son devis » est précisément le lien
 * que la chaîne d'achat existe pour tenir (`chainFromId`) — on le remonte, borné.
 */
export async function origineDuBC(doc: {
  sourceType: string | null; sourceId: string | null; chainFromId: string | null;
}): Promise<OrigineBC> {
  let depart: MaillonOrigine | null = doc.sourceType && doc.sourceId ? { type: doc.sourceType, id: doc.sourceId } : null;
  let amontId = doc.chainFromId;
  for (let i = 0; !depart && amontId && i < 3; i += 1) {
    const amont = await prisma.legalDocument.findUnique({
      where: { id: amontId }, select: { sourceType: true, sourceId: true, chainFromId: true },
    }).catch(sansBloquer("aiguillage.origineDuBC.legalDocument", null));
    if (!amont) break;
    depart = amont.sourceType && amont.sourceId ? { type: amont.sourceType, id: amont.sourceId } : null;
    amontId = amont.chainFromId;
  }

  const chemin: MaillonOrigine[] = [];
  const vus = new Set<string>();
  let posteId: string | null = null;
  let courant = depart;
  for (let i = 0; courant && i < SAUTS_MAX; i += 1) {
    const cle = `${courant.type}:${courant.id}`;
    if (vus.has(cle)) break;
    vus.add(cle);
    chemin.push(courant);
    if (courant.type === "AD_PRO_ITEM") { posteId = courant.id; break; }
    courant = await suivant(courant);
  }
  return { chemin, posteId };
}

/**
 * LE CENTRE QUE DÉSIGNE L'ORIGINE D'UN BC — lu par l'aiguillage ET par la fiche Legal, une fois.
 *
 * Le TYPE d'un maillon ne suffit plus : un contrat de consulting passé aux RH (§118.150) reste un
 * `CONSULTING_CONTRACT`, mais ce n'est plus une dépense de promotion — ses bons de commande vont
 * au centre de validations, comme ceux de toute fiche hors Ad & Pro. « Tout BC passe par le centre
 * Ad & Pro si la demande vient d'Ad & Pro, sinon par le centre normal » : c'est le PÔLE du contrat
 * qui dit d'où vient la demande, pas le nom de sa table.
 *
 * Le pôle se lit sur la LIGNE, en une requête pour tout le chemin. Un contrat qu'on ne relit pas
 * garde le défaut du schéma (Ad & Pro) : les deux centres valident, et se tromper de centre coûte
 * un transfert, jamais un BC qui part sans avoir été vu.
 */
export async function centreVouluDuBC(origine: OrigineBC): Promise<CentreBC> {
  const contrats = [...new Set(origine.chemin.filter((m) => m.type === "CONSULTING_CONTRACT").map((m) => m.id))];
  const horsAdPro = new Set<string>();
  if (contrats.length > 0) {
    const lignes = await prisma.consultingContract
      .findMany({ where: { id: { in: contrats } }, select: { id: true, pole: true } })
      .catch(sansBloquer("aiguillage.centreVouluDuBC.consultingContract", []));
    for (const l of lignes) if (poleDe(l.pole) !== "AD_PRO") horsAdPro.add(l.id);
  }
  return centreDeLOrigine(
    origine.chemin.filter((m) => !(m.type === "CONSULTING_CONTRACT" && horsAdPro.has(m.id))).map((m) => m.type),
    TYPES_AD_PRO,
  );
}

// ───────────────────────── La lecture des portes ─────────────────────────

/**
 * LES PORTES DE PLUSIEURS BC, EN QUATRE LECTURES — jamais une par document.
 *
 * Une liste Legal de cent pièces qui lirait l'origine de chacune ferait cent allers-retours sur
 * un écran qu'on ouvre dix fois par jour (§118.102b). Le seul chemin qui mène à un poste passe
 * par une demande de pièce : on ne suit que celui-là, en lot.
 *
 * Précédence : le visa du POSTE d'abord (c'est la demande qui a été visée), puis la porte la plus
 * RÉCENTE du document lui-même — un BC transféré d'un centre à l'autre, ou rouvert après une
 * demande de modification, garde son historique ; c'est la dernière porte qui dit où il en est.
 */
export async function portesDesBC(docIds: readonly string[]): Promise<Map<string, PorteBC>> {
  const res = new Map<string, PorteBC>();
  const ids = [...new Set(docIds.filter(Boolean))];
  if (ids.length === 0) return res;

  const docs = await prisma.legalDocument.findMany({
    where: { id: { in: ids }, kind: "PURCHASE_ORDER" },
    select: { id: true, sourceType: true, sourceId: true },
  }).catch(sansBloquer("aiguillage.portesDesBC.legalDocument", []));
  if (docs.length === 0) return res;
  const bcIds = docs.map((d) => d.id);

  // 1a. Le BC GÉNÉRÉ d'après les lignes validées d'un devis de poste (§118.206) naît AVEC le poste pour source :
  // c'est le visa de ce poste qu'il lit, comme celui qu'une assistante dépose. Une seconde porte sur la pièce
  // ferait valider deux fois le même engagement (§118.5).
  const parPoste = docs.filter((d) => d.sourceType === "AD_PRO_ITEM" && d.sourceId);
  if (parPoste.length > 0) {
    const postes = await prisma.adProItem.findMany({
      where: { id: { in: [...new Set(parPoste.map((d) => d.sourceId!))] } },
      select: { id: true, orderStage: true, orderDecisionNote: true },
    }).catch(sansBloquer("aiguillage.portesDesBC.adProItem", []));
    const posteParId = new Map(postes.map((p) => [p.id, p]));
    for (const d of parPoste) {
      const poste = posteParId.get(d.sourceId!);
      const etat = poste ? etatDepuisPoste(poste.orderStage) : null;
      if (poste && etat) res.set(d.id, { centre: "AD_PRO", etat, source: "POSTE", note: poste.orderDecisionNote });
    }
  }

  // 1b. Le visa du poste, par la demande de pièce qui a fait naître le BC.
  const parDemande = docs.filter((d) => d.sourceType === "DOCUMENT_REQUEST" && d.sourceId);
  if (parDemande.length > 0) {
    const demandes = await prisma.documentRequest.findMany({
      where: { id: { in: parDemande.map((d) => d.sourceId!) }, entityType: "AD_PRO_ITEM" },
      select: { id: true, entityId: true },
    }).catch(sansBloquer("aiguillage.portesDesBC.documentRequest", []));
    const postes = demandes.length
      ? await prisma.adProItem.findMany({
          where: { id: { in: demandes.map((d) => d.entityId) } },
          select: { id: true, orderStage: true, orderDecisionNote: true },
        }).catch(sansBloquer("aiguillage.portesDesBC.adProItem", []))
      : [];
    const posteDe = new Map(demandes.map((d) => [d.id, postes.find((p) => p.id === d.entityId) ?? null]));
    for (const d of parDemande) {
      const poste = posteDe.get(d.sourceId!);
      const etat = poste ? etatDepuisPoste(poste.orderStage) : null;
      if (poste && etat) res.set(d.id, { centre: "AD_PRO", etat, source: "POSTE", note: poste.orderDecisionNote });
    }
  }

  // 2. Les portes du document lui-même : visa Ad & Pro et demande de validation, la plus récente.
  const restants = bcIds.filter((id) => !res.has(id));
  if (restants.length === 0) return res;
  const [visas, validations] = await Promise.all([
    prisma.adProGateVisa.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: { in: restants } },
      select: { entityId: true, status: true, note: true, updatedAt: true },
    }).catch(sansBloquer("aiguillage.portesDesBC.adProGateVisa", [])),
    prisma.validationRequest.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: { in: restants }, objectType: OBJET_BC, status: { not: "CANCELLED" } },
      select: {
        entityId: true, status: true, updatedAt: true,
        steps: { where: { reason: { not: null } }, select: { reason: true }, orderBy: { decidedAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
    }).catch(sansBloquer("aiguillage.portesDesBC.validationRequest", [])),
  ]);

  const candidates = new Map<string, { quand: number; porte: PorteBC }>();
  const garder = (id: string, quand: Date, porte: PorteBC) => {
    const deja = candidates.get(id);
    if (!deja || quand.getTime() > deja.quand) candidates.set(id, { quand: quand.getTime(), porte });
  };
  for (const v of visas) {
    garder(v.entityId, v.updatedAt, { centre: "AD_PRO", etat: etatDepuisVisa(v.status), source: "DOCUMENT", note: v.note });
  }
  for (const v of validations) {
    if (!v.entityId) continue;
    const etat = etatDepuisValidation(v.status);
    if (!etat) continue;
    garder(v.entityId, v.updatedAt, { centre: "VALIDATION", etat, source: "DOCUMENT", note: v.steps[0]?.reason ?? null });
  }
  for (const [id, c] of candidates) res.set(id, c.porte);
  return res;
}

/** La porte d'UN BC — `null` = aucune (BC d'avant la règle, ou pièce d'une autre nature). */
export async function porteDuBC(docId: string): Promise<PorteBC | null> {
  return (await portesDesBC([docId])).get(docId) ?? null;
}

// ───────────────────────── L'écriture ─────────────────────────

type DocBC = {
  id: string; reference: string | null; title: string; counterparty: string | null;
  amount: unknown; createdById: string | null;
};

const montantDe = (d: { amount: unknown }): number | null => (d.amount == null ? null : toNumber(d.amount as never));

const intitule = (d: DocBC): string => {
  const ref = d.reference?.trim();
  const partie = d.counterparty?.trim();
  return [ref ? `Bon de commande ${ref}` : `Bon de commande « ${d.title} »`, partie].filter(Boolean).join(" — ");
};

const montantLisible = (m: number | null) => (m != null && m > 0 ? `${m.toLocaleString("fr-FR")} DZD` : "montant non renseigné");

/** Retire ce qui ATTEND encore — une décision prise, elle, ne s'efface jamais. */
export async function retirerEnAttente(docId: string): Promise<number> {
  const [visas, validations] = await Promise.all([
    prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: docId, status: "PENDING" } }).catch(sansBloquer("aiguillage.retirerEnAttente.adProGateVisa", { count: 0 })),
    prisma.validationRequest.updateMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_BC, status: "PENDING" },
      data: { status: "CANCELLED", decidedAt: new Date() },
    }).catch(sansBloquer("aiguillage.retirerEnAttente.validationRequest", { count: 0 })),
  ]);
  return visas.count + validations.count;
}

/**
 * RETIRER CE QUI ATTEND, avant de supprimer la pièce — l'arbitrage n'aurait plus d'objet.
 *
 * Distincte de `aiguillerBC`, qui RELIT la pièce : sur une suppression, il n'y a plus rien à
 * relire, et c'est justement le moment où la porte doit disparaître du centre.
 */
export async function retirerPortesEnAttente(docId: string, acteurId: string): Promise<number> {
  const n = await retirerEnAttente(docId);
  if (n > 0) {
    await recordAudit({
      actorId: acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: docId,
      summary: "Bon de commande supprimé — sa validation en attente est retirée du centre.",
    }).catch(sansBloquer("aiguillage.retirerPortesEnAttente.recordAudit"));
  }
  return n;
}

/**
 * POSER LA PORTE dans le centre voulu. Rend `false` quand personne ne siège au centre de
 * validations — cas qui ne devrait pas exister, et qu'on DIT plutôt que de le taire.
 */
async function poser(doc: DocBC, centre: CentreBC, acteurId: string, motif: string | null): Promise<boolean> {
  const montant = montantDe(doc);
  const titre = intitule(doc);

  if (centre === "AD_PRO") {
    await prisma.adProGateVisa.upsert({
      where: { entityType_entityId: { entityType: "LEGAL_DOCUMENT", entityId: doc.id } },
      // AUCUN SEUIL FIGÉ sur la ligne : la porte d'un BC suit le seuil des bons de commande EN
      // VIGUEUR, relu à chaque aiguillage et réévalué quand il change (§118.149). Une valeur figée
      // ici se lirait comme la raison du passage alors qu'elle peut ne plus l'être.
      create: { entityType: "LEGAL_DOCUMENT", entityId: doc.id, status: "PENDING", threshold: null, amount: montant, note: motif },
      // ROUVRIR : la décision précédente est effacée de la LIGNE, pas de l'histoire — le journal
      // d'audit garde qui avait validé et quand, et la raison de la réouverture est la note.
      update: { status: "PENDING", decidedById: null, decidedAt: null, note: motif, amount: montant },
    });
    await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
      type: "VALIDATION_REQUIRED",
      title: motif ? "Bon de commande à revalider" : "Bon de commande à valider",
      body: `${titre} (${montantLisible(montant)})${motif ? ` — ${motif}` : ""}`,
      // La ligne du BC dans le centre (`?ligne=<pièce Legal>`) : la notification arrive sur LUI.
      link: lienLigneCentreAdPro(doc.id),
    }).catch(sansBloquer("aiguillage.poser.notifyRoles"));
    return true;
  }

  const demandeurId = doc.createdById ?? acteurId;
  const sieges = await prisma.user.findMany({
    where: { role: { in: ["GENERAL_MANAGER", "SUPER_ADMIN"] }, isActive: true },
    select: { id: true, role: true, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  // Le demandeur ne se valide pas lui-même tant qu'un autre siège existe ; s'il est le SEUL
  // siège, il valide explicitement — un clic conscient vaut mieux qu'une porte sans validateur.
  const validateur = centreValidatorFrom(sieges.filter((s) => s.id !== demandeurId)) ?? centreValidatorFrom(sieges);
  if (!validateur) return false;
  const r = await createDirectValidation({
    requesterId: demandeurId,
    title: titre,
    description: [
      motif,
      `Montant : ${montantLisible(montant)}.`,
      "Tout bon de commande passe par le centre de validations avant d'engager la société (décision de la Direction, 09/2026).",
    ].filter(Boolean).join("\n"),
    link: `/legal/${doc.id}`,
    module: MODULE_BC,
    objectType: OBJET_BC,
    entityType: "LEGAL_DOCUMENT" as EntityType,
    entityId: doc.id,
    amount: montant,
    validatorIds: [validateur],
    allowSelf: validateur === demandeurId,
  });
  return r.ok;
}

export interface ResultatAiguillage {
  /** La porte après l'aiguillage — `null` si la pièce n'est pas (ou plus) un BC. */
  porte: PorteBC | null;
  /**
   * Ce qui a été fait, pour la phrase de l'appelant — `null` quand rien n'a bougé. `SOUS_SEUIL` :
   * la validation qui attendait a été retirée, le BC étant passé sous le seuil (§118.149).
   */
  geste: "POSEE" | "TRANSFEREE" | "ROUVERTE" | "ACTUALISEE" | "RETIREE" | "SOUS_SEUIL" | null;
  /**
   * L'ÉTAPE du BC après l'aiguillage (§118.149) — `null` quand la pièce n'est pas un BC en vie.
   * C'est elle que la phrase de l'appelant dit : « attend la signature des Finances » pour un BC
   * sous le seuil, là où la porte seule (nulle) ne dirait rien.
   */
  etape?: EtapeBC | null;
  /** Vrai quand la signature des Finances vient d'être retirée : le montant a changé après elle. */
  signatureRetiree?: boolean;
  /**
   * Vrai quand le BC vient d'ENTRER dans la file de signature des Finances par cet aiguillage —
   * c'est le seul cas où la phrase de l'appelant doit l'annoncer, et celui où elles sont prévenues.
   */
  versLesFinances?: boolean;
  /** Le seuil appliqué — pour que la phrase de l'appelant dise POURQUOI aucun centre ne le voit. */
  seuil?: number;
  /** Vrai quand la porte n'a PAS pu être posée : aucun siège au centre. Se dit, ne se tait pas. */
  sansSiege?: boolean;
  /**
   * Vrai quand l'aiguillage a ÉCHOUÉ (une erreur, pas une décision) : la pièce est écrite, sa porte
   * ne l'est pas. Distinct de « pas un BC » — les deux rendaient `porte: null, geste: null`, et
   * l'appelant ne pouvait pas savoir qu'il devait le DIRE. Mesuré : dix BC émis en parallèle, les
   * derniers sans porte, et la phrase de l'émission muette (§118.148).
   */
  enEchec?: boolean;
  /** Vrai quand le BC est retenu par sa pré-validation : aucun centre ne le voit encore (`prevalidation.ts`). */
  enPrevalidation?: boolean;
}

/**
 * PRÉVENIR LES SIGNATAIRES QU'UN BC ATTEND LEUR SIGNATURE (§118.149) — « si un BC se retrouve
 * là-bas, c'est qu'il doit être signé » : encore faut-il qu'ils sachent qu'il y est. QUI est
 * prévenu ne se lit plus sur un rôle mais sur le module « Bons de commande » tel que le Super
 * Admin l'a réglé (`signataires.ts`, §118.176).
 *
 * Appelée sur une TRANSITION vers « à signer » (aiguillage, décision d'un centre), jamais à
 * chaque relecture : une notification répétée pour la même pièce cesse d'être lue (§118.32).
 */
export async function notifierSignatairesBCASigner(doc: DocBC): Promise<void> {
  await notifierSignatairesBC({
    type: "VALIDATION_REQUIRED",
    title: "Bon de commande à signer",
    body: `${intitule(doc)} (${montantLisible(montantDe(doc))})`,
    // La ligne du BC dans la file (`?bc=<pièce Legal>`) : on arrive sur celui qu'on doit signer.
    link: lienBonDeCommande(doc.id),
  }).catch(sansBloquer("aiguillage.notifierSignatairesBCASigner.notifierSignatairesBC"));
}

/**
 * AIGUILLER UN BC — l'unique point d'entrée des écrivains, idempotent.
 *
 * Appelée après chaque écriture qui crée un BC, le modifie, le re-qualifie, le rattache ou
 * l'annule. Elle relit la pièce, calcule l'origine, lit la porte, demande à la règle pure ce
 * qu'il faut faire, et le fait. L'appeler deux fois ne pose jamais deux portes : la seconde
 * lecture trouve la première.
 *
 * Elle NE LÈVE JAMAIS : un échec d'aiguillage ne défait pas l'écriture de la pièce, qui a eu
 * lieu. Il rend `porte: null` ET `enEchec: true` — la phrase de l'appelant le DIT
 * (`reserveSansPorte`), et la fiche du BC montre le geste « Adresser au centre » qui rattrape :
 * une pièce sans porte ne reste pas invisible.
 */
export async function aiguillerBC(
  docId: string,
  opts: {
    acteurId: string; montantAvant?: number | null; modifie?: boolean;
    /**
     * La PIÈCE elle-même a changé au-delà de son montant : un autre fournisseur, ou une nouvelle
     * version du fichier composé. Ce n'est plus le BC que les Finances ont signé (§118.149).
     */
    pieceRevisee?: boolean;
    /**
     * Ne pas prévenir les Finances BC par BC : l'appelant traite un LOT (un changement de seuil)
     * et leur envoie UNE notification qui dit combien. Cinquante notifications identiques pour un
     * seul geste de la Direction cesseraient d'être lues (§118.32).
     */
    silencieux?: boolean;
    /**
     * Le seuil à appliquer, quand l'appelant le TIENT déjà : le réglage vient d'être écrit dans la
     * même requête, et la lecture des réglages est mise en cache par requête — relire rendrait
     * l'ancienne valeur. Absent : le réglage en vigueur du centre du BC.
     */
    seuil?: number;
    /**
     * Le centre dont `seuil` est le réglage (Direction, 10/2026 : un seuil PAR centre). Un BC d'un autre centre garde
     * le seuil en vigueur du sien. Absent : `seuil` vaut pour tout BC (ancien comportement des appelants).
     */
    seuilPour?: CentreBC;
  },
): Promise<ResultatAiguillage> {
  try {
    const doc = await prisma.legalDocument.findUnique({
      where: { id: docId },
      select: {
        id: true, kind: true, status: true, reference: true, title: true, counterparty: true,
        amount: true, createdById: true, sourceType: true, sourceId: true, chainFromId: true,
        signedAt: true, signedById: true, bcCircuitAt: true, signatureReturnedAt: true, bcPrevalidationAt: true,
      },
    });
    if (!doc) return { porte: null, geste: null };

    // EN PRÉ-VALIDATION (Demandes de validations) : le BC n'est adressé à AUCUN centre tant que le demandeur n'a pas
    // demandé la validation finale (`prevalidation.ts`). Une porte qui attendrait encore est retirée — personne ne
    // l'a vue, et la validation finale la reposera. Annulé ou re-qualifié, il suit la règle ordinaire ci-dessous.
    if (doc.bcPrevalidationAt && doc.kind === "PURCHASE_ORDER" && doc.status !== "CANCELLED") {
      const retires = await retirerEnAttente(doc.id);
      return { porte: null, geste: retires > 0 ? "RETIREE" : null, etape: "HORS_CIRCUIT", enPrevalidation: true };
    }

    // Plus un BC (re-qualifié) ou annulé : ce qui attendait n'a plus d'objet.
    if (doc.kind !== "PURCHASE_ORDER" || doc.status === "CANCELLED") {
      const retires = await retirerEnAttente(doc.id);
      if (retires > 0) {
        await recordAudit({
          actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
          summary: doc.status === "CANCELLED"
            ? "Bon de commande annulé — sa validation en attente est retirée du centre."
            : "La pièce n'est plus un bon de commande — sa validation en attente est retirée du centre.",
        }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
      }
      return { porte: null, geste: retires > 0 ? "RETIREE" : null };
    }

    // LE SEUIL DE SON CENTRE (Direction, 10/2026) : le centre se lit sur l'origine du BC, avant tout le reste.
    const origine = await origineDuBC(doc);
    const centreVoulu = await centreVouluDuBC(origine);
    const reglages = await getAppSettings();
    const seuil = opts.seuil !== undefined && (!opts.seuilPour || opts.seuilPour === centreVoulu)
      ? opts.seuil
      : seuilDuCentre({ adPro: reglages.bcValidationThreshold, validation: reglages.bcValidationThresholdCentre }, centreVoulu);
    const montant = montantDe(doc);
    const requise = validationRequiseBC(montant, seuil);

    // L'ENTRÉE DANS LE CIRCUIT (§118.149) : la première lecture sous cette règle la date. Sans ce
    // marqueur, fixer un seuil ferait tomber tout l'historique dans la file des Finances.
    const dejaDansLeCircuit = doc.bcCircuitAt !== null;
    // UNE DATE DE SIGNATURE SANS SIGNATAIRE N'EST PAS LA SIGNATURE DES FINANCES. Elle ne peut
    // venir que d'une pièce RE-QUALIFIÉE en BC (un contrat du PCH porte sa date de signature
    // papier) : aucun écrivain de BC ne pose l'une sans l'autre, et une signature n'est donnée
    // qu'à un BC déjà dans le circuit. Sans cette ligne, re-qualifier un contrat signé en BC le
    // ferait passer pour signé par les Finances — le faux succès exact que ce circuit ferme. La
    // date retirée est consignée au journal : rien ne se perd.
    let signeALEntree = doc.signedAt;
    if (!dejaDansLeCircuit) {
      const dateSansSignataire = doc.signedAt !== null && doc.signedById === null;
      await prisma.legalDocument.update({
        where: { id: doc.id },
        data: { bcCircuitAt: new Date(), ...(dateSansSignataire ? { signedAt: null } : {}) },
      });
      if (dateSansSignataire) {
        await recordAudit({
          actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
          field: "signedAt", oldValue: doc.signedAt!.toISOString(), newValue: null,
          summary: "Bon de commande : la date de signature reprise d'une autre nature de pièce ne vaut pas signature des Finances — retirée.",
        }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
        signeALEntree = null;
      }
    }

    // UNE SIGNATURE PORTE SUR UNE PIÈCE ET SON MONTANT. Modifié après elle, le BC n'est plus
    // celui que les Finances ont signé : la signature tombe, et le BC retourne dans leur file.
    // Sans cette ligne, on signerait 400 000 et on enverrait 2 000 000 « signé » — ou l'on
    // signerait pour un fournisseur et l'on enverrait à un autre.
    const montantAvant = opts.montantAvant ?? null;
    let signe = signeALEntree !== null;
    let signatureRetiree = false;
    const montantModifie = Boolean(opts.modifie) && montantAvant !== montant;
    if (signe && (montantModifie || opts.pieceRevisee)) {
      // La copie signée et son signataire tombent avec elle : ils portaient sur la version d'avant.
      await prisma.legalDocument.update({ where: { id: doc.id }, data: { signedAt: null, signedById: null, signedByName: null, signatureCheck: Prisma.DbNull } });
      await recordAudit({
        actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
        summary: montantModifie
          ? `Signature des Finances retirée : montant modifié après signature (${montantLisible(montantAvant)} → ${montantLisible(montant)}).`
          : "Signature des Finances retirée : le bon de commande a été révisé après signature (fournisseur ou pièce).",
      }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
      signe = false;
      signatureRetiree = true;
    }

    // UN BC RENVOYÉ À SON ÉMETTEUR (audit 360°, R09) revient à la signature dès qu'il est MODIFIÉ :
    // c'est la correction que le signataire a demandée. Le renvoi s'efface de la LIGNE ; le journal
    // garde qui l'avait renvoyé et pourquoi. Toute modification compte — la juger « suffisante » à la
    // place du signataire, c'est lui qui le fera en relisant.
    const renvoyeAvant = doc.signatureReturnedAt !== null;
    let renvoye = renvoyeAvant;
    if (renvoye && opts.modifie) {
      await prisma.legalDocument.update({
        where: { id: doc.id },
        data: { signatureReturnedAt: null, signatureReturnedById: null, signatureReturnNote: null },
      });
      await recordAudit({
        actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
        summary: "Bon de commande corrigé après son renvoi par un signataire — il revient à la signature.",
      }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
      renvoye = false;
    }

    const actuelle = await porteDuBC(doc.id);
    const etapeAvant = etapeBC({ porte: actuelle, validationRequise: requise, signe: signeALEntree !== null, dansLeCircuit: dejaDansLeCircuit, renvoye: renvoyeAvant });
    const geste = gesteAiguillage({
      actuelle, centreVoulu,
      montantAvant,
      montantApres: montant,
      modifie: opts.modifie ?? false,
      seuil,
    });

    // LA FIN DE L'AIGUILLAGE, POUR TOUS LES GESTES : l'étape obtenue, et les Finances prévenues
    // si le BC vient d'ENTRER dans leur file (jamais s'il y était déjà).
    const conclure = async (
      porte: PorteBC | null, gesteRendu: ResultatAiguillage["geste"],
    ): Promise<ResultatAiguillage> => {
      const etape = etapeBC({ porte, validationRequise: requise, signe, dansLeCircuit: true, renvoye });
      const versLesFinances = etape === "A_SIGNER" && etapeAvant !== "A_SIGNER";
      if (versLesFinances && !opts.silencieux) await notifierSignatairesBCASigner(doc);
      return {
        porte, geste: gesteRendu, etape, seuil,
        ...(signatureRetiree ? { signatureRetiree } : {}),
        ...(versLesFinances ? { versLesFinances } : {}),
      };
    };

    switch (geste.geste) {
      case "RIEN":
        return conclure(actuelle, null);

      case "RETIRER": {
        const retires = await retirerEnAttente(doc.id);
        await recordAudit({
          actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
          summary: `Bon de commande — ${geste.motif}${retires > 0 ? " Sa validation en attente est retirée du centre." : ""}`,
        }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
        return conclure(null, "SOUS_SEUIL");
      }

      case "ACTUALISER": {
        await Promise.all([
          prisma.adProGateVisa.updateMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id, status: "PENDING" }, data: { amount: montant } }),
          prisma.validationRequest.updateMany({
            where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id, objectType: OBJET_BC, status: "PENDING" },
            data: { amount: montant },
          }),
        ]);
        return conclure(actuelle, "ACTUALISEE");
      }

      case "TRANSFERER":
      case "POSER":
      case "ROUVRIR": {
        if (geste.geste === "TRANSFERER") await retirerEnAttente(doc.id);
        const motif = geste.geste === "ROUVRIR" ? geste.motif : null;
        const ok = await poser(doc, centreVoulu, opts.acteurId, motif);
        if (!ok) return { porte: null, geste: null, sansSiege: true, etape: "SANS_PORTE" };
        const verbe = geste.geste === "TRANSFERER" ? "transféré au" : geste.geste === "ROUVRIR" ? "renvoyé au" : "adressé au";
        await recordAudit({
          actorId: opts.acteurId, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
          summary: `Bon de commande ${verbe} ${LIBELLE_CENTRE_BC[centreVoulu]}${motif ? ` — ${motif}` : ""}`,
        }).catch(sansBloquer("aiguillage.aiguillerBC.recordAudit"));
        return conclure(
          { centre: centreVoulu, etat: "EN_ATTENTE", source: "DOCUMENT", note: motif },
          geste.geste === "TRANSFERER" ? "TRANSFEREE" : geste.geste === "ROUVRIR" ? "ROUVERTE" : "POSEE",
        );
      }
    }
  } catch (err) {
    console.error("[bons-de-commande] aiguillage impossible", docId, err);
    return { porte: null, geste: null, enEchec: true };
  }
}

// ───────────────────────── La fiche d'origine qui change de pôle ─────────────────────────

/** Un centre est une file courte ; au-delà, on borne et on le DIT (§118.60). */
export const LOT_ORIGINE = 300;

export interface BilanReaiguillage {
  /** BC en attente dont l'origine passe par la fiche, relus par la règle unique. */
  relus: number;
  /** Ceux dont la porte en attente a changé de centre. */
  transferes: number;
  /** Vrai quand la lecture des files a été bornée : la phrase le dit au lieu de se croire exhaustive. */
  tronque: boolean;
}

/**
 * UNE FICHE D'ORIGINE A CHANGÉ DE PÔLE — les BC EN ATTENTE qui en descendent changent de centre.
 *
 * Transférer un contrat de consulting aux RH (§118.150) change le centre que ses bons de commande
 * doivent traverser. Sans ce geste, un BC en attente au centre Ad & Pro y resterait, arbitré par
 * le centre de la promotion alors que la règle de la Direction l'envoie au centre de validations —
 * l'écran de la fiche dirait « RH » et la file dirait « Ad & Pro » (§118.61 : qui lisait l'ancien
 * pôle ?).
 *
 * On ne touche QUE ce qui ATTEND : une porte DÉCIDÉE ne se rejuge pas parce que la fiche a changé
 * de pôle (`gesteAiguillage` y veille), et une signature des Finances ne tombe pas. Les candidats
 * sont les BC en attente dans l'un des deux centres — deux files courtes, pas le registre Legal —
 * et c'est `aiguillerBC`, la règle unique, qui décide pour chacun : réécrire ici le transfert en
 * ferait une seconde vérité (§118.5).
 */
export async function reaiguillerLesBCDe(fiche: MaillonOrigine, acteurId: string): Promise<BilanReaiguillage> {
  const bilan: BilanReaiguillage = { relus: 0, transferes: 0, tronque: false };
  const [visas, validations] = await Promise.all([
    prisma.adProGateVisa.findMany({
      where: { entityType: "LEGAL_DOCUMENT", status: "PENDING" },
      select: { entityId: true }, orderBy: { createdAt: "asc" }, take: LOT_ORIGINE + 1,
    }),
    prisma.validationRequest.findMany({
      where: { entityType: "LEGAL_DOCUMENT", objectType: OBJET_BC, status: "PENDING" },
      select: { entityId: true }, orderBy: { createdAt: "asc" }, take: LOT_ORIGINE + 1,
    }),
  ]);
  bilan.tronque = visas.length > LOT_ORIGINE || validations.length > LOT_ORIGINE;
  const ids = [...new Set([
    ...visas.slice(0, LOT_ORIGINE).map((v) => v.entityId),
    ...validations.slice(0, LOT_ORIGINE).map((v) => v.entityId).filter((x): x is string => Boolean(x)),
  ])];
  if (ids.length === 0) return bilan;
  const docs = await prisma.legalDocument.findMany({
    where: { id: { in: ids }, kind: "PURCHASE_ORDER" },
    select: { id: true, sourceType: true, sourceId: true, chainFromId: true },
  });
  for (const d of docs) {
    const origine = await origineDuBC(d);
    if (!origine.chemin.some((m) => m.type === fiche.type && m.id === fiche.id)) continue;
    bilan.relus += 1;
    const r = await aiguillerBC(d.id, { acteurId });
    if (r.geste === "TRANSFEREE") bilan.transferes += 1;
  }
  return bilan;
}

// ───────────────────────── Le seuil qui change ─────────────────────────

export interface BilanSeuil {
  /** BC du circuit dont le côté du seuil a changé, et qui ont donc été réaiguillés. */
  reevalues: number;
  /** Passés sous le seuil : leur validation en attente est retirée, ils vont à la signature. */
  versLaSignature: number;
  /** Passés au-dessus : ils attendaient la signature sans centre, ils vont à un centre. */
  versUnCentre: number;
  /** Vrai quand le lot a été borné : la phrase le DIT au lieu de se croire exhaustive (§118.60). */
  tronque: boolean;
}

/** Au-delà, un seul geste de réglage deviendrait une migration : on borne, et on le dit. */
const LOT_SEUIL = 500;

/**
 * LE SEUIL A CHANGÉ — les BC EN VOL qui ont changé de côté se réaiguillent (§118.149).
 *
 * Relever le seuil sans rien réaiguiller laisserait au centre des BC qu'aucun centre n'a plus à
 * voir — ils attendraient une validation dont la règle dit qu'elle n'est plus requise, pendant
 * que les Finances ne savent même pas qu'ils existent. L'abaisser laisserait dans la file des
 * Finances des BC que la règle envoie désormais à un centre. Dans les deux cas l'écran dirait
 * une chose et la règle une autre.
 *
 * On ne touche QUE ce qui est en vol : dans le circuit, pas signé, pas annulé, et dont le côté du
 * seuil a RÉELLEMENT changé — l'ancien et le nouveau seuil se comparent par la même règle pure.
 * Ce qu'un centre a DÉCIDÉ ne se re-juge pas (la règle pure y veille), et une signature donnée
 * ne se retire pas parce que le seuil a bougé : le BC est peut-être déjà chez le fournisseur.
 *
 * Le nouveau seuil est PASSÉ à chaque aiguillage : la lecture des réglages est mise en cache par
 * requête, et relire rendrait la valeur d'avant l'écriture.
 */
export async function reaiguillerSurChangementDeSeuil(ancien: number, nouveau: number, acteurId: string, centre: CentreBC = "AD_PRO"): Promise<BilanSeuil> {
  const bilan: BilanSeuil = { reevalues: 0, versLaSignature: 0, versUnCentre: 0, tronque: false };
  if (ancien === nouveau) return bilan;
  // LA BANDE DE MONTANTS QUI CHANGE DE CÔTÉ, calculée AVANT de lire : sans elle, on lirait les
  // premiers BC en vol de toute la base et l'on trierait ensuite — et sur une base chargée, ceux
  // qui changent réellement de côté pourraient tomber après la borne. Un montant inconnu ne
  // change jamais de côté (il exige un centre sous tous les seuils). Sans seuil (0), tout montant
  // positif exige un centre : la bande part donc de 0.
  const bas = ancien > 0 && nouveau > 0 ? Math.min(ancien, nouveau) : 0;
  const haut = Math.max(ancien, nouveau);
  const enVol = await prisma.legalDocument.findMany({
    where: {
      kind: "PURCHASE_ORDER", bcCircuitAt: { not: null }, signedAt: null, status: { notIn: ["CANCELLED", "RENEWED"] },
      amount: { gt: bas, lte: haut },
    },
    select: { id: true, amount: true, sourceType: true, sourceId: true, chainFromId: true },
    orderBy: { createdAt: "asc" },
    take: LOT_SEUIL + 1,
  });
  bilan.tronque = enVol.length > LOT_SEUIL;
  const changeDeCote = enVol.slice(0, LOT_SEUIL).filter((d) => {
    const m = montantDe(d);
    return validationRequiseBC(m, ancien) !== validationRequiseBC(m, nouveau);
  });
  // UN SEUIL PAR CENTRE (Direction, 10/2026) : seuls les BC dont l'origine désigne CE centre sont concernés.
  const aTraiter: typeof changeDeCote = [];
  for (const d of changeDeCote) {
    if ((await centreVouluDuBC(await origineDuBC(d))) === centre) aTraiter.push(d);
  }
  for (const d of aTraiter) {
    const r = await aiguillerBC(d.id, { acteurId, seuil: nouveau, seuilPour: centre, silencieux: true });
    bilan.reevalues += 1;
    if (r.versLesFinances) bilan.versLaSignature += 1;
    if (r.geste === "POSEE") bilan.versUnCentre += 1;
  }
  if (bilan.versLaSignature > 0) {
    await notifierSignatairesBC({
      type: "VALIDATION_REQUIRED",
      title: bilan.versLaSignature === 1 ? "Un bon de commande à signer" : `${bilan.versLaSignature} bons de commande à signer`,
      body: `Le seuil de validation des bons de commande (${LIBELLE_CENTRE_BC[centre]}) est passé à ${nouveau.toLocaleString("fr-FR")} DZD : `
        + `${bilan.versLaSignature === 1 ? "un BC qui attendait un centre passe" : `${bilan.versLaSignature} BC qui attendaient un centre passent`} directement à votre signature.`,
      link: CHEMIN_BC_A_SIGNER,
    }).catch(sansBloquer("aiguillage.reaiguillerSurChangementDeSeuil.notifierSignatairesBC"));
  }
  return bilan;
}
