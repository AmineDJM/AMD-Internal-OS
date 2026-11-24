import Link from "next/link";
import { Building2, RefreshCw } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  ordresAvecFacture, chargerOrdresDesFinances, dossierHrefByOrder, chargerTresorerie, comptesTresorerie, chargerDossiersDesLignes,
  type DossierDeLigne,
} from "@/modules/finances/api";
import { companyScopedWhere, getMyCompanies, companyOptions } from "@/lib/company";
import { entiteParDefaut } from "@/lib/company-defaut";
import { cn, toNumber, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { MenuDossier } from "@/components/shared/menu-dossier";
import {
  settlementState, sortForSettlement, needsBudgetChoice, compteParDefaut, deadlineNatureOf, etatHistorique, jourFr,
  jourAlger, lireVueBanque, type VueBanque,
} from "@/modules/finances/partage";
import { marquesDesOrdres } from "@/lib/factures/connues";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { ENTITY_MODULE, modulesDesEntites } from "@/lib/entity-access";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { posteDeLOrdre } from "@/lib/labels";
import { ordresBvAvecQuittance } from "@/lib/regulatory/bv-reglement";
import { ComptesTresorerieButton } from "../comptes-tresorerie";
import { TreasuryUpdateRequestButton } from "../treasury-update-request";
import { OrdersTable, type LigneBanque, type BudgetChoice, type CompteChoice } from "./orders-table";
import { PurgeHistoryButton } from "./purge-history";
import { ActualiserSoldesButton } from "./actualiser-soldes";

/**
 * BANQUE & PAIEMENTS — ce qu'il y a en banque, et ce qu'il faut en sortir (maquette du 24/11/2026,
 * BanquePaiements.dc.html).
 *
 * En haut, UN chiffre : le solde bancaire, daté de ses relevés, et ce qu'il deviendra après les paiements à faire.
 * Dessous, trois onglets (`?vue=`) : « À payer », « Reportés », « Payés » (réglés ET annulés). Une ligne = le
 * bénéficiaire (qui ouvre le justificatif, le RIB et les échanges avec le demandeur), l'objet, l'échéance, le
 * montant et UN bouton « Payer » ; reporter et ouvrir le dossier vivent dans « ⋯ ».
 *
 * ── LA FILE N'A QU'UNE SOURCE ──────────────────────────────────────────────────────────────
 *
 * Rien n'arrive ici qui n'ait été AUTORISÉ par le centre de paiement (`visibleToFinance` = `canDisburse`) : un ordre
 * en attente ou REFUSÉ n'existe ni en ligne, ni en compteur, ni en montant. Les ordres non autorisés sont écartés en
 * amont (`chargerOrdresDesFinances`), pas masqués à l'écran.
 */
export default async function PaiementsAFairePage(props: { searchParams: Promise<{ focus?: string; entite?: string; vue?: string }> }) {
  const searchParams = await props.searchParams;
  // `?focus=` : la ligne qu'on vient de cliquer depuis « Mon espace » (ancre `#ord-<id>`).
  const focusId = searchParams.focus ?? null;
  const user = await requireModule("FINANCES_BANQUE");
  const canSettle = userCan(user, "FINANCES_BANQUE", "UPDATE");

  // LES PASTILLES DE SOCIÉTÉ : seules celles que la personne VOIT ; un `?entite=` étranger est ignoré.
  const mesSocietes = await getMyCompanies(user.id);
  const entiteId = entiteParDefaut(mesSocietes, searchParams.entite);

  // `companyScopedWhere` ET NON LE FILTRE BRUT : un ordre sans société resterait invisible à un comptable cloisonné.
  const orders = await chargerOrdresDesFinances(await companyScopedWhere(user.id, entiteId ? { companyId: entiteId } : {}));

  // UN ORDRE REPORTÉ RESTE DÛ — compté à part, il revient seul dans « À payer » à l'échéance (`settlementState`).
  const now = new Date();
  const ouverts = orders.filter((o) => o.status === "PENDING");
  const aPayer = sortForSettlement(ouverts.filter((o) => settlementState(o, now) === "UNPAID"), now);
  const reportes = sortForSettlement(ouverts.filter((o) => settlementState(o, now) === "DEFERRED"), now);
  const payes = orders.filter((o) => o.status === "PAID" || o.status === "CANCELLED");
  // Un `?focus=` sur un ordre reporté ouvre « Reportés » : le lien de « Mon espace » ne tombe pas dans le vide.
  const focusReporte = focusId !== null && !searchParams.vue && focusId.split(",").some((id) => reportes.some((o) => o.id === id));
  const vue: VueBanque = focusReporte ? "reportes" : lireVueBanque(searchParams.vue);
  const visibles = vue === "a-payer" ? aPayer : vue === "reportes" ? reportes : payes;

  // La facture de chaque ordre — par la MÊME règle que le règlement (`ordreAFacture`, §118.185). Le module de chaque
  // SOURCE, en une lecture — la même réponse que l'action serveur (`moduleDeLEntite`, §118.150). Toutes ces lectures
  // ne dépendent que des ordres et de l'entité : UN aller-retour (audit performance PERF-11).
  const ids = new Set(visibles.map((o) => o.id));
  const sourceFilters = visibles.filter((o) => o.sourceType && o.sourceId).map((o) => ({ entityType: o.sourceType!, entityId: o.sourceId! }));
  const [avecFacture, dossiers, doublons, avecQuittance, modulesSources, envelopes, categoryLines, tresorerie, tousLesComptes, demandeOuverte, panneaux, panneauxAPayer] = await Promise.all([
    ordresAvecFacture(orders.filter((o) => o.requiresInvoice && ids.has(o.id))),
    dossierHrefByOrder([...ids]),
    marquesDesOrdres([...ids]),
    ordresBvAvecQuittance(visibles.filter((o) => o.status === "PENDING")),
    modulesDesEntites(sourceFilters),
    prisma.budgetEnvelope.findMany({
      where: { isActive: true },
      select: { id: true, isActive: true, modules: true, module: true, periodStart: true, name: true },
    }),
    prisma.budgetCategoryLine.findMany({
      where: { envelope: { isActive: true } },
      select: { id: true, envelopeId: true, module: true, parentId: true, createdAt: true, name: true },
      orderBy: { name: "asc" },
    }),
    chargerTresorerie(user.id, entiteId),
    comptesTresorerie(),
    prisma.demandeActualisationSoldes.findFirst({
      where: { companyId: entiteId, termineeLe: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    }),
    chargerDossiersDesLignes(visibles),
    // Le compteur de l'onglet « À payer » (ses lignes qui attendent le demandeur), quel que soit l'onglet ouvert.
    vue === "a-payer" ? Promise.resolve(null) : chargerDossiersDesLignes(aPayer),
  ]);
  // « PAYÉS » : d'où, quand, comment — lus sur l'écriture de trésorerie de chaque ordre réglé (compte, mode, référence).
  const ecritures = vue !== "payes" ? new Map<string, { date: Date; method: string; notes: string | null; compte: string | null }>()
    : new Map((await prisma.financeTransaction.findMany({
        where: { id: { in: visibles.map((o) => o.transactionId).filter((t): t is string => Boolean(t)) } },
        select: { id: true, date: true, method: true, notes: true, account: true, treasuryAccount: { select: { name: true } } },
      })).map((t) => [t.id, { date: t.date, method: t.method, notes: t.notes, compte: t.treasuryAccount?.name ?? t.account }]));

  // LE BUDGET, AVANT LE CLIC — la MÊME fonction que le serveur (`pickAutoCategory` puis `needsBudgetChoice`).
  const envelopeName = new Map(envelopes.map((e) => [e.id, e.name]));
  const budgets: BudgetChoice[] = categoryLines.map((c) => ({ id: c.id, label: `${envelopeName.get(c.envelopeId) ?? "Budget"} · ${c.name}` }));
  const autoOf = (o: (typeof orders)[number]): string | null =>
    o.sourceType
      ? pickAutoCategory(
          (o.sourceId ? modulesSources.get(`${o.sourceType}:${o.sourceId}`) : undefined) ?? ENTITY_MODULE[o.sourceType],
          envelopes, categoryLines,
        )
      : null;
  const libelleBudget = new Map(budgets.map((b) => [b.id, b.label]));
  const comptes: CompteChoice[] = tresorerie.comptes.map((c) => ({ id: c.id, nom: c.nom, solde: c.solde, jourAncrage: c.jourAncrage }));

  const sansPanneau: DossierDeLigne = { dossierId: null, dossierRef: null, demandeur: null, justificatif: null, autresPieces: [], fil: [], question: null, relances: null, rib: null };
  const toLigne = (o: (typeof orders)[number]): LigneBanque => {
    const p = panneaux.get(o.id) ?? sansPanneau;
    const etat = settlementState(o, now);
    const ouvert = o.status === "PENDING";
    const fixe = deadlineNatureOf(o.deadlineNature) === "FIXED";
    const ecriture = o.transactionId ? ecritures.get(o.transactionId) ?? null : null;
    const echeance = !ouvert ? (o.status === "CANCELLED" ? "jamais débité" : ecriture?.compte ? `depuis ${ecriture.compte}` : null)
      : etat === "DEFERRED" && o.deferredUntil ? `reporté au ${jourFr(jourAlger(o.deferredUntil))}`
        : o.dueDate ? `${fixe ? "Fixe : " : "avant le "}${jourFr(jourAlger(o.dueDate))}` : null;
    const nature = natureDeLOrdreBv(o);
    const doublon = doublons.get(o.id);
    const alertes = [
      doublon ? `Doublon possible — ${doublon}` : null,
      ouvert && o.requiresInvoice && !avecFacture.has(o.id) ? "Facture requise : elle se joint ou se réclame dans le dossier." : null,
      etat === "DEFERRED" && o.deferredReason ? `Reporté : ${o.deferredReason}` : null,
    ].filter((a): a is string => Boolean(a));
    const remise = Boolean(o.pettyCashAllotment);
    const auto = o.budgetCategoryId ? null : autoOf(o);
    const budget = remise ? "pas de budget (remise de caisse)"
      : o.budgetCategoryId ? libelleBudget.get(o.budgetCategoryId) ?? "budget classé"
        : auto ? `${libelleBudget.get(auto) ?? "budget"} (automatique)` : categoryLines.length > 0 ? "à classer au paiement" : "hors enveloppe";
    return {
      id: o.id, reference: o.reference,
      beneficiaire: o.beneficiary?.trim() || o.label,
      objet: [o.label, posteDeLOrdre(o.category, o.sourceType)].filter(Boolean).join(" · "),
      justification: p.justificatif ? `${p.justificatif.nature} — ${p.justificatif.nom}` : "sans justificatif",
      budget,
      montant: toNumber(o.amount), status: o.status,
      echeance, echeanceFixe: fixe && etat === "UNPAID" && ouvert,
      dueDate: o.dueDate?.toISOString() ?? null, deadlineNature: o.deadlineNature,
      deferredUntil: o.deferredUntil?.toISOString() ?? null, deferredReason: o.deferredReason,
      alertes, relances: ouvert ? p.relances : null, question: ouvert ? p.question : null,
      historique: ouvert ? null : etatHistorique(o),
      paiement: o.status === "PAID" ? {
        le: o.paidDate ? jourFr(jourAlger(o.paidDate)) : null, depuis: ecriture?.compte ?? null, mode: ecriture?.method ?? null,
        reference: ecriture?.notes?.replace(/^Référence du paiement : /, "") ?? null,
      } : null,
      remise,
      // UNE REMISE DE CAISSE NE SE CLASSE PAS (son écrivain l'écrit sans budget) : la demander était un geste que le
      // serveur ignorait (défaut du 24/11/2026).
      needsBudget: !remise && needsBudgetChoice({ onOrder: o.budgetCategoryId, auto: autoOf(o), availableCount: categoryLines.length }),
      compteParDefautId: compteParDefaut(tousLesComptes, o.companyId),
      bv: nature ? { nature: LIBELLE_NATURE_BV[nature], quittanceJointe: avecQuittance.has(o.id) } : null,
      dossierHref: dossiers.get(o.id) ?? null,
      panneau: { dossierId: p.dossierId, demandeur: p.demandeur, justificatif: p.justificatif, autresPieces: p.autresPieces, fil: p.fil, rib: p.rib },
    };
  };

  const enAttenteDemandeur = aPayer.filter((o) => (panneauxAPayer ?? panneaux).get(o.id)?.question === "EN_ATTENTE_DEMANDEUR").length;
  const dernierReleve = tresorerie.comptes.reduce<string | null>((max, c) => (max === null || c.jourAncrage > max ? c.jourAncrage : max), null);
  const societe = mesSocietes.find((s) => s.id === entiteId);
  const nomEntite = societe ? societe.shortName || societe.name : null;
  const demandeLe = demandeOuverte?.createdAt.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" }) ?? null;
  // CE QUI RESTE APRÈS LES PAIEMENTS À FAIRE (maquette validée) : les lignes « À payer » — un reporté n'est pas pour
  // maintenant. Le solde, lui, compte déjà ce qui a été payé depuis le relevé (§118.176) : on dit ce qui est parti
  // aujourd'hui (pas encore sur le relevé), sans le retirer une seconde fois.
  const sommeAPayer = aPayer.reduce((t, o) => t + toNumber(o.amount), 0);
  const aujourdhui = jourAlger(now);
  const payeAujourdhui = payes.filter((o) => o.status === "PAID" && o.paidDate && jourAlger(o.paidDate) === aujourdhui).reduce((t, o) => t + toNumber(o.amount), 0);
  const pied = vue === "a-payer"
    ? `Total à payer : ${formatCurrency(sommeAPayer)} · ${aPayer.length} ordre(s) autorisé(s) par le centre de paiement`
    : vue === "reportes" ? "Un paiement reporté revient dans « À payer » quand on lève le report, ou seul à sa date."
      : "Cliquez une ligne pour voir le paiement : sa date, son compte, son mode et sa référence.";
  const lien = (v: VueBanque) => {
    const q = new URLSearchParams();
    if (entiteId) q.set("entite", entiteId);
    if (v !== "a-payer") q.set("vue", v);
    const s = q.toString();
    return `/finances/paiements-a-faire${s ? `?${s}` : ""}`;
  };
  const onglets: { cle: VueBanque; libelle: string }[] = [
    { cle: "a-payer", libelle: `À payer · ${aPayer.length}${enAttenteDemandeur > 0 ? ` · ${enAttenteDemandeur} en attente du demandeur` : ""}` },
    { cle: "reportes", libelle: `Reportés · ${reportes.length}` },
    { cle: "payes", libelle: `Payés · ${payes.length}` },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Banque & paiements">
        {mesSocietes.length > 0 && (
          <nav aria-label="Société" className="-mx-1 max-w-full overflow-x-auto px-1">
            <ul className="flex min-w-max gap-1.5">
              {mesSocietes.map((c) => {
                const active = c.id === entiteId;
                return (
                  <li key={c.id}>
                    <Link
                      href={`/finances/paiements-a-faire?entite=${c.id}`} scroll={false}
                      aria-current={active ? "page" : undefined} data-entite={c.id}
                      className={cn(
                        "flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
                        active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <Building2 className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="whitespace-nowrap">{companyOptions([c])[0].label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        {(canSettle || user.role === "SUPER_ADMIN") && (
          <MenuDossier label="Autres : comptes de trésorerie, actualiser les soldes, vider l'historique">
            <ComptesTresorerieButton comptes={tresorerie.comptes} entites={companyOptions(mesSocietes)} canUpdate={canSettle} discret />
            {canSettle && <ActualiserSoldesButton entiteId={entiteId} discret />}
            {/* Le Super Admin DEMANDE l'actualisation aux Finances (lui seul) — le circuit d'avant, gardé. */}
            {user.role === "SUPER_ADMIN" && (
              <TreasuryUpdateRequestButton entiteId={entiteId} entite={nomEntite} libelle={demandeOuverte ? "Relancer la demande d'actualisation" : "Demander l'actualisation aux Finances"} />
            )}
            {/* Le Super Admin vide la pile : on efface la FILE, jamais les écritures ni le journal. */}
            {user.role === "SUPER_ADMIN" && <PurgeHistoryButton count={payes.length} />}
          </MenuDossier>
        )}
      </PageHeader>

      {/* ───────────── LE SOLDE BANCAIRE — un seul chiffre, daté ─────────────
          Chaque compte part de son relevé ANCRÉ (§118.176), par la même lecture que la comptabilité
          (`chargerTresorerie`). « Après les paiements à faire » retire ce qui est autorisé et pas encore payé
          (reportés compris : ils restent dus). */}
      <section aria-label="Solde bancaire" className="surface flex flex-wrap items-end justify-between gap-3 p-4" data-a-payer={tresorerie.autorises.montant}>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            Solde bancaire{nomEntite ? ` ${nomEntite}` : ""}{tresorerie.comptes.length > 0 ? ` · relevés du ${jourFr(dernierReleve)}` : ""}
          </p>
          <p className={`text-2xl font-semibold tabular-nums sm:text-3xl ${tresorerie.total < 0 ? "text-destructive" : ""}`}>
            {tresorerie.comptes.length > 0 ? formatCurrency(tresorerie.total) : "—"}
          </p>
          {tresorerie.comptes.length > 0 && <p className="text-xs text-muted-foreground">{tresorerie.comptes.length} compte(s) de trésorerie</p>}
          {tresorerie.comptes.length === 0 && (
            <p className="text-xs text-muted-foreground" data-tresorerie="sans-compte">
              Aucun compte de trésorerie ancré : ouvrez-en un avec le solde d&apos;un relevé (« ⋯ › Comptes de trésorerie »).
            </p>
          )}
          {tresorerie.nonRattaches.nombre > 0 && (
            <p className="text-xs text-warning" role="status">
              {tresorerie.nonRattaches.nombre} écriture(s) réglée(s) ne sont rattachées à aucun compte ({formatCurrency(tresorerie.nonRattaches.montant)}).
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {tresorerie.comptes.length > 0 && (
            <div className="flex flex-col items-start gap-0.5 text-sm sm:items-end">
              {payeAujourdhui > 0 && <span className="text-muted-foreground">Payé aujourd&apos;hui, pas encore au relevé : −{formatCurrency(payeAujourdhui)}</span>}
              <span className={tresorerie.total - sommeAPayer < 0 ? "font-semibold text-destructive" : "text-muted-foreground"}>
                Après les {aPayer.length} paiements à faire : <span className="font-semibold tabular-nums">{formatCurrency(tresorerie.total - sommeAPayer)}</span>
              </span>
            </div>
          )}
          {/* ACTUALISER LES SOLDES — le circuit existant : le Super Admin DEMANDE (lui seul, `requestTreasuryUpdate`),
              les Finances SAISISSENT (la demande ouverte, ou les relevés des comptes). La demande ouverte est l'état du bouton. */}
          {demandeOuverte && canSettle ? (
            <Link href={`/finances/actualisation-soldes/${demandeOuverte.id}`} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 text-sm font-medium">
              <RefreshCw className="h-4 w-4" /> Actualisation demandée le {demandeLe} — saisir les soldes
            </Link>
          ) : canSettle ? (
            <ActualiserSoldesButton entiteId={entiteId} />
          ) : user.role === "SUPER_ADMIN" ? (
            <TreasuryUpdateRequestButton
              entiteId={entiteId} entite={nomEntite}
              libelle={demandeOuverte ? `Actualisation demandée le ${demandeLe} — relancer` : "Demander l'actualisation des soldes"}
            />
          ) : demandeOuverte ? (
            <span className="text-sm text-warning">Actualisation demandée le {demandeLe} — en attente des Finances</span>
          ) : null}
        </div>
      </section>

      <nav aria-label="Vues" className="flex gap-1 overflow-x-auto border-b border-border">
        {onglets.map((t) => (
          <Link
            key={t.cle} href={lien(t.cle)} scroll={false} aria-current={vue === t.cle ? "page" : undefined}
            className={cn("flex min-h-11 items-center whitespace-nowrap px-4 text-sm", vue === t.cle ? "font-semibold text-primary shadow-[inset_0_-2px_0_hsl(var(--primary))]" : "text-muted-foreground hover:text-foreground")}
          >
            {t.libelle}
          </Link>
        ))}
      </nav>

      <p className="text-xs text-muted-foreground">
        Seuls les paiements autorisés par le centre de paiement arrivent ici : une demande refusée par le centre n&apos;apparaît jamais dans cette liste.
      </p>

      <OrdersTable
        lignes={visibles.map(toLigne)} canSettle={canSettle} focusId={focusId} budgets={budgets} comptes={comptes} pied={pied}
        vide={vue === "a-payer" ? "Rien à payer pour l'instant" : vue === "reportes" ? "Aucun paiement reporté" : "Aucun paiement réglé ou annulé"}
      />
    </div>
  );
}
