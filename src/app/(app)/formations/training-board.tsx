"use client";

import * as React from "react";
import {
  Plus, Loader2, ThumbsUp, ThumbsDown, Check, X, Users, FileText, Download, ChevronDown, ChevronRight, GraduationCap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CHAIN_STAGE_LABELS, type ChainStage } from "@/lib/approval-chain";
import {
  TRAINING_STATUS_LABELS, ATTENDANCE_LABELS, PARTICIPANT_STATE_LABELS, countParticipants,
  type TrainingAttendance, type TrainingParticipantState, type TrainingStatus, type ParticipantCounts,
} from "@/lib/training";
import {
  requestTraining, createHrTraining, decideTraining, inviteTrainingParticipants, respondToTrainingInvitation, annulerFormation,
} from "@/lib/actions/training-actions";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useSaisir } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { ancreFormation } from "@/lib/chemins/formations";

export interface TrainingParticipantRow {
  id: string;
  userId: string;
  name: string;
  attendance: TrainingAttendance;
  state: TrainingParticipantState;
}

export interface TrainingRow {
  id: string;
  reference: string;
  title: string;
  origin: "EMPLOYEE" | "HR";
  status: TrainingStatus;
  stage: ChainStage;
  provider: string | null;
  description: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  amount: number;
  amountGranted: number | null;
  requester: string;
  requesterId: string | null;
  department: string | null;
  participants: TrainingParticipantRow[];
  documents: { id: string; name: string }[];
  /** Résolu côté serveur : un bouton affiché par erreur est une promesse que le serveur refusera. */
  canDecide: boolean;
  /** Le demandeur peut l'annuler (décision du 04/10) — même règle que l'action (`refusAnnulationFormation`). */
  canCancel?: boolean;
  myParticipation: TrainingParticipantRow | null;
}

/**
 * L'ÉCRAN DES FORMATIONS.
 *
 * Trois publics le lisent, et l'ordre des blocs suit leurs questions : « qu'ai-je à
 * trancher ? » (validateur), « où en est ma demande ? » (salarié), « qui vient ? »
 * (organisatrice). Chaque ligne se déplie plutôt que d'ouvrir une page : une formation tient
 * en dix lignes, et changer d'écran pour les lire ferait perdre la file.
 */
export function TrainingBoard({
  rows, canOrganise, isDg, people, departments, counts, formationAOuvrir,
}: {
  rows: TrainingRow[];
  canOrganise: boolean;
  isDg: boolean;
  people: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  counts: ParticipantCounts[];
  /** La formation dont parle la notification (`?formation=`) : sa ligne s'ouvre, vient sous les yeux et s'entoure. */
  formationAOuvrir?: string | null;
}) {
  const { rafraichir } = useRafraichir();
  const saisir = useSaisir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = React.useState<string | null>(
    formationAOuvrir && rows.some((r) => r.id === formationAOuvrir) ? formationAOuvrir : null,
  );
  const [form, setForm] = React.useState<"none" | "request" | "organise">("none");
  const [granted, setGranted] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<Record<string, string>>({});

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(key); setMsg(null);
    let r: { ok: boolean; error?: string };
    try {
      r = await fn();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      return;
    } finally {
      setBusy(null);
    }
    setMsg({ ok: r.ok, text: r.ok ? okText : (r.error ?? "Le geste n'a pas abouti.") });
    if (r.ok) { setForm("none"); rafraichir(); }
  };

  return (
    <div className="space-y-3">
      <SurlignerCible ids={[formationAOuvrir ? ancreFormation(formationAOuvrir) : null]} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setForm(form === "request" ? "none" : "request")}>
          <Plus className="h-4 w-4" /> Demander une formation
        </Button>
        {canOrganise && (
          <Button size="sm" variant="outline" onClick={() => setForm(form === "organise" ? "none" : "organise")}>
            <GraduationCap className="h-4 w-4" /> Organiser une formation
          </Button>
        )}
      </div>

      {form !== "none" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const organise = form === "organise";
            void run("create",
              () => (organise ? createHrTraining(undefined, fd) : requestTraining(undefined, fd)),
              organise ? "Formation créée — la direction est prévenue." : "Demande envoyée.");
          }}
          className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
        >
          <p className="text-sm font-medium">
            {form === "organise" ? "Organiser une formation (RH)" : "Demander une formation"}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs sm:col-span-2">
              Intitulé <span className="text-destructive">*</span>
              <Input name="title" required placeholder="Ex. Bonnes pratiques de fabrication — module 2" className="mt-1 h-10 sm:h-9" />
            </label>
            <label className="text-xs">
              Coût estimé (DZD)
              <Input name="amount" inputMode="decimal" placeholder="0" className="mt-1 h-10 text-right tabular-nums sm:h-9" />
            </label>
            <label className="text-xs">
              Organisme / formateur
              <Input name="provider" placeholder="Ex. Institut Pasteur d'Algérie" className="mt-1 h-10 sm:h-9" />
            </label>
            <label className="text-xs">
              Du
              <Input type="date" name="startDate" className="mt-1 h-10 sm:h-9" />
            </label>
            <label className="text-xs">
              Au
              <Input type="date" name="endDate" className="mt-1 h-10 sm:h-9" />
            </label>
            <label className="text-xs sm:col-span-2">
              Lieu
              <Input name="location" placeholder="Ex. Alger — hôtel Sofitel, ou distanciel" className="mt-1 h-10 sm:h-9" />
            </label>
            {form === "organise" && departments.length > 0 && (
              <label className="text-xs">
                Département concerné
                <select name="departmentId" className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-9">
                  <option value="">— Toute l&apos;entreprise —</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <label className="block text-xs">
            Objectif / contenu
            <Input name="description" placeholder="Ce que la formation apporte, et pourquoi maintenant" className="mt-1 h-10 sm:h-9" />
          </label>
          <label className="block text-xs">
            Devis, programme, convention…
            <input type="file" name="files" multiple className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
            <span className="text-[0.6875rem] text-muted-foreground">
              Le devis n&apos;est pas exigé maintenant — l&apos;obtenir prend parfois des semaines, et attendre
              empêcherait d&apos;en parler. Il se joint ensuite.
            </span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="sm" type="submit" disabled={busy === "create"} className="h-10 sm:h-8">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Envoyer
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setForm("none")}>Annuler</Button>
          </div>
        </form>
      )}

      {msg && (
        <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon="GraduationCap"
          title="Aucune formation"
          description="Demandez une formation, ou — si vous êtes aux ressources humaines — organisez-en une et invitez des participants."
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((t, i) => {
            const c = counts[i] ?? countParticipants(t.participants);
            const expanded = open === t.id;
            return (
              <li key={t.id} id={ancreFormation(t.id)}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
                  <button
                    type="button" onClick={() => setOpen(expanded ? null : t.id)}
                    className="-my-1 -ml-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground sm:-ml-1 sm:h-7 sm:w-7"
                    aria-label={expanded ? "Replier" : "Déplier"}
                  >
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <Badge tone={TRAINING_STATUS_LABELS[t.status].tone} dot={false}>{TRAINING_STATUS_LABELS[t.status].label}</Badge>
                  {/* Au téléphone : l'intitulé sur deux lignes plutôt que coupé ; montant et réponses passent dessous. */}
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="line-clamp-2 font-medium [overflow-wrap:anywhere] sm:line-clamp-none sm:truncate">{t.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere] sm:line-clamp-none sm:truncate">
                      <span className="font-mono">{t.reference}</span>
                      {t.origin === "HR" ? " · organisée par les RH" : ` · demandée par ${t.requester || "—"}`}
                      {t.department ? ` · ${t.department}` : ""}
                      {t.status === "PENDING" ? ` · ${CHAIN_STAGE_LABELS[t.stage]}` : ""}
                    </p>
                  </div>
                  {t.participants.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${c.expected} personne(s) attendue(s) · ${c.awaiting} réponse(s) en attente`}>
                      <Users className="h-3.5 w-3.5" /> {c.expected}/{c.total}
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums font-semibold">
                    {formatCurrency(t.amountGranted ?? t.amount)}
                    {t.amountGranted !== null && t.amountGranted !== t.amount && (
                      <span className="ml-1 text-[0.6875rem] font-normal text-muted-foreground line-through">{formatCurrency(t.amount)}</span>
                    )}
                  </span>

                  {/* Répondre à SON invitation — seulement quand on a le choix. */}
                  {t.myParticipation?.attendance === "VOLUNTARY" && t.myParticipation.state === "INVITED" && (
                    <span className="flex items-center gap-2 sm:gap-1">
                      <button type="button" disabled={busy === `resp:${t.id}`} onClick={() => {
                        const fd = new FormData(); fd.set("id", t.myParticipation!.id); fd.set("answer", "ACCEPTED");
                        void run(`resp:${t.id}`, () => respondToTrainingInvitation(fd), "Participation acceptée.");
                      }} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-success/30 px-3 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50 sm:min-h-0 sm:px-2">
                        <Check className="h-3.5 w-3.5" /> J&apos;y participe
                      </button>
                      <button type="button" disabled={busy === `resp:${t.id}`} onClick={() => {
                        const fd = new FormData(); fd.set("id", t.myParticipation!.id); fd.set("answer", "DECLINED");
                        void run(`resp:${t.id}`, () => respondToTrainingInvitation(fd), "Participation déclinée.");
                      }} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2">
                        <X className="h-3.5 w-3.5" /> Décliner
                      </button>
                    </span>
                  )}
                  {t.myParticipation?.attendance === "MANDATORY" && (
                    <Badge tone="warning" dot={false}>Convoqué</Badge>
                  )}
                </div>

                {expanded && (
                  <div className="space-y-3 border-t border-border/60 bg-secondary/20 px-3 py-3 text-sm">
                    {t.description && <p className="text-muted-foreground">{t.description}</p>}
                    <p className="text-xs text-muted-foreground">
                      {t.provider ? `Organisme : ${t.provider}` : "Organisme non précisé"}
                      {t.location ? ` · ${t.location}` : ""}
                      {t.startDate ? ` · du ${formatDate(t.startDate)}` : ""}
                      {t.endDate ? ` au ${formatDate(t.endDate)}` : ""}
                    </p>

                    {t.documents.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {t.documents.map((d) => (
                          <a key={d.id} href={`/api/documents/${d.id}?dl=1`} title={d.name}
                            className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-secondary sm:min-h-0">
                            <FileText className="h-3 w-3 shrink-0" /> <span className="min-w-0 truncate">{d.name}</span> <Download className="h-3 w-3 shrink-0" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* DÉCIDER — une marche du circuit ; la dernière révise le montant. */}
                    {t.canDecide && (
                      <div className="space-y-2 rounded-lg border border-border bg-background p-2.5">
                        <p className="text-xs font-medium">Votre décision — {CHAIN_STAGE_LABELS[t.stage]}</p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {t.stage === "DG" && (
                            <label className="text-xs">
                              Montant accordé (DZD)
                              <Input
                                value={granted[t.id] ?? String(t.amount)}
                                onChange={(e) => setGranted((p) => ({ ...p, [t.id]: e.target.value }))}
                                inputMode="decimal" className="mt-1 h-10 text-right tabular-nums sm:h-9"
                              />
                              <span className="text-[0.6875rem] text-muted-foreground">
                                La direction accorde souvent moins que demandé — le budget suit CE montant.
                              </span>
                            </label>
                          )}
                          <label className="text-xs">
                            Note (transmise à l&apos;étape suivante)
                            <Input
                              value={note[t.id] ?? ""} onChange={(e) => setNote((p) => ({ ...p, [t.id]: e.target.value }))}
                              placeholder="Facultatif" className="mt-1 h-10 sm:h-9"
                            />
                          </label>
                        </div>
                        <div className="flex flex-wrap gap-2 sm:gap-1.5">
                          <BoutonDecisif brut type="button" disabled={busy === `dec:${t.id}`} onClick={() => {
                            const fd = new FormData();
                            fd.set("id", t.id); fd.set("decision", "APPROVED");
                            if (note[t.id]) fd.set("note", note[t.id]);
                            if (t.stage === "DG") fd.set("amountGranted", granted[t.id] ?? String(t.amount));
                            void run(`dec:${t.id}`, () => decideTraining(fd), "Formation validée.");
                          }} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-success/30 px-3 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50 sm:min-h-0 sm:px-2">
                            {busy === `dec:${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsUp className="h-3.5 w-3.5" />} Approuver
                          </BoutonDecisif>
                          <BoutonDecisif brut type="button" disabled={busy === `dec:${t.id}`} onClick={() => {
                            const fd = new FormData();
                            fd.set("id", t.id); fd.set("decision", "REJECTED");
                            if (note[t.id]) fd.set("note", note[t.id]);
                            void run(`dec:${t.id}`, () => decideTraining(fd), "Formation refusée.");
                          }} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2">
                            <ThumbsDown className="h-3.5 w-3.5" /> Refuser
                          </BoutonDecisif>
                        </div>
                      </div>
                    )}

                    {/* ANNULER SA DEMANDE (décision du 04/10) — tant qu'elle n'a pas eu lieu. */}
                    {t.canCancel && (
                      <button type="button" disabled={busy === `ann:${t.id}`} onClick={async () => {
                        const motif = await saisir({
                          titre: "Annuler cette formation ?",
                          message: "Les personnes qui l'ont en main en seront prévenues.",
                          saisie: { libelle: "Motif (facultatif)", valeur: "" },
                        });
                        if (motif === null) return;
                        const fd = new FormData();
                        fd.set("id", t.id); if (motif.trim()) fd.set("motif", motif.trim());
                        void run(`ann:${t.id}`, () => annulerFormation(fd), "Formation annulée.");
                      }} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2">
                        Annuler ma demande
                      </button>
                    )}

                    {/* PARTICIPANTS — convoqués et volontaires, avec leurs réponses. */}
                    {(t.participants.length > 0 || canOrganise) && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium">
                          Participants ({c.expected} attendu(s){c.awaiting > 0 ? ` · ${c.awaiting} réponse(s) en attente` : ""})
                        </p>
                        {t.participants.length > 0 && (
                          <ul className="flex flex-wrap gap-1.5">
                            {t.participants.map((p) => (
                              <li key={p.id} className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs">
                                {p.name}
                                <Badge tone={p.attendance === "MANDATORY" ? "warning" : "neutral"} dot={false}>
                                  {p.attendance === "MANDATORY" ? "convoqué" : "volontaire"}
                                </Badge>
                                {p.attendance === "VOLUNTARY" && (
                                  <Badge tone={PARTICIPANT_STATE_LABELS[p.state].tone} dot={false}>
                                    {PARTICIPANT_STATE_LABELS[p.state].label}
                                  </Badge>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {canOrganise && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const fd = new FormData(e.currentTarget);
                              fd.set("trainingId", t.id);
                              void run(`inv:${t.id}`, () => inviteTrainingParticipants(fd), "Participants prévenus.");
                            }}
                            className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5 sm:flex-row sm:flex-wrap sm:items-end"
                          >
                            <label className="text-xs">
                              Nature
                              <select name="attendance" defaultValue="VOLUNTARY" className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-9 sm:w-auto">
                                <option value="VOLUNTARY">{ATTENDANCE_LABELS.VOLUNTARY}</option>
                                <option value="MANDATORY">{ATTENDANCE_LABELS.MANDATORY}</option>
                              </select>
                            </label>
                            <label className="text-xs sm:min-w-[14rem] sm:flex-1">
                              Personnes
                              <select name="userIds" multiple size={4} className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1 text-sm">
                                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                            </label>
                            <Button size="sm" type="submit" disabled={busy === `inv:${t.id}`} className="h-10 sm:h-8">
                              {busy === `inv:${t.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />} Inviter
                            </Button>
                          </form>
                        )}
                        {canOrganise && (
                          <p className="text-[0.6875rem] text-muted-foreground">
                            Un <strong>convoqué</strong> est compté présent d&apos;emblée — lui demander d&apos;accepter
                            viderait le mot de son sens. Un <strong>volontaire</strong> répond, et c&apos;est sa réponse
                            qui donne le nombre de couverts.
                          </p>
                        )}
                      </div>
                    )}

                    {isDg && t.status === "APPROVED" && (
                      <p className="text-[0.6875rem] text-muted-foreground">
                        Les postes de cette formation (location de salle, traiteur, intervenant…) se valident un par
                        un, comme ceux d&apos;un sponsoring.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
