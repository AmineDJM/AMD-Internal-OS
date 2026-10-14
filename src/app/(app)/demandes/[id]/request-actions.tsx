"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, CheckCircle2, Trash2, Wallet, RotateCcw, XCircle } from "lucide-react";
import {
  startRequestProcessing, finishRequest, deleteRequests, rouvrirDemande, annulerDemandeAuSecretariat,
} from "@/lib/actions/admin-request-actions";
import { gestesDuTraitement } from "@/lib/secretariat/traitement";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * LE TRAITEMENT PAR L'ASSISTANTE DE DIRECTION — deux gestes (Direction, 10/2026) : « Commencer le
 * traitement », puis « Fin du traitement ». Les étapes intermédiaires (en attente d'un tiers, d'un
 * document, bloquer, reprendre), les validations demandées d'ici et la mission chauffeur sont retirées
 * (`secretariat/traitement.ts`). Restent l'annulation (avec motif), la réouverture d'une demande
 * traitée (avec motif) et la suppression traçable.
 */
export function RequestActions({
  requestId, status, commencee, type, canManage,
  departments = [], defaultDepartmentId = null, fromAdPro = false, alreadyImputed = false, refusAnnulation = null, refusFin = null,
}: {
  requestId: string;
  status: string;
  /** « Commencer le traitement » a déjà été fait (`processingStartedAt`). */
  commencee: boolean;
  type: string;
  canManage: boolean;
  /** Départements dont on peut débiter les moyens généraux (nom seul — pas les montants). */
  departments?: { id: string; name: string }[];
  /** Le département du demandeur : c'est lui qui consomme, il est donc proposé d'emblée. */
  defaultDepartmentId?: string | null;
  /** Vient d'Ad & Pro : déjà porté par le budget de l'opération, on ne l'impute pas deux fois. */
  fromAdPro?: boolean;
  alreadyImputed?: boolean;
  /** Pourquoi l'annulation ne se fait PAS d'ici (la demande de BC d'un poste se retire depuis le poste) :
   *  le bouton n'est pas offert, et la raison se lit à sa place (§118.83). */
  refusAnnulation?: string | null;
  /** Pourquoi « Fin du traitement » n'est pas offerte : la dernière décision du validateur (refus, modification
   *  demandée, validation en attente — `refusFinApresDecision`). La raison se lit à la place du bouton. */
  refusFin?: string | null;
}) {
  const router = useRouter();
  // Rafraîchir sans laisser rouvrir une fiche sur l'état d'avant (§118.172) : les gestes restent fermés
  // tant que les données d'après ne sont pas à l'écran.
  const { enCours, rafraichir } = useRafraichir();
  const [enVol, setBusy] = React.useState(false);
  const busy = enVol || enCours;
  const [err, setErr] = React.useState<string | null>(null);
  const [del, setDel] = React.useState(false);
  const [finish, setFinish] = React.useState(false);
  const [rouvrir, setRouvrir] = React.useState(false);
  const [annuler, setAnnuler] = React.useState(false);

  if (!canManage) return null;
  const isPurchase = type === "PURCHASE";
  // L'imputation est due pour un achat qui ne vient pas d'Ad & Pro et n'a pas déjà été imputé.
  const needsImputation = isPurchase && !fromAdPro && !alreadyImputed && departments.length > 0;
  const gestesBruts = gestesDuTraitement(status, commencee);
  const gestes = { ...gestesBruts, terminer: gestesBruts.terminer && refusFin === null };
  const ouverte = status !== "DONE" && status !== "CANCELLED";

  async function run(fd: FormData, action: (f: FormData) => Promise<{ ok: boolean; error?: string }>, close?: () => void) {
    setBusy(true); setErr(null);
    const r = await action(fd);
    setBusy(false);
    if (r.ok) { close?.(); rafraichir(); } else setErr(r.error ?? "Erreur.");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {gestes.commencer && (
          <form action={(fd) => { fd.set("id", requestId); return run(fd, startRequestProcessing); }}>
            <Button type="submit" size="sm" disabled={busy}><Play className="h-4 w-4" /> Commencer le traitement</Button>
          </form>
        )}
        {/* Terminer un ACHAT sans dire qui le paie laissait le budget intact pendant que
            l'argent, lui, était sorti. On passe donc par l'imputation. */}
        {gestes.terminer && (needsImputation ? (
          <Button size="sm" type="button" disabled={busy} onClick={() => { setErr(null); setFinish(true); }}>
            <CheckCircle2 className="h-4 w-4" /> Fin du traitement
          </Button>
        ) : (
          <form action={(fd) => { fd.set("id", requestId); return run(fd, finishRequest); }}>
            <BoutonDecisif size="sm" type="submit" disabled={busy}><CheckCircle2 className="h-4 w-4" /> Fin du traitement</BoutonDecisif>
          </form>
        ))}
        {isPurchase && gestes.terminer && (
          <InfoBulle>Achat : joignez d&apos;abord la facture finale (Documents, catégorie « Facture », ou Pièces liées → Facture, avec son PDF).</InfoBulle>
        )}
        {status === "DONE" && (
          <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => { setErr(null); setRouvrir(true); }}><RotateCcw className="h-4 w-4" /> Rouvrir…</Button>
        )}
        {ouverte && refusAnnulation === null && (
          <Button size="sm" variant="outline" type="button" className="text-destructive" disabled={busy} onClick={() => { setErr(null); setAnnuler(true); }}><XCircle className="h-4 w-4" /> Annuler la demande…</Button>
        )}
      </div>
      {gestesBruts.terminer && refusFin !== null && (
        <p className="text-xs text-muted-foreground">{refusFin}</p>
      )}
      {ouverte && refusAnnulation !== null && (
        <p className="text-xs text-muted-foreground">{refusAnnulation}</p>
      )}

      <button type="button" onClick={() => { setErr(null); setDel(true); }} className="inline-flex items-center gap-1 text-xs text-destructive hover:underline">
        <Trash2 className="h-3.5 w-3.5" /> Supprimer la demande
      </button>

      {/* IMPUTATION AUX MOYENS GÉNÉRAUX — chaque département a les siens, et c'est celui qui a
          DEMANDÉ qui les consomme, pas le secrétariat qui exécute. */}
      <Sheet
        open={finish}
        onClose={() => setFinish(false)}
        title="Fin du traitement — imputer au budget"
        description="Choisissez le budget de moyens généraux à débiter : le vôtre, ou celui du département qui a demandé l'achat."
        width="md"
      >
        <form
          action={(fd) => {
            fd.set("id", requestId);
            return run(fd, finishRequest, () => setFinish(false));
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Budget de moyens généraux <span className="text-destructive">*</span></Label>
            <Select name="budgetDepartmentId" defaultValue={defaultDepartmentId ?? ""} required>
              <option value="">— Choisir le département à débiter —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Montant réellement dépensé (DZD) <span className="text-destructive">*</span></Label>
            <Input name="budgetAmount" inputMode="decimal" placeholder="0" required className="text-right tabular-nums" />
          </div>
          <div className="space-y-1.5">
            <Label>Précision (facultatif)</Label>
            <Input name="budgetNote" placeholder="Ex. fournisseur, n° de facture" />
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
            <span>La facture déjà versée à la demande sert de justificatif.</span>
          </p>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Terminer et imputer
          </Button>
        </form>
      </Sheet>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <Sheet open={rouvrir} onClose={() => setRouvrir(false)} title="Rouvrir la demande" description="La demande repart en cours ; le demandeur est prévenu, avec votre motif." width="md">
        <form action={(fd) => { fd.set("id", requestId); return run(fd, rouvrirDemande, () => setRouvrir(false)); }} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="rq-reopen">Pourquoi la rouvrir</Label><Textarea id="rq-reopen" name="motif" rows={3} required /></div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setRouvrir(false)}>Fermer</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Rouvrir</Button></div>
        </form>
      </Sheet>
      <Sheet open={annuler} onClose={() => setAnnuler(false)} title="Annuler la demande" description="La validation, l'approbation et le paiement en attente sont retirés avec elle ; le demandeur est prévenu." width="md">
        <form action={(fd) => { fd.set("id", requestId); return run(fd, annulerDemandeAuSecretariat, () => setAnnuler(false)); }} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="rq-cancel">Motif de l&apos;annulation</Label><Textarea id="rq-cancel" name="motif" rows={3} required /></div>
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAnnuler(false)}>Fermer</Button><BoutonDecisif type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Annuler la demande</BoutonDecisif></div>
        </form>
      </Sheet>
      <Sheet open={del} onClose={() => setDel(false)} title="Supprimer la demande" width="md">
        <form action={(fd) => { fd.set("ids", requestId); return run(fd, deleteRequests, () => { setDel(false); router.push("/demandes"); }); }} className="space-y-3">
          <p className="text-xs text-muted-foreground">La suppression est <strong>tracée</strong> (qui, quand, pourquoi). La demande est archivée et masquée des listes, mais reste consultable en corbeille.</p>
          <div className="space-y-1"><Label>Motif de suppression (obligatoire)</Label><Textarea name="reason" required placeholder="Ex. Doublon, demande annulée par le service…" /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setDel(false)}>Annuler</Button><BoutonDecisif type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Supprimer</BoutonDecisif></div>
        </form>
      </Sheet>
    </div>
  );
}
