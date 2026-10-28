"use client";

import * as React from "react";
import { Check, Clock, Download, Loader2, MoreHorizontal, Send, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { MeetingControls } from "@/components/shared/hr-meeting-controls";
import { ExpenseClaimHrPanel } from "@/components/hr/expense-claim-hr-panel";
import { DocumentList } from "@/components/documents/document-list";
import { HR_REQUEST_TYPE } from "@/lib/labels";
import { cn, formatCurrency, formatDate, formatDateTime, formatMonth, initials } from "@/lib/utils";
import { joursCivilsDepuis } from "@/lib/calendar-tz";
import { CATEGORIE_DU_DEPOT, hrNature, type HrNature } from "@/lib/hr-request-flow";
import {
  addHrRequestComment, decideExpenseReport, decideHrLeave, deleteHrRequest, processHrRequest,
} from "@/lib/actions/hr-document-actions";
import type { HrQueueItem } from "@/lib/queries/hr-documents";
import { OrdreMissionForm } from "../[id]/ordre-mission-form";
import { AttestationTravailForm } from "../[id]/attestation-travail-form";
import { sansBloquer } from "@/lib/journal";

/**
 * LA FILE DES DEMANDES RH (Direction, 07/10 — maquette « Demandes RH ») : UNE ligne par demande, la plus ancienne en
 * tête, UN geste (« Traiter », « Reprendre »). « Traiter » ouvre sous la ligne le panneau de traitement : trois étapes,
 * le dépôt du document qui rend la demande « prête » et prévient le salarié, le générateur quand il existe (ordre de
 * mission, attestation de travail), « Refuser… » avec un motif, un message au salarié et le fil. Les gestes rares vont dans
 * « ⋯ ».
 *
 * Mêmes actions serveur que la fiche du salarié : seul l'écran change.
 */

export type FiltreDemandes = "a-traiter" | "en-cours" | "pretes";

const STATUTS_TERMINES = ["READY", "DELIVERED", "APPROVED", "REJECTED", "CANCELLED"];
/** Les statuts que `processHrRequest` accepte tels quels (une note s'enregistre sans changer l'état). */
const STATUTS_NOTE = ["PENDING", "IN_PROGRESS", "READY", "DELIVERED", "REJECTED"];

const VIDE: Record<FiltreDemandes, string> = {
  "a-traiter": "Aucune demande à traiter.",
  "en-cours": "Aucune demande en cours.",
  pretes: "Aucune demande prête ces 30 derniers jours.",
};

export function FileDemandesRh({ demandes, filtre, referenceOrdreMission, currentUserId, lienFiche, maintenant, demandeAOuvrir }: {
  demandes: HrQueueItem[];
  filtre: FiltreDemandes;
  referenceOrdreMission: string;
  currentUserId: string;
  /** La personne voit-elle les fiches des salariés (module Employés) ? Le nom mène alors à la fiche. */
  lienFiche: boolean;
  /** L'instant du serveur (ISO) : le rendu et l'hydratation disent la même ancienneté. */
  maintenant: string;
  /** ID de la demande à ouvrir automatiquement via query param (?demande=...) */
  demandeAOuvrir?: string | null;
}) {
  const [ouverte, setOuverte] = React.useState<string | null>(demandeAOuvrir ?? null);
  // Arrivé par une notification : la ligne ouverte vient sous les yeux, pas en bas d'une longue file.
  React.useEffect(() => {
    if (demandeAOuvrir) document.getElementById(`demande-${demandeAOuvrir}`)?.scrollIntoView({ block: "start" });
  }, [demandeAOuvrir]);
  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Demandes des salariés</h2>
        <span className="text-xs text-muted-foreground">{filtre === "pretes" ? "les plus récentes d'abord" : "les plus anciennes d'abord"}</span>
      </header>
      {demandes.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{VIDE[filtre]}</p>
      ) : (
        <ul className="divide-y divide-border">
          {demandes.map((r) => (
            <LigneDemande
              key={r.id} r={r} ouverte={ouverte === r.id}
              basculer={() => setOuverte((id) => (id === r.id ? null : r.id))}
              referenceOrdreMission={referenceOrdreMission} currentUserId={currentUserId}
              lienFiche={lienFiche} maintenant={maintenant}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Initiales({ nom }: { nom: string }) {
  return (
    <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {initials(nom || "?")}
    </span>
  );
}

/** L'état de la ligne : l'ancienneté d'une demande soumise, sinon où elle en est — et chez qui (au survol). */
function etatDeLaLigne(r: HrQueueItem, maintenant: string): { texte: string; chezQui: string; ton: string } {
  switch (r.status) {
    case "PENDING": {
      const n = joursCivilsDepuis(new Date(r.createdAt), new Date(maintenant));
      return { texte: n <= 0 ? "aujourd'hui" : n === 1 ? "hier" : `il y a ${n} j`, chezQui: "Soumise — chez les RH", ton: "bg-warning/15 text-warning-foreground" };
    }
    case "IN_PROGRESS": return { texte: "en cours", chezQui: "En préparation — chez les RH", ton: "bg-primary/10 text-primary" };
    case "READY": return { texte: "prête", chezQui: "Prête — chez le salarié", ton: "bg-success/10 text-success" };
    case "DELIVERED": return { texte: "remise", chezQui: "Remise — au salarié", ton: "bg-secondary text-muted-foreground" };
    case "APPROVED": return { texte: "accordée", chezQui: "Accordée — au salarié", ton: "bg-success/10 text-success" };
    case "REJECTED": return { texte: "refusée", chezQui: "Refusée — au salarié", ton: "bg-destructive/10 text-destructive" };
    default: return { texte: "annulée", chezQui: "Annulée par le salarié", ton: "bg-secondary text-muted-foreground" };
  }
}

/** Le motif en une ligne : ce que le salarié a écrit, ou ce qui décrit la demande (montant, période). */
function motifCourt(r: HrQueueItem): string | null {
  if (r.type === "EXPENSE_REPORT") {
    const morceaux = [
      r.expenseAmount != null ? formatCurrency(r.expenseAmount) : null,
      r.expenseMonth ? formatMonth(r.expenseMonth) : null,
      r.documents.length > 0 ? `${r.documents.length} justificatif${r.documents.length > 1 ? "s" : ""}` : null,
    ].filter(Boolean);
    return morceaux.length ? morceaux.join(" · ") : r.details;
  }
  if (r.periodStart) {
    return `${formatDate(r.periodStart)}${r.periodEnd ? ` → ${formatDate(r.periodEnd)}` : ""}${r.periodDays ? ` · ${r.periodDays} j` : ""}`;
  }
  return r.details ? `« ${r.details} »` : null;
}

function LigneDemande({ r, ouverte, basculer, referenceOrdreMission, currentUserId, lienFiche, maintenant }: {
  r: HrQueueItem; ouverte: boolean; basculer: () => void;
  referenceOrdreMission: string; currentUserId: string; lienFiche: boolean; maintenant: string;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [passage, setPassage] = React.useState(false);
  const nature = hrNature(r.type);
  const etat = etatDeLaLigne(r, maintenant);
  const motif = motifCourt(r);
  const geste = r.status === "PENDING" ? "Traiter" : r.status === "IN_PROGRESS" ? "Reprendre" : "Ouvrir";

  // OUVRIR UNE DEMANDE SOUMISE LA MET « EN PRÉPARATION » — l'action de statut existante (la note RH est gardée), pour
  // une demande de document seulement : un congé, une note de frais ou une entrevue ont leur propre décision.
  const ouvrir = async () => {
    basculer();
    if (ouverte || r.status !== "PENDING" || nature !== "DOCUMENT") return;
    setPassage(true);
    const fd = new FormData();
    fd.set("id", r.id); fd.set("status", "IN_PROGRESS");
    if (r.hrNote) fd.set("hrNote", r.hrNote);
    const res = await processHrRequest(fd);
    setPassage(false);
    if (res.ok) rafraichir();
  };

  return (
    <li id={`demande-${r.id}`} className="scroll-mt-20">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_auto_auto]">
        <div className="flex min-w-0 items-center gap-2.5">
          <Initiales nom={r.employeeName} />
          <div className="min-w-0">
            {lienFiche
              ? <a href={`/rh/${r.employeeId}`} className="block truncate text-sm font-medium hover:underline">{r.employeeName}</a>
              : <p className="truncate text-sm font-medium">{r.employeeName}</p>}
            {r.employeePosition && <p className="truncate text-xs text-muted-foreground">{r.employeePosition}</p>}
          </div>
        </div>
        <div className="order-3 col-span-full min-w-0 md:order-none md:col-span-1">
          <p className="text-sm font-medium">{HR_REQUEST_TYPE[r.type] ?? r.type}</p>
          {motif && <p className="line-clamp-1 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={r.details ?? undefined}>{motif}</p>}
        </div>
        <span title={etat.chezQui} className={cn("hidden whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium md:inline-flex", etat.ton)}>{etat.texte}</span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={ouverte ? "outline" : "primary"} onClick={ouvrir} disabled={passage || enCours} aria-expanded={ouverte}>
            {passage ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {ouverte ? "Fermer" : geste}
          </Button>
          <MenuPlus r={r} lienFiche={lienFiche} />
        </div>
      </div>
      {ouverte && (
        <PanneauTraitement r={r} nature={nature} referenceOrdreMission={referenceOrdreMission} currentUserId={currentUserId} />
      )}
    </li>
  );
}

/** « ⋯ » — les gestes rares : la note RH, la fiche, l'archive, supprimer. */
function MenuPlus({ r, lienFiche }: { r: HrQueueItem; lienFiche: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [note, setNote] = React.useState(r.hrNote ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!ouvert) return;
    const ailleurs = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOuvert(false); };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setOuvert(false); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("mousedown", ailleurs);
      document.removeEventListener("touchstart", ailleurs);
      document.removeEventListener("keydown", echap);
    };
  }, [ouvert]);

  const enregistrerNote = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("id", r.id); fd.set("status", r.status); fd.set("hrNote", note);
    const res = await processHrRequest(fd);
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "Échec.");
    else { setOuvert(false); rafraichir(); }
  };
  const supprimer = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set("id", r.id);
    const res = await deleteHrRequest(fd);
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "Échec.");
    else { setOuvert(false); rafraichir(); }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOuvert((o) => !o)} aria-haspopup="menu" aria-expanded={ouvert} aria-label="Autres actions"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:h-8 sm:w-8"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {ouvert && (
        <div role="menu" className="absolute right-0 z-50 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2 rounded-lg border border-border bg-background p-2.5 text-sm shadow-lg">
          {STATUTS_NOTE.includes(r.status) && (
            <div className="space-y-1.5">
              <label htmlFor={`note-${r.id}`} className="text-xs font-medium text-muted-foreground">Note RH (vue par le salarié)</label>
              <Input id={`note-${r.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
              <Button size="sm" variant="outline" className="w-full" disabled={busy || enCours || note === (r.hrNote ?? "")} onClick={enregistrerNote}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer la note
              </Button>
            </div>
          )}
          {lienFiche && <a href={`/rh/${r.employeeId}`} className="rounded-md px-2 py-1.5 hover:bg-secondary">Fiche du salarié</a>}
          {r.archivedNodeId && <a href={`/drive/${r.archivedNodeId}`} className="rounded-md px-2 py-1.5 hover:bg-secondary">Dossier traité (Drive)</a>}
          <BoutonDecisif brut
            type="button" disabled={busy || enCours} onClick={supprimer}
            confirmation="Supprimer la demande"
            className="w-full rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Supprimer la demande
          </BoutonDecisif>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      )}
    </div>
  );
}

type Etape = { texte: string; etat: "fait" | "encours" | "avenir" | "refus" };

/** Les trois étapes d'une demande, selon sa nature : reçue, ce qu'elle attend (et de qui), la remise au salarié. */
function frise(r: HrQueueItem, nature: HrNature): Etape[] {
  const recue: Etape = { texte: `Reçue le ${formatDate(r.createdAt, { day: "numeric", month: "short" })}`, etat: "fait" };
  const termine = STATUTS_TERMINES.includes(r.status);
  if (r.status === "REJECTED" || r.status === "CANCELLED") {
    return [recue, { texte: r.status === "REJECTED" ? "Refusée" : "Annulée par le salarié", etat: "refus" }, { texte: "Réponse au salarié", etat: "fait" }];
  }
  let milieu: Etape;
  if (nature === "DOCUMENT") {
    milieu = r.fulfilmentDocId || termine
      ? { texte: "Document joint", etat: "fait" }
      : { texte: r.type === "MISSION_ORDER" ? "Ordre à générer — RH" : r.type === "WORK_CERTIFICATE" ? "Attestation à générer — RH" : "Document à joindre — RH", etat: "encours" };
  } else if (nature === "EXPENSE") {
    milieu = termine
      ? { texte: "Décision prise", etat: "fait" }
      : r.originalsAckAt
        ? { texte: "Décision à prendre — RH", etat: "encours" }
        : { texte: "Originaux attendus — secrétariat", etat: "encours" };
  } else if (nature === "INTERVIEW") {
    milieu = r.meetingConfirmedAt ? { texte: "Entrevue fixée", etat: "fait" } : { texte: "Date à fixer", etat: "encours" };
  } else {
    milieu = termine ? { texte: "Accordée", etat: "fait" } : { texte: "Décision à prendre — RH", etat: "encours" };
  }
  const fin: Etape = { texte: nature === "DOCUMENT" ? "Remise au salarié" : "Réponse au salarié", etat: termine ? "fait" : "avenir" };
  return [recue, milieu, fin];
}

function PanneauTraitement({ r, nature, referenceOrdreMission, currentUserId }: {
  r: HrQueueItem; nature: HrNature; referenceOrdreMission: string; currentUserId: string;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const prenom = r.employeeName.split(" ")[0] || r.employeeName;
  const termine = STATUTS_TERMINES.includes(r.status);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [depot, setDepot] = React.useState(false);
  const [survol, setSurvol] = React.useState(false);
  const [refus, setRefus] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const [decision, setDecision] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");
  const [envoi, setEnvoi] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const occupe = depot || decision !== null || envoi || enCours;

  // LE DÉPÔT DU DOCUMENT — l'ancien « Joindre le document & marquer prêt » : même route, même effet (la demande passe
  // « prête », le salarié est prévenu et retrouve la pièce dans son dossier).
  const deposer = async (file: File) => {
    setDepot(true); setErr(null);
    const fd = new FormData();
    fd.set("file", file); fd.set("employeeId", r.employeeId);
    fd.set("category", CATEGORIE_DU_DEPOT[r.type] ?? "OTHER");
    fd.set("visibleToEmployee", "1");
    fd.set("requestId", r.id);
    try {
      const res = await fetch("/api/rh/upload", { method: "POST", body: fd });
      const data = await res.json().catch(sansBloquer("file-demandes-rh.deposer.json", {}));
      if (!res.ok) setErr(data.error ?? "Échec de l'envoi.");
      else rafraichir();
    } catch { setErr("Échec de l'envoi."); }
    finally { setDepot(false); }
  };

  // Note de frais : valider pour le mois demandé ou le suivant.
  const decider = async (choix: "APPROVE" | "APPROVE_NEXT") => {
    setDecision(choix); setErr(null);
    const fd = new FormData(); fd.set("id", r.id); fd.set("decision", choix);
    const res = await decideExpenseReport(fd);
    setDecision(null);
    if (!res.ok) setErr(res.error ?? "Échec."); else rafraichir();
  };
  // Congé / absence / sortie (nature APPROBATION) : accorder.
  const accorder = async () => {
    setDecision("APPROVE"); setErr(null);
    const fd = new FormData(); fd.set("id", r.id); fd.set("decision", "APPROVE");
    const res = await decideHrLeave(fd);
    setDecision(null);
    if (!res.ok) setErr(res.error ?? "Échec."); else rafraichir();
  };
  // REFUSER, AVEC UN MOTIF — l'action de la nature de la demande ; le motif est la note que le salarié lit.
  const refuser = async () => {
    if (!motif.trim()) { setErr("Indiquez le motif du refus."); return; }
    setDecision("REJECT"); setErr(null);
    const fd = new FormData(); fd.set("id", r.id); fd.set("hrNote", motif.trim());
    let res;
    if (nature === "EXPENSE") { fd.set("decision", "REJECT"); res = await decideExpenseReport(fd); }
    else if (nature === "APPROVAL") { fd.set("decision", "REJECT"); res = await decideHrLeave(fd); }
    else { fd.set("status", "REJECTED"); res = await processHrRequest(fd); }
    setDecision(null);
    if (!res.ok) setErr(res.error ?? "Échec."); else { setRefus(false); rafraichir(); }
  };
  // Écrire au salarié : le fil d'échange de la demande (il est prévenu).
  const envoyer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setEnvoi(true); setErr(null);
    const fd = new FormData(); fd.set("requestId", r.id); fd.set("body", message.trim());
    const res = await addHrRequestComment(fd);
    setEnvoi(false);
    if (!res.ok) setErr(res.error ?? "Échec de l'envoi.");
    else { setMessage(""); rafraichir(); }
  };

  const peutRefuser = !termine && !(nature === "EXPENSE" && !r.originalsAckAt);

  return (
    <div className="mx-3 mb-3 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:mx-4 sm:p-4" aria-label={`Traitement de la demande de ${r.employeeName}`}>
      <ol className="grid grid-cols-3 gap-1.5">
        {frise(r, nature).map((e, i) => (
          <li
            key={i}
            className={cn(
              "border-t-[3px] pt-1 text-xs [overflow-wrap:anywhere]",
              e.etat === "fait" && "border-success text-success",
              e.etat === "encours" && "border-primary font-semibold text-primary",
              e.etat === "avenir" && "border-border text-muted-foreground",
              e.etat === "refus" && "border-destructive font-semibold text-destructive",
            )}
          >
            {e.etat === "fait" && <Check className="mr-0.5 inline h-3 w-3" />}
            {e.etat === "encours" && <Clock className="mr-0.5 inline h-3 w-3" />}
            {e.etat === "refus" && <X className="mr-0.5 inline h-3 w-3" />}
            {e.texte}
          </li>
        ))}
      </ol>

      {r.details && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">« {r.details} »</p>}
      {r.hrNote && <p className="text-xs [overflow-wrap:anywhere]"><span className="text-muted-foreground">Note RH : </span>{r.hrNote}</p>}

      {/* LE DOCUMENT : généré (ordre de mission), ou déposé — et, une fois joint, téléchargeable. */}
      {nature === "DOCUMENT" && (
        <>
          {r.type === "MISSION_ORDER" && !termine && (
            <div>
              <OrdreMissionForm requestId={r.id} employeeName={r.employeeName} employeePosition={r.employeePosition} details={r.details} referenceSuggeree={referenceOrdreMission} prefill={r.missionPrefill} />
            </div>
          )}
          {/* L'ATTESTATION DE TRAVAIL SE GÉNÈRE AUSSI (Direction, 10/2026) — et se RÉGÉNÈRE une fois prête : nouvelle version. */}
          {r.type === "WORK_CERTIFICATE" && r.status !== "REJECTED" && r.status !== "CANCELLED" && (
            <div>
              <AttestationTravailForm requestId={r.id} details={r.details} dejaGeneree={termine || Boolean(r.fulfilmentDocId)} />
            </div>
          )}
          {r.fulfilmentDocId && (
            <a href={`/api/rh/document/${r.fulfilmentDocId}?dl=1`} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <Download className="h-4 w-4" /> Document remis
            </a>
          )}
          {!termine && (
            <>
              <button
                type="button" disabled={occupe}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
                onDragLeave={() => setSurvol(false)}
                onDrop={(e) => { e.preventDefault(); setSurvol(false); const f = e.dataTransfer.files?.[0]; if (f) void deposer(f); }}
                className={cn(
                  "flex w-full flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed px-3 py-4 text-center text-sm text-muted-foreground transition-colors hover:border-primary/60 disabled:opacity-60 sm:flex-row sm:gap-2",
                  survol ? "border-primary bg-primary/5" : "border-border bg-background",
                )}
              >
                {depot ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4 text-primary" />}
                <span><span className="font-medium text-primary">Déposer le document</span> — remis à {prenom}, la demande passe « prête ».</span>
              </button>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void deposer(f); e.target.value = ""; }} />
            </>
          )}
        </>
      )}

      {/* NOTE DE FRAIS : le montant, les originaux, la décision. */}
      {nature === "EXPENSE" && (
        <div className="space-y-2">
          <p className="text-sm">
            {r.expenseAmount != null && <span className="font-semibold tabular-nums">{formatCurrency(r.expenseAmount)}</span>}
            {r.expenseAmount != null && " · "}
            {formatMonth(r.expenseMonth)}
            {r.approvedMonth && <span className="text-success"> · validée pour {formatMonth(r.approvedMonth)}</span>}
          </p>
          <p className={cn("text-xs", r.originalsAckAt ? "text-success" : "text-warning-foreground")}>
            {r.originalsAckAt
              ? `Originaux reçus${r.originalsAckByName ? ` (${r.originalsAckByName})` : ""} le ${formatDate(r.originalsAckAt)}`
              : "Originaux attendus au secrétariat"}
          </p>
          {!termine && r.originalsAckAt && (
            <div className="flex flex-wrap gap-1.5">
              <BoutonDecisif size="sm" disabled={occupe} onClick={() => decider("APPROVE")}>
                {decision === "APPROVE" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Valider ({formatMonth(r.expenseMonth)})
              </BoutonDecisif>
              <BoutonDecisif size="sm" variant="outline" disabled={occupe} onClick={() => decider("APPROVE_NEXT")}>
                {decision === "APPROVE_NEXT" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Valider pour le mois suivant
              </BoutonDecisif>
            </div>
          )}
          <ExpenseClaimHrPanel requestId={r.id} employeeName={r.employeeName} unlocked={Boolean(r.editUnlockedAt)} decided={termine} />
        </div>
      )}

      {/* ENTREVUE : proposer ou accepter une date. */}
      {nature === "INTERVIEW" && !termine && (
        <MeetingControls
          requestId={r.id} meetingAt={r.meetingAt} proposedByMe={r.meetingProposedById === currentUserId}
          confirmed={Boolean(r.meetingConfirmedAt)} canPropose otherParty="l'employé"
        />
      )}

      {/* CONGÉ / ABSENCE / SORTIE : accorder (le refus passe par « Refuser… »). */}
      {nature === "APPROVAL" && !termine && (
        <div className="flex flex-wrap gap-1.5">
          <BoutonDecisif size="sm" disabled={occupe} onClick={accorder}>
            {decision === "APPROVE" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Accorder
          </BoutonDecisif>
        </div>
      )}

      {peutRefuser && (
        refus ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={motif} onChange={(e) => setMotif(e.target.value)} autoFocus
              placeholder={`Motif du refus (lu par ${prenom})`} aria-label="Motif du refus" className="min-w-0 sm:flex-1"
            />
            <div className="flex gap-1.5">
              <BoutonDecisif size="sm" variant="outline" disabled={occupe || !motif.trim()} onClick={refuser} confirmation="Refuser la demande" className="text-destructive hover:bg-destructive/10">
                {decision === "REJECT" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Refuser
              </BoutonDecisif>
              <Button size="sm" variant="ghost" onClick={() => { setRefus(false); setMotif(""); }}>Annuler</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" disabled={occupe} onClick={() => setRefus(true)}>
              Refuser…
            </Button>
          </div>
        )
      )}

      {/* ÉCRIRE AU SALARIÉ — le fil d'échange de la demande, juste en dessous. */}
      <form onSubmit={envoyer} className="flex gap-2">
        <Input
          value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder={`Écrire à ${prenom}…`} aria-label={`Message à ${prenom}`} className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="outline" disabled={envoi || !message.trim()}>
          {envoi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
        </Button>
      </form>
      {err && <p className="text-xs text-destructive">{err}</p>}

      {r.comments.length === 0 && r.documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucun échange.</p>
      ) : (
        <div className="space-y-2">
          {r.comments.length > 0 && (
            <ul className="space-y-2">
              {r.comments.map((c) => (
                <li key={c.id} className="text-sm">
                  <span className="font-medium">{c.authorId === currentUserId ? "Vous" : c.author}</span>{" "}
                  <span className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                  <p className="whitespace-pre-wrap break-words text-foreground/90">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          {r.documents.length > 0 && <DocumentList documents={r.documents} canDelete path="/rh/demandes" />}
        </div>
      )}
    </div>
  );
}
