import Link from "next/link";
import type { ConsultingBilling, ConsultingStatus } from "@prisma/client";
import { toNumber, formatCurrency, formatDate } from "@/lib/utils";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CONSULTING_STATUS, CONSULTING_BILLING } from "@/lib/labels";
import { billingSuffix, isOverdue } from "@/modules/ad-pro/partage";

/**
 * LA LISTE DES CONTRATS DE CONSULTING — une seule, pour les deux pôles (§118.150).
 *
 * Ad & Pro › Consulting et RH › Consultants montent la MÊME table : deux rendus de la même ligne
 * finiraient par la montrer autrement — le terme dépassé signalé ici et pas là, une rémunération
 * mensuelle lue comme un forfait d'un côté (§118.5). La fiche, elle aussi, est commune
 * (`/consulting/[id]`) : c'est le même contrat, quelle que soit la maison qui le suit.
 */
export interface LigneContrat {
  id: string;
  reference: string;
  title: string;
  counterparty: string;
  company: { name: string } | null;
  startDate: Date | null;
  endDate: Date | null;
  /** Le `Decimal` de Prisma, tel qu'il sort de la base — converti ici, une fois. */
  amount: unknown;
  billing: ConsultingBilling;
  status: ConsultingStatus;
  tasks: { doneAt: Date | null }[];
}

export function ContractsTable({ contracts }: { contracts: LigneContrat[] }) {
  return (
    <div className="surface overflow-hidden p-0">
      {/* Au téléphone, chaque contrat devient une carte : chaque cellule n'a qu'UN enfant, pour que
          l'intitulé reste à gauche et la valeur (avec ses compléments) à droite. */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Référence</TableHead>
            <TableHead>Contrat</TableHead>
            <TableHead>Consultant / cabinet</TableHead>
            <TableHead>Période</TableHead>
            <TableHead className="text-right">Rémunération</TableHead>
            <TableHead>Livrables</TableHead>
            <TableHead>Statut</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contracts.map((c) => {
            const amount = c.amount == null ? null : toNumber(c.amount);
            const done = c.tasks.filter((t) => t.doneAt).length;
            return (
              <TableRow key={c.id} className="cursor-pointer">
                <TableCell className="font-mono text-xs">
                  <Link href={`/consulting/${c.id}`} className="hover:underline">{c.reference}</Link>
                </TableCell>
                <TableCell className="font-medium">
                  <div className="min-w-0">
                    <Link href={`/consulting/${c.id}`} className="break-words hover:underline">{c.title}</Link>
                    {c.company && <div className="mt-0.5 text-xs text-muted-foreground">{c.company.name}</div>}
                  </div>
                </TableCell>
                <TableCell><span className="break-words">{c.counterparty}</span></TableCell>
                <TableCell className="text-muted-foreground">
                  <div>
                    {c.startDate ? formatDate(c.startDate.toISOString()) : "—"}
                    {c.endDate ? ` → ${formatDate(c.endDate.toISOString())}` : ""}
                    {isOverdue(c) && <Badge tone="danger" dot={false} className="ml-1.5">terme dépassé</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div>
                    {amount != null ? `${formatCurrency(amount)}${billingSuffix(c.billing)}` : "—"}
                    {amount != null && c.billing !== "ONE_OFF" && (
                      <div className="text-[0.6875rem] text-muted-foreground">{CONSULTING_BILLING[c.billing]}</div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.tasks.length > 0 ? `${done}/${c.tasks.length}` : "—"}
                </TableCell>
                <TableCell><StatusBadge map={CONSULTING_STATUS} value={c.status} dot={false} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
