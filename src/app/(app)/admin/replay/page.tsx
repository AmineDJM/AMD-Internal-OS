import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDateTime } from "@/lib/utils";
import { ReplayViewer, type ReplaySession, type ReplayEvent } from "./replay-viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rejeu de session — AMD Internal OS" };

/** Assez pour couvrir « les problèmes de cette semaine », sans charger toute l'histoire. */
const SESSIONS_SHOWN = 40;

/**
 * LE REJEU DE SESSION — rembobiner ce qu'une personne a fait, pour le support technique.
 *
 * Le support reçoit « ça ne marche pas », sans page, sans heure, sans manipulation. On demande une
 * capture d'écran, elle arrive deux jours plus tard, floue, et le bug n'y est pas. Ici, on ouvre
 * la session et l'on voit la suite exacte des gestes — le curseur se place d'emblée sur la
 * première erreur, parce que c'est ce qu'on vient chercher.
 *
 * ⚠️ Ce n'est PAS une vidéo : un navigateur ne peut pas filmer l'écran sans autorisation explicite
 * ni indicateur visible. Ce sont les ACTIONS qui sont enregistrées — et jamais aucune valeur de
 * champ. Voir `src/lib/replay/capture.ts`, dont les tests garantissent le masquage.
 *
 * RÉSERVÉ AU SUPER ADMIN. Pas au PDG, pas aux RH : c'est un outil de diagnostic technique, et
 * l'élargir en ferait un outil de surveillance.
 */
export default async function ReplayPage(props: { searchParams?: Promise<{ session?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") notFound();

  // Les sessions récentes : une ligne par session, avec qui, quand, combien d'actions, et surtout
  // s'il y a eu une ERREUR — c'est le seul critère de tri qui compte pour le support.
  const grouped = await prisma.sessionEvent.groupBy({
    by: ["sessionId"],
    _count: { _all: true },
    _max: { createdAt: true },
    _min: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: SESSIONS_SHOWN,
  });

  const ids = grouped.map((g) => g.sessionId);
  const [firsts, errorCounts] = await Promise.all([
    ids.length
      ? prisma.sessionEvent.findMany({
          where: { sessionId: { in: ids } },
          distinct: ["sessionId"],
          orderBy: { at: "asc" },
          select: { sessionId: true, path: true, user: { select: { name: true } } },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.sessionEvent.groupBy({
          by: ["sessionId"], where: { sessionId: { in: ids }, kind: "ERROR" }, _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const firstOf = new Map(firsts.map((f) => [f.sessionId, f]));
  const errorsOf = new Map(errorCounts.map((e) => [e.sessionId, e._count._all]));

  const sessions: ReplaySession[] = grouped.map((g) => {
    const f = firstOf.get(g.sessionId);
    return {
      id: g.sessionId,
      who: f?.user?.name ?? "—",
      startedLabel: g._min.createdAt ? formatDateTime(g._min.createdAt) : "—",
      events: g._count._all,
      errors: errorsOf.get(g.sessionId) ?? 0,
      entryPath: f?.path ?? "—",
    };
  });

  // La session ouverte : celle demandée, sinon la plus récente AYANT une erreur, sinon la plus
  // récente. Ouvrir sur une session sans problème ferait chercher au mauvais endroit.
  const openId = (searchParams?.session && sessions.some((s) => s.id === searchParams.session))
    ? searchParams.session
    : sessions.find((s) => s.errors > 0)?.id ?? sessions[0]?.id ?? null;

  const events: ReplayEvent[] = openId
    ? (await prisma.sessionEvent.findMany({
        where: { sessionId: openId },
        orderBy: { at: "asc" },
        take: 1000,
        select: { id: true, kind: true, at: true, path: true, label: true, detail: true },
      })).map((e) => ({ id: e.id, kind: e.kind, at: e.at, path: e.path, label: e.label, detail: e.detail }))
    : [];

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Rejeu de session"
        description="La suite exacte des actions d'une personne — pages, clics, champs remplis, erreurs — pour reproduire un bug sans avoir à le faire raconter. Le curseur se place d'emblée sur la première erreur. Aucune valeur de champ n'est enregistrée : ni mot de passe, ni montant, ni contenu."
      />

      {sessions.length === 0 ? (
        <EmptyState
          icon="History"
          title="Aucune session enregistrée"
          description="Les sessions apparaissent dès que quelqu'un utilise la plateforme."
        />
      ) : (
        <ReplayViewer sessions={sessions} openId={openId} events={events} />
      )}
    </div>
  );
}
