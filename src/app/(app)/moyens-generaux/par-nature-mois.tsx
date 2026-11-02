"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { formatCurrency } from "@/lib/utils";
import { SANS_NATURE, moisPrecedent, moisSuivant, repartitionDuMois, titreMois, type PartDeNature } from "@/lib/general-means/ecran";
import { classerDepensesNonClassees } from "@/lib/actions/natures-moyens-generaux-actions";
import { journal } from "@/lib/journal";

/** L'événement par lequel la carte demande à la liste des dépenses de se filtrer (même page, deux composants). */
export const EVENEMENT_FILTRE_NATURE = "moyens-generaux:filtre-nature";
export interface FiltreNatureDetail { nature: string; mois: string }

/**
 * « PAR NATURE » — LE MOIS, CATÉGORIE PAR CATÉGORIE (Direction, 10/2026).
 *
 * La carte montrait l'année entière, et presque tout y tombait dans « Non classé ». Elle montre désormais UN MOIS (le
 * mois en cours d'office, ◀ ▶ pour remonter dans l'année), avec le total de chaque catégorie — article par article :
 * un ticket « café + ramettes » compte dans les deux. Un clic sur une catégorie filtre la liste des dépenses sur cette
 * catégorie et ce mois.
 *
 * Le Super Admin y trouve, tant qu'il en reste, le geste qui range l'existant avec l'IA.
 */
export function ParNatureMois({
  depenses, annee, moisInitial, nonClassees, peutRanger, departmentId, tronque,
}: {
  depenses: { date: string; parts: PartDeNature[] }[];
  annee: number;
  moisInitial: string;
  /** Combien de dépenses de l'année ont encore une part « Non classé ». */
  nonClassees: number;
  peutRanger: boolean;
  departmentId: string;
  /** La liste est-elle plafonnée ? (la carte le dit) */
  tronque: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [mois, setMois] = React.useState(moisInitial);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const lignes = React.useMemo(() => repartitionDuMois(depenses, mois), [depenses, mois]);
  const total = lignes.reduce((a, l) => a + l.total, 0);
  const max = Math.max(1, ...lignes.map((l) => l.total));
  const premier = `${annee}-01`;
  const dernier = `${annee}-12`;

  const filtrer = (nature: string) => {
    window.dispatchEvent(new CustomEvent<FiltreNatureDetail>(EVENEMENT_FILTRE_NATURE, { detail: { nature, mois } }));
    document.getElementById("depenses")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const ranger = () => {
    const fd = new FormData();
    fd.set("departmentId", departmentId);
    setBusy(true); setMsg(null);
    void classerDepensesNonClassees(fd).then((r) => {
      setBusy(false);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Rangé." : r.error ?? "Les dépenses n'ont pas été rangées." });
      if (r.ok) rafraichir();
    }).catch((e: unknown) => { journal.erreur("par-nature-mois.classerDepensesNonClassees", {}, e);
      setBusy(false);
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 p-4 pb-2">
        <CardTitle>Par nature · {titreMois(mois)}</CardTitle>
        <div className="flex items-center gap-1">
          <button
            type="button" onClick={() => setMois(moisPrecedent(mois))} disabled={mois <= premier}
            aria-label="Mois précédent"
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 sm:p-1.5"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button" onClick={() => setMois(moisSuivant(mois))} disabled={mois >= dernier}
            aria-label="Mois suivant"
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 sm:p-1.5"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <InfoBulle label="À propos de la répartition par nature">
            Chaque article d&apos;une dépense est rangé dans une catégorie du budget des moyens généraux — par l&apos;IA à la
            saisie, modifiable avant d&apos;enregistrer. « {SANS_NATURE} » : pas encore rangé. Un clic sur une catégorie
            filtre la liste des dépenses sur ce mois.
            {tronque && <> Calculé sur les dépenses les plus récentes affichées.</>}
          </InfoBulle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        {lignes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune dépense en {titreMois(mois).toLowerCase()}.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Total du mois : <strong className="tabular-nums text-foreground">{formatCurrency(total)}</strong>
            </p>
            <ul className="space-y-1">
              {lignes.map((l) => {
                const part = total > 0 ? Math.round((l.total / total) * 100) : 0;
                const sans = l.label === SANS_NATURE;
                return (
                  <li key={l.label}>
                    <button
                      type="button" onClick={() => filtrer(l.label)}
                      title={`${l.label} — ${formatCurrency(l.total)} (${part} %) · voir ces dépenses`}
                      className="grid min-h-9 w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-1.5 py-1 text-left text-sm hover:bg-secondary sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]"
                    >
                      <span className={`truncate ${sans ? "text-muted-foreground" : ""}`}>{l.label}</span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-secondary">
                        <span
                          className={`block h-full rounded-full ${sans ? "bg-muted-foreground/40" : "bg-primary"}`}
                          style={{ width: `${Math.max(2, (l.total / max) * 100)}%` }}
                        />
                      </span>
                      <span className="text-right text-xs tabular-nums text-muted-foreground">{formatCurrency(l.total)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {peutRanger && nonClassees > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              {nonClassees} dépense{nonClassees > 1 ? "s" : ""} de {annee} encore « {SANS_NATURE} ».
            </span>
            <Button size="sm" variant="outline" type="button" onClick={ranger} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Ranger avec l&apos;IA
            </Button>
          </div>
        )}
        {msg && (
          <p role="status" className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
