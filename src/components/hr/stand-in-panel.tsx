"use client";

import * as React from "react";
import { UserCog, Loader2, Check, X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select } from "@/components/ui/input";
import { proposeStandIn, decideStandIn } from "@/modules/rh/actions-interim";
import { STAND_IN_LABEL, type StandInStatus } from "@/lib/hr/stand-in";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * DÉSIGNER UN INTÉRIMAIRE, ET LE FAIRE VALIDER.
 *
 * Deux composants pour deux gestes qui n'appartiennent pas aux mêmes personnes : l'ABSENT
 * désigne (il sait qui peut le remplacer sur son métier), les RH VALIDENT (ils vérifient que ce
 * n'est pas un remplaçant de complaisance).
 *
 * L'écran DIT ce qui est délégué et jusqu'à quand. Une délégation qu'on accorde sans voir sa
 * portée, personne ne la relit ensuite — et c'est ainsi qu'un accès « pour cette fois » devient
 * permanent.
 */

export interface StandInPerson { id: string; name: string }
export interface StandInModule { value: string; label: string }

export interface StandInState {
  standInId: string | null;
  standInName: string | null;
  standInStatus: StandInStatus | null;
  standInModules: string[];
  standInNote: string | null;
}

const TONE: Record<StandInStatus, "info" | "success" | "danger"> = {
  PENDING: "info", APPROVED: "success", REJECTED: "danger",
};

/** L'état courant, lisible d'un coup d'œil dans une liste. */
export function StandInBadge({ state, moduleLabels }: { state: StandInState; moduleLabels: Record<string, string> }) {
  if (!state.standInId || !state.standInStatus) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{state.standInName ?? "—"}</span>
        <Badge tone={TONE[state.standInStatus]} dot={false}>{STAND_IN_LABEL[state.standInStatus]}</Badge>
      </span>
      {state.standInModules.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {state.standInModules.map((m) => moduleLabels[m] ?? m).join(", ")}
        </span>
      )}
      {state.standInNote && <span className="text-xs text-muted-foreground">« {state.standInNote} »</span>}
    </span>
  );
}

/** Le geste de l'ABSENT : choisir qui le remplace, et sur quoi. */
export function StandInButton({
  leaveId, state, people, modules, moduleLabels = {},
}: {
  leaveId: string;
  state: StandInState;
  people: StandInPerson[];
  /** Ce que la personne peut prêter (`modulesPretables`) — la liste même que l'action accepte. */
  modules: StandInModule[];
  moduleLabels?: Record<string, string>;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [who, setWho] = React.useState(state.standInId ?? "");
  // CE QUI A ÉTÉ CHOISI SOUS UNE LISTE PLUS LARGE (un module qu'on ne détient plus, un module retiré de
  // la plateforme) ne repart pas en silence : invisible ici, il serait refusé par l'action sans pouvoir
  // être décoché (§118.196). Il est dit, juste au-dessus des cases.
  const proposes = new Set(modules.map((m) => m.value));
  const [picked, setPicked] = React.useState<string[]>(() => state.standInModules.filter((m) => proposes.has(m)));
  const plusProposes = state.standInModules.filter((m) => !proposes.has(m));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (m: string) =>
    setPicked((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));

  async function save(remove = false) {
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.set("id", leaveId);
    if (!remove && who) {
      fd.set("standInId", who);
      for (const m of picked) fd.append("modules", m);
    }
    let r: Awaited<ReturnType<typeof proposeStandIn>>;
    try {
      r = await proposeStandIn(fd);
    } catch {
      setError(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    if (!r.ok) { setError(r.error ?? "Enregistrement impossible."); return; }
    setOpen(false);
    rafraichir();
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserCog className="h-3.5 w-3.5" /> {state.standInId ? "Intérimaire" : "Désigner"}
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)} width="md"
        title="Intérimaire pendant votre congé"
        description="La personne que vous désignez pourra, PENDANT VOTRE ABSENCE SEULEMENT, ouvrir les modules choisis et trancher les validations qui vous sont adressées — sauf, à ce jour, les étapes du recrutement, du matériel promotionnel et des circuits Ad & Pro qui vous sont adressées nommément. Les RH valident ce choix ; la délégation s'arrête d'elle-même au dernier jour du congé."
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">Qui vous remplace</Label>
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">— Personne —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Ce que vous déléguez</Label>
            <p className="text-xs text-muted-foreground">
              Seuls les modules que vous détenez vous-même sont proposés : votre intérimaire ne reçoit
              jamais plus que ce que vous avez, ni la suppression. Votre Drive, votre messagerie et votre
              espace personnel restent à vous.
            </p>
            {plusProposes.length > 0 && (
              <p className="text-xs text-warning">
                {plusProposes.map((m) => `« ${moduleLabels[m] ?? m} »`).join(", ")}{" "}
                {plusProposes.length > 1
                  ? "ne sont plus proposés (vous ne les détenez pas, ou plus) : ils ne seront pas redemandés."
                  : "n'est plus proposé (vous ne le détenez pas, ou plus) : il ne sera pas redemandé."}
              </p>
            )}
            {modules.length === 0 && (
              <p className="text-xs text-muted-foreground">Vous ne détenez aucun module qui se prête.</p>
            )}
            <div className="grid grid-cols-1 gap-1.5 pt-1 sm:grid-cols-2">
              {modules.map((m) => (
                <label key={m.value} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm sm:min-h-0 sm:px-2">
                  <input
                    type="checkbox" checked={picked.includes(m.value)}
                    onChange={() => toggle(m.value)}
                    className="h-4 w-4 shrink-0 rounded border-input"
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0">{error}</span>
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {state.standInId && (
              <Button variant="outline" size="sm" className="min-h-10 w-full sm:min-h-0 sm:w-auto" disabled={busy} onClick={() => save(true)}>
                <X className="h-4 w-4" /> Retirer
              </Button>
            )}
            <Button size="sm" className="min-h-10 w-full sm:min-h-0 sm:w-auto" disabled={busy || !who || picked.length === 0} onClick={() => save(false)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Proposer aux RH
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

/** Le geste des RH : valider, ou refuser en disant pourquoi. */
export function StandInDecision({ leaveId }: { leaveId: string }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(approve ? "ok" : "no"); setError(null);
    const fd = new FormData();
    fd.set("id", leaveId);
    fd.set("decision", approve ? "APPROVED" : "REJECTED");
    if (note.trim()) fd.set("note", note.trim());
    let r: Awaited<ReturnType<typeof decideStandIn>>;
    try {
      r = await decideStandIn(fd);
    } catch {
      setError(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(null);
    }
    if (!r.ok) { setError(r.error ?? "Décision impossible."); return; }
    rafraichir();
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end sm:gap-1.5">
      <Input
        value={note} onChange={(e) => setNote(e.target.value)}
        aria-label="Motif"
        placeholder="Motif (obligatoire pour refuser)" className="h-10 w-full sm:h-8 sm:w-56 sm:text-xs"
      />
      <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-1.5">
        <BoutonDecisif size="sm" className="min-h-10 max-sm:flex-1 sm:min-h-0" disabled={busy !== null} onClick={() => decide(true)}>
          {busy === "ok" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Valider
        </BoutonDecisif>
        <BoutonDecisif
          className="min-h-10 max-sm:flex-1 sm:min-h-0"
          variant="outline" size="sm" disabled={busy !== null || !note.trim()}
          title={note.trim() ? undefined : "Un refus se motive : l'intéressé doit savoir quoi proposer d'autre."}
          onClick={() => decide(false)}
        >
          {busy === "no" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Refuser
        </BoutonDecisif>
      </div>
      {error && <p className="max-w-xs text-right text-xs text-destructive">{error}</p>}
    </div>
  );
}
