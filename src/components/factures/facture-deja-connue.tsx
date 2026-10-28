"use client";

import * as React from "react";
import Link from "next/link";
import { BellRing, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relancerPaiement } from "@/modules/finances/actions-relances";
import type { CibleRelance, FactureDejaConnue } from "@/lib/factures/blocage-vue";
import { COMMENTAIRE_RELANCE_MAX } from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CETTE FACTURE EXISTE DÉJÀ » — le blocage, et le SEUL geste proposé : la relancer (Direction, 14/10/2026).
 *
 * La phrase vient du serveur (construite par le code, jamais par Luna) ; l'endroit n'est un lien que si la personne y a
 * accès. Le bouton « Relancer » part en un clic ; le commentaire est facultatif et s'ouvre sur demande. Aucun autre
 * bouton : ni « déposer quand même », ni « remplacer » — une facture déjà en paiement ne se redépose pas.
 *
 * `RelancerPaiement` est le même geste, offert là où un paiement attend (le poste Ad & Pro, par exemple) : il appelle
 * la même action (`relancerPaiement`), sous la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export function RelancerPaiement({ cible, jeton, libelle = "Relancer", compact = false }: {
  cible: CibleRelance; jeton?: string | null; libelle?: string; compact?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [ouvert, setOuvert] = React.useState(false);
  const [commentaire, setCommentaire] = React.useState("");
  const [fait, setFait] = React.useState<string | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);

  const relancer = async () => {
    setBusy(true); setErreur(null);
    const fd = new FormData();
    fd.set("cibleType", cible.type);
    fd.set("cibleId", cible.id);
    if (jeton) fd.set("jeton", jeton);
    if (commentaire.trim()) fd.set("commentaire", commentaire.trim());
    const r = await relancerPaiement(fd);
    setBusy(false);
    if (!r.ok) { setErreur(r.error ?? "La relance n'a pas pu être envoyée."); return; }
    setFait(r.message ?? "Relance envoyée."); setOuvert(false); setCommentaire("");
  };

  if (fait) return <p className="rounded-lg bg-success/10 px-2.5 py-1.5 text-xs text-success [overflow-wrap:anywhere]" role="status">{fait}</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={compact ? "outline" : "primary"} className="h-10 max-sm:w-full sm:h-8" disabled={busy} onClick={() => void relancer()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />} {libelle}
        </Button>
        {!ouvert && (
          <button type="button" className="min-h-9 text-xs text-muted-foreground underline-offset-2 hover:underline sm:min-h-0" onClick={() => setOuvert(true)}>
            Ajouter un commentaire (facultatif)
          </button>
        )}
      </div>
      {ouvert && (
        <textarea
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60"
          rows={2} maxLength={COMMENTAIRE_RELANCE_MAX} value={commentaire} aria-label="Commentaire de la relance (facultatif)"
          placeholder="Ex. le fournisseur a rappelé ce matin." onChange={(e) => setCommentaire(e.target.value)}
        />
      )}
      {erreur && <p className="text-xs text-destructive [overflow-wrap:anywhere]" role="alert">{erreur}</p>}
    </div>
  );
}

export function FactureDejaConnueCarte({ info }: { info: FactureDejaConnue }) {
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert" data-facture-deja-connue={info.etat}>
      <p className="flex gap-2 font-medium text-foreground">
        <Copy className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <span className="[overflow-wrap:anywhere]">{info.phrase}</span>
      </p>
      {info.lien && (
        <Link href={info.lien} className="inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
          <ExternalLink className="h-3.5 w-3.5" /> Ouvrir le dossier où elle est
        </Link>
      )}
      {info.relance && <RelancerPaiement cible={info.relance.cible} jeton={info.relance.jeton} />}
    </div>
  );
}
