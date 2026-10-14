"use client";

/**
 * LA FICHE D'UNE DEMANDE, EN PANNEAU LATÉRAL (maquette « onglets » validée, Direction 10/2026) — ouverte depuis
 * « Demandes Ad & Pro » et depuis le lot de l'onglet « Intégration 2026 », sans quitter l'écran.
 *
 * Demandeur, date, lieu, lignes du fichier « Dépenses AP », postes payés et leur imputation ; pour une demande portée par
 * le lot 2026, ses pièces attendues / manquantes avec le dépôt (plusieurs fichiers) et le rattachement d'une pièce déjà
 * dans la plateforme — les MÊMES gestes que la fiche complète (`PiecesHistorique`, actions d'intégration). Le bloc est
 * lu à l'ouverture (`ficheHistoriqueIntegration`), relu après chaque dépôt. « Ouvrir la fiche » mène à la demande.
 */

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PiecesHistorique } from "@/components/ad-pro/pieces-historique";
import { ficheHistoriqueIntegration } from "@/lib/actions/integration-adpro-actions";
import type { BlocHistorique } from "@/lib/budget-marketing/integration-serveur";
import { LIBELLE_STATUT_DEMANDE, type DemandeVue } from "@/lib/budget-marketing/demandes-vue";

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");
const jour = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const moisDe = (iso: string | null | undefined) => (iso ? MOIS[Number(iso.slice(5, 7)) - 1] ?? "" : "");

/** Ce que le panneau sait d'une demande avant de lire son bloc « Historique 2026 ». */
export interface FicheOuverte {
  /** `TYPE:id`. */
  cle: string;
  libelle: string;
  nature: string;
  href: string | null;
  mode: "CREEE" | "COMPLETEE" | null;
  lignes: number[];
  /** La ligne complète de l'onglet Demandes (postes, montants, demandeur) — absente depuis l'onglet Intégration. */
  demande?: DemandeVue;
}

export function FicheDemandeSheet({ fiche, onClose }: { fiche: FicheOuverte | null; onClose: () => void }) {
  const [bloc, setBloc] = React.useState<BlocHistorique | null>(null);
  const [chargement, setChargement] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const demandee = React.useRef<string | null>(null);

  const lire = React.useCallback(async (cle: string) => {
    const [type, id] = cle.split(":");
    if (!type || !id) return;
    demandee.current = cle;
    setChargement(true);
    setErreur(null);
    try {
      const fd = new FormData();
      fd.set("type", type);
      fd.set("id", id);
      const r = await ficheHistoriqueIntegration(fd);
      if (demandee.current !== cle) return; // une autre fiche a été ouverte entre-temps
      if (!r.ok) { setErreur(r.error ?? "Lecture impossible."); setBloc(null); return; }
      setBloc(r.bloc ?? null);
    } finally {
      if (demandee.current === cle) setChargement(false);
    }
  }, []);

  React.useEffect(() => {
    setBloc(null);
    setErreur(null);
    if (fiche && fiche.mode) void lire(fiche.cle);
    else demandee.current = null;
  }, [fiche, lire]);

  if (!fiche) return null;
  const d = fiche.demande;
  const lignes = bloc?.lignes.length ? bloc.lignes : fiche.lignes;
  const demandeur = bloc?.demandeurAffiche ?? d?.demandeur ?? null;
  const date = d?.date ?? bloc?.postes.map((p) => p.payeLe).filter(Boolean).sort()[0] ?? null;
  const postes = d
    ? d.postes.map((p) => ({ id: p.id, libelle: p.poste, imputation: p.categorie, montant: p.historique ? p.regle : p.accorde, detail: p.historique ? `payé le ${jour(p.date)}${p.historique.ligne ? ` · L${p.historique.ligne}` : ""}` : `${p.statut}${p.regle > 0.5 ? ` · réglé ${fmt(p.regle)}` : p.engage > 0.5 ? ` · engagé ${fmt(p.engage)}` : ""}` }))
    : (bloc?.postes ?? []).map((p) => ({ id: p.id, libelle: p.libelle, imputation: p.imputation ?? "—", montant: p.montant, detail: `payé le ${jour(p.payeLe)}${p.ligne ? ` · L${p.ligne}` : ""}` }));

  return (
    <Sheet
      open
      onClose={onClose}
      title={fiche.libelle}
      description={d ? `${d.nature}${d.lieu ? ` · ${d.lieu}` : ""}` : fiche.nature}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
          {fiche.href && <Link href={fiche.href} className="inline-flex h-10 items-center rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:h-9">Ouvrir la fiche de la demande</Link>}
        </div>
      )}
    >
      <div className="grid grid-cols-1 gap-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {fiche.mode === "CREEE" && <Badge tone="purple">Historique 2026</Badge>}
          {fiche.mode === "COMPLETEE" && <Badge tone="info">Complétée</Badge>}
          {d && <Badge tone={d.statut === "PAYEE" ? "success" : d.statut === "ENGAGEE" ? "warning" : "neutral"}>{LIBELLE_STATUT_DEMANDE[d.statut]}</Badge>}
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Demandeur</dt><dd className="text-right [overflow-wrap:anywhere]">{demandeur ?? "—"}</dd>
          <dt className="text-muted-foreground">Date</dt><dd className="text-right">{date ? `${jour(date)} (${moisDe(date)})` : "—"}</dd>
          {d?.lieu && (<><dt className="text-muted-foreground">Lieu</dt><dd className="text-right [overflow-wrap:anywhere]">{d.lieu}</dd></>)}
          {lignes.length > 0 && (<><dt className="text-muted-foreground">Fichier Dépenses AP</dt><dd className="text-right">ligne{lignes.length > 1 ? "s" : ""} {lignes.map((l) => `L${l}`).join(" + ")}</dd></>)}
          {fiche.mode && (<><dt className="text-muted-foreground">Origine</dt><dd className="text-right">{fiche.mode === "CREEE" ? "créée par l'intégration, sans circuit" : "demande existante, complétée"}</dd></>)}
          {d ? (
            <>
              <dt className="text-muted-foreground">Accordé</dt><dd className="text-right tabular-nums">{fmt(d.accorde)} DZD</dd>
              {d.engage > 0.5 && (<><dt className="text-muted-foreground">Engagé</dt><dd className="text-right tabular-nums">{fmt(d.engage)} DZD</dd></>)}
              <dt className="text-muted-foreground">Réglé</dt><dd className="text-right font-semibold tabular-nums">{fmt(d.regle)} DZD</dd>
            </>
          ) : bloc ? (
            <><dt className="text-muted-foreground">Payé</dt><dd className="text-right font-semibold tabular-nums">{fmt(bloc.montant)} DZD</dd></>
          ) : null}
        </dl>

        <div className="grid gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Postes · imputation</h3>
          {postes.length === 0 ? (
            <p className="text-muted-foreground">{chargement ? "Lecture…" : "Aucun poste."}</p>
          ) : postes.map((p) => (
            <div key={p.id} className="grid gap-0.5 rounded-lg border border-border bg-secondary/40 px-3 py-2">
              <div className="flex justify-between gap-3">
                <b className="min-w-0 font-medium [overflow-wrap:anywhere]">{p.libelle}</b>
                <b className="whitespace-nowrap tabular-nums">{fmt(p.montant)}</b>
              </div>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.imputation} · {p.detail}</span>
            </div>
          ))}
        </div>

        {fiche.mode && (
          chargement && !bloc ? (
            <p className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture des pièces…</p>
          ) : erreur ? (
            <p className="text-destructive" role="alert">{erreur}</p>
          ) : bloc ? (
            <PiecesHistorique
              demandeRowId={bloc.demandeRowId} pieces={bloc.pieces} manquantes={bloc.manquantes}
              rattachables={bloc.rattachables} peutJoindre={bloc.peutJoindre} apres={() => void lire(fiche.cle)}
            />
          ) : null
        )}
        {!fiche.mode && (
          <p className="text-xs text-muted-foreground">Demande du circuit normal : ses pièces, ses bons de commande et ses ordres se suivent sur sa fiche.</p>
        )}
      </div>
    </Sheet>
  );
}
