"use client";

import * as React from "react";
import {
  Loader2, Check, X, AlertCircle, Send, MessageSquarePlus, DoorOpen,
  Star, StarOff, CalendarCheck, UserCheck, UserX, IdCard, Undo2, CornerUpLeft, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import {
  decideRecruitmentStep, cancelRecruitmentRequest, askRecruitmentInfo, answerRecruitmentInfo,
  openRecruitmentSourcing, closeRecruitmentRequest, addRecruitmentCandidate,
  moveRecruitmentCandidate, onboardRecruitment,
  renvoyerDemandeRecrutement, resoumettreDemandeRecrutement, rouvrirDemandeRecrutement, annulerEmbaucheRecrutement,
  commenterDemandeRecrutement,
} from "@/lib/actions/recruitment-actions";
import { RECRUITMENT_CONTRACTS, CONTRACT_LABEL } from "@/lib/recruitment/request-flow";
import { useKeyedAction as useAction } from "@/components/shared/use-action";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";

/**
 * LES GESTES DU CIRCUIT DE RECRUTEMENT.
 *
 * Chaque bouton correspond à UNE capacité calculée par `abilities()` côté serveur et repassée
 * ici : l'écran ne décide de rien, il montre ce qui est permis. Un bouton visible correspond donc
 * toujours à une action qui aboutira — et le serveur revérifie de toute façon.
 */

/** Enveloppe commune : l'attente, l'erreur, et le rafraîchissement après succès. */

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" /> {error}
    </p>
  );
}

const fd = (entries: Record<string, string | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) if (v) f.set(k, v);
  return f;
};

// ───────────────────────────── Validation hiérarchique ─────────────────────────────

export interface PersonneChoisie { id: string; name: string }

/**
 * LA DÉCISION DE LA CHAÎNE. Quand c'est le DG / Super Admin qui CONCLUT la chaîne (`exigeSuivi`, calculé par la
 * page avec la règle que l'action rejoue — `decisionDuSommetExigeSuivi`), il désigne le N+1 de la future recrue et
 * au moins une personne en charge du suivi (Direction, 07/10) : « Valider » reste fermé tant qu'ils manquent.
 */
export function ChainDecisionPanel({ id, stepLabel, exigeSuivi = false, utilisateurs = [], n1ParDefaut = null }: {
  id: string; stepLabel: string;
  exigeSuivi?: boolean; utilisateurs?: PersonneChoisie[]; n1ParDefaut?: string | null;
}) {
  const { busy, error, run } = useAction();
  const [reason, setReason] = React.useState("");
  const [n1, setN1] = React.useState(n1ParDefaut ?? "");
  const [suivi, setSuivi] = React.useState<string[]>([]);
  const [filtre, setFiltre] = React.useState("");
  const manque = exigeSuivi && (!n1 || suivi.length === 0);
  const plie = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const visibles = utilisateurs.filter((u) => !filtre.trim() || plie(u.name).includes(plie(filtre.trim()))).slice(0, 40);

  /** L'accord, et — quand le DG conclut — le N+1 et le suivi qu'il désigne. */
  const accord = () => {
    const f = fd({ id, decision: "APPROVED", reason });
    if (exigeSuivi) {
      f.set("futureManagerId", n1);
      for (const s of suivi) f.append("followerIds", s);
    }
    return f;
  };

  return (
    <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Votre validation est attendue</p>
          <p className="text-xs text-muted-foreground">{stepLabel}</p>
        </div>
        <InfoBulle label="Comment se décide une marche">
          Valider fait monter la demande d&apos;une marche ; la dernière l&apos;envoie aux RH. La direction peut trancher
          d&apos;en haut : les marches non consultées sont marquées comme telles. Renvoyer ou refuser exige un motif.
        </InfoBulle>
      </div>
      {exigeSuivi && (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">N+1 de la future recrue</Label>
            <select
              value={n1} onChange={(e) => setN1(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-base sm:text-sm"
            >
              <option value="">— Choisir —</option>
              {utilisateurs.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">En charge du suivi ({suivi.length})</Label>
            <Input value={filtre} onChange={(e) => setFiltre(e.target.value)} placeholder="Chercher une personne…" className="h-9 text-sm" />
            {suivi.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {suivi.map((s) => (
                  <button
                    key={s} type="button" onClick={() => setSuivi((v) => v.filter((x) => x !== s))}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs"
                  >
                    {utilisateurs.find((u) => u.id === s)?.name ?? "—"} <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            )}
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              {visibles.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-secondary/50">
                  <input
                    type="checkbox" checked={suivi.includes(u.id)}
                    onChange={(e) => setSuivi((v) => (e.target.checked ? [...v, u.id] : v.filter((x) => x !== u.id)))}
                  />
                  <span className="min-w-0 truncate">{u.name}</span>
                </label>
              ))}
              {visibles.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Personne.</p>}
            </div>
          </div>
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-xs">Motif (obligatoire pour refuser ou renvoyer)</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. Budget non prévu cette année." className="h-9 text-sm" />
      </div>
      <div className="flex flex-wrap gap-2">
        <BoutonDecisif
          size="sm" disabled={busy !== null || manque}
          title={manque ? "Désignez le N+1 de la future recrue et au moins une personne en charge du suivi." : undefined}
          onClick={() => run("ok", () => decideRecruitmentStep(accord()))}
        >
          {busy === "ok" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Valider
        </BoutonDecisif>
        {/* RENVOYER (§118.192) : un besoin mal posé se corrige — le refuser ferait recommencer toute la chaîne. */}
        <BoutonDecisif
          size="sm" variant="outline" disabled={busy !== null || !reason.trim()}
          title={reason.trim() ? undefined : "Dites ce qu'il faut corriger — c'est ce que le demandeur lira."}
          onClick={() => run("ret", () => renvoyerDemandeRecrutement(fd({ id, motif: reason })))}
        >
          {busy === "ret" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CornerUpLeft className="h-4 w-4" />} Renvoyer pour correction
        </BoutonDecisif>
        <BoutonDecisif
          size="sm" variant="outline" disabled={busy !== null || !reason.trim()}
          title={reason.trim() ? undefined : "Un refus se motive — c'est ce que le demandeur lira."}
          onClick={() => run("no", () => decideRecruitmentStep(fd({ id, decision: "REJECTED", reason })))}
        >
          {busy === "no" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
        </BoutonDecisif>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function CancelRequestButton({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <BoutonDecisif
        variant="outline" size="sm" disabled={busy !== null}
        onClick={() => {
          void run("cancel", () => cancelRecruitmentRequest(fd({ id })));
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Retirer la demande
      </BoutonDecisif>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ───────────────────────────── Les RH ─────────────────────────────

export function HrPanel({ id, canAsk, canOpen, canReject, canReturn }: {
  id: string; canAsk: boolean; canOpen: boolean; canReject: boolean; canReturn: boolean;
}) {
  const { busy, error, run } = useAction();
  const [question, setQuestion] = React.useState("");
  const [note, setNote] = React.useState("");

  return (
    <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3 sm:p-4">
      <p className="text-sm font-semibold">Instruction RH</p>

      {canAsk && (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label className="text-xs">Demander une précision au demandeur</Label>
            <InfoBulle align="left">La demande retourne au demandeur tant qu&apos;il n&apos;a pas répondu : elle quitte votre file.</InfoBulle>
          </div>
          <Textarea
            value={question} onChange={(e) => setQuestion(e.target.value)} rows={2}
            placeholder="Compétences attendues ? Fourchette tenable ? Date de début ferme ?"
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button
              size="sm" variant="outline" disabled={busy !== null || !question.trim()}
              onClick={async () => {
                if (await run("ask", () => askRecruitmentInfo(fd({ id, question })))) setQuestion("");
              }}
            >
              {busy === "ask" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
              Demander
            </Button>
          </div>
        </div>
      )}

      {(canOpen || canReject || canReturn) && (
        <div className="space-y-1 border-t border-border pt-3">
          <Label className="text-xs">Décision</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motif (ce qu'il faut corriger, raison d'un refus…)" className="h-9 text-sm" />
          <div className="flex flex-wrap gap-2 pt-1">
            {canOpen && (
              <BoutonDecisif size="sm" disabled={busy !== null} onClick={() => run("open", () => openRecruitmentSourcing(fd({ id })))}>
                {busy === "open" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DoorOpen className="h-4 w-4" />}
                Ouvrir le poste
              </BoutonDecisif>
            )}
            {canReturn && (
              <BoutonDecisif
                size="sm" variant="outline" disabled={busy !== null || !note.trim()}
                title={note.trim() ? undefined : "Dites ce qu'il faut corriger."}
                onClick={() => run("ret", () => renvoyerDemandeRecrutement(fd({ id, motif: note })))}
              >
                {busy === "ret" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CornerUpLeft className="h-4 w-4" />} Renvoyer pour correction
              </BoutonDecisif>
            )}
            {canReject && (
              <BoutonDecisif
                size="sm" variant="outline" disabled={busy !== null || !note.trim()}
                title={note.trim() ? undefined : "Un refus se motive."}
                onClick={() => run("rej", () => closeRecruitmentRequest(fd({ id, decision: "REJECTED", note })))}
              >
                {busy === "rej" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
              </BoutonDecisif>
            )}
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function AnswerInfoForm({ id, infoId }: { id: string; infoId: string }) {
  const { busy, error, run } = useAction();
  const [answer, setAnswer] = React.useState("");
  return (
    <div className="mt-2 space-y-1">
      <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="Votre réponse…" className="text-sm" />
      <div className="flex justify-end">
        <Button
          size="sm" disabled={busy !== null || !answer.trim()}
          onClick={async () => {
            if (await run("a", () => answerRecruitmentInfo(fd({ id, infoId, answer })))) setAnswer("");
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Répondre
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

// ───────────────────────────── Les candidats ─────────────────────────────

export function AddCandidateButton({ requestId }: { requestId: string }) {
  const [open, setOpen] = React.useState(false);
  const fields: FieldDef[] = [
    { type: "hidden", name: "requestId", value: requestId },
    { type: "text", name: "fullName", label: "Nom et prénom", required: true, full: true },
    { type: "text", name: "email", label: "Courriel", inputMode: "email", autoComplete: "off" },
    { type: "text", name: "phone", label: "Téléphone", inputMode: "tel", autoComplete: "off" },
    { type: "text", name: "source", label: "Origine", placeholder: "Candidature spontanée, cabinet, cooptation…" },
    { type: "textarea", name: "notes", label: "Notes", full: true },
    { type: "file", name: "attachment", label: "CV et pièces", multiple: true, full: true, hint: "Le CV reste rattaché à CETTE personne." },
  ];

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Déposer un CV</Button>
      <Sheet
        open={open} onClose={() => setOpen(false)} width="lg"
        title="Déposer un CV reçu"
        description="Le demandeur sera prévenu : c'est lui qui présélectionne."
      >
        <RecordForm
          fields={fields}
          action={addRecruitmentCandidate}
          onDone={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          submitLabel="Enregistrer le candidat"
        />
      </Sheet>
    </>
  );
}

export function CandidateActions({ candidateId, status, can }: {
  candidateId: string;
  status: string;
  can: { shortlist: boolean; select: boolean; interview: boolean; hire: boolean };
}) {
  const { busy, error, run } = useAction();
  const move = (m: string, extra: Record<string, string> = {}) =>
    run(m, () => moveRecruitmentCandidate(fd({ candidateId, move: m, ...extra })));

  const done = status === "HIRED" || status === "DECLINED";
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex flex-wrap justify-start gap-1.5 sm:justify-end">
        {can.shortlist && !done && status !== "SHORTLISTED" && status !== "SELECTED" && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move("SHORTLIST")}>
            {busy === "SHORTLIST" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
            Présélectionner
          </Button>
        )}
        {can.shortlist && status === "SHORTLISTED" && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move("UNSHORTLIST")}>
            {busy === "UNSHORTLIST" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StarOff className="h-3.5 w-3.5" />}
            Retirer
          </Button>
        )}
        {/* Le PDG retient un candidat PRÉSÉLECTIONNÉ OU NON : la présélection est un avis, pas un
            tri éliminatoire opposable au dernier décideur. */}
        {can.select && !done && (status === "RECEIVED" || status === "SHORTLISTED") && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move("SELECT")}>
            {busy === "SELECT" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
            Retenir
          </Button>
        )}
        {can.interview && !done && status !== "INTERVIEWED" && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move("INTERVIEW")}>
            {busy === "INTERVIEW" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarCheck className="h-3.5 w-3.5" />}
            Entretien passé
          </Button>
        )}
        {can.hire && !done && (
          <BoutonDecisif size="sm" disabled={busy !== null} onClick={() => move("HIRE")}>
            {busy === "HIRE" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Recruter
          </BoutonDecisif>
        )}
        {(can.shortlist || can.select || can.interview) && !done && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move("DECLINE")}>
            {busy === "DECLINE" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserX className="h-3.5 w-3.5" />}
            Écarter
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ───────────────────────────── L'intégration ─────────────────────────────

export function OnboardPanel({ id, hiredName, external, canCancelHire }: {
  id: string; hiredName: string; external: boolean; canCancelHire: boolean;
}) {
  const { busy, error, run } = useAction();
  const [motif, setMotif] = React.useState("");
  return (
    <div className="space-y-2 rounded-xl border border-success/40 bg-success/5 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">{hiredName} est recruté</p>
        <InfoBulle>
          {external
            ? "Consulting : intervenant EXTERNE. Aucune fiche employé n'est créée — il n'entre ni dans l'effectif, ni dans la paie, ni dans l'organigramme."
            : "La fiche employé est pré-remplie depuis la demande (poste, direction, contrat, dates, N+1 désigné par la direction) et depuis le candidat. Le salaire réel et le compte applicatif se complètent ensuite depuis les RH."}
        </InfoBulle>
      </div>
      <BoutonDecisif size="sm" disabled={busy !== null} onClick={() => run("on", () => onboardRecruitment(fd({ id })))}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <IdCard className="h-4 w-4" />}
        {external ? "Clôturer — consultant externe" : "Créer la fiche employé"}
      </BoutonDecisif>
      {/* ANNULER L'EMBAUCHE (§118.192) : un candidat qui se désiste avant sa fiche ne laisse plus la demande
          en intégration pour toujours. */}
      {canCancelHire && (
        <div className="space-y-1 border-t border-success/30 pt-2">
          <Label className="text-xs">Annuler l&apos;embauche (désistement, erreur…)</Label>
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif" className="h-9 text-sm" />
          <BoutonDecisif
            size="sm" variant="outline" disabled={busy !== null || !motif.trim()}
            title={motif.trim() ? undefined : "Dites pourquoi l'embauche s'annule."}
            onClick={() => run("annul", () => annulerEmbaucheRecrutement(fd({ id, motif })))}
          >
            {busy === "annul" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Annuler l&apos;embauche
          </BoutonDecisif>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function CloseRequestButton({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  const [note, setNote] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-xl border border-border p-3">
      <Label className="text-xs">Clôturer sans suite</Label>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motif (poste abandonné, gel des embauches…)" className="h-9 text-sm" />
      <BoutonDecisif
        size="sm" variant="outline" disabled={busy !== null || !note.trim()}
        onClick={() => run("close", () => closeRecruitmentRequest(fd({ id, note })))}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Clôturer
      </BoutonDecisif>
      <ErrorLine error={error} />
    </div>
  );
}

// ───────────────────────────── Corriger, rouvrir (audit 360°, R14 — §118.192) ─────────────────────────────

/** Le besoin tel qu'il est enregistré — le formulaire de correction part de LÀ, jamais d'un formulaire vide. */
export interface BesoinAffiche {
  position: string; headcount: number; contractType: string;
  salaryMin: number | null; salaryMax: number | null;
  startDate: string | null; endDate: string | null;
  missions: string | null; skills: string | null; justification: string | null;
}

/**
 * LE DEMANDEUR CORRIGE ET RENVOIE. Le formulaire est PRÉ-REMPLI : corriger ce qu'on vous demande ne doit
 * pas obliger à tout ressaisir — et un champ ressaisi est un champ qu'on peut changer sans le vouloir.
 */
export function CorrigerDemandePanel({ id, besoin }: { id: string; besoin: BesoinAffiche }) {
  const { busy, error, run } = useAction();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [changements, setChangements] = React.useState("");
  return (
    <form
      ref={formRef}
      className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        f.set("id", id);
        void run("corr", () => resoumettreDemandeRecrutement(f));
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">Corriger et renvoyer</p>
        <InfoBulle>
          Un autre poste, un autre contrat, plus de postes, une rémunération relevée ou un contrat plus long font
          repartir la validation depuis la première marche ; le reste revient là d&apos;où la demande vous a été renvoyée.
        </InfoBulle>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Intitulé du poste</Label>
          <Input name="position" defaultValue={besoin.position} className="h-9 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type de contrat</Label>
          <select name="contractType" defaultValue={besoin.contractType} className="h-9 w-full rounded-md border border-input bg-background px-2 text-base sm:text-sm">
            {RECRUITMENT_CONTRACTS.map((c) => <option key={c} value={c}>{CONTRACT_LABEL[c]}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Nombre de postes</Label>
          <Input name="headcount" type="number" inputMode="numeric" min={1} defaultValue={besoin.headcount} className="h-9 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rémunération minimale (DZD)</Label>
          <Input name="salaryMin" type="number" inputMode="decimal" step="any" min={0} defaultValue={besoin.salaryMin ?? ""} className="h-9 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rémunération maximale (DZD)</Label>
          <Input name="salaryMax" type="number" inputMode="decimal" step="any" min={0} defaultValue={besoin.salaryMax ?? ""} className="h-9 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Prise de poste</Label>
          <Input name="startDate" type="date" defaultValue={besoin.startDate ?? ""} className="h-9 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Fin de contrat</Label>
          <Input name="endDate" type="date" defaultValue={besoin.endDate ?? ""} className="h-9 text-sm" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Missions</Label>
          <Textarea name="missions" rows={2} defaultValue={besoin.missions ?? ""} className="text-sm" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Compétences attendues</Label>
          <Textarea name="skills" rows={2} defaultValue={besoin.skills ?? ""} className="text-sm" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Pourquoi ce recrutement</Label>
          <Textarea name="justification" rows={2} defaultValue={besoin.justification ?? ""} className="text-sm" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Ce qui a changé (obligatoire)</Label>
          <Textarea
            name="changements" rows={2} value={changements} onChange={(e) => setChangements(e.target.value)}
            placeholder="Ex. Fourchette ramenée à 90 000 – 110 000 DZD, intitulé précisé."
            className="text-sm"
          />
        </div>
      </div>
      <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy !== null || !changements.trim()}>
        {busy === "corr" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Corriger et renvoyer
      </Button>
      <ErrorLine error={error} />
    </form>
  );
}

/** ÉCRIRE AU FIL — qui est partie à la demande (`abilities().comment`), le suivi désigné par le DG compris. */
export function FilForm({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  const [texte, setTexte] = React.useState("");
  return (
    <div className="space-y-1.5">
      <Textarea value={texte} onChange={(e) => setTexte(e.target.value)} rows={2} placeholder="Votre message…" className="text-sm" />
      <div className="flex justify-end">
        <Button
          size="sm" variant="outline" disabled={busy !== null || !texte.trim()}
          onClick={async () => {
            if (await run("fil", () => commenterDemandeRecrutement(fd({ id, texte })))) setTexte("");
          }}
        >
          {busy === "fil" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** ROUVRIR — les RH ou le sommet, motif à l'appui ; la phrase dit où la demande repartira. */
export function RouvrirPanel({ id, destination }: { id: string; destination: string }) {
  const { busy, error, run } = useAction();
  const [motif, setMotif] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-xl border border-border p-3">
      <Label className="text-xs">Rouvrir la demande</Label>
      <p className="text-xs text-muted-foreground">{destination}</p>
      <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (erreur reconnue, besoin confirmé…)" className="h-9 text-sm" />
      <Button
        size="sm" variant="outline" disabled={busy !== null || !motif.trim()}
        title={motif.trim() ? undefined : "Dites pourquoi vous la rouvrez."}
        onClick={() => run("rouv", () => rouvrirDemandeRecrutement(fd({ id, motif })))}
      >
        {busy === "rouv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Rouvrir
      </Button>
      <ErrorLine error={error} />
    </div>
  );
}
