"use client";

import * as React from "react";
import { FileSignature, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { genererOrdreDeMission, referenceOrdreDeMission } from "@/lib/actions/hr-document-actions";
import { MODES_TRANSPORT_MISSION, VALEURS_DU_MODELE } from "@/lib/hr/ordre-mission/constantes";
import { ChampReference } from "@/components/references/champ-reference";

/**
 * « GÉNÉRER L'ORDRE DE MISSION » (Direction, 06/10) — sur la demande du salarié, côté RH : date d'émission, référence,
 * collaborateur et fonction (pré-remplis), objet, lieu(x), dates de départ et de retour (plusieurs jours possibles),
 * transport, signataire. La plateforme remplit le document de la Direction, à l'identique, et le remet au salarié.
 */
export function OrdreMissionForm({ requestId, employeeName, employeePosition, details, referenceSuggeree, prefill = null }: {
  requestId: string; employeeName: string; employeePosition: string | null; details: string | null; referenceSuggeree: string;
  /** Mission Ad & Pro : objet, lieu et dates repris de la demande (modifiables). */
  prefill?: { objet: string; destination: string; datesDepart: string[]; datesRetour: string[]; transport?: string } | null;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [departs, setDeparts] = React.useState<string[]>(prefill?.datesDepart.length ? prefill.datesDepart : [""]);
  const [retours, setRetours] = React.useState<string[]>(prefill?.datesRetour.length ? prefill.datesRetour : [""]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [refRefusee, setRefRefusee] = React.useState(false);
  const aujourdhui = new Date().toISOString().slice(0, 10);

  if (!ouvert) {
    return (
      <Button size="sm" onClick={() => setOuvert(true)}>
        <FileSignature className="h-4 w-4" /> Générer l&apos;ordre de mission
      </Button>
    );
  }
  const listeDates = (nom: string, valeurs: string[], maj: (v: string[]) => void) => (
    <div className="space-y-1">
      {valeurs.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input type="date" name={nom} value={v} onChange={(e) => maj(valeurs.map((x, k) => (k === i ? e.target.value : x)))} aria-label={`${nom === "dateDepart" ? "Date de départ" : "Date de retour"} ${i + 1}`} />
          {valeurs.length > 1 && (
            <button type="button" onClick={() => maj(valeurs.filter((_, k) => k !== i))} className="shrink-0 rounded p-2.5 text-muted-foreground hover:bg-secondary sm:p-1" aria-label="Retirer cette date"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => maj([...valeurs, ""])} className="inline-flex items-center gap-1 py-1.5 text-xs text-primary hover:underline sm:py-0"><Plus className="h-3 w-3" /> Ajouter un jour</button>
    </div>
  );

  return (
    <form
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("requestId", requestId);
        setBusy(true); setMsg(null);
        const r = await genererOrdreDeMission(fd);
        setBusy(false);
        setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Ordre de mission généré.") : (r.error ?? "Échec.") });
        if (r.ok) { setOuvert(false); rafraichir(); }
      }}
    >
      <p className="text-sm font-medium">Ordre de mission — généré sur le modèle de la Direction</p>
      {details && <p className="rounded bg-background px-2 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">Demande du salarié : « {details} »</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1"><Label>Date d&apos;émission</Label><Input type="date" name="dateEmission" defaultValue={aujourdhui} required /></div>
        <ChampReference
          label="Référence (N°)" repli={referenceSuggeree} cle={requestId}
          charger={() => { const fd = new FormData(); fd.set("requestId", requestId); fd.set("entreprise", VALEURS_DU_MODELE.entreprise); return referenceOrdreDeMission(fd); }}
          onChange={(e) => setRefRefusee(e.erreur !== null)}
        />
        <div className="space-y-1"><Label>Collaborateur</Label><Input name="collaborateur" autoComplete="off" defaultValue={employeeName} placeholder="Mme Radia KEBIR" required /></div>
        <div className="space-y-1"><Label>Fonction</Label><Input name="fonction" defaultValue={employeePosition ?? ""} /></div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Objet — « … ayant pour but … »</Label>
          <Textarea name="objet" rows={2} required defaultValue={prefill?.objet ?? ""} placeholder="de récupérer une commande de goodies chez Eprint à Kouba et de les apporter à l'aéroport d'Alger…" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Lieu(x) de la mission — un par ligne</Label>
          <Textarea name="destination" rows={2} required defaultValue={prefill?.destination ?? ""} placeholder={"Ben Omar Kouba\nAéroport d'Alger"} />
        </div>
        <div className="space-y-1"><Label>Date(s) de départ</Label>{listeDates("dateDepart", departs, setDeparts)}</div>
        <div className="space-y-1"><Label>Date(s) de retour</Label>{listeDates("dateRetour", retours, setRetours)}</div>
        <div className="space-y-1">
          <Label>Mode de transport</Label>
          <Input name="transport" list={`transports-${requestId}`} defaultValue={prefill?.transport || MODES_TRANSPORT_MISSION[0]} required />
          <datalist id={`transports-${requestId}`}>{MODES_TRANSPORT_MISSION.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
        <div className="space-y-1">
          <Label>Entreprise</Label>
          <Select name="entreprise" defaultValue={VALEURS_DU_MODELE.entreprise}><option value={VALEURS_DU_MODELE.entreprise}>{VALEURS_DU_MODELE.entreprise}</option></Select>
        </div>
        <div className="space-y-1 sm:col-span-2"><Label>Adresse</Label><Input name="adresse" defaultValue={VALEURS_DU_MODELE.adresse} /></div>
        <div className="space-y-1"><Label>Signataire</Label><Input name="signataire" defaultValue={VALEURS_DU_MODELE.signataire} required /></div>
        <div className="space-y-1"><Label>Fonction du signataire</Label><Input name="signataireFonction" defaultValue={VALEURS_DU_MODELE.signataireFonction} /></div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button size="sm" type="submit" className="w-full sm:w-auto" disabled={busy || enCours || refRefusee}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />} Générer et remettre au salarié
        </Button>
        <Button size="sm" type="button" variant="ghost" className="w-full sm:w-auto" onClick={() => setOuvert(false)}>Annuler</Button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.texte}</p>}
    </form>
  );
}
