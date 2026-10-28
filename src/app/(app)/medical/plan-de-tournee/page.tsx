import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CalendarRange } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import { prisma } from "@/lib/prisma";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { getAppSettings } from "@/lib/settings";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { clePaire, diagnostiquerPanelVide, loadPanelPlanifiable, loadPlanTournee, loadVisitesDuPlan } from "@/lib/queries/tour-schedule";
import { stockPourVisite, type StockPourVisite } from "@/lib/queries/promo-remises";
import { jourIso } from "@/lib/sfe/grille-tournee";
import {
  GRANULARITE_LABELS, STATUT_PLAN_LABELS, aResoumettre, accesAuPlan, clausePlansADecider, estJourOuvrePourTournee, gestesPossibles, periodeSuivante,
  retardDeSoumission, type StatutPlan,
} from "@/lib/sfe/tournee";
import { lireReglageTournee } from "@/lib/sfe/tournee-reglage";
import { isManagerOfUser } from "@/lib/departments";
import { canEditRep } from "@/lib/sfe";
import { OuvrirPlan } from "./ouvrir-plan";
import { Planificateur } from "./planificateur";
import { SupprimerPlan } from "./supprimer-plan";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan de tournée — AMD Internal OS" };

/**
 * LE PLAN DE TOURNÉE — l'écran où un KAM prépare son mois, et où son N+1 le tranche.
 *
 * ── DEUX PUBLICS, UN SEUL ÉCRAN ─────────────────────────────────────────────────────────────
 *
 * Le KAM y planifie ; le validateur y décide. Deux écrans auraient fait deux vérités sur l'état
 * d'un plan, et le validateur aurait tranché sur une liste qu'il ne peut pas déplier. Ce que
 * chacun peut FAIRE vient du module pur (`gestesPossibles`) et des droits — pas de la route.
 *
 * ── LA LISTE DES PLANS À DÉCIDER N'EST PAS UNE PROMESSE D'ÉCRAN ─────────────────────────────
 *
 * Un plan soumis qu'aucun écran ne montre reste soumis pour toujours, et le KAM attend une
 * décision que personne ne sait devoir prendre (§118.50). La liste « à décider » est donc là,
 * chargée sur `reviewerId` / `escalatedToId` — les deux colonnes que l'action écrit.
 */
export default async function PlanDeTourneePage(props: { searchParams?: Promise<{ plan?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  // LE RÉGLAGE VIENT DU LECTEUR UNIQUE — le même que l'action qui ouvre un plan et que le
  // tableau de bord de la Direction (§118.5).
  const [settings, reglage] = await Promise.all([getAppSettings(), lireReglageTournee()]);
  const granularite = reglage.granularite;
  const maintenant = new Date();
  const retardDe = (p: { status: string; submissionDueAt: Date; resubmitDueAt: Date | null }) =>
    retardDeSoumission({ statut: p.status as StatutPlan, echeance: p.submissionDueAt, resoumissionAvant: p.resubmitDueAt, maintenant });

  // ── CE QUI M'ATTEND, MOI — et l'absent que je remplace (I18) ──────────────────────────────
  const agitPour = await standInForUserIds(user.id);
  const [mesPlans, aDecider] = await Promise.all([
    prisma.tourPlan.findMany({
      where: { repId: user.id },
      orderBy: { periodStart: "desc" },
      take: 8,
      select: {
        id: true, periodStart: true, periodEnd: true, status: true, submissionDueAt: true, resubmitDueAt: true,
        _count: { select: { visits: true } },
      },
    }),
    prisma.tourPlan.findMany({
      where: {
        OR: [
          // CE QUI ATTEND MA DÉCISION, OU CELLE DE L'ABSENT QUE JE REMPLACE — jamais mon propre plan (`accesAuPlan`
          // le refuse). La clause de « Mon espace » (lot E2) : deux copies de la même file finiraient par diverger.
          clausePlansADecider(user.id, agitPour),
          // UNE VUE GLOBALE VOIT TOUT CE QUI ATTEND : sans cette branche, un plan dont le
          // validateur a quitté l'entreprise n'apparaîtrait sur aucun écran et resterait soumis
          // pour toujours — le KAM attendant une décision que personne ne sait devoir prendre.
          ...(hasGlobalView(user) ? [{ status: { in: ["SUBMITTED" as const, "ESCALATED" as const] } }] : []),
        ],
      },
      orderBy: { submittedAt: "asc" },
      take: 20,
      select: {
        id: true, periodStart: true, periodEnd: true, status: true, submittedAt: true,
        rep: { select: { name: true } }, _count: { select: { visits: true } },
      },
    }),
  ]);

  const planId = searchParams?.plan ?? null;
  const plan = planId ? await loadPlanTournee(planId) : null;
  // QUI VOIT CE PLAN (§118.184) — la même règle que les actions. Un plan porte le panel du KAM et le
  // motif d'un rejet : sans cette garde, quiconque avait le module et l'identifiant l'ouvrait.
  // Hors de la règle, la page répond comme pour un plan qui n'existe pas.
  const acces = plan
    ? accesAuPlan({
      userId: user.id, vueGlobale: hasGlobalView(user), repId: plan.repId,
      reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan,
      // La chaîne n'est lue que si rien d'autre n'ouvre le plan : une lecture de l'organigramme en moins
      // pour le KAM, son validateur et le N+2.
      chaineDuKam: plan.repId === user.id || plan.reviewerId === user.id || plan.escalatedToId === user.id || hasGlobalView(user)
        ? []
        : (await isManagerOfUser(user.id, plan.repId)) ? [user.id] : [],
      agitPour,
    })
    : null;
  if (plan && !acces?.voir) notFound();
  const panel = plan ? await loadPanelPlanifiable(plan.repId) : [];
  // UN PANEL VIDE DIT SA VRAIE CAUSE (04/10/2026) : « demandez un secteur » à une KAM qui en a un fait
  // chercher au mauvais endroit — la panne était souvent des fiches jamais rattachées à l'établissement.
  const panelVide = plan && panel.length === 0 ? (await diagnostiquerPanelVide(plan.repId)).phrase : null;
  // QUI PEUT ÉCRIRE CE PLAN — donc le rouvrir pour révision (§118.193) : la même règle que l'action
  // (`peutEcrirePourLeKam` : le KAM, le superviseur de sa BU, la Direction). Un bouton offert à qui l'action
  // refuse fait chercher une panne qui n'existe pas (§118.83).
  const jePeuxEcrire = plan ? plan.repId === user.id || (await canEditRep(user, plan.repId)) : false;
  // LA GRILLE OUVRE LE RAPPORT DE LA VISITE (Direction, 06/10) — pour le KAM lui-même, qui saisit ses visites : c'est
  // son stock qui sort et son compte rendu. Les visites se lisent comme « Ma journée » les lit (`loadVisitesDuPlan`).
  const peutRapporter = plan ? plan.repId === user.id && userCan(user, "MEDICAL", "CREATE") : false;
  const sansStock: StockPourVisite = { articles: [], numeriques: [] };
  const [visitesDuPlan, stock] = plan
    ? await Promise.all([loadVisitesDuPlan(plan.id, plan.repId), peutRapporter ? stockPourVisite(user.id) : Promise.resolve(sansStock)])
    : [null, sansStock];

  // LES JOURS OUVRÉS DE LA PÉRIODE — la semaine ouvrée algérienne (dimanche → jeudi). Proposer
  // un vendredi ferait planifier un jour où personne ne sort, et la soumission le refuserait.
  const joursOuvres: string[] = [];
  if (plan) {
    for (const d = new Date(plan.periodStart); d <= plan.periodEnd; d.setDate(d.getDate() + 1)) {
      if (estJourOuvrePourTournee(d)) {
        joursOuvres.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
    }
  }

  const suivante = periodeSuivante(granularite, new Date());
  const canPlan = userCan(user, "MEDICAL", "CREATE");

  return (
    <div className={`mx-auto ${plan ? "max-w-6xl" : "max-w-5xl"} space-y-5`}>
      <PageHeader title="Plan de tournée" />
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />

      {plan ? (
        <>
          <Link href="/medical/plan-de-tournee" className="inline-flex min-h-10 items-center gap-1 text-sm text-primary hover:underline sm:min-h-8">
            ← Tous les plans
          </Link>
          <Planificateur
            planId={plan.id}
            repName={plan.repName}
            status={plan.status as StatutPlan}
            periodStart={plan.periodStart.toISOString()}
            periodEnd={plan.periodEnd.toISOString()}
            joursOuvres={joursOuvres}
            submittedAt={plan.submittedAt?.toISOString() ?? null}
            retard={{ enRetard: plan.retard.enRetard, jours: plan.retard.jours, echeance: plan.retard.echeance.toISOString() }}
            reviewerName={plan.reviewerName}
            escalatedToName={plan.escalatedToName}
            rejectionComment={plan.rejectionComment}
            resubmitDueAt={plan.resubmitDueAt?.toISOString() ?? null}
            praticiens={panel}
            panelVide={panelVide}
            pairesInitiales={plan.paires}
            pairesAcquises={plan.pairesAcquises}
            pairesNonTenues={plan.pairesNonTenues}
            pairesPassees={plan.pairesPassees}
            revisionNote={plan.revisionNote}
            revisionPar={plan.revisionPar}
            revisionLe={plan.revisionLe?.toISOString() ?? null}
            jePeuxDemanderRevision={jePeuxEcrire}
            jeSuisLeKam={plan.repId === user.id}
            // QUI TRANCHE : le validateur tant que le plan est chez lui, le N+2 dès qu'il est
            // escaladé. L'action le revérifie — l'écran ne fait que ne pas proposer l'impossible.
            // LA MÊME RÈGLE QUE L'ACTION (§118.184) : sur un plan ESCALADÉ, c'est le N+2 qui tranche — l'ancien
            // test ne proposait la décision que sur un plan soumis, et le N+2 restait sans bouton.
            jePeuxDecider={acces?.decider ?? false}
            jePeuxEscalader={acces?.escalader ?? false}
            aujourdhui={jourIso(new Date())}
            dejaValide={plan.dejaValide}
            lignes={(visitesDuPlan?.lignes ?? [])
              .filter((l) => l.doctorId)
              .map((l) => ({ ...l, date: l.date.toISOString(), cle: clePaire(l.date, l.doctorId!) }))}
            gamme={{
              produits: visitesDuPlan?.produits ?? [], produitsIncomplets: visitesDuPlan?.produitsIncomplets ?? [],
              messages: visitesDuPlan?.messages ?? [], sansBu: visitesDuPlan?.sansBu ?? true,
            }}
            stock={stock}
            peutRapporter={peutRapporter}
            peutSignalerPv={peutRapporter && signaleDesCasPv(user)}
          />
        </>
      ) : (
        <>
          {/* ── LES PLANS QUI ATTENDENT MA DÉCISION ─────────────────────────── */}
          {aDecider.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                À décider ({aDecider.length})
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-warning/40">
                {aDecider.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{p.rep.name}</span>
                    <span className="text-muted-foreground">
                      {p.periodStart.toLocaleDateString("fr-FR")} → {p.periodEnd.toLocaleDateString("fr-FR")}
                    </span>
                    <Badge tone="warning">{STATUT_PLAN_LABELS[p.status as StatutPlan]}</Badge>
                    <span className="text-xs text-muted-foreground">{p._count.visits} visite(s)</span>
                    <Link href={`/medical/plan-de-tournee?plan=${p.id}`} className="ml-auto inline-flex min-h-10 items-center gap-1 text-primary hover:underline sm:min-h-0">
                      Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── MES PLANS ───────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <CalendarRange className="h-4 w-4" /> Mes plans de tournée
                {/* CE QUE LE SUPER ADMIN A RÉGLÉ, derrière le ⓘ : sans cela, un KAM qui voit une période
                    trimestrielle croit à un bug — mais ce n'est pas un paragraphe permanent (Direction, 07/10). */}
                <InfoBulle label="Maille et échéance" align="left" className="normal-case tracking-normal">
                  Maille : <strong>{GRANULARITE_LABELS[granularite]}</strong>, réglée par le Super Admin (Force de vente ›
                  Paramètres). L&apos;échéance de soumission tombe {reglage.joursAvant} jour(s) avant la fin du mois qui
                  précède la période, ramenée au dernier jour ouvré.
                </InfoBulle>
              </h2>
              {canPlan && (
                <OuvrirPlan
                  granularite={granularite}
                  labelPeriodeSuivante={`${suivante.debut.toLocaleDateString("fr-FR")} → ${suivante.fin.toLocaleDateString("fr-FR")}`}
                  dateSuivante={suivante.debut.toISOString().slice(0, 10)}
                />
              )}
            </div>
            {mesPlans.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Aucun plan de tournée.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {mesPlans.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium tabular-nums">
                      {p.periodStart.toLocaleDateString("fr-FR")} → {p.periodEnd.toLocaleDateString("fr-FR")}
                    </span>
                    <Badge tone={p.status === "APPROVED" ? "success" : p.status === "REJECTED" ? "danger" : p.status === "DRAFT" ? "neutral" : "warning"}>
                      {STATUT_PLAN_LABELS[p.status as StatutPlan]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{p._count.visits} visite(s)</span>
                    {/* L'ÉCHÉANCE SE LIT — avant comme après son passage. « À soumettre avant le »
                        affiché sur un plan en retard de vingt jours est une date décorative. */}
                    {gestesPossibles(p.status as StatutPlan).soumettable && (() => {
                      const r = retardDe(p);
                      return r.enRetard ? (
                        <span className="text-xs font-medium text-destructive">
                          en retard de {r.jours} j — échéance dépassée le {r.echeance.toLocaleDateString("fr-FR")}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          à {aResoumettre(p.status as StatutPlan) ? "resoumettre" : "soumettre"} avant le {r.echeance.toLocaleDateString("fr-FR")}
                        </span>
                      );
                    })()}
                    <span className="ml-auto inline-flex flex-wrap items-center gap-3">
                      {/* SEUL UN BROUILLON SE SUPPRIME — le KAM propriétaire ou le Super Admin (l'action revérifie). */}
                      {p.status === "DRAFT" && canPlan && <SupprimerPlan planId={p.id} />}
                      <Link href={`/medical/plan-de-tournee?plan=${p.id}`} className="inline-flex min-h-10 items-center gap-1 text-primary hover:underline sm:min-h-0">
                        Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* UN RÉGLAGE MANQUANT QUI BLOQUE LES RAPPORTS se dit en une ligne « état — chez qui ». */}
          {settings.promoMessageAuthorRoles.length === 0 && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <span className="min-w-0 flex-1">Messages Marketing non autorisés — chez le Super Admin</span>
              <InfoBulle label="Pourquoi">
                Aucun rôle n&apos;est encore autorisé à publier les messages de la Direction Marketing : les rapports terrain
                les exigent, et ils seront refusés tant que le référentiel est vide.
              </InfoBulle>
            </p>
          )}
        </>
      )}
    </div>
  );
}
