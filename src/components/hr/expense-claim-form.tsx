"use client";

import * as React from "react";
import { AlertTriangle, Paperclip, ScanLine } from "lucide-react";
import { Input, Label, Textarea } from "@/components/ui/input";

export const moisCourant = () => new Date().toISOString().slice(0, 7);

/**
 * LES CHAMPS D'UNE NOTE DE FRAIS — les mêmes au dépôt et à la correction.
 *
 * ── POURQUOI UN SEUL JEU DE CHAMPS ──────────────────────────────────────────────────────────
 *
 * Deux formulaires pour le même objet finissent par diverger sur un détail : un champ ajouté
 * ici, une aide reformulée là, et l'on corrige une note avec des règles qui ne sont plus celles
 * de son dépôt. Le bouton « Ajouter » et la fiche « Modifier » partagent donc ces champs.
 *
 * ── LE MONTANT EST UN CHAMP, PAS UNE PHRASE ─────────────────────────────────────────────────
 *
 * Il vivait dans le motif (« 4 200 DZD — taxi et péage ») : un montant noyé dans une phrase ne
 * s'additionne pas, ne se compare pas, ne se contrôle pas. Les RH relisaient chaque ligne pour
 * savoir ce qu'on leur demandait de rembourser.
 *
 * ── LE SCAN, PAS L'APPAREIL PHOTO ───────────────────────────────────────────────────────────
 *
 * Le champ ouvrait la CAMÉRA directement (`capture`) : on prenait une photo de travers, mal
 * cadrée, à la lumière du bureau — et les RH la renvoyaient. Sans cet attribut, le téléphone
 * propose son propre sélecteur, où « Numériser un document » redresse la page, la recadre et
 * rend un PDF lisible ; l'appareil photo y reste disponible pour qui le veut. On ne perd donc
 * aucun geste : on cesse d'en imposer un mauvais.
 */
export function ExpenseClaimFields({
  defaultMonth, defaultAmount, defaultDetails, filesRequired = true, filesHint,
}: {
  defaultMonth?: string | null;
  defaultAmount?: number | null;
  defaultDetails?: string | null;
  /** Au DÉPÔT, le justificatif est exigé ; à la CORRECTION, les pièces déjà versées suffisent. */
  filesRequired?: boolean;
  filesHint?: string;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="nf-mois">Mois concerné <span className="text-destructive">*</span></Label>
          <Input id="nf-mois" type="month" name="expenseMonth" defaultValue={defaultMonth ?? moisCourant()} required />
          <p className="text-xs text-muted-foreground">Le mois des dépenses. Les RH valideront pour ce mois ou le suivant.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="nf-montant">Montant avancé (DZD) <span className="text-destructive">*</span></Label>
          <Input
            id="nf-montant" type="number" name="expenseAmount" inputMode="decimal"
            min="0" step="0.01" placeholder="4200"
            defaultValue={defaultAmount != null ? String(defaultAmount) : ""}
            required
          />
          <p className="text-xs text-muted-foreground">
            Le montant de CETTE note. Plusieurs dépenses sans rapport ? Déposez-en une par dépense.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="nf-details">Motif</Label>
        <Textarea
          id="nf-details" name="details" rows={3}
          defaultValue={defaultDetails ?? ""}
          placeholder="Ex. taxi et péage, déplacement PCH Alger du 12/09"
        />
        <p className="text-xs text-muted-foreground">Ce que vous avez avancé et pourquoi — le montant, lui, a son champ.</p>
      </div>

      {/* ── LE JUSTIFICATIF ── */}
      <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Paperclip className="h-4 w-4 text-primary" /> Le justificatif
          {filesRequired && <span className="text-destructive">*</span>}
        </p>
        <Label htmlFor="nf-piece" className="flex items-center gap-1.5">
          <ScanLine className="h-3.5 w-3.5" /> Scanner ou choisir un fichier
        </Label>
        <input
          id="nf-piece" type="file" name="files" accept="image/*,application/pdf" multiple
          required={filesRequired}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium sm:file:py-1.5"
        />
        <p className="text-xs text-muted-foreground">
          {filesHint ?? "Sur téléphone, choisissez « Numériser un document » dans le sélecteur : la page est redressée et recadrée, bien plus lisible qu'une photo. Plusieurs papiers pour une même dépense (reçu + ticket de péage) vont sur la même note."}
        </p>
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>Les originaux restent à remettre</strong> aux RH, par votre supérieur hiérarchique : les RH en
          accuseront réception dans cette demande, puis décident.
        </span>
      </p>
    </>
  );
}
