"use client";

import * as React from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { proposerPostesDepuisDescription } from "@/lib/actions/ad-pro-postes-luna-actions";
import {
  ABSTENTIONS, DESCRIPTION_MIN, personnesDuPoste, plier, resumeHebergement,
  type EvenementLu, type PostePropose, type PropositionPostes,
} from "@/lib/ad-pro/postes-luna";
import { ITEM_KIND_LABELS } from "@/lib/ad-pro-items";
import { nomComplet } from "@/lib/ad-pro/voyageurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DESCRIPTION D'UNE DEMANDE, ET CE QUE LUNA EN TIRE (maquette « luna-postes », 10/2026).
 *
 * On colle le mail d'organisation (ou on décrit la demande) ; en quittant le champ, Luna le lit et
 * propose l'événement et ses postes. RIEN ne s'écrit tant qu'on n'a pas cliqué « Reprendre » : les
 * champs VIDES du formulaire se remplissent, et les postes gardés se créent avec la demande par
 * l'action ordinaire d'ajout de poste. Sans IA (coupée, non configurée), la carte n'apparaît pas :
 * la description reste un champ comme un autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Etat =
  | { phase: "repos" }
  | { phase: "lecture" }
  | { phase: "proposition"; proposition: PropositionPostes }
  | { phase: "repris"; champs: number; postes: number }
  | { phase: "panne"; error: string };

const jjmmaaaa = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);

function resumeEvenement(e: EvenementLu): string {
  const dates = e.dateDebut && e.dateFin && e.dateFin !== e.dateDebut ? `${jjmmaaaa(e.dateDebut)} → ${jjmmaaaa(e.dateFin)}` : jjmmaaaa(e.dateDebut);
  const lieu = [e.lieu, e.ville && !(e.lieu ?? "").includes(e.ville) ? e.ville : null].filter(Boolean).join(", ");
  return [e.nom, [dates, e.horaire].filter(Boolean).join(" "), lieu, e.capacite ? `${e.capacite} pax` : null].filter(Boolean).join(" · ");
}

/** Le détail d'un poste à l'écran — sans les lignes « Pièce attendue », que le badge dit déjà. */
function detailDuPoste(p: PostePropose): string {
  const notes = (p.notes ?? "").split("\n").filter((l) => !l.startsWith("Pièce attendue")).join(" ");
  return [p.libelle, notes].filter(Boolean).join(" · ");
}

export function DescriptionLuna({ defaultValue, onReprendre, onRetirer }: {
  defaultValue?: string;
  /** Remplit les champs vides et garde les postes ; rend le nombre de champs remplis. */
  onReprendre: (p: PropositionPostes) => number;
  /** Retire les postes repris (les champs remplis restent, modifiables). */
  onRetirer: () => void;
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
            Collez le mail d&apos;organisation ou décrivez la demande : Luna en tire l&apos;événement et les postes (salle, repas,
            hôtellerie, billetterie). Rien n&apos;est créé sans votre accord.
          </InfoBulle>
        </Label>
        <Textarea name="description" defaultValue={defaultValue} rows={5} required onBlur={(e) => void lire(e.currentTarget.value)} />
      </div>

      {etat.phase === "lecture" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Luna lit la description…</p>
      )}
      {etat.phase === "panne" && <p className="text-xs text-muted-foreground" aria-live="polite">{etat.error}</p>}

      {etat.phase === "proposition" && (
        <div className="overflow-hidden rounded-lg border border-border bg-card" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-accent px-3 py-2.5">
            <p className="text-sm font-semibold">
              Luna propose {etat.proposition.postes.length} poste{etat.proposition.postes.length > 1 ? "s" : ""}
            </p>
            <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{resumeEvenement(etat.proposition.evenement)}</p>
          </div>
          {etat.proposition.postes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">Poste</th>
                    <th className="px-3 py-2 font-semibold">Détail</th>
                    <th className="px-3 py-2 font-semibold">Personnes</th>
                    <th className="w-8 px-1 py-2"><span className="sr-only">Retirer</span></th>
                  </tr>
                </thead>
                <tbody>
                  {etat.proposition.postes.map((p, i) => (
                    <React.Fragment key={`${p.nature}-${i}`}>
                      <tr className={p.voyageurs.length + p.hebergements.length > 0 ? "" : "border-b border-border"}>
                        <td className="px-3 py-2 align-top font-medium">{ITEM_KIND_LABELS[p.nature]}</td>
                        <td className="px-3 py-2 align-top">
                          {detailDuPoste(p)}
                          {p.piecesAttendues.length > 0 && (
                            <span className="ml-1.5 whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning" title={p.piecesAttendues.join(" ; ")}>
                              {/identit|\bPI\b|passeport/i.test(p.piecesAttendues.join(" ")) ? "PI à joindre" : "Pièce à joindre"}
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
                      {p.hebergements.map((h, j) => (
                        <tr key={`h${j}`} className={j === p.hebergements.length - 1 ? "border-b border-border" : ""}>
                          <td className="py-1 pl-7 pr-3 text-xs text-muted-foreground">{nomComplet(h)}</td>
                          <td colSpan={3} className="px-3 py-1 text-xs tabular-nums text-muted-foreground">{[h.hotel, h.ville].filter(Boolean).join(", ")} · {resumeHebergement(h)}</td>
                        </tr>
                      ))}
                      {p.voyageurs.map((v, j) => (
                        <tr key={`v${j}`} className={j === p.voyageurs.length - 1 ? "border-b border-border" : ""}>
                          <td className="py-1 pl-7 pr-3 text-xs text-muted-foreground">{nomComplet(v)}</td>
                          <td colSpan={3} className="px-3 py-1 text-xs tabular-nums text-muted-foreground">{v.resume}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
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
                hôtellerie, créés avec la demande. Retirez une ligne avant de reprendre si elle ne convient pas.
              </InfoBulle>
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEtat({ phase: "repos" })}>Ignorer</Button>
              <Button type="button" size="sm" onClick={() => {
                const p = etat.proposition;
                const champs = onReprendre(p);
                setEtat({ phase: "repris", champs, postes: p.postes.length });
              }}>Reprendre</Button>
            </span>
          </div>
        </div>
      )}

      {etat.phase === "repris" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success" aria-live="polite">
          <span className="min-w-0 flex-1">
            Repris — {etat.champs} champ{etat.champs > 1 ? "s" : ""} rempli{etat.champs > 1 ? "s" : ""}
            {etat.postes > 0 ? `, ${etat.postes} poste${etat.postes > 1 ? "s" : ""} ${etat.postes > 1 ? "seront créés" : "sera créé"} avec la demande.` : "."}
          </span>
          {etat.postes > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={() => { onRetirer(); setEtat({ phase: "repris", champs: etat.champs, postes: 0 }); }}>
              Retirer les postes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Remplir les champs vides ─────────────────────────────

/** Les classes du champ rempli par Luna — retirées dès qu'on le touche. */
const MARQUE_LUNA = ["ring-2", "ring-primary/30", "bg-accent/40"];

function poser(form: HTMLFormElement, nom: string, valeur: string | number | null): boolean {
  if (valeur == null || valeur === "") return false;
  const el = form.elements.namedItem(nom);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
  if (el.value.trim() !== "") return false;
  let v = String(valeur);
  if (el instanceof HTMLSelectElement) {
    const opt = Array.from(el.options).find((o) => o.value && plier(o.value) === plier(v));
    if (!opt) return false;
    v = opt.value;
  }
  el.value = v;
  el.classList.add(...MARQUE_LUNA);
  el.addEventListener("input", () => el.classList.remove(...MARQUE_LUNA), { once: true });
  el.addEventListener("change", () => el.classList.remove(...MARQUE_LUNA), { once: true });
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
