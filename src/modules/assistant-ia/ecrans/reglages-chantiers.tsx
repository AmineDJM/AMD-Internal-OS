"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/shared/use-action";
import { enregistrerReglagesChantiers } from "@/modules/assistant-ia/actions-consommation";

/** La forme des réglages (`lib/missions/chantiers/regles.ts`), redite ici : l'écran n'importe pas le moteur. */
interface ReglagesChantiers {
  plafondUsd: number; lancementsMax: number; deploiementsMax: number; tentativesMax: number;
  jourUsdMax: number; jourLancementsMax: number; jourDeploiementsMax: number; enParallele: number; autofixMinutes: number;
  attenteCommitHeures: number; relanceSansCommitHeures: number; correctionsMax: number; alerteApresEchecs: number;
}

/**
 * LES CHANTIERS DE DÉVELOPPEMENT — la console du Super Admin (lot C1, décision 0042), dans Administration › IA : les
 * plafonds qui empêchent un chantier de tourner en rond en dépensant. Un plafond atteint met le chantier en pause
 * (« Plafond atteint » au tableau « Missions ») ; relevé ici, il reprend seul au passage suivant. Le modèle exécutant
 * (MiMo) est dit tel que configuré — sa clé ne s'affiche jamais.
 */

const CHAMPS: { cle: keyof ReglagesChantiers; libelle: string; aide: string; pas: number }[] = [
  { cle: "plafondUsd", libelle: "Dollars de modèles par chantier", aide: "MiMo, Terra, Sol — journal K8 par chantier", pas: 0.5 },
  { cle: "lancementsMax", libelle: "Lancements de Claude Code par chantier", aide: "premier lancement et relances de correction", pas: 1 },
  { cle: "deploiementsMax", libelle: "Déploiements par chantier", aide: "Render, tous services confondus", pas: 1 },
  { cle: "tentativesMax", libelle: "Tentatives par étape (pannes de connecteur)", aide: "délai croissant ; la boucle de correction a son propre plafond, plus bas", pas: 1 },
  { cle: "jourUsdMax", libelle: "Dollars par jour, tous chantiers", aide: "heure d'Alger", pas: 1 },
  { cle: "jourLancementsMax", libelle: "Lancements par jour, tous chantiers", aide: "les routines ont leurs propres plafonds horaires", pas: 1 },
  { cle: "jourDeploiementsMax", libelle: "Déploiements par jour, tous chantiers", aide: "", pas: 1 },
  { cle: "enParallele", libelle: "Chantiers conduits en parallèle", aide: "les réservations sérialisent le reste", pas: 1 },
  { cle: "autofixMinutes", libelle: "Minutes laissées à l'Auto-fix avant de relancer", aide: "la session corrige sa PR elle-même, gratuitement ; 0 = relancer tout de suite", pas: 5 },
  { cle: "attenteCommitHeures", libelle: "Heures sans commit avant de demander vos consignes", aide: "l'ERP est gros : un chantier peut travailler 14 h ; jamais un échec sec, la branche reste réservée", pas: 1 },
  { cle: "relanceSansCommitHeures", libelle: "« Où en es-tu ? » toutes les … heures sans commit", aide: "à la même session ; une session morte est relancée", pas: 1 },
  { cle: "correctionsMax", libelle: "Corrections au plus sur un rouge", aide: "au-delà : pause « attend tes consignes »", pas: 1 },
  { cle: "alerteApresEchecs", libelle: "Vous prévenir au … échec", aide: "Adam continue de corriger seul après vous avoir prévenu", pas: 1 },
];

export function ReglagesChantiersForm({ initial, mimo }: { initial: ReglagesChantiers; mimo: { configure: boolean; modele: string; base: string } }) {
  const [valeurs, setValeurs] = React.useState<Record<string, string>>(() => Object.fromEntries(CHAMPS.map((c) => [c.cle, String(initial[c.cle])])));
  const [fait, setFait] = React.useState(false);
  const { busy, err, run } = useAction();
  const modifie = CHAMPS.some((c) => valeurs[c.cle] !== String(initial[c.cle]));

  const enregistrer = async () => {
    const fd = new FormData();
    for (const c of CHAMPS) fd.set(c.cle, valeurs[c.cle] ?? "");
    await run(() => enregistrerReglagesChantiers(fd), () => { setFait(true); setTimeout(() => setFait(false), 1800); });
  };

  return (
    <div className="space-y-3" data-testid="reglages-chantiers">
      <p className="text-sm text-muted-foreground">
        Exécutant : MiMo <span className="font-mono">{mimo.modele}</span> — {mimo.configure ? "clé posée (variable « mimo »)" : "clé absente : les lectures longues retombent sur Terra"} · <span className="font-mono">{mimo.base}</span>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CHAMPS.map((c) => (
          <label key={c.cle} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{c.libelle}</span>
            <input type="number" inputMode="decimal" min={0} step={c.pas} value={valeurs[c.cle] ?? ""} name={c.cle}
              onChange={(e) => { const v = e.target.value; setValeurs((p) => ({ ...p, [c.cle]: v })); setFait(false); }}
              className="h-11 rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:text-sm" />
            {c.aide && <span className="text-xs text-muted-foreground">{c.aide}</span>}
          </label>
        ))}
      </div>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <Button type="button" onClick={() => void enregistrer()} disabled={busy || !modifie} className="h-11 sm:h-9">
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : fait ? <Check aria-hidden className="h-4 w-4" /> : null} Enregistrer les plafonds
      </Button>
    </div>
  );
}
