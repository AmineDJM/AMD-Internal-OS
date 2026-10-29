import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { accesAuxPiecesLegalDetaille } from "@/lib/entity-access";
import { LEGAL_DOC_STATUS, MAIL_DIRECTION, invoiceSettlementState, INVOICE_SETTLEMENT, natureLegale } from "@/lib/labels";
import { formatCurrency, formatDate, toNumber } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { LIBELLE_ETAPE_BC, type EtapeBC } from "@/lib/bons-de-commande/regle";
import { fichiersEmis, type FichiersEmis } from "@/lib/legal/fichiers-emis";
import {
  categorieDuPdf, natureDeLaCategorie, sectionDeLaNature, type NatureDeChaine, type SectionPieces,
} from "@/modules/ad-pro/partage";

// La règle de section vit au module PUR, que le formulaire du navigateur lit aussi : on la
// réexporte pour les lecteurs serveur, on ne la réécrit pas (§118.5).
export { categorieDuPdf, sectionDeLaNature, type SectionPieces };
import type { DocItem } from "@/components/documents/document-list";
import type { MaillonAmont, NaturePieceLiee } from "@/components/pieces/attach-to-source";
import { demandeDeLaPiece, droitsSuppressionDesPieces, type DroitsPieceDemande } from "@/lib/queries/pieces-demande-droits";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES LIÉES D'UNE FICHE, LUES POUR L'ÉCRAN — ce qu'on montre, et ce que la personne peut
 * en faire (§118.161).
 *
 * Décision de la Direction (30/09/2026) : les pièces liées se lisent Devis → Bon de commande →
 * Facture (chacun avec sa « version plateforme » et son PDF), puis les Engagements (conventions
 * d'orateurs, contrats, tout le reste) — sans les bons de commande, qui ont leur maillon. Ce
 * module fait la LECTURE ; le composant `LinkedRecords` ne fait que la rendre. Séparés, parce que
 * c'est ici que vivent les droits, et qu'un droit se prouve sur la base avec de vrais acteurs —
 * pas en relisant un rendu.
 *
 * ── LES DROITS, PIÈCE PAR PIÈCE, PAR LA PORTE MÊME DU SERVEUR ─────────────────────────────
 *
 * Ouvrir, déposer, renommer, supprimer : `accesAuxPiecesLegal`, la règle de `canAccessEntity` lue
 * EN LOT. La lecture d'avant tenait par le seul droit de module (« peut lire Legal ») : un
 * document restreint à ses lecteurs désignés montrait ses fichiers, sur une fiche Ad & Pro, à
 * tout lecteur de Legal — le téléchargement était refusé ensuite, mais le nom, la taille et le
 * déposant étaient déjà à l'écran. Rien n'est chargé de ce que la personne ne peut pas ouvrir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Combien de lignes par section : au-delà, la section DIT ce qu'elle ne montre pas (§118.60). */
export const PAR_SECTION = 20;

export type Ton = "neutral" | "info" | "success" | "warning" | "danger" | "purple";

const TON_ETAPE_BC: Record<EtapeBC, Ton> = {
  HORS_CIRCUIT: "neutral", SANS_PORTE: "warning", A_VALIDER: "info", A_REVOIR: "warning",
  REFUSE: "danger", A_SIGNER: "purple", A_CORRIGER: "warning", SIGNE: "success",
};

/** Une pièce Legal liée, prête à rendre — et ce que la personne peut en faire. */
export interface LignePiece {
  id: string;
  kind: string;
  titre: string;
  reference: string | null;
  meta: string;
  badge: { label: string; tone: Ton } | null;
  /** La version plateforme (Word / PDF de la fabrique) — `null` si illisible ou absente. */
  plateforme: FichiersEmis | null;
  /**
   * La fiche `/legal/[id]` s'ouvre-t-elle à la personne ? Faux quand seule une exception de
   * lecture lui ouvre les fichiers (matériel promotionnel, arbitre d'une demande — §118.185) ou
   * quand la pièce lui est fermée : le titre se rend alors SANS lien, au lieu de mener à une page
   * refusée (§118.83).
   */
  fiche: boolean;
  /** Ses documents — `null` : la personne ne peut pas ouvrir la pièce, rien n'est chargé. */
  documents: DocItem[] | null;
  /** Renommer / supprimer ses documents (la règle du document : modifier ou supprimer la pièce). */
  gerable: boolean;
  /** Éditer en ligne (Office configuré ET gérable). */
  editable: boolean;
  /** La catégorie du PDF qu'on peut y joindre — `null` : la porte du serveur ne l'acceptera pas. */
  joindre: string | null;
  /**
   * SUPPRIMER la pièce ou l'un de ses fichiers depuis la demande (§118.209) — offert ou non, et pourquoi quand
   * ce qui ENGAGE la pièce le refuse. `null` : l'écran n'a pas demandé ce geste (`EntreePiecesLiees.suppression`).
   */
  suppression: DroitsPieceDemande | null;
}

export interface LigneCourrier {
  id: string;
  titre: string;
  reference: string | null;
  meta: string;
  badge: { label: string; tone: Ton } | null;
  documents: DocItem[] | null;
}

export interface PiecesLieesChargees {
  sections: Record<SectionPieces, LignePiece[]>;
  totaux: Record<SectionPieces, number>;
  courriers: LigneCourrier[];
  nbCourriers: number;
  /** Les fichiers de la fiche qui ont désormais une section (devis, BC, facture, convention). */
  libres: Record<NatureDeChaine, DocItem[]>;
  /** Les fichiers de la fiche qui restent des pièces de la demande. */
  propres: DocItem[];
  droitDeCreer: Record<NaturePieceLiee, boolean>;
  devisAmont: MaillonAmont[];
  bonsAmont: MaillonAmont[];
  total: number;
}

export interface EntreePiecesLiees {
  entityType: EntityType;
  entityId: string;
  canCreate: boolean;
  /** La personne qui regarde — sans elle, aucun document de pièce n'est chargé. */
  spectateur?: SessionUser | null;
  /** Peut lire les documents d'un courrier (module Courriers). */
  courriers?: boolean;
  /** Ce qu'elle peut créer, nature par nature — absent : ce que `canCreate` dit (écran d'avant). */
  creer?: { devis: boolean; bonDeCommande: boolean; facture: boolean; engagement: boolean; courrier: boolean } | null;
  /** Les fichiers déposés sur la fiche elle-même (emplacement nommé). */
  documentsDeLaFiche?: DocItem[];
  /**
   * Faut-il calculer le droit de SUPPRIMER pièces et fichiers (§118.209) ? Opt-in : seules les fiches Ad & Pro
   * l'offrent — la fiche d'une demande au secrétariat, qui monte aussi ce bloc, n'a pas demandé ce geste.
   */
  suppression?: boolean;
}

const docItem = (d: {
  id: string; name: string; category: string; version: number; sizeBytes: number | null; confidentiality: string;
  uploadedBy: { name: string } | null; createdAt: Date; fileKey: string | null;
}): DocItem => ({
  id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
  confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
  createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
});

export async function chargerPiecesLiees(e: EntreePiecesLiees): Promise<PiecesLieesChargees> {
  const where = { sourceType: e.entityType, sourceId: e.entityId };
  // UNE REQUÊTE pour toutes les pièces Legal, une pour les comptes par nature, deux pour les
  // courriers. Interroger chaque section à part demanderait quatre fois la même table.
  const [docs, comptes, mails, nbCourriers] = await Promise.all([
    prisma.legalDocument.findMany({
      where, orderBy: { createdAt: "desc" }, take: 200,
      select: {
        id: true, title: true, reference: true, kind: true, status: true, endDate: true, counterparty: true,
        amount: true, startDate: true, paidDate: true, expenseOrderId: true, custom: true, createdById: true,
        chainFrom: { select: { reference: true, title: true } },
      },
    }),
    prisma.legalDocument.groupBy({ by: ["kind"], where, _count: { _all: true } }),
    prisma.mailEntry.findMany({
      where, orderBy: { createdAt: "desc" }, take: PAR_SECTION,
      select: { id: true, title: true, reference: true, direction: true, sentAt: true },
    }),
    prisma.mailEntry.count({ where }),
  ]);

  const brutes: Record<SectionPieces, typeof docs> = { QUOTE: [], PURCHASE_ORDER: [], INVOICE: [], ENGAGEMENT: [] };
  for (const d of docs) {
    const s = brutes[sectionDeLaNature(d.kind)];
    if (s.length < PAR_SECTION) s.push(d);
  }
  const totaux: Record<SectionPieces, number> = { QUOTE: 0, PURCHASE_ORDER: 0, INVOICE: 0, ENGAGEMENT: 0 };
  for (const c of comptes) totaux[sectionDeLaNature(c.kind)] += c._count._all;

  // ─── CE QUE LA PERSONNE PEUT FAIRE DE CHAQUE PIÈCE — la porte du serveur, en lot ───────────
  const affichees = [...brutes.QUOTE, ...brutes.PURCHASE_ORDER, ...brutes.INVOICE, ...brutes.ENGAGEMENT];
  const detail = e.spectateur
    ? await accesAuxPiecesLegalDetaille(e.spectateur, affichees.map((d) => d.id), ["VIEW", "UPLOAD", "UPDATE", "DELETE"])
    : null;
  const droits = detail?.droits ?? null;
  const peut = (action: "VIEW" | "UPLOAD" | "UPDATE" | "DELETE", id: string) => droits?.get(action)?.has(id) ?? false;

  // ─── LES PIÈCES DES PIÈCES — deux requêtes au plus, jamais une par ligne ───────────────────
  // Deux gardes pour une seule propriété, et c'est MESURÉ : ne charger que les fichiers des pièces
  // lisibles (ici) ET ne les rendre que sur une ligne lisible (`ligne`, plus bas). Retirer ce filtre
  // SEUL laisse le banc vert — la garde de rendu tient — et le retrait de celle-ci le fait tomber.
  // Celui-ci reste pour ce qu'il est : ne pas lire en base les noms, tailles et déposants des
  // fichiers d'une pièce que la personne ne peut pas ouvrir (§118.140).
  const idsLegal = affichees.filter((d) => peut("VIEW", d.id)).map((d) => d.id);
  const idsCourrier = e.courriers ? mails.map((m) => m.id) : [];
  const [fichiersLegal, fichiersCourrier, etatsBC] = await Promise.all([
    idsLegal.length
      ? prisma.document.findMany({
          where: { entityType: "LEGAL_DOCUMENT", entityId: { in: idsLegal } },
          include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    idsCourrier.length
      ? prisma.document.findMany({
          where: { entityType: "MAIL_ENTRY", entityId: { in: idsCourrier } },
          include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    // OÙ EN EST CHAQUE BC — la même lecture que la file des Finances et la fiche Legal.
    etatsDesBC(brutes.PURCHASE_ORDER.map((d) => d.id)),
  ]);
  // Les droits de SUPPRESSION, en lot : la demande se juge une fois (§118.209).
  const demandeDuBloc = e.suppression && e.spectateur ? demandeDeLaPiece({ sourceType: e.entityType, sourceId: e.entityId }) : null;
  const droitsSuppression = demandeDuBloc && e.spectateur
    ? await droitsSuppressionDesPieces(e.spectateur, demandeDuBloc, affichees.filter((d) => peut("VIEW", d.id)).map((d) => ({ id: d.id, createdById: d.createdById })))
    : null;
  const parPiece = new Map<string, DocItem[]>();
  for (const d of [...fichiersLegal, ...fichiersCourrier]) {
    const liste = parPiece.get(d.entityId) ?? [];
    liste.push(docItem(d));
    parPiece.set(d.entityId, liste);
  }
  const edition = onlyofficeConfigured();
  const montant = (a: unknown) => (a !== null && a !== undefined ? formatCurrency(toNumber(a)) : "");

  const ligne = (d: (typeof docs)[number], meta: string[], badge: LignePiece["badge"]): LignePiece => {
    const lisible = peut("VIEW", d.id);
    const gerable = peut("UPDATE", d.id) || peut("DELETE", d.id);
    return {
      id: d.id, kind: d.kind, titre: d.title, reference: d.reference,
      meta: meta.filter(Boolean).join(" · "), badge,
      plateforme: lisible ? fichiersEmis(d.custom) : null,
      fiche: lisible && !(detail?.horsFiche.has(d.id) ?? false),
      documents: lisible ? parPiece.get(d.id) ?? [] : null,
      gerable, editable: edition && gerable,
      joindre: peut("UPLOAD", d.id) ? categorieDuPdf(d.kind) : null,
      suppression: droitsSuppression?.get(d.id) ?? null,
    };
  };

  const sections: Record<SectionPieces, LignePiece[]> = {
    QUOTE: brutes.QUOTE.map((d) => {
      const st = d.status !== "ACTIVE" ? LEGAL_DOC_STATUS[d.status] : null;
      return ligne(d, [
        d.counterparty ?? "", d.startDate ? `du ${formatDate(d.startDate)}` : "",
        d.endDate ? `valable jusqu'au ${formatDate(d.endDate)}` : "", montant(d.amount),
      ], st ? { label: st.label, tone: st.tone } : null);
    }),
    PURCHASE_ORDER: brutes.PURCHASE_ORDER.map((d) => {
      const etat = etatsBC.get(d.id);
      const badge = d.status === "CANCELLED"
        ? { label: LEGAL_DOC_STATUS.CANCELLED?.label ?? "Annulé", tone: "neutral" as const }
        : etat ? { label: LIBELLE_ETAPE_BC[etat.etape], tone: TON_ETAPE_BC[etat.etape] } : null;
      return ligne(d, [
        d.counterparty ?? "", d.startDate ? `du ${formatDate(d.startDate)}` : "", montant(d.amount),
        d.chainFrom ? `découle du devis ${d.chainFrom.reference ?? d.chainFrom.title}` : "",
      ], badge);
    }),
    INVOICE: brutes.INVOICE.map((d) => {
      const st = INVOICE_SETTLEMENT[invoiceSettlementState(d)];
      return ligne(d, [
        d.counterparty ?? "", d.startDate ? `émise le ${formatDate(d.startDate)}` : "",
        d.paidDate ? `réglée le ${formatDate(d.paidDate)}` : "", montant(d.amount),
        d.chainFrom ? `découle du BC ${d.chainFrom.reference ?? d.chainFrom.title}` : "",
      ], st ? { label: st.label, tone: st.tone } : null);
    }),
    ENGAGEMENT: brutes.ENGAGEMENT.map((d) => {
      const st = LEGAL_DOC_STATUS[d.status];
      return ligne(d, [
        natureLegale(d.kind), d.counterparty ?? "",
        d.endDate ? `jusqu'au ${formatDate(d.endDate)}` : "sans échéance", montant(d.amount),
      ], st ? { label: st.label, tone: st.tone } : null);
    }),
  };

  const courriers: LigneCourrier[] = mails.map((m) => {
    const dir = MAIL_DIRECTION[m.direction];
    return {
      id: m.id, titre: m.title, reference: m.reference,
      meta: m.sentAt ? `parti le ${formatDate(m.sentAt)}` : "",
      badge: dir ? { label: dir.label, tone: dir.tone } : null,
      documents: e.courriers ? parPiece.get(m.id) ?? [] : null,
    };
  });

  // ─── LES FICHIERS DÉJÀ DÉPOSÉS SUR LA FICHE — rangés dans la section de leur nature ────────
  const libres: Record<NatureDeChaine, DocItem[]> = { QUOTE: [], PURCHASE_ORDER: [], INVOICE: [], AGREEMENT: [] };
  const propres: DocItem[] = [];
  for (const d of e.documentsDeLaFiche ?? []) {
    const n = natureDeLaCategorie(d.category);
    if (n) libres[n].push(d); else propres.push(d);
  }

  // ─── CE QU'ON PEUT CRÉER D'ICI — la fiche ET la porte d'écriture de la nature ──────────────
  const c = e.creer;
  const droitDeCreer: Record<NaturePieceLiee, boolean> = {
    quote: e.canCreate && (c?.devis ?? true),
    order: e.canCreate && (c?.bonDeCommande ?? true),
    invoice: e.canCreate && (c?.facture ?? true),
    legal: e.canCreate && (c?.engagement ?? true),
    mail: e.canCreate && (c?.courrier ?? true),
  };
  const maillon = (d: (typeof docs)[number]): MaillonAmont => ({ value: d.id, label: [d.reference, d.title].filter(Boolean).join(" · ") });
  const devisAmont = brutes.QUOTE.filter((d) => d.status !== "CANCELLED").map(maillon);
  const bonsAmont = brutes.PURCHASE_ORDER.filter((d) => d.status !== "CANCELLED").map(maillon);

  return {
    sections, totaux, courriers, nbCourriers, libres, propres, droitDeCreer, devisAmont, bonsAmont,
    total: totaux.QUOTE + totaux.PURCHASE_ORDER + totaux.INVOICE + totaux.ENGAGEMENT + nbCourriers,
  };
}
