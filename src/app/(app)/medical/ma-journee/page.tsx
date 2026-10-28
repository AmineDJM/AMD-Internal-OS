import { CalendarCheck, CalendarRange, Users } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import { lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { loadEmploiDuTemps } from "@/lib/queries/tour-schedule";
import { stockPourVisite, type StockPourVisite } from "@/lib/queries/promo-remises";
import { estVue, VUE_LABELS, type VueTournee } from "@/lib/sfe/tournee";
import { EmploiDuTemps } from "./emploi-du-temps";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { Card, CardContent } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { formatDate } from "@/lib/utils";
import { DayClient } from "./day-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ma journée — AMD Internal OS" };

/**
 * « MA JOURNÉE » — le seul écran dont un délégué a besoin.
 *
 * ── POURQUOI CET ÉCRAN EXISTE ───────────────────────────────────────────────────────────────
 *
 * Le pilotage de la force de vente était complet d'un bout : la Direction prévoit, on affecte
 * les produits, le cockpit compare planifié et réalisé. Mais l'écran de SAISIE du terrain avait
 * été retiré, et un cockpit sans réalisé pilote à l'aveugle — le « réalisé » venait de visites
 * que plus rien ne permettait d'enregistrer simplement.
 *
 * On ne rétablit donc pas l'ancien module : on écrit l'écran qui manquait vraiment. Il répond à
 * UNE question — « qui je vais voir, et comment je le note ? » — et il tient sur un téléphone.
 * Tout le reste (le panel entier, l'annuaire, les rapports) vit ailleurs et reste accessible.
 *
 * ── LA LIGNE DE CHIFFRES ────────────────────────────────────────────────────────────────────
 *
 * Quatre nombres, jamais plus : fait / attendu, la part du panel touchée, et le rythme à tenir
 * sur les jours ouvrés qui restent (semaine algérienne). Un cinquième ne serait plus lu. Ils ne
 * notent personne — ils disent à un homme où il en est de son propre mois.
 */
export default async function MaJourneePage(props: { searchParams?: Promise<{ vue?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const canLog = userCan(user, "MEDICAL", "CREATE");
  // LA VUE PAR DÉFAUT EST « AUJOURD'HUI » : c'est la question qu'un homme de terrain se pose en
  // montant dans sa voiture. Une vue inconnue dans l'adresse retombe dessus plutôt que de rendre
  // une page vide.
  const vue: VueTournee = searchParams?.vue && estVue(searchParams.vue) ? searchParams.vue : "AUJOURD_HUI";
  // LE MATÉRIEL EN MAIN n'est chargé que pour qui saisit des visites : c'est le bloc « Matériel
  // remis » du rapport qui le lit (§118.166), et un compte qui ne saisit rien n'en a pas l'usage.
  const sansStock: StockPourVisite = { articles: [], numeriques: [] };
  const [day, edt, stock] = await Promise.all([
    loadMyFieldDay(user.id),
    loadEmploiDuTemps(user, vue),
    canLog ? stockPourVisite(user.id) : Promise.resolve(sansStock),
  ]);
  const p = day.progress;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title={`Bonjour ${user.name.split(" ")[0]}`} />
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />

      {/* LA LIGNE DE CHIFFRES — grande, lisible d'un coup d'œil, en haut. */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-2xl font-semibold tabular-nums">
              {p.done} <span className="text-base font-normal text-muted-foreground">/ {p.target} visites ce mois</span>
            </p>
            <span className={`text-sm font-medium ${p.donePct >= 90 ? "text-success" : p.donePct >= 60 ? "text-warning" : "text-destructive"}`}>
              {p.donePct} %
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div className={`h-full rounded-full ${p.donePct >= 90 ? "bg-success" : "bg-primary"} transition-all`} style={{ width: `${Math.min(100, p.donePct)}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Panel couvert <strong className="text-foreground">{p.coveragePct} %</strong> ({p.covered}/{p.panelSize})
            {p.perDay > 0
              ? <> · <strong className="text-foreground">{p.perDay}/jour</strong> sur {p.workdaysLeft} jours restants</>
              : p.target > 0 ? " · objectif atteint" : ""}
          </p>
        </CardContent>
      </Card>

      {/* CE QUI MANQUE SE DIT — une page vide laisse croire à une panne, et l'on n'y revient pas. En une ligne
          « état — chez qui » ; le comment est derrière le ⓘ (Direction, 07/10). */}
      {day.panelVide && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">Aucun praticien rattaché — chez votre superviseur</span>
          <InfoBulle label="Pourquoi">
            Votre tournée ne peut pas se construire sans panel : votre superviseur vous affecte vos praticiens depuis l&apos;annuaire médical.
          </InfoBulle>
        </div>
      )}
      {!day.panelVide && day.sansAffectation && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">Aucun produit affecté ce cycle — chez votre superviseur</span>
          <InfoBulle label="Pourquoi">
            Vos visites s&apos;enregistrent, mais sans les produits présentés. Votre superviseur les affecte depuis Prévisions &amp; Force de vente.
          </InfoBulle>
        </div>
      )}

      {/* ── L'EMPLOI DU TEMPS — le plan de tournée VALIDÉ, jour par jour ─────────────────────
          C'est la surface de travail du KAM : gris tant que le rapport n'est pas fait, vert
          après. Elle vient AVANT la tournée proposée, parce qu'un engagement validé passe devant
          une suggestion. Le plan de tournée a son onglet : pas de second lien vers lui ici. */}
      {!canLog ? (
        <p className="text-sm text-muted-foreground">Vous n&apos;avez pas le droit de saisir des visites.</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarRange className="h-4 w-4" /> Mon emploi du temps — {VUE_LABELS[vue]}
            </h2>
            <EmploiDuTemps
              vue={vue}
              lignes={edt.lignes.map((l) => ({ ...l, date: l.date.toISOString() }))}
              avancement={edt.avancementDuMois}
              produits={edt.produits}
              produitsIncomplets={edt.produitsIncomplets}
              messages={edt.messages}
              sansBu={edt.sansBu}
              panel={day.panel.map((d) => ({ id: d.id, name: d.name }))}
              stock={stock}
              lienPv={signaleDesCasPv(user) ? lienSignalerPv() : null}
            />
          </section>

          {/* L'annuaire n'est plus un onglet du module : pas de lien « Mon panel » ici (Direction, 07/10). */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarCheck className="h-4 w-4" /> À voir en priorité
            </h2>
            <DayClient tournee={day.tournee} panel={day.panel} produits={day.produits} stock={stock} />
          </section>
        </>
      )}

      {/* LA PREUVE QUE LA SAISIE EST ARRIVÉE QUELQUE PART. Sans retour visible, on doute d'avoir
          enregistré, on ressaisit, et le compteur ment. */}
      {day.recentes.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="h-4 w-4" /> Mes dernières visites
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {day.recentes.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{v.doctorName}</span>
                  {v.produits.length > 0 && (
                    <span className="block truncate text-xs text-muted-foreground">{v.produits.join(" · ")}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDate(v.date.toISOString())}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
