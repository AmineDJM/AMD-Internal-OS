import type { PaymentPieceKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { persistUploadedDocument } from "@/lib/documents";
import { readFileByKey, validateDocumentUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { lireDocumentLegal } from "@/lib/pieces-lues/document-legal";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { identiteLocaleDuDevis } from "@/lib/pieces-lues/fournisseur";
import { annuaireDeLecture } from "@/lib/pieces-lues/service";
import { fournisseurDuDevisDansLAnnuaire } from "@/lib/pieces-lues/devis-poste-lecture";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import type { IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import {
  avertissementUsage, natureAInscrireAuLegal, natureDePieceDuLegal, natureDePieceLue, NATURES_LEGAL_PAYABLES,
  refusReutilisation, STATUTS_DEMANDE_VIVANTE, titrePourLeRegistre,
  type DocumentLegalPropose, type LecturePourDemande, type NaturePieceDemande, type UsageDocumentLegal,
} from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE DEMANDE DE PAIEMENT — LEGAL ET LECTURE (Direction, 04/11/2026). Le serveur.
 *
 *   • `documentsLegalPourPaiement` — ce que « Choisir dans Legal » propose : le registre que la personne VOIT
 *     (`perimetreLegal`, la porte de la liste Legal), factures, BC, devis, contrats munis d'un fichier, chacun avec
 *     ce qu'on sait déjà de son usage (« déjà dans la demande PAY-… »).
 *   • `lirePourLaDemande` — ce qu'une pièce propose au formulaire : un fichier déposé est lu comme dans « Nouveau
 *     document » (Luna quand elle est ouverte) ; un document Legal donne ce que le registre sait, et son fichier,
 *     relu LOCALEMENT, ajoute le téléphone, l'e-mail et la présence d'un RIB.
 *   • `piecesDesDocumentsLegal` — à l'envoi, les documents choisis REVÉRIFIÉS (un identifiant venu d'un champ ne se
 *     croit pas sur parole) : visibles, munis d'un fichier, et une facture jamais demandée deux fois.
 *   • `joindreLesPieces` — les pièces du premier dépôt : une facture ou un devis déposés entrent au registre Legal (geste
 *     automatique, tracé, sans droit Legal), leur fournisseur passe par l'annuaire ; un document Legal choisi est
 *     RÉFÉRENCÉ (son fichier n'est pas recopié — les Finances l'ouvrent par la porte de la demande,
 *     `entity-access/ouverture-pieces.ts`).
 *
 * Hors d'un fichier « use server » : l'auteur est reçu en argument (§118.153).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const extension = (nom: string): string => (nom.split(".").pop() ?? "").toLowerCase();
const lisible = (nom: string, taille: number): boolean =>
  (FORMATS_LUS as readonly string[]).includes(extension(nom)) && taille > 0 && taille <= TAILLE_MAX_OCTETS;
const jour = (d: Date | null | undefined): string | undefined => (d ? d.toISOString().slice(0, 10) : undefined);
const nombre = (v: unknown): number | null => (v == null ? null : Number(v));

/** La porte Legal de la personne, restreinte aux natures qui justifient un paiement (hors annulés). */
async function registreVisible(user: CurrentUser) {
  const { where } = await perimetreLegal(user);
  if (!where) return null;
  return { AND: [where, { kind: { in: [...NATURES_LEGAL_PAYABLES] } }, { status: { not: "CANCELLED" as const } }] };
}

/** L'USAGE EN PAIEMENT de documents Legal : les demandes vivantes qui portent l'un de leurs fichiers, l'envoi au règlement, le règlement. */
export async function usagesDesDocumentsLegal(ids: readonly string[]): Promise<Map<string, UsageDocumentLegal>> {
  const out = new Map<string, UsageDocumentLegal>();
  if (ids.length === 0) return out;
  const [fichiers, legaux] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: [...ids] } }, select: { id: true, entityId: true } }),
    prisma.legalDocument.findMany({ where: { id: { in: [...ids] } }, select: { id: true, expenseOrderId: true, paidDate: true } }),
  ]);
  const pieces = fichiers.length
    ? await prisma.paymentPiece.findMany({
        where: { documentId: { in: fichiers.map((f) => f.id) }, request: { status: { in: [...STATUTS_DEMANDE_VIVANTE] } } },
        select: { documentId: true, request: { select: { reference: true } } },
      })
    : [];
  const legalDuFichier = new Map(fichiers.map((f) => [f.id, f.entityId]));
  for (const l of legaux) out.set(l.id, { demandes: [], envoyeAuReglement: Boolean(l.expenseOrderId), regle: Boolean(l.paidDate) });
  for (const p of pieces) {
    const u = out.get(legalDuFichier.get(p.documentId) ?? "");
    if (u && !u.demandes.includes(p.request.reference)) (u.demandes as string[]).push(p.request.reference);
  }
  return out;
}

/** CE QUE « CHOISIR DANS LEGAL » PROPOSE — les 40 plus récents, ou ceux que la recherche trouve (titre, référence, partie). */
export async function documentsLegalPourPaiement(user: CurrentUser, recherche: string | null): Promise<DocumentLegalPropose[]> {
  const visible = await registreVisible(user);
  if (!visible) return [];
  const mot = recherche?.trim().slice(0, 80);
  const lignes = await prisma.legalDocument.findMany({
    where: {
      AND: [
        visible,
        ...(mot ? [{ OR: [
          { title: { contains: mot, mode: "insensitive" as const } },
          { reference: { contains: mot, mode: "insensitive" as const } },
          { counterparty: { contains: mot, mode: "insensitive" as const } },
        ] }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: { id: true, title: true, kind: true, counterparty: true, reference: true, amount: true, startDate: true, createdAt: true },
  });
  const ids = lignes.map((l) => l.id);
  const [fichiers, usages] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { entityId: true } }),
    usagesDesDocumentsLegal(ids),
  ]);
  const compte = new Map<string, number>();
  for (const f of fichiers) compte.set(f.entityId, (compte.get(f.entityId) ?? 0) + 1);
  return lignes.filter((l) => (compte.get(l.id) ?? 0) > 0).map((l) => {
    const usage = usages.get(l.id) ?? { demandes: [], envoyeAuReglement: false, regle: false };
    const nature = natureDePieceDuLegal(l.kind);
    return {
      id: l.id, titre: l.title, nature, kind: l.kind, partie: l.counterparty, reference: l.reference,
      montant: nombre(l.amount), date: jour(l.startDate ?? l.createdAt) ?? null, fichiers: compte.get(l.id) ?? 0,
      avertissement: avertissementUsage(usage), refus: refusReutilisation(nature, l.title, usage),
    };
  });
}

/** Le téléphone, l'e-mail et le RIB imprimés — lecture LOCALE du texte (gardé par l'empreinte du fichier). */
async function identiteImprimee(userId: string, octets: Buffer, nom: string): Promise<IdentiteEmetteur | null> {
  if (!lisible(nom, octets.length)) return null;
  const lu = await lireFichierUneFois({ octets, ext: extension(nom), cloud: false, maxPages: PAGES_MAX, userId });
  if (!lu.ok) return null;
  const { groupe } = await annuaireDeLecture(userId);
  return identiteLocaleDuDevis(lu.lecture.texte, nom, groupe).identite;
}

/** CE QU'UNE PIÈCE PROPOSE AU FORMULAIRE — un fichier déposé, ou un document Legal visible. Rien n'est écrit. */
export async function lirePourLaDemande(
  user: CurrentUser,
  source: { fichier: { octets: Buffer; nom: string } } | { legalDocumentId: string },
): Promise<LecturePourDemande> {
  if ("legalDocumentId" in source) {
    const visible = await registreVisible(user);
    const doc = visible
      ? await prisma.legalDocument.findFirst({
          where: { AND: [visible, { id: source.legalDocumentId }] },
          select: { id: true, title: true, kind: true, counterparty: true, amount: true, endDate: true },
        })
      : null;
    if (!doc) return { ok: false, error: "Ce document Legal est introuvable, ou hors de votre accès." };
    const nature = natureDePieceDuLegal(doc.kind);
    const fichier = await prisma.document.findFirst({
      where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id }, orderBy: { createdAt: "asc" }, select: { name: true, fileKey: true },
    });
    const octets = fichier?.fileKey ? await readFileByKey(fichier.fileKey).catch(sansBloquer("paiement.pieces-legal.lecture", null)) : null;
    const id = octets && fichier ? await identiteImprimee(user.id, octets, fichier.name).catch(sansBloquer("paiement.pieces-legal.identite", null)) : null;
    return {
      ok: true, nature, ribLu: Boolean(id?.rib), phrase: `Repris du registre Legal : « ${doc.title} ».`,
      proposition: {
        title: doc.title, payee: doc.counterparty ?? id?.nom ?? undefined,
        amount: doc.amount != null ? String(Number(doc.amount)) : undefined,
        dueDate: nature === "INVOICE" ? jour(doc.endDate) : undefined,
        contactPhone: id?.telephone ?? undefined, contactEmail: id?.email ?? undefined,
      },
    };
  }

  const { octets, nom } = source.fichier;
  const r = await lireDocumentLegal({ user, octets, nomFichier: nom, confidentielle: false, natureImposee: null });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.lecture.prerempli;
  const nature = natureDePieceLue(p.valeurs.kind);
  const id = await identiteImprimee(user.id, octets, nom).catch(sansBloquer("paiement.pieces-legal.identite", null));
  const partieRetenue = p.partie.retenue ? p.partie.candidats.find((c) => c.id === p.partie.retenue)?.nom ?? null : null;
  return {
    ok: true, nature, ribLu: Boolean(id?.rib),
    phrase: [r.lecture.phrase, p.montantConflit].filter(Boolean).join(" "),
    proposition: {
      title: p.valeurs.title, payee: partieRetenue ?? p.partie.aCreer?.nom ?? id?.nom ?? undefined,
      amount: p.valeurs.amount, dueDate: nature === "INVOICE" ? p.valeurs.endDate : undefined,
      contactPhone: id?.telephone ?? undefined, contactEmail: id?.email ?? undefined,
    },
  };
}

/** Un fichier déposé dans le formulaire : contrôlé (format, taille) puis lu. */
export async function lireFichierPourLaDemande(user: CurrentUser, fichier: File): Promise<LecturePourDemande> {
  const invalide = validateDocumentUpload(fichier.name, fichier.size, (await getAppSettings()).maxUploadMb);
  if (invalide) return { ok: false, error: `« ${fichier.name} » : ${invalide}` };
  return lirePourLaDemande(user, { fichier: { octets: Buffer.from(await fichier.arrayBuffer()), nom: fichier.name } });
}

export interface PieceLegaleChoisie {
  legalDocumentId: string;
  titre: string;
  nature: NaturePieceDemande;
  /** Le montant au registre — le TTC d'une facture, confronté au montant demandé. */
  montant: number | null;
  documentIds: string[];
}

/** À L'ENVOI : les documents Legal choisis, revérifiés — visibles, munis d'un fichier, une facture jamais deux fois. */
export async function piecesDesDocumentsLegal(
  user: CurrentUser, ids: readonly string[],
): Promise<{ ok: true; pieces: PieceLegaleChoisie[] } | { ok: false; error: string }> {
  const uniques = [...new Set(ids.filter(Boolean))].slice(0, 10);
  if (uniques.length === 0) return { ok: true, pieces: [] };
  const visible = await registreVisible(user);
  const docs = visible
    ? await prisma.legalDocument.findMany({ where: { AND: [visible, { id: { in: uniques } }] }, select: { id: true, title: true, kind: true, amount: true } })
    : [];
  if (docs.length < uniques.length) return { ok: false, error: "Un document Legal choisi est introuvable, ou hors de votre accès : retirez-le et choisissez à nouveau." };
  const [fichiers, usages] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: uniques } }, orderBy: { createdAt: "asc" }, select: { id: true, entityId: true } }),
    usagesDesDocumentsLegal(uniques),
  ]);
  const pieces: PieceLegaleChoisie[] = [];
  for (const id of uniques) {
    const d = docs.find((x) => x.id === id)!;
    const nature = natureDePieceDuLegal(d.kind);
    const documentIds = fichiers.filter((f) => f.entityId === id).map((f) => f.id);
    if (documentIds.length === 0) return { ok: false, error: `« ${d.title} » n'a pas de fichier joint dans Legal : il ne peut pas justifier un paiement.` };
    const refus = refusReutilisation(nature, d.title, usages.get(id) ?? { demandes: [], envoyeAuReglement: false, regle: false });
    if (refus) return { ok: false, error: refus };
    pieces.push({ legalDocumentId: id, titre: d.title, nature, montant: nombre(d.amount), documentIds });
  }
  return { ok: true, pieces };
}

/**
 * UNE FACTURE OU UN DEVIS DÉPOSÉS ENTRENT AU REGISTRE LEGAL — titre, référence, total et date lus sur la pièce (lecture
 * LOCALE, gardée par l'empreinte), sens « reçue » pour une facture (la société la paie : c'est une demande de paiement),
 * le bénéficiaire en partie affichée ; le fournisseur imprimé passe par l'annuaire. `null` : rien n'est inscrit (le
 * fichier reste joint à la demande seulement).
 */
async function inscrireAuRegistre(i: {
  user: CurrentUser; file: File; octets: Buffer; nature: "INVOICE" | "QUOTE"; demande: { id: string; reference: string; companyId: string | null }; beneficiaire: string;
}): Promise<{ documentId: string; legalDocumentId: string } | null> {
  let texte = "";
  if (lisible(i.file.name, i.octets.length)) {
    const lu = await lireFichierUneFois({ octets: i.octets, ext: extension(i.file.name), cloud: false, maxPages: PAGES_MAX, userId: i.user.id });
    if (lu.ok) texte = lu.lecture.texte;
  }
  const entetes = texte ? repererEntetes(texte) : null;
  const conflit = (entetes?.conflits ?? []).some((c) => c.quoi === "TTC" || c.quoi === "NET");
  const total = conflit ? null : entetes?.totalTtc?.valeur ?? entetes?.netAPayer?.valeur ?? null;
  const reference = entetes?.numero?.valeur ?? null;
  const legal = await prisma.legalDocument.create({
    data: {
      title: titrePourLeRegistre({ nature: i.nature, reference, beneficiaire: i.beneficiaire, nomFichier: i.file.name }),
      // LA NATURE EN DUR — une facture ou un devis, jamais un BC (`centre-ecrivains.test.ts` : tout BC passe par un centre).
      ...(i.nature === "INVOICE" ? { kind: "INVOICE" as const, direction: "OUT" } : { kind: "QUOTE" as const }),
      reference, amount: total && total > 0 ? total : null,
      startDate: entetes?.date?.valeur ? new Date(`${entetes.date.valeur}T00:00:00.000Z`) : null,
      counterparty: i.beneficiaire,
      companyId: i.demande.companyId, sourceType: "PAYMENT_REQUEST", sourceId: i.demande.id,
      createdById: i.user.id, updatedById: i.user.id,
    },
    select: { id: true, title: true },
  });
  const doc = await persistUploadedDocument(i.user.id, {
    entityType: "LEGAL_DOCUMENT", entityId: legal.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: i.file, buffer: i.octets,
  });
  if (!doc.ok || !doc.documentId) {
    await prisma.legalDocument.delete({ where: { id: legal.id } }).catch(sansBloquer("paiement.pieces-legal.retrait"));
    return null;
  }
  await recordAudit({
    actorId: i.user.id, action: "CREATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: legal.id,
    summary: `Document légal « ${legal.title} » inscrit automatiquement depuis la demande de paiement ${i.demande.reference}`,
  }).catch(sansBloquer("paiement.pieces-legal.audit"));
  if (texte) {
    const { groupe } = await annuaireDeLecture(i.user.id);
    const { identite, nomDuFichierSeul } = identiteLocaleDuDevis(texte, i.file.name, groupe);
    await fournisseurDuDevisDansLAnnuaire({ userId: i.user.id, legalDocumentId: legal.id, identite, groupe, nomDuFichierSeul });
  }
  return { documentId: doc.documentId, legalDocumentId: legal.id };
}

/**
 * LES PIÈCES DU PREMIER DÉPÔT. Un échec d'enregistrement n'emporte pas la demande : un dossier créé auquel il manque une
 * pièce — visible, corrigeable — vaut mieux qu'un formulaire perdu. Rend le nombre de pièces inscrites au registre Legal.
 */
export async function joindreLesPieces(i: {
  user: CurrentUser;
  demande: { id: string; reference: string; companyId: string | null };
  beneficiaire: string;
  deposees: readonly { file: File; kind: PaymentPieceKind; note: string | null }[];
  legales: readonly PieceLegaleChoisie[];
  notesLegales: ReadonlyMap<string, string | null>;
}): Promise<{ inscrites: number }> {
  let position = 0;
  let inscrites = 0;
  for (const p of i.deposees) {
    try {
      const octets = Buffer.from(await p.file.arrayBuffer());
      const aInscrire = natureAInscrireAuLegal(p.kind);
      const auRegistre = aInscrire
        ? await inscrireAuRegistre({ user: i.user, file: p.file, octets, nature: aInscrire, demande: i.demande, beneficiaire: i.beneficiaire })
            .catch(sansBloquer("paiement.pieces-legal.inscription", null))
        : null;
      if (auRegistre) inscrites++;
      const documentId = auRegistre?.documentId ?? (await (async () => {
        const doc = await persistUploadedDocument(i.user.id, {
          entityType: "PAYMENT_REQUEST", entityId: i.demande.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: p.file, buffer: octets,
        });
        if (!doc.ok || !doc.documentId) throw new Error(doc.error ?? "Enregistrement impossible.");
        return doc.documentId;
      })());
      await prisma.paymentPiece.create({
        data: { requestId: i.demande.id, documentId, kind: p.kind, note: p.note, position: position++, createdById: i.user.id },
      });
    } catch (e) {
      console.error("[payment] pièce non enregistrée", e);
    }
  }
  // UN DOCUMENT LEGAL CHOISI : ses fichiers RÉFÉRENCÉS — le premier porte sa nature, les suivants (annexes) « autre pièce ».
  for (const l of i.legales) {
    for (const [k, documentId] of l.documentIds.entries()) {
      await prisma.paymentPiece.create({
        data: {
          requestId: i.demande.id, documentId, kind: (k === 0 ? l.nature : "OTHER") as PaymentPieceKind,
          note: k === 0 ? i.notesLegales.get(l.legalDocumentId) ?? null : `Annexe de « ${l.titre} » (Legal)`,
          position: position++, createdById: i.user.id,
        },
      }).catch(sansBloquer("paiement.pieces-legal.reference"));
    }
  }
  return { inscrites };
}
