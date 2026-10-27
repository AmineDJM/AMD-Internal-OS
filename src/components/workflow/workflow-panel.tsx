"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Check, X, Loader2, MessageSquare, ArrowRight, SkipForward, Undo2, Send, Ban } from "lucide-react";
import type { EntityType } from "@prisma/client";
import { advanceWorkflow, faireAppelAdPro, resoumettreDemande, retirerDemandeAdPro } from "@/lib/actions/workflow-actions";
import type { WorkflowView, WorkflowEventView, WorkflowStepView } from "@/lib/queries/workflow";
import { SCOPE_LABELS } from "@/lib/workflow/types";
import { ROLE_LABELS, EXPENSE_ORDER_STATUS } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { cn, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

const STATUS_TONE: Record<string, { label: string; tone: "success" | "danger" | "warning" | "neutral" }> = {
  IN_PROGRESS: { label: "En cours", tone: "warning" },
  RETURNED: { label: "À corriger", tone: "warning" },
  APPROVED: { label: "Approuvé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

function rolesText(roles: string[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
}

/** QUI tient une étape, en un mot. */
function acteurDe(s: WorkflowStepView): string {
  return s.actorScope === "ROLE" ? rolesText(s.actorRoles) || "—" : SCOPE_LABELS[s.actorScope];
}

/** Une case de la frise horizontale de « La demande ». */
export interface EtapeDeFrise {
  cle: string;
  titre: string;
  /** Sous le titre : « date · personne » pour une étape faite, qui la tient sinon. */
  detail?: string | null;
  etat: "done" | "current" | "todo" | "rejected";
}

/** La phrase « état — chez qui », et ce qui vient ensuite. */
export interface StatutDeLaDemande {
  phrase: string;
  ensuite?: string | null;
  ton?: "info" | "succes" | "attente" | "refus" | "neutre";
}

const TON_STATUT: Record<NonNullable<StatutDeLaDemande["ton"]>, string> = {
  info: "border-primary/30 bg-primary/10 text-primary",
  succes: "border-success/30 bg-success/10 text-success",
  attente: "border-warning/40 bg-warning/10 text-warning",
  refus: "border-destructive/30 bg-destructive/5 text-destructive",
  neutre: "border-border bg-secondary/40 text-foreground",
};

/** « Yacine Habes » → « Y. Habes » : la frise n'a la place que d'un nom court. */
function nomCourt(nom: string | null): string | null {
  if (!nom) return null;
  const p = nom.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]![0]}. ${p.slice(1).join(" ")}` : nom;
}

const jourCourt = (iso: string) => formatDate(iso, { day: "numeric", month: "short" });

/** Les gestes qui FONT une étape (et non un commentaire en passant). */
const GESTES_D_ETAPE = new Set(["APPROVE", "REJECT", "OPINION_AGAINST", "SKIP", "AUTO_SKIP", "AUTO_APPROVE_REQUESTER"]);

/**
 * Panneau générique piloté par la **définition de workflow** configurée (Administration).
 * Affiche la frise dynamique, l'action disponible pour le spectateur à l'étape courante,
 * l'issue (montant accordé / ordre de dépense) et l'historique. Remplace les anciens
 * panneaux de décision spécifiques de Sponsoring / Congrès / Événements.
 *
 * RENDU COMPACT (`compact`, Direction 07/10 — la carte « La demande ») : une frise HORIZONTALE, une phrase
 * « état — chez qui » et, dedans, les gestes de l'étape courante. Mêmes gestes, mêmes actions, mêmes règles ;
 * l'historique n'y figure pas (il vit dans « Traçabilité », pour le Super Admin — `HistoriqueDuCircuit`),
 * ni le retrait (la page le range dans « ⋯ » — `WithdrawForm`).
 */
export function WorkflowPanel({ entityType, entityId, view, compact = false, suite = [], statut = null, gestes = null }: {
  entityType: EntityType;
  entityId: string;
  view: WorkflowView;
  compact?: boolean;
  /** Compact : les étapes de la demande APRÈS le circuit (le sponsoring : postes, validation finale), ajoutées à la frise. */
  suite?: EtapeDeFrise[];
  /** Compact : la phrase de statut quand la page en sait plus que le circuit (le circuit est fini, la suite se joue ailleurs). */
  statut?: StatutDeLaDemande | null;
  /** Compact : des gestes propres à la page, rangés sous ceux de l'étape (validation finale, appel, relance…). */
  gestes?: React.ReactNode;
}) {
  // LE RAFRAÎCHISSEMENT EST SUIVI (§118.172) : tant que les données d'après n'ont pas remplacé
  // l'écran, ses gestes restent fermés — sinon un second clic agirait sur l'état d'avant.
  const { enCours, rafraichir } = useRafraichir();
  const [pendingAction, start] = React.useTransition();
  const pending = pendingAction || enCours;
  const [err, setErr] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<null | "approve" | "reject" | "comment" | "skip" | "return">(null);

  const a = view.action;
  const [assignee, setAssignee] = React.useState("");
  const [amount, setAmount] = React.useState(a?.suggestedAmount != null ? String(a.suggestedAmount) : "");
  const [category, setCategory] = React.useState("");
  const [note, setNote] = React.useState("");
  /** Pièces jointes à l'avis (devis comparatif, note, courrier) — toutes les issues, y compris
   *  un simple commentaire : c'est souvent là qu'on veut déposer un document. */
  const [files, setFiles] = React.useState<File[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setMode(null); setNote(""); setAssignee(""); setCategory(""); setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = (action: "APPROVE" | "REJECT" | "COMMENT" | "SKIP" | "RETURN") => {
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    fd.set("action", action);
    if (note) fd.set("note", note);
    for (const f of files) fd.append("files", f);
    if (action === "APPROVE") {
      if (assignee) fd.set("assigneeId", assignee);
      if (amount) fd.set("amount", amount);
      if (category) fd.set("budgetCategoryId", category);
    }
    // Avis défavorable sur une étape intermédiaire : la désignation reste requise et le
    // Direction Marketing peut, DE MANIÈRE OPTIONNELLE, joindre un montant révisé (ex. « montant
    // revu à la hausse »). Ignoré sur un refus définitif (dernière étape).
    if (action === "REJECT") {
      if (assignee) fd.set("assigneeId", assignee);
      if (!actionIsLast && amount) fd.set("amount", amount);
    }
    start(async () => {
      setErr(null);
      const r = await advanceWorkflow(fd);
      if (!r.ok) { setErr(r.error ?? "Action impossible."); return; }
      resetForm();
      rafraichir();
    });
  };

  const st = STATUS_TONE[view.status] ?? STATUS_TONE.IN_PROGRESS;
  // Sur une étape intermédiaire, « Refuser » = AVIS DÉFAVORABLE : le circuit continue.
  const lastSlug = view.steps[view.steps.length - 1]?.slug;
  const actionIsLast = a?.slug === lastSlug;
  const needsAssign = !!a?.powers.includes("ASSIGN");
  const needsAmount = !!a && (a.requireAmount || a.powers.includes("SET_AMOUNT"));
  const needsCategory = !!a && (a.requireCategory || a.powers.includes("SET_CATEGORY"));
  const canApprove = !!a?.powers.includes("APPROVE");
  const canReject = !!a?.powers.includes("REJECT");
  const canComment = !!a?.powers.includes("COMMENT");
  // Sauter l'étape : possible sur une étape INTERMÉDIAIRE non terminale et qui ne désigne
  // pas le responsable de la suite (sinon plus personne en charge). Toujours tracé + noté.
  const canSkip = !!a && !actionIsLast && !needsAssign;

  const approveDisabled =
    pending ||
    (needsAssign && !assignee) ||
    (!!a?.requireAmount && !(Number(amount) > 0)) ||
    (!!a?.requireCategory && !category) ||
    (!!a?.requireNote && !note.trim());

  // LES GESTES DE L'ÉTAPE COURANTE — un seul jeu de boutons et un seul formulaire, montés par les deux rendus
  // (la frise verticale d'origine, ou l'encart de statut de « La demande »).
  const boutons = a ? (
                      // Au téléphone : une issue par ligne, pleine largeur, à hauteur de pouce — rien ne déborde à droite.
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        {canApprove && <Button size="sm" variant="success" className="h-11 text-sm sm:h-8 sm:text-xs" onClick={() => setMode("approve")}><Check className="h-4 w-4" /> Approuver</Button>}
                        {canReject && <Button size="sm" variant="destructive" className="h-11 text-sm sm:h-8 sm:text-xs" onClick={() => setMode("reject")}><X className="h-4 w-4" /> {actionIsLast ? "Refuser" : "Avis défavorable"}</Button>}
                        {/* RENVOYER POUR CORRECTION (§118.186) — ouvert là où le refus l'est : la troisième
                            issue, entre laisser passer une demande fausse et la tuer. */}
                        {canReject && <Button size="sm" variant="outline" onClick={() => setMode("return")}><Undo2 className="h-4 w-4" /> Renvoyer pour correction</Button>}
                        {canSkip && <Button size="sm" variant="outline" onClick={() => setMode("skip")}><SkipForward className="h-4 w-4" /> Sauter l&apos;étape</Button>}
                        {canComment && <Button size="sm" variant="ghost" onClick={() => setMode("comment")}><MessageSquare className="h-4 w-4" /> Commenter</Button>}
                      </div>
  ) : null;
  const formulaire = a ? (
                      <div className="space-y-2">
                        {mode === "reject" && !actionIsLast && (
                          <p className="rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                            Votre avis défavorable sera consigné mais n'est pas éliminatoire : le circuit continue vers l'étape suivante.
                          </p>
                        )}
                        {mode === "return" && (
                          <p className="rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                            La demande retourne à son demandeur avec votre motif : il la corrige, puis la resoumet — elle reviendra à cette étape. Rien n&apos;est refusé.
                          </p>
                        )}
                        {mode === "skip" && (
                          <p className="rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                            L&apos;étape sera <strong>sautée</strong> : le circuit passe directement à la suivante. Le saut, son auteur et sa raison sont <strong>tracés</strong> (historique + journal d&apos;audit) et notifiés à l&apos;étape suivante.
                          </p>
                        )}
                        {needsAssign && (mode === "approve" || (mode === "reject" && !actionIsLast)) && (
                          <div className="space-y-1">
                            <Label>Personne désignée{a.assignRole ? ` (${ROLE_LABELS[a.assignRole] ?? a.assignRole})` : ""} <span className="text-destructive">*</span></Label>
                            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                              <option value="">— Sélectionner —</option>
                              {a.assigneeCandidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </Select>
                            {a.assigneeCandidates.length === 0 && <p className="text-xs text-warning">Aucun compte disponible pour ce rôle.</p>}
                          </div>
                        )}
                        {/* Montant : sur APPROUVER (obligatoire ou non selon l'étape), ET de
                            manière OPTIONNELLE sur un AVIS DÉFAVORABLE intermédiaire — le chef de
                            produit peut y joindre un montant révisé (ex. « revu à la hausse »). */}
                        {needsAmount && (mode === "approve" || (mode === "reject" && !actionIsLast)) && (
                          <div className="space-y-1">
                            <Label>
                              Montant (DZD)
                              {mode === "approve" && a.requireAmount && <span className="text-destructive"> *</span>}
                              {mode === "reject" && <span className="font-normal text-muted-foreground"> — optionnel (montant révisé)</span>}
                            </Label>
                            <Input type="number" inputMode="decimal" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={mode === "reject" ? "Montant révisé (optionnel)" : "Montant"} />
                          </div>
                        )}
                        {mode === "approve" && needsCategory && (
                          <div className="space-y-1">
                            <Label>(Sous-)catégorie budgétaire{a.requireCategory && <span className="text-destructive"> *</span>}</Label>
                            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                              <option value="">— Choisir la (sous-)catégorie à imputer —</option>
                              {view.budgetCategories.map((c) => <option key={c.id} value={c.id}>{c.isSub ? " ↳ " : ""}{c.label}</option>)}
                            </Select>
                          </div>
                        )}
                        <Textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder={mode === "reject" ? (actionIsLast ? "Motif du refus (obligatoire)…" : "Motif de l'avis défavorable (obligatoire)…") : mode === "return" ? "Ce que le demandeur doit corriger (obligatoire)…" : mode === "skip" ? "Raison du saut d'étape (obligatoire)…" : mode === "comment" ? "Votre commentaire…" : a.requireNote ? "Commentaire (obligatoire)…" : "Note (optionnel)…"}
                          className="min-h-[56px]"
                        />
                        {/* Pièce(s) jointe(s) à l'avis — disponibles à toutes les issues :
                            l'analyse s'appuie souvent sur un devis ou un courrier, et le faire
                            déposer « plus tard, dans les documents » revient à ne pas le lier
                            à la décision qu'il justifie. */}
                        <div className="space-y-1">
                          <Label className="font-normal text-muted-foreground">Pièce(s) jointe(s) à votre avis — optionnel</Label>
                          <input
                            ref={fileRef}
                            type="file"
                            multiple
                            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                            className="block w-full cursor-pointer rounded-lg border border-border bg-background text-xs file:mr-3 file:cursor-pointer file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium"
                          />
                          {files.length > 0 && (
                            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                              {files.length} fichier(s) : {files.map((f) => f.name).join(", ")}
                            </p>
                          )}
                        </div>
                        {err && <p className="text-xs text-destructive">{err}</p>}
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                          {mode === "approve" && (
                            <BoutonDecisif size="sm" className="h-11 w-full text-sm sm:h-8 sm:w-auto sm:text-xs" disabled={approveDisabled} onClick={() => submit("APPROVE")}>
                              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Confirmer
                            </BoutonDecisif>
                          )}
                          {mode === "reject" && (
                            <BoutonDecisif size="sm" variant="destructive" className="h-11 w-full text-sm sm:h-8 sm:w-auto sm:text-xs" disabled={pending || !note.trim() || (!actionIsLast && needsAssign && !assignee)} onClick={() => submit("REJECT")}>
                              {pending && <Loader2 className="h-4 w-4 animate-spin" />} {actionIsLast ? "Refuser" : "Émettre l'avis défavorable"}
                            </BoutonDecisif>
                          )}
                          {mode === "return" && (
                            <BoutonDecisif size="sm" variant="outline" className="h-11 w-full text-sm sm:h-8 sm:w-auto sm:text-xs" disabled={pending || !note.trim()} onClick={() => submit("RETURN")}>
                              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Renvoyer au demandeur
                            </BoutonDecisif>
                          )}
                          {mode === "skip" && (
                            <BoutonDecisif size="sm" variant="outline" className="h-11 w-full text-sm sm:h-8 sm:w-auto sm:text-xs" disabled={pending || !note.trim()} onClick={() => submit("SKIP")}>
                              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SkipForward className="h-4 w-4" />} Confirmer le saut
                            </BoutonDecisif>
                          )}
                          {mode === "comment" && (
                            <Button size="sm" className="h-11 text-sm sm:h-8 sm:text-xs" disabled={pending || !note.trim()} onClick={() => submit("COMMENT")}>
                              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Publier
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => { resetForm(); setErr(null); }}>Annuler</Button>
                        </div>
                      </div>
  ) : null;

  // LE MOTIF ET LA RESOUMISSION — communs aux deux rendus.
  const motifEtReprise = (
    <>
      {/* LE MOTIF QUE LE DEMANDEUR DOIT LIRE (§118.186, R03) — un renvoi qui l'attend, ou le refus
          qui a clos sa demande. Hors de l'historique privilégié : il lui est adressé. */}
      {view.motif && (
        <div className={`rounded-lg border p-3 text-sm ${view.motif.nature === "RENVOI" ? "border-warning/40 bg-warning/10" : "border-destructive/30 bg-destructive/5"}`}>
          <p className="font-medium">
            {view.motif.nature === "RENVOI" ? "À corriger" : "Demande refusée"} — {view.motif.etape}
            {view.motif.auteur ? `, par ${view.motif.auteur}` : ""} <span className="font-normal text-muted-foreground">({formatDateTime(view.motif.le)})</span>
          </p>
          {view.motif.motif && <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">{view.motif.motif}</p>}
          {view.motif.nature === "RENVOI" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Corrigez la demande (« Modifier la demande »), puis resoumettez-la : elle reviendra à cette étape.
            </p>
          )}
        </div>
      )}
      {view.peutResoumettre && <ResubmitForm entityType={entityType} entityId={entityId} />}
      {view.peutFaireAppel && <AppealForm entityType={entityType} entityId={entityId} />}
    </>
  );

  // L'ORDRE DE DÉPENSE émis à l'issue d'un accord global — commun aux deux rendus.
  const ordre = view.outcome?.expenseOrder ? (
            <p className="mt-1 flex flex-wrap items-center gap-2">
              Ordre de dépense <span className="font-mono text-xs">{view.outcome.expenseOrder.reference}</span>
              <StatusBadge map={EXPENSE_ORDER_STATUS} value={view.outcome.expenseOrder.status} dot={false} />
              <span className="tabular-nums">{formatCurrency(view.outcome.expenseOrder.amount)}</span>
              <Link href="/finances/paiements-a-faire" className="inline-flex min-h-9 items-center px-1 text-primary hover:underline sm:min-h-0 sm:px-0">Voir</Link>
            </p>
  ) : null;

  if (compact) {
    // ── LA FRISE HORIZONTALE : la demande déposée, les étapes de SON parcours, puis ce que la page ajoute. ──
    const creation = view.events.find((e) => e.action === "CREATE");
    const quand = (e: WorkflowEventView | undefined) => (e ? [jourCourt(e.createdAt), nomCourt(e.actorName)].filter(Boolean).join(" · ") : null);
    const frise: EtapeDeFrise[] = [
      ...(creation ? [{ cle: "__demande__", titre: "Demande", detail: quand(creation), etat: "done" as const }] : []),
      ...view.steps.map((s): EtapeDeFrise => {
        const fait = [...view.events].reverse().find((e) => e.stepTitle === s.title && GESTES_D_ETAPE.has(e.action));
        const detail = s.state === "done" || s.state === "rejected" ? quand(fait)
          : s.state === "current" ? (view.assigneeName ?? acteurDe(s))
            : acteurDe(s);
        return { cle: s.slug, titre: s.title, detail, etat: s.state };
      }),
      ...suite,
    ];

    // ── LA PHRASE « état — chez qui », et ce qui vient ensuite (la page peut la dire mieux : `statut`). ──
    const courante = view.steps.find((s) => s.state === "current") ?? null;
    const apres = courante ? view.steps.slice(view.steps.indexOf(courante) + 1).find((s) => s.state === "todo") ?? null : null;
    const suiteAttendue = suite.find((x) => x.etat !== "done") ?? null;
    const parDefaut: StatutDeLaDemande =
      view.status === "IN_PROGRESS" ? {
        phrase: courante ? `${courante.title} — ${a ? "à vous d'agir" : `chez ${view.assigneeName ?? acteurDe(courante)}`}` : "En cours",
        ensuite: apres ? `${apres.title} (${acteurDe(apres)})` : suiteAttendue?.titre ?? null,
        ton: "info",
      }
        : view.status === "RETURNED" ? { phrase: "À corriger — chez le demandeur", ensuite: courante ? `retour à « ${courante.title} »` : null, ton: "attente" }
          : view.status === "APPROVED" ? { phrase: "Approuvée", ensuite: suiteAttendue?.titre ?? null, ton: "succes" }
            : view.status === "REJECTED" ? { phrase: "Refusée", ton: "refus" }
              : { phrase: st.label, ton: "neutre" };
    const s = statut ?? parDefaut;

    return (
      <div className="space-y-3">
        <ol aria-label="Étapes de la demande" className="grid auto-cols-[minmax(6.5rem,1fr)] grid-flow-col gap-1.5 overflow-x-auto pb-1">
          {frise.map((e) => (
            <li
              key={e.cle}
              title={[e.titre, e.detail].filter(Boolean).join(" — ")}
              className={cn(
                "min-w-0 border-t-[3px] pt-1.5 text-xs",
                e.etat === "done" ? "border-success text-success"
                  : e.etat === "current" ? "border-primary text-primary"
                    : e.etat === "rejected" ? "border-destructive text-destructive"
                      : "border-border text-muted-foreground",
              )}
            >
              <p className={cn("truncate", e.etat === "current" ? "font-semibold" : "font-medium")}>
                {e.etat === "done" ? "✓ " : e.etat === "current" ? "⏱ " : e.etat === "rejected" ? "✗ " : ""}{e.titre}
              </p>
              <p className="truncate text-[0.6875rem] opacity-90">{e.detail || " "}</p>
            </li>
          ))}
        </ol>

        <div className={cn("rounded-lg border px-3 py-2.5 sm:px-4", TON_STATUT[s.ton ?? "info"])}>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="min-w-0 font-semibold [overflow-wrap:anywhere]">
              {s.phrase}
              {s.ensuite && <span className="block text-xs font-normal opacity-90">Ensuite : {s.ensuite}</span>}
            </p>
            {!mode && boutons}
          </div>
          {mode && formulaire && <div className="mt-3 rounded-lg border border-border bg-card p-3 text-foreground">{formulaire}</div>}
        </div>

        {gestes}
        {motifEtReprise}
        {ordre && <div className="text-sm">{ordre}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-muted-foreground">{view.definitionName}</p>
        <Badge tone={st.tone} dot={false}>{st.label}</Badge>
      </div>

      {/* Frise dynamique dérivée de la définition */}
      <ol className="space-y-3">
        {view.steps.map((s, i) => {
          const tone =
            s.state === "done" ? "bg-success text-success-foreground"
              : s.state === "current" ? "bg-warning text-warning-foreground"
                : s.state === "rejected" ? "bg-destructive text-destructive-foreground"
                  : "bg-secondary text-muted-foreground";
          return (
            <li key={s.slug} className="flex gap-3">
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${tone}`}>
                {s.state === "rejected" ? "✗" : s.state === "done" ? "✓" : i + 1}
              </div>
              <div className="min-w-0 flex-1 border-b border-border pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-medium">{s.title}</p>
                  {/* QUI tient l'étape, en un mot. Le reste (pouvoirs, description de la règle, « → dépense ») ne s'affiche plus
                      sur la fiche (Direction, 07/10) : il se lit et se règle dans Administration › Circuits. */}
                  <span className="text-xs text-muted-foreground">· {acteurDe(s)}</span>
                </div>

                {/* Action disponible à l'étape courante */}
                {a && a.slug === s.slug && (
                  <div className="mt-3 rounded-lg border border-border bg-secondary/30 p-2.5 sm:p-3">
                    {!mode ? boutons : formulaire}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {motifEtReprise}

      {a === null && view.status === "IN_PROGRESS" && (
        <p className="text-sm text-muted-foreground">
          {view.assigneeName ? `En attente de ${view.assigneeName} ou du rôle en charge de l'étape courante.` : "En attente de l'acteur en charge de l'étape courante."}
        </p>
      )}

      {/* Issue d'un SPONSORING sous la règle de la tenue : l'étape suivante est la préparation des
          postes, puis la clôture — pas « l'information médicale / les Finances » d'un accord global. */}
      {view.outcome?.tenue && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
          {view.outcome.tenue === "PRE_VALIDEE" ? (
            <p>Tenue pré-validée — les postes se préparent (devis, BC, factures), puis la validation finale range chaque poste dans un budget et clôture la demande.</p>
          ) : (
            <p>
              Validée et clôturée
              {view.outcome.grantedAmount != null && <> — montant accordé <span className="font-semibold">{formatCurrency(view.outcome.grantedAmount)}</span></>}.
              {" "}Les paiements suivent poste par poste.
            </p>
          )}
        </div>
      )}

      {/* Issue */}
      {view.outcome && !view.outcome.tenue && (view.outcome.grantedAmount != null || view.outcome.expenseOrder) && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
          {view.outcome.grantedAmount != null && <p>Montant accordé : <span className="font-semibold">{formatCurrency(view.outcome.grantedAmount)}</span></p>}
          {ordre ? ordre : view.status === "APPROVED" ? (
            <p className="mt-1 text-xs text-muted-foreground">En cours de traitement (information médicale / Finances).</p>
          ) : null}
        </div>
      )}

      {view.peutRetirer && <WithdrawForm entityType={entityType} entityId={entityId} />}

      {/* Historique — visible des spectateurs privilégiés (Super Admin, Direction /
          Directeur des opérations, National Sales, Direction Marketing). L'avis et le
          montant des étapes confidentielles restent masqués pour les autres (déjà caviardés
          côté requête), qui ne voient pas ce bloc du tout. */}
      {view.canViewHistory && view.events.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historique</p>
          <HistoriqueDuCircuit events={view.events} />
        </div>
      )}
    </div>
  );
}

/**
 * L'HISTORIQUE DU CIRCUIT — qui a fait quoi, et quand. Sur les fiches Sponsoring et Événements (Direction, 07/10), il quitte
 * la carte « La demande » pour « Traçabilité », et seulement pour le Super Admin : la page décide qui le voit.
 */
export function HistoriqueDuCircuit({ events }: { events: WorkflowEventView[] }) {
  return (
    <ul className="space-y-1.5">
      {events.map((e, i) => (
        <li key={i} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">{e.actorName ?? "—"}</span> · {e.stepTitle} ·{" "}
          {LIBELLE_ACTION[e.action] ?? "commenté"}
          {e.amount != null ? ` · ${formatCurrency(e.amount)}` : ""}
          {e.note ? ` — ${e.note}` : ""} <span className="opacity-70">({formatDateTime(e.createdAt)})</span>
        </li>
      ))}
    </ul>
  );
}

/** Les gestes de l'historique, dits en français — un code brut à l'écran ne se lit pas. */
const LIBELLE_ACTION: Record<string, string> = {
  CREATE: "a créé la demande",
  APPROVE: "approuvé",
  REJECT: "refusé",
  OPINION_AGAINST: "avis défavorable",
  SKIP: "étape sautée",
  AUTO_SKIP: "étape franchie automatiquement",
  AUTO_APPROVE_REQUESTER: "auto-accord (demandeur habilité)",
  COMMENT: "commenté",
  RETURN: "renvoyé pour correction",
  RESUBMIT: "corrigée et resoumise",
  REOPEN: "étape rouverte (montant relevé)",
  APPEAL: "appel — réexamen",
  CANCEL: "demande close",
};

/**
 * RESOUMETTRE après correction (§118.186). Une note facultative dit ce qui a été corrigé — elle part
 * avec la notification à l'étape qui reprend la demande.
 */
function ResubmitForm({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [pendingAction, start] = React.useTransition();
  const pending = pendingAction || enCours;
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const envoyer = () => start(async () => {
    setErr(null);
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    if (note.trim()) fd.set("note", note.trim());
    const r = await resoumettreDemande(fd);
    if (!r.ok) { setErr(r.error ?? "Resoumission impossible."); return; }
    setNote("");
    rafraichir();
  });
  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
      <Label>Ce que vous avez corrigé — facultatif</Label>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. montant ramené à 300 000 DZD, devis joint…" className="min-h-[56px]" />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <Button size="sm" className="w-full sm:w-auto" disabled={pending} onClick={envoyer}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Resoumettre la demande
      </Button>
    </div>
  );
}

/**
 * FAIRE APPEL D'UN REFUS (décision #12, 27/10/2026) — motif obligatoire, transmis à l'étape qui réexamine.
 */
function AppealForm({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [pendingAction, start] = React.useTransition();
  const pending = pendingAction || enCours;
  const [motif, setMotif] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const envoyer = () => start(async () => {
    setErr(null);
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    fd.set("motif", motif.trim());
    const r = await faireAppelAdPro(fd);
    if (!r.ok) { setErr(r.error ?? "Appel impossible."); return; }
    setMotif("");
    rafraichir();
  });
  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
      <Label>Faire appel du refus</Label>
      <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Pourquoi la demande doit être réexaminée (obligatoire)…" className="min-h-[56px]" />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <Button size="sm" className="w-full sm:w-auto" disabled={pending || !motif.trim()} onClick={envoyer}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Faire appel
      </Button>
    </div>
  );
}

/**
 * RETIRER une demande non tranchée (§118.186) — motif obligatoire, et la confirmation le dit : retirer
 * la SUPPRIME (Direction, 05/10), récupérable depuis la corbeille par le Super Admin. La fiche n'existe
 * plus après le geste : on quitte la page vers la liste au lieu de la rafraîchir (elle s'afficherait
 * « Introuvable »).
 */
export function WithdrawForm({ entityType, entityId, dansUnMenu = false }: {
  entityType: EntityType;
  entityId: string;
  /** Rangé dans le menu « ⋯ » de la fiche (rendu compact) : sans le filet de séparation du panneau. */
  dansUnMenu?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const retirer = () => start(async () => {
    setErr(null);
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    fd.set("motif", motif.trim());
    const r = await retirerDemandeAdPro(fd);
    if (!r.ok) { setErr(r.error ?? "Retrait impossible."); return; }
    setOpen(false);
    // Pas de `refresh()` : la fiche n'existe plus, la rafraîchir la rendrait « Introuvable ». L'action a
    // invalidé les listes (`revaliderLaDemande`) ; la navigation les relit.
    router.push(r.redirect ?? "/ad-pro");
  });
  if (!open) {
    return (
      <div className={dansUnMenu ? undefined : "border-t border-border pt-3"}>
        <Button size="sm" variant={dansUnMenu ? "outline" : "ghost"} className={dansUnMenu ? "w-full justify-start" : undefined} onClick={() => setOpen(true)}><Ban className="h-4 w-4" /> Retirer la demande</Button>
      </div>
    );
  }
  return (
    <div className={dansUnMenu ? "space-y-2" : "space-y-2 border-t border-border pt-3"}>
      <p className="text-xs text-muted-foreground">
        La demande sera SUPPRIMÉE, avec ses postes, ses pièces et ce qui en découle (circuit, validations, ordres non réglés). Elle reste récupérable depuis la corbeille par le Super Admin ; le motif reste au journal.
      </p>
      <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Pourquoi retirer la demande (obligatoire)…" className="min-h-[56px]" />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <BoutonDecisif size="sm" variant="destructive" disabled={pending || !motif.trim()} onClick={retirer}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Retirer
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setErr(null); }}>Annuler</Button>
      </div>
    </div>
  );
}
