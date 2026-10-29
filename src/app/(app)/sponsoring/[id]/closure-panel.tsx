"use client";

import * as React from "react";
import { AlertCircle, Loader2, Lock, RotateCcw } from "lucide-react";
import { cloturerSponsoring, rouvrirSponsoring } from "@/modules/ad-pro/actions-sponsoring";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useAction } from "@/components/shared/use-action";

/**
 * LA VALIDATION FINALE ET LA CLÔTURE D'UN SPONSORING (§118.151) — l'écran du geste.
 *
 * Tout ce qu'il affiche vient du SERVEUR, calculé par le module pur (`ad-pro/cloture-sponsoring`)
 * que l'action relit au moment du clic : le bilan (ce qui manque, dit en une fois), le total qui
 * sera écrit, et qui a le droit. Le recalculer ici ferait deux vérités — un bouton actif qu'une
 * action refuse, ou l'inverse (§118.5).
 */
export interface BilanAffiche {
  cloturable: boolean;
  manques: string[];
  total: number;
  accordes: number;
  refuses: number;
  aDecider: number;
}

export function ClosurePanel({
  id, statut, bilan, peutAgir, quiCloture, cloture,
}: {
  id: string;
  statut: string;
  bilan: BilanAffiche;
  /** Tient l'autorité de la clôture (et de la réouverture) sur CETTE demande. */
  peutAgir: boolean;
  /** « la Direction Marketing » ou « la Direction (…) » — qui agit, dit en clair. */
  quiCloture: string;
  /** Renseigné quand la demande a été clôturée par sa validation finale. */
  cloture: { le: string; par: string | null; note: string | null; montant: number | null } | null;
}) {
  const [note, setNote] = React.useState("");
  const [motif, setMotif] = React.useState("");
  const [rouvrir, setRouvrir] = React.useState(false);
  // Gardé (levée, délai) et rafraîchi par `useAction` : clôturer ou rouvrir ne peut plus figer le panneau.
  const { busy: pending, err, setErr, run } = useAction();

  const agir = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, champs: Record<string, string>) => {
    const fd = new FormData();
    fd.set("id", id);
    for (const [k, v] of Object.entries(champs)) if (v.trim()) fd.set(k, v.trim());
    void run(() => fn(fd), () => { setNote(""); setMotif(""); setRouvrir(false); });
  };

  // ── CLÔTURÉE : ce qui a été arrêté, et le geste qui rouvre ──
  // Dans la carte « La demande » (Direction, 07/10), la phrase de statut dit déjà « validée et clôturée le …, par … » et
  // le bandeau le montant accordé : restent la note de clôture et le geste qui rouvre.
  if (cloture) {
    if (!cloture.note && !peutAgir) return null;
    return (
      <div className="space-y-3 text-sm">
        {cloture.note && <p className="text-muted-foreground [overflow-wrap:anywhere]">« {cloture.note} »</p>}
        {peutAgir && (
          rouvrir ? (
            <div className="space-y-2">
              <Textarea
                value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[60px]"
                placeholder="Pourquoi rouvrir ? (obligatoire — une facture d'un autre montant, un poste oublié…)"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={pending || !motif.trim()} onClick={() => agir(rouvrirSponsoring, { reason: motif })}>
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Rouvrir la demande
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setRouvrir(false); setErr(null); }}>Annuler</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRouvrir(true)}>
              <RotateCcw className="h-4 w-4" /> Rouvrir la demande
            </Button>
          )
        )}
        {err && <Erreur texte={err} />}
      </div>
    );
  }

  // ── PAS ENCORE PRÉ-VALIDÉE : la clôture vient après la tenue — la frise de « La demande » le montre ──
  if (statut !== "PRE_VALIDATED") return null;

  // ── PRÉ-VALIDÉE : ce qui manque, et le geste s'il est possible ──
  // Le pourquoi (et le total que la clôture écrira) derrière un ⓘ ; la phrase de statut dit déjà chez qui est la demande.
  return (
    <div className="space-y-3 text-sm">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Validation finale
        <InfoBulle label="La validation finale">
          Une fois l&apos;événement complété, {quiCloture} valide chaque poste, le range dans un budget, puis clôture : la somme
          des postes accordés ({formatCurrency(bilan.total)}, {bilan.accordes} poste{bilan.accordes > 1 ? "s" : ""}) devient le
          montant accordé de la demande.
        </InfoBulle>
      </p>
      {!bilan.cloturable && (
        <ul className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          {bilan.manques.map((m) => (
            <li key={m} className="flex items-start gap-1.5"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" /> {m}</li>
          ))}
        </ul>
      )}
      {peutAgir ? (
        <div className="space-y-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[50px]" placeholder="Note de clôture (facultative)" />
          <BoutonDecisif
            size="sm" disabled={pending || !bilan.cloturable}
            title={bilan.cloturable ? undefined : "Réglez d'abord ce qui est listé ci-dessus."}
            confirmation={`valider et clôturer — accordé ${formatCurrency(bilan.total)}, postes arrêtés`}
            onClick={() => { agir(cloturerSponsoring, { note }); }}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Valider et clôturer
          </BoutonDecisif>
        </div>
      ) : null}
      {err && <Erreur texte={err} />}
    </div>
  );
}

function Erreur({ texte }: { texte: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{texte}</span>
    </div>
  );
}
