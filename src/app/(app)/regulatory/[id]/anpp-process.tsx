"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check, Loader2, CircleDot, ArrowRight, ChevronDown, Paperclip, MessageSquare,
  ReceiptText, ListChecks, Repeat, Ban,
} from "lucide-react";
import {
  REG_PHASES, REG_STEPS, REG_STEP_STATE, REG_CHECKLIST,
  PRESUB_ANSWER_STEP, REG_PRESUB_OUTCOME, REG_PRESUB_OUTCOME_ORDER, presubOutcome,
  PRESUB_CHECKLIST_AFTER_STEP, BV_REQUEST_STEPS, BV_PAYMENT_STEPS, ANPP_EXCHANGE_AFTER_STEP,
  regProgress, regStepStatus, regChecklistProgress,
  type RegWorkflowState, type RegChecklistState, type RegStepState, type RegPresubOutcome,
} from "@/lib/regulatory-workflow";
import { setRegulatoryStepState, setRegulatoryStepNote, setRegulatoryChecklistItem, setRegulatoryPresubOutcome } from "@/lib/actions/regulatory-actions";
import { Badge } from "@/components/ui/badge";
import { Select, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { DocumentUpload } from "@/components/documents/document-upload";
import { cn } from "@/lib/utils";
import { BvRequestSheet } from "./bv-requests";
import { DossierTimeline, type TimelineStepView } from "./dossier-timeline";
import { CtdInitiale } from "./ctd-initiale";
import { CTD_INITIALE_ETAPE, CTD_INITIALE_CATEGORIE } from "@/lib/regulatory/ctd-initiale";
import { ETAT_BV, type SuiviBvVue } from "@/lib/regulatory/bv-circuit";

const STATE_OPTS: RegStepState[] = ["TODO", "DOING", "DONE", "BLOCKED"];

function Bar({ pct, tone = "primary" }: { pct: number; tone?: "primary" | "success" }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
      <div className={`h-full rounded-full ${tone === "success" ? "bg-success" : "bg-primary"} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** La pastille de la frise : l'état de l'étape se lit sans lire le texte. */
function Dot({ state, n }: { state: RegStepState; n: number }) {
  const cls =
    state === "DONE" ? "border-success bg-success text-white"
      : state === "DOING" ? "border-primary bg-primary/10 text-primary"
        : state === "BLOCKED" ? "border-destructive bg-destructive/10 text-destructive"
          : "border-border bg-background text-muted-foreground";
  return (
    <span className={cn("z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[0.6875rem] font-semibold", cls)}>
      {state === "DONE" ? <Check className="h-3.5 w-3.5" />
        : state === "DOING" ? <CircleDot className="h-3.5 w-3.5" />
          : state === "BLOCKED" ? <Ban className="h-3.5 w-3.5" />
            : n}
    </span>
  );
}

/**
 * LE DOSSIER EST UNE FRISE, PAS QUATRE CARTES.
 *
 * Avant, ouvrir un dossier donnait quatre blocs empilés qui parlaient du même parcours : le
 * processus officiel en liste, la check-list de présoumission ailleurs, la demande de BV dans
 * la colonne de droite, les réserves ANPP encore plus bas. On lisait le dossier en faisant
 * défiler, et l'on tenait ce parcours dans sa tête plutôt qu'à l'écran.
 *
 * Ici il n'y a qu'un fil vertical, celui du dossier réel, et les trois objets vivants y sont
 * DANS l'étape à laquelle ils appartiennent :
 *
 *   • le **CTD initial se dépose sur l'étape 1** (fichiers, .zip pour une arborescence) — la
 *     réception n'est pas qu'une case, c'est la pièce elle-même ;
 *   • la **check-list de présoumission est l'étape 2**, à part — la liste se déplie sous elle ;
 *   • **demander un BV** se fait sur l'étape « Demande du BV 25 / 75 % », avec montant,
 *     échéance, note et pièces ; la demande EST l'étape, elle la coche ;
 *   • les **allers-retours avec l'ANPP** (réserves → réponses → redépôt, autant de fois qu'il
 *     le faut) sont la SEULE trace du cycle des réserves : la frise du dossier vit entre
 *     l'évaluation et le dépôt des réponses — les anciennes cases-jalons ont été retirées.
 */
export function RegulatoryProcess({
  productId, workflow, checklist, canUpdate, canUpload, canDelete, stepDocs, path,
  dossierSteps, reference, ctd, bvSuivi = {},
}: {
  /**
   * L'état de chaque BV, par étape de DEMANDE (`bv25_req`, `bv75_req`) — lu sur son ordre de dépense :
   * demandé (au centre), autorisé (chez les Finances), payé (quittance), refusé (motif). `null` : rien
   * n'a été demandé, ou la demande a été annulée.
   */
  bvSuivi?: Record<string, SuiviBvVue | null>;
  productId: string;
  workflow: RegWorkflowState | null;
  checklist: RegChecklistState | null;
  canUpdate: boolean;
  canUpload: boolean;
  canDelete: boolean;
  stepDocs: Record<string, DocItem[]>;
  path: string;
  dossierSteps: TimelineStepView[];
  reference: string;
  /** La « CTD initiale » (§118.213) : ses documents, ce que la personne peut en faire, et ce qui s'est passé. */
  ctd: {
    docs: DocItem[];
    canUpload: boolean;
    canManage: boolean;
    depotEnCours: boolean;
    retiree: { quand: string; fichiers: number; remplacee: boolean } | null;
  };
}) {
  const router = useRouter();
  const [state, setState] = React.useState<RegWorkflowState>(workflow ?? {});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [bvStep, setBvStep] = React.useState<string | null>(null);

  React.useEffect(() => { setState(workflow ?? {}); }, [workflow]);

  const prog = regProgress(state);

  async function setStep(key: string, status: RegStepState) {
    setBusy(key);
    setState((prev) => ({
      ...prev,
      [key]: { ...prev[key], status, date: status === "DONE" && !prev[key]?.date ? new Date().toISOString().slice(0, 10) : prev[key]?.date },
    }));
    const fd = new FormData();
    fd.set("productId", productId); fd.set("stepKey", key); fd.set("status", status);
    await setRegulatoryStepState(fd);
    setBusy(null);
    router.refresh();
  }

  // Avis de présoumission : favorable → « Fait » (le flux continue) ; défavorable → « Bloqué » ;
  // en attente → « En cours ». Le statut de l'étape est dérivé de l'avis (source unique).
  async function setPresub(outcome: RegPresubOutcome) {
    setBusy(PRESUB_ANSWER_STEP);
    const mapped = REG_PRESUB_OUTCOME[outcome];
    setState((prev) => ({
      ...prev,
      [PRESUB_ANSWER_STEP]: {
        ...prev[PRESUB_ANSWER_STEP], status: mapped.status, outcome,
        date: mapped.status === "DONE" && !prev[PRESUB_ANSWER_STEP]?.date ? new Date().toISOString().slice(0, 10) : prev[PRESUB_ANSWER_STEP]?.date,
      },
    }));
    const fd = new FormData();
    fd.set("productId", productId); fd.set("outcome", outcome);
    await setRegulatoryPresubOutcome(fd);
    setBusy(null);
    router.refresh();
  }

  /** Une étape de la frise, avec son rail, sa pastille et son tiroir. */
  const renderStep = (s: (typeof REG_STEPS)[number], last: boolean) => {
    const st = regStepStatus(state, s.key);
    const done = st === "DONE";
    const docs = stepDocs[s.key] ?? [];
    const note = state[s.key]?.note ?? "";
    const expanded = openKey === s.key;
    const bvType = BV_REQUEST_STEPS[s.key];
    const bvPaid = bvType ? regStepStatus(state, BV_PAYMENT_STEPS[s.key]) === "DONE" : false;
    // LE BV SE DEMANDE EN CLIQUANT L'ÉTAPE — tant qu'aucune demande ne vit (rien demandé, ou refusé par
    // le centre : on redemande). Une demande en cours, autorisée ou payée ne se double pas : le serveur
    // le refuse aussi (`requestBV`), l'écran ne propose donc pas le geste.
    const suivi = bvType ? bvSuivi[s.key] ?? null : null;
    const peutDemanderBv = Boolean(bvType && canUpdate && (suivi ? suivi.etat === "REFUSE" : !bvPaid));
    // L'étape de PAIEMENT rappelle la quittance déposée par les Finances.
    const reqDuPaiement = Object.keys(BV_PAYMENT_STEPS).find((k) => BV_PAYMENT_STEPS[k] === s.key);
    const quittance = reqDuPaiement ? bvSuivi[reqDuPaiement]?.quittance ?? null : null;

    return (
      <li key={s.key} className="relative pl-10">
        {/* Le rail : il relie les étapes, et s'arrête à la dernière. */}
        {!last && <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-border" />}
        <span className="absolute left-0 top-0.5"><Dot state={st} n={s.n} /></span>

        <div className={cn("rounded-lg border px-3 py-2.5 transition-colors", done ? "border-success/30 bg-success/5" : st === "BLOCKED" ? "border-destructive/30 bg-destructive/5" : "border-border")}>
          {/* Au téléphone, l'état passe SOUS le libellé : à côté, le menu ne laissait que trois mots au titre. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <button type="button" onClick={() => setOpenKey(expanded ? null : s.key)} className="min-w-0 flex-1 text-left">
              <p className={cn("text-sm font-medium", done && "text-muted-foreground line-through")}>{s.label}</p>
              <p className="text-xs text-muted-foreground">{s.responsible} · {s.expected}</p>
              {done && state[s.key]?.date && <p className="text-[0.6875rem] text-success">Fait le {state[s.key]!.date}</p>}
              <span className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
                {docs.length > 0 && <span className="inline-flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{docs.length}</span>}
                {note && <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" /> note</span>}
                <span className="inline-flex items-center gap-0.5 text-primary"><ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} /> {expanded ? "Réduire" : "Pièces & note"}</span>
              </span>
            </button>

            <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-col sm:items-end">
              {s.key === PRESUB_ANSWER_STEP ? (
                canUpdate ? (
                  <Select
                    value={presubOutcome(state) ?? ""}
                    onChange={(e) => setPresub(e.target.value as RegPresubOutcome)}
                    disabled={busy === s.key}
                    className="h-9 w-full text-xs sm:h-8 sm:w-44"
                  >
                    <option value="" disabled>— Avis présoumission —</option>
                    {REG_PRESUB_OUTCOME_ORDER.map((o) => <option key={o} value={o}>{REG_PRESUB_OUTCOME[o].label}</option>)}
                  </Select>
                ) : presubOutcome(state) ? (
                  <Badge tone={REG_PRESUB_OUTCOME[presubOutcome(state)!].tone} dot={false}>{REG_PRESUB_OUTCOME[presubOutcome(state)!].label}</Badge>
                ) : (
                  <Badge tone={REG_STEP_STATE[st].tone} dot={false}>{REG_STEP_STATE[st].label}</Badge>
                )
              ) : canUpdate ? (
                <Select
                  value={st}
                  onChange={(e) => setStep(s.key, e.target.value as RegStepState)}
                  disabled={busy === s.key}
                  className="h-9 w-full text-xs sm:h-8 sm:w-32"
                >
                  {STATE_OPTS.map((o) => <option key={o} value={o}>{REG_STEP_STATE[o].label}</option>)}
                </Select>
              ) : (
                <Badge tone={REG_STEP_STATE[st].tone} dot={false}>{busy === s.key ? <Loader2 className="h-3 w-3 animate-spin" /> : REG_STEP_STATE[st].label}</Badge>
              )}

            </div>
          </div>

          {/* LA DEMANDE DE BV SE FAIT ICI — l'étape elle-même est le geste (montant, pièce jointe et
              commentaire facultatifs), puis elle raconte où en est le bon : au centre, chez les
              Finances, payé avec sa quittance, ou refusé avec le motif — et l'on redemande. */}
          {bvType && (suivi || peutDemanderBv) && (
            <BvEtape suivi={suivi} bvType={bvType} peutDemander={peutDemanderBv} onDemander={() => setBvStep(s.key)} />
          )}
          {quittance && (
            <a
              href={`/api/documents/${quittance.id}`} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0"
            >
              <Paperclip className="h-3 w-3" /> Quittance déposée par les Finances : {quittance.name}
            </a>
          )}

          {expanded && (
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <StepNote productId={productId} stepKey={s.key} initial={note} canUpdate={canUpdate} path={path} />
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {s.key === CTD_INITIALE_ETAPE ? "Autres pièces de l'étape (la CTD initiale a son bloc, juste en dessous)" : "Pièces de l'étape"}
                </p>
                {docs.length > 0 ? (
                  <DocumentList documents={docs} canDelete={canDelete || canUpload} canRename={canUpload} path={path} />
                ) : (
                  <p className="text-xs text-muted-foreground">Aucune pièce pour cette étape.</p>
                )}
                {canUpload && (
                  <div className="mt-2">
                    <DocumentUpload
                      entityType="REGULATORY_PRODUCT"
                      entityId={productId}
                      stepKey={s.key}
                      categories={s.key === CTD_INITIALE_ETAPE
                        // « CTD complet » n'est plus proposé ici : la CTD initiale se dépose depuis son bloc, qui sait
                        // l'ajouter, la remplacer, et la poser dans un dossier (§118.213).
                        ? ["MODULE_1", "MODULE_2", "MODULE_3", "MODULE_4", "MODULE_5", "SUPPORTING_DOC", "OTHER"].filter((c) => c !== CTD_INITIALE_CATEGORIE)
                        : ["SUPPORTING_DOC", "OTHER"]}
                      compact
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* LA CTD INITIALE, sur l'étape 1 : bien visible, avec la même importance que le bloc des réserves ANPP.
            Elle n'attend pas qu'on déplie « Pièces & note » : c'est LE livrable de cette étape. */}
        {s.key === CTD_INITIALE_ETAPE && (
          <div className="mt-2">
            <CtdInitiale
              productId={productId}
              reference={reference}
              docs={ctd.docs}
              canUpload={ctd.canUpload}
              canManage={ctd.canManage}
              canDelete={canDelete}
              path={path}
              depotEnCours={ctd.depotEnCours}
              retiree={ctd.retiree}
            />
          </div>
        )}

        {/* LA CHECK-LIST DE PRÉSOUMISSION, juste après la réception du CTD — pliée par défaut :
            trente cases ouvertes en permanence noieraient le parcours qu'on vient lire. */}
        {s.key === PRESUB_CHECKLIST_AFTER_STEP && (
          <ChecklistPanel productId={productId} checklist={checklist} canUpdate={canUpdate} />
        )}
      </li>
    );
  };

  return (
    <div className="space-y-5">
      {/* Où en est-on ? */}
      <div className="rounded-xl border border-border bg-secondary/30 p-3 sm:p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 text-sm">
          <span className="font-medium">Avancement</span>
          <span className="text-muted-foreground">{prog.done}/{prog.total} étapes · {prog.pct}%</span>
        </div>
        <Bar pct={prog.pct} tone={prog.pct === 100 ? "success" : "primary"} />
        {prog.current ? (
          <p className="mt-3 flex items-start gap-1.5 text-sm">
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span><span className="font-medium">Prochaine étape :</span> {prog.current.n}. {prog.current.label} <span className="text-muted-foreground">— {prog.current.responsible}</span></span>
          </p>
        ) : (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-success"><Check className="h-4 w-4" /> Processus terminé.</p>
        )}
      </div>

      {REG_PHASES.map((phase) => {
        const steps = REG_STEPS.filter((s) => s.phase === phase.key);
        const phaseDone = steps.filter((s) => regStepStatus(state, s.key) === "DONE").length;
        // La frise des allers-retours s'insère APRÈS l'évaluation — le cycle des réserves
        // n'a plus de cases : il se raconte là, tour par tour, avec ses pièces.
        const exchangeIdx = steps.findIndex((s) => s.key === ANPP_EXCHANGE_AFTER_STEP);

        return (
          <section key={phase.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{phase.label}</h3>
              <span className="text-xs text-muted-foreground">{phaseDone}/{steps.length}</span>
            </div>
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <React.Fragment key={s.key}>
                  {renderStep(s, i === steps.length - 1 && i !== exchangeIdx)}
                  {i === exchangeIdx && (
                    <li className="relative pl-10">
                      {i < steps.length - 1 && <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-border" />}
                      <span className="absolute left-0 top-0.5">
                        <span className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-warning bg-warning/10 text-warning">
                          <Repeat className="h-3.5 w-3.5" />
                        </span>
                      </span>
                      <AnppExchanges
                        productId={productId}
                        reference={reference}
                        canUpdate={canUpdate}
                        canUpload={canUpload}
                        canDelete={canDelete}
                        path={path}
                        dossierSteps={dossierSteps}
                      />
                    </li>
                  )}
                </React.Fragment>
              ))}
            </ol>
          </section>
        );
      })}

      {/* La demande de BV, ouverte depuis l'étape qui la porte. */}
      {bvStep && (
        <BvRequestSheet
          productId={productId}
          stepKey={bvStep}
          bvType={BV_REQUEST_STEPS[bvStep] ?? "BV"}
          onClose={() => setBvStep(null)}
        />
      )}
    </div>
  );
}

const fmtJour = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : null);

/**
 * LE BV DANS SON ÉTAPE — « Demande du BV 25 % » se clique, puis dit où en est le bon.
 *
 * Demandé (au centre de paiement) → Autorisé (chez les Finances) → Payé (la quittance, déposée par les
 * Finances, s'ouvre d'ici) ; ou Refusé, avec le motif écrit par le centre (« Non prioritaire »…), et
 * le geste pour redemander. L'état est lu sur l'ordre de dépense, jamais saisi à part.
 */
function BvEtape({
  suivi, bvType, peutDemander, onDemander,
}: { suivi: SuiviBvVue | null; bvType: string; peutDemander: boolean; onDemander: () => void }) {
  const e = suivi ? ETAT_BV[suivi.etat] : null;
  return (
    <div className="mt-2 space-y-2">
      {suivi && e && (
        <div className={cn(
          "rounded-md border px-2.5 py-2 text-xs",
          suivi.etat === "REFUSE" ? "border-destructive/30 bg-destructive/5"
            : suivi.etat === "PAYE" ? "border-success/30 bg-success/5" : "border-border bg-secondary/30",
        )}>
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone={e.tone} dot={false}>{e.label}</Badge>
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {e.detail} · <span className="font-mono">{suivi.reference}</span> · {suivi.montant.toLocaleString("fr-FR")} DZD
            </span>
          </p>
          <p className="mt-1 text-muted-foreground">
            Demandé le {fmtJour(suivi.demandeLe)}
            {suivi.decideLe && (suivi.etat === "AUTORISE" || suivi.etat === "REFUSE") && <> · {suivi.etat === "REFUSE" ? "refusé" : "autorisé"} le {fmtJour(suivi.decideLe)}</>}
            {suivi.payeLe && <> · payé le {fmtJour(suivi.payeLe)}</>}
          </p>
          {suivi.etat === "REFUSE" && (
            <p className="mt-1 whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">
              <span className="font-medium">Motif : </span>{suivi.motifRefus ?? "non précisé"}
            </p>
          )}
          {suivi.quittance && (
            <a href={`/api/documents/${suivi.quittance.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary hover:underline">
              <Paperclip className="h-3 w-3" /> Quittance : {suivi.quittance.name}
            </a>
          )}
        </div>
      )}
      {peutDemander && (
        <button
          type="button" onClick={onDemander}
          className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-left text-sm font-medium text-primary hover:bg-primary/10"
        >
          <span className="inline-flex items-center gap-2">
            <ReceiptText className="h-4 w-4 shrink-0" />
            {suivi?.etat === "REFUSE" ? `Redemander le ${bvType}` : `Demander le ${bvType}`}
          </span>
          <span className="text-xs font-normal text-muted-foreground">pièce jointe et commentaire facultatifs →</span>
        </button>
      )}
    </div>
  );
}

/**
 * LES ALLERS-RETOURS AVEC L'ANPP — la seule trace du cycle des réserves.
 *
 * Les anciennes cases-jalons (réception, analyse, transmission, réponses, vérification) ont été
 * retirées : cocher « Réception des réserves » une fois ne disait pas qu'il y a eu trois
 * lettres. La frise du dossier porte les tours réels — « Réserves ANPP 1 », réponses, versions
 * redéposées — chacun daté, avec ses pièces. L'étape officielle qui suit est le dépôt des
 * réponses.
 */
function AnppExchanges({
  productId, reference, canUpdate, canUpload, canDelete, path, dossierSteps,
}: {
  productId: string;
  reference: string;
  canUpdate: boolean;
  canUpload: boolean;
  canDelete: boolean;
  path: string;
  dossierSteps: TimelineStepView[];
}) {
  const [open, setOpen] = React.useState(true);
  const cycles = dossierSteps.filter((s) => s.kind === "ANPP_RESERVES").length;

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/[0.04]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left">
        <div className="min-w-0">
          <p className="text-sm font-medium">Réserves &amp; réponses (ANPP) — les allers-retours</p>
          <p className="text-xs text-muted-foreground">
            dossier {reference}
            {cycles > 0 ? ` · ${cycles} cycle${cycles > 1 ? "s" : ""} de réserves reçu${cycles > 1 ? "s" : ""}` : " · aucun cycle enregistré"}
          </p>
        </div>
        <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-warning/30 px-3 py-3">
          <DossierTimeline
            productId={productId}
            steps={dossierSteps}
            canUpdate={canUpdate}
            canUpload={canUpload}
            canDelete={canDelete}
            path={path}
          />
        </div>
      )}
    </div>
  );
}

/** Éditeur de commentaire d'une étape (note). Lecture seule si pas de droit d'édition. */
function StepNote({ productId, stepKey, initial, canUpdate, path }: { productId: string; stepKey: string; initial: string; canUpdate: boolean; path: string }) {
  const router = useRouter();
  const [value, setValue] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const dirty = value.trim() !== initial.trim();

  React.useEffect(() => { setValue(initial); }, [initial]);

  async function save() {
    setSaving(true); setSaved(false);
    const fd = new FormData();
    fd.set("productId", productId); fd.set("stepKey", stepKey); fd.set("note", value);
    await setRegulatoryStepNote(fd);
    setSaving(false); setSaved(true);
    router.refresh();
    setTimeout(() => setSaved(false), 1500);
  }

  if (!canUpdate) {
    return initial ? (
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Commentaire</p>
        <p className="whitespace-pre-wrap rounded-lg bg-secondary/50 px-3 py-2 text-sm">{initial}</p>
      </div>
    ) : null;
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">Commentaire de l&apos;étape</p>
      <Textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="Note interne sur cette étape…" className="min-h-[60px] text-sm" />
      <div className="mt-1.5 flex justify-end">
        <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer la note"}
        </Button>
      </div>
    </div>
  );
}

/**
 * LA CHECK-LIST DE PRÉSOUMISSION, DANS LE PROCESSUS.
 *
 * Elle vivait dans une carte à part, sous le processus : on cochait le CTD d'un côté et l'on
 * remplissait le Module 1 de l'autre, sans que rien ne dise que le second conditionne le
 * premier. Elle est désormais accrochée à l'étape « Réception du CTD complet », et PLIÉE :
 * on l'ouvre quand on la remplit, elle ne coupe pas la lecture du parcours le reste du temps.
 */
function ChecklistPanel({ productId, checklist, canUpdate }: { productId: string; checklist: RegChecklistState | null; canUpdate: boolean }) {
  const router = useRouter();
  const [state, setState] = React.useState<RegChecklistState>(checklist ?? {});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const prog = regChecklistProgress(state);

  React.useEffect(() => { setState(checklist ?? {}); }, [checklist]);

  async function toggle(key: string, checked: boolean) {
    setBusy(key);
    setState((prev) => ({ ...prev, [key]: { ...prev[key], checked } }));
    const fd = new FormData();
    fd.set("productId", productId); fd.set("itemKey", key); fd.set("checked", checked ? "true" : "false");
    await setRegulatoryChecklistItem(fd);
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-secondary/20">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Check-list de présoumission — Module 1</span>
            <span className="block text-xs text-muted-foreground">{prog.checked}/{prog.total} documents · {prog.pct}%</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="hidden w-28 sm:block"><Bar pct={prog.pct} tone={prog.pct === 100 ? "success" : "primary"} /></span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-3 py-3">
          {REG_CHECKLIST.map((group) => {
            const groupChecked = group.items.filter((i) => state[i.key]?.checked).length;
            return (
              <div key={group.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h4>
                  <span className="text-xs text-muted-foreground">{groupChecked}/{group.items.length}</span>
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const checked = state[item.key]?.checked ?? false;
                    return (
                      <label key={item.key} className={cn("flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-secondary/50 sm:py-1.5", canUpdate ? "cursor-pointer" : "cursor-default")}>
                        <input
                          type="checkbox" checked={checked}
                          onChange={(e) => toggle(item.key, e.target.checked)}
                          disabled={!canUpdate || busy === item.key}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-success"
                        />
                        <span className="text-sm">
                          <span className={checked ? "text-muted-foreground line-through" : ""}>{item.label}</span>
                          {item.hint && <span className="block text-[0.6875rem] text-muted-foreground">{item.hint}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
