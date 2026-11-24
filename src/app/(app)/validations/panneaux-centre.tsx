"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { setBcValidationThresholdCentre } from "@/lib/actions/settings-actions";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { lienDemandeDeValidation } from "@/lib/chemins/validations";
import {
  etatEnvoyee, libelleDecision, REGLES_DU_CENTRE,
  type LigneDecidee, type LigneEnvoyee, type Ton,
} from "@/lib/validations/centre-affichage";
import { ValidationFinaleBC } from "./validation-finale-bc";
import { Etiquette } from "./etiquette";

/**
 * LES PANNEAUX DU MENU ⋯ (maquette validée le 24/11/2026) — ce qu'on consulte rarement et qui encombrait l'écran :
 * déjà décidés, mes demandes envoyées, les règles. Ils prennent la place de la file ; « Retour à la file » la rend.
 */

const TON: Record<Ton, string> = {
  rouge: "font-semibold text-destructive",
  orange: "font-semibold text-warning",
  bleu: "font-semibold text-primary",
  neutre: "font-semibold text-success",
};

/** Le retour d'un validateur sur un élément (un avis, pas la décision). */
const AVIS: Record<string, string> = { APPROVED: "approuvé", CHANGES_REQUESTED: "à réviser", REJECTED: "refusé" };

const ligne = "flex flex-wrap items-baseline justify-between gap-2 border-t border-border py-3 text-sm";

export function PanneauDecides({ decides }: { decides: LigneDecidee[] }) {
  if (decides.length === 0) return <p className="text-sm text-muted-foreground">Aucune décision pour l&apos;instant.</p>;
  return (
    <ul>
      {decides.map((d) => {
        const dec = libelleDecision(d.status, d.motif);
        return (
          <li key={d.stepId} className={ligne}>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <Etiquette genre={d.genre}>{d.etiquette}</Etiquette>{" "}
              <Link href={lienDemandeDeValidation(d.requestId)} className="font-semibold hover:underline">{d.objet}</Link>
              {d.montant !== null && <span className="text-muted-foreground"> · {formatCurrency(d.montant)}</span>}
            </span>
            <span className={cn("whitespace-nowrap font-semibold", dec.accord ? "text-success" : "text-destructive")}>
              {dec.texte} · {formatDate(d.decideeLe, { day: "numeric", month: "short" })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function PanneauEnvoyees({ envoyees, demander, paiements, estSuperAdmin }: {
  envoyees: LigneEnvoyee[]; demander: React.ReactNode; paiements: React.ReactNode; estSuperAdmin: boolean;
}) {
  const now = React.useMemo(() => new Date(), []);
  return (
    <div className="flex flex-col gap-4">
      {envoyees.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune demande envoyée.</p>
      ) : (
        <ul>
          {envoyees.map((e) => {
            const etat = etatEnvoyee(e.status, e.depuis, e.decideeLe, now);
            return (
              <li key={e.key} className="border-t border-border py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <Link href={lienDemandeDeValidation(e.id)} className="font-semibold hover:underline">{e.objet}</Link>
                    <span className="text-muted-foreground"> · à {e.a}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn("whitespace-nowrap", TON[etat.ton])}>{etat.texte}</span>
                    {estSuperAdmin && e.mainId && (
                      <SuperAdminDeleteButton kind="VALIDATION_REQUEST" id={e.mainId} name={`${e.reference} — ${e.objet}`} enabled />
                    )}
                  </span>
                </div>
                {e.resume && <p className="mt-1 text-[13px] text-muted-foreground">{e.resume}</p>}
                {e.retours.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[13px] text-muted-foreground">
                    {e.retours.map((r, i) => (
                      <li key={i} className="[overflow-wrap:anywhere]">{r.validateur} · {r.element} : {AVIS[r.decision] ?? r.decision}{r.commentaire ? ` — ${r.commentaire}` : ""}</li>
                    ))}
                  </ul>
                )}
                {/* LA PRÉ-VALIDATION D'UN BC : acquise, le demandeur demande la validation finale ; ensuite, on suit le BC. */}
                {e.bc && (e.bc.retenu
                  ? (e.status === "APPROVED" && <div className="mt-2"><ValidationFinaleBC demandeId={e.mainId ?? e.id} reference={e.bc.reference} /></div>)
                  : (
                    <p className="mt-1 flex flex-wrap gap-x-2 text-[13px]">
                      <span className="text-muted-foreground">Bon de commande {e.bc.reference} :</span>
                      <span className="font-medium">{e.bc.etape}</span>
                      <Link href={`/legal/${e.bc.docId}`} className="font-semibold text-primary hover:underline">Ouvrir</Link>
                    </p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">{demander}</div>
      {paiements}
    </div>
  );
}

/** LE SEUIL DES BC HORS AD & PRO — réglé par qui a accès au centre (`setBcValidationThresholdCentre` le revérifie). */
function SeuilBC({ seuil, peutRegler }: { seuil: number; peutRegler: boolean }) {
  const [valeur, setValeur] = React.useState(String(seuil));
  const [enregistre, setEnregistre] = React.useState(false);
  const { busy, err, run } = useAction();
  React.useEffect(() => { setValeur(String(seuil)); }, [seuil]);
  const enregistrer = () => {
    const fd = new FormData();
    fd.set("bcValidationThresholdCentre", valeur.replace(/\s/g, "").replace(",", "."));
    void run(() => setBcValidationThresholdCentre(fd), () => setEnregistre(true));
  };
  return (
    <li className={cn(ligne, "items-center")}>
      <span><strong>Bons de commande hors Ad &amp; Pro</strong> <span className="text-muted-foreground">· validés ici au-dessus de</span></span>
      {peutRegler ? (
        <span className="flex flex-wrap items-center gap-2">
          <label htmlFor="seuil-bc" className="sr-only">Seuil des bons de commande, en DZD</label>
          <Input
            id="seuil-bc" inputMode="decimal" value={valeur} className="h-9 w-32 text-right"
            onChange={(e) => { setValeur(e.target.value); setEnregistre(false); }}
          />
          <span>DZD</span>
          <Button type="button" variant="outline" size="sm" className="h-9" disabled={busy} onClick={enregistrer}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {enregistre ? "Enregistré" : "Enregistrer"}
          </Button>
          {err && <span role="alert" className="w-full text-[13px] text-destructive">{err}</span>}
        </span>
      ) : (
        <strong className="tabular-nums">{formatCurrency(seuil)}</strong>
      )}
    </li>
  );
}

export function PanneauRegles({ seuil, peutRegler }: { seuil: number; peutRegler: boolean }) {
  return (
    <ul>
      <SeuilBC seuil={seuil} peutRegler={peutRegler} />
      {REGLES_DU_CENTRE.map((r) => (
        <li key={r.quoi} className={ligne}>
          <strong>{r.quoi}</strong>
          <span className="text-muted-foreground">{r.qui}</span>
        </li>
      ))}
    </ul>
  );
}
