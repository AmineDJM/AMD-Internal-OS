"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { arreterRappelAssistant, cancelReminder, completeReminder, snoozeReminder } from "@/lib/actions/reminder-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";
import { quandLisible, rappelsDuJour, type RappelVue } from "@/lib/rappels/vue";
import { RappelRapide, type RappelCree } from "./rappel-rapide";

/**
 * « MES RAPPELS » DANS AUJOURD'HUI (maquette validée, 24/11/2026) — le formulaire EN HAUT, puis UNE liste sans
 * onglets : ce qui est passé (en rouge), puis ce qui vient. Un bouton « Fait » par rappel ; « Reporter » et
 * « Annuler » dans « ⋯ ». Mêmes actions que la page complète (`/mon-espace/rappels`, qui garde ses onglets,
 * les reçus et l'historique).
 *
 * Un rappel qu'on vient d'ajouter se voit TOUT DE SUITE : il s'affiche avant même le retour du serveur, et
 * reste dans la liste même au-delà des cinq premiers.
 */

const LIMITE = 5;
const LIEN_DE_CETTE_PAGE = "/mon-espace";

/** Demain 9 h, heure du navigateur — « Reporter » ne tombe pas au milieu de la nuit. */
function demainNeufHeures(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** Un lien qui ramène ici n'ouvre rien : on ne l'offre pas. */
const lienUtile = (lien: string | null) => (lien && lien.split(/[?#]/)[0] !== LIEN_DE_CETTE_PAGE ? lien : null);

export function RappelsDuJour({ rappels, maintenant }: { rappels: RappelVue[]; maintenant: string }) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [nouveau, setNouveau] = React.useState<RappelCree | null>(null);

  const cleNouveau = nouveau ? `perso:${nouveau.id}` : null;
  const liste = React.useMemo(() => {
    if (!nouveau || rappels.some((r) => r.key === cleNouveau)) return rappels;
    const provisoire: RappelVue = {
      key: `perso:${nouveau.id}`, id: nouveau.id, source: "perso", titre: nouveau.titre, note: null,
      lien: LIEN_DE_CETTE_PAGE, quand: nouveau.quand, statut: "PENDING", recurrence: null,
    };
    return [...rappels, provisoire];
  }, [rappels, nouveau, cleNouveau]);
  const { lignes, caches } = rappelsDuJour(liste, new Date(maintenant).getTime(), LIMITE, cleNouveau);

  async function act(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, r: RappelVue, succes: string, extra?: Record<string, string>) {
    setBusyKey(r.key);
    const fd = new FormData();
    fd.set("id", r.id);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    try {
      const res = await fn(fd);
      if (res.ok) { retours.succes(succes); rafraichir(); }
      else retours.erreur(res.error ?? "Le rappel n'a pas pu être modifié.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusyKey(null);
    }
  }

  const itemMenu = "flex min-h-10 items-center rounded-md px-2.5 text-left text-sm hover:bg-secondary disabled:opacity-50 sm:min-h-9";

  return (
    <div className="flex flex-col gap-3.5">
      <RappelRapide onCree={setNouveau} />
      {lignes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun rappel en attente.</p>
      ) : (
        <ul className="flex flex-col">
          {lignes.map(({ rappel: r, passe }) => {
            const busy = busyKey === r.key;
            const lien = lienUtile(r.lien);
            return (
              <li key={r.key} className="flex items-center gap-3 border-t border-border py-2.5">
                <div className="min-w-0 flex-1">
                  {lien ? (
                    <Link href={lien} className="break-words text-sm font-semibold text-foreground hover:underline">{r.titre}</Link>
                  ) : (
                    <p className="break-words text-sm font-semibold">{r.titre}</p>
                  )}
                  <p className={cn("text-xs", passe ? "text-destructive" : "text-muted-foreground")}>
                    {quandLisible(r.quand, new Date(maintenant).getTime())}
                    {passe && " — passé"}
                    {r.source === "assistant" && <span className="text-muted-foreground"> · posé par l&apos;assistant</span>}
                    {r.recurrence && <span className="text-muted-foreground"> · {r.recurrence}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
                  {r.source === "perso" && (
                    <>
                      <button
                        type="button" disabled={busy} onClick={() => act(completeReminder, r, "Rappel terminé.")}
                        className="inline-flex h-10 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-semibold hover:bg-secondary focus-ring disabled:opacity-50 sm:h-9"
                      >
                        Fait
                      </button>
                      <MenuDossier label={`Autres actions sur « ${r.titre} »`} doigt>
                        <button type="button" role="menuitem" disabled={busy} className={itemMenu} onClick={() => act(snoozeReminder, r, "Rappel reporté à demain 9 h.", { remindAt: demainNeufHeures() })}>
                          Reporter à demain 9 h
                        </button>
                        <button type="button" role="menuitem" disabled={busy} className={cn(itemMenu, "text-destructive hover:bg-destructive/10")} onClick={() => act(cancelReminder, r, "Rappel annulé.")}>
                          Annuler le rappel
                        </button>
                      </MenuDossier>
                    </>
                  )}
                  {r.source === "assistant" && r.statut === "ACTIVE" && (
                    <MenuDossier label={`Autres actions sur « ${r.titre} »`} doigt>
                      <button type="button" role="menuitem" disabled={busy} className={itemMenu} onClick={() => act(arreterRappelAssistant, r, "Rappel arrêté.")}>
                        Arrêter ce rappel
                      </button>
                    </MenuDossier>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/mon-espace/rappels" className="text-sm font-semibold text-primary hover:underline">
        Tous mes rappels{caches > 0 ? ` (${caches} de plus)` : ""}
      </Link>
    </div>
  );
}
