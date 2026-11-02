import { notFound } from "next/navigation";
import { Video, ExternalLink } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { roomUrl } from "@/lib/meetings";
import { PublicJoin } from "./public-join";

export const dynamic = "force-dynamic";

/**
 * Page PUBLIQUE (sans compte) d'une réunion, ouverte par un lien externe partagé.
 * Le jeton non devinable autorise l'accès. Si un **lien de réunion** (Meet/Teams/Zoom) est
 * défini, on l'affiche comme bouton « Rejoindre » ; sinon repli sur la salle Jitsi (conservée).
 * Aucune donnée interne de l'OS n'est exposée (seul le titre est affiché).
 */
export default async function PublicMeetPage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const meeting = await prisma.meeting.findUnique({
    where: { publicToken: params.token },
    select: { title: true, slug: true, withVideo: true, status: true, meetLink: true },
  });
  if (!meeting) notFound();

  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-primary text-xs text-primary-foreground">A</span>
          Adventum Pharma
        </div>
        {meeting.status === "ENDED" ? (
          <div className="rounded-xl border border-border bg-card px-6 py-10 text-center">
            <h1 className="text-lg font-semibold">{meeting.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">Cette réunion est terminée.</p>
          </div>
        ) : meeting.meetLink ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"><Video className="h-7 w-7 text-primary" /></div>
            <h1 className="text-lg font-semibold">{meeting.title}</h1>
            <p className="text-sm text-muted-foreground">Vous êtes invité à rejoindre cette réunion.</p>
            <a href={meeting.meetLink} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              <ExternalLink className="h-4 w-4" /> Rejoindre la réunion
            </a>
          </div>
        ) : (
          <PublicJoin baseUrl={roomUrl(meeting.slug, { video: meeting.withVideo })} title={meeting.title} />
        )}
        <p className="text-center text-xs text-muted-foreground">Réunion sécurisée.</p>
      </div>
    </main>
  );
}
