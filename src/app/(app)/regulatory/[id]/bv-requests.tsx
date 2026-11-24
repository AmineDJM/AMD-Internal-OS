"use client";

import * as React from "react";

import { Loader2, ReceiptText, FileUp, X } from "lucide-react";
import { requestBV } from "@/lib/actions/regulatory-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { etatDeLOrdreBv, ETAT_BV } from "@/lib/regulatory/bv-circuit";
import type { SuiviDemandeBvVue } from "@/lib/regulatory/bv-validation";
import { ETAT_DEMANDE_BV } from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { cn, montantDzd } from "@/lib/utils";
import Link from "next/link";

export interface BvItem {
  id: string;
  reference: string;
  label: string;
  amount: number;
  status: string;
  /** La décision du centre de paiement — l'état se lit sur le couple (`etatDeLOrdreBv`). */
  centralStatus: string;
  dueDate: string | null;
  paidDate: string | null;
}

/**
 * L'état d'un BV de la liste : celui du circuit — demandé (au centre), autorisé (chez les Finances),
 * payé, refusé —, ou « Annulé ». « À régler » disait la même chose d'un BV que le centre n'avait pas
 * encore vu et d'un BV qu'il venait de refuser.
 */
function etatLu(b: BvItem): { label: string; tone: "warning" | "success" | "danger" | "neutral" | "info" } {
  const e = etatDeLOrdreBv(b);
  return e ? { label: `${ETAT_BV[e].label} — ${ETAT_BV[e].detail}`, tone: ETAT_BV[e].tone } : { label: "Annulé", tone: "neutral" };
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : null);

/**
 * LA DEMANDE DE BV SE FAIT DEPUIS L'ÉTAPE QUI LA PORTE.
 *
 * Le bouton vivait dans une carte de la colonne de droite, à côté d'une liste. On lisait le
 * processus à gauche — « 3. Demande du BV 25 % » — et il fallait aller chercher le formulaire
 * ailleurs, sans que rien ne relie les deux : l'étape restait à cocher à la main, et l'on
 * découvrait des dossiers où le BV était demandé mais l'étape jamais faite.
 *
 * Le type de BV n'est plus un menu déroulant : il est DÉTERMINÉ par l'étape d'où l'on part.
 * Choisir « BV 75 % » depuis l'étape « Demande du BV 25 % » était possible, et ne voulait rien
 * dire.
 */
export function BvRequestSheet({
  productId, stepKey, bvType, onClose,
}: {
  productId: string;
  stepKey: string;
  bvType: string;
  onClose: () => void;
}) {
  const { busy, err: error, run } = useAction();
  const [files, setFiles] = React.useState<File[]>([]);

  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title={`Demander l'autorisation du ${bvType}`}
      description="La demande part au Centre de validations : toute personne qui y a accès peut l'accepter ou la refuser. Acceptée, son montant est engagé au budget Regulatory et l'étape « Paiement » se déverrouille ; refusée, vous pourrez redemander."
    >
      <form
        action={async (fd) => {
          fd.set("productId", productId);
          fd.set("bvType", bvType);
          fd.set("stepKey", stepKey);
          for (const f of files) fd.append("files", f);
          await run(() => requestBV(fd), onClose);
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="amount">Montant (DZD)</Label>
            <Input id="amount" name="amount" type="number" inputMode="decimal" step="any" min="1" required placeholder="Ex. 150000" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dueDate">Échéance souhaitée</Label>
            <Input id="dueDate" name="dueDate" type="date" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="note">Commentaire (facultatif)</Label>
          <Textarea id="note" name="note" placeholder="Lu par le Centre de validations : urgence, échéance ANPP, précisions…" />
        </div>

        {/* UNE OU PLUSIEURS PIÈCES : un BV arrive rarement seul (proforma, courrier de
            l'agence, calcul du montant). N'en accepter qu'une revenait à déposer le reste
            ailleurs, c'est-à-dire nulle part. */}
        <div className="space-y-1.5">
          <Label>Pièces jointes (proforma BV, courrier ANPP…)</Label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-sm hover:bg-muted/50">
            <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">Ajouter un ou plusieurs documents (optionnel)</span>
            <input
              type="file" multiple className="hidden"
              onChange={(e) => {
                // Le tableau est matérialisé MAINTENANT : le corps d'un updater React ne
                // s'exécute que plus tard, et `e.target.value = ""` aura d'ici là VIDÉ la
                // FileList — on ajouterait alors zéro fichier, par intermittence.
                const ajoutes = Array.from(e.target.files ?? []);
                if (ajoutes.length === 0) return;
                setFiles((prev) => [...prev, ...ajoutes]);
                e.target.value = "";
              }}
            />
          </label>
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-secondary/50 px-2 py-1 text-xs">
                  <span className="truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 rounded p-2 text-muted-foreground hover:text-destructive sm:p-0.5"
                    aria-label={`Retirer ${f.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Retour ton="erreur">{error}</Retour>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />} Demander l&apos;autorisation
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

const fmtJour = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : null);

/**
 * LE BV AU CENTRE DE VALIDATIONS, DANS SON ÉTAPE — en attente, accepté (montant engagé au budget Regulatory), ou
 * refusé avec le motif écrit par le validateur. Lu sur la demande de validation, jamais saisi à part.
 */
export function SuiviCentreBv({ centre }: { centre: SuiviDemandeBvVue }) {
  const e = ETAT_DEMANDE_BV[centre.etat];
  return (
    <div className={cn(
      "rounded-md border px-2.5 py-2 text-xs",
      centre.etat === "REFUSE" ? "border-destructive/30 bg-destructive/5"
        : centre.etat === "ACCEPTE" ? "border-success/30 bg-success/5" : "border-border bg-secondary/30",
    )}>
      <p className="flex flex-wrap items-center gap-1.5">
        <StatusBadge map={ETAT_DEMANDE_BV} value={centre.etat} dot={false} />
        <span className="text-muted-foreground [overflow-wrap:anywhere]">
          {e?.detail} · <Link href={`/validations/${centre.validationId}`} className="font-mono hover:underline">{centre.reference}</Link> · {montantDzd(centre.montant)}
        </span>
      </p>
      <p className="mt-1 text-muted-foreground">
        Demandé le {fmtJour(centre.demandeLe)}
        {centre.decideLe && centre.etat !== "EN_ATTENTE" && <> · {centre.etat === "REFUSE" ? "refusé" : "accepté"} le {fmtJour(centre.decideLe)}{centre.decideur && <> par {centre.decideur}</>}</>}
      </p>
      {centre.etat === "REFUSE" && (
        <p className="mt-1 whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">
          <span className="font-medium">Motif : </span>{centre.motifRefus ?? "non précisé"}
        </p>
      )}
    </div>
  );
}

/**
 * LE SUIVI des bons de versement — une LISTE, plus un formulaire.
 *
 * On y lit ce qui est demandé, ce qui est réglé et quand. La DEMANDE, elle, part de l'étape du
 * processus : deux portes pour le même geste auraient fini par produire des BV demandés hors
 * de toute étape.
 */
export function BvRequests({ items }: { items: BvItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune demande de BV. Elle se fait depuis l&apos;étape « Demande du BV » du processus d&apos;enregistrement.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((b) => (
        <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{b.label}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{b.reference}</span> · {montantDzd(b.amount)}
              {b.dueDate && <> · échéance {fmtDate(b.dueDate)}</>}
              {b.paidDate && <> · réglé le {fmtDate(b.paidDate)}</>}
            </p>
          </div>
          <Badge tone={etatLu(b).tone} dot={false}>{etatLu(b).label}</Badge>
        </li>
      ))}
    </ul>
  );
}
