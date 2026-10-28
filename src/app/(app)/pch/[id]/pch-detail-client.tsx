"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAction } from "@/components/shared/use-action";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Plus, Pencil, Trash2, Loader2, AlertCircle } from "lucide-react";
import { updateTender, deleteTender, createOrder, updateOrder, deleteOrder } from "@/lib/actions/pch-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PCH_TENDER_STATUS, PCH_ORDER_STATUS } from "@/lib/labels";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils";
import type { PchTenderDTO, PchOrderDTO } from "@/lib/queries/pch";
import type { Market360 } from "@/lib/queries/market-360";
import { OrderExecution } from "./order-execution";

type Action = (fd: FormData) => Promise<{ ok: boolean; error?: string }>;

function W({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}><Label>{label}</Label>{children}</div>;
}

function useSubmit() {
  const { busy: saving, err, setErr, run } = useAction();
  const submit = async (action: Action, fd: FormData, onOk: () => void) => {
    await run(() => action(fd), onOk);
  };
  return { saving, err, setErr, submit };
}

export function EditTenderButton({ tender, canDelete, users = [], businessUnits = [] }: {
  tender: PchTenderDTO; canDelete: boolean;
  users?: { id: string; name: string }[];
  businessUnits?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [open, setOpen] = React.useState(false);
  const { saving, err, setErr, submit } = useSubmit();
  const t = tender;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setErr(null); setOpen(true); }}><Pencil className="h-4 w-4" /> Modifier</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Modifier l'appel d'offres" width="lg">
        <form action={(fd) => { fd.set("id", t.id); submit(updateTender, fd, () => setOpen(false)); }} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* LA RÉFÉRENCE DU MARCHÉ SE CORRIGE ICI. Elle est saisie à la main le jour de la
                publication : une coquille dans le numéro se paie pendant des années. Elle reste
                unique — le serveur refuse en NOMMANT le marché qui la porte déjà. */}
            <W label="Référence du marché"><Input name="reference" defaultValue={t.reference} required placeholder="AO 12/2026" /></W>
            <W full label="Intitulé"><Input name="title" defaultValue={t.title} /></W>
            <W label="Référence interne"><Input name="internalReference" defaultValue={t.internalReference ?? ""} placeholder="AO-2026-ONCO-04" /></W>
            <W label="Responsable interne">
              <Select name="responsibleId" defaultValue={t.responsibleId ?? ""}>
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </W>
            <W label="Publié le"><Input name="publishedAt" type="date" defaultValue={t.publishedAt?.slice(0, 10) ?? ""} /></W>
            <W label="Date limite de dépôt"><Input name="submissionDeadline" type="date" defaultValue={t.submissionDeadline?.slice(0, 10) ?? ""} /></W>
            <W label="Business Unit">
              <Select name="businessUnitId" defaultValue={t.businessUnitId ?? ""}>
                <option value="">—</option>
                {businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </W>
            <W full label="Produits"><Textarea name="products" defaultValue={t.products} /></W>
            <W label="Fournisseur"><Input name="supplier" defaultValue={t.supplier} /></W>
            <W label="Pays du fournisseur"><Input name="supplierCountry" defaultValue={t.supplierCountry} /></W>
            <W label="Quantité"><Input name="quantity" type="number" inputMode="numeric" defaultValue={t.quantity} /></W>
            <W label="Valeur (DZD)"><Input name="value" type="number" step="any" inputMode="decimal" defaultValue={t.value ?? ""} /></W>
            <W label="Client"><Input name="client" defaultValue={t.client} /></W>
            <W label="Statut"><Select name="status" defaultValue={t.status}>{Object.entries(PCH_TENDER_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}</Select></W>
            <W label="Date d'attribution"><Input name="awardDate" type="date" defaultValue={t.awardDate?.slice(0, 10) ?? ""} /></W>
            <W full label="— Caution —"><div /></W>
            <W label="Montant caution (DZD)"><Input name="cautionAmount" type="number" step="any" inputMode="decimal" defaultValue={t.cautionAmount ?? ""} /></W>
            <W label="Déposée ?"><label className="flex h-9 items-center gap-2 text-sm"><input type="hidden" name="cautionDeposited" value="off" /><input type="checkbox" name="cautionDeposited" defaultChecked={t.cautionDeposited} className="h-4 w-4 rounded border-input" /> Caution déposée</label></W>
            <W label="Caution — début"><Input name="cautionStart" type="date" defaultValue={t.cautionStart?.slice(0, 10) ?? ""} /></W>
            <W label="Caution — fin"><Input name="cautionEnd" type="date" defaultValue={t.cautionEnd?.slice(0, 10) ?? ""} /></W>
            <W full label="Notes"><Textarea name="notes" defaultValue={t.notes} /></W>
          </div>
          {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
            {canDelete ? (
              <Button type="button" variant="ghost" className="w-full text-destructive sm:w-auto" onClick={async () => { if (await confirmer("Supprimer cet appel d'offres ? Il part à la corbeille avec ses lots, ses bons de commande et leurs livraisons — le Super Admin peut tout restaurer.")) { const fd = new FormData(); fd.set("id", t.id); deleteTender(fd).then((r) => { if (r.ok) router.push("/pch"); else retours.erreur(r.error ?? "L'appel d'offres n'a pas été supprimé."); }).catch(() => retours.erreur(actionFailureMessage("THROWN"))); } }}>
                <Trash2 className="h-4 w-4" /> Supprimer
              </Button>
            ) : <span className="hidden sm:block" />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto">Annuler</Button>
              <Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
            </div>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function OrdersManager({ tenderId, orders, canEdit, canDelete, canInvoice = false, details = [], contrats = [] }: {
  tenderId: string; orders: PchOrderDTO[]; canEdit: boolean; canDelete: boolean;
  /** Droit FINANCES CREATE — la facture d'un bon se crée depuis le bon, déjà rattachée. */
  canInvoice?: boolean;
  /** L'exécution de chaque bon (lignes, livraisons, factures) — la vue 360°. */
  details?: Market360["bons"];
  contrats?: Market360["contrats"];
}) {
  // L'icône « supprimer » d'une ligne n'a pas de place pour parler : un refus part en avis flottant.
  const suppression = useAction({ signalerErreurs: true });
  const [editing, setEditing] = React.useState<PchOrderDTO | null>(null);
  const [adding, setAdding] = React.useState(false);
  // LE BON DÉPLIÉ : ses lignes, ses livraisons, ses factures. Un seul à la fois — la table
  // reste une table, le détail reste un détail.
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const detailOf = React.useMemo(() => new Map(details.map((d) => [d.id, d])), [details]);
  const { saving, err, setErr, submit } = useSubmit();
  const open = adding || editing !== null;
  const o = editing;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Bons de commande ({orders.length})</h2>
        {canEdit && <Button size="sm" onClick={() => { setErr(null); setAdding(true); }}><Plus className="h-4 w-4" /> Nouveau bon</Button>}
      </div>

      {orders.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">Aucun bon de commande. Ajoutez les bons reçus de la PCH.</p>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead><TableHead>Produits</TableHead><TableHead className="text-right">Qté</TableHead>
                <TableHead className="text-right">Valeur</TableHead><TableHead>Reçu</TableHead><TableHead>Paiement</TableHead><TableHead>Statut</TableHead><TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((ord) => (
                <React.Fragment key={ord.id}>
                <TableRow
                  className={detailOf.has(ord.id) ? "cursor-pointer" : undefined}
                  onClick={() => detailOf.has(ord.id) && setExpanded(expanded === ord.id ? null : ord.id)}
                >
                  <TableCell className="font-mono text-xs [overflow-wrap:anywhere]">{ord.reference || "—"}{ord.estAvenant && <Badge tone="warning" className="ml-1.5 font-sans">Avenant</Badge>}</TableCell>
                  <TableCell className="[overflow-wrap:anywhere]">{ord.products || "—"}</TableCell>
                  <TableCell className="text-right">{formatNumber(ord.quantity)}</TableCell>
                  <TableCell className="text-right">{ord.value !== null ? formatCurrency(ord.value) : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{ord.receivedDate ? formatDate(ord.receivedDate) : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{ord.paymentDate ? formatDate(ord.paymentDate) : "—"}</TableCell>
                  <TableCell><StatusBadge map={PCH_ORDER_STATUS} value={ord.status} /></TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      {canEdit && <button aria-label="Modifier le bon" onClick={(e) => { e.stopPropagation(); setErr(null); setEditing(ord); }} className="rounded p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"><Pencil className="h-4 w-4" /></button>}
                      {canDelete && <button aria-label="Supprimer le bon" onClick={(e) => { e.stopPropagation(); const fd = new FormData(); fd.set("id", ord.id); void suppression.run(() => deleteOrder(fd), undefined, { confirmer: "Supprimer ce bon de commande ?" }); }} disabled={suppression.busy} className="rounded p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </TableCell>
                </TableRow>
                {expanded === ord.id && detailOf.has(ord.id) && (
                  <TableRow>
                    <TableCell colSpan={8} data-sans-etiquette className="bg-transparent p-2">
                      <OrderExecution bon={detailOf.get(ord.id)!} contrats={contrats} canEdit={canEdit} canInvoice={canInvoice} />
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={open} onClose={() => { setAdding(false); setEditing(null); }} title={o ? "Modifier le bon de commande" : "Nouveau bon de commande"} width="md">
        <form
          action={(fd) => {
            if (o) { fd.set("id", o.id); submit(updateOrder, fd, () => setEditing(null)); }
            else { fd.set("tenderId", tenderId); submit(createOrder, fd, () => setAdding(false)); }
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <W label="Référence (n° BC)"><Input name="reference" defaultValue={o?.reference} /></W>
            <W label="Statut"><Select name="status" defaultValue={o?.status ?? "PENDING"}>{Object.entries(PCH_ORDER_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}</Select></W>
            {/* Le CONTRAT exécuté : c'est lui qui ouvre le contrôle du restant sur les lignes. */}
            {!o && contrats.length > 0 && (
              <W full label="Contrat exécuté">
                <Select name="contractId" defaultValue={contrats.length === 1 ? contrats[0].id : ""}>
                  <option value="">— Sans contrat —</option>
                  {contrats.map((c) => <option key={c.id} value={c.id}>{c.reference ? `${c.reference} — ` : ""}{c.title}</option>)}
                </Select>
              </W>
            )}
            <W full label="Produits"><Input name="products" defaultValue={o?.products} /></W>
            <W label="Quantité"><Input name="quantity" type="number" inputMode="numeric" defaultValue={o?.quantity ?? ""} /></W>
            <W label="Valeur (DZD)"><Input name="value" type="number" step="any" inputMode="decimal" defaultValue={o?.value ?? ""} /></W>
            <W label="Date de réception"><Input name="receivedDate" type="date" defaultValue={o?.receivedDate?.slice(0, 10) ?? ""} /></W>
            <W label="Date de paiement"><Input name="paymentDate" type="date" defaultValue={o?.paymentDate?.slice(0, 10) ?? ""} /></W>
            <W full label="Notes"><Textarea name="notes" defaultValue={o?.notes} /></W>
            {/* BC D'AVENANT — au-delà du volume attribué par l'AO. Le témoin caché fait dire « non » à la case décochée. */}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="hidden" name="estAvenant" value="off" />
              <input type="checkbox" name="estAvenant" defaultChecked={o?.estAvenant ?? false} className="h-4 w-4" />
              BC d&apos;avenant (au-delà du volume attribué)
            </label>
          </div>
          {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => { setAdding(false); setEditing(null); }} className="w-full sm:w-auto">Annuler</Button>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
