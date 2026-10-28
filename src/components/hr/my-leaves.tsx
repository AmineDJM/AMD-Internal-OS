"use client";

import * as React from "react";
import { Loader2, X, Check } from "lucide-react";
import { cancelLeave } from "@/modules/rh/actions";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LEAVE_TYPE, LEAVE_STATUS } from "@/lib/labels";
import { LEAVE_STAGE_LABELS, type LeaveStage } from "@/modules/rh/partage";
import { formatDate, cn } from "@/lib/utils";
import { StandInButton, StandInBadge } from "@/components/hr/stand-in-panel";
import { BulleDiscussion, FilConge } from "@/components/hr/conge-discussion";
import type { CommentItem } from "@/components/shared/comment-thread";
import type { StandInStatus } from "@/lib/hr/stand-in";

export interface LeaveItem {
  id: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  /** Marche courante du circuit N+1 → RH. */
  stage: LeaveStage;
  /** Marches déjà franchies, dans l'ordre — pour montrer OÙ en est la demande. */
  passed: { label: string; note: string | null }[];
  /** L'intérimaire désigné pour ce congé, et où en est sa validation par les RH. */
  standInId: string | null;
  standInName: string | null;
  standInStatus: StandInStatus | null;
  standInModules: string[];
  /**
   * Le congé est TERMINÉ — calculé par le SERVEUR (`congeTermine`), l'horloge même de l'action : le
   * calculer ici donnerait, autour de minuit, une autre réponse que celle de l'action et du rendu
   * serveur. Un congé terminé n'a plus de place à tenir (§118.196).
   */
  termine?: boolean;
  standInNote: string | null;
  /** La discussion du congé avec le N+1 et les RH (Direction, 07/10) — absente : l'écran ne la montre pas. */
  commentaires?: CommentItem[];
}

function CancelButton({ id }: { id: string }) {
  const [saving, setSaving] = React.useState(false);
  return (
    <form action={async (fd) => { setSaving(true); await cancelLeave(fd); setSaving(false); }} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={saving}
        className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 py-1 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2 sm:text-xs"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Annuler
      </button>
    </form>
  );
}

/** Les deux marches, dessinées : ce qui est signé, ce qu'on attend (la marche DG est supprimée — Direction, 06/10). */
const STEPS: { stage: LeaveStage; short: string }[] = [
  { stage: "MANAGER", short: "N+1" },
  { stage: "HR", short: "RH" },
];
/** Une demande restée à la DG d'avant le changement garde sa troisième marche à l'écran. */
const STEPS_AVEC_DG: { stage: LeaveStage; short: string }[] = [...STEPS, { stage: "DG", short: "DG" }];

function StageTrail({ leave }: { leave: LeaveItem }) {
  if (leave.status !== "PENDING") {
    return <span className="text-xs text-muted-foreground">{leave.passed.length > 0 ? `${leave.passed.length} validation(s)` : "—"}</span>;
  }
  const marches = leave.stage === "DG" ? STEPS_AVEC_DG : STEPS;
  const currentIdx = marches.findIndex((s) => s.stage === leave.stage);
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 sm:justify-start">
      {marches.map((s, i) => {
        const done = currentIdx < 0 || i < currentIdx;
        const current = i === currentIdx;
        return (
          <span
            key={s.stage}
            title={LEAVE_STAGE_LABELS[s.stage]}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium",
              done && "border-success/30 bg-success/10 text-success",
              current && "border-warning/40 bg-warning/10 text-warning-foreground",
              !done && !current && "border-border text-muted-foreground",
            )}
          >
            {done && <Check className="h-3 w-3" />} {s.short}
          </span>
        );
      })}
    </div>
  );
}

/**
 * MES DEMANDES DE CONGÉ — la même liste dans « Mon espace » et « Mon dossier RH ».
 *
 * Elle montre l'avancement réel du circuit : savoir qu'une demande est « en attente » sans
 * savoir DE QUI, c'est ne rien savoir — et c'est ce qui déclenche les relances au hasard.
 */
export function MyLeaves({ leaves, people = [], modules = [], moduleLabels = {}, currentUserId }: {
  leaves: LeaveItem[];
  /** Pour reconnaître ses propres messages dans la discussion d'un congé. */
  currentUserId?: string;
  /** Collègues désignables comme intérimaire. Vide = la colonne reste en lecture. */
  people?: { id: string; name: string }[];
  /** Ce que la personne peut PRÊTER (`modulesPretables`) — la liste même que l'action accepte (§118.196). */
  modules?: { value: string; label: string }[];
  moduleLabels?: Record<string, string>;
}) {
  const [fil, setFil] = React.useState<string | null>(null);
  if (leaves.length === 0) {
    return <EmptyState icon="Plane" title="Aucune demande de congé" description="Vos demandes apparaîtront ici, avec l'étape où elles en sont." />;
  }
  return (
    <div className="surface overflow-hidden">
      <Table mobileCards>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Période</TableHead>
            <TableHead className="text-right">Jours</TableHead>
            <TableHead>Statut</TableHead>
            <TableHead>Circuit</TableHead>
            <TableHead>Intérimaire</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leaves.map((l) => (
            <React.Fragment key={l.id}>
            <TableRow>
              <TableCell label="Type" className="font-medium">{LEAVE_TYPE[l.type] ?? l.type}</TableCell>
              <TableCell label="Période">
                <span>
                  <span className="whitespace-nowrap">{formatDate(l.startDate)} →</span>{" "}
                  <span className="whitespace-nowrap">{formatDate(l.endDate)}</span>
                </span>
              </TableCell>
              <TableCell label="Jours" className="text-right">{l.days}</TableCell>
              {/* En carte, chaque cellule à plusieurs morceaux les garde ensemble, alignés à droite
                  sous leur intitulé — sinon ils s'étalaient côte à côte. */}
              <TableCell label="Statut">
                <div className="flex min-w-0 flex-col items-end gap-0.5 sm:items-start">
                  <StatusBadge map={LEAVE_STATUS} value={l.status} />
                  {l.status === "PENDING" && (
                    <p className="text-[0.6875rem] text-muted-foreground">{LEAVE_STAGE_LABELS[l.stage]}</p>
                  )}
                </div>
              </TableCell>
              <TableCell label="Circuit">
                <div className="min-w-0">
                  <StageTrail leave={l} />
                  {l.passed.filter((p) => p.note).map((p, i) => (
                    <p key={i} className="mt-0.5 text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{p.label} : {p.note}</p>
                  ))}
                </div>
              </TableCell>
              {/* L'INTÉRIMAIRE se désigne tant que le congé n'est pas passé : c'est souvent en
                  voyant la demande accordée qu'on pense à faire tenir sa place. */}
              <TableCell label="Intérimaire">
                <div className="flex min-w-0 flex-col items-end gap-1.5 sm:items-start">
                  <StandInBadge state={l} moduleLabels={moduleLabels} />
                  {people.length > 0 && l.status !== "REJECTED" && l.status !== "CANCELLED" && !l.termine && (
                    <StandInButton leaveId={l.id} state={l} people={people} modules={modules} moduleLabels={moduleLabels} />
                  )}
                </div>
              </TableCell>
              <TableCell label="Action" className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  {l.status === "PENDING" ? <CancelButton id={l.id} /> : !l.commentaires && <span className="text-muted-foreground">—</span>}
                  {l.commentaires && (
                    <BulleDiscussion nombre={l.commentaires.length} ouvert={fil === l.id} onClick={() => setFil((v) => (v === l.id ? null : l.id))} />
                  )}
                </div>
              </TableCell>
            </TableRow>
            {fil === l.id && l.commentaires && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} data-sans-etiquette className="bg-muted/20">
                  <div className="w-full min-w-0">
                    <FilConge leaveId={l.id} commentaires={l.commentaires} currentUserId={currentUserId} path="/mon-dossier" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            </React.Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
