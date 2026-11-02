"use client";

import * as React from "react";
import { Loader2, AlertCircle, BadgeCheck, Send, Bell, XCircle } from "lucide-react";
import {
  submitQuotes, chooseAgency, submitBcForFinance, remindFinance, validateBc, confirmBcSent,
  initiatePayment, confirmPayment, submitMaterial, directionReview, confirmConformity, startBat,
  submitFinalMaterial, recordInvoice, settle, cancelPromoMaterial,
} from "@/lib/actions/promo-material-actions";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "@/lib/actions/types";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface PromoFlags {
  isMarketing: boolean;
  isAssistant: boolean;
  isFinance: boolean;
  isMedicalInfo: boolean;
  isDirection: boolean;
  /**
   * Siège au CENTRE DE VALIDATION AD & PRO — c'est lui, et non plus les Finances, qui valide le BC
   * (décision de la Direction, 09/2026, §118.148). Calculé au serveur par `siegeAuCentreAdPro`.
   */
  isCentreAdPro: boolean;
}
interface Props {
  id: string;
  status: string;
  flags: PromoFlags;
  chosenAgency: string | null;
  bcReference: string | null;
  visaReference: string | null;
  authorityRef: string | null;
  amount: number | null;
  reminderCount: number;
  /**
   * L'ORDRE DE DÉPENSE du bordereau et celui du règlement final, avec où il en est (§118.148).
   * « Paiement effectué » et la clôture se CONSTATENT sur l'ordre : sans lui à l'écran, le bouton
   * serait offert puis refusé, et la personne découvrirait la règle après le clic.
   */
  paymentOrder?: { reference: string; etat: string; regle: boolean } | null;
  settlementOrder?: { reference: string; etat: string; regle: boolean } | null;
}

/** Les libellés d'étape sont longs : au téléphone, le bouton prend la largeur et passe à la ligne au lieu de sortir de l'écran. */
const bouton = "h-auto min-h-10 w-full whitespace-normal py-2 sm:w-auto";
/** Le bouton décisif, sans `w-full` : il en déduirait une pleine largeur à toutes les tailles. */
const boutonDecisif = "h-auto min-h-10 whitespace-normal py-2";

const Err = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /> {msg}</div> : null;

function useRun() {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : les gestes restent fermés jusqu'à l'arrivée des nouvelles données.
  const { enCours, rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<ActionResult>) => {
    setSaving(true); setErr(null);
    let r: ActionResult;
    try {
      r = await fn();
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setSaving(false);
    }
    if (r.ok) rafraichir(); else setErr(r.error ?? "Le geste n'a pas abouti.");
  };
  return { saving: saving || enCours, err, run };
}

/** Carte d'action de l'étape courante, gérée par l'acteur concerné. */
export function PromoActionPanel(props: Props) {
  const { id, status, flags } = props;
  const { saving, err, run } = useRun();
  const fd = (extra?: Record<string, string>) => { const f = new FormData(); f.set("id", id); if (extra) for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };

  // ── Cartes par statut ──
  const panels: React.ReactNode[] = [];

  if (status === "PROSPECTION_REQUESTED" && flags.isAssistant) {
    panels.push(
      <Step key="quotes" title="Devis des agences" hint="Déposez les devis reçus (ci-dessus), puis confirmez.">
        <Err msg={err} />
        <Button className={bouton} onClick={() => run(() => submitQuotes(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Devis déposés</Button>
      </Step>,
    );
  }
  if (status === "QUOTES_UPLOADED" && flags.isMarketing) {
    panels.push(
      <StepForm key="choose" title="Choix de l'agence" hint="Choisissez l'agence/devis retenu, joignez si besoin une ou plusieurs pièces (devis retenu, comparatif, contrat…) et demandez la création du bon de commande."
        onSubmit={(form) => { form.set("id", id); run(() => chooseAgency(form)); }} saving={saving} err={err} submit="Valider l'agence & demander le BC">
        <Field name="chosenAgency" label="Agence retenue" required defaultValue={props.chosenAgency ?? ""} />
        <Field name="chosenAmount" label="Montant du devis (DZD)" type="number" />
        <FileField name="attachments" label="Pièces jointes (optionnel — une ou plusieurs)" />
        <Area name="comment" label="Commentaire (motif du choix)" />
      </StepForm>,
    );
  }
  if (status === "AGENCY_CHOSEN" && flags.isAssistant) {
    panels.push(
      <StepForm key="bc" title="Bon de commande" hint="Renseignez le n° et joignez le(s) bon(s) de commande (un ou plusieurs), puis transmettez-le au centre de validation Ad & Pro, qui le valide avant tout envoi à l'agence."
        onSubmit={(form) => { form.set("id", id); run(() => submitBcForFinance(form)); }} saving={saving} err={err} submit="Transmettre au centre de validation">
        <Field name="bcReference" label="N° de bon de commande" />
        <FileField name="bcFiles" label="Bon(s) de commande (fichiers)" />
      </StepForm>,
    );
  }
  if (status === "BC_FINANCE_REVIEW") {
    if (flags.isCentreAdPro) {
      panels.push(
        <Step key="vbc" title="Validation du bon de commande (centre Ad & Pro)" hint="Vérifiez le BC déposé, puis validez. Tout bon de commande né d'Ad & Pro passe par le centre de validation Ad & Pro.">
          <Err msg={err} />
          <BoutonDecisif className={boutonDecisif} onClick={() => run(() => validateBc(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Valider le bon de commande</BoutonDecisif>
        </Step>,
      );
    }
    if (flags.isAssistant || flags.isMarketing) {
      panels.push(
        <Step key="relance" title="Relancer le centre de validation" hint={`Bon de commande en attente de validation au centre de validation Ad & Pro.${props.reminderCount > 0 ? ` ${props.reminderCount} relance(s) envoyée(s).` : ""}`}>
          <Err msg={err} />
          <Button variant="outline" className={bouton} onClick={() => run(() => remindFinance(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />} Relancer le centre</Button>
        </Step>,
      );
    }
  }
  if (status === "BC_VALIDATED" && flags.isAssistant) {
    panels.push(
      <Step key="sent" title="Transmission à l'agence" hint="Le BC est validé. Confirmez sa transmission à l'agence (contact hors plateforme).">
        <Err msg={err} />
        <BoutonDecisif className={boutonDecisif} onClick={() => run(() => confirmBcSent(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} BC validé & transmis à l'agence</BoutonDecisif>
      </Step>,
    );
  }
  if (status === "BC_SENT" && flags.isMedicalInfo) {
    panels.push(
      <StepForm key="pay" title="Bordereau de paiement" hint="Initiez le bordereau de paiement : un ordre de dépense part au centre de paiement, qui l'autorise avant que les Finances ne le règlent."
        onSubmit={(form) => run(() => initiatePayment(fd({ amount: String(form.get("amount") || "") })))} saving={saving} err={err} submit="Initier le bordereau de paiement">
        <Field name="amount" label="Montant du bordereau (DZD)" type="number" required defaultValue={props.amount != null ? String(props.amount) : ""} />
      </StepForm>,
    );
  }
  if (status === "PAYMENT_INITIATED" && flags.isFinance) {
    const o = props.paymentOrder ?? null;
    panels.push(
      o?.regle ? (
        <StepForm key="cpay" title="Paiement" hint={`L'ordre ${o.reference} est réglé. Confirmez le paiement (joignez la quittance ci-dessus).`}
          onSubmit={(form) => run(() => confirmPayment(fd({ comment: String(form.get("comment") || "") })))} saving={saving} err={err} submit="Paiement effectué">
          <Area name="comment" label="Commentaire / quittance" />
        </StepForm>
      ) : (
        <Step key="cpay" title="Paiement" hint={o
          ? `L'ordre ${o.reference} est ${o.etat}. Le paiement se constate ici une fois l'ordre réglé depuis Finances › Paiements à faire.`
          : "Aucun ordre de dépense n'accompagne ce bordereau : l'information médicale doit le réinitier avec son montant."}>
          <Err msg={err} />
        </Step>
      ),
    );
  }
  if (status === "PAYMENT_INITIATED" && flags.isMedicalInfo && !props.paymentOrder) {
    // RATTRAPAGE — un bordereau initié sans montant n'avait créé aucun ordre.
    panels.push(
      <StepForm key="repay" title="Bordereau sans ordre de dépense" hint="Ce bordereau a été initié sans montant : aucun ordre n'est parti au centre de paiement. Réinitiez-le avec son montant."
        onSubmit={(form) => run(() => initiatePayment(fd({ amount: String(form.get("amount") || "") })))} saving={saving} err={err} submit="Réinitier le bordereau">
        <Field name="amount" label="Montant du bordereau (DZD)" type="number" required defaultValue={props.amount != null ? String(props.amount) : ""} />
      </StepForm>,
    );
  }
  if (status === "PAYMENT_DONE" && flags.isMarketing) {
    panels.push(
      <Step key="mat" title="Matériel réalisé" hint="Déposez le matériel réalisé par l'agence (ci-dessus), puis confirmez.">
        <Err msg={err} />
        <Button className={bouton} onClick={() => run(() => submitMaterial(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Matériel réalisé déposé</Button>
      </Step>,
    );
  }
  if (status === "MATERIAL_PRODUCED" && flags.isDirection) {
    panels.push(
      <StepForm key="dir" title="Validation Direction" hint="Examinez le matériel réalisé."
        onSubmit={(form) => run(() => directionReview(fd({ comment: String(form.get("comment") || "") })))} saving={saving} err={err} submit="Valider (Direction)">
        <Area name="comment" label="Commentaire (facultatif)" />
      </StepForm>,
    );
  }
  if (status === "CONFORMITY_REVIEW" && flags.isMedicalInfo) {
    panels.push(
      <StepForm key="conf" title="Conformité & visa publicitaire" hint="Vérifiez la conformité, déposez aux autorités puis saisissez la référence + le visa publicitaire."
        onSubmit={(form) => run(() => confirmConformity(fd({ visaReference: String(form.get("visaReference") || ""), authorityRef: String(form.get("authorityRef") || "") })))} saving={saving} err={err} submit="Conformité OK — visa obtenu">
        <Field name="authorityRef" label="Référence de dépôt aux autorités" defaultValue={props.authorityRef ?? ""} />
        <Field name="visaReference" label="Visa publicitaire" defaultValue={props.visaReference ?? ""} />
      </StepForm>,
    );
  }
  if (status === "VISA_OBTAINED" && flags.isMarketing) {
    panels.push(
      <Step key="bat" title="BAT / impression" hint="Le visa publicitaire est obtenu. Lancez le BAT / l'impression.">
        <Err msg={err} />
        <Button className={bouton} onClick={() => run(() => startBat(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Lancer le BAT / impression</Button>
      </Step>,
    );
  }
  if (status === "BAT_PRINTING" && flags.isMarketing) {
    panels.push(
      <Step key="final" title="Matériel final" hint="Déposez le matériel final imprimé (ci-dessus), puis confirmez.">
        <Err msg={err} />
        <Button className={bouton} onClick={() => run(() => submitFinalMaterial(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Matériel final déposé</Button>
      </Step>,
    );
  }
  if (status === "FINAL_MATERIAL" && (flags.isAssistant || flags.isMarketing)) {
    panels.push(
      <Step key="inv" title="Facture de l'agence" hint="Enregistrez la facture finale + le bon de livraison (ci-dessus), puis transmettez aux finances.">
        <Err msg={err} />
        <BoutonDecisif className={boutonDecisif} onClick={() => run(() => recordInvoice(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Facture reçue — transmettre aux finances</BoutonDecisif>
      </Step>,
    );
  }
  if (status === "INVOICED" && flags.isFinance) {
    const o = props.settlementOrder ?? null;
    panels.push(
      !o ? (
        <StepForm key="settle" title="Règlement" hint="Envoyez la facture de l'agence au règlement : un ordre de dépense part au centre de paiement. Le dossier se clôturera une fois l'ordre réglé."
          onSubmit={(form) => run(() => settle(fd({ amount: String(form.get("amount") || "") })))} saving={saving} err={err} submit="Envoyer au règlement">
          <Field name="amount" label="Montant à régler (DZD)" type="number" required defaultValue={props.amount != null ? String(props.amount) : ""} />
        </StepForm>
      ) : o.regle ? (
        <Step key="settle" title="Règlement" hint={`L'ordre ${o.reference} est réglé : le dossier peut être clôturé.`}>
          <Err msg={err} />
          <BoutonDecisif className={boutonDecisif} onClick={() => run(() => settle(fd()))} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Clôturer le dossier (réglé)</BoutonDecisif>
        </Step>
      ) : (
        <Step key="settle" title="Règlement" hint={`L'ordre ${o.reference} est ${o.etat}. Le dossier se clôturera une fois l'ordre réglé depuis Finances › Paiements à faire.`}>
          <Err msg={err} />
        </Step>
      ),
    );
  }

  // Annulation (sauf dossier clôturé)
  const canCancel = status !== "SETTLED" && status !== "CANCELLED" && (flags.isMarketing || flags.isAssistant || flags.isDirection);

  if (panels.length === 0 && !canCancel) return null;

  return (
    <div className="space-y-4">
      {panels}
      {canCancel && (
        <CancelButton id={id} />
      )}
    </div>
  );
}

function CancelButton({ id }: { id: string }) {
  const { saving, err, run } = useRun();
  const [confirm, setConfirm] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  return (
    <div className="space-y-2">
      <Err msg={err} />
      {!confirm ? (
        <button onClick={() => setConfirm(true)} className="inline-flex min-h-9 items-center text-xs text-muted-foreground hover:text-destructive sm:min-h-0">Annuler ce dossier</button>
      ) : (
        // Le MOTIF est exigé (audit 360°, R17/R18) : l'annulation est définitive, et le demandeur doit
        // pouvoir lire pourquoi — sans lui, il croyait à un refus.
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Annuler le dossier ?</span>
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} aria-label="Motif de l'annulation" placeholder="Pourquoi (obligatoire)" className="min-w-0 flex-1 basis-full sm:basis-0" />
          <BoutonDecisif size="sm" variant="destructive" onClick={() => { const f = new FormData(); f.set("id", id); f.set("motif", motif.trim()); run(() => cancelPromoMaterial(f)); }} disabled={saving || !motif.trim()}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Confirmer</BoutonDecisif>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={saving}>Non</Button>
        </div>
      )}
    </div>
  );
}

/** Le titre d'une étape, et son explication à la demande (ⓘ) — plus de paragraphe sous chaque titre (Direction, 07/10). */
function TitreEtape({ title, hint }: { title: string; hint: string }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-1 text-base">{title} <InfoBulle label={`À propos : ${title}`} align="left">{hint}</InfoBulle></CardTitle>
    </CardHeader>
  );
}

function Step({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <Card className="border-primary/40">
      <TitreEtape title={title} hint={hint} />
      <CardContent className="space-y-3">
        {children}
      </CardContent>
    </Card>
  );
}

function StepForm({ title, hint, children, onSubmit, saving, err, submit }: { title: string; hint: string; children: React.ReactNode; onSubmit: (fd: FormData) => void; saving: boolean; err: string | null; submit: string }) {
  return (
    <Card className="border-primary/40">
      <TitreEtape title={title} hint={hint} />
      <CardContent>
        <form action={onSubmit} className="space-y-3">
          {children}
          <Err msg={err} />
          <Button type="submit" className={bouton} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} {submit}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ name, label, type = "text", required, defaultValue }: { name: string; label: string; type?: string; required?: boolean; defaultValue?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      <Input id={name} name={name} type={type} required={required} defaultValue={defaultValue} step={type === "number" ? "any" : undefined} inputMode={type === "number" ? "decimal" : undefined} />
    </div>
  );
}
function Area({ name, label }: { name: string; label: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <Textarea id={name} name={name} className="min-h-[60px]" />
    </div>
  );
}
function FileField({ name, label }: { name: string; label: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <input id={name} name={name} type="file" multiple className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-secondary/80" />
    </div>
  );
}
