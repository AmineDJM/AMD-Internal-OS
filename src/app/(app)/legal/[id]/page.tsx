import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip, ExternalLink } from "lucide-react";
import { requireUser } from "@/lib/session";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { PartyLink } from "@/components/directory/party-link";
import { userCan, peutVoirAdam } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { canEditCompanyId, companyScopedWhere } from "@/lib/company";
import { legalKindVisible, legalViewScope, legalWriteAllowed } from "@/lib/legal/invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApercuPieceEmise } from "@/components/legal/apercu-piece-emise";
import { StatusBadge } from "@/components/shared/status-badge";
import { BackLink } from "@/components/shared/back-link";
import { AskChief } from "@/components/shared/ask-chief";
import { realtimeVoiceConfigured, canUseRealtimeVoice } from "@/lib/assistant/voice-realtime";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { LEGAL_DOC_STATUS, LEGAL_EXPIRY_LEVEL, AUDIT_ACTION, natureLegale } from "@/lib/labels";
import { formatCurrency, formatDate, formatDateTime, toNumber } from "@/lib/utils";
import { effectiveStatus, expiryLevel, daysLeft } from "@/lib/legal/lifecycle";
import { sourceHref, sourceCaption } from "@/lib/links/source-link";
import { legalFields, dateInput } from "../legal-fields";
import { buildFolderTree, flattenFolders, indentedLabel } from "@/lib/legal/folders";
import { EditLegalButton } from "./edit-legal";
import { ComposerPieceButton } from "@/components/pieces/composer-piece";
import { letterheadContextFor } from "@/lib/queries/letterheads";
import { EmettreAvoirButton } from "./emettre-avoir";
import { RecordDeleteButton } from "@/components/shared/record-delete-button";
import { PartagerButton } from "@/components/shared/partager-button";
import { legalReaderWhere, canManageLegalReaders } from "@/lib/lecteurs/legal";
import { LegalAccessPanel } from "./access-panel";
import { loadLegalChain, piecesAmontProposees } from "@/lib/queries/legal-chain";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { valeurContractuelleCourante } from "@/lib/pch/market-math";
import { MarketContext } from "./market-context";
import { LegalChainCard } from "./chain-card";
import { EntityLinks } from "@/components/shared/entity-links";
import { linksOf, linkedViews } from "@/lib/links/store";
import { porteDuBC, origineDuBC, centreVouluDuBC } from "@/lib/bons-de-commande/aiguillage";
import { blocageParLeBC, reserveEtapeBC } from "@/lib/bons-de-commande/regle";
import { REFUS_FACTURE_EMISE_AU_REGLEMENT } from "@/lib/finances/settlement";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";
import { sitsOnValidationCentre } from "@/lib/validations/centre";
import { BonDeCommandeGate } from "./bc-gate";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { peutSignerBC } from "@/lib/queries/bons-de-commande";
import { fichiersEmis, lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { pieceDefinitive, pieceEmise, refusRevisionAval, remedePieceEmise, specRevisable, valeursComposables, type TypePieceEmise } from "@/lib/legal/piece-emise";

/** Le nom d'une pièce émise dans la phrase de succès. */
const LIBELLE_PIECE_EMISE: Record<TypePieceEmise, string> = {
  DEVIS: "Devis", BON_DE_COMMANDE: "Bon de commande", FACTURE: "Facture", AVOIR: "Avoir",
};
import { netDeLaFacture } from "@/lib/lecteurs/avoir";
import { avalActif, avoirsDeLaFacture } from "@/lib/legal/aval";

export const dynamic = "force-dynamic";

/** Les natures de pièce qu'on joint à un engagement — pas les 40 du référentiel complet. */
const LEGAL_DOC_CATEGORIES = [
  "CONVENTION", "PURCHASE_ORDER", "INVOICE", "REQUEST_LETTER",
  "SUPPORTING_DOC", "QUOTE", "DELIVERY_NOTE", "OTHER",
];

/**
 * LA FICHE D'UN ENGAGEMENT — ses dates, sa chaîne de renouvellement, ses pièces, son journal.
 *
 * Le tableau du module sert à RETROUVER (« qu'est-ce qui arrive à échéance ? ») ; la fiche sert à
 * instruire : joindre le contrat signé et ses avenants, corriger une date, et relire ce qu'il est
 * advenu du document. C'est aussi la destination des rappels d'échéance — un rappel qui ne mène
 * nulle part ne vaut rien.
 *
 * Le FICHIER de référence, lui, reste dans le Drive : Legal pointe dessus, ne le duplique pas.
 * Les pièces jointes ici sont les pièces PROPRES à l'engagement, par la table `Document` commune.
 */
export default async function LegalDocumentPage({ params, searchParams }: { params: { id: string }; searchParams?: { emis?: string } }) {
  // DEUX PORTES, ET LA SECONDE EST ÉTROITE. Legal ouvre tout le registre ; la COMPTABILITÉ n'y
  // ouvre que les FACTURES — elle venait les lire dans un écran à part, et centraliser ne devait
  // rien lui retirer. La restriction est vérifiée sur la pièce elle-même, plus bas : une porte
  // qui n'existe qu'à l'écran se contourne en tapant l'adresse.
  const user = await requireUser();
  const portee = legalViewScope({
    onLegal: userCan(user, "LEGAL", "VIEW"),
    onFinances: userCan(user, "FINANCES", "VIEW"),
    // TROISIÈME PORTE (§118.176) : le module « Bons de commande » ouvre la fiche d'un BON DE
    // COMMANDE, et d'elle seule — ce que la file demande de signer doit pouvoir se lire.
    onBonsDeCommande: userCan(user, "PURCHASE_ORDERS", "VIEW"),
  });
  if (portee === "NONE") notFound();

  // Cloisonnement par entité : deviner un identifiant n'ouvre pas les engagements d'une autre
  // société du groupe.
  const readerScope = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const doc = await prisma.legalDocument.findFirst({
    // Deux gardes, et elles se composent : l'ENTITÉ (on ne lit pas les engagements d'une autre
    // société) et les LECTEURS DÉSIGNÉS (un document restreint ne s'ouvre pas parce qu'on en
    // devine l'identifiant). Un refus rend 404, jamais « accès refusé » : dire qu'un document
    // existe, c'est déjà en dire trop.
    // LA MÊME PORTE QUE LA LISTE (`companyScopedWhere`). La fiche appliquait le filtre STRICT,
    // qui exclut les pièces SANS entité : un engagement visible au registre répondait 404 quand
    // on l'ouvrait, et ses pièces jointes avec. Deux règles pour un même document, c'est la panne.
    where: await companyScopedWhere(user.id, {
      AND: [{ id: params.id }, ...(readerScope ? [readerScope] : [])],
    }),
    include: {
      driveNode: { select: { id: true, name: true } },
      renewedFrom: { select: { id: true, title: true } },
      // Le CONTEXTE MARCHÉ : marché d'origine, contrat amendé, avenants portés.
      tender: { select: { id: true, reference: true, title: true } },
      amends: { select: { id: true, title: true } },
      amendments: {
        select: { id: true, title: true, amountDelta: true, effectiveAt: true, signedAt: true, status: true },
        orderBy: { createdAt: "asc" },
      },
      renewals: { select: { id: true, title: true, endDate: true }, orderBy: { createdAt: "desc" } },
      createdBy: { select: { name: true } },
      company: { select: { name: true, shortName: true } },
      readers: { select: { userId: true, user: { select: { name: true } } } },
    },
  });
  if (!doc) notFound();

  // La pièce est-elle DANS la portée de cette personne ? Un refus rend 404, comme les autres :
  // dire qu'un document existe, c'est déjà en dire trop.
  if (!legalKindVisible(portee, String(doc.kind))) notFound();

  const canEdit = legalWriteAllowed({
    onLegal: userCan(user, "LEGAL", "UPDATE"),
    onFinances: userCan(user, "FINANCES", "UPDATE"),
    kind: String(doc.kind),
  });
  const canUpload = userCan(user, "LEGAL", "UPLOAD") || canEdit;

  // LES ACCÈS SE GÈRENT SUR LE DOCUMENT. La règle est celle du module — le déposant et le Super
  // Admin, jamais le simple droit d'écriture : il suffirait de s'ajouter soi-même à la liste.
  const canManageAccess = canManageLegalReaders(
    { viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" },
    { createdById: doc.createdById },
  );
  // La liste des comptes n'est chargée que pour qui peut réellement s'en servir : on ne publie
  // pas l'annuaire de l'entreprise à qui ne fait que lire la fiche.
  const designables = canManageAccess
    ? (await prisma.user.findMany({
        where: { isActive: true, ...(doc.createdById ? { id: { not: doc.createdById } } : {}) },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }))
    : [];

  const [documents, history] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
  ]);

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  // « RELIER À… » — une pièce légale se tient rarement seule : elle naît d'un marché, elle est
  // exécutée par des bons, elle est couverte par une assurance, et des plis s'échangent à son
  // sujet. Le flux (`links/graph.ts`) décide de ce qui se relie ; l'écran ne propose que cela.
  const self = { type: "LEGAL_DOCUMENT" as const, id: doc.id };
  const linkViews = await linkedViews(self, await linksOf(self));

  const today = new Date();
  const status = effectiveStatus(doc, today);
  const expiry = expiryLevel(doc, today);
  const left = daysLeft(doc, today);
  const st = LEGAL_DOC_STATUS[status];
  const exp = LEGAL_EXPIRY_LEVEL[expiry];

  // Le classement se corrige depuis la fiche : constater qu'un engagement est au mauvais endroit
  // et devoir revenir à la liste pour le déplacer, c'est ne jamais le déplacer.
  const [folderRows, chainDocs, chain] = await Promise.all([
    prisma.legalFolder.findMany({ select: { id: true, name: true, parentId: true } }),
    // Les pièces amont possibles pour rattacher CE document à sa chaîne d'achat — et la pièce
    // ACTUELLE toujours, sans quoi « Enregistrer » détachait une facture d'un BC ancien (§118.168).
    // Par LA porte de la liste (`perimetreLegal`, lot D1c) : les Finances ne lisent pas les devis, le menu ne leur en
    // montre pas les titres — et la pièce actuelle qu'elles ne lisent pas garde son libellé NEUTRE (§118.168). Sans
    // porte de liste (aucune nature lisible), le menu ne propose rien.
    perimetreLegal(user).then((perimetre) => piecesAmontProposees({
      userId: user.id, readerScope: perimetre.where ?? { id: { in: [] } }, docId: doc.id, actuelId: doc.chainFromId,
    })),
    // La chaîne complète : maillons, validateurs de chacun, règlement au bout.
    loadLegalChain(doc.id, user),
  ]);
  const folderOptions = flattenFolders(buildFolderTree(folderRows)).map((n) => ({ value: n.id, label: indentedLabel(n) }));
  const chainCandidates = chainDocs;

  // La valeur COURANTE d'un contrat amendé — calculée, jamais stockée (§17-18).
  const montantInitial = doc.amount !== null ? toNumber(doc.amount) : null;
  const marketCtx = {
    kind: String(doc.kind),
    tender: doc.tender,
    amends: doc.amends,
    amendments: doc.amendments.map((a) => ({
      id: a.id, title: a.title,
      amountDelta: a.amountDelta !== null ? toNumber(a.amountDelta) : null,
      effectiveAt: a.effectiveAt, signedAt: a.signedAt, status: String(a.status),
    })),
    montantInitial,
    valeurCourante: valeurContractuelleCourante(
      montantInitial,
      doc.amendments.map((a) => ({
        amountDelta: a.amountDelta !== null ? toNumber(a.amountDelta) : null,
        status: String(a.status), effectiveAt: a.effectiveAt,
      })),
    ),
    amountDelta: doc.amountDelta !== null ? toNumber(doc.amountDelta) : null,
    effectiveAt: doc.effectiveAt,
  };

  // LA PORTE DU BON DE COMMANDE (§118.148) — lue par le MÊME lecteur que le centre et que le
  // refus d'envoi au règlement : trois lectures de « ce BC est-il validé ? » divergeraient.
  const estBC = doc.kind === "PURCHASE_ORDER";
  // Les fichiers que la FABRIQUE a produits pour cette pièce (`custom.fabrique`) — voir `fichiers-emis`.
  const emis = fichiersEmis(doc.custom);
  // UNE PIÈCE ÉMISE SE RÉVISE, ELLE NE SE RÉÉCRIT PAS (§118.194) — devis et bon de commande : même numéro,
  // nouvelle version. Le geste n'est offert qu'à qui la fabrique l'accordera — le droit d'écrire la pièce ET
  // celui d'engager sa société —, et ce qui en découle se dit AVANT le clic (§118.83).
  const emise = pieceEmise(doc.custom);
  const revisable = emise && !pieceDefinitive(emise.type) && doc.status === "ACTIVE" ? specRevisable(doc.custom) : null;
  const peutReviser = Boolean(revisable) && canEdit && (await canEditCompanyId(user.id, doc.companyId));
  const avalDeLaPiece = peutReviser && emise ? await avalActif(doc.id, emise.type) : null;
  // « MODIFIABLE DE A À Z » (Direction, 10/2026) : le composeur rouvre la pièce PRÉ-REMPLIE de sa version courante, avec la
  // papeterie Word de SA société (ou commune au groupe) — l'enregistrement est une révision (même numéro, version suivante).
  const valeursPiece = peutReviser && !avalDeLaPiece ? valeursComposables(doc.custom) : null;
  const papeterie = valeursPiece
    ? (await letterheadContextFor(user.id)).letterheads
      .filter((l) => l.kind === "word" && (l.companyId === null || l.companyId === doc.companyId))
      .map((l) => ({ id: l.id, name: l.name, companyId: l.companyId, companyLabel: l.companyLabel }))
    : [];
  // UNE FACTURE ÉMISE SE CORRIGE PAR UN AVOIR (§118.195) : ses avoirs, son NET et ce qui reste à créditer se lisent
  // ici par les mêmes lecteurs que la fabrique (qui plafonne) et que le règlement (qui encaisse le net). Le geste n'est
  // offert qu'à qui la fabrique l'accordera — le droit de créer un avoir ET celui d'engager la société.
  const factureEmise = emise?.type === "FACTURE";
  const avoirs = factureEmise ? await avoirsDeLaFacture(doc.id) : [];
  const netFacture = netDeLaFacture(doc.amount !== null ? toNumber(doc.amount) : 0, avoirs.filter((a) => a.actif).map((a) => a.montant));
  const peutEmettreAvoir = factureEmise && doc.status === "ACTIVE" && netFacture > 0
    && legalWriteAllowed({ onLegal: userCan(user, "LEGAL", "CREATE"), onFinances: userCan(user, "FINANCES", "CREATE"), kind: "CREDIT_NOTE" })
    && (await canEditCompanyId(user.id, doc.companyId));
  const lignesFacture = peutEmettreAvoir ? specRevisable(doc.custom)?.lignes ?? [] : [];
  // L'ÉTAT DE BOUT EN BOUT (§118.149) — porte, seuil, signature — par le MÊME lecteur que la file
  // des Finances et que l'action de signature : la fiche ne peut pas dire « à signer » d'un BC que
  // l'action refuserait.
  const [etatBC, origine] = estBC
    ? await Promise.all([etatDuBC(doc.id), origineDuBC(doc)])
    : [null, null];
  const porte = etatBC?.porte ?? null;
  // Le centre que désigne l'origine — la MÊME lecture que l'aiguillage, pôle du contrat compris :
  // la fiche ne peut pas annoncer le centre Ad & Pro pour un BC que la règle envoie ailleurs (§118.150).
  const centreAttendu = origine ? await centreVouluDuBC(origine) : "VALIDATION";
  const centreDeLaPorte = porte?.centre ?? centreAttendu;
  const siegeAuCentre = centreDeLaPorte === "AD_PRO" ? siegeAuCentreAdPro(user) : sitsOnValidationCentre(user);

  // « VIENT D'ÊTRE ÉMISE » (§118.209) : l'adresse du composeur porte `?emis=1`, et on n'y croit que si la pièce a
  // bien été émise il y a moins d'un quart d'heure — un favori ou un lien partagé ne doit pas annoncer « émis » d'une
  // pièce vieille d'un mois. Les réserves viennent de la pièce (papier en-tête, étape du BC), jamais de l'adresse.
  const faitsFabrique = (doc.custom as { fabrique?: { emisLe?: unknown; surPapierEnTete?: unknown } } | null)?.fabrique ?? null;
  const emisLe = typeof faitsFabrique?.emisLe === "string" ? Date.parse(faitsFabrique.emisLe) : Number.NaN;
  const emisJustement = searchParams?.emis === "1" && emise !== null && Number.isFinite(emisLe) && Date.now() - emisLe < 15 * 60 * 1000;
  const sansPapierEnTete = faitsFabrique?.surPapierEnTete === false;
  const reserveBC = etatBC ? reserveEtapeBC(etatBC.etape, etatBC.porte, etatBC.seuil) : null;

  // UNE FACTURE QUI DÉCOULE D'UN BC : pourquoi elle ne peut pas encore partir, dit AVANT le clic.
  // La phrase vient de `blocageParLeBC`, la même que le refus de l'action — elles ne peuvent pas
  // se contredire.
  const bcAmont = doc.kind === "INVOICE" && doc.chainFromId
    ? await prisma.legalDocument.findUnique({ where: { id: doc.chainFromId }, select: { id: true, kind: true, reference: true } })
    : null;
  // Une facture ÉMISE par la société se règle par son client : la fiche dit pourquoi le bouton n'est pas là, avec la
  // phrase même du refus de l'action (§118.195).
  const settleBlocked = doc.kind === "INVOICE" && doc.direction === "IN"
    ? REFUS_FACTURE_EMISE_AU_REGLEMENT
    : bcAmont?.kind === "PURCHASE_ORDER"
      ? blocageParLeBC(await porteDuBC(bcAmont.id), bcAmont.reference)
      : null;

  // L'ANNUAIRE — avec les parties DÉJÀ retenues, même retirées de l'annuaire depuis : une partie
  // à un contrat signé ne disparaît pas du contrat parce qu'on ne travaille plus avec elle.
  const partyOptions = await listPartyOptions(user.id, { includeIds: doc.counterpartyIds });
  const canCreateContact = userCan(user, "GENERAL_MEANS", "CREATE");

  const fields = legalFields({
    title: doc.title,
    reference: doc.reference ?? undefined,
    kind: doc.kind,
    counterparty: doc.counterparty ?? undefined,
    startDate: dateInput(doc.startDate),
    endDate: dateInput(doc.endDate),
    amount: doc.amount !== null ? String(toNumber(doc.amount)) : undefined,
    // LE RÈGLEMENT D'UNE FACTURE, REJOUÉ. Sans ces deux valeurs, corriger une virgule sur une
    // facture réglée EFFACERAIT sa date de paiement — et retirerait son écriture du livre au
    // passage. Un formulaire qui ne recharge pas un champ le remet à vide, en silence.
    direction: doc.direction ?? undefined,
    paidDate: dateInput(doc.paidDate),
    notes: doc.notes ?? undefined,
    folderId: doc.folderId ?? undefined,
    chainFromId: doc.chainFromId ?? undefined,
  }, "edit", [], folderOptions, chainCandidates, false,
     { options: partyOptions, canCreate: canCreateContact, selected: doc.counterpartyIds }, Boolean(emise));

  return (
    <div className="space-y-5">
      <BackLink href="/legal">
        <ArrowLeft className="h-4 w-4" /> Retour aux engagements
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={st?.tone ?? "neutral"} dot={false}>{st?.label ?? status}</Badge>
            <span className="text-xs text-muted-foreground">{natureLegale(doc.kind)}</span>
            {doc.reference && <span className="font-mono text-xs text-muted-foreground">{doc.reference}</span>}
            {doc.company && <span className="text-xs text-muted-foreground">{doc.company.shortName || doc.company.name}</span>}
            {peutVoirAdam(user) && userCan(user, "CHIEF_OF_STAFF", "VIEW") && (
              <AskChief reference={doc.reference || doc.title} call={realtimeVoiceConfigured() && canUseRealtimeVoice(user)} />
            )}
          </div>
          <h1 className="mt-1 text-xl font-semibold [overflow-wrap:anywhere] sm:text-2xl">{doc.title}</h1>
          <p className="text-sm text-muted-foreground">
            Enregistré par {doc.createdBy?.name ?? "—"} le {formatDate(doc.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          <PartagerButton
            refType="LEGAL_DOCUMENT" refId={doc.id}
            refLabel={doc.reference ? `${doc.reference} — ${doc.title}` : doc.title}
            href={`/legal/${doc.id}`}
          />
          {canEdit && (
            <EditLegalButton
              id={doc.id} fields={fields}
              note={emise ? `Pièce émise par la plateforme (${emise.numero}) : son montant, sa partie, son numéro, sa nature et ses dates viennent de son fichier et ne se corrigent pas ici — ${remedePieceEmise(emise)}` : undefined}
            />
          )}
          {/* Le déposant peut retirer son document — suppression réversible (corbeille admin).
              Un contrat effacé par erreur reste récupérable par un administrateur. */}
          <RecordDeleteButton
            kind="LEGAL_DOCUMENT" id={doc.id} name={doc.title} typeLabel="ce document"
            enabled={legalWriteAllowed({
              onLegal: userCan(user, "LEGAL", "DELETE"),
              onFinances: userCan(user, "FINANCES", "DELETE"),
              kind: String(doc.kind),
            }) || doc.createdById === user.id}
          />
        </div>
      </div>

      {/* UNE PIÈCE QU'ON VIENT D'ÉMETTRE SE MONTRE (§118.209) — « il doit s'afficher, pas juste se sauvegarder dans
          Legal et qu'on aille le rechercher ». Le composeur mène ici (`?emis=1`) : la phrase de succès, puis le PDF
          ouvert. Sur toute pièce émise, l'aperçu reste disponible, replié. */}
      {emise && emisJustement && (
        <section role="status" aria-live="polite" className="rounded-lg border border-success/50 bg-success/5 p-3 text-sm" data-piece-emise-bandeau>
          <p className="font-medium">
            {LIBELLE_PIECE_EMISE[emise.type]} {emise.numero} émis{emise.type === "FACTURE" ? "e" : ""} — le voici ci-dessous, inscrit{emise.type === "FACTURE" ? "e" : ""} au registre Legal.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {sansPapierEnTete && <li>Sans papier en-tête (mise en page neutre) : réglez le papier de la société dans Administration › Marque pour les prochaines pièces.</li>}
            {!emis.pdf && <li>Aucun PDF n&apos;a pu être produit : le Word fait foi.</li>}
            {estBC && reserveBC && <li>{reserveBC}</li>}
          </ul>
        </section>
      )}
      {emise && (emis.pdf || emis.docx) && (
        <ApercuPieceEmise
          titre={doc.title}
          pdf={emis.pdf ? lienFichierEmis(doc.id, "pdf") : null}
          word={emis.docx ? lienFichierEmis(doc.id, "docx", true) : null}
          excel={lienFichierEmis(doc.id, "xlsx", true)}
          ouvertParDefaut={searchParams?.emis === "1"}
        />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>L&apos;engagement</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              {/* LE NOM SEUL — et il s'ouvre sur le mail et le contact. */}
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Partie</p>
                <PartyLink
                  parties={partyOptions.filter((o) => doc.counterpartyIds.includes(o.id))}
                  fallback={doc.counterparty}
                  className="font-medium"
                />
              </div>
              <Info label="Début" value={doc.startDate ? formatDate(doc.startDate) : null} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Échéance</p>
                {doc.endDate ? (
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {formatDate(doc.endDate)}
                    {expiry !== "NONE" && expiry !== "SCHEDULED" && (
                      <Badge tone={exp?.tone ?? "neutral"} dot={false}>
                        {left !== null && left >= 0 ? `dans ${left} j` : "dépassée"}
                      </Badge>
                    )}
                  </p>
                ) : (
                  // SANS ÉCHÉANCE : dit explicitement, pour qu'on ne croie pas à un oubli de saisie.
                  <p className="font-medium text-muted-foreground">sans échéance</p>
                )}
              </div>
              <Info label="Montant" value={doc.amount !== null ? formatCurrency(toNumber(doc.amount)) : null} />
              <Info label="Annulé le" value={doc.cancelledAt ? formatDate(doc.cancelledAt) : null} />
              <Info label="Motif d'annulation" value={doc.cancelReason} />
              {/* D'OÙ ÇA VIENT : le chemin de retour vers la demande qui a justifié cet
                  engagement. Sans lui, le lien n'existe que dans un sens et ne sert qu'à moitié. */}
              {doc.sourceType && (
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Rattaché à</p>
                  {sourceHref(doc.sourceType, doc.sourceId) ? (
                    <Link href={sourceHref(doc.sourceType, doc.sourceId)!} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      {sourceCaption(doc.sourceType)} <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : (
                    <p className="font-medium">{sourceCaption(doc.sourceType)}</p>
                  )}
                </div>
              )}
              {doc.notes && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Notes</p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{doc.notes}</p>
                </div>
              )}
              {emis.docx || emis.pdf ? (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Pièce émise par la plateforme</p>
                  {/* LE FICHIER ÉMIS S'OUVRE SOUS LA PORTE DE LA PIÈCE (§118.152). Il vit dans le Drive
                      personnel de celui qui l'a émis : y renvoyer répondait 403 à tous les autres
                      lecteurs de la pièce — les Finances qui la signent, le centre qui la valide. */}
                  <div className="flex flex-wrap items-center gap-3">
                    {emis.pdf && (
                      <a href={lienFichierEmis(doc.id, "pdf")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                        <Paperclip className="h-3.5 w-3.5" /> PDF <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {emis.docx && (
                      <a href={lienFichierEmis(doc.id, "docx", true)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                        <Paperclip className="h-3.5 w-3.5" /> Word
                      </a>
                    )}
                    {/* « Générer le BC sur Excel » : la pièce RENDUE en classeur à formules, à la demande, sous la même porte. */}
                    {emise && (
                      <a href={lienFichierEmis(doc.id, "xlsx", true)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline" aria-label={`Générer ${emise.numero} sur Excel`}>
                        <Paperclip className="h-3.5 w-3.5" /> Excel
                      </a>
                    )}
                    {emise && <span className="text-xs text-muted-foreground">Version {emise.version}</span>}
                  </div>
                  {/* CE QUI CORRIGE UNE PIÈCE ÉMISE, À L'ENDROIT OÙ ON LA REGARDE (§118.194) : la révision pour un
                      devis ou un bon de commande ; pour une facture, la phrase qui dit pourquoi elle ne se révise pas. */}
                  {factureEmise && avoirs.length > 0 && (
                    <div className="mt-2 space-y-1 text-sm">
                      <p className="text-xs text-muted-foreground">Avoirs sur cette facture</p>
                      <ul className="space-y-0.5">
                        {avoirs.map((a) => (
                          <li key={a.id} className={a.actif ? "" : "text-muted-foreground line-through"}>
                            <Link href={`/legal/${a.id}`} className="font-medium text-primary hover:underline">{a.reference ?? "Avoir"}</Link>
                            {" "}— {formatCurrency(a.montant)}{a.actif ? "" : " (annulé)"}
                          </li>
                        ))}
                      </ul>
                      <p className="font-medium tabular-nums">Net de la facture : {formatCurrency(netFacture)}</p>
                    </div>
                  )}
                  {emise && pieceDefinitive(emise.type) && doc.status === "ACTIVE" && !peutEmettreAvoir && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {emise.type === "AVOIR"
                        ? "Un avoir émis ne se révise pas : il s'annule (motif à l'appui), puis un autre s'émet depuis la fiche de la facture."
                        : netFacture <= 0
                          ? "Facture entièrement créditée par ses avoirs."
                          // Le geste n'est pas offert ICI : on ne nomme pas un bouton que la personne n'a pas (§118.128).
                          : "Une facture émise ne se révise pas : un avoir la corrige, émis par une personne qui tient les pièces de cette société."}
                    </p>
                  )}
                  {peutEmettreAvoir && emise && (
                    <div className="mt-2">
                      <p className="mb-1 text-xs text-muted-foreground">Une facture émise ne se réécrit pas : un avoir la corrige, en totalité ou en partie, sous son propre numéro.</p>
                      <EmettreAvoirButton factureId={doc.id} numero={emise.numero} reste={formatCurrency(netFacture)} lignes={lignesFacture} />
                    </div>
                  )}
                  {peutReviser && revisable && emise && !pieceDefinitive(emise.type) && (
                    avalDeLaPiece
                      ? <p className="mt-2 text-xs text-muted-foreground">{refusRevisionAval(emise.type, avalDeLaPiece)}</p>
                      : (
                        valeursPiece && doc.companyId ? (
                          <div className="mt-2">
                            <ComposerPieceButton
                              typeInitial={emise.type} typesAutorises={[emise.type]}
                              societes={[{ id: doc.companyId, label: doc.company?.shortName || doc.company?.name || "Société émettrice" }]}
                              societeParDefaut={doc.companyId} letterheads={papeterie} peutReglerNumerotation={false}
                              amont={{ options: [], tronquees: [], fermees: [], limite: 0 }}
                              // Le nom que les refus et les avis citent déjà (« Réviser la pièce ») : un seul nom pour un seul geste.
                              declencheur={{ libelle: "Réviser la pièce" }}
                              revision={{ legalDocumentId: doc.id, numero: emise.numero, version: emise.version, valeurs: valeursPiece }}
                            />
                            <p className="mt-1 text-xs text-muted-foreground">Tout se modifie — fournisseur, lignes, prix, TVA, taxes, livraison, paiement, coordonnées imprimées : la pièce garde son numéro et passe à la version {emise.version + 1}.</p>
                          </div>
                        ) : null
                      )
                  )}
                </div>
              ) : doc.driveNode && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Pièce de référence (dans le Drive)</p>
                  {/* Le fichier vit dans le DRIVE : on y renvoie, on n'en sert pas une copie. */}
                  <Link href={`/drive/${doc.driveNode.id}`} className="inline-flex max-w-full items-center gap-1 font-medium text-primary [overflow-wrap:anywhere] hover:underline">
                    <Paperclip className="h-3.5 w-3.5" /> {doc.driveNode.name} <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* LA VALIDATION DU BC — quel centre, où il en est, et le geste qui rattrape un BC sans
              porte. Elle vient juste après l'engagement : c'est la première question qu'on pose
              sur un bon de commande avant de l'envoyer au fournisseur. */}
          {estBC && doc.status !== "CANCELLED" && (
            <BonDeCommandeGate
              documentId={doc.id} porte={porte} centreAttendu={centreAttendu}
              canAddress={canEdit} siegeAuCentre={siegeAuCentre}
              etape={etatBC?.etape ?? "HORS_CIRCUIT"} seuil={etatBC?.seuil ?? 0}
              validationRequise={etatBC?.validationRequise ?? true}
              signeLe={etatBC?.signeLe?.toISOString() ?? null} signePar={etatBC?.signePar?.name ?? null}
              renvoi={etatBC?.renvoi ? { le: etatBC.renvoi.le.toISOString(), par: etatBC.renvoi.par, note: etatBC.renvoi.note } : null}
              peutSigner={peutSignerBC(user)}
            />
          )}

          {/* QUI PEUT L'OUVRIR — dit sur la fiche, avec les noms, ET MODIFIABLE ICI. Une
              restriction invisible est une restriction dont on doute, et qu'on contourne « au cas
              où » en envoyant le fichier par mail — ce qu'elle sert précisément à éviter. Une
              restriction qu'on ne peut plus corriger a le même effet : on redépose le document. */}
          <LegalAccessPanel
            documentId={doc.id}
            createdById={doc.createdById}
            depositorName={doc.createdBy?.name ?? null}
            people={designables}
            readers={doc.readers.map((r) => ({ id: r.userId, name: r.user.name }))}
            canManage={canManageAccess}
          />

          {/* LE CONTEXTE MARCHÉ : marché d'origine, valeur courante calculée, avenants —
              le même objet que la fiche /pch, vu du côté juridique. */}
          <MarketContext ctx={marketCtx} />

          {/* LA CHAÎNE D'ACHAT : devis → BC → facture → règlement, avec les validateurs et les
              délais de chaque maillon. Elle ne s'affiche que si la pièce en fait partie. */}
          <LegalChainCard links={chain.links} settlement={chain.settlement} canSettle={canEdit} settleBlocked={settleBlocked} />

          {/* LE FIL DE L'AFFAIRE : le marché dont ce contrat est né, les bons qui l'exécutent,
              l'assurance qui le couvre, les plis échangés à son sujet. Une facture, elle, se relie
              à son BON — le contrat s'en déduit par le bon, et « quelle facture pour quel bon ? »
              garde une réponse. */}
          <EntityLinks
            self={self}
            links={linkViews}
            canEdit={canEdit}
            emptyHint="Aucun lien. Reliez cette pièce au marché dont elle est née, aux bons de commande qui l'exécutent, à l'assurance qui la couvre, ou aux courriers échangés à son sujet."
          />

          {(doc.renewedFrom || doc.renewals.length > 0) && (
            <Card>
              <CardHeader><CardTitle>Chaîne de renouvellement</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {/* Un renouvellement n'efface pas le passé : les deux bouts restent atteignables. */}
                {doc.renewedFrom && (
                  <p>
                    Prend la suite de{" "}
                    <Link href={`/legal/${doc.renewedFrom.id}`} className="font-medium hover:underline">{doc.renewedFrom.title}</Link>
                  </p>
                )}
                {doc.renewals.map((r) => (
                  <p key={r.id}>
                    Renouvelé par{" "}
                    <Link href={`/legal/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
                    {r.endDate && <span className="text-muted-foreground"> — jusqu&apos;au {formatDate(r.endDate)}</span>}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Pièces jointes
                <span className="text-sm font-normal text-muted-foreground">({documents.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {canUpload && (
                <DocumentUpload entityType="LEGAL_DOCUMENT" entityId={doc.id} categories={LEGAL_DOC_CATEGORIES} />
              )}
              <DocumentList documents={docItems} canDelete={canEdit} canEdit={canEdit} canRename={canEdit} path={`/legal/${doc.id}`} />
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Journal</CardTitle></CardHeader>
          <CardContent className="space-y-2.5 text-xs">
            {history.length === 0 ? (
              <p className="text-muted-foreground">Aucun mouvement enregistré.</p>
            ) : history.map((h) => (
              <div key={h.id} className="space-y-0.5 border-b border-border pb-2 last:border-0 last:pb-0">
                <div className="flex items-start justify-between gap-2">
                  <StatusBadge map={AUDIT_ACTION} value={h.action} dot={false} />
                  <span className="shrink-0 text-muted-foreground">{formatDateTime(h.createdAt)}</span>
                </div>
                <p className="text-muted-foreground">{h.summary ?? h.field ?? "—"}</p>
                <p className="text-muted-foreground">{h.actor?.name ?? "Système"}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium [overflow-wrap:anywhere] sm:truncate" title={value ?? undefined}>{value || "—"}</p>
    </div>
  );
}
