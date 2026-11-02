"use client";

import * as React from "react";
import { Trash2, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { superAdminDeleteMany, apercuSuppressionGroupee, type ResultatSuppressionGroupee } from "@/lib/actions/admin-delete-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER DES ÉCRITURES « À IMPUTER » — une ou plusieurs, par le Super Admin (§118.176).
 *
 * « Tu dois me donner la main pour que je supprime carrément ça, une ou plusieurs. » La sélection
 * se fait sur la liste ; la CONFIRMATION dit, écriture par écriture, ce qui reste mais perd son lien
 * (la facture qu'elle règle, l'ordre de dépense, la dotation de caisse) — lu par le MÊME inventaire
 * que la suppression (§118.53) —, ce qu'elle retire à la trésorerie, et qu'elle se restaure depuis
 * la corbeille. Le résultat se DIT : combien sont parties, lesquelles ont été refusées et pourquoi.
 *
 * Le rafraîchissement passe par `useRafraichir` (§118.172) : tant que la liste n'est pas à jour, la
 * sélection est fermée — sinon une ligne déjà supprimée se resélectionnerait sur l'état d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EcritureAImputer {
  id: string;
  reference: string;
  label: string;
  amount: number;
  status: string;
}

type Apercu = Extract<Awaited<ReturnType<typeof apercuSuppressionGroupee>>, { elements: unknown }>["elements"][number];

export function BarreSuppressionAImputer({
  selection, ecritures, onVider,
}: {
  selection: ReadonlySet<string>;
  ecritures: readonly EcritureAImputer[];
  onVider: () => void;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [apercu, setApercu] = React.useState<Apercu[] | null>(null);
  const [lecture, setLecture] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [resultat, setResultat] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const choisies = ecritures.filter((e) => selection.has(e.id));
  const total = choisies.reduce((t, e) => t + e.amount, 0);
  const reglees = choisies.filter((e) => e.status === "SETTLED").length;

  const formulaire = () => {
    const fd = new FormData();
    fd.set("kind", "FINANCE_TRANSACTION");
    for (const e of choisies) fd.append("id", e.id);
    return fd;
  };

  const ouvrir = async () => {
    setOuvert(true); setApercu(null); setLecture(null); setResultat(null);
    const r = await apercuSuppressionGroupee(formulaire()).catch(sansBloquer("suppression-a-imputer.ouvrir.apercuSuppressionGroupee", { erreur: "Lecture impossible — réessayez." }));
    if ("erreur" in r) setLecture(r.erreur);
    else setApercu(r.elements);
  };

  const confirmer = async () => {
    setBusy(true);
    const r: ResultatSuppressionGroupee = await superAdminDeleteMany(formulaire())
      .catch(sansBloquer("suppression-a-imputer.confirmer.superAdminDeleteMany", { ok: false, error: "Suppression impossible — réessayez.", supprimes: [], refus: [] }));
    setBusy(false);
    setResultat({ ok: r.ok, texte: (r.ok ? r.message : r.error) ?? (r.ok ? "Supprimé." : "Suppression refusée.") });
    setOuvert(false);
    if (r.supprimes.length > 0) { onVider(); rafraichir(); }
  };

  return (
    <div className="space-y-2">
      {resultat && (
        <p role="status" className={resultat.ok ? "rounded-lg bg-success/10 px-3 py-2 text-xs text-foreground" : "rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"}>
          {resultat.texte}
        </p>
      )}
      {choisies.length > 0 && !ouvert && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {choisies.length} sélectionnée{choisies.length > 1 ? "s" : ""} · {formatCurrency(total)}
          </span>
          <Button variant="destructive" size="sm" onClick={ouvrir} disabled={enCours || busy}>
            <Trash2 className="h-4 w-4" /> Supprimer la sélection ({choisies.length})
          </Button>
          <Button variant="ghost" size="sm" onClick={onVider} disabled={enCours || busy}>Tout désélectionner</Button>
        </div>
      )}
      {ouvert && (
        <div role="dialog" aria-label="Confirmer la suppression des écritures" className="surface space-y-3 border-destructive/40 p-3 text-sm sm:p-4">
          <p className="font-medium">
            Supprimer {choisies.length} écriture{choisies.length > 1 ? "s" : ""} ({formatCurrency(total)}) ?
          </p>
          {lecture ? (
            <p className="text-xs text-destructive">{lecture}</p>
          ) : !apercu ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lecture de ce qui sera touché…</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {apercu.map((a) => (
                <li key={a.id} className="[overflow-wrap:anywhere]">
                  <span className="font-medium">{a.nom ?? a.id}</span>
                  {a.refus ? <span className="text-destructive"> — refusée : {a.refus}</span> : null}
                  {!a.refus && a.detache.length > 0 ? <span className="text-muted-foreground"> — perd son lien : {a.detache.join(", ")}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {reglees > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              {reglees > 1
                ? `${reglees} de ces écritures sont réglées : supprimées, elles ne compteront plus dans le solde de leur compte de trésorerie.`
                : choisies.length > 1
                  ? "Une de ces écritures est réglée : supprimée, elle ne comptera plus dans le solde de son compte de trésorerie."
                  : "Cette écriture est réglée : supprimée, elle ne comptera plus dans le solde de son compte de trésorerie."}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Restaurables depuis Administration › Corbeille, avec ce qui les cite.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={confirmer} disabled={busy || !apercu || enCours}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer définitivement ({choisies.length})
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOuvert(false)} disabled={busy}>Annuler</Button>
          </div>
        </div>
      )}
    </div>
  );
}
