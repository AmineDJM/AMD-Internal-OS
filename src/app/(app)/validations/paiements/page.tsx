import Link from "next/link";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { KpiCard } from "@/components/shared/kpi-card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_REQUEST_STATUS, PAYMENT_URGENCY } from "@/lib/labels";
import {
  sortByPriority, isOverdue, deadlineLabel, isWithFinance, isCompanionDossier, deadlineNatureLabel,
  deadlineNatureOf, groupByEntity, unassignedWarning,
} from "@/modules/finances/partage";
import { NewPaymentButton } from "./new-payment-button";
import { getMyCompanies } from "@/lib/company";
import { myPaymentRequests } from "@/modules/finances/api";

export const dynamic = "force-dynamic";

/**
 * LA FILE DES DEMANDES DE PAIEMENT — dans les Demandes de validations, là où on les DÉPOSE.
 *
 * Une demande de paiement est une DEMANDE : elle se dépose là où l'on dépose ses demandes.
 * Les Finances, elles, la retrouvent depuis LEUR module, où elles instruisent — c'est leur
 * travail, pas leur boîte de réception. Le même écran sert donc les deux, et la section « À
 * instruire » n'apparaît qu'à ceux qui instruisent.
 *
 * Deux listes : ce que j'ai demandé, et — pour les Finances — ce qui attend leur instruction.
 * L'ordre n'est PAS chronologique : un tri par date de création enterre l'urgence de ce matin
 * sous les dossiers du mois dernier. On classe par échéance réelle (`sortByPriority`).
 *
 * ⚠️ La porte n'est PAS le module Finances, et ce n'est pas un oubli. N'importe qui peut avoir
 * à faire payer une facture — la Direction Marketing, une assistante, un délégué — sans avoir la
 * moindre raison de voir le grand livre ou la trésorerie. L'écran est donc gardé par le CERCLE
 * du dossier : chacun voit ses propres demandes, les Finances voient la file à instruire, et
 * rien d'autre ne s'affiche. Exiger le module aurait rendu l'écran invisible à ceux-là mêmes
 * qui doivent y déposer leurs dossiers.
 */
export default async function PaymentRequestsPage() {
  const user = await requireUser();
  const finance = userCan(user, "FINANCES", "VALIDATE") || userCan(user, "FINANCES", "UPDATE")
    || user.role === "FINANCE_BUDGET_MANAGER" || hasGlobalView(user.role);

  const [mine, queue] = await Promise.all([
    // LA MÊME LISTE QUE L'ÉCRAN DES VALIDATIONS — une seule définition de « mes demandes ».
    // Deux requêtes auraient fini par diverger, et une demande visible ici serait absente là.
    myPaymentRequests(user.id),
    finance
      ? prisma.paymentRequest.findMany({
          // ── LES COMPAGNONS NE S'INSTRUISENT PAS ICI ────────────────────────────────────────
          //
          // Depuis que TOUT ordre de dépense ouvre son dossier, les paiements nés ailleurs
          // (matériel promotionnel, bon de versement, sponsoring…) ont eux aussi un dossier. Mais
          // ils ne s'instruisent pas : leur circuit d'origine a validé, le centre a autorisé, et
          // les Finances les règlent dans « Banque & paiements ». Les faire remonter ici aurait
          // demandé de les instruire une SECONDE fois — deux files pour le même argent, et un
          // « à instruire » qui ne veut plus rien dire.
          where: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD"] }, origin: "REQUEST" },
          orderBy: { createdAt: "desc" }, take: 200,
        })
      : Promise.resolve([] as never[]),
  ]);

  // L'ENTITÉ EST LA COLONNE VERTÉBRALE DE L'ARGENT : le formulaire la propose et l'exige, la
  // file la RANGE. Un total qui mélange deux sociétés n'appartient à aucune des deux.
  const mesEntites = await getMyCompanies(user.id);
  const entityLabels = Object.fromEntries(mesEntites.map((c) => [c.id, c.shortName || c.name]));

  const names = new Map(
    (await prisma.user.findMany({
      where: { id: { in: [...new Set(queue.map((q) => q.requesterId))] } },
      select: { id: true, name: true },
    })).map((u) => [u.id, u.name]),
  );

  const Rows = ({ rows, who }: { rows: typeof mine; who?: (id: string) => string }) => (
    <div className="surface overflow-x-auto p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Référence</TableHead>
            <TableHead>Objet</TableHead>
            <TableHead>Bénéficiaire</TableHead>
            {who && <TableHead>Demandeur</TableHead>}
            <TableHead className="text-right">Montant</TableHead>
            <TableHead>Échéance</TableHead>
            <TableHead>État</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortByPriority(rows).map((r) => (
            <TableRow key={r.id} className="cursor-pointer">
              <TableCell className="font-mono text-xs">
                <Link href={`/validations/paiements/${r.id}`} className="hover:underline">{r.reference}</Link>
              </TableCell>
              <TableCell className="font-medium [overflow-wrap:anywhere]">
                <Link href={`/validations/paiements/${r.id}`} className="hover:underline">{r.title}</Link>
                {/* CE DOSSIER VIENT D'AILLEURS — il accompagne un ordre né d'un autre circuit.
                    Le dire évite de chercher un « bon à payer » qui n'existe pas ici. */}
                {isCompanionDossier(r.origin) && (
                  <span className="block text-xs font-normal text-muted-foreground">accompagne un ordre de dépense</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{r.payee}</TableCell>
              {who && <TableCell className="text-muted-foreground">{who(r.requesterId)}</TableCell>}
              <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums sm:font-normal">{formatCurrency(toNumber(r.amount))}</TableCell>
              <TableCell className="text-muted-foreground">
                {deadlineLabel(r, PAYMENT_URGENCY)}
                {isOverdue(r) && <Badge tone="danger" dot={false} className="ml-1.5">en retard</Badge>}
                {/* Une date sans sa nature ne dit qu'à moitié — et c'est la nature qui classe
                    cette file (`sortByPriority`), pas seulement la date. */}
                {r.dueDate && (
                  <span className={deadlineNatureOf(r.deadlineNature) === "FIXED" ? "block text-xs font-semibold text-destructive" : "block text-xs"}>
                    {deadlineNatureLabel(r.deadlineNature)}
                  </span>
                )}
              </TableCell>
              <TableCell><StatusBadge map={PAYMENT_REQUEST_STATUS} value={r.status} dot={false} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const waiting = queue.filter((q) => isWithFinance(q.status));
  const total = waiting.reduce((a, q) => a + toNumber(q.amount), 0);
  // UN PAIEMENT PAR ENTITÉ. On ne présente plus une file mélangée avec un total qui n'appartient
  // à personne : chaque société a sa section et son total, et ce qui ne porte aucune entité forme
  // son propre groupe, nommé — ce sont précisément ceux qu'il faut rattacher.
  const parEntite = groupByEntity(waiting, (q) => ({ companyId: q.companyId, amount: toNumber(q.amount) }), entityLabels);
  const orphelins = unassignedWarning(parEntite);

  return (
    <div className="space-y-5">
      {/* PAS DE LIEN DE RETOUR VERS LES FINANCES. Cet écran est ouvert à TOUT LE MONDE — n'importe
          qui peut avoir à faire payer une facture — alors que le module Finances ne l'est pas.
          Un bouton « Finances » y menait donc la plupart des gens vers une page interdite. La
          page est une entrée de menu à part entière : elle n'a besoin d'aucun retour. */}
      <PageHeader
        title="Demandes de paiement"
        description="Le dossier qui arrive aux Finances : montant, bénéficiaire, échéance, et les pièces qui le justifient. La discussion se tient pièce par pièce."
      >
        <NewPaymentButton />
      </PageHeader>

      {finance && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <KpiCard label="À instruire" value={waiting.length} icon="Banknote" tone={waiting.length > 0 ? "warning" : "default"} />
          <KpiCard label="En attente" value={queue.filter((q) => q.status === "ON_HOLD").length} icon="PauseCircle" />
          <KpiCard label="Montant en jeu" value={formatCurrency(total)} icon="Wallet" tone="info" />
        </div>
      )}

      {finance && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">À instruire (Finances)</h2>
          {/* CE QUI NE PORTE AUCUNE ENTITÉ SE DIT. Ces montants n'entrent dans la comptabilité
              d'aucune société tant qu'ils ne sont pas rattachés — les noyer dans une liste les
              ferait disparaître. */}
          {orphelins && (
            <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-muted-foreground">{orphelins}</p>
          )}
          {queue.length === 0 ? (
            <EmptyState icon="Banknote" title="Rien à instruire" description="Aucune demande de paiement en attente." />
          ) : parEntite.length > 1 ? (
            // UN PAIEMENT PAR ENTITÉ : chaque société sa section, chaque section son total.
            parEntite.map((bucket) => (
              <div key={bucket.companyId ?? "sans"} className="space-y-1.5">
                <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">{bucket.label}</span>
                  <span className="text-muted-foreground">
                    {bucket.rows.length} demande(s) · <strong className="tabular-nums text-foreground">{formatCurrency(bucket.total)}</strong>
                  </span>
                </p>
                <Rows rows={bucket.rows} who={(id) => names.get(id) ?? "—"} />
              </div>
            ))
          ) : (
            <Rows rows={queue} who={(id) => names.get(id) ?? "—"} />
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Mes demandes</h2>
        {/* MES DEMANDES, ET AUSSI CE QUE J'AI FAIT PAYER AILLEURS. Un matériel promotionnel, un
            bon de versement, un sponsoring que j'ai lancés sont des paiements que j'attends : les
            retrouver ici est la condition pour pouvoir relancer ou signaler une urgence. */}
        {mine.length === 0
          ? <EmptyState icon="Banknote" title="Aucune demande" description="Utilisez « Demander un paiement » : le dossier passe par le centre de paiement, qui l'autorise, puis les Finances le règlent." />
          : <Rows rows={mine} />}
      </section>
    </div>
  );
}
