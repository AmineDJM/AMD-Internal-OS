"use client";

import * as React from "react";

import { Loader2, UserPlus } from "lucide-react";
import { shareNode, shareNodeWithMany, unshareNode } from "@/lib/actions/drive-actions";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Retour, useRetours } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import type { ActionResult } from "@/lib/actions/types";

export interface ShareItem { userId: string; name: string; access: string }

/** Ligne d'un partage : l'accès est **modifiable** (Lecture / Éditeur / Aucun accès). */
function ShareRow({ nodeId, share, canEdit, onChanged }: { nodeId: string; share: ShareItem; canEdit: boolean; onChanged?: () => void }) {
  const { rafraichir } = useRafraichir();
  // Le sélecteur d'une ligne n'a pas de place pour parler : un refus part en avis flottant.
  const retours = useRetours();
  const [busy, setBusy] = React.useState(false);

  async function change(value: string) {
    setBusy(true);
    const fd = new FormData();
    fd.set("nodeId", nodeId);
    fd.set("userId", share.userId);
    try {
      let r: ActionResult;
      if (value === "NONE") {
        r = await unshareNode(fd);
      } else {
        fd.set("access", value);
        r = await shareNode(fd);
      }
      if (!r.ok) retours.erreur(r.error ?? "Le droit d'accès n'a pas été modifié.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
    onChanged?.();
    rafraichir();
  }

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">{share.name}</span>
      {canEdit ? (
        <span className="flex items-center gap-1.5">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Select
            value={share.access}
            onChange={(e) => change(e.target.value)}
            disabled={busy}
            className="h-9 w-32 text-xs sm:h-8"
          >
            <option value="VIEW">Lecture</option>
            <option value="EDIT">Éditeur</option>
            <option value="NONE">Aucun accès</option>
          </Select>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{share.access === "EDIT" ? "Éditeur" : "Lecture"}</span>
      )}
    </li>
  );
}

export function SharePanel({
  nodeId, users, shares, canEdit, onChanged,
}: {
  nodeId: string;
  users: { id: string; name: string }[];
  shares: ShareItem[];
  canEdit: boolean;
  /** Appelé après un ajout / changement / retrait — pour rafraîchir un panneau embarqué. */
  onChanged?: () => void;
}) {
  const { busy: saving, err, run } = useAction();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [query, setQuery] = React.useState("");

  // Les personnes déjà destinataires ne sont plus proposées : les recocher ne changerait rien
  // et ferait douter de ce qui a été fait.
  const already = new Set(shares.map((s) => s.userId));
  const needle = query.trim().toLowerCase();
  const shown = users
    .filter((u) => !already.has(u.id))
    .filter((u) => !needle || u.name.toLowerCase().includes(needle));

  return (
    <div className="space-y-3">
      {shares.length === 0 ? (
        <p className="text-sm text-muted-foreground">Pas encore partagé.</p>
      ) : (
        <ul className="space-y-1.5">
          {shares.map((s) => <ShareRow key={s.userId} nodeId={nodeId} share={s} canEdit={canEdit} onChanged={onChanged} />)}
        </ul>
      )}

      {/* PARTAGER AVEC PLUSIEURS PERSONNES D'UN COUP. Partager un dossier de campagne avec six
          délégués un par un, c'est six ouvertures du panneau — et la sixième se fait oublier une
          fois sur deux. On coche, on choisit le droit, on envoie. */}
      {canEdit && users.length > 0 && (
        <form
          action={async (fd) => {
            await run(() => shareNodeWithMany(fd), () => { setPicked(new Set()); onChanged?.(); });
          }}
          className="space-y-2 border-t border-border pt-3"
        >
          <input type="hidden" name="nodeId" value={nodeId} />
          {[...picked].map((id) => <input key={id} type="hidden" name="userId" value={id} />)}

          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Chercher une personne…"
            className="h-9"
          />
          <ul className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
            {shown.length === 0 ? (
              <li className="px-1 py-2 text-xs text-muted-foreground">Personne ne correspond.</li>
            ) : shown.map((u) => (
              <li key={u.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-2 text-sm hover:bg-secondary sm:py-1">
                  <input
                    type="checkbox"
                    checked={picked.has(u.id)}
                    onChange={() => setPicked((p) => {
                      const next = new Set(p);
                      if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
                      return next;
                    })}
                    className="h-4 w-4 rounded border-input"
                  />
                  {u.name}
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end gap-2">
            <Select name="access" defaultValue="VIEW" className="h-9 w-32 text-sm">
              <option value="VIEW">Lecture</option>
              <option value="EDIT">Éditeur</option>
            </Select>
            <Button type="submit" size="sm" disabled={saving || picked.size === 0}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Partager{picked.size > 0 ? ` (${picked.size})` : ""}
            </Button>
          </div>
          <Retour ton="erreur">{err}</Retour>
        </form>
      )}
    </div>
  );
}
