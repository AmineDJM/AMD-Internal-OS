import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getEvents, getAdProCreateData } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Badge } from "@/components/ui/badge";
import { EVENT_TYPE, EVENT_FORMAT, EVENT_STATUS, EVENTS_TABS } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { CreateEventButton } from "./event-form";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const user = await requireModule("EVENTS");
  const canCreate = userCan(user, "EVENTS", "CREATE");
  // LES RÉFÉRENTIELS DU FORMULAIRE — le MÊME chargeur que le panneau commun d'Ad & Pro, appelé
  // avec la seule nature de cet écran. Recopier ici les quatre requêtes (annuaire, produits au
  // traitement terminé, spécialités, gammes) ferait un second chargeur qui prendrait du retard
  // au premier référentiel ajouté (§118.5) — et ce sont exactement les menus que la Direction
  // vient de rendre obligatoires : sans eux, chacun retombe sur sa saisie libre.
  //
  // Chargés SEULEMENT si la personne peut créer : la lecture coûte quatre requêtes, et un écran
  // en lecture seule n'ouvre aucun formulaire.
  const [events, responsibles, adPro] = await Promise.all([
    getEvents(user.id),
    canCreate ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    canCreate ? getAdProCreateData(user.id, ["EVENT"]) : Promise.resolve(null),
  ]);

  const upcoming = events.filter((e) => e.startDate && new Date(e.startDate) >= new Date() && e.status !== "CANCELLED").length;
  const totalReg = events.reduce((a, e) => a + e.registrations, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Events" description="Événements externes — staffs, webinaires, congrès et journées d'autres organisateurs.">
        {canCreate && (
          <CreateEventButton
            responsibles={responsibles}
            referentiels={adPro ? {
              doctors: adPro.doctors, products: adPro.products,
              specialties: adPro.specialties, specialtiesHeritees: adPro.specialtiesHeritees,
              businessUnits: adPro.businessUnits, businessUnitDeduite: adPro.businessUnitDeduite,
            } : undefined}
          />
        )}
      </PageHeader>
      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard label="Événements" value={events.length} icon="CalendarDays" />
        <KpiCard label="À venir" value={upcoming} icon="CalendarClock" tone="info" />
        <KpiCard label="Inscrits (total)" value={totalReg} icon="Users" />
      </div>

      {events.length === 0 ? (
        <EmptyState icon="Ticket" title="Aucun événement" description={canCreate ? "Déclarez un événement externe (staff, webinaire, congrès, journée) auquel l'équipe participe." : "Les événements apparaîtront ici."} />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <Link key={e.id} href={`/events/${e.id}`} className="surface flex flex-col gap-2 p-4 transition-colors hover:bg-secondary/40">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 break-words font-semibold leading-tight">{e.name}</h3>
                <StatusBadge map={EVENT_STATUS} value={e.status} />
              </div>
              <p className="text-xs text-muted-foreground">{EVENT_TYPE[e.type]} · {EVENT_FORMAT[e.format]}{e.city ? ` · ${e.city}` : ""}</p>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                <span>{e.startDate ? formatDate(e.startDate) : "Date à définir"}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="info" dot={false}>{e.registrations} inscrit{e.registrations > 1 ? "s" : ""}</Badge>
                  {e.present > 0 && <Badge tone="success" dot={false}>{e.present} présent{e.present > 1 ? "s" : ""}</Badge>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
