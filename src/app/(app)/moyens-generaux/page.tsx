import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { getGeneralMeans, resolveGeneralMeansDepartment, LIST_LIMIT } from "@/lib/queries/general-means";
import { getAppSettings } from "@/lib/settings";
import { generalMeansBudgetTargets } from "@/lib/general-means/budget-targets";
import { normalizeYear, DEPT_BUDGET_LABEL, consumedPercent } from "@/lib/department-budget";
import { PageHeader } from "@/components/shared/page-header";
import { Tuile } from "@/components/shared/tuile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { InfoBulle } from "@/components/ui/info-bulle";
import { moisParDefaut, titreMois, totauxDuMois } from "@/lib/general-means/ecran";
import { assurerNaturesMoyensGeneraux } from "@/lib/general-means/natures-store";
import { ParNatureMois } from "./par-nature-mois";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CashPanel } from "./cash-panel";
import { ExpensePanel } from "./expense-panel";
import { ServiceSwitch, ChangerDeService } from "./service-switch";
import { EnteteMenu } from "./entete-menu";
import { ExpenseTable } from "./expense-table";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { ANCRE_CAISSE_AVANCE } from "@/lib/chemins/moyens-generaux";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moyens généraux — AMD Internal OS" };

/**
 * MOYENS GÉNÉRAUX — le module qui rassemble ce qui était éparpillé.
 *
 * Le budget vivait dans un tableau, les achats dans les demandes administratives, et l'argent
 * liquide confié à l'assistante nulle part. « Combien a-t-on dépensé ce mois-ci, et me
 * reste-t-il de quoi payer ? » exigeait d'additionner à la main, en espérant n'avoir rien
 * oublié.
 *
 * Un seul écran, une seule notion : LA CAISSE. Elle se lit à deux horizons — la caisse de
 * l'exercice (la dotation de l'année, ce qu'on a le droit de dépenser) et la caisse du mois
 * (l'argent en main aujourd'hui). Ce n'est pas un budget d'un côté et une caisse de l'autre :
 * c'est le même argent, la caisse du mois étant prélevée sur celle de l'exercice. Puis le détail
 * des dépenses avec leurs pièces (où est passé l'argent ?). Chaque dépense porte sa facture ou
 * son bon de paiement — sans pièce, une ligne n'est qu'une affirmation.
 */
export default async function MoyensGenerauxPage(props: { searchParams: Promise<{ year?: string; cible?: string }> }) {
  const searchParams = await props.searchParams;
  // DEUX VISAGES SUR LE MÊME ÉCRAN, et c'est le sujet de cette page.
  //
  // Demander un achat est un geste de TOUT employé : un délégué qui a besoin de cartouches n'a
  // pas à connaître le circuit ni à écrire à l'assistante. La porte du module s'ouvre donc à
  // tous — mais le BUDGET, lui, reste fermé à qui n'a pas le droit de module. Ce n'est pas de
  // la cachotterie : connaître le reste de l'enveloppe transforme une demande en négociation,
  // et le rôle du demandeur est de dire ce dont il a besoin, pas d'arbitrer une caisse qu'il
  // ne tient pas.
  const user = await requireUser();
  const year = normalizeYear(searchParams.year);
  // PLUS DE PÉRIODE À RÉSOUDRE. La caisse d'avance est CONTINUE : elle ne se ferme pas au
  // changement de mois, et il n'y a donc plus « le mois qu'on regarde » — il y a le fond, fait de
  // toutes les remises non soldées, chacune avec sa date.

  // Le catalogue est proposé à TOUT LE MONDE : c'est lui qui rend la demande possible sans
  // connaître les références internes.
  const articles = await prisma.officeSupplyArticle.findMany({
    where: { active: true },
    select: { id: true, name: true, unit: true, estimatedPrice: true },
    orderBy: { name: "asc" },
  });
  const articleOptions = articles.map((a) => ({
    id: a.id, name: a.name, unit: a.unit, estimatedPrice: a.estimatedPrice ? Number(a.estimatedPrice) : null,
  }));

  // LES DEMANDES D'ACHAT PASSENT PAR LE BUREAU DU SECRÉTARIAT (Direction, 07/10 — elles ont quitté
  // « Mon espace »). Ce module est celui de ceux qui ACHÈTENT et qui DÉCAISSENT : qui n'a pas la
  // caisse n'a rien à faire ici — on lui donne le chemin plutôt qu'une page vide.
  if (!userCan(user, "GENERAL_MEANS", "VIEW")) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Moyens généraux"
          description="Ce module tient la caisse et le budget d'un département."
        />
        <EmptyState
          icon="ShoppingBasket"
          title="Vos demandes d'achat passent par le Bureau du secrétariat"
          description="Bureau du secrétariat › Nouvelle demande."
        />
        {userCan(user, "ADMIN_REQUESTS", "VIEW") && (
          <div className="flex justify-center">
            <Link href="/demandes" className="text-sm font-medium text-primary hover:underline">Ouvrir le Bureau du secrétariat</Link>
          </div>
        )}
      </div>
    );
  }

  // LE SUPER ADMIN DÉSIGNE LE SERVICE — et lui seul (`setGeneralMeansDepartment` le revérifie).
  const pilote = user.role === "SUPER_ADMIN" || user.secondaryRole === "SUPER_ADMIN";
  const serviceCourant = pilote ? (await getAppSettings()).generalMeansDepartmentId : null;
  // La liste des départements ne sert qu'à DÉSIGNER le service (`ChangerDeService`) : elle n'ouvre
  // la caisse d'aucun d'eux. Chargée pour le seul Super Admin.
  const departements = pilote
    ? (await prisma.department.findMany({ select: { id: true, name: true, parent: { select: { name: true } } }, orderBy: { name: "asc" } }))
        .map((d) => ({ id: d.id, libelle: d.parent ? `${d.parent.name} › ${d.name}` : d.name }))
    : [];

  const departmentId = await resolveGeneralMeansDepartment(user);
  if (!departmentId) {
    // UNE ISSUE POUR LE SUPER ADMIN. Sans département à lui et sans service valide (jamais désigné,
    // ou supprimé depuis), il n'avait que « aucun département rattaché » — et le seul geste qui
    // désigne le service vivait sur l'écran d'un département qu'il ne pouvait plus ouvrir.
    if (pilote) {
      return (
        <div className="space-y-5">
          <PageHeader title="Moyens généraux" description="La caisse des moyens généraux de la société — l'exercice et le mois — et ses achats, au même endroit." />
          <EmptyState
            icon="Landmark"
            title={serviceCourant ? "Le service des moyens généraux n'existe plus" : "Aucun service des moyens généraux n'est désigné"}
            description="Choisissez le département qui tient la caisse de la société : c'est elle que tout le monde ouvrira en arrivant ici."
          />
          <ChangerDeService departements={departements} actuel={null} ouvertParDefaut />
        </div>
      );
    }
    return (
      <div className="space-y-5">
        <PageHeader title="Moyens généraux" description="La caisse d'un département — l'exercice et le mois — et ses achats, au même endroit." />
        <EmptyState
          icon="Building2"
          title="Aucun département rattaché à votre compte"
          description="La caisse et le budget se tiennent par département. Demandez aux ressources humaines de rattacher votre fiche employé — vos demandes d'achat, elles, fonctionnent déjà."
        />
      </div>
    );
  }

  const view = await getGeneralMeans(user, departmentId, year);
  if (!view) notFound();

  // UN SEUL SERVICE À L'ÉCRAN, Super Admin compris (décision du 01/10 : « enlève les autres
  // départements, laisse que l'Administration »). Le sélecteur qui lui ouvrait les moyens généraux
  // de chaque département est retiré : pour tout le monde, les moyens généraux sont ceux de la
  // société, et un sélecteur dirait le contraire. Le découpage par département reste la façon dont
  // l'argent est IMPUTÉ — il se lit dans Budgets › par département, lien conservé ci-dessous.
  // Le Super Admin garde ce qui n'appartient qu'à lui : voir QUEL département tient le service,
  // et en désigner un autre (`ChangerDeService`) — sans ouvrir la caisse de cet autre.

  // Les candidats à qui remettre une caisse : seule l'administration a besoin de cette liste.
  const people = view.canAllot
    ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];

  // LE CATALOGUE D'ARTICLES — le même que celui du Bureau du secrétariat, vu d'ici. Deux
  // catalogues auraient produit deux vocabulaires, donc des consommations incomparables.
  // La liste courte alimente les menus déroulants des tickets ; la liste détaillée n'est
  // chargée que pour qui peut la tenir.
  const canManageCatalog = userCan(user, "GENERAL_MEANS", "UPDATE");
  const catalog = canManageCatalog
    ? await prisma.officeSupplyArticle.findMany({
        select: { id: true, name: true, category: true, unit: true, reference: true, estimatedPrice: true, supplierHint: true, active: true, notes: true },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      })
    : [];
  const catalogRows = catalog.map((a) => ({ ...a, estimatedPrice: a.estimatedPrice ? Number(a.estimatedPrice) : null }));

  // LES CASES BUDGÉTAIRES OUVERTES ICI. Liste volontairement pauvre : des destinations, sans
  // montants ni consommation — classer une dépense ne suppose pas d'accéder au module Budget.
  // LES NATURES PAR DÉFAUT SONT GARANTIES d'abord (Direction, 10/2026) : l'enveloppe des moyens généraux et ses
  // catégories existent, sans quoi l'IA n'aurait nulle part où ranger. Une panne ici n'empêche pas d'afficher la page.
  if (view.canSpend) await assurerNaturesMoyensGeneraux().catch((err) => console.error("[moyens-generaux] natures", err));
  const budgetTargets = view.canSpend ? await generalMeansBudgetTargets() : [];

  // MOIS EN COURS, DÉPENSES PAR NATURE : lus sur la liste affichée (les 200 plus récentes — largement assez pour deux mois).
  const maintenant = new Date();
  const mois = totauxDuMois(view.expenses, maintenant);
  const nomDuMois = (ym: string) => titreMois(ym).split(" ")[0].toLowerCase();
  const nonClassees = view.expenses.filter((e) => e.parts.some((p) => p.nature === null)).length;
  const fund = view.cash?.fund ?? null;
  const derniereRemise = view.cash?.remittances.find((r) => r.centre === "VERSEE") ?? view.cash?.remittances[0] ?? null;
  const totalAnnee = view.consumed + view.otherConsumed;

  return (
    <div className="space-y-5">
      {/* Arrivé par une notification (`?cible=remise-…` / `rallonge-…`) : la remise ou la rallonge visée vient
          sous les yeux ; si elle n'est plus affichée (soldée, repliée), c'est la caisse d'avance qui s'entoure. */}
      <SurlignerCible ids={searchParams.cible ? [searchParams.cible, ANCRE_CAISSE_AVANCE] : []} />
      {/* EN-TÊTE (Direction, 09/10) : la société et l'année, UN geste principal (« Ajouter une dépense »), le reste dans ⋯.
          La caisse, les dépenses et le choix du service ne sont pas retirés : ils vivent dans la page, sous l'en-tête. */}
      <PageHeader
        title={pilote ? `Moyens généraux — ${view.department.path}` : "Moyens généraux"}
        description={`${view.department.company ?? view.department.name} · ${year}`}
      >
        {view.canSpend && (
          <ExpensePanel
            departmentId={view.department.id} year={year} remaining={view.remaining}
            articles={articleOptions} budgetTargets={budgetTargets}
            cash={view.cash ? {
              // « Reçue » se juge sur le FOND : une remise en attente de confirmation
              // n'empêche pas de dépenser ce qui est déjà en main.
              status: view.cash.fund.received > 0 ? "RECEIVED" : "ALLOTTED",
              remaining: view.cash.fund.remaining,
              // La caisse n'est proposée qu'à qui peut réellement en sortir de l'argent :
              // offrir l'option à quelqu'un d'autre, c'est un refus après la saisie.
              canSpend: view.isHolder || view.canAmendCash,
            } : null}
          />
        )}
        {canManageCatalog && <EnteteMenu articles={catalogRows} peutModifier />}
      </PageHeader>

      {/* QUEL DÉPARTEMENT TIENT LES MOYENS GÉNÉRAUX DE LA SOCIÉTÉ — le réglage qui décide où tout le
          monde atterrit. Il n'appartient qu'au Super Admin, et il n'ouvre la caisse d'aucun autre
          département : une seule caisse à l'écran, celle du service désigné (§118.170). */}
      {pilote && (
        <div className="flex flex-wrap items-center gap-2">
          <ServiceSwitch
            departmentId={view.department.id} departmentName={view.department.path}
            current={serviceCourant}
          />
          <ChangerDeService departements={departements} actuel={serviceCourant} />
        </div>
      )}

      {/* TROIS CHIFFRES : ce qu'il reste à dépenser, ce que le mois a coûté, ce que l'année a coûté. Les explications
          (caisse de l'exercice, autres budgets) sont derrière ⓘ. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tuile
          label="En caisse" valeur={fund ? formatCurrency(fund.remaining) : "—"}
          ton={fund?.overspent ? "danger" : fund?.lowOnCash ? "alerte" : "defaut"}
          contexte={fund
            ? `sur ${formatCurrency(fund.remitted)} remis${derniereRemise ? ` le ${formatDate(derniereRemise.remittedAt, { day: "2-digit", month: "2-digit" })}` : ""}${view.cash?.holder ? ` · ${view.cash.holder}` : ""}`
            : "aucune somme remise"}
        />
        <Tuile
          label="Dépensé ce mois" valeur={formatCurrency(mois.courant)}
          contexte={`${nomDuMois(mois.precedentMois)} : ${formatCurrency(mois.precedent)}`}
        />
        <Tuile
          className="col-span-2 md:col-span-1"
          label="Dépenses de l'année" valeur={formatCurrency(totalAnnee)}
          contexte={`${view.expenseCount} dépense${view.expenseCount > 1 ? "s" : ""}`}
          info={
            <InfoBulle label="À propos des dépenses de l'année">
              {view.allocated > 0
                ? <>Caisse de l&apos;exercice {year} : {formatCurrency(view.allocated)} — {consumedPercent(view.allocated, view.consumed)} % consommée par les {DEPT_BUDGET_LABEL.OPERATING.toLowerCase()}. </>
                : <>Aucune caisse annuelle réglée. </>}
              {view.otherConsumed > 0 && <>Dont {formatCurrency(view.otherConsumed)} imputés à d&apos;autres budgets (métier, formation), non déduits de cette caisse.</>}
            </InfoBulle>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card id={ANCRE_CAISSE_AVANCE}>
          <CardHeader className="flex-row items-center justify-between gap-2 p-4 pb-2">
            <CardTitle>Caisse d&apos;avance</CardTitle>
            <InfoBulle label="À propos de la caisse d'avance">
              La part de la caisse de l&apos;exercice en main — le même argent, pas un budget à côté. Elle est continue : chaque remise
              s&apos;ajoute au fond et garde sa date. La personne qui la détient confirme avoir reçu la somme, puis chaque dépense en est
              déduite, justificatif à l&apos;appui, jusqu&apos;à épuisement — moment où elle demande une rallonge.
            </InfoBulle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <CashPanel view={view} people={people} />
          </CardContent>
        </Card>

        <ParNatureMois
          depenses={view.expenses.map((e) => ({ date: e.date, parts: e.parts }))}
          annee={year}
          moisInitial={moisParDefaut(year, maintenant)}
          nonClassees={nonClassees}
          peutRanger={pilote}
          departmentId={view.department.id}
          tronque={view.truncated}
        />
      </div>

      <Card id="depenses" className="scroll-mt-4">
        <CardHeader className="flex-row items-center justify-between gap-2 p-4 pb-2">
          <CardTitle>Dépenses</CardTitle>
          <InfoBulle label="À propos des dépenses">
            {view.canSpend && <>Un seul endroit pour enregistrer un achat, qu&apos;il ait été réglé sur la caisse ou autrement (virement, carte, facture payée par les Finances) : le moyen de paiement se choisit dans le formulaire et se corrige après coup. </>}
            Seul le mois en cours est ouvert ; un clic sur une ligne en montre le détail.
            {view.truncated && <> Les {LIST_LIMIT} plus récentes sont affichées ; les totaux portent sur l&apos;année entière.</>}
          </InfoBulle>
        </CardHeader>
        <CardContent className="p-0 pb-2">
          {/* UNE SEULE LISTE, ET ELLE SE FILTRE. Les dépenses payées en liquide s'affichaient
              aussi dans un bloc « Dépenses de la caisse » : les mêmes achats, deux fois, avec
              deux compteurs. « Caisse d'avance » est un filtre de paiement. */}
          <ExpenseTable
            expenses={view.expenses}
            canSpend={view.canSpend}
            canAmendCash={view.canAmendCash}
            articles={articleOptions}
            budgetTargets={budgetTargets}
            cashUsable={Boolean(view.cash && view.cash.fund.received > 0 && (view.isHolder || view.canAmendCash))}
            maintenant={maintenant.toISOString()}
          />
        </CardContent>
      </Card>
    </div>
  );
}