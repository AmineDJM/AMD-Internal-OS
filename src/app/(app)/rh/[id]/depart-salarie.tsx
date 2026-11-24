"use client";

import * as React from "react";
import Link from "next/link";
import { DoorOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAction } from "@/components/shared/use-action";
import { annulerFinDeContrat, corrigerFinDeContrat, ouvrirFinDeContrat } from "@/modules/rh/actions-depart";
import {
  LIBELLE_MOTIF_DEPART, LIBELLE_STATUT_DEPART, MOTIFS_DEPART, type ChampsCertificat, type LigneSolde, type MotifDepart, type StatutDepart,
} from "@/modules/rh/partage";
import { DepartSortieListe, type TacheVue } from "./depart-sortie-liste";
import { DepartSolde } from "./depart-solde";
import { DepartCertificat } from "./depart-certificat";
import type { ActionResult } from "@/lib/actions/types";

/** La fin de contrat telle que la page la sérialise (dates en texte). */
export interface DepartVue {
  id: string;
  motif: string;
  dateFin: string;
  preavisJours: number | null;
  note: string | null;
  statut: StatutDepart;
  ouvertLe: string;
  ouvertPar: string;
  compteFermeLe: string | null;
  validation: { id: string; reference: string; etapes: { ordre: number; valideur: string; statut: string; motif: string | null; decideeLe: string | null }[] } | null;
  taches: TacheVue[];
  solde: LigneSolde[] | null;
  soldeModifieLe: string | null;
  certificat: ChampsCertificat | null;
  certificatEmisLe: string | null;
  certificatReference: string | null;
}

const ETAPE: Record<string, { label: string; tone: "info" | "warning" | "danger" | "success" | "neutral" }> = {
  PENDING: { label: "En attente", tone: "info" },
  APPROVED: { label: "Validé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CHANGES_REQUESTED: { label: "Renvoyé", tone: "warning" },
  SKIPPED: { label: "Sans objet", tone: "neutral" },
};
const MARCHES = ["Ressources humaines", "Supérieur hiérarchique", "Direction générale"];

/** Les champs de la fin de contrat — ouverture et correction partagent le même formulaire. */
function ChampsDepart({ d, dateParDefaut }: { d: Pick<DepartVue, "motif" | "dateFin" | "preavisJours" | "note"> | null; dateParDefaut: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="depart-motif">Motif</Label>
        <Select id="depart-motif" name="motif" required defaultValue={d?.motif ?? ""}>
          <option value="" disabled>— Choisir —</option>
          {MOTIFS_DEPART.map((m) => <option key={m} value={m}>{LIBELLE_MOTIF_DEPART[m]}</option>)}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="depart-date">Dernier jour travaillé</Label>
        <Input id="depart-date" name="dateFin" type="date" required defaultValue={d?.dateFin ?? dateParDefaut} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="depart-preavis">Préavis (jours)</Label>
        <Input id="depart-preavis" name="preavisJours" type="number" min={0} max={365} inputMode="numeric" defaultValue={d?.preavisJours ?? ""} />
      </div>
      <div className="space-y-1 sm:col-span-3">
        <Label htmlFor="depart-note">Note pour les valideurs</Label>
        <Textarea id="depart-note" name="note" rows={2} defaultValue={d?.note ?? ""} />
      </div>
    </div>
  );
}

export function DepartSalarie({ employeeId, actif, depart, peutAgir, voitSolde, dateParDefaut }: {
  employeeId: string; actif: boolean; depart: DepartVue | null; peutAgir: boolean; voitSolde: boolean; dateParDefaut: string;
}) {
  const { busy, err, run } = useAction();
  const [ouvert, setOuvert] = React.useState(false);
  const [annuler, setAnnuler] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const soumettre = (fn: (fd: FormData) => Promise<ActionResult>, apres?: () => void) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    void run(async () => { const r = await fn(fd); if (r.ok) setMsg(r.message ?? null); return r; }, apres);
  };

  const close = !depart || depart.statut === "REFUSE" || depart.statut === "ANNULE";
  const peutOuvrir = peutAgir && actif && close;
  // Rien à montrer à qui ne peut pas l'ouvrir : pas de carte vide.
  if (!depart && !peutOuvrir) return null;

  return (
    <Card id="depart">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <DoorOpen className="h-4 w-4" /> Fin de contrat
          {depart && <StatusBadge map={LIBELLE_STATUT_DEPART} value={depart.statut} />}
          {depart?.validation && (
            <Link href={`/validations/${depart.validation.id}`} className="text-xs font-normal text-primary hover:underline">{depart.validation.reference}</Link>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {depart && (
          <div className="space-y-3">
            <p>
              <b>{LIBELLE_MOTIF_DEPART[depart.motif as MotifDepart] ?? depart.motif}</b> — dernier jour le <b>{depart.dateFin.split("-").reverse().join("/")}</b>
              {depart.preavisJours != null && <> · préavis {depart.preavisJours} j</>}
              <span className="text-muted-foreground"> · ouverte par {depart.ouvertPar} le {depart.ouvertLe}</span>
            </p>
            {depart.note && <p className="whitespace-pre-line text-muted-foreground">{depart.note}</p>}
            {depart.validation && (
              <ol className="grid gap-2 sm:grid-cols-3">
                {depart.validation.etapes.map((e) => (
                  <li key={e.ordre} className="rounded-lg border border-border p-2">
                    <p className="text-xs text-muted-foreground">{e.ordre === 1 ? MARCHES[0] : depart.validation!.etapes.length === 3 ? MARCHES[e.ordre - 1] : "Validation finale"}</p>
                    <p className="font-medium [overflow-wrap:anywhere]">{e.valideur}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <StatusBadge map={ETAPE} value={e.statut} dot={false} />
                      {e.decideeLe && <span className="text-xs text-muted-foreground">{e.decideeLe}</span>}
                    </div>
                    {e.motif && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">« {e.motif} »</p>}
                  </li>
                ))}
              </ol>
            )}
            {depart.compteFermeLe && <p className="text-muted-foreground">Fiche et compte fermés le {depart.compteFermeLe}.</p>}
          </div>
        )}

        {depart?.statut === "A_CORRIGER" && peutAgir && (
          <form onSubmit={soumettre(corrigerFinDeContrat)} className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <input type="hidden" name="departId" value={depart.id} />
            <ChampsDepart d={depart} dateParDefaut={dateParDefaut} />
            <div className="space-y-1">
              <Label htmlFor="depart-correction">Ce qui a été corrigé</Label>
              <Input id="depart-correction" name="correction" required />
            </div>
            <BoutonDecisif size="sm" disabled={busy}>Renvoyer en validation</BoutonDecisif>
          </form>
        )}

        {peutOuvrir && !ouvert && (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={() => setOuvert(true)}><DoorOpen className="h-4 w-4" /> Fin de contrat</Button>
            {!depart && <span className="text-muted-foreground">Validation RH → supérieur hiérarchique → DG.</span>}
          </div>
        )}
        {peutOuvrir && ouvert && (
          <form onSubmit={soumettre(ouvrirFinDeContrat, () => setOuvert(false))} className="space-y-3 rounded-lg border border-border p-3">
            <input type="hidden" name="employeeId" value={employeeId} />
            <ChampsDepart d={null} dateParDefaut={dateParDefaut} />
            <div className="flex flex-wrap gap-2">
              <BoutonDecisif size="sm" disabled={busy}>Envoyer en validation</BoutonDecisif>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOuvert(false)}>Fermer</Button>
            </div>
          </form>
        )}

        {depart && !close && !depart.compteFermeLe && peutAgir && (
          annuler ? (
            <form onSubmit={soumettre(annulerFinDeContrat, () => setAnnuler(false))} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="departId" value={depart.id} />
              <div className="min-w-[14rem] flex-1 space-y-1">
                <Label htmlFor="depart-annulation">Motif de l&apos;annulation</Label>
                <Input id="depart-annulation" name="motif" required />
              </div>
              <BoutonDecisif size="sm" variant="destructive" disabled={busy}>Annuler la fin de contrat</BoutonDecisif>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAnnuler(false)}>Fermer</Button>
            </form>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAnnuler(true)}>Annuler la fin de contrat…</Button>
          )
        )}

        {msg && <Retour ton="succes" onFermer={() => setMsg(null)}>{msg}</Retour>}
        <Retour>{err}</Retour>

        {depart?.statut === "VALIDE" && (
          <div className="space-y-5 border-t border-border pt-4">
            <DepartSortieListe departId={depart.id} taches={depart.taches} peutAgir={peutAgir} />
            {voitSolde && <DepartSolde departId={depart.id} lignes={depart.solde ?? []} modifieLe={depart.soldeModifieLe} peutAgir={peutAgir} />}
            {depart.certificat && (
              <DepartCertificat departId={depart.id} champs={depart.certificat} emisLe={depart.certificatEmisLe} reference={depart.certificatReference} peutAgir={peutAgir} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
