"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, Link2, Loader2, Plus, X } from "lucide-react";
import { addEntityLink, removeEntityLink, linkCandidatesFor } from "@/lib/actions/link-actions";
import { LINK_TYPE_LABELS, pairReason, type LinkType } from "@/lib/links/graph";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useAction } from "@/components/shared/use-action";

/**
 * « RELIÉ À… » — la MÊME carte sur toutes les fiches.
 *
 * Un contrat né d'un marché, un bon qui exécute ce contrat, une facture qui couvre un ou plusieurs
 * bons, une assurance rattachée à son contrat, un courrier qui parle de n'importe lequel d'entre
 * eux : c'est un seul geste, il mérite un seul écran. Trois cartes différentes auraient dérivé —
 * l'une saurait retirer un lien, l'autre non, la troisième oublierait de dire pourquoi.
 *
 * Le menu déroulant N'AFFICHE QUE les natures que le flux autorise depuis ici (`targetsFor` côté
 * serveur remplit `candidates`), et la raison de la paire s'écrit sous le choix : on sait ce qu'on
 * est en train d'affirmer avant de cliquer. Le serveur revérifie tout — cette liste est une
 * commodité de saisie, jamais un contrôle.
 *
 * Ce module n'importe QUE `links/graph.ts` (pur) : la frontière client tient.
 */
export interface EntityLinkView {
  id: string;
  typeLabel: string;
  label: string;
  href: string | null;
}

export interface EntityLinkCandidates {
  type: string;
  typeLabel: string;
  options: { value: string; label: string }[];
}

export function EntityLinks({ self, links, canEdit, emptyHint }: {
  self: { type: LinkType; id: string };
  links: EntityLinkView[];
  canEdit: boolean;
  emptyHint?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { busy, err, setErr, run: lancer } = useAction();
  // LES CIBLES SE CHARGENT AU CLIC, pas avec la page : jusqu'à cinq requêtes de deux cents
  // lignes pour un tiroir que la plupart des visites n'ouvrent jamais.
  const [candidates, setCandidates] = React.useState<EntityLinkCandidates[] | null>(null);
  const [type, setType] = React.useState("");
  const groupe = candidates?.find((c) => c.type === type);
  const raison = type ? pairReason(self.type, type as LinkType) : null;

  const ouvrir = async () => {
    setErr(null); setOpen(true);
    if (candidates) return;
    const groupes = await linkCandidatesFor(self.type, self.id);
    setCandidates(groupes);
    setType(groupes.find((c) => c.options.length > 0)?.type ?? groupes[0]?.type ?? "");
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => lancer(fn);

  if (links.length === 0 && !canEdit) return null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" aria-hidden /> Relié à
          <span className="text-sm font-normal text-muted-foreground">({links.length})</span>
        </CardTitle>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={ouvrir}>
            <Plus className="h-4 w-4" /> Relier à…
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {emptyHint ?? "Aucun lien. Reliez cet objet aux pièces qu'il concerne — elles l'afficheront de leur côté."}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {links.map((l) => (
              <li key={l.id} className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-secondary/50 py-1 pl-2.5 pr-1 text-sm">
                <span className="text-xs text-muted-foreground">{l.typeLabel} ·</span>
                {l.href ? (
                  <Link href={l.href} className="inline-flex min-w-0 items-center gap-1 font-medium [overflow-wrap:anywhere] hover:underline">
                    {l.label} <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </Link>
                ) : (
                  <span className="font-medium">{l.label}</span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Retirer le lien ${l.label}`}
                    disabled={busy}
                    className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive sm:p-0.5"
                    onClick={() => run(() => { const fd = new FormData(); fd.set("id", l.id); return removeEntityLink(fd); })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {err && !open && <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </CardContent>

      <Sheet open={open} onClose={() => setOpen(false)} title={`Relier ${LINK_TYPE_LABELS[self.type].toLowerCase()} à…`} width="md">
        <form
          className="space-y-4"
          action={async (fd) => {
            fd.set("fromType", self.type);
            fd.set("fromId", self.id);
            fd.set("toType", type);
            if (await run(() => addEntityLink(fd))) setOpen(false);
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="entity-link-type">Nature de l&apos;objet</label>
            <select
              id="entity-link-type"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
              disabled={candidates === null}
            >
              {(candidates ?? []).map((c) => (
                <option key={c.type} value={c.type} disabled={c.options.length === 0}>
                  {c.typeLabel}{c.options.length === 0 ? " (aucun)" : ""}
                </option>
              ))}
            </select>
            {/* CE QU'ON AFFIRME EN RELIANT — le flux, écrit là où on l'applique. */}
            {candidates === null
              ? <p className="text-xs text-muted-foreground">Chargement des objets à relier…</p>
              : raison && <p className="text-xs text-muted-foreground">{raison}</p>}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="entity-link-target">Objet</label>
            <select
              id="entity-link-target"
              name="toId"
              required
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>— Choisir —</option>
              {(groupe?.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" disabled={busy || candidates === null}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Relier
            </Button>
          </div>
        </form>
      </Sheet>
    </Card>
  );
}
