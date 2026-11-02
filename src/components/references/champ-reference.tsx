"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { verifierReferenceRegistre } from "@/lib/actions/registre-references-actions";
import { lireReference, type ReferenceProchaine } from "@/lib/references/registre";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHAMP « RÉFÉRENCE » DES FORMULAIRES DE GÉNÉRATION (Direction, 10/2026) — « permets de modifier les numéros de référence
 * à la génération ».
 *
 * Prérempli avec le PROCHAIN numéro NNN/DG/AAAA du registre commun de la société (prévu, jamais réservé), modifiable, vérifié
 * en direct : un numéro déjà attribué — à n'importe quel document de la société — est refusé sous le champ. Laissé tel quel
 * (ou vide), le serveur attribue le prochain libre au moment de générer. Le champ caché `nameSuggeree` dit au serveur ce qui
 * était proposé (`saisieEffective`).
 *
 * Hors registre (une société qui garde sa numérotation) : rien ne s'affiche — ou, avec `repli`, le champ libre d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EtatChampReference {
  /** Ce qui est saisi. */
  valeur: string;
  /** Ce qui était proposé (le prochain numéro) ; `null` hors registre. */
  suggeree: string | null;
  /** Le refus de la vérification en direct (numéro pris, mauvais format) ; `null` sinon. */
  erreur: string | null;
  actif: boolean;
}

export function ChampReference({
  charger, cle = "", name = "reference", nameSuggeree = "referenceSuggeree", label = "Référence", repli, valeurInitiale = null, annee,
  id, onChange,
}: {
  /** Lit la société et son prochain numéro (une action serveur de lecture). */
  charger: () => Promise<ReferenceProchaine>;
  /** Relire quand elle change (une autre société, un aperçu régénéré). */
  cle?: string;
  name?: string;
  nameSuggeree?: string;
  label?: string;
  /** HORS REGISTRE : la valeur libre d'avant (ordre de mission « 007/DPG/2026 ») ; absente, le champ ne s'affiche pas. */
  repli?: string;
  /** Une référence déjà choisie (un brouillon) : elle remplace le prochain numéro dans le champ. */
  valeurInitiale?: string | null;
  /** L'année du document quand elle n'est pas l'année en cours (une pièce datée). */
  annee?: number;
  id?: string;
  /** Pour un formulaire piloté (aperçu du BC) : la saisie, la proposition et l'erreur, à chaque changement. */
  onChange?: (e: EtatChampReference) => void;
}) {
  const [etat, setEtat] = React.useState<ReferenceProchaine | null>(null);
  const [valeur, setValeur] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [verification, setVerification] = React.useState(false);
  const chargerRef = React.useRef(charger);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => { chargerRef.current = charger; onChangeRef.current = onChange; });
  const autoId = React.useId();
  const champId = id ?? `reference-${autoId}`;

  React.useEffect(() => {
    let vivant = true;
    setEtat(null);
    chargerRef.current()
      .then((r) => {
        if (!vivant) return;
        setEtat(r);
        setValeur(r.ok && r.actif ? (valeurInitiale?.trim() || r.prochaine || "") : (repli ?? ""));
        setErreur(null);
      })
      .catch(() => { if (vivant) setEtat({ ok: false, error: "Le prochain numéro n'a pas pu être lu : il sera attribué à la génération." }); });
    return () => { vivant = false; };
    // Relu à chaque `cle` seulement : la saisie en cours n'est pas écrasée par un nouveau rendu du parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle]);

  const actif = etat !== null && etat.ok && etat.actif;
  const societeId = etat !== null && etat.ok ? etat.societeId : null;
  const suggeree = etat !== null && etat.ok && etat.actif ? etat.prochaine : null;

  // LA VÉRIFICATION EN DIRECT — seulement pour une valeur qui n'est pas la proposée (celle-là est libre par construction).
  React.useEffect(() => {
    if (!actif || !societeId) return;
    const v = valeur.trim();
    const saisie = lireReference(v);
    const proposee = lireReference(suggeree);
    if (!v || (saisie && proposee && saisie.numero === proposee.numero && saisie.annee === proposee.annee)) {
      setErreur(null);
      setVerification(false);
      return;
    }
    let vivant = true;
    setVerification(true);
    const minuterie = setTimeout(async () => {
      const fd = new FormData();
      fd.set("societeId", societeId);
      fd.set("reference", v);
      if (annee) fd.set("annee", String(annee));
      const r = await verifierReferenceRegistre(fd).catch(sansBloquer("champ-reference.ChampReference.verifierReferenceRegistre", null));
      if (!vivant) return;
      setVerification(false);
      setErreur(r && !r.ok ? r.error : null);
    }, 400);
    return () => { vivant = false; clearTimeout(minuterie); };
  }, [valeur, actif, societeId, suggeree, annee]);

  React.useEffect(() => {
    onChangeRef.current?.({ valeur, suggeree, erreur, actif });
  }, [valeur, suggeree, erreur, actif]);

  if (etat === null) {
    return (
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Prochain numéro…</p>
      </div>
    );
  }

  if (!actif) {
    if (repli === undefined) {
      return !etat.ok ? <p className="text-xs text-muted-foreground">{etat.error}</p> : null;
    }
    return (
      <div className="space-y-1">
        <Label htmlFor={champId}>{label}</Label>
        <Input id={champId} name={name} value={valeur} onChange={(e) => setValeur(e.target.value)} required />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Label htmlFor={champId}>{label}</Label>
        <InfoBulle label="La référence NNN/DG/AAAA" align="left">
          Un seul compteur par société et par année pour tous ses documents (bons de commande, ordres de mission, demandes de
          devis…). Le prochain numéro est proposé ; vous pouvez en saisir un autre s&apos;il est libre — plus haut, il fait avancer
          le compteur. Un numéro attribué ne se réutilise jamais. Vide : le prochain libre est attribué à la génération.
        </InfoBulle>
      </div>
      <Input
        id={champId} name={name} value={valeur} onChange={(e) => setValeur(e.target.value)} placeholder={suggeree ?? undefined}
        inputMode="text" autoComplete="off" spellCheck={false}
        aria-invalid={erreur ? true : undefined} aria-describedby={erreur ? `${champId}-erreur` : undefined}
        className={erreur ? "border-destructive focus-visible:ring-destructive" : undefined}
      />
      <input type="hidden" name={nameSuggeree} value={suggeree ?? ""} />
      {verification ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Vérification…</p>
      ) : erreur ? (
        <p id={`${champId}-erreur`} role="alert" className="flex gap-1 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {erreur}</p>
      ) : null}
    </div>
  );
}
