"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Check, Loader2 } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { cn } from "@/lib/utils";
import { repondreActualisationSoldes } from "@/lib/actions/actualisation-soldes-actions";
import { LIBELLE_ETAT_LIGNE, lireReponse, type EtatLigne, type SaisieLigne } from "@/lib/finance/actualisation-soldes";

export interface LigneEcran {
  id: string;
  compte: string;
  banque: string | null;
  etat: EtatLigne;
  /** L'ancrage au moment de la demande. */
  ancrageDemande: { solde: number; jour: string };
  /** L'ancrage aujourd'hui (il a pu être corrigé entre-temps). */
  ancrageActuel: { solde: number; jour: string };
  /** Le solde affiché sur Banque & paiements : ancrage + écritures réglées postérieures. */
  soldeActuel: number | null;
  nouveau: { solde: number; jour: string } | null;
  traitePar: string | null;
  traiteLe: string | null;
}

const dzd = (n: number) => `${n.toLocaleString("fr-FR")} DZD`;
const jourFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** « 2 271 953,50 » → 2271953.5 ; vide → null. */
function lireMontant(s: string): number | null {
  const net = s.replace(/[\s  ]/g, "").replace(",", ".");
  if (!net) return null;
  const n = Number(net);
  return Number.isFinite(n) ? n : null;
}

/**
 * LA RÉPONSE, COMPTE PAR COMPTE — le solde du nouveau relevé et sa date (aujourd'hui par défaut), ou
 * « pas encore reçu ». La règle est LUE ici avant l'envoi (`lireReponse`, la même que le serveur) :
 * le refus arrive sous les yeux, pas après un aller-retour.
 */
export function FormulaireActualisation({ demandeId, lignes, peutRepondre, aujourdhui }: {
  demandeId: string;
  lignes: LigneEcran[];
  peutRepondre: boolean;
  aujourdhui: string;
}) {
  const { rafraichir } = useRafraichir();
  const ouvertes = lignes.filter((l) => l.etat !== "ACTUALISE");
  const [choix, setChoix] = React.useState<Record<string, "ACTUALISE" | "NON_RECU">>(() =>
    Object.fromEntries(ouvertes.map((l) => [l.id, "ACTUALISE"])),
  );
  const [soldes, setSoldes] = React.useState<Record<string, string>>({});
  const [dates, setDates] = React.useState<Record<string, string>>(() => Object.fromEntries(ouvertes.map((l) => [l.id, aujourdhui])));
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [fait, setFait] = React.useState<string | null>(null);

  const envoyer = async () => {
    setErreur(null);
    const saisies: SaisieLigne[] = ouvertes.map((l) => ({
      ligneId: l.id,
      choix: choix[l.id] ?? "ACTUALISE",
      solde: lireMontant(soldes[l.id] ?? ""),
      date: dates[l.id] ?? null,
    }));
    const lecture = lireReponse(
      lignes.map((l) => ({ id: l.id, compte: l.compte, etat: l.etat, jourAncrageActuel: l.ancrageActuel.jour })),
      saisies, aujourdhui,
    );
    if (!lecture.ok) { setErreur(lecture.error); return; }
    setBusy(true);
    const fd = new FormData();
    fd.set("id", demandeId);
    fd.set("lignes", JSON.stringify(saisies));
    try {
      const r = await repondreActualisationSoldes(fd);
      if (r.ok) { setFait(r.message ?? "Réponse enregistrée."); rafraichir(); }
      else setErreur(r.error ?? "La réponse n'a pas été enregistrée.");
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {lignes.map((l) => {
          const ouverte = l.etat !== "ACTUALISE";
          const c = choix[l.id] ?? "ACTUALISE";
          return (
            <li key={l.id} className="rounded-2xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]">{l.compte}</p>
                  {l.banque && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.banque}</p>}
                </div>
                <Badge tone={l.etat === "ACTUALISE" ? "success" : l.etat === "NON_RECU" ? "warning" : "neutral"}>{LIBELLE_ETAT_LIGNE[l.etat]}</Badge>
              </div>

              <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <div className="rounded-lg bg-secondary/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Relevé au moment de la demande</dt>
                  <dd className="font-medium tabular-nums">{dzd(l.ancrageDemande.solde)} <span className="text-xs font-normal text-muted-foreground">au {jourFr(l.ancrageDemande.jour)}</span></dd>
                </div>
                <div className="rounded-lg bg-secondary/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Solde affiché aujourd&apos;hui</dt>
                  <dd className="font-medium tabular-nums">{l.soldeActuel === null ? "—" : dzd(l.soldeActuel)}</dd>
                </div>
                <div className="rounded-lg bg-secondary/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Nouveau relevé</dt>
                  <dd className="font-medium tabular-nums">
                    {l.nouveau ? <>{dzd(l.nouveau.solde)} <span className="text-xs font-normal text-muted-foreground">au {jourFr(l.nouveau.jour)}</span></> : "—"}
                  </dd>
                </div>
              </dl>
              {l.traitePar && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {l.etat === "ACTUALISE" ? "Actualisé" : "Signalé « pas encore reçu »"} par {l.traitePar}
                  {l.traiteLe ? ` le ${new Date(l.traiteLe).toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "short", timeStyle: "short" })}` : ""}.
                </p>
              )}

              {ouverte && peutRepondre && !fait && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Réponse pour ${l.compte}`}>
                    {(["ACTUALISE", "NON_RECU"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={c === v}
                        onClick={() => setChoix((p) => ({ ...p, [l.id]: v }))}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-sm font-medium",
                          c === v ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-secondary",
                        )}
                      >
                        {v === "ACTUALISE" ? "Saisir le nouveau solde" : "Relevé pas encore reçu"}
                      </button>
                    ))}
                  </div>
                  {c === "ACTUALISE" && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`solde-${l.id}`}>Solde du relevé (DZD)</Label>
                        <Input
                          id={`solde-${l.id}`} inputMode="decimal" placeholder="Ex. 2 271 953"
                          value={soldes[l.id] ?? ""} onChange={(e) => setSoldes((p) => ({ ...p, [l.id]: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`date-${l.id}`}>Date du relevé (fin de journée)</Label>
                        <Input
                          id={`date-${l.id}`} type="date" min={l.ancrageActuel.jour} max={aujourdhui}
                          value={dates[l.id] ?? aujourdhui} onChange={(e) => setDates((p) => ({ ...p, [l.id]: e.target.value }))}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {peutRepondre && ouvertes.length > 0 && !fait && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Le solde saisi devient le nouveau relevé du compte : Banque &amp; paiements l&apos;affiche aussitôt, en n&apos;ajoutant que les paiements réglés après cette date.
            Celui qui a demandé et les Super Admins sont prévenus.
          </p>
          <BoutonDecisif className="w-full sm:w-auto" disabled={busy} onClick={envoyer}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer et prévenir
          </BoutonDecisif>
        </div>
      )}
      {!peutRepondre && ouvertes.length > 0 && (
        <p className="rounded-lg bg-secondary/60 px-3 py-2 text-sm text-muted-foreground">En attente de la réponse des Finances.</p>
      )}
      {erreur && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{erreur}</p>}
      {fait && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground">{fait}</p>}
    </div>
  );
}
