import { notFound } from "next/navigation";
import { Paperclip } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { deposantDuDocumentLegal } from "@/lib/entity-access/ouverture-pieces";
import { natureLegale } from "@/lib/labels";
import { formatCurrency, formatDate, toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentList, type DocItem } from "@/components/documents/document-list";

/**
 * LA FICHE DU DÉPOSANT (Direction, 08/11/2026) — « qui a déposé un fichier voit son fichier quand il entre dans le
 * document ».
 *
 * Elle ne s'affiche que là où la fiche complète refuse : pas de module Legal, une nature hors de sa portée, une autre
 * société, des lecteurs désignés dont il n'est pas. On montre alors le document EN LECTURE — ce qu'il est, avec qui,
 * combien, quand — et SES fichiers : tous s'il a créé le document, sinon ceux qu'il a déposés lui-même. Rien d'autre :
 * ni la chaîne des pièces liées, ni l'historique, ni les accès, ni un seul geste d'écriture. Ni créateur ni déposant :
 * 404, comme la fiche — dire qu'un document existe, c'est déjà en dire trop.
 */
export async function FicheDuDeposant({ userId, legalDocumentId }: { userId: string; legalDocumentId: string }) {
  const qui = await deposantDuDocumentLegal(userId, legalDocumentId);
  if (!qui) notFound();
  const doc = await prisma.legalDocument.findUnique({
    where: { id: legalDocumentId },
    select: { id: true, title: true, kind: true, reference: true, counterparty: true, amount: true, startDate: true, endDate: true, createdAt: true },
  });
  if (!doc) notFound();

  const fichiers = await prisma.document.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: doc.id, ...(qui === "DEPOSANT" ? { uploadedById: userId } : {}) },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const items: DocItem[] = fichiers.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));
  const montant = doc.amount != null ? formatCurrency(toNumber(doc.amount)) : null;
  const faits: [string, string | null][] = [
    ["Nature", natureLegale(String(doc.kind))],
    ["Référence", doc.reference],
    ["Autre partie", doc.counterparty],
    ["Montant", montant],
    ["Date", doc.startDate ? formatDate(doc.startDate) : formatDate(doc.createdAt)],
    ["Échéance", doc.endDate ? formatDate(doc.endDate) : null],
  ];

  return (
    <div className="space-y-5">
      <BackLink href="/">Retour</BackLink>
      <PageHeader title={doc.title} description="Document du registre Legal — en lecture" />
      <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
        {qui === "CREATEUR"
          ? "Vous voyez ce document parce que vous l'avez créé : ses fichiers sont ci-dessous. Le reste de la fiche relève du module Legal."
          : "Vous voyez ce document parce que vous y avez déposé un fichier : vos fichiers sont ci-dessous. Le reste de la fiche relève du module Legal."}
      </p>
      <Card>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-3 py-4 sm:grid-cols-3">
          {faits.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="truncate font-medium">{v}</p>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Paperclip className="h-4 w-4" /> {qui === "CREATEUR" ? "Fichiers" : "Vos fichiers"}</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0
            ? <p className="text-sm text-muted-foreground">Aucun fichier.</p>
            : <DocumentList documents={items} canDelete={false} canEdit={false} canRename={false} path={`/legal/${doc.id}`} />}
        </CardContent>
      </Card>
    </div>
  );
}
