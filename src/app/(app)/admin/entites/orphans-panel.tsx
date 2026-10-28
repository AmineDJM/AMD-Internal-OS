"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { attachOrphansToCompany } from "@/lib/actions/entity-attach-actions";
import type { UnattachedGroup } from "@/lib/queries/unattached";

/**
 * CE QUI N'APPARTIENT À AUCUNE ENTITÉ — et comment le ranger.
 *
 * Depuis que choisir une entité ne montre QUE celle-là, un objet sans entité n'apparaît plus
 * dans aucune vue cloisonnée. Il reste lisible en vue « toutes les entités », mais personne ne
 * cherche ce qu'il ne sait pas manquant : cet écran est là pour le dire, et pour le corriger.
 *
 * Le rattachement en masse ne touche QUE les enregistrements sans entité — jamais ceux qui en
 * ont déjà une, même pour « uniformiser ».
 */
export function OrphansPanel({
  groups, total, companies,
}: {
  groups: UnattachedGroup[];
  total: number;
  companies: { id: string; name: string }[];
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [target, setTarget] = React.useState<Record<string, string>>({});

  if (total === 0) {
    return (
      <p className="surface p-4 text-sm text-muted-foreground">
        Tout est rattaché à une entité. Chaque création porte celle de son auteur, et les vues
        cloisonnées ne laissent donc rien de côté.
      </p>
    );
  }

  const attach = async (model: string) => {
    const companyId = target[model];
    if (!companyId) { setMsg({ ok: false, text: "Choisissez l'entité de rattachement." }); return; }
    const fd = new FormData();
    fd.set("model", model);
    fd.set("companyId", companyId);
    setBusy(model); setMsg(null);
    try {
      const r = await attachOrphansToCompany(fd);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Rattaché.") : (r.error ?? "Les enregistrements n'ont pas été rattachés.") });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">{total}</strong> enregistrement(s) ne portent aucune entité.
        Ils restent lisibles depuis la vue « toutes les entités », mais n&apos;apparaissent dans
        aucune vue cloisonnée. Rattachez-les à la société dont ils relèvent.
      </p>

      {msg && (
        <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}

      <ul className="surface divide-y divide-border">
        {groups.map((g) => (
          <li key={g.model} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{g.label}</span>
              {g.href && (
                <Link href={g.href} className="ml-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  ouvrir <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </span>
            <span className="tabular-nums font-semibold">{g.count}</span>
            <Select
              value={target[g.model] ?? ""}
              onChange={(e) => setTarget((t) => ({ ...t, [g.model]: e.target.value }))}
              className="h-10 min-w-0 flex-1 basis-40 text-xs sm:h-9 sm:w-48 sm:flex-none sm:basis-auto"
              aria-label={`Entité de rattachement — ${g.label}`}
            >
              <option value="">— Entité —</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Button size="sm" variant="outline" disabled={busy === g.model} onClick={() => void attach(g.model)}>
              {busy === g.model ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Rattacher
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
