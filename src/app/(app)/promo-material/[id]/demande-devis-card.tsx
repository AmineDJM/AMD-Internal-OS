"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, ExternalLink, FileText, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { referenceDemandeDevisPromo, regenererDemandeDevisPromo } from "@/lib/actions/promo-devis-actions";
import { deleteDocument } from "@/lib/actions/document-actions";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ChampReference } from "@/components/references/champ-reference";

/**
 * LA DEMANDE DE DEVIS — la lettre que Luna rédige pour l'agence (Word + PDF sur papier en-tête), l'étape d'avant les
 * devis. La dernière génération en tête ; les précédentes repliées. Tout arrive tranché du serveur : qui peut
 * (re)générer (la règle de l'action), quel fichier se supprime (celle de `deleteDocument`).
 */

export interface FichierLettre { id: string; nom: string; supprimable: boolean }
export interface GenerationLettre { quand: string; pdf: FichierLettre | null; word: FichierLettre | null }

export function DemandeDevisCard({ promoMaterialId, generations, peutGenerer, apercu, retrait }: {
  promoMaterialId: string;
  /** La plus récente d'abord. */
  generations: GenerationLettre[];
  peutGenerer: boolean;
  /** L'aperçu in-app de la dernière lettre (rendu par le serveur). */
  apercu?: React.ReactNode;
  /** Le geste « Retirer la demande de devis », quand le serveur l'offre. */
  retrait?: React.ReactNode;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState({ valeur: "", suggeree: "", refusee: false });
  const bloque = occupe || enCours;
  const chemin = `/promo-material/${promoMaterialId}`;

  const generer = async () => {
    setOccupe(true); setErr(null); setMsg(null);
    const fd = new FormData();
    fd.set("promoMaterialId", promoMaterialId);
    // La référence NNN/DG/AAAA (registre commun) : préremplie avec le prochain numéro, modifiable.
    fd.set("reference", reference.valeur);
    fd.set("referenceSuggeree", reference.suggeree);
    let r: Awaited<ReturnType<typeof regenererDemandeDevisPromo>>;
    try {
      r = await regenererDemandeDevisPromo(fd);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setOccupe(false);
    }
    if (r.ok) { setMsg(r.message ?? null); rafraichir(); } else setErr(r.error ?? "La demande de devis n'a pas été générée.");
  };
  const supprimer = async (f: FichierLettre) => {
    setOccupe(true); setErr(null); setMsg(null);
    let r: Awaited<ReturnType<typeof deleteDocument>>;
    try {
      r = await deleteDocument(f.id, chemin);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setOccupe(false);
    }
    if (r.ok) rafraichir(); else setErr(r.error ?? "La lettre n'a pas été supprimée.");
  };

  const [derniere, ...anciennes] = generations;

  const fichier = (f: FichierLettre | null, libelle: string) => f && (
    <span className="inline-flex items-center gap-0.5">
      <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline" title={f.nom}>
        {libelle} <ExternalLink className="h-3 w-3 text-muted-foreground" />
      </a>
      {f.supprimable && (
        <BoutonDecisif
          brut type="button" aria-label={`Supprimer ${f.nom}`} disabled={bloque} onClick={() => supprimer(f)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-destructive disabled:opacity-50 sm:h-5 sm:w-5"
        >
          <X className="h-3.5 w-3.5" />
        </BoutonDecisif>
      )}
    </span>
  );
  const ligne = (g: GenerationLettre) => (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{g.quand}</span>
      {fichier(g.pdf, "PDF")}
      {fichier(g.word, "Word")}
    </span>
  );

  return (
    <div className="space-y-2.5 text-sm">
      {derniere ? (
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><FileText className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1 space-y-0.5">
            {apercu ?? <p className="truncate font-medium">Demande de devis</p>}
            {ligne(derniere)}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Pas encore générée.</p>
      )}

      {anciennes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Versions précédentes ({anciennes.length})</summary>
          <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
            {anciennes.map((g, i) => <li key={`${g.quand}-${i}`}>{ligne(g)}</li>)}
          </ul>
        </details>
      )}

      {err && <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{err}</span></div>}
      {msg && <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div>}

      {peutGenerer && (
        <div className="max-w-xs">
          <ChampReference
            cle={`${promoMaterialId}:${generations.length}`}
            charger={() => { const fd = new FormData(); fd.set("promoMaterialId", promoMaterialId); return referenceDemandeDevisPromo(fd); }}
            onChange={(e) => setReference({ valeur: e.valeur, suggeree: e.suggeree ?? "", refusee: e.erreur !== null })}
          />
        </div>
      )}
      {(peutGenerer || retrait) && (
        <div className="flex flex-wrap items-center gap-2">
          {peutGenerer && (
            <Button size="sm" variant={derniere ? "outline" : "primary"} className="w-full sm:w-auto" disabled={bloque || reference.refusee} onClick={generer}>
              {occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : derniere ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              {derniere ? "Régénérer" : "Générer la demande de devis"}
            </Button>
          )}
          {retrait}
        </div>
      )}
    </div>
  );
}
