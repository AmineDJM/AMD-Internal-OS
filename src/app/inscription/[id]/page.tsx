import { notFound } from "next/navigation";
import { CalendarDays, MapPin } from "lucide-react";
import { getPublicEvent } from "@/modules/ad-pro/api";
import { EVENT_TYPE, EVENT_FORMAT } from "@/lib/labels";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function InscriptionPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const event = await getPublicEvent(params.id);
  if (!event) notFound();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">A</div>
          <div className="leading-tight"><p className="text-sm font-semibold">Adventum Pharma</p><p className="text-[0.6875rem] text-muted-foreground">Inscription à l'événement</p></div>
        </div>

        <div className="surface overflow-hidden">
          <div className="bg-primary px-6 py-5 text-primary-foreground">
            <p className="text-xs uppercase tracking-wide opacity-80">{EVENT_TYPE[event.type]} · {EVENT_FORMAT[event.format]}</p>
            <h1 className="mt-1 text-2xl font-bold">{event.name}</h1>
            <div className="mt-3 flex flex-wrap gap-4 text-sm opacity-90">
              {event.startDate && <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> {formatDate(event.startDate)}{event.endDate ? ` → ${formatDate(event.endDate)}` : ""}</span>}
              {(event.location || event.city) && <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" /> {[event.location, event.city, event.country].filter(Boolean).join(", ")}</span>}
            </div>
          </div>

          <div className="p-6">
            {event.description && <p className="mb-5 whitespace-pre-wrap text-sm text-muted-foreground">{event.description}</p>}
            {/* ÉVÉNEMENTS EXTERNES (Direction, 27/10) : l'inscription se fait chez l'organisateur. */}
            <div className="rounded-lg bg-secondary px-4 py-6 text-center text-sm text-muted-foreground">
              Les inscriptions à cet événement se font auprès de son organisateur.
            </div>
          </div>
        </div>
        <p className="mt-4 text-center text-[0.6875rem] text-muted-foreground">© {new Date().getFullYear()} Adventum Pharma</p>
      </div>
    </div>
  );
}
