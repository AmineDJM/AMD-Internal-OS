"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Download, ExternalLink, FileText, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";
import { cn, formatDate } from "@/lib/utils";
import { ancreBat } from "@/lib/chemins/ad-pro";
import { deciderConformitePoste } from "@/modules/ad-pro/actions-postes-execution";
import type { FileConformite, LigneBat } from "@/modules/ad-pro/api";

/**
 * « BAT À CONTRÔLER » (Direction, 23/11/2026) — tout ce qu'il faut pour décider, SUR LA LIGNE : la demande et son produit,
 * l'agence, le cahier des charges, TOUS les BAT (le plus récent d'abord ; les versions précédentes avec leur « non conforme »),
 * puis « Conforme » ou « Non conforme » (ce qu'il faut corriger, exigé). Puis ce qui attend un BAT corrigé, et les décidés.
 * La ligne porte l'ancre de la notification (`#bat-<poste>`) : elle s'y ouvre surlignée.
 */

const jours = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

function Fichiers({ ligne }: { ligne: LigneBat }) {
  if (ligne.fichiers.length === 0) return <p className="text-xs text-muted-foreground">Aucun fichier BAT joint.</p>;
  return (
    <ul className="space-y-1.5">
      {ligne.fichiers.map((f, i) => (
        <li key={f.id} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm", i > 0 && f.verdict && "text-muted-foreground")}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">{f.nom}</a>
          <span className="shrink-0 text-xs text-muted-foreground">BAT n° {f.tour} · {formatDate(f.le, { day: "numeric", month: "short" })}</span>
          {f.verdict && (
            <span className={cn("shrink-0 rounded border px-1.5 text-[0.6875rem]", f.verdict.conforme ? "border-success/40 text-success" : "border-destructive/40 text-destructive")}>
              {f.verdict.conforme ? "conforme" : "non conforme"}
            </span>
          )}
          <a href={`/api/documents/${f.id}?dl=1`} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-secondary" aria-label={`Télécharger ${f.nom}`}>
            <Download className="h-3.5 w-3.5" /> Télécharger
          </a>
          {f.verdict && !f.verdict.conforme && f.verdict.note && (
            <p className="w-full pl-5 text-xs text-destructive [overflow-wrap:anywhere]">À corriger : « {f.verdict.note} »</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Decision({ ligne }: { ligne: LigneBat }) {
  const { saving, err, run } = useAction();
  const [note, setNote] = React.useState("");
  const [manque, setManque] = React.useState(false);
  const decider = (decision: "CONFORME" | "NON_CONFORME") => {
    if (decision === "NON_CONFORME" && !note.trim()) { setManque(true); return; }
    const fd = new FormData();
    fd.set("id", ligne.itemId);
    fd.set("decision", decision);
    if (note.trim()) fd.set("note", note.trim());
    void run(() => deciderConformitePoste(fd), () => setNote(""), { succes: decision === "CONFORME" ? "BAT déclaré conforme." : "BAT déclaré non conforme : la Direction Marketing est prévenue." });
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
      <ul className="grid grid-cols-1 gap-x-4 text-xs text-muted-foreground sm:grid-cols-2">
        <li>• Mentions légales et RCP conformes</li><li>• N° de visa publicitaire présent</li>
        <li>• Aucune allégation hors AMM</li><li>• Logo et dénomination conformes</li>
      </ul>
      <Label htmlFor={`bat-note-${ligne.itemId}`}>Ce qu&apos;il faut corriger (exigé si non conforme)</Label>
      <Textarea id={`bat-note-${ligne.itemId}`} value={note} rows={2} onChange={(e) => { setNote(e.target.value); setManque(false); }} />
      {manque && <p className="text-xs text-destructive">Dites ce qu&apos;il faut corriger : l&apos;agence reprendra le BAT d&apos;après vous.</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="success" disabled={saving} onClick={() => decider("CONFORME")}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Conforme
        </Button>
        <Button size="sm" variant="destructive" disabled={saving} onClick={() => decider("NON_CONFORME")}>
          <XCircle className="h-4 w-4" /> Non conforme
        </Button>
      </div>
    </div>
  );
}

function CarteBat({ ligne, peutDecider, ancre = true }: { ligne: LigneBat; peutDecider: boolean; ancre?: boolean }) {
  const attente = jours(ligne.depuis);
  return (
    <li id={ancre ? ancreBat(ligne.itemId) : undefined} className="scroll-mt-20 space-y-3 rounded-xl border border-border bg-card p-3 target:border-primary target:ring-2 target:ring-primary/30 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium [overflow-wrap:anywhere]">{ligne.poste} <span className="font-normal text-muted-foreground">· {ligne.nature}</span></p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {ligne.ref} — {ligne.demande}
            {ligne.agence ? ` · agence : ${ligne.agence}` : ""}
            {ligne.produits ? ` · produit : ${ligne.produits}` : ""}
          </p>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", attente > 2 ? "text-warning" : "text-muted-foreground")}>
          <Clock className="h-3.5 w-3.5" /> {ligne.statut === "EN_CONTROLE" ? `envoyé ${attente ? `il y a ${attente} j` : "aujourd'hui"}` : `décidé le ${formatDate(ligne.depuis)}`}
          {ligne.statut === "EN_CONTROLE" && ligne.envoyePar ? ` par ${ligne.envoyePar}` : ""}
        </span>
      </div>
      {ligne.cahierDesCharges && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Cahier des charges</summary>
          <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">{ligne.cahierDesCharges}</p>
        </details>
      )}
      <Fichiers ligne={ligne} />
      {ligne.statut === "NON_CONFORME" && (
        <p className="text-xs text-muted-foreground">Non conforme{ligne.decidePar ? ` (${ligne.decidePar})` : ""} — la Direction Marketing fait corriger le BAT par l&apos;agence ; il vous reviendra ici.</p>
      )}
      {ligne.statut === "CONFORME" && (
        <p className="inline-flex items-center gap-1 text-xs text-success"><ShieldCheck className="h-3.5 w-3.5" /> Conforme{ligne.decidePar ? ` — ${ligne.decidePar}` : ""} : l&apos;impression peut partir.</p>
      )}
      {ligne.statut === "EN_CONTROLE" && peutDecider && <Decision ligne={ligne} />}
      {ligne.lienPoste && (
        <Link href={ligne.lienPoste} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> Ouvrir le poste sur la demande
        </Link>
      )}
    </li>
  );
}

export function BatAControler({ file, peutDecider }: { file: FileConformite; peutDecider: boolean }) {
  return (
    <section id="bat" className="scroll-mt-20 space-y-3" aria-labelledby="titre-bat">
      <div>
        <h2 id="titre-bat" className="text-base font-semibold">BAT à contrôler <span className="font-normal text-muted-foreground">({file.aControler.length})</span></h2>
        <p className="text-xs text-muted-foreground">Mentions légales, visa publicitaire, allégations — avant impression. Votre décision part à la Direction Marketing.</p>
      </div>
      {file.aControler.length === 0
        ? <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">Aucun BAT n&apos;attend votre contrôle.</p>
        : <ul className="space-y-3">{file.aControler.map((l) => <CarteBat key={l.itemId} ligne={l} peutDecider={peutDecider} />)}</ul>}
      {file.enAttenteCorrection.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">En attente d&apos;un BAT corrigé ({file.enAttenteCorrection.length})</summary>
          <ul className="mt-3 space-y-3">{file.enAttenteCorrection.map((l) => <CarteBat key={l.itemId} ligne={l} peutDecider={false} />)}</ul>
        </details>
      )}
      {file.decides.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Décidés — les {file.decides.length} derniers</summary>
          <ul className="mt-3 space-y-3">{file.decides.map((l) => <CarteBat key={`d-${l.itemId}`} ligne={l} peutDecider={false} ancre={false} />)}</ul>
        </details>
      )}
    </section>
  );
}
