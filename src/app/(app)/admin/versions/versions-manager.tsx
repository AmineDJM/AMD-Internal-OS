"use client";

import * as React from "react";
import { Loader2, CheckCircle2, FlaskConical, Undo2, PowerOff, Eye, EyeOff } from "lucide-react";
import { setFeatureStage, toggleMyTestMode } from "@/lib/actions/feature-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import type { FeatureRow } from "@/lib/features";
import { formatDateTime } from "@/lib/utils";

const STAGE: Record<FeatureRow["stage"], { label: string; tone: "success" | "warning" | "neutral"; hint: string }> = {
  PROD: { label: "En production", tone: "success", hint: "Visible de toute l'entreprise." },
  TEST: { label: "En test", tone: "warning", hint: "Visible uniquement des comptes en mode test." },
  OFF: { label: "Désactivée", tone: "neutral", hint: "Invisible de tout le monde." },
};

export function VersionsManager({ rows, testMode }: { rows: FeatureRow[]; testMode: boolean }) {
  const geste = useKeyedAction();
  const busy = geste.busy;
  const err = geste.error;

  async function move(key: string, stage: FeatureRow["stage"]) {
    const fd = new FormData();
    fd.set("key", key); fd.set("stage", stage);
    await geste.run(key, async () => {
      const r = await setFeatureStage(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "La fonctionnalité n'a pas changé d'étape." };
    });
  }

  async function switchTestMode() {
    const fd = new FormData();
    fd.set("on", testMode ? "false" : "true");
    await geste.run("__mode", async () => {
      const r = await toggleMyTestMode(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "Le mode test n'a pas été basculé." };
    });
  }

  const inTest = rows.filter((r) => r.stage === "TEST");
  const inProd = rows.filter((r) => r.stage === "PROD");
  const off = rows.filter((r) => r.stage === "OFF");

  return (
    <div className="space-y-6">
      {/* Interrupteur du mode test personnel */}
      <section className={`surface flex flex-wrap items-center gap-3 p-4 ${testMode ? "border-warning/50" : ""}`}>
        {testMode ? <Eye className="h-5 w-5 shrink-0 text-warning" /> : <EyeOff className="h-5 w-5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">Mon mode test {testMode ? "— activé" : "— désactivé"}</p>
          <p className="text-xs text-muted-foreground">
            {testMode
              ? "Vous voyez actuellement les nouveautés en test. Les autres comptes voient la production."
              : "Vous voyez l'application exactement comme tout le monde (production seulement)."}
          </p>
        </div>
        <Button variant={testMode ? "outline" : "primary"} size="sm" onClick={switchTestMode} disabled={busy !== null}>
          {busy === "__mode" ? <Loader2 className="h-4 w-4 animate-spin" /> : testMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {testMode ? "Désactiver le mode test" : "Activer le mode test"}
        </Button>
      </section>

      <Retour ton="erreur">{err}</Retour>

      <Group
        title={`En version de test (${inTest.length})`}
        subtitle="À recetter. Validez celles qui vous conviennent — elles deviendront visibles de toute l'entreprise."
        rows={inTest} busy={busy} onMove={move}
      />
      <Group
        title={`En production (${inProd.length})`}
        subtitle="Actives pour tout le monde. Un retour en test les masque immédiatement."
        rows={inProd} busy={busy} onMove={move}
      />
      {off.length > 0 && (
        <Group title={`Désactivées (${off.length})`} subtitle="Invisibles de tous." rows={off} busy={busy} onMove={move} />
      )}
    </div>
  );
}

function Group({
  title, subtitle, rows, busy, onMove,
}: {
  title: string;
  subtitle: string;
  rows: FeatureRow[];
  busy: string | null;
  onMove: (key: string, stage: FeatureRow["stage"]) => void;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">Aucune.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const s = STAGE[r.stage];
            const working = busy === r.key;
            return (
              <div key={r.key} className="surface space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.label}</span>
                  <Badge tone={s.tone} dot={false}>{s.label}</Badge>
                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{r.key}</span>
                </div>
                {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                {r.stage === "PROD" && r.promotedAt && (
                  <p className="text-xs text-success">
                    Validée en production {r.promotedByName ? `par ${r.promotedByName} ` : ""}le {formatDateTime(r.promotedAt)}.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {r.stage !== "PROD" && (
                    <Button size="sm" onClick={() => onMove(r.key, "PROD")} disabled={busy !== null}>
                      {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Valider en production
                    </Button>
                  )}
                  {r.stage !== "TEST" && (
                    <Button size="sm" variant="outline" onClick={() => onMove(r.key, "TEST")} disabled={busy !== null}>
                      {r.stage === "PROD" ? <Undo2 className="h-4 w-4" /> : <FlaskConical className="h-4 w-4" />}
                      {r.stage === "PROD" ? "Retirer de la production" : "Remettre en test"}
                    </Button>
                  )}
                  {r.stage !== "OFF" && (
                    <Button size="sm" variant="ghost" onClick={() => onMove(r.key, "OFF")} disabled={busy !== null}>
                      <PowerOff className="h-4 w-4" /> Désactiver
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
