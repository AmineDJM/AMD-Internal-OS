"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, FileQuestion, Loader2, Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { askHrRequestPiece, setExpenseClaimEditUnlocked } from "@/modules/rh/actions-documents";
import { EXPENSE_EDIT_MINUTES } from "@/modules/rh/partage";

/**
 * CE QUE LES RH FONT SUR UNE NOTE DE FRAIS — sans la réécrire.
 *
 * ── DEUX GESTES, ET ILS NE SE CONFONDENT PAS ────────────────────────────────────────────────
 *
 *   • **RÉCLAMER UN JUSTIFICATIF** — « le ticket de péage manque ». La demande part au
 *     DEMANDEUR et à personne d'autre : le reçu d'un taxi est chez celui qui l'a pris, et
 *     proposer un annuaire ferait réclamer la pièce d'une personne à une autre. Elle apparaît
 *     dans « Mes pièces à fournir », avec sa référence et son échéance — c'est-à-dire une trace
 *     de ce qu'on attend, de qui, depuis quand, que jamais un message ne donne.
 *   • **ROUVRIR LA MODIFICATION** — « votre montant est faux, corrigez ». Sans cela, la phrase
 *     n'a aucun sens passé les quinze minutes : la personne ne peut plus rien changer, elle
 *     refait une seconde note, et l'on se retrouve avec deux demandes pour une dépense.
 *
 * Pour une simple EXPLICATION, il n'y a rien ici : le fil d'échange de la demande sert déjà à
 * cela, juste en dessous, et il prévient le demandeur. Un troisième bouton qui écrirait au même
 * endroit ferait deux chemins pour le même message.
 *
 * ── CE QUE LES RH NE FONT PAS ───────────────────────────────────────────────────────────────
 *
 * Ils ne corrigent pas le montant eux-mêmes. Ce chiffre est la parole du demandeur : le
 * réécrire à sa place ferait porter son nom à une somme qu'il n'a pas déclarée.
 */
export function ExpenseClaimHrPanel({
  requestId, employeeName, unlocked, decided,
}: {
  requestId: string;
  employeeName: string;
  /** La modification est-elle déjà rouverte ? */
  unlocked: boolean;
  /** Une note tranchée ne se rouvre pas : il n'y a plus rien à corriger. */
  decided: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  const basculerVerrou = async () => {
    setBusy(true); setErr(null); setOk(null);
    const fd = new FormData();
    fd.set("id", requestId);
    fd.set("unlock", unlocked ? "0" : "1");
    const r = await setExpenseClaimEditUnlocked(fd);
    setBusy(false);
    if (r.ok) { setOk(r.message ?? null); router.refresh(); } else setErr(r.error ?? "Le changement a échoué.");
  };

  const demanderPiece = async (fd: FormData) => {
    setBusy(true); setErr(null); setOk(null);
    fd.set("requestId", requestId);
    const r = await askHrRequestPiece(fd);
    setBusy(false);
    if (r.ok) { setOpen(false); setOk(r.message ?? "Pièce demandée."); router.refresh(); }
    else setErr(r.error ?? "La demande n'a pas pu être créée.");
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => { setErr(null); setOk(null); setOpen(true); }}>
          <FileQuestion className="h-3.5 w-3.5" /> Demander un justificatif
        </Button>
        {!decided && (
          <Button variant="outline" size="sm" onClick={basculerVerrou} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : unlocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            {unlocked ? "Refermer la modification" : "Autoriser la modification"}
          </Button>
        )}
        <span className="min-w-0 basis-full text-[0.6875rem] text-muted-foreground sm:basis-auto">
          {decided
            ? "Note traitée : elle ne se modifie plus."
            : unlocked
              ? `${employeeName} peut corriger sa note, sans limite de temps, jusqu'à ce que vous refermiez.`
              : `Passé ${EXPENSE_EDIT_MINUTES} minutes, ${employeeName} ne peut plus corriger sans votre autorisation.`}
        </span>
      </div>

      {ok && <p className="flex items-start gap-1.5 text-xs text-success"><Check className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0">{ok}</span></p>}
      {err && <p className="flex items-start gap-1.5 text-xs text-destructive"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0">{err}</span></p>}

      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Demander un justificatif"
        description={`La demande part à ${employeeName}, avec sa référence et son échéance. Elle apparaît dans ses pièces à fournir.`}
        width="md"
      >
        <form action={demanderPiece} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nf-ask-label">Ce que vous demandez <span className="text-destructive">*</span></Label>
            <Input id="nf-ask-label" name="label" required placeholder="Le ticket de péage du 12/09" />
            {/* Dire CE QU'ON VEUT, pas « pièce n° 2 » : la personne doit pouvoir aller le
                chercher sans revenir demander de quoi il s'agit. */}
            <p className="text-xs text-muted-foreground">En clair — « le reçu du taxi », pas « pièce manquante ».</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nf-ask-due">Pour le</Label>
            <Input id="nf-ask-due" type="date" name="dueDate" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nf-ask-note">Précision</Label>
            <Textarea id="nf-ask-note" name="note" rows={2} placeholder="Le scan reçu est illisible sur la partie du montant." />
          </div>

          {err && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0">{err}</span>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer la demande
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
