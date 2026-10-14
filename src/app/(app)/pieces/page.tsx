import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PIECE_REQUEST_STATUS, ENTITY_TYPE_LABELS, WORKSPACE_TABS } from "@/lib/labels";
import { isLate, isOutstanding } from "@/lib/doc-request";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";

export const dynamic = "force-dynamic";

/**
 * LES PIÈCES QU'ON ME DEMANDE, ET CELLES QUE J'ATTENDS.
 *
 * Deux listes et pas une seule : « ce que je dois déposer » appelle une action de ma part, « ce
 * que j'attends » appelle une relance. Les mélanger obligerait à trier du regard à chaque visite.
 */
export default async function PiecesPage() {
  const user = await requireUser();

  // LES BC QU'ON TIENT POUR UNE ABSENTE (audit Assistante de direction, 10/2026) : l'intérimaire de l'assistante
  // sollicitée pour le bon de commande d'un poste Ad & Pro le dépose à sa place (`ouverteALInterim`).
  const absents = await standInForUserIds(user.id);
  const [toMe, mine, pourAbsents] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { askedToId: user.id }, orderBy: { createdAt: "desc" }, take: 200,
      include: { askedBy: { select: { name: true } } },
    }),
    prisma.documentRequest.findMany({
      where: { askedById: user.id }, orderBy: { createdAt: "desc" }, take: 200,
      include: { askedTo: { select: { name: true } } },
    }),
    absents.length > 0
      ? prisma.documentRequest.findMany({
        where: { askedToId: { in: absents }, entityType: "AD_PRO_ITEM", kind: "PURCHASE_ORDER", status: { in: ["PENDING", "SUBMITTED", "DECLINED"] } },
        orderBy: { createdAt: "desc" }, take: 200,
        include: { askedTo: { select: { name: true } } },
      })
      : Promise.resolve([]),
  ]);

  const waiting = toMe.filter((r) => isOutstanding(r.status)).length;

  const Rows = ({ rows, who, label }: { rows: { id: string; reference: string; label: string; status: string; dueDate: Date | null; entityType: string; createdAt: Date }[]; who: (i: number) => string; label: string }) => (
    <div className="surface overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Référence</TableHead>
            <TableHead>Pièce demandée</TableHead>
            <TableHead>{label}</TableHead>
            <TableHead>Se rattache à</TableHead>
            <TableHead>Échéance</TableHead>
            <TableHead>État</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id} className="cursor-pointer">
              <TableCell className="font-mono text-xs"><Link href={`/pieces/${r.id}`} className="hover:underline">{r.reference}</Link></TableCell>
              <TableCell className="break-words font-medium"><Link href={`/pieces/${r.id}`} className="hover:underline">{r.label}</Link></TableCell>
              <TableCell className="text-muted-foreground">{who(i)}</TableCell>
              <TableCell className="text-muted-foreground">{ENTITY_TYPE_LABELS[r.entityType] ?? r.entityType}</TableCell>
              <TableCell className="text-muted-foreground">
                {r.dueDate ? formatDate(r.dueDate.toISOString()) : "—"}
                {isLate(r) && <Badge tone="danger" dot={false} className="ml-1.5">en retard</Badge>}
              </TableCell>
              <TableCell><StatusBadge map={PIECE_REQUEST_STATUS} value={r.status} dot={false} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pièces demandées"
        description="Ce qu'on vous demande de déposer, et ce que vous attendez des autres."
      />
      <ModuleTabs tabs={WORKSPACE_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <section className="space-y-2">
        <h2 className="flex flex-wrap items-center gap-y-1 text-sm font-semibold">
          On vous demande {waiting > 0 && <Badge tone="warning" dot={false} className="ml-1">{waiting} en attente</Badge>}
        </h2>
        {toMe.length === 0
          ? <EmptyState icon="Inbox" title="Rien à déposer" description="Personne n'attend de pièce de votre part." />
          : <Rows rows={toMe} who={(i) => toMe[i].askedBy.name} label="Demandée par" />}
      </section>

      {pourAbsents.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Pendant l&apos;absence d&apos;une collègue que vous remplacez</h2>
          <Rows rows={pourAbsents} who={(i) => `Pour ${pourAbsents[i].askedTo.name}`} label="Demandée à" />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Vous attendez</h2>
        {mine.length === 0
          ? <EmptyState icon="Send" title="Aucune demande en cours" description="Depuis un poste de dépense ou un dossier, demandez une pièce à la personne qui la détient." />
          : <Rows rows={mine} who={(i) => mine[i].askedTo.name} label="Demandée à" />}
      </section>
    </div>
  );
}
