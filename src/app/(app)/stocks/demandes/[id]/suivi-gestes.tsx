"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Lock, Trash2 } from "lucide-react";
import { relancerDemandeStocks, cloreDemandeStocks, supprimerDemandeStocks } from "@/lib/actions/demande-stocks-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatDateTime } from "@/lib/utils";

type Res = { ok: boolean; error?: string; message?: string; redirect?: string };

interface KamSuivi {
  kamId: string;
  nom: string;
  total: number;
  remplies: number;
  envoye: boolean;
  relanceLe: string | null;
  relances: number;
}

function useGeste() {
  const { enCours, rafraichir } = useRafraichir();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [retour, setRetour] = useState<{ ok: boolean; texte: string } | null>(null);
  const lancer = async (fn: () => Promise<Res>) => {
    setBusy(true); setRetour(null);
    try {
      const r = await fn();
      if (!r.ok) { setRetour({ ok: false, texte: r.error ?? "La demande de stocks n'a pas été mise à jour." }); return; }
      if (r.message) setRetour({ ok: true, texte: r.message });
      if (r.redirect) router.push(r.redirect);
      else rafraichir();
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };
  return { occupe: busy || enCours, retour, lancer };
}

const Retour = ({ r }: { r: { ok: boolean; texte: string } | null }) =>
  r ? <p className={`rounded border px-3 py-2 text-sm ${r.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{r.texte}</p> : null;

/** L'AVANCEMENT PAR KAM — et la relance de ceux qui n'ont pas envoyé. */
export function SuiviKams({ demandeId, ouverte, kams }: { demandeId: string; ouverte: boolean; kams: KamSuivi[] }) {
  const { occupe, retour, lancer } = useGeste();
  const enAttente = kams.filter((k) => !k.envoye);
  const relancer = (kamIds: string[]) => lancer(() => {
    const fd = new FormData();
    fd.set("demandeId", demandeId);
    for (const k of kamIds) fd.append("kamId", k);
    return relancerDemandeStocks(fd);
  });
  return (
    <div className="space-y-2">
      <Retour r={retour} />
      {ouverte && enAttente.length > 0 && (
        <Button type="button" size="sm" variant="outline" disabled={occupe} onClick={() => relancer([])}>
          <BellRing className="h-4 w-4" /> Relancer les {enAttente.length} KAM en attente
        </Button>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {kams.map((k) => {
          const pct = k.total === 0 ? 0 : Math.round((k.remplies / k.total) * 100);
          return (
            <li key={k.kamId} className="grid grid-cols-1 gap-2 px-3 py-2 text-sm sm:grid-cols-[1fr_10rem_auto] sm:items-center">
              <span className="min-w-0">
                <span className="font-medium">{k.nom}</span>
                <span className="block text-xs text-muted-foreground">
                  {k.remplies}/{k.total} stocks
                  {k.relances > 0 && k.relanceLe ? ` · relancé ${k.relances} fois, dernière le ${formatDateTime(k.relanceLe)}` : ""}
                </span>
              </span>
              <Progress value={pct} tone={k.envoye ? "success" : "primary"} />
              <span className="flex items-center gap-2 sm:justify-end">
                {k.envoye ? <Badge tone="success">Envoyé</Badge> : <Badge tone="warning">En attente</Badge>}
                {ouverte && !k.envoye && (
                  <Button type="button" size="sm" variant="ghost" disabled={occupe} onClick={() => relancer([k.kamId])}>Relancer</Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Clore, supprimer — les deux gestes qui tranchent, confirmés d'un second clic. */
export function GestesDemande({ demandeId, ouverte, peutSupprimer }: { demandeId: string; ouverte: boolean; peutSupprimer: boolean }) {
  const { occupe, retour, lancer } = useGeste();
  const avec = (fn: (fd: FormData) => Promise<Res>) => () => lancer(() => {
    const fd = new FormData();
    fd.set("demandeId", demandeId);
    return fn(fd);
  });
  return (
    <>
      {ouverte && (
        <BoutonDecisif type="button" size="sm" variant="outline" disabled={occupe} onClick={avec(cloreDemandeStocks)}
          confirmation="Clôturer la demande (les KAM ne pourront plus la renseigner)">
          <Lock className="h-3.5 w-3.5" /> Clôturer
        </BoutonDecisif>
      )}
      {peutSupprimer && (
        <BoutonDecisif type="button" size="sm" variant="ghost" disabled={occupe} onClick={avec(supprimerDemandeStocks)}
          confirmation="Supprimer la demande (les stocks déjà envoyés restent au module Stocks)">
          <Trash2 className="h-3.5 w-3.5" /> Supprimer
        </BoutonDecisif>
      )}
      <Retour r={retour} />
    </>
  );
}
