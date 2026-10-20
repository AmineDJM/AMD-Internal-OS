"use client";

import * as React from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { proposerPostesDepuisDescription } from "@/lib/actions/ad-pro-postes-luna-actions";
import {
  ABSTENTIONS, DESCRIPTION_MIN, badgePieceAttendue, detailDuPoste, nomAffiche, personnesDuPoste, resumeEvenement, resumeHebergement,
  type EvenementLu, type PropositionPostes,
} from "@/lib/ad-pro/postes-luna";
import { ITEM_KIND_LABELS } from "@/lib/ad-pro-items";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DESCRIPTION D'UNE DEMANDE, ET CE QUE LUNA EN TIRE (maquette « luna-postes », validée 10/2026).
 *
 * On colle le mail d'organisation (ou on décrit la demande) ; en quittant le champ, Luna le lit et
 * propose l'événement et ses postes. RIEN ne s'écrit tant qu'on n'a pas cliqué « Reprendre » : les
 * champs VIDES du formulaire se remplissent (marqués « Luna » jusqu'au premier geste), et les postes
 * gardés se créent avec la demande par l'action ordinaire d'ajout de poste. « Annuler » défait tout :
 * les champs que Luna a remplis et que personne n'a touchés se vident, les postes partent, la
 * proposition revient. Sans IA (coupée, non configurée), la carte n'apparaît pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Etat =
  | { phase: "repos" }
  | { phase: "lecture" }
  | { phase: "proposition"; proposition: PropositionPostes }
  | { phase: "repris"; proposition: PropositionPostes; champs: number }
  | { phase: "panne"; error: string };

export function DescriptionLuna({ defaultValue, onReprendre, onAnnuler }: {
  defaultValue?: string;
  /** Remplit les champs vides et garde les postes ; rend le nombre de champs remplis. */
  onReprendre: (p: PropositionPostes) => number;
  /** Défait la reprise : vide les champs encore marqués « Luna », retire les postes. */
  onAnnuler: () => void;
}) {
  const [etat, setEtat] = React.useState<Etat>({ phase: "repos" });
  const derniere = React.useRef<string>("");

  async function lire(texte: string) {
    const t = texte.trim();
    if (t.replace(/\s+/g, " ").length < DESCRIPTION_MIN || t === derniere.current) return;
    if (etat.phase === "repris" || etat.phase === "lecture") return;
    derniere.current = t;
    setEtat({ phase: "lecture" });
    const fd = new FormData();
    fd.set("description", t);
    try {
      const r = await proposerPostesDepuisDescription(fd);
      if (r.ok) setEtat({ phase: "proposition", proposition: r.proposition });
      else setEtat(ABSTENTIONS.includes(r.raison) ? { phase: "repos" } : { phase: "panne", error: r.error });
    } catch {
      setEtat({ phase: "panne", error: "Luna n'a pas pu lire la description." });
    }
  }

  const retirerPoste = (i: number) => setEtat((e) => e.phase === "proposition"
    ? { phase: "proposition", proposition: { ...e.proposition, postes: e.proposition.postes.filter((_, j) => j !== i) } }
    : e);

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          Description
          <InfoBulle label="À quoi sert la description" align="left">
            Collez le mail ou décrivez la demande : Luna en tire l&apos;événement et les postes. Vous validez avant toute création.
          </InfoBulle>
        </Label>
        <Textarea name="description" defaultValue={defaultValue} rows={6} required onBlur={(e) => void lire(e.currentTarget.value)} />
      </div>

      {etat.phase === "lecture" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-luna" /> Luna lit la description…
        </p>
      )}
      {etat.phase === "panne" && <p className="text-xs text-muted-foreground" aria-live="polite">{etat.error}</p>}

      {etat.phase === "proposition" && (
        <div className="overflow-hidden rounded-lg border border-border bg-card" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-luna-soft px-3 py-2.5">
            <p className="flex items-center text-[0.8125rem] font-semibold">
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-luna" aria-hidden />
              Luna propose {etat.proposition.postes.length} poste{etat.proposition.postes.length > 1 ? "s" : ""}
            </p>
            <p className="min-w-0 text-[0.8125rem] tabular-nums [overflow-wrap:anywhere]">{resumeEvenement(etat.proposition.evenement)}</p>
          </div>
          {etat.proposition.postes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-border text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">Poste</th>
                    <th className="px-3 py-2 font-semibold">Détail</th>
                    <th className="px-3 py-2 font-semibold">Personnes</th>
                    <th className="w-8 px-1 py-2"><span className="sr-only">Retirer</span></th>
                  </tr>
                </thead>
                <tbody>
                  {etat.proposition.postes.map((p, i) => {
                    const sousLignes = [
                      ...p.hebergements.map((h) => ({ nom: nomAffiche(h), detail: resumeHebergement(h) })),
                      ...p.voyageurs.map((v) => ({ nom: nomAffiche(v), detail: v.resume })),
                    ];
                    const badge = badgePieceAttendue(p);
                    return (
                      <React.Fragment key={`${p.nature}-${i}`}>
                        <tr className={sousLignes.length > 0 ? "" : "border-b border-border"}>
                          <td className="px-3 py-2 align-top font-semibold">{ITEM_KIND_LABELS[p.nature]}</td>
                          <td className="px-3 py-2 align-top" title={p.libelle}>
                            {detailDuPoste(p)}
                            {badge && (
                              <span className="ml-1.5 whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-[0.6875rem] text-warning" title={p.piecesAttendues.join(" ; ")}>
                                {badge}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top tabular-nums">{personnesDuPoste(p)}</td>
                          <td className="px-1 py-1.5 align-top">
                            <button type="button" onClick={() => retirerPoste(i)} aria-label={`Retirer le poste ${ITEM_KIND_LABELS[p.nature]}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                              <X className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                        {sousLignes.map((l, j) => (
                          <tr key={j} className={j === sousLignes.length - 1 ? "border-b border-border" : ""}>
                            <td className="py-1 pl-7 pr-3 text-xs text-muted-foreground">{l.nom}</td>
                            <td colSpan={3} className="px-3 py-1 text-xs tabular-nums text-muted-foreground">{l.detail}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {etat.proposition.remarques.length > 0 && (
            <p className="border-b border-border px-3 py-2 text-xs text-warning">À vérifier : {etat.proposition.remarques.join(" ")}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Montants à saisir sur chaque poste.
              <InfoBulle label="Ce que fait « Reprendre »" align="left">
                Luna remplit seulement les champs vides de l&apos;événement et prépare les postes avec leurs fiches voyageurs et
                hôtellerie. Vous pouvez retirer une ligne avant de reprendre. Sans IA configurée, la demande se crée normalement.
              </InfoBulle>
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEtat({ phase: "repos" })}>Ignorer</Button>
              <Button type="button" size="sm" onClick={() => {
                const p = etat.proposition;
                setEtat({ phase: "repris", proposition: p, champs: onReprendre(p) });
              }}>Reprendre</Button>
            </span>
          </div>
        </div>
      )}

      {etat.phase === "repris" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-[0.8125rem] text-success" aria-live="polite">
          <Check className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Repris — {etat.champs} champ{etat.champs > 1 ? "s" : ""} rempli{etat.champs > 1 ? "s" : ""}
            {etat.proposition.postes.length > 0
              ? `, ${etat.proposition.postes.length} poste${etat.proposition.postes.length > 1 ? "s" : ""} ${etat.proposition.postes.length > 1 ? "seront créés" : "sera créé"} avec la demande.`
              : "."}
          </span>
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => { onAnnuler(); setEtat({ phase: "proposition", proposition: etat.proposition }); }}>
            Annuler
          </Button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Remplir (et vider) les champs ─────────────────────────────

type Champ = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Le marqueur « Luna » vit sur le bloc du champ (libellé + champ) : la feuille de style le dessine (`globals.css`). */
function marquer(el: Champ) {
  const bloc = el.parentElement;
  if (!bloc) return;
  bloc.dataset.luna = "1";
  const oter = () => { delete bloc.dataset.luna; };
  el.addEventListener("input", oter, { once: true });
  el.addEventListener("change", oter, { once: true });
}

function poser(form: HTMLFormElement, nom: string, valeur: string | number | null): boolean {
  if (valeur == null || valeur === "") return false;
  const el = form.elements.namedItem(nom);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
  if (el.value.trim() !== "") return false;
  let v = String(valeur);
  if (el instanceof HTMLSelectElement) {
    const plie = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    const opt = Array.from(el.options).find((o) => o.value && plie(o.value) === plie(v));
    if (!opt) return false;
    v = opt.value;
  }
  el.value = v;
  marquer(el);
  return true;
}

/** Remplit les champs VIDES de l'événement — jamais ce que la personne a déjà saisi. Rend le nombre de champs remplis. */
export function remplirChampsVidesEvenement(form: HTMLFormElement, e: EvenementLu): number {
  const champs: [string, string | number | null][] = [
    ["name", e.nom], ["type", e.type], ["scope", e.portee], ["format", e.format],
    ["startDate", e.dateDebut], ["endDate", e.dateFin], ["location", e.lieu], ["city", e.ville],
    ["country", e.pays], ["specialty", e.specialite], ["capacity", e.capacite],
  ];
  return champs.filter(([nom, v]) => poser(form, nom, v)).length;
}

/** « Annuler » : vide les champs que Luna a remplis et que personne n'a touchés depuis. */
export function viderChampsLuna(form: HTMLFormElement): void {
  for (const bloc of Array.from(form.querySelectorAll<HTMLElement>('[data-luna="1"]'))) {
    const el = bloc.querySelector<Champ>("input, select, textarea");
    if (el) el.value = "";
    delete bloc.dataset.luna;
  }
}
