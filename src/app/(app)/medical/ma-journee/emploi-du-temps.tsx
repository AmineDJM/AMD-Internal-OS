"use client";

import * as React from "react";
import { Check, Clock, Loader2, Mic, Package, Pencil } from "lucide-react";
import { direVisiteNonTenue, rapporterVisite } from "@/lib/actions/tour-visit-actions";
import { useAction } from "@/components/shared/use-action";
import { ETAT_VISITE_LABELS, VUE_LABELS, type EtatVisite, type VueTournee } from "@/lib/sfe/tournee";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BARRE_ACTIONS } from "./formulaire-rapport";
import { FeuilleVisite } from "./feuille-visite";
import { indexerContextes, type FrequenceVue } from "./contexte-visite";
import type { ContexteVisite, DerniereVisiteVue, Executer, GammeVue, LigneVue } from "./types-visite";

export type { Executer, GammeVue, LigneVue } from "./types-visite";

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

/** Le ton de la pastille d'état : la couleur EST l'information, la pastille la nomme. */
export const tonEtatVisite = (e: EtatVisite): "neutral" | "success" | "warning" | "info" =>
  e === "FAITE" ? "success" : e === "PERDUE" ? "warning" : e === "ANNULEE" || e === "REPORTEE" ? "info" : "neutral";

/**
 * L'EMPLOI DU TEMPS DES AUTRES JOURS — Demain, la semaine, le mois : les onglets SECONDAIRES de « Ma journée »
 * (11/2026). « Aujourd'hui » a sa propre liste (`journee-delegue.tsx`) ; ici, le tableau qui se relit.
 *
 * ── TROIS COULEURS, PAS DEUX ────────────────────────────────────────────────────────────────
 *
 * Gris tant que le rapport n'est pas fait, vert après. Mais la fenêtre de rapport se ferme 48 h après la visite :
 * une visite du 3 sans rapport le 10 n'est plus « en attente », elle est PERDUE — d'où l'ambre, et le compte des
 * heures restantes tant qu'il en reste.
 *
 * Une ligne porte UN geste : « Commencer » une visite à faire, « Corriger » un rapport dans sa fenêtre. Les deux
 * ouvrent la feuille « Visite » — la même que la liste du jour et que la grille du plan.
 */
export function EmploiDuTemps({
  vue, lignes, gamme, stock, frequences = [], dernieres = [], peutSignalerPv = false,
}: {
  vue: VueTournee;
  lignes: LigneVue[];
  gamme: GammeVue;
  /** Le matériel en main du délégué, pour le bloc « Matériel remis » (§118.166). */
  stock: StockPourVisite;
  /** Ce que l'écran sait en plus des praticiens (lettre, fréquence, dernière fois) — la feuille les montre. */
  frequences?: FrequenceVue[];
  dernieres?: DerniereVisiteVue[];
  peutSignalerPv?: boolean;
}) {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : une fiche rouverte avant la fin montrerait la visite d'avant.
  const { busy: occupe, err, setErr, run: lancer } = useAction();
  const [ouverte, setOuverte] = React.useState<LigneVue | null>(null);
  /** La visite qu'on dit NON TENUE (reportée, annulée) — §118.193. */
  const [nonTenue, setNonTenue] = React.useState<LigneVue | null>(null);
  const run: Executer = (action, fd) => lancer(() => action(fd));
  const { contexteDe } = React.useMemo(() => indexerContextes(frequences, dernieres), [frequences, dernieres]);
  const ouvrir = (l: LigneVue) => { setErr(null); setOuverte(l); };

  const jourDe = (iso: string) =>
    new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });

  return (
    <div className="space-y-3">
      {err && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {lignes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Aucune visite prévue — {VUE_LABELS[vue].toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {lignes.map((l) => (
            <li
              key={l.id}
              className={cn(
                "flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-3 sm:flex-nowrap sm:items-center",
                l.etat === "FAITE" && "bg-success/5",
                l.etat === "PERDUE" && "bg-warning/5",
              )}
            >
              <span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground">{jourDe(l.date)}</span>
              <span className="min-w-0 flex-1 basis-48">
                <span className="block font-medium">{l.doctorName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[l.specialty, l.institution, l.wilaya].filter(Boolean).join(" · ") || "—"}
                </span>
                {l.origine === "DIRECTION" && (
                  <Badge tone="info" dot={false}>Demandée par la Direction{l.objectif ? ` — ${l.objectif}` : ""}</Badge>
                )}
                {l.origine === "UNPLANNED" && <Badge tone="neutral" dot={false}>Hors plan</Badge>}
                {l.etat === "FAITE" && l.produits.length > 0 && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{l.produits.join(" · ")}</span>
                )}
                {/* CE QUI A ÉTÉ REMIS SE VOIT sur la ligne : une erreur de quantité se repère avant la fin des 48 h. */}
                {(l.remises.materiel.length > 0 || l.remises.numeriques.length > 0) && (
                  <span className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                    <Package className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span>
                      {[
                        ...l.remises.materiel.map((m) => `${nombre(m.quantite)} ${m.libelle}`),
                        ...l.remises.numeriques.map((n) => `${n.libelle} (présenté)`),
                      ].join(" · ")}
                    </span>
                  </span>
                )}
                {l.motifNonTenue && (l.etat === "ANNULEE" || l.etat === "REPORTEE") && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">« {l.motifNonTenue} »</span>
                )}
              </span>
              <span className="flex shrink-0 flex-col items-start gap-0.5 sm:items-end">
                <Badge tone={tonEtatVisite(l.etat)}>{ETAT_VISITE_LABELS[l.etat]}</Badge>
                {l.etat === "A_FAIRE" && l.heuresRestantes <= 48 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" aria-hidden /> {l.heuresRestantes} h restantes
                  </span>
                )}
                {l.vocal && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Mic className="h-3 w-3" aria-hidden /> vocal</span>}
              </span>
              <span className="ml-auto shrink-0">
                {l.etat === "A_FAIRE" ? (
                  <Button size="sm" variant="outline" className="h-10 sm:h-8" onClick={() => ouvrir(l)} disabled={occupe}>
                    Commencer
                  </Button>
                ) : l.etat === "FAITE" && l.heuresRestantes > 0 ? (
                  // CORRIGER DANS LA FENÊTRE : une quantité remise mal tapée se rattrape ici, et le stock suit (§118.166).
                  <Button size="sm" variant="ghost" className="h-10 sm:h-8" onClick={() => ouvrir(l)} disabled={occupe}>
                    <Pencil className="h-3.5 w-3.5" /> Corriger
                  </Button>
                ) : l.etat === "FAITE" ? (
                  <Check className="h-4 w-4 text-success" aria-label="Rapport fait" />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <FeuilleRapportVisite
        ouverte={ouverte} onClose={() => setOuverte(null)} gamme={gamme} stock={stock} executer={run} occupe={occupe} err={err}
        contexte={ouverte ? contexteDe(ouverte.doctorId) : null} peutSignalerPv={peutSignalerPv}
        onNonTenue={(l) => { setErr(null); setOuverte(null); setNonTenue(l); }}
      />
      <FeuilleNonTenue visite={nonTenue} onClose={() => setNonTenue(null)} executer={run} occupe={occupe} err={err} />
    </div>
  );
}

/**
 * LE RAPPORT D'UNE VISITE PLANIFIÉE — la feuille « Visite », ouverte depuis « Ma journée » ET depuis la grille du plan
 * de tournée (Direction, 06/10). Deux écrans, une porte : la même action (`rapporterVisite`), le même formulaire, les
 * mêmes exigences. En écrire une seconde pour la grille ferait diverger les deux saisies au premier champ ajouté.
 */
export function FeuilleRapportVisite({
  ouverte, onClose, gamme, stock, executer, occupe, err, onNonTenue, contexte = null, peutSignalerPv = false,
}: {
  ouverte: LigneVue | null;
  onClose: () => void;
  gamme: GammeVue;
  stock: StockPourVisite;
  executer: Executer;
  occupe: boolean;
  err: string | null;
  /** « Elle n'a pas eu lieu » (§118.193), offert en lien discret dans la feuille quand l'écran hôte le passe. */
  onNonTenue?: (l: LigneVue) => void;
  contexte?: ContexteVisite | null;
  peutSignalerPv?: boolean;
}) {
  return (
    <FeuilleVisite
      ouverte={ouverte ? { sorte: "PLANIFIEE", ligne: ouverte } : null}
      contexte={contexte}
      onClose={onClose}
      gamme={gamme}
      stock={stock}
      occupe={occupe}
      err={err}
      enregistrer={(fd) => executer(rapporterVisite, fd)}
      onNonTenue={onNonTenue}
      peutSignalerPv={peutSignalerPv}
    />
  );
}

/** LA VISITE QUI N'A PAS EU LIEU (§118.193) — la même feuille pour « Ma journée » et la grille du plan. */
export function FeuilleNonTenue({
  visite, onClose, executer, occupe, err,
}: {
  visite: LigneVue | null;
  onClose: () => void;
  executer: Executer;
  occupe: boolean;
  err: string | null;
}) {
  const [motif, setMotif] = React.useState("");
  // Une feuille rouverte sur une autre visite repart d'un motif vide.
  React.useEffect(() => { setMotif(""); }, [visite?.id]);
  return (
    <Sheet
      open={visite !== null}
      onClose={onClose}
      title={visite ? `La visite n'a pas eu lieu — ${visite.doctorName}` : ""}
      description={visite ? `Visite du ${new Date(visite.date).toLocaleDateString("fr-FR")}` : ""}
      width="md"
    >
      {visite && (
        <form
          className="space-y-3"
          action={async (fd) => {
            fd.set("visitId", visite.id);
            if (await executer(direVisiteNonTenue, fd)) onClose();
          }}
        >
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 flex items-center gap-1 text-sm font-medium">
              Ce qui s&apos;est passé
              <InfoBulle label="Pourquoi le dire" align="left">
                Reportée ou annulée, la visite sort du dénominateur de votre plan — à condition de le dire, motif à l&apos;appui.
              </InfoBulle>
            </legend>
            {/* Deux grandes cases côte à côte : un choix d'un seul pouce. */}
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-col sm:gap-1.5">
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-0 sm:border-0 sm:px-0 sm:has-[:checked]:bg-transparent">
                <input type="radio" name="issue" value="POSTPONED" defaultChecked className="h-5 w-5 sm:h-4 sm:w-4" /> Reportée
              </label>
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-0 sm:border-0 sm:px-0 sm:has-[:checked]:bg-transparent">
                <input type="radio" name="issue" value="CANCELLED" className="h-5 w-5 sm:h-4 sm:w-4" /> Annulée
              </label>
            </div>
          </fieldset>
          <div>
            <Label htmlFor="non-tenue-motif">Pourquoi</Label>
            <Textarea id="non-tenue-motif" name="motif" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)}
              placeholder="Le Dr Amrani était en congé ; je le revois mardi prochain." />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className={BARRE_ACTIONS}>
            <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" onClick={onClose} disabled={occupe}>Annuler</Button>
            <BoutonDecisif type="submit" className="h-12 flex-1 sm:h-10" disabled={occupe || motif.trim().length === 0} confirmation="dire que la visite n’a pas eu lieu">
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
            </BoutonDecisif>
          </div>
        </form>
      )}
    </Sheet>
  );
}
