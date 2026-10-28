import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { EtatTache, SanteTachesDeFond } from "@/lib/taches-de-fond/sante";

/**
 * TÂCHES DE FOND (refonte V2-F) — le battement de chaque tâche vu par le Super Admin : qui l'a
 * exécutée (web ou worker), quand, combien de temps, avec quelle issue. Même lecture que
 * `/api/health/worker`, avec le détail (processus détenteur, message du dernier passage).
 */

const MODE: Record<SanteTachesDeFond["mode"], string> = {
  web: "le processus web bat",
  worker: "le worker bat, le web se tait",
  "les-deux": "web et worker battent, un bail par tâche",
};

function etat(t: EtatTache): { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" } {
  if (t.interrompue) return { label: "Interrompue", tone: "danger" };
  if (t.enCours) return { label: "En cours", tone: "info" };
  if (t.statut === "ECHEC") return { label: "Échec", tone: "danger" };
  if (t.enRetard) return { label: "En retard", tone: "warning" };
  if (t.statut === "IGNOREE") return { label: "Ignorée", tone: "neutral" };
  return { label: "OK", tone: "success" };
}

function duree(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

export function TachesDeFondCard({ sante }: { sante: SanteTachesDeFond }) {
  const echecs = sante.taches.filter((t) => t.statut === "ECHEC" || t.interrompue).length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Tâches de fond</CardTitle>
        <CardDescription>
          <code className="rounded bg-muted px-1">TACHES_DE_FOND={sante.mode}</code> — {MODE[sante.mode]}.
          {sante.modeInconnu && " Valeur inconnue dans l'environnement : repli sur « web »."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone={sante.vivant ? "success" : "danger"} dot={false}>
            {sante.vivant ? "Battement vivant" : "Aucun battement depuis 5 min"}
          </Badge>
          <Badge tone="neutral" dot={false}>
            Dernier départ : {sante.dernierBattementA ? formatDateTime(sante.dernierBattementA) : "jamais"}
          </Badge>
          <Badge tone="neutral" dot={false}>
            Exécutants récents : {sante.executeursRecents.length ? sante.executeursRecents.join(", ") : "aucun"}
          </Badge>
          <Badge tone={echecs ? "danger" : "neutral"} dot={false}>{echecs} en échec</Badge>
        </div>
        {sante.taches.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune tâche n&apos;a encore tourné depuis la mise en service du suivi.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Tâche</th>
                  <th className="py-1 pr-3 font-medium">État</th>
                  <th className="py-1 pr-3 font-medium">Exécutant</th>
                  <th className="py-1 pr-3 font-medium">Dernier départ</th>
                  <th className="py-1 pr-3 text-right font-medium">Durée</th>
                  <th className="py-1 pr-3 text-right font-medium">Passages</th>
                  <th className="py-1 font-medium">Dernier message</th>
                </tr>
              </thead>
              <tbody>
                {sante.taches.map((t) => {
                  const e = etat(t);
                  return (
                    <tr key={t.cle} className="border-t border-border align-top">
                      <td className="py-1.5 pr-3 font-mono text-xs">{t.cle}</td>
                      <td className="py-1.5 pr-3"><Badge tone={e.tone} dot={false}>{e.label}</Badge></td>
                      <td className="py-1.5 pr-3 text-xs" title={t.detenteur ?? undefined}>{t.executeur ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-xs tabular-nums">{t.dernierDebutA ? formatDateTime(t.dernierDebutA) : "—"}</td>
                      <td className="py-1.5 pr-3 text-right text-xs tabular-nums">{duree(t.derniereDureeMs)}</td>
                      <td className="py-1.5 pr-3 text-right text-xs tabular-nums">{t.executions}{t.echecs ? ` (${t.echecs} éch.)` : ""}</td>
                      <td className="max-w-[24rem] break-words py-1.5 text-xs text-muted-foreground">{t.message ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
