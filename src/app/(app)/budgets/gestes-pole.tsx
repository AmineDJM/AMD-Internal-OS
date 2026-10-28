"use client";

/**
 * LES GESTES PROPRES À UN PÔLE — Budget Regulatory (les BV) et Budget Operations & Sales (la masse salariale).
 *
 * Compléter les catégories d'office, saisir un BV payé hors circuit, ranger un BV dans l'enveloppe. Les noms des champs
 * sont écrits en clair (contrat des actions) ; l'écran se rafraîchit après chaque geste (`useRafraichir`).
 */

import * as React from "react";
import { Loader2, Plus, ListPlus, ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { completerCategoriesPole, saisirBvManuel, imputerBv } from "@/lib/actions/budget-pole-actions";

type Resultat = { ok: boolean; error?: string; message?: string };

function useGeste() {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const lancer = async (fn: () => Promise<Resultat>, onOk?: () => void) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (r.ok) { if (r.message) setMsg({ ok: true, texte: r.message }); onOk?.(); rafraichir(); } else setMsg({ ok: false, texte: r.error ?? "L'opération n'a pas été enregistrée." });
    } catch {
      setMsg({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };
  return { busy: busy || enCours, msg, lancer };
}

/** Ajoute à l'enveloppe les catégories d'office qui lui manquent (BV 25 % / 75 % ; masse salariale et ses BU). */
export function CompleterCategories({ envelopeId, domaine, libelle }: { envelopeId: string; domaine: "REGULATORY" | "OPERATIONS"; libelle: string }) {
  const { busy, msg, lancer } = useGeste();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm" variant="outline" disabled={busy}
        onClick={() => {
          const fd = new FormData();
          fd.set("envelopeId", envelopeId);
          fd.set("domaine", domaine);
          lancer(() => completerCategoriesPole(fd));
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />} {libelle}
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.texte}</span>}
    </span>
  );
}

/** Saisir un BV réglé sans demande (historique, paiement direct) : dossier, part, montant, « payé le ». */
export function SaisirBv({ envelopeId, dossiers }: { envelopeId: string; dossiers: { id: string; libelle: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const { busy, msg, lancer } = useGeste();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Saisir un BV payé</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Saisir un BV payé" width="md">
        <form
          action={(fd) => { fd.set("envelopeId", envelopeId); lancer(() => saisirBvManuel(fd), () => setOpen(false)); }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Dossier</Label>
            <Select name="productId" required defaultValue="">
              <option value="" disabled>— Choisir —</option>
              {dossiers.map((d) => <option key={d.id} value={d.id}>{d.libelle}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>BV</Label>
            <Select name="nature" required defaultValue="25">
              <option value="25">BV 25 %</option>
              <option value="75">BV 75 %</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Montant (DZD)</Label>
            <Input name="amount" type="number" inputMode="decimal" step="any" min={0} required />
          </div>
          <div className="space-y-1.5">
            <Label>Payé le</Label>
            <Input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
          </div>
          <div className="space-y-1.5">
            <Label>Référence</Label>
            <Input name="reference" placeholder="N° du bon" />
          </div>
          {msg && !msg.ok && <p className="text-sm text-destructive sm:col-span-2">{msg.texte}</p>}
          <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

/** Ranger un BV (demandé ou payé) dans la catégorie de sa part. */
export function RangerBv({ envelopeId, orderId, paye }: { envelopeId: string; orderId: string; paye: boolean }) {
  const { busy, msg, lancer } = useGeste();
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button" disabled={busy}
        title={paye ? "Imputer ce BV payé à l'enveloppe" : "Ranger ce BV demandé dans l'enveloppe"}
        onClick={() => {
          const fd = new FormData();
          fd.set("envelopeId", envelopeId);
          fd.set("orderId", orderId);
          lancer(() => imputerBv(fd));
        }}
        className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-primary hover:bg-secondary disabled:opacity-50 sm:min-h-0"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />} Ranger
      </button>
      {msg && !msg.ok && <span className="text-xs text-destructive">{msg.texte}</span>}
    </span>
  );
}
