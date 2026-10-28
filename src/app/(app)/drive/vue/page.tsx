import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, canViewDrive, fileKind } from "@/lib/drive";
import { onlyofficeConfigured, onlyofficeEditable } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { DocumentWorkspace, type OpenDoc } from "./workspace";

export const dynamic = "force-dynamic";

/** Au-delà, les onglets deviennent illisibles et la page met une éternité à s'ouvrir. */
const MAX_OPEN = 8;

/**
 * OUVRIR PLUSIEURS DOCUMENTS À LA FOIS — `/drive/vue?ids=a,b,c`.
 *
 * Chaque identifiant passe par la MÊME résolution d'accès que le Drive : ouvrir huit fichiers d'un
 * coup ne doit rien montrer de plus qu'en les ouvrant un par un. Ce qui n'est pas visible est
 * silencieusement écarté — annoncer « 3 documents refusés » apprendrait déjà quelque chose.
 */
export default async function DriveMultiViewPage(props: { searchParams: Promise<{ ids?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("DRIVE");
  const ids = (searchParams.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_OPEN);

  const officeEnabled = onlyofficeConfigured();
  const docs: OpenDoc[] = [];
  for (const id of ids) {
    const access = await resolveDriveAccess(user, id);
    if (!canViewDrive(access)) continue;
    const node = await prisma.driveNode.findUnique({
      where: { id }, select: { id: true, name: true, mimeType: true, type: true, isTrashed: true },
    });
    if (!node || node.type !== "FILE" || node.isTrashed) continue;
    docs.push({
      id: node.id,
      name: node.name,
      kind: fileKind(node.mimeType, node.name),
      canEdit: access === "EDIT",
      editable: onlyofficeEditable(node.name),
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader title={docs.length > 1 ? `${docs.length} documents ouverts` : docs[0]?.name ?? "Documents"}>
        <Link
          href="/drive"
          className="inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary"
        >
          <ArrowLeft className="h-4 w-4" /> Drive
        </Link>
      </PageHeader>

      {docs.length === 0 ? (
        <EmptyState
          icon="FileText"
          title="Aucun document à ouvrir"
          description="Sélectionnez un ou plusieurs fichiers dans le Drive, puis « Ouvrir »."
        />
      ) : (
        <DocumentWorkspace docs={docs} officeEnabled={officeEnabled} />
      )}
    </div>
  );
}
