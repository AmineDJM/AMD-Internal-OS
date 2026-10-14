import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, House } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, canCreateDriveSpace } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getDriveListing, getDriveSpacesForUser } from "@/lib/queries/drive";
import { canCreateInSpace } from "@/lib/drive";
import { getAppSettings } from "@/lib/settings";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDateTime } from "@/lib/utils";
import { UploadButton } from "./upload-button";
import { NewFolderButton } from "./new-folder-button";
import { NewOfficeButton } from "./new-office-button";
import { CreateSpaceButton } from "./drive-space-manager";
import { DriveTable, type DriveRow } from "./drive-table";
import { DriveCanvas } from "./drive-canvas";
import { ExplorerNav } from "./explorer-nav";
import { DriveToolbar } from "./drive-toolbar";
import { QuickAccessList, type QuickRow } from "./quick-access-list";
import { DriveSearch } from "./drive-search";
import { parseView, VIEW_TITLE, fileTypeLabel, explorerSize } from "@/lib/drive/explorer";
import { getRecentFiles } from "@/lib/queries/drive-quick-access";
import { searchDrive } from "@/lib/queries/drive-search";
import { normalizeQuery, searchSummary } from "@/lib/drive/search";
import { letterheadContextFor } from "@/lib/queries/letterheads";
import { canManageLetterheads } from "@/lib/office/letterhead";
import { Stamp } from "lucide-react";


export default async function DrivePage({ searchParams }: { searchParams: { folder?: string; trash?: string; view?: string; q?: string } }) {
  const user = await requireModule("DRIVE");
  const folderId = searchParams.folder ?? null;
  const trash = searchParams.trash === "1";
  const view = parseView(searchParams.view, trash);
  const query = normalizeQuery(searchParams.q);

  // LA RECHERCHE est un MODE, pas un filtre du dossier courant : elle prend toute la page et
  // ignore `folder`. Chercher dans le dossier où l'on se trouve déjà ne sert à rien — si l'on
  // savait où regarder, on n'aurait pas ouvert la barre de recherche.
  if (query) {
    const [outcome, navSpaces] = await Promise.all([
      searchDrive(user, query),
      getDriveSpacesForUser(user),
    ]);
    const found: QuickRow[] = outcome.rows.map((r) => ({
      id: r.id, name: r.name, isFile: r.isFile, size: r.size, updatedAt: r.updatedAt,
      folderName: r.path, href: r.href,
    }));
    return (
      <div className="space-y-4">
        <PageHeader title="Recherche">
          <DriveSearch initial={query} />
        </PageHeader>
        <div className="flex flex-col gap-4 lg:flex-row">
          <ExplorerNav active="search" spaces={navSpaces} />
          <div className="min-w-0 flex-1 space-y-2">
            <QuickAccessList
              rows={found}
              showFilter={false}
              summary={searchSummary(found.length, query)}
              folderHeading="Chemin"
              emptyTitle="Aucun résultat"
              emptyHint="Essayez un autre mot du nom du fichier — la recherche ignore les accents et la casse."
            />
            {outcome.truncated && (
              <p className="text-xs text-muted-foreground">
                Tous les résultats ne sont pas affichés — précisez votre recherche.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ACCÈS RAPIDE — une liste transverse, qui ne parcourt pas l'arborescence. Elle passe par le
  // même filtre de visibilité : un raccourci ne doit jamais montrer plus que la navigation.
  if (view === "recent") {
    const [files, navSpaces] = await Promise.all([
      getRecentFiles(user),
      getDriveSpacesForUser(user),
    ]);
    const quick: QuickRow[] = files.map((f) => ({
      id: f.id, name: f.name, isFile: true, size: f.size, updatedAt: f.updatedAt,
      folderName: f.folderName, href: `/drive/${f.id}`,
    }));
    return (
      <div className="space-y-4">
        <PageHeader title={VIEW_TITLE.recent}>
          <DriveSearch />
        </PageHeader>
        <div className="flex flex-col gap-4 lg:flex-row">
          <ExplorerNav active="recent" spaces={navSpaces} />
          <div className="min-w-0 flex-1">
            <QuickAccessList
              rows={quick}
              emptyTitle="Aucun fichier récent"
              emptyHint="Les fichiers que vous ou vos collègues modifiez apparaîtront ici."
            />
          </div>
        </div>
      </div>
    );
  }

  const listing = await getDriveListing(user, folderId, trash);
  if (!listing) notFound();

  // Droit de créer/importer DANS le dossier courant (à la racine : on crée chez soi).
  const canEditHere = listing.level === "EDIT";
  const canCreate = userCan(user, "DRIVE", "CREATE") && canEditHere;
  const [settings, spaces] = await Promise.all([getAppSettings(), getDriveSpacesForUser(user)]);
  const canCreateSpace = canCreateDriveSpace(user, settings.driveSpaceCreatorRoles);
  // Catégories où l'on peut DÉPOSER (glisser-déposer) : celles que l'utilisateur gère.
  const dropCategories = trash
    ? []
    : (await Promise.all(spaces.map(async (s) => ({ id: s.id, name: s.name, ok: await canCreateInSpace(user, s.id) }))))
        .filter((s) => s.ok)
        .map((s) => ({ id: s.id, name: s.name }));
  // La papeterie proposée à la création d'un document Office (vide si personne n'en a déposé).
  const { letterheads, companyId: letterheadCompanyId } = canCreate
    ? await letterheadContextFor(user.id)
    : { letterheads: [], companyId: null };
  /**
   * LA PAPETERIE DE LA SOCIÉTÉ — elle vit dans « Direction artistique » (Transverse, 10/2026), une
   * entité par onglet. Le menu « ⋯ » du Drive n'en garde qu'un LIEN, pour qui la tient (la
   * responsabilité historique ou le module ouvert par la console) : créer un document avec en-tête
   * reste sur le bouton « Nouveau document ».
   */
  const letterheadTools = canManageLetterheads(user) || userCan(user, "ART_DIRECTION", "VIEW")
    ? [{
        key: "letterheads",
        label: "Direction artistique",
        description: "Papiers en-tête et modèles Word, Excel, PowerPoint de chaque entité.",
        icon: <Stamp className="h-4 w-4" />,
        href: "/direction-artistique",
      }]
    : [];

  // Personnes avec qui partager à l'import / ouvrir une catégorie (hors soi-même).
  const users = (canCreate || canCreateSpace)
    ? await prisma.user.findMany({ where: { isActive: true, id: { not: user.id } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  // Dossiers de destination pour « Déplacer » (Drive PERSONNEL uniquement : spaceId null).
  const moveTargets = trash
    ? []
    : [
        { id: "", name: "Racine (Drive)" },
        ...(await prisma.driveNode.findMany({
          where: {
            type: "FOLDER", isTrashed: false, spaceId: null,
            ...(user.role === "SUPER_ADMIN"
              ? {}
              : { OR: [{ ownerId: user.id }, { shares: { some: { userId: user.id, access: "EDIT" } } }] }),
          },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 300,
        })),
      ];

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
      href: isFile ? `/drive/${n.id}` : `/drive?folder=${n.id}`,
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader title={trash ? "Corbeille" : VIEW_TITLE.browse}>
        <DriveSearch />
        <DriveToolbar
          trashHref={trash ? "/drive" : "/drive?trash=1"}
          trashLabel={trash ? "Mes fichiers" : "Corbeille"}
          settings={!trash && canCreateSpace ? <CreateSpaceButton users={users} /> : undefined}
          // LA PAPETERIE VIT DANS LE MENU « ⋯ », et n'apparaît qu'à qui la tient. Elle avait un
          // écran à elle (« Bureautique ») que tout le monde voyait pour un réglage que deux
          // personnes touchent. Créer un document avec en-tête, lui, reste où il a toujours
          // été : sur le bouton « Nouveau document ».
          tools={letterheadTools}
          primary={!trash && canCreate ? (
            <>
              <NewFolderButton parentId={folderId} />
              <NewOfficeButton parentId={folderId} officeEnabled={onlyofficeConfigured()} letterheads={letterheads} companyId={letterheadCompanyId} />
              <UploadButton parentId={folderId} users={users} />
            </>
          ) : undefined}
        />
      </PageHeader>

      {/* Fil d'Ariane — la seule chose qui doive rester entre le titre et les fichiers. */}
      {!trash && listing.breadcrumb.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <Link href="/drive" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <House className="h-4 w-4" /> {VIEW_TITLE.browse}
          </Link>
          {listing.breadcrumb.map((c) => (
            <span key={c.id} className="inline-flex min-w-0 max-w-full items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Link href={`/drive?folder=${c.id}`} title={c.name} className="truncate py-1 text-muted-foreground hover:text-foreground">{c.name}</Link>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <ExplorerNav
          active={trash ? "trash" : (folderId ?? "root")}
          spaces={spaces}
         
          users={users}
        />
        <div className="min-w-0 flex-1">
          <DriveCanvas parentId={folderId} canCreate={!trash && canCreate} officeEnabled={onlyofficeConfigured()}>
            {listing.nodes.length === 0 ? (
              <EmptyState icon="FolderOpen" title={trash ? "Corbeille vide" : "Dossier vide"} description={trash ? "Aucun élément supprimé." : "Importez des fichiers, ou faites un clic droit ici pour créer un dossier."} />
            ) : (
              <DriveTable rows={rows} moveTargets={moveTargets} trash={trash} users={canCreate ? users : undefined} spaceId={null} categories={dropCategories} folderId={folderId} ancestorIds={listing.breadcrumb.map((c) => c.id)} />
            )}
          </DriveCanvas>
        </div>
      </div>
    </div>
  );
}
