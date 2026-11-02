"use client";

import * as React from "react";
import Link from "next/link";
import { useAction } from "@/components/shared/use-action";
import { useConfirmer } from "@/components/ui/dialogue";
import { ExternalLink, FileSignature, Loader2, Plus, Trash2 } from "lucide-react";
import {
  addContractLine, createAmendment, createContractFromAward, deleteContractLine,
  linkContractToTender, setAmendmentEffective,
} from "@/lib/actions/pch-market-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils";
import type { Market360 } from "@/lib/queries/market-360";

/**
 * CONTRAT & AVENANTS — la vue MARCHÉ du même objet que Legal (§16, §64).
 *
 * Le contrat est un LegalDocument : ici son contexte d'exécution (lignes, quantités, valeur
 * courante), dans Legal sa couche juridique (revue, lecteurs, échéances). Le lien « Ouvrir
 * dans Legal » matérialise le principe : UN objet, DEUX vues.
 *
 * La valeur COURANTE affichée vient du serveur (initial + deltas effectifs) — jamais
 * recalculée ici : un client qui refait le calcul du serveur finit par le contredire.
 */

type LigneAo = { id: string; designation: string; produitId: string | null };

export function ContractPanel({ tenderId, contrats, lignesAo, aDesGagnes, canPch, canLegal }: {
  tenderId: string;
  contrats: Market360["contrats"];
  lignesAo: LigneAo[];
  aDesGagnes: boolean;
  canPch: boolean;
  canLegal: boolean;
}) {
  const { busy, err, setErr, run } = useAction();
  const confirmer = useConfirmer();
  const [creating, setCreating] = React.useState(false);
  const [amendingId, setAmendingId] = React.useState<string | null>(null);
  const [linking, setLinking] = React.useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Contrat &amp; avenants
        </h2>
        <div className="flex flex-wrap gap-2">
          {canPch && contrats.length > 0 === false && (
            <Button size="sm" variant="outline" onClick={() => { setErr(null); setLinking(true); }}>
              Rattacher un contrat existant
            </Button>
          )}
          {canPch && canLegal && aDesGagnes && (
            <Button size="sm" onClick={() => { setErr(null); setCreating(true); }}>
              <FileSignature className="h-4 w-4" /> Créer le contrat depuis l&apos;attribution
            </Button>
          )}
        </div>
      </div>

      {contrats.length === 0 && (
        <p className="surface p-4 text-sm text-muted-foreground">
          {aDesGagnes
            ? "Marché gagné : le contrat reste à enregistrer — il naît des lots attribués en un geste."
            : "Le contrat apparaîtra ici après l'attribution."}
        </p>
      )}

      {contrats.map((c) => (
        <div key={c.id} className="surface space-y-3 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{c.title}</span>
            {c.reference && <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{c.reference}</span>}
            <Badge tone={c.status === "ACTIVE" ? "success" : c.status === "CANCELLED" ? "danger" : "neutral"} dot={false}>
              {c.status === "ACTIVE" ? "En vigueur" : c.status === "EXPIRED" ? "Échu" : c.status === "CANCELLED" ? "Annulé" : c.status}
            </Badge>
            <Link href={`/legal/${c.id}`} className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline">
              Ouvrir dans Legal <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Fact label="Montant initial" value={c.montantInitial !== null ? formatCurrency(c.montantInitial) : "—"} />
            <Fact
              label="Valeur courante"
              value={c.valeurCourante !== null ? formatCurrency(c.valeurCourante) : "—"}
              accent={c.valeurCourante !== null && c.valeurCourante !== c.montantInitial}
            />
            <Fact label="Signé le" value={c.signedAt ? formatDate(c.signedAt.toString()) : "—"} />
            <Fact label="Échéance" value={c.endDate ? formatDate(c.endDate.toString()) : "sans terme"} />
          </div>

          {c.lignes.length > 0 && (
            <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ligne contractuelle</TableHead>
                    <TableHead className="text-right">Quantité</TableHead>
                    <TableHead className="text-right">Prix (DZD)</TableHead>
                    <TableHead>Portée par</TableHead>
                    {canLegal && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.lignes.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell data-sans-etiquette className="font-medium [overflow-wrap:anywhere]">
                        {l.designation}
                        {l.produit && <Link href={`/produits/${l.produit.id}`} title={l.produit.nom} className="ml-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] text-primary hover:underline">{l.produit.code}</Link>}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${l.quantityUnits < 0 ? "text-destructive" : ""}`}>
                        {l.surAvenant && l.quantityUnits > 0 ? "+" : ""}{formatNumber(l.quantityUnits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.unitPriceDzd !== null ? formatNumber(l.unitPriceDzd) : "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{l.surAvenant ? "avenant" : "contrat"}</TableCell>
                      {canLegal && (
                        <TableCell className="text-right">
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Retirer la ligne ${l.designation}`}
                            onClick={async () => {
                              if (!(await confirmer(`Retirer la ligne « ${l.designation} » (${l.quantityUnits} u.) ?`))) return;
                              void run(() => { const fd = new FormData(); fd.set("id", l.id); return deleteContractLine(fd); });
                            }}
                            className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                          >
                            <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                          </button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
            </Table>
          )}

          {c.avenants.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Avenants</p>
              {c.avenants.map((a, i) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{a.title || `Avenant n° ${i + 1}`}</span>
                  {a.reference && <span className="font-mono text-xs text-muted-foreground">{a.reference}</span>}
                  {a.amountDelta !== null && (
                    <span className={`tabular-nums ${a.amountDelta < 0 ? "text-destructive" : "text-success"}`}>
                      {a.amountDelta > 0 ? "+" : ""}{formatCurrency(a.amountDelta)}
                    </span>
                  )}
                  {a.effectif ? (
                    <Badge tone="success" dot={false}>Effectif{a.effectiveAt ? ` — ${formatDate(a.effectiveAt.toString())}` : ""}</Badge>
                  ) : a.status === "CANCELLED" ? (
                    <Badge tone="danger" dot={false}>Annulé</Badge>
                  ) : (
                    <Badge tone="warning" dot={false}>{a.signedAt ? "Signé, pas encore effectif" : "En préparation"}</Badge>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {canLegal && !a.effectif && a.status !== "CANCELLED" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => {
                        const fd = new FormData(); fd.set("id", a.id);
                        return setAmendmentEffective(fd);
                      })}>
                        Rendre effectif
                      </Button>
                    )}
                    <Link href={`/legal/${a.id}`} className="inline-flex min-h-9 items-center px-1 text-xs text-primary hover:underline sm:min-h-0">Legal</Link>
                  </span>
                </div>
              ))}
            </div>
          )}

          {canLegal && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => { setErr(null); setAmendingId(c.id); }}>
                <Plus className="h-4 w-4" /> Nouvel avenant
              </Button>
              <AddLineForm contract={c} lignesAo={lignesAo} busy={busy} run={run} />
            </div>
          )}
        </div>
      ))}

      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {/* ── Créer le contrat depuis l'attribution ─────────────────────────────────────────── */}
      <Sheet open={creating} onClose={() => setCreating(false)} title="Créer le contrat depuis l'attribution" description="Une pièce Legal naît avec une ligne par lot gagné (quantités et prix d'attribution). Le montant proposé se corrige : le contrat signé fait foi." width="md">
        <form action={(fd) => { fd.set("tenderId", tenderId); void run(() => createContractFromAward(fd), () => setCreating(false)); }} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Référence du contrat"><Input name="reference" placeholder="174/2026" /></Field>
            <Field label="Montant (DZD) — vide = calculé"><Input name="amount" type="number" step="any" inputMode="decimal" /></Field>
            <Field full label="Intitulé"><Input name="title" placeholder="Contrat PCH — …" /></Field>
            <Field label="Date d'effet"><Input name="startDate" type="date" /></Field>
            <Field label="Échéance"><Input name="endDate" type="date" /></Field>
            <Field label="Date de signature"><Input name="signedAt" type="date" /></Field>
            <Field label="Contrepartie"><Input name="counterparty" placeholder="PCH" /></Field>
            <Field full label="Notes"><Textarea name="notes" /></Field>
          </div>
          <FormFooter busy={busy} onCancel={() => setCreating(false)} submitLabel="Créer le contrat" />
        </form>
      </Sheet>

      {/* ── Nouvel avenant ─────────────────────────────────────────────────────────────────── */}
      <Sheet open={amendingId !== null} onClose={() => setAmendingId(null)} title="Nouvel avenant" description="L'avenant est une pièce Legal. Ses montants et quantités sont des DELTAS : le contrat initial n'est jamais réécrit, la valeur courante se calcule." width="md">
        <form action={(fd) => { fd.set("contractId", amendingId ?? ""); void run(() => createAmendment(fd), () => setAmendingId(null)); }} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field full label="Intitulé"><Input name="title" placeholder="Avenant n° 1 — extension Pembrolizumab" /></Field>
            <Field label="Référence"><Input name="reference" /></Field>
            <Field label="Impact financier (± DZD)"><Input name="amountDelta" type="number" step="any" placeholder="180000 ou -50000" /></Field>
            <Field label="Signé le"><Input name="signedAt" type="date" /></Field>
            <Field label="Effectif le — vide = pas encore"><Input name="effectiveAt" type="date" /></Field>
            <Field full label="Motif / description"><Textarea name="notes" /></Field>
          </div>
          <p className="text-xs text-muted-foreground">Les quantités s&apos;ajoutent ensuite ligne par ligne (« Ajouter une ligne », portée par l&apos;avenant).</p>
          <FormFooter busy={busy} onCancel={() => setAmendingId(null)} submitLabel="Créer l'avenant" />
        </form>
      </Sheet>

      {/* ── Rattacher un contrat existant ──────────────────────────────────────────────────── */}
      <Sheet open={linking} onClose={() => setLinking(false)} title="Rattacher un contrat existant" description="Pour l'historique déjà saisi dans Legal : coller l'identifiant du contrat (visible dans son adresse /legal/…)." width="md">
        <form action={(fd) => { fd.set("tenderId", tenderId); void run(() => linkContractToTender(fd), () => setLinking(false)); }} className="space-y-4">
          <Field label="Identifiant du contrat Legal"><Input name="contractId" placeholder="cl…" required /></Field>
          <FormFooter busy={busy} onCancel={() => setLinking(false)} submitLabel="Rattacher" />
        </form>
      </Sheet>
    </div>
  );
}

/** L'ajout d'une ligne contractuelle — sur le contrat de base ou l'un de ses avenants. */
function AddLineForm({ contract, lignesAo, busy, run }: {
  contract: Market360["contrats"][number];
  lignesAo: LigneAo[];
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Ajouter une ligne
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Ligne contractuelle" description="Une quantité NÉGATIVE ne se pose que sur un avenant (réduction)." width="md">
        <form
          action={(fd) => {
            const aoId = String(fd.get("tenderLineId") ?? "");
            const ao = lignesAo.find((l) => l.id === aoId);
            if (ao?.produitId) fd.set("productId", ao.produitId);
            void run(() => addContractLine(fd), () => setOpen(false));
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field full label="Portée par">
              <Select name="documentId" defaultValue={contract.id}>
                <option value={contract.id}>Contrat de base</option>
                {contract.avenants.map((a, i) => <option key={a.id} value={a.id}>{a.title || `Avenant n° ${i + 1}`}</option>)}
              </Select>
            </Field>
            <Field full label="Lot de l'AO correspondant (facultatif)">
              <Select name="tenderLineId" defaultValue="">
                <option value="">— Aucun —</option>
                {lignesAo.map((l) => <option key={l.id} value={l.id}>{l.designation}</option>)}
              </Select>
            </Field>
            <Field full label="Désignation (telle que la pièce l'écrit)"><Input name="designation" required /></Field>
            <Field label="Quantité (unités, ± sur avenant)"><Input name="quantityUnits" type="number" required /></Field>
            <Field label="Prix unitaire (DZD)"><Input name="unitPriceDzd" type="number" step="any" inputMode="decimal" /></Field>
          </div>
          <FormFooter busy={busy} onCancel={() => setOpen(false)} submitLabel="Ajouter" />
        </form>
      </Sheet>
    </>
  );
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-medium tabular-nums [overflow-wrap:anywhere] ${accent ? "text-primary" : ""}`}>{value}</p>
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
