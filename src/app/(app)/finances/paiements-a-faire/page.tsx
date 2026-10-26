import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ordresAvecFacture } from "@/lib/finance/facture-ordre";
import { companyScopedWhere, getMyCompanies, companyOptions } from "@/lib/company";
import { entiteParDefaut } from "@/lib/company-defaut";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ComptesTresorerieButton } from "../comptes-tresorerie";
import { toNumber, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { visibleToFinance, type CentralStatus } from "@/lib/payments/authorization";
import { settlementState, sortForSettlement } from "@/lib/finance/settlement";
import { dossierHrefByOrder } from "@/lib/expense-orders";
import { marquesDesOrdres } from "@/lib/factures/connues";
import { needsBudgetChoice } from "@/lib/finance/settle-budget";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { ENTITY_MODULE, modulesDesEntites } from "@/lib/entity-access";
import { chargerTresorerie } from "@/lib/queries/finance";
import { TreasuryUpdateRequestButton } from "../treasury-update-request";
import { OrdersTable, type OrderRow, type BudgetChoice, type CompteChoice } from "./orders-table";
import { compteParDefaut } from "@/lib/finance/tresorerie";
import { comptesTresorerie } from "@/lib/finance/comptes";
import { PurgeHistoryButton } from "./purge-history";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { ordresBvAvecQuittance } from "@/lib/regulatory/bv-reglement";

/**
 * BANQUE & PAIEMENTS — ce qu'il y a en banque, et ce qu'il faut en sortir.
 *
 * ── POURQUOI LES DEUX SUR LE MÊME ÉCRAN ─────────────────────────────────────────────────────
 *
 * Le solde de trésorerie vivait sur un tableau de bord, un écran plus tôt. On y regardait ce
 * qu'il restait en banque, puis on venait ici décider ce qu'on paie — de mémoire. C'est
 * exactement au moment de régler qu'on veut voir le solde : il est donc en tête de la file qu'il
 * gouverne, avec le détail par compte.
 *
 * ── LA FILE DU DÉCAISSEMENT N'A QU'UNE SOURCE ───────────────────────────────────────────────
 *
 * Rien n'atterrit ici qui ne soit passé par le CENTRE DE PAIEMENT. Ce n'est pas un filtre
 * d'affichage : les ordres non autorisés sont écartés en amont, si bien qu'ils n'existent ni en
 * ligne, ni en total, ni en compteur pour la comptabilité. Un ordre REFUSÉ, lui, reste visible —
 * les Finances doivent savoir qu'il ne faut pas payer, et pourquoi.
 *
 * TROIS ÉTATS, ET RIEN D'AUTRE. Les Finances ne peuvent ni annuler, ni demander une révision de
 * budget : l'ordre leur arrive AUTORISÉ, et rouvrir le montant à la caisse reviendrait à défaire
 * une décision prise par le centre, qui voit la file entière. Reste **non payé** (le défaut),
 * **paiement reporté à** une date, **payé**.
 */
/** « 2026-09-28 » → « 28/09/2026 ». */
const jourFr = (iso: string | null) => {
  if (!iso) return "—";
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

export default async function PaiementsAFairePage({ searchParams }: { searchParams: { focus?: string; entite?: string } }) {
  // `?focus=` : la ligne qu'on vient de cliquer depuis « Mon espace ». Voir OrdersTable.
  const focusId = searchParams.focus ?? null;
  const user = await requireModule("FINANCES");
  const canSettle = userCan(user, "FINANCES", "UPDATE");

  // LES CASES D'ENTITÉS, EN HAUT (Direction, 05/10) : la page se lit entité par entité. Seules les
  // sociétés que la personne VOIT sont proposées, et un `?entite=` qui n'en est pas une est ignoré
  // (on n'ouvre pas une société par son identifiant). PLUS DE « TOUTES LES ENTITÉS » (Direction, 06/10) :
  // tout l'existant est rattaché à Adventum (migration `finance_rattache_adventum`), et c'est Adventum
  // qui s'ouvre par défaut.
  const mesSocietes = await getMyCompanies(user.id);
  const entiteId = entiteParDefaut(mesSocietes, searchParams.entite);

  // LES FINANCES NE REÇOIVENT RIEN tant que le centre de paiement n'a pas tranché — quel que
  // soit le montant, depuis que le seuil a été retiré. Un ordre n'apparaît ici qu'une fois
  // autorisé (ou refusé : il faut savoir qu'il ne faut pas payer). Les écarter en amont plutôt
  // qu'à l'écran est délibéré : un ordre non autorisé ne doit pas exister pour la comptabilité,
  // pas même en total ou en compteur.
  // `companyScopedWhere` ET NON LE FILTRE BRUT : celui-ci vaut `companyId = X`, et `NULL` n'est
  // pas `X`. Un ordre qu'on n'a pas su rattacher disparaissait de la file du décaissement pour
  // tout comptable cloisonné sur une société — et un paiement invisible n'est pas un paiement
  // classé, c'est un paiement qu'on ne fera jamais.
  const orders = (await prisma.expenseOrder.findMany({
    where: await companyScopedWhere(user.id, entiteId ? { companyId: entiteId } : {}),
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { name: true } } },
    take: 300,
  })).filter((o) => visibleToFinance(o.centralStatus as CentralStatus));

  // La facture de chaque ordre — par la MÊME règle que le règlement (`finance/facture-ordre.ts`,
  // §118.185) : la colonne disait « facture jointe » là où le règlement refusait, et inversement.
  const orderIds = orders.map((o) => o.id);
  const avecFacture = await ordresAvecFacture(orders.filter((o) => o.requiresInvoice));
  const sourceFilters = orders
    .filter((o) => o.sourceType && o.sourceId)
    .map((o) => ({ entityType: o.sourceType!, entityId: o.sourceId! }));
  const hasInvoice = (o: (typeof orders)[number]) => avecFacture.has(o.id);

  // LE DOSSIER DE CHAQUE ORDRE — de TOUS les ordres, désormais. La règle testait `sourceType ===
  // "PAYMENT_REQUEST"` et ne reconnaissait donc qu'un circuit sur treize : un matériel
  // promotionnel, un bon de versement, un sponsoring arrivaient ici avec un libellé mort, et
  // joindre une facture obligeait à retrouver le module d'origine — quand on y avait accès.
  // Depuis qu'un ordre ouvre son dossier en naissant (`createExpenseOrder`), le lien se lit sur
  // `expenseOrderId`, qui vaut pour les deux sens de l'histoire.
  const dossiers = await dossierHrefByOrder(orderIds);
  // LA MARQUE « DOUBLON POSSIBLE » de chaque ordre (Direction, 14/10/2026).
  const doublons = await marquesDesOrdres(orderIds);

  // ── OÙ CETTE DÉPENSE TOMBERA-T-ELLE ? ───────────────────────────────────────────────────────
  //
  // La question se pose AVANT le clic, avec la MÊME fonction que le serveur (`pickAutoCategory`,
  // puis `needsBudgetChoice`) : deux règles séparées auraient divergé, et l'on aurait fini avec un
  // bouton qui promet un règlement que le serveur refuse. Les catégories sont chargées ici une
  // fois pour toute la table — l'écran en a besoin pour PROPOSER le classement, pas seulement
  // pour le calculer.
  const [envelopes, categoryLines] = await Promise.all([
    prisma.budgetEnvelope.findMany({
      where: { isActive: true },
      select: { id: true, isActive: true, modules: true, module: true, periodStart: true, name: true },
    }),
    prisma.budgetCategoryLine.findMany({
      where: { envelope: { isActive: true } },
      select: { id: true, envelopeId: true, module: true, parentId: true, createdAt: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const envelopeName = new Map(envelopes.map((e) => [e.id, e.name]));
  // Le libellé porte l'enveloppe : « Marketing 2026 · Congrès » — « Congrès » seul se répète
  // d'une enveloppe à l'autre, et l'on classe alors dans l'exercice de l'an dernier.
  const budgets: BudgetChoice[] = categoryLines.map((c) => ({
    id: c.id,
    label: `${envelopeName.get(c.envelopeId) ?? "Budget"} · ${c.name}`,
  }));
  // Le module de chaque SOURCE, en une lecture — la même réponse que l'action serveur
  // (`moduleDeLEntite`) : un consultant passé aux RH se classe sur une enveloppe RH (§118.150).
  const modulesSources = await modulesDesEntites(sourceFilters);
  const autoOf = (o: (typeof orders)[number]): string | null =>
    o.sourceType
      ? pickAutoCategory(
          (o.sourceId ? modulesSources.get(`${o.sourceType}:${o.sourceId}`) : undefined) ?? ENTITY_MODULE[o.sourceType],
          envelopes, categoryLines,
        )
      : null;

  // LES COMPTES D'OÙ PEUT PARTIR UN RÈGLEMENT — et le défaut de chaque ordre, par la MÊME règle que
  // l'écriture (`compteParDefaut` sur TOUS les comptes), sinon l'écran proposerait un compte et le
  // serveur en figerait un autre (§118.176).
  const [tresorerie, tousLesComptes] = await Promise.all([chargerTresorerie(user.id, entiteId), comptesTresorerie()]);
  const comptes: CompteChoice[] = tresorerie.comptes.map((c) => ({ id: c.id, nom: c.nom }));

  // LE BV D'UN DOSSIER RÉGLEMENTAIRE se règle avec sa QUITTANCE : l'écran la demande au geste « Payé »
  // quand elle n'est pas déjà jointe — par la MÊME règle que le serveur (`ordresBvAvecQuittance`).
  const avecQuittance = await ordresBvAvecQuittance(orders.filter((o) => o.status === "PENDING"));
  const bvDe = (o: (typeof orders)[number]): OrderRow["bv"] => {
    const nature = natureDeLOrdreBv(o);
    return nature ? { nature: LIBELLE_NATURE_BV[nature], quittanceJointe: avecQuittance.has(o.id) } : null;
  };

  const toRow = (o: (typeof orders)[number]): OrderRow => ({
    id: o.id, reference: o.reference, label: o.label, beneficiary: o.beneficiary,
    category: o.category, amount: toNumber(o.amount), status: o.status,
    requestedBy: o.requestedBy?.name ?? null, createdAt: o.createdAt.toISOString(),
    requiresInvoice: o.requiresInvoice, hasInvoice: hasInvoice(o),
    dueDate: o.dueDate?.toISOString() ?? null, deadlineNature: o.deadlineNature,
    deferredUntil: o.deferredUntil?.toISOString() ?? null, deferredReason: o.deferredReason,
    // On ouvre LE DOSSIER DU PAIEMENT et ses pièces — pas la demande source, qui vit dans un
    // autre module, avec d'autres droits, et que le comptable n'a pas à traverser pour lire une
    // facture.
    dossierHref: dossiers.get(o.id) ?? null,
    doublonPossible: doublons.get(o.id) ?? null,
    needsBudget: needsBudgetChoice({
      onOrder: o.budgetCategoryId,
      auto: autoOf(o),
      availableCount: categoryLines.length,
    }),
    compteParDefautId: compteParDefaut(tousLesComptes, o.companyId),
    bv: bvDe(o),
  });

  // UN ORDRE REPORTÉ RESTE DANS LA FILE — daté, pas classé. Le sortir d'ici ferait de « reporter »
  // le moyen commode de faire disparaître ce qu'on ne veut pas payer ; il est donc seulement
  // affiché à part, compté à part, et il redescend tout seul dans « à régler » à l'expiration de
  // sa date (`settlementState`).
  const now = new Date();
  const ouverts = orders.filter((o) => o.status === "PENDING");
  const pending = sortForSettlement(ouverts.filter((o) => settlementState(o, now) === "UNPAID"), now);
  const reportes = sortForSettlement(ouverts.filter((o) => settlementState(o, now) === "DEFERRED"), now);
  const others = orders.filter((o) => o.status === "PAID" || o.status === "CANCELLED");
  const totalPending = pending.reduce((a, o) => a + toNumber(o.amount), 0);

  // LA BANQUE — « Solde bancaire » = la somme des comptes, datée (Direction, 05/10) ; la soustraction des
  // paiements autorisés (01/10) est retirée : ce montant à régler se lit à côté, jamais en moins.
  // Chaque compte part de son relevé ANCRÉ et n'ajoute que les écritures réglées postérieures
  // (§118.176) ; la même lecture que la comptabilité (`chargerTresorerie`) — un second calcul
  // donnerait deux soldes au moment précis où il faut décider si l'on peut payer.
  // (chargée plus haut, avec les comptes du règlement)
  const dernierReleve = tresorerie.comptes.reduce<string | null>((max, c) => (max === null || c.jourAncrage > max ? c.jourAncrage : max), null);

  // UNE DEMANDE D'ACTUALISATION ENCORE OUVERTE pour cette entité : elle se DIT en tête, avec le chemin
  // de la réponse — le comptable qui arrive ici sans passer par la notification la trouve aussi.
  const demandeOuverte = await prisma.demandeActualisationSoldes.findFirst({
    where: { companyId: entiteId, termineeLe: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  const libelleEntite = mesSocietes.find((s) => s.id === entiteId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finances — Banque & paiements"
        description="Ce qu'il y a en banque, et les dépenses AUTORISÉES par le centre de paiement qu'il reste à régler. Le règlement génère l'écriture de trésorerie."
      >
        {/* L'ADMINISTRATION DEMANDE l'actualisation, les Finances la font — et « l'administration »
            veut dire LE SUPER ADMIN, lui seul. Le geste notifie tous les responsables Finances :
            ouvert plus largement, il devient une sonnerie que personne n'écoute plus.
            La MÊME règle garde l'action serveur (`requestTreasuryUpdate`) et l'opération d'Adam
            (`request_treasury_update`) — un bouton masqué n'est pas un contrôle d'accès. */}
        {user.role === "SUPER_ADMIN" && <TreasuryUpdateRequestButton entiteId={entiteId} entite={libelleEntite ? libelleEntite.shortName || libelleEntite.name : null} />}
        {/* LE SOLDE SE MET À JOUR ICI, là où on le lit : le comptable pose le solde du relevé et sa date,
            et « Solde bancaire » ci-dessous les affiche dès l'enregistrement. */}
        {canSettle && <ComptesTresorerieButton comptes={tresorerie.comptes} entites={companyOptions(mesSocietes)} canUpdate={canSettle} />}
      </PageHeader>

      {demandeOuverte && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span>
            Actualisation des soldes demandée le{" "}
            {demandeOuverte.createdAt.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })} — en attente des Finances.
          </span>
          <Link href={`/finances/actualisation-soldes/${demandeOuverte.id}`} className="font-medium text-primary hover:underline">
            {canSettle ? "Saisir les soldes" : "Voir la demande"}
          </Link>
        </div>
      )}

      {mesSocietes.length > 1 && (
        <nav aria-label="Entités" className="-mx-1 overflow-x-auto px-1 pb-1">
          <ul className="flex min-w-max gap-2">
            {mesSocietes.map((c) => ({ id: c.id, label: companyOptions([c])[0].label })).map((e) => {
              const active = e.id === entiteId;
              return (
                <li key={e.id}>
                  <Link
                    href={`/finances/paiements-a-faire?entite=${e.id}`} scroll={false}
                    aria-current={active ? "page" : undefined} data-entite={e.id}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                      active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    <Building2 className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="whitespace-nowrap">{e.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {/* ───────────── LA BANQUE ─────────────
          Le solde d'abord : c'est lui qui dit si la file ci-dessous peut être servie. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {/* LE SOLDE BANCAIRE, avec sa date (Direction, 05/10) : ce que les relevés disent, point. Ce qu'il reste à
            régler ne s'en SOUSTRAIT plus — il a sa propre carte, « Montant à régler », juste à côté. La date est
            celle du relevé le plus récent posé par la comptabilité ; les écritures réglées depuis s'y ajoutent. */}
        <KpiCard
          label="Solde bancaire"
          value={tresorerie.comptes.length > 0 ? formatCurrency(tresorerie.total) : "—"}
          icon="Landmark"
          tone={tresorerie.comptes.length === 0 ? "default" : tresorerie.total >= 0 ? "success" : "danger"}
          hint={tresorerie.comptes.length > 0
            ? `Relevé du ${jourFr(dernierReleve)}${tresorerie.comptes.length > 1 ? ` · ${tresorerie.comptes.length} comptes` : ""}`
            : "Aucun compte ancré"}
        />
        <KpiCard label="Ordres à régler" value={pending.length} icon="ReceiptText" tone={pending.length > 0 ? "warning" : "default"} />
        <KpiCard label="Montant à régler" value={formatCurrency(totalPending)} icon="Banknote" tone="warning" hint={`Autorisé par le centre : ${formatCurrency(tresorerie.autorises.montant)}`} />
        <KpiCard label="Paiements reportés" value={reportes.length} icon="CalendarClock" tone={reportes.length > 0 ? "info" : "default"} />
        <KpiCard label="Total ordres émis" value={orders.length} icon="ListChecks" tone="info" />
      </div>

      {/* LES COMPTES, CHACUN DEPUIS SON RELEVÉ. Sans compte ancré, l'écran le DIT : additionner des
          flux sans point de départ affichait un solde qui ne ressemblait à aucun relevé (§118.176). */}
      {tresorerie.comptes.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground" data-tresorerie="sans-compte">
          Aucun compte de trésorerie ancré : le solde ne se calcule pas encore. Ouvrez un compte avec le solde d&apos;un relevé
          (Finances › Comptabilité › Comptes de trésorerie).
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {tresorerie.comptes.map((c) => (
              <div key={c.id} className="surface flex w-full items-center justify-between gap-3 px-3 py-2.5 sm:w-auto sm:justify-start sm:px-4" data-compte={c.nom}>
                <span className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{c.nom} <span className="text-xs">· au {jourFr(c.jourAncrage)}</span></span>
                <span className={`shrink-0 whitespace-nowrap font-semibold tabular-nums ${c.solde >= 0 ? "text-foreground" : "text-destructive"}`}>{formatCurrency(c.solde)}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {tresorerie.comptes.length} compte(s) : {formatCurrency(tresorerie.total)}, depuis leurs relevés ancrés · à régler (autorisé par le centre, pas encore payé) :
            {" "}{tresorerie.autorises.nombre} paiement(s), {formatCurrency(tresorerie.autorises.montant)}
          </p>
          {tresorerie.nonRattaches.nombre > 0 && (
            <p className="text-xs text-warning" role="status">
              {tresorerie.nonRattaches.nombre} écriture(s) réglée(s) depuis l&apos;ancrage ne sont rattachées à aucun compte ({formatCurrency(tresorerie.nonRattaches.montant)}) :
              désignez un compte principal, ou nommez leur compte dans le livre.
            </p>
          )}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À régler</h2>
        <OrdersTable rows={pending.map(toRow)} canSettle={canSettle} emptyLabel="Aucun ordre à régler" focusId={focusId} budgets={budgets} comptes={comptes} />
      </section>

      {reportes.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Paiements reportés ({reportes.length})</h2>
          {/* Ils ne quittent pas la file : ils y reviennent seuls le jour dit. */}
          <p className="text-xs text-muted-foreground">
            Ces ordres sont dus — leur règlement est daté, pas abandonné. Ils redescendent dans « À régler » à l&apos;échéance du report, sans que personne n&apos;ait à y penser.
          </p>
          <OrdersTable rows={reportes.map(toRow)} canSettle={canSettle} focusId={focusId} budgets={budgets} comptes={comptes} />
        </section>
      )}

      {others.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Historique</h2>
            {/* Le Super Admin peut vider cette pile : elle ne sert plus qu'à faire défiler. Les
                écritures de trésorerie, elles, restent — on efface la FILE, pas la comptabilité. */}
            {user.role === "SUPER_ADMIN" && <PurgeHistoryButton count={others.length} />}
          </div>
          <OrdersTable rows={others.map(toRow)} canSettle={false} focusId={focusId} />
        </section>
      )}
    </div>
  );
}
