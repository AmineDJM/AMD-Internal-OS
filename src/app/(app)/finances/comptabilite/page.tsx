import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { getFinanceData, chargerTresorerie } from "@/lib/queries/finance";
import { getComptaData, getResultatMensuel } from "@/lib/queries/compta";
import { lirePeriode, moisAlger } from "@/lib/finance/resultat-mensuel";
import { ComptaCockpit } from "../compta-cockpit";
import { auditLedger, auditSummary } from "@/lib/finance/ledger-audit";
import { PageHeader } from "@/components/shared/page-header";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createTransaction, createQuickIncome } from "@/lib/actions/finance-actions";
import { FINANCE_CATEGORY, FINANCE_DIRECTION, FINANCE_METHOD, FINANCE_STATUS } from "@/lib/labels";
import { getMyCompanies, companyOptions } from "@/lib/company";
import { LedgerTable } from "../ledger-table";
import { ImportTransactionsButton } from "../import-transactions";
import { ComptesTresorerieButton } from "../comptes-tresorerie";

export const dynamic = "force-dynamic";

/**
 * COMPTABILITÉ — le livre, et rien d'autre.
 *
 * Tenir les comptes et régler les fournisseurs sont deux métiers, faits par deux personnes, à
 * deux moments : les avoir mis sur la même page obligeait le comptable à défiler sous les
 * règlements pour atteindre ses écritures, et le payeur à défiler sous le livre pour atteindre
 * sa file. On garde ici ce qui S'ÉCRIT : les écritures, l'import, les soldes d'ouverture.
 *
 * ── ET CE QUE LE DAF DOIT ENCORE ARBITRER ───────────────────────────────────────────────────
 *
 * Le cockpit — dépenses hors ordres, masse salariale à provisionner, résultat mensuel — vivait
 * sur le tableau de bord des Finances, qui a été supprimé. Il n'a pas disparu avec lui : c'est
 * du travail de comptable, il est donc ICI, au-dessus du livre qu'il conduit à corriger. Le
 * reloger était le seul moyen de ne pas perdre une capacité qu'aucun autre écran ne portait.
 */
export default async function ComptabilitePage(
  props: {
    searchParams?: Promise<{ periode?: string; du?: string; au?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("FINANCES");
  // LA PÉRIODE DU RÉSULTAT MENSUEL — lue dans l'adresse, côté serveur : un lien la partage, un
  // rechargement la garde. Illisible, elle retombe sur 6 mois en le disant (`lirePeriode`).
  const periode = lirePeriode(searchParams ?? {}, moisAlger(new Date()));
  const canCreate = userCan(user, "FINANCES", "CREATE");
  const canUpdate = userCan(user, "FINANCES", "UPDATE");
  const canDelete = userCan(user, "FINANCES", "DELETE");
  const [data, compta, resultat, companies, settled, remises, tresorerie] = await Promise.all([
    getFinanceData(user.id),
    // CE QUE LE DAF DOIT ENCORE ARBITRER — arrivé du tableau de bord supprimé.
    getComptaData(user.id),
    getResultatMensuel(user.id, periode),
    getMyCompanies(user.id),
    // ── LE CONTRÔLE DU LIVRE ────────────────────────────────────────────────────────────────
    //
    // Deux questions qu'aucun écran ne posait : tout paiement est-il comptabilisé, et quelque
    // chose est-il sorti deux fois ? Un ordre réglé sans écriture creuse un écart bancaire qu'on
    // découvre au rapprochement, un mois plus tard ; un double paiement ne se voit pas dans un
    // livre de trois mille lignes, puisque chaque écriture, prise seule, est régulière.
    //
    // On lit les ordres RÉGLÉS de la portée. La règle vit dans `finance/ledger-audit.ts` — ce
    // module SIGNALE et n'efface rien : un doublon apparent peut être deux règlements légitimes.
    prisma.expenseOrder.findMany({
      where: await companyScopedWhere(user.id, { status: "PAID" as const }),
      orderBy: { paidDate: "desc" },
      take: 500,
      select: {
        id: true, reference: true, label: true, amount: true, transactionId: true,
        sourceType: true, sourceId: true, paidDate: true,
      },
    }),
    // LES REMISES DE CAISSE D'AVANCE — l'autre porte par laquelle l'argent quitte la banque. Les
    // DÉPENSES de la caisse étaient suivies ; la remise qui fait exister le fond ne l'était pas.
    // Une remise qui attend encore le centre de paiement (ou qu'il a refusée) n'a rien sorti : la
    // signaler « sans écriture » serait une fausse alerte (§118.176). On ne lit que les remises
    // d'avant la règle et celles dont l'ordre est réglé — l'écriture leur est alors due.
    prisma.pettyCashAllotment.findMany({
      where: { OR: [{ expenseOrderId: null }, { expenseOrder: { status: "PAID" } }] },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true, amount: true, period: true, transactionId: true, createdAt: true,
        department: { select: { name: true } },
      },
    }),
    // LES COMPTES ANCRÉS (§118.176) — la même lecture que « Banque & paiements ».
    chargerTresorerie(user.id),
  ]);

  const audit = auditLedger(
    settled.map((o) => ({
      id: o.id, reference: o.reference, label: o.label, amount: toNumber(o.amount),
      transactionId: o.transactionId, sourceType: o.sourceType, sourceId: o.sourceId,
      paidDate: o.paidDate,
    })),
    data.rows.map((r) => ({
      id: r.id, reference: r.reference, direction: r.direction, amount: r.amount,
      label: r.label, counterparty: r.counterparty, date: r.date,
    })),
    remises.map((r) => ({
      id: r.id,
      label: `Caisse d'avance — ${r.department?.name ?? "service"} (${r.period})`,
      amount: toNumber(r.amount),
      transactionId: r.transactionId,
      date: r.createdAt,
    })),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Finances — Comptabilité" description="Le livre comptable : écritures, import de relevés et comptes de trésorerie ancrés.">
        <ComptesTresorerieButton comptes={tresorerie.comptes} entites={companyOptions(companies)} canUpdate={canUpdate} />
        {canCreate && (
          <>
            {/* ENCAISSEMENT SIMPLE — cinq champs. Le formulaire complet reste à côté pour la
                saisie comptable soignée ; encaisser un règlement client ne doit pas l'exiger. */}
            <CreateRecordButton
              label="Encaissement"
              title="Nouvel encaissement"
              description="Un règlement reçu : date, référence, libellé, montant, client. Le reste est implicite (recette réglée, virement bancaire)."
              action={createQuickIncome}
              fields={[
                { type: "date", name: "date", label: "Date", required: true },
                { type: "text", name: "reference", label: "Référence", placeholder: "Reçu / virement — laissez vide pour une référence automatique" },
                { type: "text", name: "label", label: "Libellé", required: true, full: true },
                { type: "number", name: "amount", label: "Montant (DZD)", required: true },
                { type: "text", name: "client", label: "Client" },
                { type: "select", name: "companyId", label: "Entité", options: companyOptions(companies), placeholder: "— Entité —" },
              ]}
            />
            <ImportTransactionsButton />
            <CreateRecordButton
              label="Nouvelle écriture"
              title="Nouvelle écriture comptable"
              description="Recette, dépense, apport (CCA), prêt, salaire…"
              action={createTransaction}
              fields={[
                { type: "date", name: "date", label: "Date", required: true },
                { type: "select", name: "direction", label: "Sens", options: optionsFromMap(FINANCE_DIRECTION), defaultValue: "OUT" },
                { type: "select", name: "category", label: "Catégorie", options: optionsFromMap(FINANCE_CATEGORY), defaultValue: "FOURNISSEUR" },
                { type: "select", name: "companyId", label: "Entité", options: companyOptions(companies), placeholder: "— Entité —" },
                { type: "text", name: "label", label: "Libellé", required: true, full: true },
                { type: "number", name: "amount", label: "Montant (DZD)", required: true },
                { type: "select", name: "method", label: "Moyen de paiement", options: optionsFromMap(FINANCE_METHOD), defaultValue: "BANK_TRANSFER" },
                { type: "text", name: "account", label: "Compte", defaultValue: "Banque" },
                { type: "text", name: "counterparty", label: "Tiers (client / fournisseur)" },
                { type: "text", name: "invoiceRef", label: "Réf. facture" },
                { type: "select", name: "status", label: "Statut", options: optionsFromMap(FINANCE_STATUS), defaultValue: "SETTLED" },
                { type: "textarea", name: "notes", label: "Notes" },
              ]}
            />
          </>
        )}
      </PageHeader>

      {/* CE QUE LE LIVRE NE DIT PAS DE LUI-MÊME. Placé AVANT les écritures : un contrôle qu'il
          faut aller chercher sous trois mille lignes est un contrôle que personne ne lit. */}
      {/* CE QU'IL RESTE À ARBITRER, avant le livre : ce sont ces lignes-là qui deviendront des
          écritures, et les voir après le livre reviendrait à les lire trop tard. */}
      <ComptaCockpit d={compta} resultat={resultat} periode={periode} />

      <section className="surface space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Contrôle du livre</h2>
          <p className={`text-xs ${audit.clean ? "text-success" : "text-muted-foreground"}`}>{auditSummary(audit)}</p>
        </div>
        {!audit.clean && (
          <ul className="space-y-2">
            {audit.findings.slice(0, 12).map((f, i) => (
              <li
                key={`${f.kind}-${i}`}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  f.severity === "HIGH" ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/5"
                }`}
              >
                <p className="font-medium [overflow-wrap:anywhere]">{f.title}</p>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{f.detail}</p>
              </li>
            ))}
            {audit.findings.length > 12 && (
              <li className="text-xs text-muted-foreground">
                … et {audit.findings.length - 12} autre(s). Les plus lourds sont en tête.
              </li>
            )}
          </ul>
        )}
      </section>

      <LedgerTable rows={data.rows} canUpdate={canUpdate} canDelete={canDelete} />
    </div>
  );
}
