"use client";

import * as React from "react";
import { Send, Loader2, BellRing, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DocumentPreview } from "@/components/documents/document-preview";
import { envoyerFiche, envoyerFichesPretes, relancerFiche, retirerFiche } from "@/lib/actions/reservation-fiche-actions";
import { fichesAEnvoyer, peutEnvoyer, resumeEnvois, type EnvoiVue } from "@/lib/reservation-fiche/etat";

type Resultat = { ok: boolean; error?: string; message?: string };
/** Le `run` de l'écran hôte (bloc des voyageurs, fiche d'une prise en charge) : il verrouille, affiche et rafraîchit. */
export type RunEnvoi = (key: string, fn: () => Promise<Resultat>, okText: string) => Promise<unknown>;

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/**
 * L'ENVOI D'UNE FICHE À L'ASSISTANTE (Direction, 14/10/2026) — sa pastille d'état, le sous-état (« depuis 2 j ·
 * relancée 1 fois ») et SES gestes : envoyer, renvoyer la mise à jour, relancer (une fois par 24 h), retirer.
 * Chaque fiche part seule. La règle est `reservation-fiche/etat.ts`, calculée au serveur (`EnvoiVue`) : l'écran
 * n'offre pas un geste que l'action refuserait.
 */
export function EnvoiFiche({ envoi, peutEditer, busy, run }: { envoi: EnvoiVue | undefined; peutEditer: boolean; busy: string | null; run: RunEnvoi }) {
  const [retrait, setRetrait] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  if (!envoi) return null;
  const e = envoi;
  const cle = (g: string) => `envoi-${g}:${e.ficheId}`;
  const chezElle = e.etat === "ENVOYEE" || e.etat === "PRISE" || e.etat === "DEVIS_RECU";
  const envoyable = peutEnvoyer(e.etat, e.manques);
  const retirable = chezElle || e.etat === "MANQUE_SIGNALE" || e.etat === "MODIFIEE_APRES_ENVOI";

  return (
    <div className="space-y-1 rounded-md bg-secondary/30 px-2 py-1.5" data-envoi-fiche={e.etat}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={e.ton} dot={false}>{e.libelle}</Badge>
        {e.sousEtat && <span className="min-w-0 text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{e.sousEtat}</span>}
        {e.reference && <span className="text-[0.6875rem] text-muted-foreground">réf. {e.reference}</span>}
        {peutEditer && (
          <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1">
            {envoyable && (
              <Button
                size="sm" disabled={busy !== null}
                onClick={() => void run(cle("envoyer"), () => envoyerFiche(fd({ source: e.source, id: e.ficheId })), "Fiche envoyée à l'assistante.")}
              >
                {busy === cle("envoyer") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : e.etat === "PRETE" ? <Send className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                {e.etat === "PRETE" ? "Envoyer à l'assistante" : e.etat === "MODIFIEE_APRES_ENVOI" ? "Renvoyer la mise à jour" : "Renvoyer"}
              </Button>
            )}
            {chezElle && e.demandeId && (
              <Button
                size="sm" variant="outline" disabled={busy !== null || e.refusRelance !== null} title={e.refusRelance ?? undefined}
                onClick={() => void run(cle("relancer"), () => relancerFiche(fd({ id: e.demandeId! })), "Relance envoyée.")}
              >
                {busy === cle("relancer") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
                {e.refusRelance && e.relances > 0 ? "Relancée" : "Relancer"}
              </Button>
            )}
            {retirable && e.demandeId && !retrait && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRetrait(true)} aria-label="Retirer la fiche de chez l'assistante">
                <Undo2 className="h-3.5 w-3.5" /> Retirer
              </Button>
            )}
          </span>
        )}
      </div>
      {e.etat === "BROUILLON" && e.manques.length > 0 && (
        <p className="text-[0.6875rem] text-warning">Il manque : {e.manques.join(", ")} — la fiche part dès qu&apos;elle est complète.</p>
      )}
      {e.etat === "MANQUE_SIGNALE" && e.manques.length > 0 && (
        <p className="text-[0.6875rem] text-warning">Encore à préciser : {e.manques.join(", ")}.</p>
      )}
      {e.changements.length > 0 && (
        <ul className="space-y-0.5 text-[0.6875rem] text-muted-foreground">
          {e.changements.map((c) => (
            <li key={c.champ}><span className="font-medium text-foreground">{c.champ}</span> : <s>{c.avant}</s> → {c.apres}</li>
          ))}
        </ul>
      )}
      {e.pieces.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.6875rem] text-muted-foreground">{e.nature === "BILLET" ? "Billet" : "Confirmation"}</span>
          {e.pieces.map((p) => <DocumentPreview key={p.id} id={p.id} name={p.name} hasFile />)}
        </div>
      )}
      {retrait && e.demandeId && (
        <form
          className="space-y-1.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(cle("retirer"), () => retirerFiche(fd({ id: e.demandeId!, motif })), "Fiche retirée.").then(() => { setRetrait(false); setMotif(""); });
          }}
        >
          <label className="block text-[0.6875rem] font-medium" htmlFor={`motif-retrait-${e.ficheId}`}>
            Pourquoi la retirer ?{e.motifRetraitRequis ? ` (${e.priseParNom ?? "l'assistante"} l'a déjà prise : elle lira ce motif)` : " (facultatif)"}
          </label>
          <input
            id={`motif-retrait-${e.ficheId}`} value={motif} onChange={(ev) => setMotif(ev.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" variant="destructive" disabled={busy !== null || (e.motifRetraitRequis && motif.trim() === "")}>
              {busy === cle("retirer") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Retirer
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRetrait(false)}>Annuler</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * LE BANDEAU DU POSTE — où en sont ses fiches chez l'assistante, qui s'en occupe, et « Envoyer les fiches prêtes (n) »
 * (un raccourci : chaque fiche part seule, par la même action que son propre bouton).
 */
export function BandeauEnvois({ envois, lot, peutEditer, busy, run }: {
  envois: readonly (EnvoiVue | undefined)[];
  /** Le poste Ad & Pro, ou la prise en charge. */
  lot: { itemId: string } | { scope: "NATIONAL" | "INTERNATIONAL"; requestId: string };
  peutEditer: boolean;
  busy: string | null;
  run: RunEnvoi;
}) {
  const liste = envois.filter((x): x is EnvoiVue => Boolean(x));
  if (liste.length === 0) return null;
  const r = resumeEnvois(liste.map((e) => e.etat));
  const pretes = fichesAEnvoyer(liste).length;
  const qui = [...new Set(liste.map((e) => e.priseParNom).filter((x): x is string => Boolean(x)))];
  const cle = `envoi-lot:${"itemId" in lot ? lot.itemId : lot.requestId}`;
  const morceaux = [
    `chez l'assistante : ${r.chezElle} fiche${r.chezElle > 1 ? "s" : ""}`,
    r.reservees ? `réservées : ${r.reservees}` : null,
    r.aCompleter ? `à compléter : ${r.aCompleter}` : null,
    r.aRenvoyer ? `à renvoyer : ${r.aRenvoyer}` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-secondary/20 px-2 py-1.5 text-[0.6875rem]" role="status">
      <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
        {morceaux.join(" · ").replace(/^c/, "C")}
        {qui.length > 0 && <> · <span className="text-foreground">{qui.join(", ")}</span> s&apos;en occupe{qui.length > 1 ? "nt" : ""}</>}
      </span>
      {peutEditer && (
        <Button
          size="sm" className="ml-auto" disabled={busy !== null || pretes === 0}
          title={pretes === 0 ? "Aucune fiche prête : complétez celles qui le disent." : undefined}
          onClick={() => void run(cle, () => envoyerFichesPretes(fd("itemId" in lot ? { itemId: lot.itemId } : { scope: lot.scope, requestId: lot.requestId })), "Fiches envoyées.")}
        >
          {busy === cle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Envoyer les fiches prêtes ({pretes})
        </Button>
      )}
    </div>
  );
}
