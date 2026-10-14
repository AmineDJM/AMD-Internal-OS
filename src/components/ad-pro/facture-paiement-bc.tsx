"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Loader2, Receipt, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { formatCurrency } from "@/lib/utils";
import type { BcDePoste, PieceDePoste } from "@/lib/ad-pro/pieces-poste";
import { refusDemandePaiementBC } from "@/lib/bons-de-commande/copie-signee";
import { etatDuPaiement, phrasePaiementBloque } from "@/lib/ad-pro/poste-etapes";
import { deposerFacturePoste, demanderPaiementPoste } from "@/lib/actions/ad-pro-item-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FACTURE ET LA DEMANDE DE PAIEMENT D'UN POSTE À BON DE COMMANDE (Direction, 06/10).
 *
 * « Quand les Finances ont uploadé le BC signé, la case Facture se débloque ; une fois la facture reçue, Luna vérifie
 * uniquement la cohérence avec le bon de commande. Si c'est bon, une case de demande de paiement se déclenche et suit le
 * process habituel ; s'il y a des incohérences, notamment le montant total, ça demande une argumentation, et s'il
 * souhaite quand même faire la demande de paiement, ça le fait s'il coche oui. Ça doit aussi fonctionner avec plusieurs
 * BC. »
 *
 *   • `DeposerFactureBC` — le dépôt : le fichier, et le(s) BC signé(s) qu'il couvre (une facture par BC, ou une pour
 *     plusieurs) ; le montant saisi ne sert que si la lecture échoue.
 *   • `DemandePaiementBC` — la case qui se déclenche quand chaque BC signé a sa facture : le contrôle de chaque facture,
 *     et le geste — direct si tout est cohérent, argumenté et confirmé sinon. La règle est celle de l'action
 *     (`refusDemandePaiementBC`, §118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

const champ = "w-full rounded border border-border bg-background px-1.5 py-2 text-xs outline-none focus:border-primary/60 sm:py-1";

/** Les BC signés qui n'ont pas encore de facture. */
export function bcsSansFacture(bcs: readonly BcDePoste[], factures: readonly PieceDePoste[]): BcDePoste[] {
  const couverts = new Set(factures.filter((f) => !f.annulee).flatMap((f) => f.controle?.bcIds ?? []));
  return bcs.filter((b) => b.etape === "SIGNE" && !couverts.has(b.id));
}

/** Le contrôle d'une facture, en une ligne sous elle. */
export function ControleDeFacture({ piece }: { piece: PieceDePoste }) {
  const c = piece.controle;
  if (!c || piece.annulee) return null;
  return c.coherente ? (
    <p className="flex gap-1 text-success"><CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /> Cohérente avec le bon de commande{c.montant != null ? ` (${formatCurrency(c.montant)})` : ""}.</p>
  ) : (
    <div className="space-y-0.5 text-warning">
      {c.ecarts.map((e, i) => <p key={i} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {e}</p>)}
    </div>
  );
}

export function DeposerFactureBC({ itemId, bcs, factures, busy, run, onClose }: {
  itemId: string; bcs: BcDePoste[]; factures: PieceDePoste[]; busy: string | null; run: Run; onClose: () => void;
}) {
  const libres = bcsSansFacture(bcs, factures);
  // PLUSIEURS PIÈCES (audit Ad & Pro, 14/10) : la PREMIÈRE est la facture, lue et contrôlée ; les suivantes ses annexes.
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const [coches, setCoches] = React.useState<Set<string>>(() => new Set(libres.length === 1 ? [libres[0].id] : []));
  const [montant, setMontant] = React.useState("");
  const [reference, setReference] = React.useState("");
  const enCours = busy === `fac:${itemId}`;
  const deposer = () => {
    const fd = new FormData();
    fd.set("id", itemId);
    for (const f of fichiers) fd.append("attachment", f);
    for (const id of coches) fd.append("bcId", id);
    fd.set("montant", montant);
    fd.set("reference", reference);
    void run(`fac:${itemId}`, () => deposerFacturePoste(fd), "Facture déposée.").then(onClose);
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5 text-xs" aria-label="Déposer la facture">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 font-medium text-foreground">Déposer la facture</p>
        <InfoBulle label="Comment la facture est contrôlée">
          Luna compare la facture au bon de commande signé : montant total, numéro de BC cité, fournisseur. Si tout concorde, la
          demande de paiement s&apos;ouvre.
        </InfoBulle>
        <button type="button" onClick={onClose} className="min-h-9 px-2 text-muted-foreground hover:text-foreground sm:min-h-0 sm:px-0">Fermer</button>
      </div>
      <label className="block space-y-0.5">
        <span className="font-medium text-foreground">Facture (PDF ou photo) — obligatoire, et ses annexes si besoin</span>
        <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" aria-label="Fichiers de la facture" onChange={(e) => setFichiers(Array.from(e.target.files ?? []))} className="block w-full min-w-0 max-w-full py-1 [overflow-wrap:anywhere]" />
      </label>
      {fichiers.length > 1 && (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          « {fichiers[0].name} » est lu comme la facture ; {fichiers.length - 1} autre{fichiers.length > 2 ? "s" : ""} pièce{fichiers.length > 2 ? "s" : ""} jointe{fichiers.length > 2 ? "s" : ""} avec elle.
        </p>
      )}
      {libres.length > 1 && (
        <fieldset className="space-y-0.5">
          <legend className="font-medium text-foreground">Cette facture couvre</legend>
          {libres.map((b) => (
            <label key={b.id} className="flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input
                type="checkbox" checked={coches.has(b.id)} aria-label={`La facture couvre ${b.reference ?? b.titre}`}
                className="shrink-0 max-sm:h-5 max-sm:w-5"
                onChange={(e) => setCoches((cur) => { const n = new Set(cur); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n; })}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{b.reference ?? b.titre}{b.montant != null ? ` — ${formatCurrency(b.montant)}` : ""}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-0.5">N° de facture (facultatif)<input className={champ} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label className="space-y-0.5">Montant TTC (si la lecture échoue)<input className={champ} inputMode="decimal" value={montant} onChange={(e) => setMontant(e.target.value)} /></label>
      </div>
      <Button size="sm" className="h-10 w-full sm:h-8 sm:w-auto" onClick={deposer} disabled={enCours || fichiers.length === 0 || coches.size === 0}>
        {enCours ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Déposer et contrôler
      </Button>
    </div>
  );
}

export function DemandePaiementBC({ itemId, bcs, factures, accorde, peutDemander, expenseOrder, busy, run }: {
  itemId: string; bcs: BcDePoste[]; factures: PieceDePoste[]; accorde: number | null; peutDemander: boolean;
  expenseOrder: { reference: string; status: string; centralStatus?: string | null } | null; busy: string | null; run: Run;
}) {
  const [argumentation, setArgumentation] = React.useState("");
  const [oui, setOui] = React.useState(false);
  const [montantSaisi, setMontantSaisi] = React.useState("");
  if (expenseOrder) {
    // L'ÉTAT RÉEL de l'ordre (audit Ad & Pro, 14/10) : un ordre refusé par le centre, ou annulé, n'est pas « au centre ».
    const etat = etatDuPaiement({ expenseOrderId: expenseOrder.reference, expenseOrderStatus: expenseOrder.status, expenseOrderCentral: expenseOrder.centralStatus ?? null });
    const bloque = phrasePaiementBloque(etat, expenseOrder.reference);
    if (bloque) return <p className="flex gap-1 text-destructive [overflow-wrap:anywhere]"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {bloque}</p>;
    return (
      <p className="inline-flex flex-wrap items-center gap-1 text-muted-foreground [overflow-wrap:anywhere]">
        <Receipt className="h-3 w-3 shrink-0" /> {expenseOrder.reference} · {etat === "PAYE" ? "payé" : "au centre de paiement"}
      </p>
    );
  }
  const vivantes = factures.filter((f) => !f.annulee);
  const attente = refusDemandePaiementBC({
    bcs: bcs.map((b) => ({ id: b.id, reference: b.reference, signe: b.etape === "SIGNE" })), factures: vivantes, argumentation: "x", confirme: true,
  });
  if (attente) {
    return (
      <p className="flex items-center gap-1 text-muted-foreground">
        Après la signature du BC et sa facture.
        {bcs.length > 0 && <InfoBulle label="Ce qui manque" align="left">{attente}</InfoBulle>}
      </p>
    );
  }
  const ecarts = vivantes.flatMap((f) => (f.controle && !f.controle.coherente ? f.controle.ecarts : []));
  const montants = vivantes.map((f) => f.controle?.montant ?? f.montant);
  const total = montants.every((m): m is number => m != null) ? montants.reduce((s, m) => s + m, 0) : null;
  const depasse = total != null && accorde != null && total > accorde;
  const enCours = busy === `pay:${itemId}`;
  const demander = () => {
    const fd = new FormData();
    fd.set("id", itemId);
    if (ecarts.length > 0) { fd.set("argumentation", argumentation); fd.set("confirme", oui ? "1" : "0"); }
    if (total == null) fd.set("montant", montantSaisi);
    void run(`pay:${itemId}`, () => demanderPaiementPoste(undefined, fd), "Paiement demandé au centre de paiement.");
  };
  // UN MONTANT QUI NE SE LIT PAS SE SAISIT ICI (audit Ad & Pro, 14/10) : l'action le demande (« indiquez-le »), et la case
  // n'avait aucun champ pour le faire — la seule issue était d'annuler la facture dans Legal et de la redéposer.
  const montantManquant = total == null && !(Number(montantSaisi.replace(/\s/g, "").replace(",", ".")) > 0);
  return (
    <div className="space-y-1.5">
      <p className="tabular-nums text-foreground">{total != null ? formatCurrency(total) : "Montant à confirmer"}{vivantes.length > 1 ? ` · ${vivantes.length} factures` : ""}</p>
      {total == null && peutDemander && (
        <label className="block space-y-0.5">
          <span className="text-foreground">Montant TTC à payer — la facture ne se lit pas : saisissez-le depuis le papier</span>
          <input className={`${champ} tabular-nums`} inputMode="decimal" value={montantSaisi} onChange={(e) => setMontantSaisi(e.target.value)} />
        </label>
      )}
      {depasse && <p className="flex gap-1 text-destructive"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Au-delà de l&apos;accordé ({formatCurrency(accorde as number)}) : demandez une révision du poste.</p>}
      {ecarts.length > 0 && (
        <div className="space-y-1.5 rounded border border-warning/40 bg-warning/10 p-2">
          <p className="font-medium text-foreground">La facture n&apos;est pas cohérente avec le bon de commande.</p>
          {ecarts.map((e, i) => <p key={i} className="text-warning">{e}</p>)}
          {peutDemander && (
            <>
              <label className="block space-y-0.5">
                <span className="text-foreground">Pourquoi le paiement doit-il tout de même partir ? (obligatoire)</span>
                <textarea className={champ} rows={2} value={argumentation} onChange={(e) => setArgumentation(e.target.value)} />
              </label>
              <label className="flex items-start gap-1.5 py-1 sm:py-0">
                <input type="checkbox" checked={oui} onChange={(e) => setOui(e.target.checked)} className="mt-0.5 shrink-0 max-sm:h-5 max-sm:w-5" aria-label="Faire quand même la demande de paiement" />
                <span>Oui, je souhaite quand même faire la demande de paiement.</span>
              </label>
            </>
          )}
        </div>
      )}
      {peutDemander && !depasse && (
        <BoutonDecisif size="sm" className="max-sm:w-full" onClick={demander} disabled={enCours || montantManquant || (ecarts.length > 0 && (!argumentation.trim() || !oui))}>
          {enCours ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />} Demander le paiement
        </BoutonDecisif>
      )}
    </div>
  );
}
