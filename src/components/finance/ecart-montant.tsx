"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { LIBELLE_CONFIRMATION_ECART } from "@/modules/finances/partage";

const dzd = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;

/**
 * LE MONTANT DEMANDÉ N'EST PAS CELUI DE LA FACTURE (`finance/montant-facture.ts`) — les deux chiffres, et les deux issues :
 * reprendre le montant de la facture, ou expliquer l'écart et le confirmer. Les champs portent les noms que l'action lit
 * (`ecartJustification`, `ecartConfirme`) : posés dans un formulaire, ils partent avec lui.
 */
export function EcartMontantCarte({
  ecart, justification, onJustification, confirme, onConfirme, onPrendreFacture, disabled,
}: {
  ecart: { montant: number; total: number };
  justification: string;
  onJustification: (v: string) => void;
  confirme: boolean;
  onConfirme: (v: boolean) => void;
  /** Reprendre le TTC de la facture comme montant — absent quand le montant se corrige ailleurs (« Corriger la demande »). */
  onPrendreFacture?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm" data-ecart-montant>
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">Facture : {dzd(ecart.total)} TTC · demandé : {dzd(ecart.montant)}</span>
        <InfoBulle label="Pourquoi ce contrôle">
          Le montant payé est celui de la facture (TTC, net à payer), lu par Luna. Un HT, le montant du bon de commande ou
          du devis ne passent pas en silence : corrigez le montant, ou expliquez l&apos;écart — l&apos;explication part avec
          l&apos;ordre au centre de paiement.
        </InfoBulle>
      </p>
      {onPrendreFacture && (
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onPrendreFacture}>
          Prendre {dzd(ecart.total)}
        </Button>
      )}
      <Textarea
        name="ecartJustification" rows={2} value={justification} disabled={disabled}
        onChange={(e) => onJustification(e.target.value)}
        placeholder="Ou expliquez l'écart (acompte, avoir, frais hors facture…)"
      />
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="checkbox" name="ecartConfirme" value="1" className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={confirme} disabled={disabled} onChange={(e) => onConfirme(e.target.checked)}
        />
        <span>{LIBELLE_CONFIRMATION_ECART}</span>
      </label>
    </div>
  );
}
