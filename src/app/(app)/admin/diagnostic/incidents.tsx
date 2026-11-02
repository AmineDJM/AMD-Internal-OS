import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { SEUIL, type IncidentDiagnostic } from "@/lib/incidents-repetes";

/**
 * LES ERREURS RÉPÉTÉES (lot V3-E « Fiabilité ») — ce que les `catch` nommés ont rattrapé depuis
 * sept jours, tous processus confondus. Un écran qui affichait un repli (liste vide, valeur par
 * défaut) a laissé ici son nom : c'est ce que la notification au Super Admin résume.
 */
export function IncidentsCard({ incidents }: { incidents: IncidentDiagnostic[] }) {
  const actifs = incidents.filter((i) => i.fenetreActive && i.compteFenetre >= SEUIL).length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Erreurs rattrapées</CardTitle>
        <CardDescription>
          Les échecs tolérés par les écrans et les tâches de fond (repli affiché, traitement poursuivi), sur sept jours.
          Au-delà de {SEUIL} dans l&apos;heure, le Super Admin est prévenu — une fois toutes les six heures au plus.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone={actifs ? "danger" : "success"} dot={false}>{actifs} répétée(s) dans l&apos;heure</Badge>
          <Badge tone="neutral" dot={false}>{incidents.length} événement(s) sur 7 jours</Badge>
        </div>
        {incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune erreur rattrapée depuis sept jours.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Événement</th>
                  <th className="py-1 pr-3 text-right font-medium">Dans l&apos;heure</th>
                  <th className="py-1 pr-3 text-right font-medium">Total</th>
                  <th className="py-1 pr-3 font-medium">Dernière</th>
                  <th className="py-1 font-medium">Dernier message</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.evenement} className="border-t border-border align-top">
                    <td className="break-all py-1.5 pr-3 font-mono text-xs">{i.evenement}</td>
                    <td className="py-1.5 pr-3 text-right text-xs tabular-nums">
                      {i.fenetreActive ? <Badge tone={i.compteFenetre >= SEUIL ? "danger" : "neutral"} dot={false}>{i.compteFenetre}</Badge> : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-xs tabular-nums">{i.total}</td>
                    <td className="py-1.5 pr-3 text-xs tabular-nums">{formatDateTime(i.dernierA)}</td>
                    <td className="max-w-[24rem] break-words py-1.5 text-xs text-muted-foreground">{i.dernierMessage ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
