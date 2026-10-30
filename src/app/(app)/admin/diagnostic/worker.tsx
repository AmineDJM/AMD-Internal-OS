import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { lireEtatWorker, SanteTachesDeFond } from "@/lib/taches-de-fond/sante";

/**
 * LE WORKER (décision 0019) — ce que le Super Admin doit voir sans ouvrir Render : le dernier battement du worker,
 * son contrôle au démarrage (variables présentes/absentes, moteur de conversion), la file des conversions et ses
 * derniers échecs. Les VALEURS des variables ne sont jamais lues : seulement présente / absente.
 */
export function WorkerCard({ etat, sante }: { etat: Awaited<ReturnType<typeof lireEtatWorker>>; sante: SanteTachesDeFond }) {
  const duWorker = sante.taches.filter((t) => t.executeur === "worker" && t.dernierDebutA);
  const dernier = duWorker.reduce<string | null>((m, t) => (!m || t.dernierDebutA! > m ? t.dernierDebutA : m), null);
  const vivant = sante.executeursRecents.includes("worker");
  const c = etat.controle;
  const f = etat.conversions;
  const manquants = c?.variables.filter((v) => !v.presente) ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Worker et conversions</CardTitle>
        <CardDescription>
          Le service <code className="rounded bg-muted px-1">amd-worker</code> (image Docker : moteur de conversion, LibreOffice, OCR).
          Tant qu&apos;il ne bat pas, le web reprend les tâches de fond et les conversions attendent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone={vivant ? "success" : "warning"} dot={false}>{vivant ? "Worker vivant" : "Worker silencieux (aucun passage depuis 5 min)"}</Badge>
          <Badge tone="neutral" dot={false}>Dernier battement : {dernier ? formatDateTime(dernier) : "jamais"}</Badge>
          <Badge tone={c ? (c.pret ? "success" : "danger") : "neutral"} dot={false}>
            {c ? `Contrôle au démarrage : ${c.pret ? "prêt" : "incomplet"} (${formatDateTime(c.verifieA)})` : "Aucun contrôle de démarrage enregistré"}
          </Badge>
          {c?.moteur && <Badge tone={c.moteur.pret ? "success" : "danger"} dot={false}>Moteur de conversion : {c.moteur.pret ? "complet" : "incomplet"}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone={f.enFile ? "info" : "neutral"} dot={false}>{f.enFile} en file</Badge>
          <Badge tone="neutral" dot={false}>{f.enCours} en cours</Badge>
          <Badge tone="success" dot={false}>{f.faites24h} faites (24 h)</Badge>
          <Badge tone={f.echecs24h ? "danger" : "neutral"} dot={false}>{f.echecs24h} échec{f.echecs24h > 1 ? "s" : ""} (24 h)</Badge>
          {f.plusAncienneEnFile && <Badge tone="warning" dot={false}>Plus ancienne en file : {formatDateTime(f.plusAncienneEnFile)}</Badge>}
        </div>
        {c && c.messages.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {c.messages.map((m) => <li key={m} className={m.startsWith("CRITIQUE") ? "text-destructive" : "text-muted-foreground"}>{m}</li>)}
          </ul>
        )}
        {c && manquants.length === 0 && c.moteur?.pret && <p className="text-xs text-muted-foreground">Toutes les variables attendues sont présentes ; le moteur est complet.</p>}
        {f.derniersEchecs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-medium">Quand</th><th className="py-1 pr-3 font-medium">Vers</th><th className="py-1 pr-3 font-medium">Voie</th><th className="py-1 font-medium">Erreur</th></tr></thead>
              <tbody>
                {f.derniersEchecs.map((e) => (
                  <tr key={e.quand + e.erreur} className="border-t border-border align-top">
                    <td className="py-1 pr-3 tabular-nums">{formatDateTime(e.quand)}</td>
                    <td className="py-1 pr-3">{e.vers}</td>
                    <td className="py-1 pr-3">{e.voie}</td>
                    <td className="max-w-[28rem] break-words py-1 text-muted-foreground">{e.erreur}</td>
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
