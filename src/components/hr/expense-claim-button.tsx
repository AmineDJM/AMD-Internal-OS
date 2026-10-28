"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { requestHrDocument } from "@/modules/rh/actions-documents";
import { ExpenseClaimFields } from "./expense-claim-form";
import { EXPENSE_EDIT_MINUTES } from "@/modules/rh/partage";

/**
 * AJOUTER UNE NOTE DE FRAIS — depuis son espace, avec le reçu qu'on a dans la main.
 *
 * ── POURQUOI UNE PORTE DE PLUS, ET PAS UN CIRCUIT DE PLUS ───────────────────────────────────
 *
 * La note de frais EXISTE : c'est une demande RH de type `EXPENSE_REPORT`, avec son mois, ses
 * pièces, son accusé de réception des originaux et sa décision. Elle ne se déposait que depuis
 * « Mon dossier RH », derrière une liste déroulante de douze types — on y allait pour une
 * attestation, pas pour se faire rembourser un taxi.
 *
 * Ce bouton n'invente donc RIEN : il appelle la MÊME action (`requestHrDocument`) et écrit la
 * MÊME demande. Un second circuit aurait donné deux notes de frais pour un seul remboursement,
 * et deux files aux RH (§17).
 *
 * ── UNE NOTE, UN MONTANT, SA PIÈCE ──────────────────────────────────────────────────────────
 *
 * Le montant a son champ, séparé du motif ; le justificatif est exigé — une note de frais sans
 * pièce n'est pas une demande, c'est une affirmation, et elle repartirait au premier examen.
 * Deux dépenses sans rapport font deux notes : c'est ce qui permet de les instruire séparément.
 *
 * ── ET APRÈS L'ENVOI ────────────────────────────────────────────────────────────────────────
 *
 * Quinze minutes pour se relire et se corriger, depuis « Mon dossier RH ». On le DIT ici, avant
 * l'envoi : sans cela, la personne qui se relit croit devoir annuler et redéposer, ce qui laisse
 * deux demandes dont une morte.
 */
/** `compact` : le bouton discret du bloc « Moi » d'Aujourd'hui (« Ajouter ») — même feuille, même action. */
export function ExpenseClaimButton({ compact = false }: { compact?: boolean } = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async (fd: FormData) => {
    setBusy(true); setErr(null);
    // La nature est POSÉE ICI, pas choisie : le bouton dit ce qu'il fait.
    fd.set("type", "EXPENSE_REPORT");
    const r = await requestHrDocument(fd);
    setBusy(false);
    if (r.ok) { setOpen(false); router.refresh(); } else setErr(r.error ?? "L'envoi a échoué.");
  };

  return (
    <>
      {/* MÊME TAILLE QUE SES VOISINS — voir `training-request-button.tsx` : les trois boutons
          de l'en-tête de Mon espace forment un jeu, et une taille différente se lit comme une
          importance différente. */}
      {compact ? (
        <Button variant="outline" size="sm" onClick={() => { setErr(null); setOpen(true); }} aria-label="Ajouter une note de frais">
          Ajouter
        </Button>
      ) : (
        <Button variant="outline" onClick={() => { setErr(null); setOpen(true); }}>
          <ReceiptText className="h-4 w-4" /> Ajouter une note de frais
        </Button>
      )}

      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Ajouter une note de frais"
        description="Le mois concerné, le montant avancé, le motif, et le justificatif scanné. Les RH la traitent depuis votre dossier."
        width="md"
      >
        <form action={submit} className="space-y-4">
          <ExpenseClaimFields />

          <p className="text-xs text-muted-foreground">
            Après l&apos;envoi, vous pourrez la corriger pendant {EXPENSE_EDIT_MINUTES} minutes depuis
            « Mon dossier RH ». Passé ce délai, les RH peuvent rouvrir la modification — ne déposez
            pas une seconde note pour la même dépense.
          </p>

          {err && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0">{err}</span>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer la note de frais
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
