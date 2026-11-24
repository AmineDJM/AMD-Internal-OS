"use client";

import * as React from "react";
import { FileCheck2, Loader2, Send, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { declarerCasPv, enregistrerAccuseCasPv, evaluerCasPv, viserCasPv } from "@/lib/actions/pharmacovigilance-actions";
import { IMPUTABILITES_PV, IMPUTABILITE_PV } from "@/lib/pharmacovigilance/declaration";

/**
 * LES GESTES DE LA DÉCLARATION À L'AUTORITÉ (Super Admin, 24/11/2026) — évaluer, enregistrer la déclaration faite hors
 * plateforme (date, référence, pièce, accusé), ajouter l'accusé arrivé ensuite, viser (pharmacien responsable). Chaque
 * formulaire poste ses champs tels quels ; le serveur relit la règle (`declaration.ts`).
 */

function OuiNon({ name, oui, non, defaut }: { name: string; oui: string; non: string; defaut: boolean | null }) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <label className="inline-flex items-center gap-1.5"><input type="radio" name={name} value="oui" defaultChecked={defaut === true} required /> {oui}</label>
      <label className="inline-flex items-center gap-1.5"><input type="radio" name={name} value="non" defaultChecked={defaut === false} /> {non}</label>
    </div>
  );
}

/** Soumettre un formulaire à une action, le geste gardé par `useAction` (une levée ne fige pas l'écran). */
function useSoumission(action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>) {
  const { busy, err, run } = useAction();
  const soumettre = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    void run(() => action(fd));
  };
  return { busy, err, soumettre };
}

export function EvaluationPv({ caseId, defaut }: {
  caseId: string;
  defaut: { grave: boolean | null; attendu: boolean | null; imputabilite: string | null; dateConnaissance: string; note: string | null };
}) {
  const { busy, err, soumettre } = useSoumission(evaluerCasPv);
  return (
    <form onSubmit={soumettre} className="space-y-3 text-sm">
      <input type="hidden" name="caseId" value={caseId} />
      <div className="space-y-1"><Label>Gravité</Label><OuiNon name="grave" oui="Grave" non="Non grave" defaut={defaut.grave} /></div>
      <div className="space-y-1"><Label>Effet</Label><OuiNon name="attendu" oui="Attendu" non="Inattendu" defaut={defaut.attendu} /></div>
      <div className="space-y-1">
        <Label htmlFor="pv-imput">Imputabilité</Label>
        <Select id="pv-imput" name="imputabilite" defaultValue={defaut.imputabilite ?? ""} required>
          <option value="" disabled>Choisir…</option>
          {IMPUTABILITES_PV.map((i) => <option key={i} value={i}>{IMPUTABILITE_PV[i]}</option>)}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pv-connaissance">Connu le (jour zéro du délai)</Label>
        <Input id="pv-connaissance" type="date" name="dateConnaissance" defaultValue={defaut.dateConnaissance} />
      </div>
      <Textarea name="note" defaultValue={defaut.note ?? ""} aria-label="Note d'évaluation" placeholder="Note (facultative)…" className="min-h-[60px]" />
      <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enregistrer l&apos;évaluation
      </Button>
      {err && <Retour ton="erreur">{err}</Retour>}
    </form>
  );
}

export function DeclarationPv({ caseId, aujourdhui }: { caseId: string; aujourdhui: string }) {
  const { busy, err, soumettre } = useSoumission(declarerCasPv);
  return (
    <form onSubmit={soumettre} className="space-y-3 text-sm">
      <input type="hidden" name="caseId" value={caseId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="pv-decl-date">Déclaré le</Label>
          <Input id="pv-decl-date" type="date" name="declareLe" defaultValue={aujourdhui} max={aujourdhui} required />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="pv-decl-ref">Référence</Label>
          <Input id="pv-decl-ref" name="reference" required placeholder="N° attribué ou réf. de l'envoi" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pv-decl-piece">Pièce de la déclaration</Label>
        <Input id="pv-decl-piece" type="file" name="piece" required />
      </div>
      <details className="rounded-lg bg-secondary/40 px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">Accusé de réception déjà reçu</summary>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input type="date" name="accuseLe" max={aujourdhui} aria-label="Date de l'accusé" />
          <Input name="accuseReference" placeholder="Référence de l'accusé" aria-label="Référence de l'accusé" />
          <Input type="file" name="accuseFichier" aria-label="Pièce de l'accusé" className="sm:col-span-2" />
        </div>
      </details>
      <BoutonDecisif size="sm" className="w-full sm:w-auto" disabled={busy} confirmation="Enregistrer la déclaration à l'autorité">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Enregistrer la déclaration
      </BoutonDecisif>
      {err && <Retour ton="erreur">{err}</Retour>}
    </form>
  );
}

export function AccusePv({ caseId, aujourdhui }: { caseId: string; aujourdhui: string }) {
  const { busy, err, soumettre } = useSoumission(enregistrerAccuseCasPv);
  return (
    <form onSubmit={soumettre} className="space-y-2 text-sm">
      <input type="hidden" name="caseId" value={caseId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input type="date" name="accuseLe" max={aujourdhui} required aria-label="Date de l'accusé" />
        <Input name="accuseReference" placeholder="Référence (facultative)" aria-label="Référence de l'accusé" />
        <Input type="file" name="accuseFichier" aria-label="Pièce de l'accusé" className="sm:col-span-2" />
      </div>
      <Button type="submit" size="sm" variant="outline" className="w-full sm:w-auto" disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5" />} Enregistrer l&apos;accusé
      </Button>
      {err && <Retour ton="erreur">{err}</Retour>}
    </form>
  );
}

export function VisaPv({ caseId }: { caseId: string }) {
  const { busy, err, soumettre } = useSoumission(viserCasPv);
  return (
    <form onSubmit={soumettre} className="space-y-2 text-sm">
      <input type="hidden" name="caseId" value={caseId} />
      <Textarea name="note" aria-label="Note du visa" placeholder="Observation (facultative)…" className="min-h-[50px]" />
      <BoutonDecisif size="sm" className="w-full sm:w-auto" disabled={busy} confirmation="Viser la déclaration">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Stamp className="h-3.5 w-3.5" />} Viser la déclaration
      </BoutonDecisif>
      {err && <Retour ton="erreur">{err}</Retour>}
    </form>
  );
}
