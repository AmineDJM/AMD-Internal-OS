"use client";

import * as React from "react";
import { Building2, Loader2, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { setCompanyAccess } from "@/lib/actions/company-access-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface CompanyAccessRow {
  companyId: string;
  name: string;
  /** "none" | "view" | "edit" */
  mode: "none" | "view" | "edit";
  /** Entité d'appartenance : lisible de droit, on ne peut pas la retirer. */
  isHome: boolean;
}

/**
 * ACCÈS AUX ENTITÉS — sur la fiche d'un employé.
 *
 * Une personne peut être salariée d'Adventum et travailler pour trois entités du groupe :
 * l'**appartenance** (sa fiche) et le **droit d'accès** (ce qu'elle voit) sont deux choses
 * distinctes. C'est la seconde qui se règle ici.
 *
 * Deux règles rendues visibles à l'écran plutôt que cachées dans le code :
 *   • **son entité d'appartenance reste toujours lisible** — on n'enferme personne hors de sa
 *     propre société par oubli de paramétrage ;
 *   • **voir n'est pas modifier** — on donne souvent la lecture sur une entité voisine sans le
 *     droit d'y écrire.
 */
export function CompanyAccessCard({ userId, rows, seesWholeGroup }: {
  userId: string; rows: CompanyAccessRow[]; seesWholeGroup: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const change = (companyId: string, mode: CompanyAccessRow["mode"]) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(companyId);
    setMsg(null);
    const fd = new FormData();
    fd.set("userId", userId);
    fd.set("companyId", companyId);
    fd.set("mode", mode);
    void (async () => {
      try {
        const r = await setCompanyAccess(undefined, fd);
        setMsg({ ok: r.ok, text: r.ok ? "Accès mis à jour." : (r.error ?? "L'accès n'a pas été modifié.") });
        if (r.ok) rafraichir();
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(null);
        lock.current = false;
      }
    })();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" /> Accès aux entités
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {seesWholeGroup ? (
          <p className="flex items-start gap-2 rounded-xl border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              Son rôle lui donne la <strong>vue groupe</strong> : elle accède à toutes les entités,
              en lecture comme en écriture. Aucun réglage n&apos;est nécessaire ici.
            </span>
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Ce que cette personne voit dans le sélecteur d&apos;entité — et donc les dossiers,
              produits réglementaires et documents auxquels elle accède. Son entité
              d&apos;appartenance reste toujours lisible : on n&apos;enferme personne hors de sa
              propre société.
            </p>

            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.companyId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.name}</span>
                  {r.isHome && <Badge tone="info" dot={false}>son entité</Badge>}
                  {busy === r.companyId && <Loader2 className="h-4 w-4 animate-spin" />}
                  <div className="flex w-full gap-1 sm:w-auto">
                    {(["none", "view", "edit"] as const).map((m) => {
                      // Retirer l'accès à sa propre entité n'aurait aucun effet : elle reste
                      // lisible de droit. On désactive plutôt que de laisser croire au contraire.
                      const disabled = busy !== null || (m === "none" && r.isHome);
                      return (
                        <button
                          key={m}
                          disabled={disabled}
                          onClick={() => change(r.companyId, m)}
                          title={m === "none" && r.isHome ? "Son entité d'appartenance reste toujours lisible." : undefined}
                          className={`min-h-9 flex-1 rounded-lg border px-2 py-1 text-xs transition disabled:opacity-40 sm:min-h-0 sm:flex-none ${
                            r.mode === m
                              ? "border-primary bg-primary/10 font-medium text-foreground"
                              : "border-border text-muted-foreground hover:bg-secondary"
                          }`}
                        >
                          {m === "none" ? "Aucun" : m === "view" ? "Voir" : "Voir et modifier"}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>

            {msg && (
              <p className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>
                {msg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {msg.text}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
