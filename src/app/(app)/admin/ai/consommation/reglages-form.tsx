"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";
import { enregistrerReglagesAssistantIa } from "@/modules/assistant-ia/actions-consommation";
import { BORNES, REGLAGES_PAR_DEFAUT, type ReglagesAssistantIa } from "@/modules/assistant-ia/partage";

type CleNombre = "plafondJetonsJour" | "plafondJetonsTour" | "etapesMaxTour" | "expirationCartesHeures";
type CleDecision = "censurerSaisie" | "retirerCartesCaduques";

const NOMBRES: { cle: CleNombre; label: string; aide: string }[] = [
  { cle: "plafondJetonsJour", label: "Jetons par personne et par jour", aide: "Atteint : les demandes de la personne sont refusées jusqu'à minuit (heure d'Alger), avec une phrase qui le dit ; vous êtes notifié une fois." },
  { cle: "plafondJetonsTour", label: "Jetons par tour", aide: "Toutes les étapes d'une demande, résumés de documents compris. Atteint : l'assistant s'arrête avant de finir et le dit." },
  { cle: "etapesMaxTour", label: "Étapes par tour", aide: "Appels du modèle pour UNE demande (lectures enchaînées). Chaque étape renvoie environ 9 000 jetons fixes." },
  { cle: "expirationCartesHeures", label: "Expiration des cartes (heures)", aide: "Une carte d'action jamais confirmée expire après ce délai : elle ne s'exécute plus, on la redemande." },
];

const DECISIONS: { cle: CleDecision; label: string; aide: string }[] = [
  { cle: "censurerSaisie", label: "Filtrer ce que la personne écrit (décision IA-09)", aide: "Les coordonnées bancaires, rémunérations et numéros d'identité collés dans un message (et l'historique) sont masqués avant de partir chez le fournisseur. Coupé : la personne peut les dicter volontairement à l'assistant." },
  { cle: "retirerCartesCaduques", label: "Retirer les cartes dont on reparle (décision IA-10)", aide: "Quand la personne reparle du sujet d'une carte en attente sans que l'assistant la repropose, la carte est retirée avant le tour — elle ne pourra plus exécuter une version dépassée. Coupé : la carte reste cliquable." },
];

export function ReglagesAssistantIaForm({ initial }: { initial: ReglagesAssistantIa }) {
  const [r, setR] = React.useState<ReglagesAssistantIa>(initial);
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);

  const enregistrer = () => {
    const fd = new FormData();
    for (const { cle } of NOMBRES) fd.set(cle, String(r[cle]));
    for (const { cle } of DECISIONS) fd.set(cle, r[cle] ? "true" : "false");
    setOk(false);
    void run(() => enregistrerReglagesAssistantIa(fd), () => setOk(true));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {NOMBRES.map(({ cle, label, aide }) => (
          <label key={cle} className="block space-y-1">
            <span className="text-sm font-medium">{label}</span>
            <Input
              type="number" inputMode="numeric" min={BORNES[cle].min} max={BORNES[cle].max}
              value={r[cle]}
              onChange={(e) => setR({ ...r, [cle]: Number(e.target.value) })}
            />
            <span className="block text-xs text-muted-foreground">{aide} Défaut : {REGLAGES_PAR_DEFAUT[cle].toLocaleString("fr-FR")}.</span>
          </label>
        ))}
      </div>
      <div className="space-y-3">
        {DECISIONS.map(({ cle, label, aide }) => (
          <label key={cle} className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={r[cle]} onChange={(e) => setR({ ...r, [cle]: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{aide} Défaut : {REGLAGES_PAR_DEFAUT[cle] ? "activé" : "coupé"} (option prudente).</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={enregistrer} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Enregistrer
        </Button>
        {ok && !err && <span className="text-sm text-success">Enregistré.</span>}
        {err && <span className="text-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}
