"use client";

import * as React from "react";
import { Loader2, Check, X, MessageSquare, MoreHorizontal } from "lucide-react";
import { decideLeave } from "@/modules/rh/actions";
import { EmptyState } from "@/components/shared/empty-state";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import type { CommentItem } from "@/components/shared/comment-thread";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LEAVE_TYPE } from "@/lib/labels";
import { type LeaveStage } from "@/modules/rh/partage";
import { formatDate, cn, initials } from "@/lib/utils";
import { depuisLisible } from "@/lib/calendar-tz";
import { LeaveEditButton } from "./leave-edit";
import { BulleDiscussion, FilConge } from "./conge-discussion";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { ANCRE_CONGES_A_TRANCHER } from "@/lib/chemins/rh";

export interface PendingLeave {
  id: string;
  employeeId?: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  stage: LeaveStage;
  previousNote?: string | null;
  previousStageLabel?: string | null;
  /** La fiche complète (nom, fonction, recrutement, direction, téléphone, intérim, reprise). */
  sheet?: { label: string; value: string }[];
  /** En intérim : le N+1 absent au nom de qui l'on signe (I18). */
  pourLeCompteDe?: string | null;
  /** Depuis quand la demande attend à sa marche (ISO — lot E2, 07-05). */
  depuis?: string | null;
  /** La discussion du congé (Direction, 07/10) — absente : l'écran ne la montre pas. */
  commentaires?: CommentItem[];
  /** Qui a validé la marche du N+1 (« N+1 : X ✓ », table des RH). */
  n1Valide?: string | null;
  /** Le solde du salarié une fois ce congé débité (congé annuel seulement). */
  soldeApres?: number | null;
}

/**
 * TRANCHER UN CONGÉ — un geste à la fois, et l'écran ne se rouvre pas sur l'état d'avant (`useRafraichir`).
 */
function useDecisionConge(leaveId: string, note: string) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<"APPROVED" | "REJECTED" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    setBusy(decision); setError(null);
    const fd = new FormData();
    fd.set("id", leaveId);
    fd.set("decision", decision);
    if (note.trim()) fd.set("note", note.trim());
    const r = await decideLeave(fd);
    setBusy(null);
    if (r.ok) rafraichir();
    else setError(r.error ?? "Échec de la décision.");
  };
  return { busy, error, decide, enCours };
}

const STAGE_SHORT: Record<LeaveStage, string> = {
  MANAGER: "Responsable (N+1)",
  HR: "Ressources humaines",
  DG: "Direction générale",
  DONE: "Terminé",
};

/**
 * DÉCIDER SUR UN CONGÉ — avec un mot, pas seulement un clic.
 *
 * Un refus sans motif oblige le salarié à venir demander pourquoi, et l'étape suivante à
 * deviner ce que la précédente pensait. Le champ « note » est donc dans la ligne, pas derrière
 * un écran de plus.
 */
function DecisionRow({ leave, canManage, maintenant, currentUserId }: { leave: PendingLeave; canManage: boolean; maintenant?: string; currentUserId?: string }) {
  // DEPUIS QUAND ÇA ATTEND (07-05) — la période dit quand la personne part, pas depuis quand elle attend
  // une réponse. L'instant vient du serveur quand il le donne : le rendu et l'hydratation disent la même chose.
  const attente = depuisLisible(leave.depuis, maintenant ? new Date(maintenant) : undefined);
  const [note, setNote] = React.useState("");
  const [fil, setFil] = React.useState(false);
  const { busy, error, decide, enCours } = useDecisionConge(leave.id, note);

  return (
    <>
    <TableRow>
      {/* LA FICHE SOUS LES YEUX AU MOMENT DE SIGNER. Repliée par défaut — la liste reste
          lisible —, mais présente : la chercher ailleurs, c'était décrocher le téléphone à
          chacune des trois marches. */}
      {/* En carte (téléphone), le nom est le titre de la carte : pas d'intitulé « Employé ». */}
      <TableCell data-sans-etiquette className="font-medium">
        <div className="w-full min-w-0 [overflow-wrap:anywhere]">
          {leave.employee}
          {leave.sheet && leave.sheet.length > 0 && (
            <details className="mt-1 font-normal">
              <summary className="cursor-pointer py-1 text-xs text-primary hover:underline sm:py-0 sm:text-[0.6875rem]">
                Fiche de la demande
              </summary>
              <dl className="mt-1.5 space-y-0.5 rounded-md border border-border bg-secondary/40 p-2 text-[0.6875rem]">
                {leave.sheet.map((l) => (
                  <div key={l.label} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{l.label}</dt>
                    <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      </TableCell>
      <TableCell label="Type">{LEAVE_TYPE[leave.type] ?? leave.type}</TableCell>
      <TableCell label="Période">
        <span>
          <span className="whitespace-nowrap">{formatDate(leave.startDate)} →</span>{" "}
          <span className="whitespace-nowrap">{formatDate(leave.endDate)}</span>
        </span>
      </TableCell>
      <TableCell label="Jours" className="text-right">{leave.days}</TableCell>
      {/* Le motif se lit en entier au téléphone : l'intitulé passe au-dessus, le texte en dessous. */}
      <TableCell label="Motif" className="max-sm:flex-col max-sm:gap-1 sm:max-w-[220px]">
        <div className="min-w-0 max-sm:!text-left">
          <span className="text-muted-foreground">{leave.reason || "—"}</span>
          {leave.previousNote && (
            <p className="mt-1 flex items-start gap-1 text-[0.6875rem] text-muted-foreground">
              <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0">{leave.previousStageLabel} : {leave.previousNote}</span>
            </p>
          )}
        </div>
      </TableCell>
      <TableCell label="Étape">
        <div className="flex min-w-0 flex-col items-end gap-1 sm:items-start">
          <Badge tone="warning" dot={false}>{STAGE_SHORT[leave.stage]}</Badge>
          {leave.pourLeCompteDe && <Badge tone="info" dot={false}>Intérim pour {leave.pourLeCompteDe}</Badge>}
          {attente && <p className="text-[0.6875rem] text-muted-foreground">En attente {attente}</p>}
        </div>
      </TableCell>
      <TableCell data-sans-etiquette>
        <div className="flex w-full flex-col items-stretch gap-2 md:items-end md:gap-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note de décision"
            placeholder="Note (facultative, transmise à l'étape suivante)"
            className="min-h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-base md:min-h-0 md:w-56 md:px-2 md:py-1 md:text-xs"
          />
          {/* Au pouce : Approuver et Refuser côte à côte, pleine largeur, 40 px de haut. */}
          <div className="grid grid-cols-2 items-center gap-2 md:flex md:justify-end md:gap-1.5">
            <BoutonDecisif brut
              type="button" disabled={busy !== null || enCours} onClick={() => decide("APPROVED")}
              className={cn("inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-success/30 px-3 py-1 text-sm font-medium text-success hover:bg-success/10 disabled:opacity-50 max-md:flex-1 md:min-h-0 md:px-2 md:text-xs")}
            >
              {busy === "APPROVED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approuver
            </BoutonDecisif>
            <BoutonDecisif brut
              type="button" disabled={busy !== null || enCours} onClick={() => decide("REJECTED")}
              className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-border px-3 py-1 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 max-md:flex-1 md:min-h-0 md:px-2 md:text-xs"
            >
              {busy === "REJECTED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Refuser
            </BoutonDecisif>
            {canManage && (
              <LeaveEditButton leave={{
                id: leave.id, employee: leave.employee, type: leave.type,
                startDate: leave.startDate, endDate: leave.endDate, days: leave.days,
                reason: leave.reason, status: "PENDING", decisionNote: null,
              }} />
            )}
            {leave.commentaires && (
              <BulleDiscussion nombre={leave.commentaires.length} ouvert={fil} onClick={() => setFil((v) => !v)} className="max-md:col-span-2" />
            )}
          </div>
          {error && <p className="text-xs text-destructive md:text-right md:text-[0.6875rem]">{error}</p>}
        </div>
      </TableCell>
    </TableRow>
    {fil && leave.commentaires && (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={7} data-sans-etiquette className="bg-muted/20">
          <div className="w-full min-w-0">
            <FilConge leaveId={leave.id} commentaires={leave.commentaires} currentUserId={currentUserId} path="/mon-espace" />
          </div>
        </TableCell>
      </TableRow>
    )}
    </>
  );
}

/**
 * LA FILE DES CONGÉS À TRANCHER **PAR CETTE PERSONNE**.
 *
 * Le même composant sert au responsable d'équipe (depuis « Mon espace »), aux RH et à la
 * direction (depuis le module RH) : trois publics, une seule file — celle que le serveur a
 * déjà filtrée pour eux.
 */
export function LeaveApprovals({
  leaves, emptyHint, canManage = false, maintenant, currentUserId,
}: { leaves: PendingLeave[]; emptyHint?: string; canManage?: boolean; maintenant?: string; currentUserId?: string }) {
  if (leaves.length === 0) {
    return (
      <EmptyState
        icon="CheckCheck"
        title="Aucune demande à trancher"
        description={emptyHint ?? "Les congés qui attendent VOTRE signature apparaîtront ici."}
      />
    );
  }
  return (
    <div className="surface overflow-hidden">
      <Table mobileCards>
        <TableHeader>
          <TableRow>
            <TableHead>Employé</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Période</TableHead>
            <TableHead className="text-right">Jours</TableHead>
            <TableHead>Motif</TableHead>
            <TableHead>Étape</TableHead>
            <TableHead className="text-right">Décision</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leaves.map((l) => <DecisionRow key={l.id} leave={l} canManage={canManage} maintenant={maintenant} currentUserId={currentUserId} />)}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * « CONGÉS ET ABSENCES À TRANCHER » — LA TABLE DES RH (Direction, 07/10 — maquette « Demandes RH »).
 *
 * Une ligne par congé : le salarié et qui a signé avant (« N+1 : X ✓ »), le type, la période, les jours, le solde
 * après, Valider / Refuser — les mêmes décisions que `LeaveApprovals` (`decideLeave`). Une TABLE au téléphone aussi :
 * elle défile dans son cadre. La bulle déplie la discussion du congé ; « ⋯ » porte la note de décision, la fiche de
 * la demande et la correction.
 */
export function CongesATrancher({ leaves, canManage = false, maintenant, currentUserId }: {
  leaves: PendingLeave[]; canManage?: boolean; maintenant?: string; currentUserId?: string;
}) {
  return (
    // L'ANCRE des notifications « Message sur un congé à trancher » (`LIEN_CONGES_A_TRANCHER_RH`).
    <section id={ANCRE_CONGES_A_TRANCHER} className="surface scroll-mt-20 overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-semibold">Congés et absences à trancher</h2>
          <InfoBulle label="Le circuit des congés">
            Circuit : responsable (N+1) → ressources humaines. Seules les demandes qui attendent votre signature figurent
            ici ; le solde n&apos;est débité qu&apos;au bout du circuit.
          </InfoBulle>
        </div>
        <span className="text-xs text-muted-foreground">en attente de votre signature</span>
      </header>
      {leaves.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Aucun congé à trancher.</p>
      ) : (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>Salarié</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Période</TableHead>
              <TableHead className="text-right">Jours</TableHead>
              <TableHead className="text-right">Solde après</TableHead>
              <TableHead><span className="sr-only">Décision</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaves.map((l) => (
              <LigneCongeRh key={l.id} leave={l} canManage={canManage} maintenant={maintenant} currentUserId={currentUserId} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function LigneCongeRh({ leave, canManage, maintenant, currentUserId }: {
  leave: PendingLeave; canManage: boolean; maintenant?: string; currentUserId?: string;
}) {
  const attente = depuisLisible(leave.depuis, maintenant ? new Date(maintenant) : undefined);
  const [note, setNote] = React.useState("");
  const [deplie, setDeplie] = React.useState<"fil" | "plus" | null>(null);
  const { busy, error, decide, enCours } = useDecisionConge(leave.id, note);
  const commentaires = leave.commentaires ?? [];
  const basculer = (quoi: "fil" | "plus") => setDeplie((d) => (d === quoi ? null : quoi));
  // QUI A SIGNÉ AVANT — « état — chez qui » : la marche franchie, ou celle où la demande se trouve.
  const avant = leave.n1Valide
    ? `N+1 : ${leave.n1Valide} ✓`
    : leave.stage === "MANAGER" ? "chez le N+1" : STAGE_SHORT[leave.stage];

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {initials(leave.employee || "?")}
            </span>
            <div className="min-w-0">
              <p className="font-medium">{leave.employee}</p>
              <p className="text-xs text-muted-foreground">
                {avant}
                {leave.pourLeCompteDe ? ` · intérim pour ${leave.pourLeCompteDe}` : ""}
                {attente ? ` · ${attente}` : ""}
              </p>
            </div>
          </div>
        </TableCell>
        <TableCell>{LEAVE_TYPE[leave.type] ?? leave.type}</TableCell>
        <TableCell className="whitespace-nowrap">{formatDate(leave.startDate, { day: "numeric", month: "short" })} → {formatDate(leave.endDate, { day: "numeric", month: "short" })}</TableCell>
        <TableCell className="text-right tabular-nums">{leave.days}</TableCell>
        <TableCell className={cn("text-right tabular-nums", (leave.soldeApres ?? 0) < 0 && "font-medium text-destructive")}>
          {leave.soldeApres == null ? <span className="text-muted-foreground">—</span> : leave.soldeApres}
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1.5">
            <BoutonDecisif brut
              type="button" disabled={busy !== null || enCours} onClick={() => decide("APPROVED")}
              className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-success/30 px-2.5 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50 sm:min-h-8"
            >
              {busy === "APPROVED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Valider
            </BoutonDecisif>
            <BoutonDecisif brut
              type="button" disabled={busy !== null || enCours} onClick={() => decide("REJECTED")}
              className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 sm:min-h-8"
            >
              {busy === "REJECTED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Refuser
            </BoutonDecisif>
            <BulleDiscussion nombre={commentaires.length} ouvert={deplie === "fil"} onClick={() => basculer("fil")} />
            <button
              type="button" onClick={() => basculer("plus")} aria-expanded={deplie === "plus"} aria-label="Autres actions"
              className={cn(
                "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:h-8 sm:w-8",
                deplie === "plus" ? "border-primary/40 bg-primary/10 text-primary" : "border-border",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
          {error && <p className="mt-1 text-right text-xs text-destructive">{error}</p>}
        </TableCell>
      </TableRow>
      {deplie && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-muted/20">
            {/* Le fil reste à la largeur de l'écran quand la table défile, au téléphone. */}
            <div className="sticky left-0 w-full max-w-[calc(100vw-3rem)] min-w-0 md:max-w-none">
              {deplie === "fil" ? (
                <FilConge leaveId={leave.id} commentaires={commentaires} currentUserId={currentUserId} canModerate={canManage} path="/rh/demandes" />
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label htmlFor={`note-conge-${leave.id}`} className="text-xs font-medium text-muted-foreground">Note de décision (transmise avec Valider / Refuser)</label>
                    <input
                      id={`note-conge-${leave.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note"
                      className="min-h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-base md:min-h-0 md:py-1.5 md:text-sm"
                    />
                    {leave.reason && <p className="text-xs [overflow-wrap:anywhere]"><span className="text-muted-foreground">Motif : </span>{leave.reason}</p>}
                    {leave.previousNote && (
                      <p className="flex items-start gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="min-w-0">{leave.previousStageLabel} : {leave.previousNote}</span>
                      </p>
                    )}
                    {canManage && (
                      <LeaveEditButton leave={{
                        id: leave.id, employee: leave.employee, type: leave.type,
                        startDate: leave.startDate, endDate: leave.endDate, days: leave.days,
                        reason: leave.reason, status: "PENDING", decisionNote: null,
                      }} />
                    )}
                  </div>
                  {leave.sheet && leave.sheet.length > 0 && (
                    <dl className="space-y-0.5 rounded-md border border-border bg-background p-2 text-xs">
                      {leave.sheet.map((l) => (
                        <div key={l.label} className="flex justify-between gap-3">
                          <dt className="shrink-0 text-muted-foreground">{l.label}</dt>
                          <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{l.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
