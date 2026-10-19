import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";
import type { CurrentUser } from "@/lib/session";
import type { BudgetEnvelopeOption, BudgetOverview } from "@/lib/queries/budget";
import { vueBvParDossier } from "@/lib/queries/budget-regulatory";
import { syntheseSimple, type CompteMontant, type DossierSimple, type EtatBvSimple } from "@/lib/budget-regulatory/synthese";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs, type ModuleTab } from "@/components/shared/module-tabs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";
import { BudgetContextBar } from "./budget-context-bar";
import { AlerteAImputer } from "./alerte-a-imputer";
import { ancreCategorieBudget } from "@/lib/chemins/budgets";

/**
 * BUDGET REGULATORY — LA VUE D'ENSEMBLE SIMPLIFIÉE (maquette validée, Direction 10/2026 : « beaucoup trop complexe »).
 * Trois chiffres (budget, consommé, restant), une barre (consommé | engagé | libre), deux cartes BV 25 % / BV 75 %, et
 * le tableau des dossiers, replié. La courbe, les barres par catégorie et les « Prochains BV » sont partis.
 *
 * Le calcul est PUR et testé (`syntheseSimple`, `lib/budget-regulatory/synthese.ts`) : un BV 25 % engage tout le dossier
 * (× 4), et le rapprochement avec l'enveloppe y est expliqué. Même enveloppe et mêmes requêtes que `VueEnsembleBudget`.
 */

/** Le motif hachuré de l'engagé — la barre et sa légende. */
const HACHURE = {
  backgroundImage: "repeating-linear-gradient(135deg, hsl(var(--warning)) 0 3px, hsl(var(--warning) / 0.3) 3px 6px)",
} as const;

const PASTILLE: Record<Exclude<EtatBvSimple, "AUCUN">, { libelle: string; tone: "success" | "warning" | "info" }> = {
  PAYE: { libelle: "Payé", tone: "success" },
  DEMANDE: { libelle: "Demandé", tone: "warning" },
  ENGAGE: { libelle: "Engagé", tone: "info" },
};

export async function VueEnsembleRegulatory({ user, titre, overview, envelopes, tabs, exportHref, lienAImputer }: {
  user: CurrentUser;
  /** Le chemin du module (`/budget-regulatory`). */
  base: string;
  /** La liste « À imputer » de cette enveloppe, dans Budgets (`lienAImputerBudgets`) — `null` : l'alerte informe seulement. */
  lienAImputer: string | null;
  titre: string;
  overview: BudgetOverview;
  envelopes: BudgetEnvelopeOption[];
  tabs: ModuleTab[];
  exportHref: string;
}) {
  const vue = await vueBvParDossier(user, overview);
  const s = syntheseSimple(vue.lignes, overview.totals);

  const anneeDebut = overview.period.from.slice(0, 4);
  const anneeFin = overview.period.to.slice(0, 4);
  const exercice = anneeDebut === anneeFin ? anneeDebut : `${anneeDebut}–${anneeFin}`;

  return (
    <div className="space-y-5">
      <PageHeader title={titre} description={`Enveloppe ${exercice}`}>
        <a
          href={exportHref}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary sm:min-h-0 sm:px-2.5"
          title="Exporter en Excel"
        >
          <Download className="h-4 w-4" /> Exporter
        </a>
        <InfoBulle label="À propos du budget Regulatory">
          Regulatory gère le budget des bons de versement (BV) des dossiers d&apos;enregistrement : 25 % en préparation, 75 % avant le dépôt.
          Consommé : les BV réglés. Engagé : les BV demandés pas encore réglés, et le BV 75 % attendu de chaque dossier dont le 25 % existe.
        </InfoBulle>
      </PageHeader>
      <ModuleTabs tabs={tabs} />

      <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />

      {overview.unattributed.total > 0 && (
        <AlerteAImputer href={lienAImputer} total={overview.unattributed.total} action="Ranger">
          de dépenses ne sont rangées dans aucune catégorie.
        </AlerteAImputer>
      )}

      <section className="surface min-w-0 space-y-4 p-4 sm:p-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Chiffre titre={`Budget ${exercice}`} valeur={s.budget} />
          <Chiffre titre="Consommé" valeur={s.consomme} sous="BV réellement payés" />
          <Chiffre
            titre="Restant" valeur={s.restant} ton={s.restant < 0 ? "text-destructive" : "text-success"}
            sous={s.restant < 0 ? "dépassement" : "budget − consommé − engagé"}
          />
        </dl>

        <div className="space-y-2">
          <div
            className="flex h-4 w-full overflow-hidden rounded-full bg-secondary"
            role="img"
            aria-label={`Consommé ${formatCurrency(s.consomme)}, engagé ${formatCurrency(s.engage)}, libre ${formatCurrency(Math.max(0, s.restant))}`}
          >
            <div className="h-full bg-primary" style={{ width: `${s.barre.consomme}%` }} />
            <div className="h-full" style={{ ...HACHURE, width: `${s.barre.engage}%` }} />
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Legende pastille={<span className="h-2.5 w-2.5 rounded-sm bg-primary" />} libelle="Consommé" valeur={s.consomme} />
            <Legende pastille={<span className="h-2.5 w-2.5 rounded-sm" style={HACHURE} />} libelle="Engagé" valeur={s.engage} />
            <Legende pastille={<span className="h-2.5 w-2.5 rounded-sm border border-border bg-secondary" />} libelle="Libre" valeur={Math.max(0, s.restant)} />
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          Un BV 25 % engage tout le dossier : BV 25 % × 4 = frais d&apos;enregistrement. Dès qu&apos;un BV 25 % est demandé ou payé, les
          75 % restants (3 × BV 25 %) sont engagés — retirés du restant — jusqu&apos;au paiement du BV 75 %.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CarteBv
          id={vue.categories.bv25 ? ancreCategorieBudget(vue.categories.bv25.id) : undefined}
          titre="BV 25 %" sousTitre="préparation du dossier"
          lignes={[
            { libelle: "Payés", c: s.bv25.payes, ton: "text-success" },
            { libelle: "Demandés", c: s.bv25.demandes, ton: "text-warning" },
            { libelle: "Au total", c: s.bv25.total, fort: true },
          ]}
        />
        <CarteBv
          id={vue.categories.bv75 ? ancreCategorieBudget(vue.categories.bv75.id) : undefined}
          titre="BV 75 %" sousTitre="avant le dépôt"
          lignes={[
            { libelle: "Payés", c: s.bv75.payes, ton: "text-success" },
            { libelle: "Demandés", c: s.bv75.demandes, ton: "text-warning" },
            { libelle: "À venir (engagés)", c: s.bv75.aVenir, fort: true },
          ]}
        />
      </div>

      <details className="surface group min-w-0 overflow-hidden rounded-xl">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          Dossiers <span className="font-normal text-muted-foreground">({s.dossiers.length})</span>
        </summary>
        {s.dossiers.length === 0 ? (
          <p className="border-t border-border px-4 py-4 text-sm text-muted-foreground">Aucun BV sur la période.</p>
        ) : (
          <div className="border-t border-border text-sm">
            <div className={cn(COLONNES, "hidden border-b border-border bg-secondary/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid")}>
              <span>Dossier · produit</span>
              <span className="text-right">BV 25 %</span>
              <span className="text-right">BV 75 %</span>
              <span className="text-right">Frais totaux</span>
              <span className="text-right">Reste à payer</span>
            </div>
            <ul className="divide-y divide-border">
              {s.dossiers.map((d) => (
                <li key={d.dossierId}>
                  {vue.lienDossiers ? (
                    <Link
                      href={`/regulatory/${d.dossierId}`}
                      className="block px-4 py-3 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none"
                      title={`Ouvrir le dossier ${d.reference}`}
                    >
                      <LigneDossier d={d} lien />
                    </Link>
                  ) : (
                    <div className="px-4 py-3"><LigneDossier d={d} lien={false} /></div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </div>
  );
}

/** Les colonnes du tableau des dossiers (à partir de md ; en dessous, chaque dossier est une petite fiche). */
const COLONNES = "md:grid md:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] md:items-center md:gap-3";

function Chiffre({ titre, valeur, sous, ton = "" }: { titre: string; valeur: number; sous?: string; ton?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground sm:text-sm">{titre}</dt>
      <dd className={cn("break-words text-xl font-semibold tabular-nums tracking-tight lg:text-2xl", ton)}>{formatCurrency(valeur)}</dd>
      {sous && <dd className="text-xs text-muted-foreground">{sous}</dd>}
    </div>
  );
}

function Legende({ pastille, libelle, valeur }: { pastille: ReactNode; libelle: string; valeur: number }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      {pastille}
      <span className="text-muted-foreground">{libelle}</span>
      <span className="font-medium tabular-nums">{formatCurrency(valeur)}</span>
    </li>
  );
}

function CarteBv({ id, titre, sousTitre, lignes }: {
  id?: string;
  titre: string;
  sousTitre: string;
  lignes: { libelle: string; c: CompteMontant; ton?: string; fort?: boolean }[];
}) {
  return (
    <section id={id} className="surface min-w-0 scroll-mt-24 p-4">
      <h2 className="text-sm font-semibold">{titre} <span className="font-normal text-muted-foreground">· {sousTitre}</span></h2>
      <dl className="mt-3 space-y-2 text-sm">
        {lignes.map((l) => (
          <div key={l.libelle} className={cn("flex items-baseline justify-between gap-3", l.fort && "border-t border-border pt-2 font-semibold")}>
            <dt className="min-w-0">
              <span className={cn(!l.fort && "text-muted-foreground")}>{l.libelle}</span>
              <span className={cn("ml-1.5 tabular-nums", l.ton)}>{l.c.nombre}</span>
            </dt>
            <dd className="shrink-0 tabular-nums">{formatCurrency(l.c.montant)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CaseBv({ libelle, c }: { libelle: string; c: DossierSimple["bv25"] }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 md:items-end">
      <span className="text-xs text-muted-foreground md:hidden">{libelle}</span>
      <span className="tabular-nums">{c.montant !== null ? formatCurrency(c.montant) : "—"}</span>
      {c.etat !== "AUCUN" && <Badge tone={PASTILLE[c.etat].tone}>{PASTILLE[c.etat].libelle}</Badge>}
    </div>
  );
}

function LigneDossier({ d, lien }: { d: DossierSimple; lien: boolean }) {
  return (
    <div className={COLONNES}>
      <div className="flex min-w-0 items-center gap-1">
        <p className="min-w-0 truncate">
          <span className={cn("font-medium", lien && "text-primary")}>{d.reference}</span>
          <span className="text-muted-foreground"> · {d.produit}</span>
        </p>
        {lien && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground md:hidden" />}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 md:contents">
        <CaseBv libelle="BV 25 %" c={d.bv25} />
        <CaseBv libelle="BV 75 %" c={d.bv75} />
        <div className="flex min-w-0 flex-col items-start md:items-end">
          <span className="text-xs text-muted-foreground md:hidden">Frais totaux</span>
          <span className="tabular-nums">{d.fraisTotaux > 0 ? formatCurrency(d.fraisTotaux) : "—"}</span>
        </div>
        <div className="flex min-w-0 flex-col items-start md:items-end">
          <span className="text-xs text-muted-foreground md:hidden">Reste à payer</span>
          {d.resteAPayer > 0
            ? <span className="font-medium tabular-nums">{formatCurrency(d.resteAPayer)}</span>
            : <span className="font-medium text-success">{d.fraisTotaux > 0 ? "Soldé" : "—"}</span>}
        </div>
      </div>
    </div>
  );
}
