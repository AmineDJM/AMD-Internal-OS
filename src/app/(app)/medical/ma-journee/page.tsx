import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Plus, Users } from "lucide-react";
import { requireModule } from "@/lib/session";
import { signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { diagnostiquerPanelVide, loadEmploiDuTemps, loadJourneeDuDelegue } from "@/lib/queries/tour-schedule";
import { dernieresVisites, planDuJour } from "@/lib/queries/journee-delegue";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { stockPourVisite } from "@/lib/queries/promo-remises";
import { estVue, VUES, VUE_LABELS, type VueTournee } from "@/lib/sfe/tournee";
import { etatDuPlanPourJournee, fusionnerJournee, jourLocal } from "@/lib/sfe/journee-visite";
import { comptesRendusEnRetard } from "@/lib/sfe/compte-rendu-envoye";
import type { Lettre } from "@/lib/segmentation/regles";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { Tuile } from "@/components/shared/tuile";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn, formatDate } from "@/lib/utils";
import { EmploiDuTemps } from "./emploi-du-temps";
import { JourneeDelegue } from "./journee-delegue";
import { PrevenirSuperviseur } from "./prevenir-superviseur";
import type { LigneVue } from "./types-visite";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ma journée — Visite médicale — AMD Internal OS" };

/**
 * « MA JOURNÉE » — l'écran du DÉLÉGUÉ, au téléphone comme à l'ordinateur (refonte 11/2026, alignée le 24/11/2026 sur la
 * maquette VALIDÉE de l'interface du délégué).
 *
 * Il répond à UNE question — « qui je vois, et comment je le note ? » — dans l'ordre de la maquette :
 *   • l'en-tête : le jour, « + Visite hors plan », « Mon plan » ;
 *   • quatre chiffres qui mènent là où ils se travaillent (visites du jour, comptes rendus en retard, le sac, la
 *     couverture du panel) ;
 *   • les COMPTES RENDUS EN RETARD (la règle des 48 h), puis les visites du jour dans l'ordre de la tournée — un geste
 *     visible par visite, le reste dans ⋯ —, puis « À rattraper » ;
 *   • Demain, la semaine, le mois en onglets secondaires ;
 *   • un état vide qui dit toujours le remède (panel vide → sa cause et « Prévenir mon superviseur » ; pas de plan →
 *     « Préparer mon plan » ; plan soumis → chez qui, depuis quand).
 *
 * Ce n'est l'écran que du délégué : un superviseur, un manager ou la Direction qui l'ouvre par son adresse est
 * renvoyé là où `/medical` l'aurait mené (`aiguillerVisite`) — l'écran d'un autre métier ne lui dirait que « 0 / 0 ».
 */
export default async function MaJourneePage(props: { searchParams?: Promise<{ vue?: string; horsPlan?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  // LA VUE PAR DÉFAUT EST « AUJOURD'HUI » ; une vue inconnue dans l'adresse y retombe plutôt que de rendre une page vide.
  const vue: VueTournee = searchParams?.vue && estVue(searchParams.vue) ? searchParams.vue : "AUJOURD_HUI";
  const maintenant = new Date();
  const [day, edt, stock, plan] = await Promise.all([
    loadMyFieldDay(user.id, maintenant),
    vue === "AUJOURD_HUI" ? loadJourneeDuDelegue(user, maintenant) : loadEmploiDuTemps(user, vue, maintenant),
    stockPourVisite(user.id),
    planDuJour(user.id, maintenant),
  ]);
  const diagnostic = day.panelVide ? await diagnostiquerPanelVide(user.id) : null;
  const lignes: LigneVue[] = edt.lignes.map((l) => ({ ...l, date: l.date.toISOString() }));
  const gamme = { produits: edt.produits, produitsIncomplets: edt.produitsIncomplets, messages: edt.messages, sansBu: edt.sansBu };
  const lettres = new Map(day.frequences.map((f) => [f.doctorId, f.lettre as Lettre | null]));
  const panel = day.panel.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty, institution: d.institution, wilaya: d.wilaya, lettre: lettres.get(d.id) ?? null }));

  // LA LISTE DU JOUR, rangée ICI (heure du serveur, la même que les fenêtres de l'emploi du temps) : le navigateur
  // ne refait pas le tri, et l'écran rendu ne change pas à l'hydratation.
  const journee = fusionnerJournee({
    visites: lignes,
    rattrapages: day.tournee.map((t) => ({
      doctorId: t.doctorId, id: t.doctorId, name: t.name, specialty: t.specialty, institution: t.institution, wilaya: t.wilaya,
      lettre: (t.lettre ?? null) as Lettre | null, reason: t.reason, missing: t.missing,
    })),
    aujourdhui: jourLocal(maintenant),
  });
  const praticiensVus = vue === "AUJOURD_HUI"
    ? [...journee.aujourdhui.map((l) => l.doctorId), ...journee.aRattraper.map((r) => r.doctorId)]
    : lignes.map((l) => l.doctorId);
  const dernieres = await dernieresVisites(user.id, praticiensVus.filter((x): x is string => Boolean(x)));

  // LES CHIFFRES DU JOUR (maquette du délégué, 24/11) : la tournée du jour, les comptes rendus en retard, le sac, la
  // couverture du panel — chacun mène là où il se travaille.
  const retard = comptesRendusEnRetard(lignes, jourLocal(maintenant), (iso) => jourLocal(new Date(iso)));
  const duJour = journee.aujourdhui.filter((l) => !l.jourPasse);
  const enMain = stock.articles.filter((a) => a.distribuable > 0);
  const perimes = stock.articles.filter((a) => a.perime > 0).length;
  const jourLisible = maintenant.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const etatPlan = day.panelVide ? null : etatDuPlanPourJournee(
    plan ? { ...plan } : null, maintenant, journee.aujourdhui.some((l) => !l.jourPasse),
  );
  const precoches = day.produits.filter((p) => p.preselected).map((p) => p.productId);
  const peutSignalerPv = signaleDesCasPv(user);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Ma journée" description={jourLisible.charAt(0).toUpperCase() + jourLisible.slice(1)}>
        {vue === "AUJOURD_HUI" && !day.panelVide && (
          <Link href="/medical/ma-journee?horsPlan=1" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-secondary sm:h-9">
            <Plus className="h-4 w-4" aria-hidden /> Visite hors plan
          </Link>
        )}
        <Link href="/medical/plan-de-tournee" className="inline-flex h-10 items-center rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-secondary sm:h-9">
          Mon plan
        </Link>
      </PageHeader>
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />

      {/* ── LES CHIFFRES DU JOUR — chacun mène là où il se travaille ─────────────────────────── */}
      {vue === "AUJOURD_HUI" && (
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <a href="#visites-du-jour" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Tuile label="Visites du jour" valeur={`${duJour.filter((l) => l.etat === "FAITE").length} / ${duJour.length}`} contexte="Voir la liste" className="h-full" />
          </a>
          <Tuile
            label="Comptes rendus en retard" valeur={retard.ouverts.length} ton={retard.ouverts.length > 0 ? "danger" : "ok"}
            contexte={retard.fermes.length > 0 ? `${retard.fermes.length} non rapporté(s)` : "Règle des 48 h"}
            info={<InfoBulle label="La règle des 48 h" align="right">Un compte rendu s&apos;écrit dans les 48 h qui suivent la visite ; ensuite il ne s&apos;écrit plus et la visite reste non rapportée.</InfoBulle>}
          />
          <Link href="/medical/mon-sac" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Tuile label="Mon sac" valeur={`${enMain.length} article${enMain.length > 1 ? "s" : ""}`} ton={perimes > 0 ? "alerte" : "defaut"}
              contexte={perimes > 0 ? `${perimes} périmé(s) à déclarer` : "en main"} className="h-full" />
          </Link>
          <Link href="/medical/objectifs" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Tuile label="Couverture du panel (mois)" valeur={`${day.progress.coveragePct} %`} ton={day.progress.coveragePct >= 80 ? "ok" : "alerte"}
              contexte={`${day.progress.covered} / ${day.progress.panelSize} médecins vus · Mes objectifs`} className="h-full" />
          </Link>
        </div>
      )}

      {/* ── LES ONGLETS SECONDAIRES — Aujourd'hui d'abord, le reste se relit ─────────────────── */}
      <nav aria-label="Période" className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
        {VUES.map((v) => (
          <Link
            key={v}
            href={v === "AUJOURD_HUI" ? "/medical/ma-journee" : `/medical/ma-journee?vue=${v}`}
            aria-current={v === vue ? "page" : undefined}
            className={cn(
              "inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm sm:h-9",
              v === vue ? "bg-primary text-primary-foreground" : "border border-input hover:bg-secondary",
            )}
          >
            {VUE_LABELS[v]}
          </Link>
        ))}
      </nav>

      {/* ── CE QUI MANQUE SE DIT, AVEC SON REMÈDE ──────────────────────────────────────────── */}
      {diagnostic && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <p><strong>Aucun praticien dans votre panel.</strong> {diagnostic.phrase}</p>
          <PrevenirSuperviseur />
        </div>
      )}
      {etatPlan && (
        <div className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm", etatPlan.ton === "warning" ? "border-warning/40 bg-warning/10" : "border-border bg-secondary/40")}>
          <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">{etatPlan.texte}</span>
          {etatPlan.geste && (
            <Link href={etatPlan.geste.href} className="inline-flex min-h-10 items-center font-medium text-primary hover:underline sm:min-h-0">
              {etatPlan.geste.libelle}
            </Link>
          )}
        </div>
      )}

      {vue === "AUJOURD_HUI" ? (
        <JourneeDelegue
          personneId={user.id}
          aujourdhui={journee.aujourdhui}
          fermes={retard.fermes}
          ouvrirHorsPlan={searchParams?.horsPlan === "1" && !day.panelVide}
          aRattraper={journee.aRattraper}
          panel={panel}
          gamme={gamme}
          stock={stock}
          precoches={precoches}
          frequences={day.frequences}
          dernieres={dernieres}
          peutSignalerPv={peutSignalerPv}
        />
      ) : (
        <EmploiDuTemps
          vue={vue}
          lignes={lignes}
          gamme={gamme}
          stock={stock}
          peutSignalerPv={peutSignalerPv}
          dernieres={dernieres}
          frequences={day.frequences}
        />
      )}

      {/* LA PREUVE QUE LA SAISIE EST ARRIVÉE QUELQUE PART : sans retour visible, on doute, on ressaisit, et le compteur ment. */}
      {day.recentes.length > 0 && (
        <section className="space-y-2" aria-labelledby="titre-recentes">
          <h2 id="titre-recentes" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="h-4 w-4" aria-hidden /> Mes dernières visites
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {day.recentes.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{v.doctorName}</span>
                  {v.produits.length > 0 && <span className="block truncate text-xs text-muted-foreground">{v.produits.join(" · ")}</span>}
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
