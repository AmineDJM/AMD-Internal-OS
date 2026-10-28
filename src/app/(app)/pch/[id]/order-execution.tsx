"use client";

import * as React from "react";
import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Loader2, PackageCheck, Plus, Trash2 } from "lucide-react";
import { addOrderLine, createDelivery, deleteDelivery, deleteOrderLine } from "@/lib/actions/pch-market-actions";
import { AttachToSourceButtons } from "@/components/shared/attach-to-source";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatNumber } from "@/lib/utils";
import { boxCount } from "@/lib/pch/box-economics";
import type { Market360 } from "@/lib/queries/market-360";

/**
 * L'EXÉCUTION D'UN BON DE COMMANDE — ses lignes (reliées au contrat), ses livraisons (BL, lot
 * pharmaceutique, péremption), ses factures Finance.
 *
 * LE DÉPASSEMENT NE SE CONTOURNE PAS EN SILENCE : quand le serveur refuse (« excès N »),
 * l'écran MONTRE le refus et propose UN geste explicite de passage en force — qui s'audite.
 * Cacher le bouton aurait fait saisir la commande hors ERP ; le montrer garde l'écart visible.
 */
export function OrderExecution({ bon, contrats, canEdit, canInvoice }: {
  bon: Market360["bons"][number];
  contrats: Market360["contrats"];
  canEdit: boolean;
  /** Droit FINANCES CREATE : ouvre la création d'une facture DÉJÀ rattachée à ce bon. */
  canInvoice: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [depassement, setDepassement] = React.useState<{ fd: FormData; message: string } | null>(null);
  const [addingLine, setAddingLine] = React.useState(false);
  const [delivering, setDelivering] = React.useState(false);

  const lignesContractuelles = contrats.flatMap((c) =>
    c.lignes.map((l) => ({ id: l.id, label: `${l.designation} (${l.surAvenant ? "avenant" : "contrat"}, ${formatNumber(l.quantityUnits)} u.)` })),
  );

  // Ne lève jamais : une levée devient un refus lisible, que l'appelant peut encore examiner.
  const run = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done?: () => void): Promise<{ ok: boolean; error?: string; message?: string }> => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (!r.ok) { setErr(r.error ?? "Le bon de commande n'a pas été mis à jour."); return r; }
      done?.();
      rafraichir();
      return r;
    } catch {
      const echec = actionFailureMessage("THROWN");
      setErr(echec);
      return { ok: false, error: echec };
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg bg-secondary/40 p-3">
      {/* ── Les lignes du bon ─────────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lignes du bon</p>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setAddingLine(true); }}>
              <Plus className="h-3.5 w-3.5" /> Ligne
            </Button>
          )}
        </div>
        {bon.lignes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune ligne détaillée — le contrôle du restant contractuel passe par elles.</p>
        ) : (
          <ul className="space-y-1">
            {bon.lignes.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-1.5 text-sm">
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] sm:truncate">{l.designation}</span>
                <span className="tabular-nums">{formatNumber(l.quantityUnits)} u.</span>
                {/* LA QUANTITÉ EN BOÎTES, calculée — jamais stockée : un chiffre dérivé qu'on
                    enregistre devient faux le jour où l'on corrige la quantité sans y penser. */}
                {boxCount(l.quantityUnits, l.unitsPerBox) != null && (
                  <span className="tabular-nums text-xs text-muted-foreground">= {formatNumber(boxCount(l.quantityUnits, l.unitsPerBox) as number)} bt</span>
                )}
                {l.boxPriceDzd != null && (
                  <span className="tabular-nums text-xs text-muted-foreground">{formatNumber(l.boxPriceDzd)} DZD / bt</span>
                )}
                {l.quantiteLivree > 0 && (
                  <span className="text-xs text-success">livré {formatNumber(l.quantiteLivree)}</span>
                )}
                {!l.contractLineId && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] text-warning" title="Sans lien contractuel : hors contrôle du restant">hors contrat</span>}
                {canEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Retirer la ligne ${l.designation}`}
                    onClick={async () => {
                      if (!(await confirmer(`Retirer la ligne « ${l.designation} » ?`))) return;
                      void run(() => { const fd = new FormData(); fd.set("id", l.id); return deleteOrderLine(fd); });
                    }}
                    className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                  >
                    <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Les livraisons ────────────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Livraisons</p>
          {canEdit && bon.lignes.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setDelivering(true); }}>
              <PackageCheck className="h-3.5 w-3.5" /> Livraison
            </Button>
          )}
        </div>
        {bon.livraisons.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune livraison enregistrée.</p>
        ) : (
          <ul className="space-y-1">
            {bon.livraisons.map((d) => (
              <li key={d.id} className="rounded-md bg-card px-2.5 py-1.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.reference ? `BL ${d.reference}` : "Livraison"}</span>
                  {d.deliveredAt ? (
                    <Badge tone="success" dot={false}>Livrée le {formatDate(d.deliveredAt.toString())}</Badge>
                  ) : d.expectedAt && new Date(d.expectedAt) < new Date() ? (
                    <Badge tone="danger" dot={false}>En retard — attendue le {formatDate(d.expectedAt.toString())}</Badge>
                  ) : (
                    <Badge tone="info" dot={false}>{d.expectedAt ? `Attendue le ${formatDate(d.expectedAt.toString())}` : "Planifiée"}</Badge>
                  )}
                  {d.reserves && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] text-warning">réserves émises</span>}
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label="Supprimer la livraison"
                      onClick={async () => {
                        if (!(await confirmer("Supprimer cette livraison ? Les mouvements de stock liés sont CONSERVÉS."))) return;
                        void run(() => { const fd = new FormData(); fd.set("id", d.id); return deleteDelivery(fd); });
                      }}
                      className="ml-auto rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                    >
                      <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </button>
                  )}
                </div>
                {d.lignes.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {d.lignes.map((dl) =>
                      `${formatNumber(dl.quantityUnits)} u. ${dl.designation}${dl.batchNumber ? ` (lot ${dl.batchNumber}${dl.expiryDate ? `, exp. ${formatDate(dl.expiryDate.toString())}` : ""})` : ""}`,
                    ).join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Les factures Finance du bon ───────────────────────────────────────────────────────
          La facture reste une pièce FINANCES (createInvoice, mêmes verrous) : ici on la crée
          simplement DÉJÀ rattachée (sourceType=PCH_ORDER) — le seul moment où le lien se fait. */}
      {(bon.factures.length > 0 || canInvoice) && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Factures</p>
            {canInvoice && (
              <AttachToSourceButtons entityType="PCH_ORDER" entityId={bon.id} reference={bon.reference} kinds={["invoice"]} />
            )}
          </div>
          {bon.factures.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune facture rattachée à ce bon.</p>
          ) : (
          <ul className="space-y-1">
            {bon.factures.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-1.5 text-sm">
                <Link href={`/legal/${f.id}`} className="min-w-0 flex-1 text-primary [overflow-wrap:anywhere] hover:underline sm:truncate">
                  {f.number ? `${f.number} — ` : ""}{f.title}
                </Link>
                {f.amount !== null && <span className="tabular-nums">{formatNumber(f.amount)} DZD</span>}
                <Badge tone={f.status === "PAID" ? "success" : f.status === "IN_CIRCUIT" ? "info" : f.status === "CANCELLED" ? "neutral" : f.dueDate && new Date(f.dueDate) < new Date() ? "danger" : "warning"} dot={false}>
                  {f.status === "PAID" ? "Réglée" : f.status === "IN_CIRCUIT" ? "En règlement" : f.status === "CANCELLED" ? "Annulée" : f.dueDate && new Date(f.dueDate) < new Date() ? "Échue" : "À régler"}
                </Badge>
                {/* Les courriers DE CETTE facture (relance, mise en demeure…) — reliés depuis
                    la fiche courrier (« Relier à… » → Facture) ou par Adam. */}
                {f.courriers.length > 0 && (
                  <span className="w-full text-xs text-muted-foreground">
                    Courriers :{" "}
                    {f.courriers.map((c, i) => (
                      <React.Fragment key={c.id}>
                        {i > 0 && " · "}
                        <Link href={`/courriers/${c.id}`} className="text-primary hover:underline">
                          {c.reference ? `${c.reference} — ` : ""}{c.title}
                        </Link>
                      </React.Fragment>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          )}
        </div>
      )}

      {/* ── Les courriers reliés à CE bon (« Relier à… » depuis la fiche courrier). ───────── */}
      {bon.courriers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Courriers du bon</p>
          <ul className="space-y-1">
            {bon.courriers.map((c) => (
              <li key={c.id} className="rounded-md bg-card px-2.5 py-1.5 text-sm">
                <Link href={`/courriers/${c.id}`} className="text-primary hover:underline">
                  {c.reference ? `${c.reference} — ` : ""}{c.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {/* ── Ajouter une ligne (avec le circuit de dépassement) ────────────────────────────── */}
      <Sheet open={addingLine} onClose={() => setAddingLine(false)} title="Ligne de bon de commande" description="Reliée à sa ligne contractuelle, la quantité est contrôlée contre le restant du contrat." width="md">
        <form
          action={(fd) => {
            fd.set("orderId", bon.id);
            void run(() => addOrderLine(fd), () => setAddingLine(false)).then((r) => {
              if (r && !r.ok && r.message === "DEPASSEMENT") {
                setErr(null);
                setDepassement({ fd, message: r.error ?? "Dépassement contractuel." });
              }
            });
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field full label="Ligne contractuelle">
              <Select name="contractLineId" defaultValue="">
                <option value="">— Hors contrat —</option>
                {lignesContractuelles.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Select>
            </Field>
            <Field full label="Désignation"><Input name="designation" required /></Field>
            {/* LE BON SE COMMANDE EN BOÎTES, LE CONTRAT SE CONTRÔLE EN UNITÉS.
                Le conditionnement du bon peut différer de celui de l'AO — c'est celui qui sera
                réellement livré. Le prix de la BOÎTE fait foi quand il est saisi ; le prix
                unitaire, dont vit le contrôle du restant contractuel, s'en déduit au serveur
                (`lib/pch/box-economics.ts`). */}
            <Field label="Quantité (unités)"><Input name="quantityUnits" type="number" min={1} inputMode="numeric" required /></Field>
            <Field label="Boîte de N unités"><Input name="unitsPerBox" type="number" min={1} inputMode="numeric" placeholder="ex. 30" /></Field>
            <Field label="Prix / boîte (DZD)"><Input name="boxPriceDzd" type="number" step="any" inputMode="decimal" /></Field>
            <Field label="Prix unitaire (DZD)"><Input name="unitPriceDzd" type="number" step="any" inputMode="decimal" placeholder="déduit du prix / boîte" /></Field>
          </div>
          <FormFooter busy={busy} onCancel={() => setAddingLine(false)} submitLabel="Ajouter" />
        </form>
      </Sheet>

      {/* Le refus de dépassement : chiffré, et le passage en force est UN geste, tracé. */}
      <Sheet open={depassement !== null} onClose={() => setDepassement(null)} title="Dépassement contractuel" width="md">
        <div className="space-y-4">
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm">{depassement?.message}</p>
          <p className="text-sm text-muted-foreground">
            Passer outre enregistre la ligne ET trace le dépassement dans l&apos;audit — l&apos;écart
            reste visible au lieu de disparaître dans une saisie hors ERP.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setDepassement(null)} className="w-full sm:w-auto">Annuler</Button>
            <Button
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => {
                const fd = depassement!.fd;
                fd.set("force", "true");
                void run(() => addOrderLine(fd), () => { setDepassement(null); setAddingLine(false); });
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Passer outre (tracé)
            </Button>
          </div>
        </div>
      </Sheet>

      {/* ── Enregistrer une livraison ─────────────────────────────────────────────────────── */}
      <Sheet open={delivering} onClose={() => setDelivering(false)} title="Enregistrer une livraison" description="Les quantités se saisissent ligne par ligne ; lot pharmaceutique et péremption quand le BL les donne." width="md">
        <form action={(fd) => { fd.set("orderId", bon.id); void run(() => createDelivery(fd), () => setDelivering(false)); }} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="N° de BL"><Input name="reference" /></Field>
            <Field label="Livrée le — vide = planifiée"><Input name="deliveredAt" type="date" /></Field>
            <Field label="Attendue le"><Input name="expectedAt" type="date" /></Field>
            <Field label="Lieu"><Input name="location" placeholder="PCH" /></Field>
            <Field full label="Réserves à réception (vide = conforme)"><Input name="reserves" /></Field>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quantités livrées</p>
            {bon.lignes.map((l) => (
              <div key={l.id} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-4">
                <span className="col-span-2 text-sm [overflow-wrap:anywhere] sm:col-span-2 sm:truncate" title={l.designation}>{l.designation}</span>
                <Input name={`qty_${l.id}`} type="number" min={0} inputMode="numeric" placeholder={`sur ${l.quantityUnits}`} aria-label={`Quantité livrée — ${l.designation}`} />
                <Input name={`batch_${l.id}`} placeholder="Lot pharma" aria-label={`Lot pharmaceutique — ${l.designation}`} />
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="createStockMovements" className="h-4 w-4 rounded border-input" />
            Écrire les mouvements de stock (sortie) — seulement pour les produits résolus sans ambiguïté
          </label>
          <FormFooter busy={busy} onCancel={() => setDelivering(false)} submitLabel="Enregistrer" />
        </form>
      </Sheet>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}><Label>{label}</Label>{children}</div>;
}

function FormFooter({ busy, onCancel, submitLabel }: { busy: boolean; onCancel: () => void; submitLabel: string }) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" onClick={onCancel} className="w-full sm:w-auto">Annuler</Button>
      <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy && <Loader2 className="h-4 w-4 animate-spin" />} {submitLabel}</Button>
    </div>
  );
}
