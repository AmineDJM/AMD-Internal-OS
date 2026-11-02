import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays, CheckCheck, Clock, MapPin, Video } from "lucide-react";
import { requireModule } from "@/lib/session";
import { peutVoirAdam } from "@/lib/rbac";
import { featureEnabled, FEATURES } from "@/lib/features";
import { getToday, type TodayItem } from "@/lib/queries/today";
import { getDailyBrief } from "@/lib/daily-brief";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { MorningBrief } from "@/components/shared/morning-brief";
import { formatDate, daysUntil } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * Écran d'accueil « Aujourd'hui ». Une question, une réponse : *que dois-je faire maintenant ?*
 * Une seule action mise en avant, quelques suivantes, le reste replié — le classement vient de
 * `getToday`, qui ne lit que ce que la personne a déjà le droit de voir.
 */
export default async function TodayPage() {
  const user = await requireModule("WORKSPACE");
  if (!(await featureEnabled(FEATURES.HOME_TODAY.key, user.id))) redirect("/mon-espace");

  const today = await getToday(user);
  // Point du matin (nouveauté indépendante) : l'assistant résume la journée en 3-5 phrases.
  const proactive = !user.impersonatedBy && (await featureEnabled(FEATURES.ASSISTANT_PROACTIVE.key, user.id));
  // LE BRIEF DU MATIN EST ADAM (§118.153) : il n'est composé — donc payé — que pour qui le voit.
  const brief = proactive && peutVoirAdam(user) ? await getDailyBrief(user).catch(sansBloquer("aujourdhui-page.TodayPage.getDailyBrief", null)) : null;
  const dayLabel = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Algiers",
  }).format(new Date());

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-sm capitalize text-muted-foreground">{dayLabel}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {today.greeting} {user.name.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          {today.counts.total === 0
            ? "Rien ne vous attend — profitez-en."
            : today.counts.total === 1
              ? "Une seule chose vous attend."
              : `${today.counts.total} choses vous attendent. Commencez par celle-ci.`}
        </p>
      </header>

      {brief?.text && <MorningBrief initial={brief.text} />}

      {today.focus ? <FocusCard item={today.focus} /> : (
        <EmptyState icon="CheckCheck" title="Tout est à jour 🎉" description="Aucune action en attente. L'assistant vous préviendra dès qu'il y aura du nouveau." />
      )}

      {today.next.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ensuite</h2>
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {today.next.map((i) => <NextRow key={i.key} item={i} />)}
              </ul>
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            {today.restCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                +{today.restCount} autre{today.restCount > 1 ? "s" : ""} en attente
              </span>
            ) : <span />}
            <Link href="/mon-espace" className="inline-flex items-center gap-1 py-1.5 text-sm text-primary hover:underline">
              Tout voir <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </section>
      )}

      {today.agenda.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Votre journée</h2>
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {today.agenda.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-12 shrink-0 text-sm font-medium tabular-nums">
                      {e.allDay ? "Jour" : e.timeLabel}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{e.title}</p>
                      <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        {e.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">{e.location}</span></span>}
                        {e.meetLink && <span className="inline-flex shrink-0 items-center gap-1"><Video className="h-3 w-3" />Visio</span>}
                        {!e.location && !e.meetLink && <span className="truncate">{e.organizerName}</span>}
                      </p>
                    </div>
                    <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <div className="flex justify-end">
            <Link href="/calendar" className="inline-flex items-center gap-1 py-1.5 text-sm text-primary hover:underline">
              Mon calendrier <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </section>
      )}

      {today.counts.total === 0 && today.agenda.length === 0 && (
        <p className="flex items-center justify-center gap-2 pt-2 text-sm text-muted-foreground">
          <CheckCheck className="h-4 w-4" /> Aucun rendez-vous aujourd'hui.
        </p>
      )}
    </div>
  );
}

/** L'action mise en avant : grande, une seule, avec la raison de sa présence. */
function FocusCard({ item }: { item: TodayItem }) {
  const d = item.deadline ? daysUntil(item.deadline) : null;
  const late = item.reason === "overdue";
  return (
    <Link
      href={item.href}
      className={`group block rounded-2xl border p-4 transition hover:shadow-md sm:p-5 ${late ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={late ? "danger" : item.reason === "blocking" ? "warning" : "info"} dot={false}>{item.reasonLabel}</Badge>
        <span className="text-xs text-muted-foreground">{item.module}</span>
      </div>
      <h2 className="mt-2.5 break-words text-lg font-semibold leading-snug">{item.title}</h2>
      {item.subtitle && <p className="mt-0.5 break-words text-sm text-muted-foreground">{item.subtitle}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition group-hover:brightness-110">
          Ouvrir <ArrowRight className="h-4 w-4" />
        </span>
        {item.deadline && (
          <span className={`inline-flex items-center gap-1 text-xs ${late ? "font-medium text-destructive" : "text-muted-foreground"}`}>
            <Clock className="h-3.5 w-3.5" />
            {formatDate(item.deadline)}
            {late ? " · en retard" : d === 0 ? " · aujourd'hui" : ""}
          </span>
        )}
        {item.owner && <span className="text-xs text-muted-foreground">{item.owner}</span>}
      </div>
    </Link>
  );
}

function NextRow({ item }: { item: TodayItem }) {
  return (
    <li>
      <Link href={item.href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {item.reasonLabel} · {item.module}
            {item.subtitle ? ` · ${item.subtitle}` : ""}
          </p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
