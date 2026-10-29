import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { formatDate, formatDateTime } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { PIECE_REQUEST_STATUS, ENTITY_TYPE_LABELS } from "@/lib/labels";
import { canSubmit, canDecide, canCancel, isLate, docRequestSummary, refusReaffectation } from "@/lib/doc-request";
import { tientPourLaSollicitee } from "@/lib/doc-request-interim";
import { assistantesDeDirection } from "@/modules/ad-pro/api";
import { PIECE_KIND_LABEL, pieceKindOf } from "@/lib/legal/from-piece";
import { RespondPanel } from "./respond-panel";
import { ReaffecterPanel } from "./reaffecter-panel";

export const dynamic = "force-dynamic";

/**
 * LE FIL D'UNE DEMANDE DE PIÈCE.
 *
 * Cet écran est accessible SANS accès au module de l'objet visé : on peut réclamer une facture à
 * un collègue sans lui ouvrir tout le pôle Ad & Pro au passage. L'autorisation vient du fil —
 * on a demandé, ou on est celui à qui l'on demande.
 */
export default async function DocumentRequestPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  const req = await prisma.documentRequest.findUnique({
    where: { id: params.id },
    include: { askedBy: { select: { name: true } }, askedTo: { select: { name: true } } },
  });
  if (!req) notFound();

  // L'INTÉRIMAIRE de l'assistante sollicitée pour le BC d'un poste la remplace ici (audit Assistante de direction, 10/2026).
  const remplace = await tientPourLaSollicitee(user.id, req);
  const involved = req.askedById === user.id || req.askedToId === user.id || remplace || hasGlobalView(user.role);
  // Une demande de pièce n'est pas un objet public : celui qui n'y est pour rien n'a pas à
  // découvrir qu'on réclame une facture à quelqu'un.
  if (!involved) redirect("/pieces");

  // LE FIL CONTINUE DE MONTRER CE QUI A ÉTÉ DÉPOSÉ, MÊME APRÈS CLASSEMENT.
  //
  // Une pièce acceptée dont la nature engage la société (facture, bon de commande, devis,
  // contrat) DÉMÉNAGE vers Legal — un fichier, un seul domicile ; deux copies divergent le jour
  // où l'une est remplacée. On lit donc les documents aux DEUX adresses : sans cela, le fil
  // afficherait « aucune pièce » juste après l'acceptation, ce qui se lit comme une perte.
  const documents = await prisma.document.findMany({
    where: {
      OR: [
        { entityType: "DOCUMENT_REQUEST", entityId: req.id },
        ...(req.legalDocumentId ? [{ entityType: "LEGAL_DOCUMENT" as const, entityId: req.legalDocumentId }] : []),
      ],
    },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  const mayUpload = canSubmit(req, user.id, remplace);
  // CONFIER À UNE AUTRE ASSISTANTE : la règle de l'action (`refusReaffectation`), les seules assistantes actives.
  const reaffectable = refusReaffectation(req, { id: user.id, vueGlobale: hasGlobalView(user.role), remplace }, "") === null;
  const autresAssistantes = reaffectable ? (await assistantesDeDirection()).filter((a) => a.id !== req.askedToId) : [];

  return (
    <div className="space-y-5">
      <BackLink href="/pieces"><ArrowLeft className="h-4 w-4" /> Pièces demandées</BackLink>
      <PageHeader title={req.label} description={`Réf. ${req.reference} · ${docRequestSummary(req, user.id)}`}>
        <StatusBadge map={PIECE_REQUEST_STATUS} value={req.status} />
        {isLate(req) && <Badge tone="danger" dot={false}>en retard</Badge>}
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>La demande</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 sm:gap-x-6 [&>div]:min-w-0 [&_p]:break-words">
              <div><p className="text-xs text-muted-foreground">Demandée par</p><p className="font-medium">{req.askedBy.name}</p></div>
              <div><p className="text-xs text-muted-foreground">Demandée à</p><p className="font-medium">{req.askedTo.name}</p></div>
              <div><p className="text-xs text-muted-foreground">Le</p><p className="font-medium">{formatDate(req.createdAt.toISOString())}</p></div>
              {req.dueDate && <div><p className="text-xs text-muted-foreground">Attendue pour</p><p className="font-medium">{formatDate(req.dueDate.toISOString())}</p></div>}
              {req.submittedAt && <div><p className="text-xs text-muted-foreground">Déposée le</p><p className="font-medium">{formatDateTime(req.submittedAt.toISOString())}</p></div>}
              <div>
                <p className="text-xs text-muted-foreground">Se rattache à</p>
                <p className="font-medium">
                  {req.link ? (
                    <Link href={req.link} className="inline-flex items-center gap-1 text-primary hover:underline">
                      {ENTITY_TYPE_LABELS[req.entityType] ?? req.entityType} <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : (ENTITY_TYPE_LABELS[req.entityType] ?? req.entityType)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Nature</p>
                <p className="font-medium">{PIECE_KIND_LABEL[pieceKindOf(req.kind)]}</p>
              </div>
              {/* OÙ LA PIÈCE EST ALLÉE — le registre des engagements. Sans ce lien, on la
                  chercherait dans le Drive, puis on la redemanderait. */}
              {req.legalDocumentId && (
                <div>
                  <p className="text-xs text-muted-foreground">Enregistrée dans</p>
                  <p className="font-medium">
                    <Link href={`/legal/${req.legalDocumentId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                      Legal <ExternalLink className="h-3 w-3" />
                    </Link>
                  </p>
                </div>
              )}
              {req.note && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Précisions</p>
                  <p className="whitespace-pre-wrap">{req.note}</p>
                </div>
              )}
              {req.responseNote && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Dernier échange</p>
                  <p className="whitespace-pre-wrap">{req.responseNote}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Pièces déposées</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {mayUpload && <DocumentUpload entityType="DOCUMENT_REQUEST" entityId={req.id} />}
              <DocumentList
                documents={docItems}
                canDelete={mayUpload}
                canRename={mayUpload}
                canEdit={onlyofficeConfigured() && mayUpload}
                path={`/pieces/${req.id}`}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <RespondPanel
            id={req.id}
            canSubmit={mayUpload}
            canDecide={canDecide(req, user.id)}
            canCancel={canCancel(req, user.id)}
            attachmentCount={documents.length}
          />
          {autresAssistantes.length > 0 && <ReaffecterPanel id={req.id} assistantes={autresAssistantes} />}
        </div>
      </div>
    </div>
  );
}
