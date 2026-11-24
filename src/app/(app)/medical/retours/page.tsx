import Link from "next/link";
import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { lecteurCoaching } from "@/lib/coaching/serveur";
import { listerFichesVisibles } from "@/lib/coaching/fiches";
import { FENETRE_RELECTURE_JOURS, appelleUnHumain } from "@/lib/sfe/rapport-visite";
import { STATUT_PLAN_LABELS, type StatutPlan } from "@/lib/sfe/tournee";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Badge } from "@/components/ui/badge";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Retours du superviseur — Visite médicale — AMD Internal OS" };

const JOUR_MS = 86_400_000;
const jour = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

const TON_PLAN: Record<StatutPlan, "success" | "danger" | "warning" | "info" | "neutral"> = {
  APPROVED: "success", REJECTED: "danger", REVISION: "warning", SUBMITTED: "info", ESCALATED: "info", DRAFT: "neutral",
};

/**
 * « RETOURS DU SUPERVISEUR » (interface du délégué, maquette VALIDÉE le 24/11/2026) — UNE boîte pour ce que le
 * superviseur dit au délégué, lu où il est déjà écrit :
 *   • les RELECTURES de ses comptes rendus (`reluLe`, le mot `reluCommentaire` — `relireRapportVisite`), celles qu'il a
 *     relues en priorité parce que l'IA y voyait un possible cas ;
 *   • ses fiches de COACHING finalisées (la tournée en double, sa note, ce qu'il y a à travailler) ;
 *   • ce qui a été dit de ses PLANS DE TOURNÉE (validé, rejeté avec son commentaire, rouvert).
 * DECISIONS (24/11) : pas de « demander un complément » — la relecture ne renvoie pas le rapport.
 */
export default async function RetoursSuperviseurPage() {
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  const maintenant = new Date();
  const depuis = new Date(maintenant.getTime() - 60 * JOUR_MS);
  const [relus, enAttente, plans, coaching, tabs] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: { delegateId: user.id, reluLe: { not: null, gte: depuis } },
      orderBy: { reluLe: "desc" },
      take: 30,
      select: {
        id: true, date: true, reluLe: true, reluParId: true, reluCommentaire: true, pvIa: true, doctorId: true,
        doctor: { select: { name: true } }, _count: { select: { casPharmacovigilance: true } },
      },
    }),
    prisma.medicalVisit.count({
      where: {
        delegateId: user.id, status: "COMPLETED", report: { not: null }, reluLe: null,
        date: { gte: new Date(maintenant.getTime() - FENETRE_RELECTURE_JOURS * JOUR_MS) },
      },
    }),
    prisma.tourPlan.findMany({
      where: { repId: user.id, OR: [{ decidedAt: { not: null } }, { rejectionComment: { not: null } }, { status: "REVISION" }] },
      orderBy: { periodStart: "desc" },
      take: 4,
      select: { id: true, periodStart: true, periodEnd: true, status: true, rejectionComment: true, decidedAt: true, decidedBy: { select: { name: true } } },
    }),
    lecteurCoaching(user).then((l) => listerFichesVisibles(l, { collaboratorId: user.id, statut: "FINALIZED", limite: 3 })),
    visibleTabs(user, MEDICAL_TABS),
  ]);
  const relecteurIds = [...new Set(relus.flatMap((v) => (v.reluParId ? [v.reluParId] : [])))];
  const relecteurs = new Map(
    relecteurIds.length ? (await prisma.user.findMany({ where: { id: { in: relecteurIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]) : [],
  );
  const rien = relus.length === 0 && plans.length === 0 && coaching.fiches.length === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Retours du superviseur" />
      <ModuleTabs tabs={tabs} />

      {rien && (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Aucun retour pour l&apos;instant. Les relectures de vos comptes rendus, vos fiches de coaching et les décisions sur vos plans arriveront ici.
        </p>
      )}

      <section aria-labelledby="t-relu" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pb-1 pt-3 sm:px-4">
          <h2 id="t-relu" className="text-base font-semibold">Relectures de vos comptes rendus</h2>
          {enAttente > 0 && <span className="text-xs text-muted-foreground">{enAttente} en attente de relecture</span>}
        </div>
        {relus.length === 0 ? (
          <p className="px-3 pb-3 text-sm text-muted-foreground sm:px-4">Aucune relecture ces deux derniers mois.</p>
        ) : (
          <ul className="divide-y divide-border">
            {relus.map((v) => {
              const prioritaire = appelleUnHumain(v.pvIa) || v._count.casPharmacovigilance > 0;
              return (
                <li key={v.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-3 sm:px-4">
                  <span className="min-w-0 flex-1 basis-60 text-sm">
                    {v.doctorId
                      ? <Link href={`/praticiens/${v.doctorId}`} className="font-medium hover:underline">{v.doctor?.name ?? "Praticien"}</Link>
                      : <span className="font-medium">{v.doctor?.name ?? "Praticien"}</span>}
                    <span className="text-muted-foreground"> · visite du {jour(v.date)}</span>
                    <span className="mt-0.5 block [overflow-wrap:anywhere]">{v.reluCommentaire ? `« ${v.reluCommentaire} »` : "Relu, sans commentaire."}</span>
                    <span className="block text-xs text-muted-foreground">
                      {v.reluParId ? relecteurs.get(v.reluParId) ?? "Votre superviseur" : "Votre superviseur"}{v.reluLe ? `, le ${jour(v.reluLe)}` : ""}
                    </span>
                  </span>
                  <Badge tone={prioritaire ? "danger" : "success"}>{prioritaire ? "Priorité PV" : "Relu"}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {coaching.fiches.length > 0 && (
        <section aria-labelledby="t-coach" className="overflow-hidden rounded-xl border border-border bg-card">
          <h2 id="t-coach" className="px-3 pb-1 pt-3 text-base font-semibold sm:px-4">Coaching · tournées en double</h2>
          <ul className="divide-y divide-border">
            {coaching.fiches.map((f) => (
              <li key={f.id}>
                <Link href={`/medical/coaching/${f.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-3 hover:bg-secondary/50 sm:px-4">
                  <span className="text-2xl font-semibold tabular-nums">{f.total !== null && f.max !== null ? `${f.total} / ${f.max}` : "—"}</span>
                  <span className="min-w-0 flex-1 basis-60 text-sm">
                    <span className="font-medium">Tournée du {jour(f.visitDate)}</span>{f.manager ? <span className="text-muted-foreground"> · {f.manager}</span> : null}
                    {f.improvements && <span className="mt-0.5 block text-muted-foreground [overflow-wrap:anywhere]">À travailler : {f.improvements}</span>}
                  </span>
                  <span className="text-sm font-medium text-primary">Ouvrir la fiche</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plans.length > 0 && (
        <section aria-labelledby="t-plans" className="overflow-hidden rounded-xl border border-border bg-card">
          <h2 id="t-plans" className="px-3 pb-1 pt-3 text-base font-semibold sm:px-4">Sur vos plans de tournée</h2>
          <ul className="divide-y divide-border">
            {plans.map((p) => (
              <li key={p.id}>
                <Link href={`/medical/plan-de-tournee?plan=${encodeURIComponent(p.id)}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 hover:bg-secondary/50 sm:px-4">
                  <span className="min-w-0 flex-1 basis-60 text-sm">
                    <span className="font-medium">Plan du {jour(p.periodStart)} au {jour(p.periodEnd)}</span>
                    <span className="mt-0.5 block text-muted-foreground [overflow-wrap:anywhere]">
                      {p.rejectionComment ? `« ${p.rejectionComment} »` : p.decidedAt ? `${p.decidedBy?.name ?? "Décidé"}, le ${jour(p.decidedAt)} — sans commentaire.` : "Pas encore de retour."}
                    </span>
                  </span>
                  <Badge tone={TON_PLAN[p.status as StatutPlan] ?? "neutral"}>{STATUT_PLAN_LABELS[p.status as StatutPlan] ?? p.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
