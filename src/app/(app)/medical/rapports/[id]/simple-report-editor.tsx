"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Mic, Square, Loader2, Send, Paperclip, FileText, Download, Trash2, RotateCcw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { FIELD_REPORT_STATUS } from "@/lib/labels";
import { formatBytes } from "@/app/(app)/messages/format";
import { submitFieldReport, reopenFieldReport, deleteFieldReportAttachment } from "@/lib/actions/field-report-actions";
import type { FieldReportDetail } from "@/lib/queries/field-reports";
import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { DoctorPicker } from "./doctor-picker";
import { BlocMaterielRemis, type RemisesInitiales } from "../../ma-journee/materiel-remis";
import type { StockPourVisite } from "@/lib/queries/promo-remises";

/** Le matériel du compte rendu : le stock en main du KAM, et ce que ce compte rendu a déjà remis. */
export interface MaterielDuRapport { stock: StockPourVisite; initial: RemisesInitiales }

const AUCUN_PRODUIT: ReadonlySet<string> = new Set();

/**
 * Vue **délégué** simple : un seul compte rendu (synthèse) — on parle (ou on écrit) —
 * + médecin(s), établissement, spécialité, date, pièces jointes. On envoie.
 *
 * Et le MATÉRIEL REMIS (§118.204) : le même bloc que les trois autres portes d'une visite faite,
 * lu et vérifié par le même module côté serveur. Un compte rendu rattaché à une visite de l'emploi
 * du temps n'en porte pas — la visite le porte — et l'écran le dit au lieu de proposer un geste
 * que l'action refuserait (§118.83).
 */
export function SimpleReportEditor({ detail, doctors, materiel, rattacheAUneVisite }: {
  detail: FieldReportDetail;
  doctors: { id: string; name: string }[];
  materiel: MaterielDuRapport | null;
  rattacheAUneVisite: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const sent = detail.status === "VALIDATED";

  const [summary, setSummary] = React.useState(detail.summary ?? detail.transcript ?? "");
  const [visitDate, setVisitDate] = React.useState(detail.visitDate.slice(0, 10));
  const [doctorIds, setDoctorIds] = React.useState<string[]>(detail.doctorIds);
  const [doctorName, setDoctorName] = React.useState(detail.doctorName ?? "");
  const [institution, setInstitution] = React.useState(detail.institution ?? "");
  const [specialty, setSpecialty] = React.useState(detail.specialty ?? "");
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const mr = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const materielRef = React.useRef<HTMLFormElement>(null);

  const startRec = async () => {
    setMsg(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMsg("Le micro nécessite une connexion sécurisée (HTTPS). Vous pouvez aussi écrire votre compte rendu ci-dessous.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); await uploadAudio(new Blob(chunks.current, { type: rec.mimeType || "audio/webm" })); };
      rec.start(); mr.current = rec; setRecording(true);
    } catch {
      setMsg("Micro inaccessible — autorisez-le dans le navigateur, ou écrivez votre compte rendu ci-dessous.");
    }
  };
  const stopRec = () => { mr.current?.stop(); setRecording(false); };

  const uploadAudio = async (blob: Blob) => {
    setTranscribing(true); setMsg(null);
    try {
      const f = new FormData(); f.set("file", blob, "audio.webm");
      const res = await fetch(`/api/field-reports/${detail.id}/transcribe`, { method: "POST", body: f });
      const data = await res.json();
      if (data.transcript) setSummary((prev) => (prev ? `${prev}\n${data.transcript}` : data.transcript));
      else setMsg(data.error ?? "Transcription indisponible — vous pouvez écrire à la main.");
    } catch { setMsg("Envoi de l'audio impossible."); }
    finally { setTranscribing(false); }
  };

  const send = async () => {
    if (!summary.trim()) { setMsg("Dictez ou écrivez d'abord votre compte rendu."); return; }
    setSending(true); setMsg(null);
    const f = new FormData();
    f.set("id", detail.id); f.set("summary", summary); f.set("visitDate", visitDate);
    f.set("doctorIds", doctorIds.join(",")); f.set("doctorName", doctorName);
    f.set("institution", institution); f.set("specialty", specialty);
    // Les champs du bloc « Matériel remis » (mêmes noms que dans « Ma journée »).
    if (materielRef.current) for (const [k, v] of new FormData(materielRef.current)) f.append(k, v);
    try {
      const r = await submitFieldReport(f);
      if (r.ok) router.push(CHEMIN_RAPPORTS_TERRAIN); else setMsg(r.error ?? "Envoi impossible.");
    } catch {
      setMsg(actionFailureMessage("THROWN"));
    } finally {
      setSending(false);
    }
  };

  const reopen = async () => {
    const f = new FormData(); f.set("id", detail.id);
    try { await reopenFieldReport(f); } catch { setMsg(actionFailureMessage("THROWN")); return; }
    rafraichir();
  };

  const uploadAttachment = async (file: File) => {
    const f = new FormData(); f.set("file", file);
    const res = await fetch(`/api/field-reports/${detail.id}/upload`, { method: "POST", body: f });
    if (res.ok) rafraichir(); else { const d = await res.json(); setMsg(d.error ?? "Échec de la pièce jointe."); }
  };

  if (sent) {
    return (
      <div className="space-y-4">
        <div className="surface flex flex-wrap items-center gap-3 p-3">
          <StatusBadge map={FIELD_REPORT_STATUS} value={detail.status} />
          <span className="inline-flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" /> Compte rendu envoyé.</span>
          <Button variant="outline" size="sm" className="h-10 w-full sm:ml-auto sm:h-8 sm:w-auto" onClick={reopen}><RotateCcw className="h-4 w-4" /> Corriger / renvoyer</Button>
        </div>
        <div>
          <Label>Compte rendu (synthèse)</Label>
          <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 text-sm">{detail.summary || detail.transcript || "—"}</p>
        </div>
        {materiel && materiel.initial.materiel.length > 0 && (
          <div>
            <Label>Matériel remis</Label>
            <ul className="mt-1 space-y-0.5 text-sm">
              {materiel.initial.materiel.map((m) => (
                <li key={m.itemId}>{m.libelle} — {m.quantite.toLocaleString("fr-FR", { maximumFractionDigits: 3 })}</li>
              ))}
            </ul>
          </div>
        )}
        <Attachments detail={detail} readOnly />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface flex flex-wrap items-center gap-3 p-3">
        <StatusBadge map={FIELD_REPORT_STATUS} value={detail.status} />
        {/* Au téléphone, « Parler » est un grand bouton : c'est le geste de quelqu'un qui sort d'un cabinet. */}
        {recording ? (
          <Button variant="destructive" size="sm" className="h-12 flex-1 text-sm sm:h-8 sm:flex-none sm:text-xs" onClick={stopRec}><Square className="h-4 w-4" /> Arrêter</Button>
        ) : (
          <Button size="sm" className="h-12 flex-1 text-sm sm:h-8 sm:flex-none sm:text-xs" onClick={startRec} disabled={transcribing}>{transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />} Parler</Button>
        )}
        <Button size="sm" className="ml-auto hidden sm:inline-flex" onClick={send} disabled={sending}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer mon compte rendu</Button>
      </div>

      {recording && <p className="flex items-center gap-2 text-sm text-destructive"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" /> Enregistrement… parlez naturellement.</p>}
      {msg && <p className="rounded-lg bg-accent/60 px-3 py-2 text-sm text-accent-foreground">{msg}</p>}

      <div className="space-y-1.5">
        <Label>Compte rendu (synthèse)</Label>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={7} placeholder="Dictez avec « Parler », ou écrivez ici votre compte rendu de visite…" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Date de visite</Label><Input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Spécialité (optionnel)</Label><Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Ex. Cardiologie" /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Médecin(s) — annuaire</Label><DoctorPicker doctors={doctors} value={doctorIds} onChange={setDoctorIds} /></div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Nom du médecin (si absent de l&apos;annuaire)</Label>
          <Input value={doctorName} onChange={(e) => setDoctorName(e.target.value)} placeholder="Ex. Dr Karim Benali" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Établissement / hôpital (optionnel)</Label>
          <Input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Ex. CHU Mustapha, Clinique El Azhar…" />
        </div>
      </div>

      {materiel ? (
        <form ref={materielRef} onSubmit={(e) => e.preventDefault()}>
          <BlocMaterielRemis stock={materiel.stock} produitsCoches={AUCUN_PRODUIT} initial={materiel.initial} />
        </form>
      ) : rattacheAUneVisite ? (
        <p className="rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-foreground">
          Ce compte rendu raconte une visite de votre emploi du temps : le matériel remis se déclare dans le rapport de cette visite (Promotion médicale › Ma journée).
        </p>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Pièces jointes (tout type)</Label>
          <Button variant="outline" size="sm" className="h-10 sm:h-8" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Ajouter</Button>
          <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAttachment(f); e.target.value = ""; }} />
        </div>
        <Attachments detail={detail} onDeleted={rafraichir} />
      </div>

      {/* TÉLÉPHONE : l'envoi colle au bas de l'écran, sous le pouce, pendant toute la saisie. */}
      <div className="sticky bottom-2 z-10 rounded-xl border border-border bg-card/95 p-2 shadow-md backdrop-blur sm:hidden">
        <Button className="h-12 w-full" onClick={send} disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer mon compte rendu
        </Button>
      </div>
    </div>
  );
}

function Attachments({ detail, readOnly, onDeleted }: { detail: FieldReportDetail; readOnly?: boolean; onDeleted?: () => void }) {
  const confirmer = useConfirmer();
  const retours = useRetours();
  if (detail.attachments.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {detail.attachments.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
          {a.isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <a href={`/api/field-reports/attachment/${a.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/field-reports/attachment/${a.id}`} alt={a.name} className="h-10 w-10 rounded object-cover" /></a>
          ) : <FileText className="h-8 w-8 shrink-0 text-primary" />}
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{a.name}</p><p className="text-[0.6875rem] text-muted-foreground">{formatBytes(a.size)}</p></div>
          <a href={`/api/field-reports/attachment/${a.id}?dl=1`} aria-label={`Télécharger ${a.name}`} className="shrink-0 rounded-lg p-2.5 text-muted-foreground hover:bg-secondary sm:rounded sm:p-1"><Download className="h-4 w-4" /></a>
          {!readOnly && (
            <button onClick={async () => { if (await confirmer("Supprimer ?")) { const f = new FormData(); f.set("id", a.id); deleteFieldReportAttachment(f).then(() => onDeleted?.(), () => retours.erreur(actionFailureMessage("THROWN"))); } }} aria-label={`Supprimer ${a.name}`} className="shrink-0 rounded-lg p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:rounded sm:p-1"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      ))}
    </div>
  );
}
