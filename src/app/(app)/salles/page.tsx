import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { libelleInstant, sallesEnService } from "@/modules/salles/partage";
import { sallesEtReservations } from "@/modules/salles/api";

/**
 * MIS DE CÔTÉ (Direction, 03/11/2026 : « il n'y a pas de réservation de la salle ») : hors service, l'adresse mène à l'accueil ;
 * `SALLES_EN_SERVICE=1` la rétablit (décision 0051, « Correction du 03/11 »).
 *
 * LES SALLES DE RÉUNION (lot T3, décision 0051) — ouvertes à TOUS les employés (Direction, 02/11/2026) : les salles et
 * leur capacité, les réservations à venir. On réserve par Adventum IA (« réserve la salle du conseil jeudi de 10 h à
 * 12 h ») : le créneau est vérifié, une salle prise propose les salles libres, la réservation s'annule d'un geste.
 */
export default async function Salles() {
  await requireUser();
  if (!sallesEnService()) redirect("/");
  const { salles, reservations } = await sallesEtReservations();
  return (
    <div className="space-y-6">
      <PageHeader title="Salles de réunion" description="Les salles, leur capacité et les réservations à venir." />
      <Card>
        <CardHeader><CardTitle>Salles ({salles.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {salles.length === 0 ? (
            <EmptyState title="Aucune salle déclarée" description="L'assistante de direction déclare les salles (« ajoute la salle du conseil, 14 places »)." />
          ) : salles.map((s) => (
            <div key={s.id} className="flex flex-wrap justify-between gap-2">
              <span className="min-w-0 break-words font-medium">{s.libelle}</span>
              <span className="text-muted-foreground">{s.capacite ? `${s.capacite} places` : "capacité non renseignée"}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Réservations à venir</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {reservations.length === 0 ? <p className="text-muted-foreground">Aucune réservation à venir.</p> : reservations.map((r) => (
            <div key={r.id} className="flex flex-wrap justify-between gap-2">
              <span className="min-w-0 break-words"><span className="font-medium">{r.moyen.libelle}</span> — {r.objet}{r.participants ? ` (${r.participants} pers.)` : ""}</span>
              <span className="text-muted-foreground">{libelleInstant(r.debut)} → {libelleInstant(r.fin).slice(11)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
