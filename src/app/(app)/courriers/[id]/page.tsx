import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip, ExternalLink } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { PartyLink } from "@/components/directory/party-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { BackLink } from "@/components/shared/back-link";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { MAIL_DIRECTION, AUDIT_ACTION } from "@/lib/labels";
import { formatDate, formatDateTime } from "@/lib/utils";
import { renderTraceValue } from "@/lib/mail-register/trace";
import { sourceHref, sourceCaption } from "@/lib/links/source-link";
import { mailFields, dateInput, dateTimeInput } from "../mail-fields";
import { buildFolderTree, flattenFolders, indentedLabel } from "@/lib/legal/folders";
import { EditMailButton } from "./edit-mail";
import { RecordDeleteButton } from "@/components/shared/record-delete-button";
import { PartagerButton } from "@/components/shared/partager-button";
import { MailPieces } from "./mail-pieces";
import { EntityLinks } from "@/components/shared/entity-links";
import { linksOf, linkedViews } from "@/lib/links/store";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { mailRoutingOptions } from "@/lib/queries/mail-routing";

export const dynamic = "force-dynamic";

/** Les natures de pièce qu'on joint à un pli — pas les 40 du référentiel complet. */
const MAIL_DOC_CATEGORIES = [
  "REQUEST_LETTER", "CONVENTION", "INVOICE", "PURCHASE_ORDER",
  "SUPPORTING_DOC", "QUOTE", "DELIVERY_NOTE", "PHOTO", "OTHER",
];

/**
 * LA FICHE D'UN COURRIER — le pli, ses pièces, et son journal.
 *
 * Le tableau du registre sert à RETROUVER ; la fiche sert à travailler dessus : y joindre le
 * scan du pli et l'accusé signé, corriger une date qu'on avait notée de mémoire, et relire qui
 * a corrigé quoi. Les trois vont ensemble — une correction sans trace, sur un registre qu'on
 * oppose (« le pli est bien parti le 12 »), ne vaudrait rien.
 *
 * Les pièces passent par la table `Document` commune : même stockage, même contrôle d'accès,
 * même réplication dans le Drive de celui qui importe, et même journalisation que partout.
 */
export default async function MailEntryPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("MAIL_REGISTER");

  // LE CLOISONNEMENT S'APPLIQUE ICI AUSSI — deviner un identifiant ne doit pas ouvrir le
  // registre d'une autre société du groupe. Mais par la MÊME porte que la liste
  // (`companyScopedWhere`), et c'est tout le sujet : la fiche appliquait le filtre STRICT, qui
  // exclut les plis sans entité, pendant que la liste les gardait. Un courrier enregistré sans
  // entité s'affichait donc au registre et répondait 404 quand on l'ouvrait — avec ses pièces
  // jointes devenues inatteignables. Deux règles pour un même pli, c'était la panne.
  const entry = await prisma.mailEntry.findFirst({
    where: await companyScopedWhere(user.id, { id: params.id }),
    include: {
      createdBy: { select: { name: true } },
      company: { select: { name: true, shortName: true } },
      driveNode: { select: { id: true, name: true } },
      department: { select: { name: true } },
      concernedUser: { select: { name: true } },
      // LES PIÈCES NOMINATIVES : un même pli part souvent à plusieurs endroits, et c'est « qui a
      // reçu quoi » qu'on vient chercher ici des mois plus tard.
      pieces: {
        orderBy: { createdAt: "asc" },
        include: { driveNode: { select: { name: true } } },
      },
    },
  });
  if (!entry) notFound();

  const canEdit = userCan(user, "MAIL_REGISTER", "UPDATE");
  const canDelete = userCan(user, "MAIL_REGISTER", "DELETE");
  const canUpload = userCan(user, "MAIL_REGISTER", "UPLOAD") || canEdit;

  const [documents, history] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "MAIL_ENTRY", entityId: entry.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "MAIL_ENTRY", entityId: entry.id },
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

  // Les mêmes menus qu'à la création : une entité ou un partenaire qu'on ne peut pas corriger
  // sur la fiche, c'est une erreur de saisie qui reste au registre pour toujours.
  const [myCompanies, partners, routing, folderRows] = await Promise.all([
    getMyCompanies(user.id),
    prisma.mailPartner.findMany({ where: { isActive: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } }),
    mailRoutingOptions(),
    prisma.mailEntryFolder.findMany({ select: { id: true, name: true, parentId: true, companyId: true } }),
  ]);
  const folderOptions = flattenFolders(buildFolderTree(folderRows)).map((n) => ({ value: n.id, label: indentedLabel(n) }));

  // « RELIER À… » — la carte partagée : le flux décide des natures proposées, le registre
  // commun porte les liens, et l'accès est REVÉRIFIÉ à l'écriture. Un pli parle de tout : c'est
  // la seule nature sans contrainte de flux.
  const self = { type: "MAIL_ENTRY" as const, id: entry.id };
  const linkViews = await linkedViews(self, await linksOf(self));

  // L'ANNUAIRE — avec l'expéditeur et le destinataire DÉJÀ retenus, même retirés depuis.
  const partyOptions = await listPartyOptions(user.id, {
    includeIds: [entry.senderContactId, entry.recipientContactId].filter((x): x is string => Boolean(x)),
  });
  const canCreateContact = userCan(user, "GENERAL_MEANS", "CREATE");

  const dir = MAIL_DIRECTION[entry.direction];
  const fields = mailFields({
    title: entry.title,
    direction: entry.direction,
    reference: entry.reference ?? undefined,
    sender: entry.sender ?? undefined,
    recipient: entry.recipient ?? undefined,
    sentAt: dateTimeInput(entry.sentAt),
    receivedAt: dateInput(entry.receivedAt),
    acknowledgedAt: dateInput(entry.acknowledgedAt),
    carrier: entry.carrier ?? undefined,
    notes: entry.notes ?? undefined,
    companyId: entry.companyId ?? undefined,
    partnerId: entry.partnerId ?? undefined,
    departmentId: entry.departmentId ?? undefined,
    concernedUserId: entry.concernedUserId ?? undefined,
    folderId: entry.folderId ?? undefined,
  }, "edit",
    myCompanies.map((c) => ({ value: c.id, label: companyLabel(c) })),
    partners.map((x) => ({ value: x.id, label: x.kind ? `${x.name} — ${x.kind}` : x.name })),
    routing.departments,
    routing.people,
    folderOptions,
    {
      options: partyOptions, canCreate: canCreateContact,
      selected: {
        sender: entry.senderContactId ? [entry.senderContactId] : [],
        recipient: entry.recipientContactId ? [entry.recipientContactId] : [],
      },
    },
  );

  return (
    <div className="space-y-5">
      <BackLink href="/courriers">
        <ArrowLeft className="h-4 w-4" /> Retour au registre
      </BackLink>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={dir?.tone ?? "neutral"} dot={false}>{dir?.label ?? entry.direction}</Badge>
            {entry.reference && <span className="font-mono text-xs text-muted-foreground">{entry.reference}</span>}
            {entry.company && (
              <span className="text-xs text-muted-foreground">{entry.company.shortName || entry.company.name}</span>
            )}
          </div>
          <h1 className="mt-1 text-xl font-semibold [overflow-wrap:anywhere] sm:text-2xl">{entry.title}</h1>
          <p className="text-sm text-muted-foreground">
            Enregistré par {entry.createdBy?.name ?? "—"} le {formatDate(entry.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          <PartagerButton
            refType="MAIL_ENTRY" refId={entry.id}
            refLabel={entry.reference ? `${entry.reference} — ${entry.title}` : entry.title}
            href={`/courriers/${entry.id}`}
          />
          {canEdit && <EditMailButton id={entry.id} fields={fields} />}
          {/* Le CRÉATEUR d'un pli peut le retirer, même sans le droit `DELETE` du registre —
              suppression réversible (corbeille de l'administrateur). Ceux qui ont le droit
              `DELETE` l'ont aussi, pour ranger les plis d'autrui. */}
          <RecordDeleteButton
            kind="MAIL_ENTRY" id={entry.id} name={entry.title} typeLabel="ce courrier"
            enabled={canDelete || entry.createdById === user.id}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Le pli</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              {/* LE NOM SEUL — et il s'ouvre sur le mail et le contact. */}
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Expéditeur</p>
                <PartyLink parties={partyOptions.filter((o) => o.id === entry.senderContactId)} fallback={entry.sender} className="font-medium" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Destinataire</p>
                <PartyLink parties={partyOptions.filter((o) => o.id === entry.recipientContactId)} fallback={entry.recipient} className="font-medium" />
              </div>
              {/* À QUI LE PLI S'ADRESSE EN INTERNE — la question qu'on pose au registre le plus
                  souvent (« qui devait traiter ça ? »). Les deux se cumulent et sont facultatives :
                  un contrat vise la Direction Générale ET son directeur, une convocation une seule
                  personne, une mise en demeure un seul service. */}
              <Info label="Direction concernée" value={entry.department?.name} />
              <Info label="Personne concernée" value={entry.concernedUser?.name} />
              <Info label="Porteur" value={entry.carrier} />
              {/* Le départ garde son HEURE : deux plis du même jour ne partent pas ensemble. */}
              <Info label="Départ" value={entry.sentAt ? formatDateTime(entry.sentAt) : null} />
              <Info label="Arrivée" value={entry.receivedAt ? formatDate(entry.receivedAt) : null} />
              <Info label="Accusé de réception" value={entry.acknowledgedAt ? formatDate(entry.acknowledgedAt) : null} />
              {/* D'OÙ ÇA VIENT : le chemin de retour vers l'affaire qui a motivé ce pli. */}
              {entry.sourceType && (
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Rattaché à</p>
                  {sourceHref(entry.sourceType, entry.sourceId) ? (
                    <Link href={sourceHref(entry.sourceType, entry.sourceId)!} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      {sourceCaption(entry.sourceType)} <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : (
                    <p className="font-medium">{sourceCaption(entry.sourceType)}</p>
                  )}
                </div>
              )}
              {/* LE FICHIER DU DRIVE, RÉFÉRENCÉ — associé à la création ou depuis le Drive. Il n'a
                  pas été recopié : on renvoie vers lui, et c'est sa version courante qui fait foi. */}
              {entry.driveNode && (
                <div className="col-span-2 min-w-0 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Pièce de référence (dans le Drive)</p>
                  <Link href={`/drive/${entry.driveNode.id}`} className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline">
                    <Paperclip className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{entry.driveNode.name}</span> <ExternalLink className="h-3 w-3 shrink-0" />
                  </Link>
                </div>
              )}
              {entry.notes && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">Notes</p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <EntityLinks
            self={self}
            links={linkViews}
            canEdit={canEdit}
            emptyHint="Aucun lien. Reliez ce pli aux affaires qu'il concerne (marché, contrat, bon de commande, facture, dossier) — elles l'afficheront dans leur fiche."
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Pièces jointes
                <span className="text-sm font-normal text-muted-foreground">({documents.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {canUpload && (
                <DocumentUpload entityType="MAIL_ENTRY" entityId={entry.id} categories={MAIL_DOC_CATEGORIES} />
              )}
              <DocumentList documents={docItems} canDelete={canEdit} canEdit={canEdit} canRename={canEdit} path={`/courriers/${entry.id}`} />
            </CardContent>
          </Card>

          {/* LES PIÈCES NOMINATIVES — au-dessous des pièces jointes, parce qu'elles s'y appuient :
              on joint d'abord, on affecte ensuite à qui de droit. */}
          <MailPieces
            entryId={entry.id}
            canEdit={canEdit}
            pieces={entry.pieces.map((p) => ({
              id: p.id, label: p.label, recipient: p.recipient, notes: p.notes,
              documentId: p.documentId, driveNodeId: p.driveNodeId,
              driveName: p.driveNode?.name ?? null,
            }))}
          />
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
                {/* Le champ touché et ses deux valeurs : c'est ce qui distingue un journal utile
                    d'un « courrier modifié » qui ne répond à aucune question. */}
                {h.field ? (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">{h.field}</span>{" : "}
                    {renderTraceValue(h.oldValue)} → <span className="text-foreground">{renderTraceValue(h.newValue)}</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">{h.summary ?? "—"}</p>
                )}
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
