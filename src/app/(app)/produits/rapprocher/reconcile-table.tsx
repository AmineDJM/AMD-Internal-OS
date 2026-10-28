"use client";

import * as React from "react";
import { Loader2, Link2, Link2Off, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import type { CatalogReconciliation, OrphanProduct } from "@/lib/queries/product-catalog";
import { linkProductToDossier, unlinkProductFromDossier } from "@/lib/actions/product-catalog-actions";

const KIND_LABEL: Record<"BD" | "PROMO", string> = {
  BD: "Business Development",
  PROMO: "Planning promotionnel",
};

/**
 * L'ÉCRAN DE RAPPROCHEMENT — la machine classe, la personne tranche.
 *
 * Chaque produit orphelin arrive avec ce que le rapprochement a trouvé de plus proche ET LE MOTIF.
 * Le motif est là pour être LU : « même molécule · DOSAGES DIFFÉRENTS (500MG ≠ 1G) » se relit en
 * une seconde et évite l'erreur que la seule ressemblance des noms rendrait irrésistible.
 *
 * Une proposition sûre porte un bouton qui rattache en un clic ; les autres passent par la liste
 * complète des dossiers. Aucun rattachement ne se fait tout seul.
 */
export function ReconcileTable({ data, canLink }: { data: CatalogReconciliation; canLink: boolean }) {
  const geste = useKeyedAction();
  const busy = geste.busy;
  const error = geste.error;
  const [picked, setPicked] = React.useState<Record<string, string>>({});

  const key = (o: { kind: string; id: string }) => `${o.kind}:${o.id}`;

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    await geste.run(id, async () => {
      const r = await fn();
      return r.ok ? r : { ok: false, error: r.error ?? "Le rattachement n'a pas été modifié." };
    });
  }

  return (
    <div className="space-y-5">
      <Retour ton="erreur">{error}</Retour>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          À rapprocher <span className="font-normal text-muted-foreground">({data.orphans.length})</span>
        </h2>
        {data.orphans.length === 0 ? (
          <p className="surface px-3 py-6 text-center text-sm text-muted-foreground">
            Tous les produits des autres modules sont rattachés à un dossier réglementaire.
          </p>
        ) : (
          <ul className="surface divide-y divide-border">
            {data.orphans.map((o) => (
              <OrphanRow
                key={key(o)} orphan={o} canLink={canLink}
                dossiers={data.dossiers}
                picked={picked[key(o)] ?? ""}
                onPick={(v) => setPicked((p) => ({ ...p, [key(o)]: v }))}
                busy={busy === key(o)}
                onLink={(dossierId) => run(key(o), () => linkProductToDossier({ kind: o.kind, id: o.id, regulatoryProductId: dossierId }))}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          Déjà rapprochés <span className="font-normal text-muted-foreground">({data.linked.length})</span>
        </h2>
        {data.linked.length === 0 ? (
          <p className="surface px-3 py-6 text-center text-sm text-muted-foreground">Aucun rapprochement pour l&apos;instant.</p>
        ) : (
          <ul className="surface divide-y divide-border">
            {data.linked.map((l) => (
              <li key={key(l)} className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral" dot={false}>{KIND_LABEL[l.kind]}</Badge>
                    <span className="truncate font-medium">{l.label}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Link2 className="h-3 w-3" /> {l.dossier.label}
                  </span>
                </span>
                {canLink && (
                  <Button size="sm" variant="ghost" disabled={busy === key(l)}
                    onClick={() => run(key(l), () => unlinkProductFromDossier({ kind: l.kind, id: l.id }))}>
                    {busy === key(l) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5" />} Défaire
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function OrphanRow({ orphan, dossiers, canLink, picked, onPick, busy, onLink }: {
  orphan: OrphanProduct;
  dossiers: CatalogReconciliation["dossiers"];
  canLink: boolean;
  picked: string;
  onPick: (v: string) => void;
  busy: boolean;
  onLink: (dossierId: string) => void;
}) {
  const top = orphan.proposals[0];
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" dot={false}>{KIND_LABEL[orphan.kind]}</Badge>
        <span className="font-medium">{orphan.label || "Sans nom"}</span>
        <span className="text-xs text-muted-foreground">{orphan.detail}</span>
      </div>

      {orphan.proposals.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Aucun dossier ne lui ressemble. Choisissez-en un dans la liste, ou laissez-le non rattaché — beaucoup
          de produits à l&apos;étude n&apos;ont pas encore de dossier.
        </p>
      ) : (
        <ul className="space-y-1">
          {orphan.proposals.map((p) => (
            <li key={p.dossier.id} className="flex flex-col gap-1.5 rounded-lg border border-border px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  {p.confident && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
                  <span className="truncate font-medium">{p.dossier.label}</span>
                </span>
                {/* LE MOTIF, en toutes lettres : c'est lui qui empêche de confondre deux dosages. */}
                <span className={cn("mt-0.5 block text-xs", p.reason.includes("DIFFÉRENTS") ? "font-medium text-warning" : "text-muted-foreground")}>
                  {p.reason}
                </span>
              </span>
              {canLink && (
                <Button size="sm" variant={p.confident ? "primary" : "outline"} disabled={busy}
                  onClick={() => onLink(p.dossier.id)} className="shrink-0">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Rattacher
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canLink && (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <Select value={picked} onChange={(e) => onPick(e.target.value)} className="h-9 text-xs sm:h-8">
            <option value="">
              {top ? "…ou choisir un autre dossier" : "Choisir le dossier réglementaire"}
            </option>
            {dossiers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </Select>
          <Button size="sm" variant="outline" disabled={busy || !picked} onClick={() => picked && onLink(picked)} className="shrink-0">
            Rattacher
          </Button>
        </div>
      )}
    </li>
  );
}
