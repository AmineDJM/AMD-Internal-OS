import { notFound, redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess } from "@/lib/drive";
import { voitLaCategorie } from "@/lib/queries/drive";
import { fileTypeLabel, explorerSize } from "@/lib/drive/explorer";
import { dossierDuFichier } from "@/lib/drive/menu-fichier";
import { onlyofficeConfigured, onlyofficeEditable, onlyofficeTypeOuvrable } from "@/lib/onlyoffice";
import { sessionEditeur, RAISON_EDITEUR } from "@/lib/onlyoffice-session";
import { convertConfigured } from "@/lib/office-convert";
import { getFieldDefs } from "@/lib/custom-fields";
import { CustomFieldsCard } from "@/components/shared/custom-fields-card";
import type { SessionPrete } from "@/components/documents/editeur-en-ligne";
import { formatDateTime } from "@/lib/utils";
import { FichierOuvert } from "./fichier-ouvert";

export const dynamic = "force-dynamic";

/**
 * OUVRIR UN FICHIER DU DRIVE — la page ne lit que ce qui s'affiche.
 *
 * Mesuré avant la refonte (10/2026) : la page chargeait d'avance les partages, vingt versions, tout le fil de
 * commentaires, les champs personnalisés et la liste de TOUS les utilisateurs ; puis, une fois affichée, le
 * navigateur redemandait la configuration de l'éditeur (`/api/onlyoffice/session`) — un aller-retour de plus
 * avant même de charger l'éditeur. Désormais :
 *   • une lecture du fichier (nom, taille, dates, propriétaire, trois COMPTEURS, dernière version) ;
 *   • la configuration de l'éditeur construite ICI, avec ces mêmes valeurs (`sessionEditeur` ne relit rien) ;
 *   • partages, versions et commentaires se lisent à l'ouverture de LEUR panneau.
 */
export default async function DriveFilePage({ params }: { params: { id: string } }) {
  const user = await requireModule("DRIVE");
  const level = await resolveDriveAccess(user, params.id);
  if (level === "NONE") notFound();

  const node = await prisma.driveNode.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, type: true, size: true, parentId: true, spaceId: true, updatedAt: true, custom: true,
      owner: { select: { name: true } },
      _count: { select: { shares: true, comments: true, versions: true } },
      versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
    },
  });
  if (!node) notFound();
  // Un dossier d'une catégorie qu'on ne voit pas (partagé, ou joint à un message) s'ouvre dans « Drive ».
  if (node.type === "FOLDER") redirect(node.spaceId && (await voitLaCategorie(user, node.spaceId)) ? `/drive/espace/${node.spaceId}?folder=${node.id}` : `/drive?folder=${node.id}`);

  const canEdit = level === "EDIT";
  const ouvrable = onlyofficeConfigured() && onlyofficeTypeOuvrable(node.name) !== null;
  const [setup, fieldDefs] = await Promise.all([
    ouvrable
      ? sessionEditeur(user, { type: "drive", id: node.id }, { acces: level, nom: node.name, estFichier: true, version: node.versions[0]?.version ?? null })
      : Promise.resolve(null),
    getFieldDefs("DRIVE_NODE"),
  ]);
  // Un format Office sans éditeur joignable : on le dit tout de suite, sans que le navigateur redemande.
  const session: SessionPrete | undefined = setup
    ? (setup.ok ? { apiJs: setup.apiJs, config: setup.config, mode: setup.mode } : { error: RAISON_EDITEUR[setup.reason] })
    : onlyofficeTypeOuvrable(node.name) !== null ? { error: RAISON_EDITEUR["not-configured"] } : undefined;

  const champs = fieldDefs.length > 0 ? (
    <CustomFieldsCard
      entityType="DRIVE_NODE"
      entityId={node.id}
      defs={fieldDefs.map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }))}
      values={(node.custom as Record<string, unknown>) ?? {}}
      canEdit={canEdit}
    />
  ) : undefined;

  return (
    <FichierOuvert
      id={node.id}
      name={node.name}
      retour={dossierDuFichier(node)}
      canEdit={canEdit}
      owner={node.owner?.name ?? "—"}
      infos={{ sizeLabel: explorerSize(node.size, true), typeLabel: fileTypeLabel(node.name, true), updatedLabel: formatDateTime(node.updatedAt) }}
      counts={node._count}
      convertible={convertConfigured() && onlyofficeEditable(node.name) && userCan(user, "DRIVE", "CREATE")}
      session={session}
      champs={champs}
    />
  );
}
