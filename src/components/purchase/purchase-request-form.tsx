"use client";

import * as React from "react";
import { Plus, Trash2, Loader2, ShoppingBasket, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createPurchaseRequest } from "@/lib/actions/purchase-request-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { estimatedTotal, type PurchaseLine } from "@/lib/general-means/purchase-request";
import { formatCurrency } from "@/lib/utils";
import type { CatalogArticle } from "@/app/(app)/moyens-generaux/receipt-lines";

interface Row extends PurchaseLine { key: number }
let uid = 0;
const blank = (): Row => ({ key: uid++, articleId: null, label: "", quantity: 1, unitPrice: null });

/**
 * DEMANDER UN ACHAT — le catalogue, ou « autre ».
 *
 * On coche ce dont on a besoin dans le catalogue de la société, et l'on décrit en clair ce qui
 * n'y figure pas. Les deux comptent : un catalogue fermé oblige à demander « par message » tout
 * ce qui n'a pas été prévu, et ces demandes-là n'existent alors nulle part.
 *
 * Le prix affiché est INDICATIF — il vient du catalogue, qui date du jour où quelqu'un l'a
 * saisi. Il donne un ordre de grandeur à celui qui valide, jamais un engagement : c'est la
 * facture réelle qui fera foi.
 *
 * Le destinataire ne se choisit PAS : c'est le responsable hiérarchique du demandeur. Laisser
 * choisir reviendrait à laisser choisir qui vous dit oui.
 */
export function PurchaseRequestForm({
  articles, managerName,
}: {
  articles: CatalogArticle[];
  /** Le responsable qui recevra la demande, nommé — pour qu'on sache à qui l'on écrit. */
  managerName: string | null;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<Row[]>([blank()]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const total = estimatedTotal(rows);

  const patch = (key: number, p: Partial<Row>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const pickArticle = (key: number, articleId: string) => {
    const a = articles.find((x) => x.id === articleId);
    // Choisir un article REMPLIT le libellé et le prix indicatif ; « autre » les laisse libres.
    patch(key, a
      ? { articleId: a.id, label: a.name, unitPrice: a.estimatedPrice ?? null }
      : { articleId: null, label: "", unitPrice: null });
  };

  const submit = async (fd: FormData) => {
    setBusy(true); setMsg(null);
    fd.set("lines", JSON.stringify(rows.map(({ key: _key, ...l }) => l)));
    let r: Awaited<ReturnType<typeof createPurchaseRequest>>;
    try {
      r = await createPurchaseRequest(undefined, fd);
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      return;
    } finally {
      setBusy(false);
    }
    if (!r.ok) { setMsg({ ok: false, text: r.error ?? "La demande d'achat n'a pas été envoyée." }); return; }
    setMsg({ ok: true, text: r.message ?? "Demande envoyée." });
    setRows([blank()]);
    setOpen(false);
    rafraichir();
  };

  return (
    <div className="space-y-2">
      {!open ? (
        <Button onClick={() => { setOpen(true); setMsg(null); }}>
          <ShoppingBasket className="h-4 w-4" /> Demander un achat
        </Button>
      ) : (
        <form action={submit} className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="text-sm font-medium">
            Ce dont vous avez besoin
            {managerName && <span className="ml-1 font-normal text-muted-foreground">— la demande partira à {managerName}</span>}
          </p>

          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.key} className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-background p-2 sm:grid-cols-[1fr_1fr_5rem_auto]">
                <label className="text-xs">
                  Article du catalogue
                  <Select
                    className="mt-1 h-9"
                    value={r.articleId ?? ""}
                    onChange={(e) => pickArticle(r.key, e.target.value)}
                  >
                    <option value="">Autre (à décrire)</option>
                    {articles.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.unit ? ` (${a.unit})` : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-xs">
                  Précisez
                  <Input
                    className="mt-1 h-9" value={r.label}
                    onChange={(e) => patch(r.key, { label: e.target.value })}
                    placeholder={r.articleId ? "" : "Ex. rallonge électrique 5 m"}
                  />
                </label>
                <label className="text-xs">
                  Quantité
                  <Input
                    className="mt-1 h-9 text-right tabular-nums" inputMode="numeric" value={r.quantity}
                    onChange={(e) => patch(r.key, { quantity: Number(e.target.value) || 1 })}
                  />
                </label>
                <button
                  type="button" aria-label="Retirer la ligne"
                  onClick={() => setRows((cur) => (cur.length > 1 ? cur.filter((x) => x.key !== r.key) : cur))}
                  className="self-end rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => setRows((c) => [...c, blank()])}>
              <Plus className="h-4 w-4" /> Ajouter un article
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pr-desc">Pourquoi (facultatif)</Label>
            <Textarea id="pr-desc" name="description" rows={2} placeholder="Ce à quoi ça sert, l'urgence s'il y en a une…" />
          </div>

          {total != null && (
            <p className="text-xs text-muted-foreground">
              Ordre de grandeur d&apos;après le catalogue : <strong>{formatCurrency(total)}</strong> — indicatif,
              c&apos;est la facture réelle qui fera foi.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer la demande
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
          </div>
        </form>
      )}

      {msg && (
        <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
