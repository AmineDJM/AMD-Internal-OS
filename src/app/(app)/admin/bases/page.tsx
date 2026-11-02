import { redirect } from "next/navigation";
import { ArrowLeft, Database, HardDrive, FileText, FolderTree } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { countOrphanBlobs } from "@/lib/drive-storage";
import { getAppSettings } from "@/lib/settings";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { formatBytes as fmtBytes } from "@/lib/utils";
import { PurgeOrphansButton, PermanentDeleteButton } from "./database-admin";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

/**
 * Onglet « Bases de données » (Super Admin) : vue de toutes les bases de données porteuses de
 * stockage, avec la possibilité de supprimer DÉFINITIVEMENT fichiers / documents / dossiers et de
 * purger le stockage orphelin pour libérer RÉELLEMENT l'espace disque de la BDD.
 */
export default async function DatabasesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/mon-espace");

  const [
    blobAgg, chunkCount, versionAgg, storedCount,
    driveFiles, driveFolders, docAgg, extractionAgg,
    activityCount, auditCount, deletedActive,
    orphan, settings, topFiles, topDocs,
  ] = await Promise.all([
    prisma.fileBlob.aggregate({ _sum: { size: true }, _count: true }),
    prisma.fileBlobChunk.count(),
    prisma.fileVersion.aggregate({ _sum: { size: true }, _count: true }),
    prisma.storedFile.count(),
    prisma.driveNode.count({ where: { type: "FILE" } }),
    prisma.driveNode.count({ where: { type: "FOLDER" } }),
    prisma.document.aggregate({ _sum: { sizeBytes: true }, _count: true }),
    prisma.regulatoryExtraction.aggregate({ _sum: { charCount: true }, _count: true }),
    prisma.activityLog.count(),
    prisma.auditLog.count(),
    prisma.deletedRecord.count({ where: { purgedAt: null } }),
    countOrphanBlobs(),
    getAppSettings(),
    prisma.driveNode.findMany({ where: { type: "FILE" }, orderBy: { size: "desc" }, take: 20, select: { id: true, name: true, size: true, isTrashed: true, owner: { select: { name: true } } } }),
    prisma.document.findMany({ orderBy: { sizeBytes: "desc" }, take: 20, select: { id: true, name: true, sizeBytes: true, entityType: true } }),
  ]);

  const physicalBytes = blobAgg._sum.size ?? 0;
  const logicalBytes = versionAgg._sum.size ?? 0;
  const capacityBytes = settings.driveCapacityGb * 1024 ** 3;

  // Bases de données porteuses de données (avec taille quand elle est mesurable).
  const tables: { label: string; rows: number; bytes?: number; hint?: string }[] = [
    { label: "Stockage physique (blobs chiffrés, dédupliqués)", rows: blobAgg._count, bytes: physicalBytes, hint: "octets réels sur disque" },
    { label: "Tranches de gros fichiers", rows: chunkCount },
    { label: "Versions de fichiers (Drive)", rows: versionAgg._count, bytes: logicalBytes, hint: "toutes versions confondues" },
    { label: "Fichiers Drive", rows: driveFiles },
    { label: "Dossiers Drive", rows: driveFolders },
    { label: "Références de fichiers stockés", rows: storedCount },
    { label: "Documents (bibliothèques métier)", rows: docAgg._count, bytes: docAgg._sum.sizeBytes ?? 0 },
    { label: "Extractions Regulatory (texte OCR)", rows: extractionAgg._count, bytes: extractionAgg._sum.charCount ?? 0, hint: "≈ octets de texte extrait" },
    { label: "Journal d'activité", rows: activityCount },
    { label: "Journal d'audit", rows: auditCount },
    { label: "Corbeille (restaurables)", rows: deletedActive },
  ];

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Bases de données"
        description="Toutes les bases porteuses de stockage. Le Super Admin peut supprimer DÉFINITIVEMENT fichiers, documents et dossiers, et purger le stockage orphelin pour libérer réellement l'espace disque."
      />

      {/* Stockage physique + ramasse-miettes */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" /> Stockage physique</CardTitle>
          <CardDescription>
            Le contenu binaire est <strong>dédupliqué</strong> et partagé : supprimer un fichier ne libère l'espace que
            lorsque son contenu n'est plus référencé nulle part. Le <strong>ramasse-miettes</strong> détruit ces blobs
            orphelins — c'est ce qui rend réellement l'espace disque.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Physique / capacité</p>
              <p className="text-lg font-semibold">{fmtBytes(physicalBytes)} <span className="text-sm font-normal text-muted-foreground">/ {settings.driveCapacityGb} Go</span></p>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
                <div className={`h-full ${capacityBytes > 0 && physicalBytes / capacityBytes > 0.9 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${capacityBytes > 0 ? Math.min(100, (physicalBytes / capacityBytes) * 100) : 0}%` }} />
              </div>
            </div>
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Logique (toutes versions)</p>
              <p className="text-lg font-semibold">{fmtBytes(logicalBytes)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Économie de déduplication : {fmtBytes(Math.max(0, logicalBytes - physicalBytes))}</p>
            </div>
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">Récupérable (orphelins)</p>
              <p className="text-lg font-semibold text-warning">{fmtBytes(orphan.bytes)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{orphan.count} blob·s non référencés</p>
            </div>
          </div>
          <PurgeOrphansButton count={orphan.count} bytes={orphan.bytes} />
        </CardContent>
      </Card>

      {/* Liste de toutes les bases de données */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> Bases de données</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Base</TableHead>
                <TableHead className="text-right">Enregistrements</TableHead>
                <TableHead className="text-right">Taille</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map((t) => (
                <TableRow key={t.label}>
                  <TableCell data-sans-etiquette className="font-medium">{t.label}{t.hint && <span className="ml-1 text-xs font-normal text-muted-foreground">({t.hint})</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.rows.toLocaleString("fr-FR")}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{t.bytes !== undefined ? fmtBytes(t.bytes) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Plus gros fichiers Drive — suppression définitive */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FolderTree className="h-4 w-4" /> Plus gros fichiers du Drive</CardTitle>
          <CardDescription>Suppression <strong>définitive</strong> (irréversible) — libère l'espace après ramassage automatique des blobs orphelins.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fichier</TableHead>
                <TableHead>Propriétaire</TableHead>
                <TableHead className="text-right">Taille</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {topFiles.length === 0 ? (
                <TableRow><TableCell colSpan={4} data-sans-etiquette className="text-center text-sm text-muted-foreground">Aucun fichier.</TableCell></TableRow>
              ) : topFiles.map((f) => (
                <TableRow key={f.id}>
                  <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">{f.name}{f.isTrashed && <Badge tone="neutral" dot={false} className="ml-2">Corbeille</Badge>}</TableCell>
                  <TableCell className="text-muted-foreground">{f.owner?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBytes(f.size)}</TableCell>
                  <TableCell className="text-right"><PermanentDeleteButton kind="drive" id={f.id} name={f.name} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Plus gros documents — suppression définitive */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" /> Plus gros documents</CardTitle>
          <CardDescription>Documents rattachés aux objets métier. Suppression <strong>définitive</strong> (irréversible).</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Rattaché à</TableHead>
                <TableHead className="text-right">Taille</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {topDocs.length === 0 ? (
                <TableRow><TableCell colSpan={4} data-sans-etiquette className="text-center text-sm text-muted-foreground">Aucun document.</TableCell></TableRow>
              ) : topDocs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">{d.name}</TableCell>
                  <TableCell className="text-muted-foreground">{ENTITY_TYPE_LABELS[d.entityType] ?? d.entityType}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBytes(d.sizeBytes ?? 0)}</TableCell>
                  <TableCell className="text-right"><PermanentDeleteButton kind="document" id={d.id} name={d.name} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
