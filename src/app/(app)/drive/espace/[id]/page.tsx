import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, FolderOpen } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getDriveListing, getDriveSpacesForUser } from "@/lib/queries/drive";
import { canCreateInSpace } from "@/lib/drive";
import { fileTypeLabel, explorerSize } from "@/lib/drive/explorer";
import { onlyofficeConfigured, onlyofficeApiJs, onlyofficeEditable, onlyofficeTypeOuvrable } from "@/lib/onlyoffice";
import { convertConfigured } from "@/lib/office-convert";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDateTime } from "@/lib/utils";
import { UploadButton } from "../../upload-button";
import { NewFolderButton } from "../../new-folder-button";
import { NewOfficeButton } from "../../new-office-button";
import { SpaceSettingsButton } from "../../drive-space-manager";
import { DriveTable, type DriveRow } from "../../drive-table";
import { DriveCanvas } from "../../drive-canvas";
import { ExplorerNav } from "../../explorer-nav";
import { DriveToolbar } from "../../drive-toolbar";
import { DriveSearch } from "../../drive-search";
import { letterheadContextFor } from "@/lib/queries/letterheads";

export const dynamic = "force-dynamic";


export default async function DriveSpacePage(
  props: { params: Promise<{ id: string }>; searchParams: Promise<{ folder?: string; trash?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await requireModule("DRIVE");
  const spaceId = params.id;
  const folderId = searchParams.folder ?? null;
  const trash = searchParams.trash === "1";
  const listing = await getDriveListing(user, folderId, trash, spaceId);
  if (!listing || !listing.space) notFound();

  const { space } = listing;
  const base = `/drive/espace/${spaceId}`;
  const canEditHere = listing.level === "EDIT"; // gestionnaire de la catégorie (ou dossier éditable)

  // Personnes (pour partages à l'import) + données d'accès de la catégorie (pour les réglages).
  // `spaces` alimente le volet de navigation : LE MÊME que sur /drive, sans quoi entrer dans une
  // catégorie ferait disparaître la colonne de gauche — un explorateur ne la perd jamais.
  const [spaces, users, spaceRow] = await Promise.all([
    getDriveSpacesForUser(user),
    canEditHere || space.canManage
      ? prisma.user.findMany({ where: { isActive: true, id: { not: user.id } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string }[]),
    space.canManage
      ? prisma.driveSpace.findUnique({ where: { id: spaceId }, select: { id: true, name: true, icon: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true } })
      : Promise.resolve(null),
  ]);

  // La papeterie proposée à la création d'un document Office (vide si personne n'en a déposé).
  const { letterheads, companyId: letterheadCompanyId } = canEditHere
    ? await letterheadContextFor(user.id)
    : { letterheads: [], companyId: null };

  // Dossiers de destination pour « Déplacer » : ceux de CETTE catégorie (invariant préservé).
  const moveTargets = trash || !canEditHere
    ? []
    : [
        { id: "", name: "Racine (catégorie)" },
        ...(await prisma.driveNode.findMany({
          where: { type: "FOLDER", isTrashed: false, spaceId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 300,
        })),
      ];

  // Autres catégories où DÉPOSER (glisser-déposer) — celles que l'utilisateur gère, hors la courante.
  const dropCategories = trash ? [] : (await Promise.all(
    spaces.filter((s) => s.id !== spaceId).map(async (s) => ({ id: s.id, name: s.name, ok: await canCreateInSpace(user, s.id) })),
  )).filter((s) => s.ok).map((s) => ({ id: s.id, name: s.name }));

  const peutConvertir = convertConfigured() && userCan(user, "DRIVE", "CREATE");
  const officeApiJs = onlyofficeApiJs();
  const rows: DriveRow[] = listing.nodes.map((n) => {
    const isFile = n.type === "FILE";
    return {
      id: n.id,
      name: n.name,
      isFile,
      category: n.category ?? null,
      owner: n.owner?.name ?? "—",
      size: n.size,
      sizeLabel: explorerSize(n.size, isFile),
      typeLabel: fileTypeLabel(n.name, isFile),
      updatedAt: n.updatedAt.toISOString(),
      updatedLabel: formatDateTime(n.updatedAt),
      canEdit: n.canEdit,
      href: isFile ? `/drive/${n.id}` : `${base}?folder=${n.id}`,
      counts: n.counts,
      convertible: isFile && peutConvertir && onlyofficeEditable(n.name),
      office: isFile && officeApiJs !== null && onlyofficeTypeOuvrable(n.name) !== null,
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader title={trash ? `Corbeille — ${space.name}` : space.name}>
        {/* La recherche est GLOBALE, même lancée depuis une catégorie : un fichier qu'on croit
            rangé ici est souvent ailleurs — c'est justement pour cela qu'on le cherche. */}
        <DriveSearch />
        <DriveToolbar
          trashHref={trash ? base : `${base}?trash=1`}
          trashLabel={trash ? "Fichiers" : "Corbeille"}
          settings={spaceRow ? <SpaceSettingsButton space={spaceRow} users={users} canDelete={user.role === "SUPER_ADMIN"} /> : undefined}
          primary={!trash && canEditHere ? (
            <>
              {/* `spaceId` sert de repli quand on crée à la RACINE de la catégorie ; dans un
                  sous-dossier, `parentId` prime (le nouveau nœud hérite de la catégorie du parent). */}
              <NewFolderButton parentId={folderId} spaceId={spaceId} />
              <NewOfficeButton parentId={folderId} spaceId={spaceId} officeEnabled={onlyofficeConfigured()} letterheads={letterheads} companyId={letterheadCompanyId} />
              <UploadButton parentId={folderId} spaceId={spaceId} users={users} />
            </>
          ) : undefined}
        />
      </PageHeader>

      {/* Fil d'Ariane : racine de la catégorie → dossiers. Masqué à la racine — le titre le dit déjà. */}
      {!trash && listing.breadcrumb.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <Link href={base} className="inline-flex min-w-0 max-w-full items-center gap-1 py-1 text-muted-foreground hover:text-foreground">
            <FolderOpen className="h-4 w-4 shrink-0" /> <span className="truncate">{space.name}</span>
          </Link>
          {listing.breadcrumb.map((c) => (
            <span key={c.id} className="inline-flex min-w-0 max-w-full items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Link href={`${base}?folder=${c.id}`} title={c.name} className="truncate py-1 text-muted-foreground hover:text-foreground">{c.name}</Link>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-4 lg:flex-row">
        <ExplorerNav active={folderId ?? spaceId} spaces={spaces} users={users} />
        <div className="min-w-0 flex-1">
          <DriveCanvas parentId={folderId} spaceId={spaceId} canCreate={!trash && canEditHere} officeEnabled={onlyofficeConfigured()}>
            {listing.nodes.length === 0 ? (
              <EmptyState
                icon="FolderOpen"
                title={trash ? "Corbeille vide" : "Catégorie vide"}
                description={trash ? "Aucun élément supprimé." : canEditHere ? "Importez des fichiers, ou faites un clic droit ici pour créer un dossier." : "Aucun fichier n'a encore été déposé ici."}
              />
            ) : (
              <DriveTable rows={rows} moveTargets={moveTargets} trash={trash} users={canEditHere ? users : undefined} spaceId={spaceId} categories={dropCategories} folderId={folderId} ancestorIds={listing.breadcrumb.map((c) => c.id)} officeApiJs={officeApiJs} />
            )}
          </DriveCanvas>
        </div>
      </div>
    </div>
  );
}
