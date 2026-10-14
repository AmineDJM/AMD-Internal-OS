"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Upload, Trash2, ShieldCheck, AlertCircle, FileText, BadgeCheck, Lock, HandCoins, PackageCheck, Plus, BellRing, XCircle, CheckCircle2 } from "lucide-react";
import {
  requestDocument, cancelDocRequest, fulfillDocRequest, validateDeclaration, validateDeclarationByDirection, refuseDeclarationByDirection, recordAuthorityDeclaration,
  relancerPieceInfoMed,
  requestDeclareDecision, addMedicalInfoSlip, removeMedicalInfoSlip, requestSlipsValidation,
  requestSlipPayment, deliverMedicalInfoSlip, skipMedicalInfoBv, createMedicalInfoItem, changerProduitDeclaration,
} from "@/lib/actions/medical-info-actions";
import {
  declareMessage, declareStage, declareStageLabel, DECLARE_INTENT_LABEL, type DeclareInput,
} from "@/lib/medical-info/declare-decision";
import {
  slipStage, slipsMessage, SLIP_STAGE_LABEL, SLIPS_LOT_LABEL,
  type SlipsLotStage, type SlipsSummary, type SlipInput,
} from "@/lib/medical-info/slips";
import { OPENABLE_DECLARATION_KINDS, DECLARATION_KIND_LABEL, DECLARATION_KIND_HINT } from "@/lib/medical-info/circuits";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { ROLE_LABELS } from "@/lib/labels";
import type { ActionResult } from "@/lib/actions/types";
import { useAction } from "@/components/shared/use-action";
import { InfoBulle } from "@/components/ui/info-bulle";

interface UserOpt { id: string; name: string; role: string }

const Err = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /> {msg}</div> : null;

/** LA CONFIRMATION DE L'ACTION — où est partie la demande (le Directeur des Opérations, ou le Super Admin à défaut). */
const Ok = ({ msg }: { msg: string | null }) =>
  msg ? <div role="status" className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 className="h-4 w-4 shrink-0" /> {msg}</div> : null;


// ───────────── Pharmacien : demander une pièce ─────────────

export function RequestDocForm({ declarationId, users }: { declarationId: string; users: UserOpt[] }) {
  const { saving, err, run } = useAction();
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={(fd) => { fd.set("declarationId", declarationId); run(() => requestDocument(fd), () => formRef.current?.reset()); }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label>Pièce demandée</Label>
        <Input name="label" required placeholder="Ex. convention signée, programme, facture pro forma…" />
      </div>
      <div className="space-y-1">
        <Label>Demandée à</Label>
        <Select name="targetUserId" required defaultValue="">
          <option value="" disabled>Sélectionner une personne…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name} — {ROLE_LABELS[u.role] ?? u.role}</option>)}
        </Select>
      </div>
      <Err msg={err} />
      <Button type="submit" disabled={saving} size="sm">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander la pièce</Button>
    </form>
  );
}

export function CancelRequestButton({ id }: { id: string }) {
  const { saving, run } = useAction();
  return (
    <button
      type="button"
      onClick={() => { const fd = new FormData(); fd.set("id", id); run(() => cancelDocRequest(fd)); }}
      disabled={saving}
      className="-m-1 inline-flex items-center gap-1 rounded p-2 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50 sm:m-0 sm:p-0"
      title="Annuler la demande" aria-label="Annuler la demande"
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </button>
  );
}

/** « Demander une pièce » — le geste secondaire : un bouton, le formulaire à la demande. */
export function DemanderPieceBouton({ declarationId, users }: { declarationId: string; users: UserOpt[] }) {
  const [open, setOpen] = React.useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileText className="h-4 w-4" /> Demander une pièce
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
      <RequestDocForm declarationId={declarationId} users={users} />
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Fermer</Button>
    </div>
  );
}

/**
 * RELANCER UNE PIÈCE ATTENDUE — une notification à la personne sollicitée. Le serveur tient le
 * délai (quatre heures) ; l'écran le dit d'avance quand il le connaît, plutôt qu'un bouton qui échoue.
 */
export function RelancerPieceButton({ id, refus }: { id: string; refus: string | null }) {
  const { saving, err, run } = useAction();
  const [fait, setFait] = React.useState(false);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm" variant="outline" disabled={saving || Boolean(refus) || fait} title={refus ?? undefined}
        onClick={() => { const fd = new FormData(); fd.set("id", id); void run(() => relancerPieceInfoMed(fd), () => setFait(true)); }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />} {fait ? "Relancé" : "Relancer"}
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}

// ───────────── Personne sollicitée : déposer la pièce ─────────────

export function FulfillForm({ requestId }: { requestId: string }) {
  const { saving, err, run } = useAction();
  return (
    <form
      action={(fd) => { fd.set("requestId", requestId); run(() => fulfillDocRequest(undefined, fd)); }}
      className="mt-2 space-y-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3"
    >
      <p className="text-xs font-medium text-primary">Cette pièce vous est demandée — déposez-la ici.</p>
      <Input name="file" type="file" required className="text-sm" />
      <Input name="note" placeholder="Note (optionnel)" className="text-sm" />
      <Err msg={err} />
      <Button type="submit" disabled={saving} size="sm">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer</Button>
    </form>
  );
}

// ───────────── Le BON DE VERSEMENT — l'étape qui précède la déclaration ─────────────

/**
 * LA CARTE DU BON DE VERSEMENT — un seul état à la fois, et le geste de CELUI QUI REGARDE.
 *
 * Trois personnes passent ici et n'y font pas la même chose : le PRIM demande (ou déclare qu'il
 * n'y a rien à verser), le centre de paiement tranche ailleurs, les Finances remettent le bon.
 * L'écran montre donc l'état à tous, et le bouton à un seul — un bouton qu'on ne peut pas
 * actionner apprend seulement qu'on n'a pas le droit.
 */
/**
 * CIRCUIT ÉVÉNEMENT — « faut-il déclarer ? », et rien d'autre.
 *
 * Une prise en charge, un sponsoring, un événement n'appellent AUCUN versement. C'était le
 * défaut : chacun sortait par la porte « ce dossier n'appelle aucun versement », motif à l'appui.
 * Un contournement obligatoire n'est plus une porte de sortie, c'est le chemin normal mal nommé.
 */
export function DeclareDecisionCard({
  id, state, authorityRef, canRequest, validationHref,
}: {
  id: string;
  state: DeclareInput;
  authorityRef: string | null;
  canRequest: boolean;
  validationHref: string | null;
}) {
  const { saving, err, run } = useAction();
  const [info, setInfo] = React.useState<string | null>(null);
  const etape = declareStage(state);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">{declareStageLabel(etape)}</span>
        {state.intent && (
          <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {DECLARE_INTENT_LABEL[state.intent === "SKIP" ? "SKIP" : "DECLARE"]}
          </span>
        )}
        <InfoBulle label="Ce que cette décision ouvre" align="left">{declareMessage(state, { authorityRef })}</InfoBulle>
      </div>
      {validationHref && (
        <a href={validationHref} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <FileText className="h-3.5 w-3.5" /> Ouvrir la demande de validation
        </a>
      )}
      <Ok msg={info} />

      {canRequest && (
        <form
          action={(fd) => { fd.set("id", id); setInfo(null); run(async () => { const r = await requestDeclareDecision(undefined, fd); if (r.ok) setInfo(r.message ?? null); return r; }); }}
          className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3"
        >
          <div className="space-y-1">
            <Label>Ce que vous comptez faire</Label>
            <Select name="intent" defaultValue="DECLARE">
              <option value="DECLARE">{DECLARE_INTENT_LABEL.DECLARE}</option>
              <option value="SKIP">{DECLARE_INTENT_LABEL.SKIP}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Motif / note</Label>
            <Textarea name="note" className="min-h-[60px]" placeholder="Ce que lira le Directeur des Opérations — exigé si le dossier ne se déclare pas." />
          </div>
          <Err msg={err} />
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Faire valider par le Directeur des Opérations
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * CIRCUIT MATÉRIEL PROMOTIONNEL — un bon de versement par matériel.
 *
 * On sépare le dossier en matériels, on fait valider le dépôt des bons EN UNE FOIS, puis on
 * demande le paiement de chaque quittance SÉPARÉMENT. Il n'y avait qu'un bon par dossier : on
 * additionnait les montants, et ce qui n'entrait pas dans la case se réglait hors ERP.
 */
export interface SlipView extends SlipInput {
  id: string;
  label: string;
  amount: number | null;
  note: string | null;
  deliveredAtIso: string | null;
}

export function SlipsCard({
  id, lot, slips, summary, canEdit, canValidate, canManage, canDeliver, canSkip, skipReason, validationHref,
}: {
  id: string;
  lot: SlipsLotStage;
  slips: SlipView[];
  summary: SlipsSummary;
  canEdit: boolean;
  canValidate: boolean;
  /** Le pharmacien : c'est lui qui demande les paiements. */
  canManage: boolean;
  /** Les Finances : elles remettent les quittances réglées. */
  canDeliver: boolean;
  canSkip: boolean;
  skipReason: string | null;
  validationHref: string | null;
}) {
  const { saving, err, run } = useAction();
  const [pane, setPane] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  if (skipReason) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <span>Ce dossier a été déclaré <strong>sans versement</strong> — {skipReason}</span>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <HandCoins className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">{SLIPS_LOT_LABEL[lot]}</span>
        {summary.count > 0 && (
          <span className="text-xs text-muted-foreground">
            {summary.count} matériel(s) · {formatCurrency(summary.announced)} annoncés · {summary.delivered}/{summary.count} remis
          </span>
        )}
        <InfoBulle label="Où en sont les bons" align="left">{slipsMessage(lot, summary)}</InfoBulle>
      </div>
      {validationHref && (
        <a href={validationHref} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <FileText className="h-3.5 w-3.5" /> Ouvrir la demande de validation
        </a>
      )}

      {/* LES BONS EN UN TABLEAU — un bon par matériel : montant, état, reçu. Les gestes d'une
          ligne s'ouvrent sous elle, sans quitter le tableau. */}
      {slips.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-semibold">Matériel</th>
                <th className="px-3 py-2 text-right font-semibold">Montant</th>
                <th className="px-3 py-2 text-left font-semibold">État</th>
                <th className="px-3 py-2 text-left font-semibold">Reçu</th>
                <th className="px-1 py-2" aria-label="Actions" />
              </tr>
            </thead>
          {slips.map((sl) => {
            const etape = slipStage(sl);
            const peutPayer = canManage && lot === "QUITTANCE_A_DEMANDER" && (etape === "A_DEMANDER" || etape === "REFUSE");
            const peutRemettre = canDeliver && etape === "PAYE";
            return (
              <tbody key={sl.id} className="border-t border-border">
                <tr>
                  <td className="sticky left-0 z-10 max-w-[12rem] bg-card px-3 py-2 sm:max-w-none">
                    <span className="block truncate font-medium">{sl.label}</span>
                    {sl.note && <span className="block truncate text-xs text-muted-foreground">{sl.note}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{sl.amount != null ? formatCurrency(sl.amount) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={etape === "REMIS" ? "text-success" : etape === "REFUSE" || etape === "RENVOYE" ? "text-destructive" : "text-muted-foreground"}>
                      {SLIP_STAGE_LABEL[etape]}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{sl.deliveredAtIso ? formatDate(sl.deliveredAtIso) : "—"}</td>
                  <td className="px-1 py-2 text-right">
                    {canEdit && !sl.requestId && (
                      <button
                        type="button" title="Retirer ce matériel" aria-label="Retirer ce matériel" disabled={saving}
                        onClick={() => { const fd = new FormData(); fd.set("slipId", sl.id); run(() => removeMedicalInfoSlip(fd)); }}
                        className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
                {(peutPayer || peutRemettre) && (
                <tr>
                <td colSpan={5} className="px-3 pb-3">
                {/* DEMANDER LE PAIEMENT DE CE BON — son montant RÉEL, qui n'est pas toujours celui annoncé. */}
                {peutPayer && (
                  pane === `pay:${sl.id}` ? (
                    <form
                      action={(fd) => { fd.set("slipId", sl.id); run(() => requestSlipPayment(undefined, fd)); }}
                      className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2"
                    >
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label>Montant réel (DZD)</Label>
                          <Input name="amount" inputMode="decimal" required defaultValue={sl.amount ?? ""} className="h-9 text-right tabular-nums" />
                        </div>
                        <div className="space-y-1">
                          <Label>Bénéficiaire</Label>
                          <Input name="payee" defaultValue="Autorités sanitaires" className="h-9" />
                        </div>
                        <div className="space-y-1">
                          <Label>Échéance souhaitée</Label>
                          <Input name="dueDate" type="date" className="h-9" />
                        </div>
                      </div>
                      <Textarea name="note" className="min-h-[48px]" placeholder="Précisions pour le centre de paiement (facultatif)" />
                      <label className="block text-xs text-muted-foreground">
                        Pièces (quittance, avis de versement…)
                        <input type="file" name="files" multiple className="mt-1 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
                      </label>
                      <Err msg={err} />
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={saving}>
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Demander le paiement
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setPane(null)}>Annuler</Button>
                      </div>
                    </form>
                  ) : (
                    <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1.5 text-left sm:min-h-8" onClick={() => setPane(`pay:${sl.id}`)}>
                      <HandCoins className="h-4 w-4" /> Demander le paiement de cette quittance
                    </Button>
                  )
                )}

                {/* LES FINANCES REMETTENT — un geste, pas un état déduit du règlement. */}
                {peutRemettre && (
                  <form
                    action={(fd) => { fd.set("slipId", sl.id); run(() => deliverMedicalInfoSlip(fd)); }}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <div className="min-w-[12rem] flex-1 space-y-1">
                      <Label>Note de remise (facultatif)</Label>
                      <Input name="note" className="h-9" placeholder="Remis en main propre le…" />
                    </div>
                    <Button type="submit" size="sm" disabled={saving} className="w-full sm:w-auto">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />} Quittance remise au PRIM
                    </Button>
                  </form>
                )}
                </td>
                </tr>
                )}
              </tbody>
            );
          })}
          </table>
        </div>
      )}

      {/* SÉPARER LE DOSSIER EN MATÉRIELS — tant que le dépôt n'est pas signé. */}
      {canEdit && (
        <form
          action={(fd) => { fd.set("declarationId", id); run(() => addMedicalInfoSlip(undefined, fd)); }}
          className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:grid-cols-[2fr,1fr,auto]"
        >
          <div className="space-y-1">
            <Label>Matériel</Label>
            <Input name="label" required placeholder="Présentoir comptoir, affiches A2…" className="h-9" />
          </div>
          <div className="space-y-1">
            <Label>Montant annoncé (DZD)</Label>
            <Input name="amount" inputMode="decimal" placeholder="0" className="h-9 text-right tabular-nums" />
          </div>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="outline" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Ajouter
            </Button>
          </div>
        </form>
      )}

      <Err msg={err} />
      <Ok msg={info} />

      <div className="flex flex-wrap gap-2">
        {canValidate && (
          <form action={(fd) => { fd.set("id", id); setInfo(null); run(async () => { const r = await requestSlipsValidation(undefined, fd); if (r.ok) setInfo(r.message ?? null); return r; }); }} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] space-y-1">
              <Label>Note pour le Directeur des Opérations</Label>
              <Input name="note" className="h-9" placeholder="Facultatif" />
            </div>
            <Button type="submit" size="sm" disabled={saving || slips.length === 0}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Faire valider le dépôt des bons
            </Button>
          </form>
        )}
        {canSkip && (
          pane === "skip" ? (
            <form
              action={(fd) => { fd.set("id", id); run(() => skipMedicalInfoBv(fd)); }}
              className="w-full space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
            >
              <Label>Pourquoi ce dossier n&apos;appelle aucun versement</Label>
              <Textarea name="reason" required className="min-h-[60px]" placeholder="C'est ce que lira l'audit." />
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant="outline" disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Déclarer sans versement
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setPane(null)}>Annuler</Button>
              </div>
            </form>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setPane("skip")}>
              <Lock className="h-4 w-4" /> Ce dossier n&apos;appelle aucun versement
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** Le dépôt aux autorités, FERMÉ tant que le circuit du dossier ne l'a pas ouvert. */
export function AuthorityLocked({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/**
 * LE PHARMACIEN OUVRE LUI-MÊME UN DOSSIER.
 *
 * Une obligation réglementaire se découvre aussi de son côté : un support à faire viser, une
 * déclaration au ministère qu'aucun événement n'a déclenchée, un versement à faire. Il n'avait
 * pour cela aucun geste — le module ne se remplissait que par la validation d'un autre — et ce
 * qui n'entre pas dans l'ERP se traite dans un carnet.
 */
export function CreateDeclarationButton() {
  const router = useRouter();
  const { saving, err, run } = useAction();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<string>("MIP");

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Nouvelle déclaration
      </Button>
    );
  }
  return (
    <form
      action={(fd) => {
        void run(async () => {
          const r = await createMedicalInfoItem(undefined, fd);
          if (r.ok && r.id) { setOpen(false); router.push(`/information-medicale/${r.id}`); }
          return r;
        });
      }}
      className="w-full space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
    >
      <p className="text-sm font-medium">Ouvrir un dossier d&apos;information médicale</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Objet</Label>
          <Input name="label" required placeholder="Ce qu'il y a à déclarer, viser ou verser" className="h-9" />
        </div>
        <div className="space-y-1">
          <Label>Nature</Label>
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {/* DEUX NATURES. « Bon de versement » n'est pas un dossier qu'on ouvre : c'est une
                ÉTAPE du circuit du matériel, à l'intérieur du dossier. Le proposer ici faisait
                choisir entre un dossier et l'une de ses pièces. */}
            {OPENABLE_DECLARATION_KINDS.map((k) => <option key={k} value={k}>{DECLARATION_KIND_LABEL[k]}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Bénéficiaire (facultatif)</Label>
          <Input name="beneficiary" className="h-9" />
        </div>
        <div className="space-y-1">
          <Label>Montant (facultatif, DZD)</Label>
          <Input name="amount" inputMode="decimal" className="h-9 text-right tabular-nums" />
        </div>
      </div>
      {/* LA NATURE DÉCIDE DU CIRCUIT, et on le dit AVANT de créer : le découvrir après coup
          obligerait à supprimer le dossier pour en rouvrir un autre. */}
      <p className="text-xs text-muted-foreground">
        {DECLARATION_KIND_HINT[kind as keyof typeof DECLARATION_KIND_HINT] ?? ""}
      </p>
      <Err msg={err} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Ouvrir
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
      </div>
    </form>
  );
}

// ───────────── Pharmacien : le produit de la déclaration ─────────────

/** Le produit de la déclaration, à choisir parmi nos produits — repris de la source à la création, corrigeable ici. */
export function ProduitDeclarationForm({ id, productId, produits }: { id: string; productId: string | null; produits: { id: string; nom: string }[] }) {
  const { saving, err, run } = useAction();
  const [valeur, setValeur] = React.useState(productId ?? "");
  return (
    <form
      action={(fd) => { fd.set("id", id); void run(() => changerProduitDeclaration(fd)); }}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <Select name="productId" aria-label="Produit de la déclaration" value={valeur} onChange={(e) => setValeur(e.target.value)} className="h-9 w-56 max-w-full">
        <option value="">— Non précisé —</option>
        {produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
      </Select>
      <Button type="submit" size="sm" variant="outline" disabled={saving || valeur === (productId ?? "")}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer
      </Button>
      <Err msg={err} />
    </form>
  );
}

// ───────────── Pharmacien : déclaration aux autorités ─────────────

export function AuthorityForm({ id, authorityRef, authorityNotes }: { id: string; authorityRef: string | null; authorityNotes: string | null }) {
  const { saving, err, run } = useAction();
  return (
    <form action={(fd) => { fd.set("id", id); run(() => recordAuthorityDeclaration(fd)); }} className="space-y-3">
      <div className="space-y-1">
        <Label>Référence / récépissé de déclaration</Label>
        <Input name="authorityRef" defaultValue={authorityRef ?? ""} placeholder="N° de déclaration aux autorités" />
      </div>
      <div className="space-y-1">
        <Label>Notes de déclaration</Label>
        <Textarea name="authorityNotes" defaultValue={authorityNotes ?? ""} className="min-h-[60px]" placeholder="Autorité destinataire, date, observations…" />
      </div>
      <Err msg={err} />
      <Button type="submit" disabled={saving} size="sm" variant="outline">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Enregistrer la déclaration</Button>
    </form>
  );
}

// ───────────── Pharmacien : validation → transmission au Directeur des Opérations ─────────────

export function ValidateButton({ id, hasPending }: { id: string; hasPending: boolean; amount?: number | null }) {
  const { saving, err, run } = useAction();
  const [confirm, setConfirm] = React.useState(false);
  return (
    <div className="space-y-2">
      {hasPending && <p className="text-xs text-warning">Des pièces sont encore attendues — vous pouvez tout de même valider.</p>}
      <Err msg={err} />
      {!confirm ? (
        <div className="flex items-center gap-1">
          <Button onClick={() => setConfirm(true)} disabled={saving} className="h-auto min-h-10 w-full whitespace-normal py-2 sm:w-auto"><BadgeCheck className="h-4 w-4 shrink-0" /> Valider et transmettre au Directeur des Opérations</Button>
          <InfoBulle label="Ce que fait la validation" align="left">Votre validation transmet la déclaration au Directeur des Opérations (à défaut, au Super Admin), qui la valide pour le comptable — ou la refuse avec son motif, et elle vous revient.</InfoBulle>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { const fd = new FormData(); fd.set("id", id); run(() => validateDeclaration(fd)); }} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Confirmer
          </Button>
          <Button variant="ghost" onClick={() => setConfirm(false)} disabled={saving}>Annuler</Button>
        </div>
      )}
    </div>
  );
}

// ───────────── Directeur des Opérations : validation finale → ordre de dépense (comptable), ou refus motivé ─────────────

export function DirectionValidateButton({ id, amount }: { id: string; amount: number | null }) {
  const { saving, err, run } = useAction();
  const [confirm, setConfirm] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [refus, setRefus] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {amount && amount > 0
          ? `Votre validation déclenche l'ordre de dépense (${amount.toLocaleString("fr-FR")} DZD) vers le comptable.`
          : "Aucun budget associé : la validation clôt simplement la déclaration."}
      </p>
      <div className="space-y-1">
        <Label>Commentaire (facultatif)</Label>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-[56px]" placeholder="Observation à destination du comptable / des parties prenantes…" />
      </div>
      <Err msg={err} />
      {refus ? (
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <Label>Motif du refus</Label>
          <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[56px]" placeholder="Ce que lira le pharmacien pour reprendre le dossier (exigé)." />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              onClick={() => { const fd = new FormData(); fd.set("id", id); if (motif.trim()) fd.set("reason", motif); run(() => refuseDeclarationByDirection(fd)); }}
              disabled={saving || !motif.trim()}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Refuser et renvoyer au pharmacien
            </Button>
            <Button variant="ghost" onClick={() => setRefus(false)} disabled={saving}>Annuler</Button>
          </div>
        </div>
      ) : !confirm ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setConfirm(true)} disabled={saving} className="w-full sm:w-auto"><BadgeCheck className="h-4 w-4" /> Valider pour le comptable</Button>
          <Button variant="outline" onClick={() => setRefus(true)} disabled={saving} className="w-full sm:w-auto"><XCircle className="h-4 w-4" /> Refuser</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { const fd = new FormData(); fd.set("id", id); if (comment.trim()) fd.set("comment", comment); run(() => validateDeclarationByDirection(fd)); }} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Confirmer la validation
          </Button>
          <Button variant="ghost" onClick={() => setConfirm(false)} disabled={saving}>Annuler</Button>
        </div>
      )}
    </div>
  );
}

export const DocIcon = FileText;
