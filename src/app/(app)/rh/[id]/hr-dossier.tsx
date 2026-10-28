"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, Trash2, FileText, Download, Paperclip, FolderArchive, FolderTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { HR_DOCUMENT_CATEGORY, HR_REQUEST_TYPE, HR_REQUEST_STATUS } from "@/lib/labels";
import { formatDate, formatMonth, formatCurrency } from "@/lib/utils";
import { processHrRequest, deleteEmployeeDocument, decideExpenseReport, decideHrLeave, deleteHrRequest, setEmployeeDocumentVisibility } from "@/modules/rh/actions-documents";
import {
  defaultVisibleToEmployee, visibilityLabel, hrNature, HR_DOCUMENT_STATUSES, CATEGORIE_DU_DEPOT,
} from "@/modules/rh/partage";
import { HrRequestThread } from "@/modules/rh/ecrans/hr-request-thread";
import { MeetingControls } from "@/modules/rh/ecrans/hr-meeting-controls";
import { ExpenseClaimHrPanel } from "@/components/hr/expense-claim-hr-panel";
import type { HrDocumentDTO, HrRequestDTO } from "@/modules/rh/api";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { OrdreMissionForm } from "./ordre-mission-form";
import { AttestationTravailForm } from "./attestation-travail-form";

export function HrDossier({ employeeId, employeeName, employeePosition = null, referenceOrdreMission = "", documents, requests, currentUserId }: { employeeId: string; employeeName: string; employeePosition?: string | null; referenceOrdreMission?: string; documents: HrDocumentDTO[]; requests: HrRequestDTO[]; currentUserId: string }) {
  const router = useRouter();
  const [category, setCategory] = React.useState("PAYSLIP");
  // La case suit la CATÉGORIE tant que personne ne l'a touchée : choisir « Contrat » doit
  // décocher tout seul, sinon le défaut ne protège que ceux qui y pensent.
  const [shareWithEmployee, setShareWithEmployee] = React.useState(() => defaultVisibleToEmployee("PAYSLIP"));
  const setCategoryAndVisibility = (next: string) => {
    setCategory(next);
    setShareWithEmployee(defaultVisibleToEmployee(next));
  };
  const [period, setPeriod] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File, opts: { category: string; period?: string; requestId?: string; visibleToEmployee?: boolean }) => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("file", file); fd.set("employeeId", employeeId); fd.set("category", opts.category);
    // Toujours envoyé, y compris pour un dépôt qui répond à une demande : le serveur distingue
    // « rien coché » de « décoché », et une demande d'attestation se remet évidemment au salarié.
    fd.set("visibleToEmployee", (opts.visibleToEmployee ?? defaultVisibleToEmployee(opts.category)) ? "1" : "0");
    if (opts.period) fd.set("period", opts.period);
    if (opts.requestId) fd.set("requestId", opts.requestId);
    try {
      const res = await fetch("/api/rh/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Échec de l'envoi.");
      else router.refresh();
    } catch { setErr("Échec de l'envoi."); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      {/* Téléversement d'un document */}
      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 text-sm font-medium">Déposer un document RH</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="col-span-2 space-y-1.5"><Label>Catégorie</Label>
            <Select value={category} onChange={(e) => setCategoryAndVisibility(e.target.value)}>
              {Object.entries(HR_DOCUMENT_CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Période</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-01" /></div>
          <div className="flex items-end">
            <Button className="w-full" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Choisir
            </Button>
          </div>
        </div>
        {/* QUI VERRA CETTE PIÈCE — préréglé sur la NATURE du document, et modifiable. Un contrat
            ou un avenant reste aux RH ; un bulletin, une attestation vont au salarié, puisqu'ils
            existent pour lui. La case dit l'état AVANT le dépôt, pas après. */}
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
            checked={shareWithEmployee} onChange={(e) => setShareWithEmployee(e.target.checked)}
          />
          <span>
            Visible par le salarié dans « Mon dossier RH »
            <span className="block text-xs text-muted-foreground">
              {shareWithEmployee
                ? "Il retrouvera cette pièce dans son espace."
                : "Pièce de gestion : elle reste au dossier RH, le salarié ne la voit pas."}
            </span>
          </span>
        </label>
        {/* LE CONTRAT PART AUSSI DANS LE DRIVE, et on le dit AVANT le dépôt. C'est là qu'on ira
            le chercher dans trois ans, quand la personne qui l'a déposé aura changé de poste —
            dans la catégorie « RH — Contrats », ouverte aux seules ressources humaines. */}
        {(category === "CONTRACT" || category === "AMENDMENT") && (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
            <FolderTree className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Cette pièce sera <strong className="text-foreground">aussi rangée dans le Drive</strong>, sous
              « RH — Contrats / {employeeName} » — une catégorie ouverte aux seules ressources humaines.
            </span>
          </p>
        )}
        <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f, { category, period: period || undefined, visibleToEmployee: shareWithEmployee }); e.target.value = ""; }} />
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      </div>

      {/* Documents */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documents ({documents.length})</p>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun document déposé.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 sm:flex-nowrap">
                <FileText className="h-4 w-4 shrink-0 text-primary" />
                {/* Au téléphone, le nom prend toute la ligne ; visibilité et actions passent dessous. */}
                <div className="min-w-0 flex-1 basis-[calc(100%-26px)] sm:basis-0">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="text-xs text-muted-foreground">{HR_DOCUMENT_CATEGORY[d.category]}{d.period ? ` · ${d.period}` : ""} · {formatDate(d.createdAt)}</p>
                </div>
                {/* L'ÉTAT SE VOIT, et se change d'un clic : une restriction invisible est une
                    restriction dont on doute, et qu'on finit par contourner « au cas où ». */}
                <button
                  onClick={() => { const fd = new FormData(); fd.set("id", d.id); fd.set("visible", d.visibleToEmployee ? "0" : "1"); setEmployeeDocumentVisibility(fd).then(() => router.refresh()); }}
                  title={d.visibleToEmployee ? "Reprendre l'accès du salarié" : "Partager avec le salarié"}
                  className={`ml-auto shrink-0 rounded-full border px-2.5 py-1.5 text-[0.6875rem] font-medium transition-colors sm:ml-0 sm:px-2 sm:py-0.5 ${d.visibleToEmployee ? "border-success/40 text-success hover:bg-success/10" : "border-border text-muted-foreground hover:bg-secondary"}`}
                >
                  {visibilityLabel(d.visibleToEmployee)}
                </button>
                <a href={`/api/rh/document/${d.id}?dl=1`} className="shrink-0 rounded p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5" title="Télécharger" aria-label="Télécharger"><Download className="h-4 w-4" /></a>
                <BoutonDecisif brut
                  onClick={() => { const fd = new FormData(); fd.set("id", d.id); deleteEmployeeDocument(fd).then(() => router.refresh()); }}
                  className="rounded p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5" title="Supprimer"
                ><Trash2 className="h-4 w-4" /></BoutonDecisif>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Demandes */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Demandes RH ({requests.length})</p>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune demande.</p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => <RequestRow key={r.id} req={r} employeeId={employeeId} employeeName={employeeName} employeePosition={employeePosition} referenceOrdreMission={referenceOrdreMission} onFulfil={upload} busy={busy} currentUserId={currentUserId} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

// La file du sous-module « Demandes RH » vit dans `rh/demandes/file-demandes-rh.tsx` (Direction, 07/10) : une ligne par
// demande et un panneau de traitement. La ligne ci-dessous reste celle de la fiche du salarié.
function RequestRow({ req, employeeId, employeeName, employeePosition, referenceOrdreMission, onFulfil, busy, currentUserId }: { req: HrRequestDTO; employeeId: string; employeeName: string; employeePosition: string | null; referenceOrdreMission: string; onFulfil: (file: File, opts: { category: string; requestId: string }) => void; busy: boolean; currentUserId: string }) {
  const router = useRouter();
  const [status, setStatus] = React.useState(req.status);
  const [note, setNote] = React.useState(req.hrNote ?? "");
  const [saving, setSaving] = React.useState(false);
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const [decideErr, setDecideErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Nature de la demande : pilote l'interface (document à préparer vs décision d'accord…).
  const nature = hrNature(req.type);

  // Décision note de frais : la note RH saisie est enregistrée avec la décision.
  const decide = async (decision: "APPROVE" | "APPROVE_NEXT" | "REJECT") => {
    setDeciding(decision); setDecideErr(null);
    const fd = new FormData();
    fd.set("id", req.id); fd.set("decision", decision);
    if (note) fd.set("hrNote", note);
    const r = await decideExpenseReport(fd);
    setDeciding(null);
    if (!r.ok) setDecideErr(r.error ?? "Échec."); else router.refresh();
  };

  // Décision congé / absence / autorisation (nature APPROBATION) : accorder ou refuser.
  const decideLeave = async (decision: "APPROVE" | "REJECT") => {
    setDeciding(decision); setDecideErr(null);
    const fd = new FormData();
    fd.set("id", req.id); fd.set("decision", decision);
    if (note) fd.set("hrNote", note);
    const r = await decideHrLeave(fd);
    setDeciding(null);
    if (!r.ok) setDecideErr(r.error ?? "Échec."); else router.refresh();
  };

  const save = async () => {
    setSaving(true);
    const fd = new FormData(); fd.set("id", req.id); fd.set("status", status); fd.set("hrNote", note);
    await processHrRequest(fd);
    setSaving(false);
    router.refresh();
  };

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{HR_REQUEST_TYPE[req.type]}</span>
        <StatusBadge map={HR_REQUEST_STATUS} value={req.status} />
        {req.fulfilmentDocId && <a href={`/api/rh/document/${req.fulfilmentDocId}?dl=1`} className="text-xs text-primary hover:underline">Document joint</a>}
        {req.archivedNodeId && (
          <a href={`/drive/${req.archivedNodeId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" title="Ouvrir l'archive dans le Drive">
            <FolderArchive className="h-3.5 w-3.5" /> Dossier traité
          </a>
        )}
        <BoutonDecisif brut
          onClick={() => {
            const fd = new FormData(); fd.set("id", req.id);
            deleteHrRequest(fd).then(() => router.refresh());
          }}
          title="Supprimer cette demande (la demande seule, pas l'employé)"
          className="ml-auto rounded-md p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
        >
          <Trash2 className="h-4 w-4" />
        </BoutonDecisif>
      </div>
      {req.details && <p className="mb-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">Demande : {req.details}</p>}

      {/* Congé / absence : période demandée + jours + débit du solde (congé annuel) */}
      {(req.periodStart || req.periodEnd) && (
        <p className="mb-2 text-xs">
          <span className="text-muted-foreground">Période : </span>
          <span className="font-medium">{req.periodStart ? formatDate(req.periodStart) : "?"}{req.periodEnd ? ` → ${formatDate(req.periodEnd)}` : ""}</span>
          {req.periodDays ? <span className="text-muted-foreground"> · {req.periodDays} j</span> : null}
          {req.type === "ANNUAL_LEAVE" && (req.balanceApplied
            ? <span className="ml-1 font-medium text-success">· solde débité</span>
            : <span className="ml-1 text-muted-foreground">· solde débité à l&apos;approbation</span>)}
        </p>
      )}

      {/* Note de frais : mois, accusé de réception des originaux, décision en un clic */}
      {req.type === "EXPENSE_REPORT" && (
        <div className="mb-2 space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
          <p className="text-xs">
            {/* LE MONTANT EN PREMIER : c'est ce que les RH doivent décider de rembourser, et il
                ne se lit plus au milieu d'une phrase de motif. */}
            {req.expenseAmount != null && (
              <>Montant : <span className="font-semibold tabular-nums">{formatCurrency(req.expenseAmount)}</span> · </>
            )}
            Mois concerné : <span className="font-medium">{formatMonth(req.expenseMonth)}</span>
            {req.approvedMonth && <> · Validée pour <span className="font-medium text-success">{formatMonth(req.approvedMonth)}</span></>}
          </p>
          <p className={`text-xs ${req.originalsAckAt ? "text-success" : "text-amber-700"}`}>
            {req.originalsAckAt
              ? `Originaux réceptionnés par le secrétariat${req.originalsAckByName ? ` (${req.originalsAckByName})` : ""} le ${formatDate(req.originalsAckAt)}.`
              : "Originaux non réceptionnés par le bureau du secrétariat pour l'instant."}
          </p>
          {req.status !== "REJECTED" && !req.approvedMonth && (
            <>
              {!req.originalsAckAt && (
                <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800">
                  Traitement verrouillé : en attente de l&apos;accusé de réception des originaux par le bureau du secrétariat.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <BoutonDecisif size="sm" disabled={deciding !== null || !req.originalsAckAt} onClick={() => decide("APPROVE")}>
                  {deciding === "APPROVE" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Valider ({formatMonth(req.expenseMonth)})
                </BoutonDecisif>
                <BoutonDecisif size="sm" variant="outline" disabled={deciding !== null || !req.originalsAckAt} onClick={() => decide("APPROVE_NEXT")}>
                  {deciding === "APPROVE_NEXT" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Valider pour le mois suivant
                </BoutonDecisif>
                <BoutonDecisif size="sm" variant="outline" disabled={deciding !== null || !req.originalsAckAt} onClick={() => decide("REJECT")} className="text-destructive hover:bg-destructive/10">
                  {deciding === "REJECT" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Refuser
                </BoutonDecisif>
              </div>
            </>
          )}
          {decideErr && <p className="text-xs text-destructive">{decideErr}</p>}

          {/* CE QUE LES RH FONT SANS RÉÉCRIRE LA NOTE : réclamer un justificatif au demandeur,
              et lui rouvrir la modification. « Votre montant est faux, corrigez » n'a aucun sens
              passé les quinze minutes — la personne refait une seconde note, et l'on se retrouve
              avec deux demandes pour une dépense. Pour une simple explication, le fil d'échange
              juste en dessous suffit et prévient déjà le demandeur. */}
          <ExpenseClaimHrPanel
            requestId={req.id}
            employeeName={employeeName}
            unlocked={Boolean(req.editUnlockedAt)}
            decided={["READY", "DELIVERED", "APPROVED", "REJECTED"].includes(req.status)}
          />
        </div>
      )}

      {/* Entrevue RH : proposer / accepter une date */}
      {req.type === "HR_INTERVIEW" && req.status !== "REJECTED" && (
        <div className="mb-2">
          <MeetingControls
            requestId={req.id}
            meetingAt={req.meetingAt}
            proposedByMe={req.meetingProposedById === currentUserId}
            confirmed={Boolean(req.meetingConfirmedAt)}
            canPropose
            otherParty="l'employé"
          />
        </div>
      )}

      {/* Nature APPROBATION (congé / absence / autorisation de sortie) : décision Accorder / Refuser
          — pas de document à préparer, pas de « statut de préparation ». */}
      {nature === "APPROVAL" && (
        <div className="mb-2 space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
          {req.status === "APPROVED" || req.status === "REJECTED" ? (
            <p className={`text-xs font-medium ${req.status === "APPROVED" ? "text-success" : "text-destructive"}`}>
              {req.status === "APPROVED" ? "Demande accordée." : "Demande refusée."}
              {req.type === "ANNUAL_LEAVE" && req.balanceApplied ? " Solde de congés débité." : ""}
              {req.hrNote ? ` — ${req.hrNote}` : ""}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Demande d&apos;accord — accordez ou refusez (aucun document à remettre).</p>
              <div className="space-y-1.5"><Label>Note RH (facultative)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motif / précision communiqué à l'employé" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <BoutonDecisif size="sm" disabled={deciding !== null} onClick={() => decideLeave("APPROVE")}>
                  {deciding === "APPROVE" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Accorder
                </BoutonDecisif>
                <BoutonDecisif size="sm" variant="outline" disabled={deciding !== null} onClick={() => decideLeave("REJECT")} className="text-destructive hover:bg-destructive/10">
                  {deciding === "REJECT" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Refuser
                </BoutonDecisif>
              </div>
            </>
          )}
          {decideErr && <p className="text-xs text-destructive">{decideErr}</p>}
        </div>
      )}

      {/* Nature DOCUMENT (attestations, relevés, titres, ordre de mission…) + notes de frais / entrevues :
          flux de préparation d'un document (statut de préparation, note, pièce à joindre). */}
      {nature !== "APPROVAL" && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="col-span-2 space-y-1.5 sm:col-span-1"><Label>Statut</Label>
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                {HR_DOCUMENT_STATUSES.map((v) => <option key={v} value={v}>{HR_REQUEST_STATUS[v].label}</option>)}
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5"><Label>Note RH</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note interne / message" /></div>
            <div className="col-span-2 flex items-end gap-1.5 sm:col-span-1">
              <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={save}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</Button>
            </div>
          </div>
          {/* L'ORDRE DE MISSION SE GÉNÈRE (Direction, 06/10) : le document de la Direction, rempli par la plateforme. */}
          {req.type === "MISSION_ORDER" && req.status !== "CANCELLED" && req.managerGate !== "PENDING" && req.managerGate !== "REJECTED" && (
            <div className="mt-2">
              <OrdreMissionForm requestId={req.id} employeeName={employeeName} employeePosition={employeePosition} details={req.details} referenceSuggeree={referenceOrdreMission} prefill={req.missionPrefill} />
            </div>
          )}
          {/* L'ATTESTATION DE TRAVAIL SE GÉNÈRE (Direction, 10/2026) — préremplie par la fiche et le contrat de travail. */}
          {req.type === "WORK_CERTIFICATE" && req.status !== "CANCELLED" && req.status !== "REJECTED" && (
            <div className="mt-2">
              <AttestationTravailForm requestId={req.id} details={req.details} dejaGeneree={Boolean(req.fulfilmentDocId) || req.status === "READY" || req.status === "DELIVERED"} />
            </div>
          )}
          <div className="mt-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Joindre le document & marquer prêt</Button>
            <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFulfil(f, { category: CATEGORIE_DU_DEPOT[req.type] ?? "OTHER", requestId: req.id }); e.target.value = ""; }} />
          </div>
        </>
      )}
      <HrRequestThread requestId={req.id} documents={req.documents} comments={req.comments} canManage currentUserId={currentUserId} path={`/rh/${employeeId}`} />
    </li>
  );
}
