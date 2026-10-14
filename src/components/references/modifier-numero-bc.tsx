"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Hash, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { ValeursComposables } from "@/lib/legal/piece-emise";
import { formulaireDuComposeur } from "@/lib/bons-de-commande/composeur-test-outils";
import { phraseNumeroSeul } from "@/lib/bons-de-commande/numero-seul";
import { ChampNumeroPiece, type EtatNumeroPiece } from "@/components/references/champ-numero-piece";

type Retour = { ok: boolean; error?: string; message?: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MODIFIER LE N° DE RÉFÉRENCE » D'UN BC SIGNÉ (Direction, 14/10/2026 — « changer UNIQUEMENT le numéro ne relance pas le
 * circuit »).
 *
 * Un BC signé ne se révise plus depuis le poste ou la demande — sauf son numéro. Ce petit formulaire renvoie la pièce
 * ENREGISTRÉE telle quelle (le même formulaire que le composeur, `formulaireDuComposeur`) avec le nouveau numéro : c'est le
 * SERVEUR qui constate, en comparant, que seul le numéro change (`bons-de-commande/numero-seul.ts`) — aucun drapeau de
 * l'écran n'en décide. Le BC garde alors son état et sa signature ; le Word et le PDF sont régénérés au nouveau numéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function ModifierNumeroBc({ legalDocumentId, numero, version, valeurs, signe, envoyer, extra = {} }: {
  legalDocumentId: string;
  numero: string;
  version: number;
  valeurs: ValeursComposables;
  signe: boolean;
  /** L'action du chemin (`modifierBcDuPoste`, `reviserPieceCommerciale`…). */
  envoyer: (fd: FormData) => Promise<Retour>;
  /** Les champs propres au chemin (l'id du poste…). */
  extra?: Record<string, string>;
}) {
  const router = useRouter();
  const [ouvert, setOuvert] = React.useState(false);
  const [etat, setEtat] = React.useState<EtatNumeroPiece | null>(null);
  const [motif, setMotif] = React.useState("");
  const [retour, setRetour] = React.useState<Retour | null>(null);
  const [envoi, start] = React.useTransition();

  if (!ouvert) {
    return (
      <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={() => setOuvert(true)}>
        <Hash className="h-3 w-3" /> Modifier le n° de référence
      </button>
    );
  }
  const pret = Boolean(etat && etat.change && !etat.erreur && !etat.verification);
  const enregistrer = () => {
    if (!etat) return;
    const fd = formulaireDuComposeur(valeurs, {
      ...extra, legalDocumentId, revisionDe: legalDocumentId, versionVue: String(version), numeroRevise: etat.valeur, numeroActuel: numero,
      motif: motif.trim() || "Numéro de référence corrigé.",
    });
    setRetour(null);
    start(async () => {
      const r = await envoyer(fd);
      setRetour(r);
      if (r.ok) router.refresh();
    });
  };
  return (
    <div className="mt-2 w-full max-w-md space-y-2 rounded-lg border border-border p-3 text-sm">
      <ChampNumeroPiece depart={numero} legalDocumentId={legalDocumentId} date={valeurs.champs.date} label="N° de référence du BC" onChange={setEtat} />
      <p className="text-xs text-muted-foreground">{phraseNumeroSeul({ signe })}</p>
      <div className="space-y-1">
        <Label htmlFor={`motif-numero-${legalDocumentId}`}>Motif (gardé au journal)</Label>
        <Input id={`motif-numero-${legalDocumentId}`} value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Numéro de la série papier" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!pret || envoi || retour?.ok === true} onClick={enregistrer}>
          {envoi && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer le numéro
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setOuvert(false); setRetour(null); }}>Fermer</Button>
      </div>
      {retour && <p role="status" className={retour.ok ? "text-success" : "text-destructive"}>{retour.ok ? retour.message ?? "Numéro modifié." : retour.error}</p>}
    </div>
  );
}
