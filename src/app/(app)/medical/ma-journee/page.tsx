import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Users } from "lucide-react";
import { requireModule } from "@/lib/session";
import { signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { diagnostiquerPanelVide, loadEmploiDuTemps, loadJourneeDuDelegue } from "@/lib/queries/tour-schedule";
import { dernieresVisites, planDuJour } from "@/lib/queries/journee-delegue";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { stockPourVisite } from "@/lib/queries/promo-remises";
import { estVue, VUES, VUE_LABELS, type VueTournee } from "@/lib/sfe/tournee";
import { etatDuPlanPourJournee, fusionnerJournee, jourLocal, ligneDeChiffres } from "@/lib/sfe/journee-visite";
import type { Lettre } from "@/lib/segmentation/regles";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatDate } from "@/lib/utils";
import { EmploiDuTemps } from "./emploi-du-temps";
import { JourneeDelegue } from "./journee-delegue";
import { PrevenirSuperviseur } from "./prevenir-superviseur";
import type { LigneVue } from "./types-visite";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ma journée — Visite médicale — AMD Internal OS" };

/**
 * « MA JOURNÉE » — l'écran du DÉLÉGUÉ, au téléphone comme à l'ordinateur (refonte 11/2026).
 *
 * Il répond à UNE question — « qui je vois, et comment je le note ? » :
 *   • UNE ligne de chiffres (le plan validé du mois, `ligneDeChiffres`) ;
 *   • UNE liste « Aujourd'hui » (l'emploi du temps du jour, puis « À rattraper »), et UN geste plein sur la prochaine
 *     visite, « Commencer la visite » ;
 *   • Demain, la semaine, le mois en onglets secondaires ;
 *   • un état vide qui dit toujours le remède (panel vide → sa cause et « Prévenir mon superviseur » ; pas de plan →
 *     « Préparer mon plan » ; plan soumis → chez qui, depuis quand).
 *
 * Ce n'est l'écran que du délégué : un superviseur, un manager ou la Direction qui l'ouvre par son adresse est
 * renvoyé là où `/medical` l'aurait mené (`aiguillerVisite`) — l'écran d'un autre métier ne lui dirait que « 0 / 0 ».
 */
export default async function MaJourneePage(props: { searchParams?: Promise<{ vue?: string }> }) {
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
  const panel = day.panel.map((d) => ({ ...d, lettre: lettres.get(d.id) ?? null }));

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

  const chiffres = ligneDeChiffres(edt.avancementDuMois, day.progress);
  const etatPlan = day.panelVide ? null : etatDuPlanPourJournee(
    plan ? { ...plan } : null, maintenant, journee.aujourdhui.some((l) => !l.jourPasse),
  );
  const precoches = day.produits.filter((p) => p.preselected).map((p) => p.productId);
  const peutSignalerPv = signaleDesCasPv(user);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`Bonjour ${user.name.split(" ")[0]}`} />
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />

      {/* ── LA LIGNE DE CHIFFRES — UN seul compteur « ce mois », celui du plan validé ─────────── */}
      <Card>
        <CardContent className="p-4">
          <p className="text-2xl font-semibold tabular-nums">
            {chiffres.fait}
            {chiffres.sur !== null && <span className="text-base font-normal text-muted-foreground"> / {chiffres.sur}</span>}
            <span className="text-base font-normal text-muted-foreground"> {chiffres.libelle}</span>
          </p>
          {chiffres.sur !== null && (
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
              <div className={cn("h-full rounded-full transition-all", chiffres.pct >= 90 ? "bg-success" : "bg-primary")} style={{ width: `${Math.min(100, chiffres.pct)}%` }} />
            </div>
          )}
          {chiffres.sousTexte.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{chiffres.sousTexte.join(" · ")}</p>}
        </CardContent>
      </Card>

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
        <section className="space-y-3" aria-labelledby="titre-jour">
          <h2 id="titre-jour" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Aujourd&apos;hui</h2>
          {journee.aujourdhui.length === 0 && journee.aRattraper.length === 0 && !day.panelVide && (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Rien de prévu aujourd&apos;hui.
            </p>
          )}
          <JourneeDelegue
            personneId={user.id}
            aujourdhui={journee.aujourdhui}
            aRattraper={journee.aRattraper}
            panel={panel}
            gamme={gamme}
            stock={stock}
            precoches={precoches}
            frequences={day.frequences}
            dernieres={dernieres}
            peutSignalerPv={peutSignalerPv}
          />
        </section>
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
