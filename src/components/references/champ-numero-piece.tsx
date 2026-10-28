"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { verifierNumeroPiece } from "@/lib/actions/fabrique-actions";
import { memeNumero } from "@/lib/bons-de-commande/numero-reference";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHAMP « N° DE RÉFÉRENCE » D'UN BON DE COMMANDE (Direction, 14/10/2026) — « modifiable quand on le compose ; écrit
 * manuellement, ou modifié quand on modifie ou qu'on révise n'importe quel bon de commande ».
 *
 * Prérempli (le numéro actuel du BC, ou le prochain numéro de sa série), modifiable, vérifié EN DIRECT par le serveur :
 * forme, année, unicité dans la série de la société — la pièce elle-même exclue (garder son numéro n'est jamais « pris »).
 * Laissé tel quel, rien ne change. Le serveur revérifie sous verrou au moment d'écrire : ce champ éclaire, il ne réserve rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EtatNumeroPiece {
  valeur: string;
  /** La saisie diffère-t-elle de la valeur de départ ? */
  change: boolean;
  /** Le refus de la vérification (numéro pris, mauvaise forme) ; `null` sinon. */
  erreur: string | null;
  verification: boolean;
}

export function ChampNumeroPiece({
  initial, depart, legalDocumentId, societe, type = "BON_DE_COMMANDE", date, label = "N° de référence", aide, onChange, name, nameActuel,
}: {
  /** Ce que le champ montre à l'ouverture (un numéro déjà modifié sur un brouillon, sinon `depart`). */
  initial?: string | null;
  /** Le numéro de départ : celui du BC (révision), ou le prochain de la série (composition). Identique = aucun changement. */
  depart: string;
  /** La pièce révisée (exclue de l'unicité) ; absente à la composition. */
  legalDocumentId?: string | null;
  societe?: string | null;
  type?: "BON_DE_COMMANDE" | "DEVIS";
  /** La date de la pièce (l'année du numéro). */
  date?: string | null;
  label?: string;
  aide?: string;
  onChange?: (e: EtatNumeroPiece) => void;
  /** Dans un formulaire non piloté : le nom du champ (la saisie) et celui du numéro de départ (caché). */
  name?: string;
  nameActuel?: string;
}) {
  const [valeur, setValeur] = React.useState(() => (initial?.trim() || depart));
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [verification, setVerification] = React.useState(false);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => { onChangeRef.current = onChange; });
  const id = React.useId();
  const change = !memeNumero(valeur, depart);

  React.useEffect(() => {
    const v = valeur.trim();
    if (!v) { setErreur("Le numéro de référence est obligatoire."); setVerification(false); return; }
    if (!change) { setErreur(null); setVerification(false); return; }
    let vivant = true;
    setVerification(true);
    const minuterie = setTimeout(async () => {
      const fd = new FormData();
      fd.set("numero", v);
      fd.set("type", type);
      if (legalDocumentId) fd.set("legalDocumentId", legalDocumentId);
      if (societe) fd.set("societe", societe);
      if (date) fd.set("date", date);
      const r = await verifierNumeroPiece(fd).catch(sansBloquer("champ-numero-piece.ChampNumeroPiece.verifierNumeroPiece", null));
      if (!vivant) return;
      setVerification(false);
      setErreur(r && !r.ok ? r.error : null);
    }, 400);
    return () => { vivant = false; clearTimeout(minuterie); };
  }, [valeur, change, legalDocumentId, societe, type, date]);

  React.useEffect(() => {
    onChangeRef.current?.({ valeur, change, erreur, verification });
  }, [valeur, change, erreur, verification]);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id} name={name} value={valeur} onChange={(e) => setValeur(e.target.value)} placeholder={depart}
        autoComplete="off" spellCheck={false} aria-invalid={erreur ? true : undefined} aria-describedby={`${id}-aide`}
        className={erreur ? "border-destructive focus-visible:ring-destructive" : undefined}
      />
      {nameActuel && <input type="hidden" name={nameActuel} value={depart} />}
      {verification ? (
        <p id={`${id}-aide`} className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Vérification…</p>
      ) : erreur ? (
        <p id={`${id}-aide`} role="alert" className="flex gap-1 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {erreur}</p>
      ) : (
        <p id={`${id}-aide`} className="text-xs text-muted-foreground">
          {change ? `Nouveau numéro : ${valeur.trim()} (libre). L'ancien ${depart} sera remplacé, et le changement tracé.` : aide ?? "Gardez ce numéro, ou écrivez-en un autre : il doit être libre dans la série de la société."}
        </p>
      )}
    </div>
  );
}
