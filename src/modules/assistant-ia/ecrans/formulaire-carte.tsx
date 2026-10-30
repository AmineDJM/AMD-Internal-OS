"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { sansBloquer } from "@/lib/journal";
import type { ChampFormulaire, FormulaireCarte, Saisie, Saisies } from "@/platform/ia/capacites/formulaire";

/**
 * LE FORMULAIRE D'UNE CARTE DE CAPACITÉ (lot J11, décision 0030) — généré depuis le contrat de l'action.
 *
 * Chaque champ est rendu selon son type ; la valeur PROPOSÉE par l'assistant est pré-remplie et surlignée (« Proposé ») ;
 * une valeur changée par la personne l'est autrement (« Corrigé »). Une référence vers une autre fiche se choisit dans
 * un sélecteur dont le serveur ne rend que les fiches que la personne voit. Accessibilité : chaque champ a son libellé,
 * son erreur reliée (`aria-describedby`, `aria-invalid`) ; le sélecteur est une combobox au clavier (↑ ↓ Entrée Échap).
 * Mobile : une colonne, champs de 44 px, texte à 16 px (pas de zoom forcé).
 */

export interface OptionReference { id: string; titre: string; sousTitre: string | null }

export interface FormulaireCarteProps {
  formulaire: FormulaireCarte;
  saisies: Saisies;
  erreurs: Record<string, string>;
  /** Les champs que la personne a changés (marqués « Corrigé »). */
  corriges: ReadonlySet<string>;
  desactive?: boolean;
  onChange: (nom: string, valeur: Saisie) => void;
  onChercher: (champ: string, texte: string) => Promise<OptionReference[]>;
}

const CHAMP = "w-full rounded-lg border bg-white px-2.5 text-base text-zinc-900 outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 sm:text-sm dark:bg-zinc-900 dark:text-zinc-100";

function bordure(proposee: boolean, corrige: boolean, erreur: boolean): string {
  if (erreur) return "border-red-400 dark:border-red-500";
  if (corrige) return "border-amber-400 bg-amber-50/70 dark:border-amber-500 dark:bg-amber-950/30";
  if (proposee) return "border-sky-300 bg-sky-50/70 dark:border-sky-700 dark:bg-sky-950/30";
  return "border-zinc-300 dark:border-zinc-700";
}

const aUneProposition = (c: ChampFormulaire): boolean =>
  c.propose !== null && c.propose !== undefined && !(Array.isArray(c.propose) && c.propose.length === 0);

export function FormulaireCarteCapacite({ formulaire, saisies, erreurs, corriges, desactive, onChange, onChercher }: FormulaireCarteProps) {
  const base = useId();
  return (
    <fieldset className="mt-3 grid grid-cols-1 gap-3 rounded-xl bg-zinc-50/70 p-2.5 sm:grid-cols-2 dark:bg-zinc-950/40" disabled={desactive}>
      <legend className="sr-only">Champs de l&apos;action — corrigez avant de signer</legend>
      {formulaire.champs.map((c) => {
        const id = `${base}-${c.nom}`;
        const erreur = erreurs[c.nom];
        const corrige = corriges.has(c.nom);
        const proposee = aUneProposition(c) && !corrige;
        const aide = c.aide ? `${id}-aide` : undefined;
        const err = erreur ? `${id}-err` : undefined;
        const decrit = [aide, err].filter(Boolean).join(" ") || undefined;
        const large = c.widget === "zone" || c.widget === "references" || c.widget === "etiquettes" || c.widget === "choix-multiple";
        const commun = { id, "aria-invalid": erreur ? true : undefined, "aria-describedby": decrit, "aria-required": c.obligatoire || undefined };
        const classe = `${CHAMP} ${bordure(proposee, corrige, !!erreur)}`;
        // Une ligne fait 44 px ; une zone, au moins 88 px — la hauteur n'est jamais dans `CHAMP` (une seule déclaration).
        const ligne = `${classe} h-11`;
        const zone = `${classe} min-h-[5.5rem] py-2`;
        const v = saisies[c.nom];
        return (
          <div key={c.nom} className={`flex min-w-0 flex-col gap-1 ${large ? "sm:col-span-2" : ""}`} data-champ={c.nom}>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {c.libelle}
                {c.obligatoire && <span aria-hidden className="ml-0.5 text-red-500">*</span>}
                {c.obligatoire && <span className="sr-only"> (obligatoire)</span>}
              </label>
              {corrige ? (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">Corrigé</span>
              ) : proposee ? (
                <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-900/50 dark:text-sky-200">Proposé</span>
              ) : null}
            </div>

            {c.widget === "case" ? (
              <label className={`flex h-11 items-center gap-2 rounded-lg border px-2.5 text-sm ${bordure(proposee, corrige, !!erreur)}`}>
                <input type="checkbox" {...commun} checked={v === true} onChange={(e) => onChange(c.nom, e.target.checked)} className="h-5 w-5 accent-blue-600" />
                <span className="text-zinc-700 dark:text-zinc-300">{v === true ? "Oui" : "Non"}</span>
              </label>
            ) : c.widget === "zone" ? (
              <textarea {...commun} rows={3} value={String(v ?? "")} onChange={(e) => onChange(c.nom, e.target.value)} className={zone} />
            ) : c.widget === "choix" ? (
              <select {...commun} value={String(v ?? "")} onChange={(e) => onChange(c.nom, e.target.value)} className={ligne}>
                <option value="">{c.obligatoire ? "— Choisir —" : "— Aucun —"}</option>
                {(c.valeurs ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : c.widget === "choix-multiple" ? (
              <div role="group" aria-labelledby={id} aria-describedby={decrit} className={`flex flex-wrap gap-2 rounded-lg border p-2 ${bordure(proposee, corrige, !!erreur)}`}>
                <span id={id} className="sr-only">{c.libelle}</span>
                {(c.valeurs ?? []).map((o) => {
                  const coches = Array.isArray(v) ? v : [];
                  return (
                    <label key={o} className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-md bg-white px-2 text-sm dark:bg-zinc-900">
                      <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={coches.includes(o)}
                        onChange={(e) => onChange(c.nom, e.target.checked ? [...coches, o] : coches.filter((x) => x !== o))} />
                      {o}
                    </label>
                  );
                })}
              </div>
            ) : c.widget === "etiquettes" ? (
              <textarea {...commun} rows={3} value={Array.isArray(v) ? v.join("\n") : ""} onChange={(e) => onChange(c.nom, e.target.value.split("\n"))} className={zone} />
            ) : c.widget === "reference" || c.widget === "references" ? (
              <SelecteurReference champ={c} id={id} decrit={decrit} invalide={!!erreur} classe={bordure(proposee, corrige, !!erreur)}
                valeurs={Array.isArray(v) ? v : v ? [String(v)] : []} multiple={c.widget === "references"}
                onChange={(ids) => onChange(c.nom, c.widget === "references" ? ids : ids[0] ?? "")} onChercher={onChercher} />
            ) : (
              <input {...commun} type={c.widget === "date" ? "date" : "text"} inputMode={c.widget === "nombre" ? "decimal" : undefined}
                value={String(v ?? "")} onChange={(e) => onChange(c.nom, e.target.value)} className={ligne} />
            )}

            {c.aide && <p id={aide} className="text-[11px] text-zinc-500 dark:text-zinc-400">{c.aide}</p>}
            {erreur && <p id={err} className="text-[11px] font-medium text-red-600 dark:text-red-400">{erreur}</p>}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Le sélecteur d'une référence : combobox au clavier, options rendues par le serveur sous les droits de la personne. */
function SelecteurReference({ champ, id, decrit, invalide, classe, valeurs, multiple, onChange, onChercher }: {
  champ: ChampFormulaire; id: string; decrit?: string; invalide: boolean; classe: string; valeurs: string[]; multiple: boolean;
  onChange: (ids: string[]) => void; onChercher: FormulaireCarteProps["onChercher"];
}) {
  const [texte, setTexte] = useState("");
  const [options, setOptions] = useState<OptionReference[]>([]);
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(-1);
  const [charge, setCharge] = useState(false);
  const [noms, setNoms] = useState<Record<string, string>>(champ.etiquettes);
  const saisie = useRef<HTMLInputElement>(null);
  const liste = `${id}-options`;

  useEffect(() => {
    const q = texte.trim();
    if (q.length < 2) { setOptions([]); return; }
    let vivant = true;
    setCharge(true);
    const t = setTimeout(() => {
      // Une recherche qui échoue rend une liste vide (« aucune fiche ») — jamais une erreur muette.
      onChercher(champ.nom, q).catch(sansBloquer("formulaire-carte.chercher", [] as OptionReference[]))
        .then((o) => { if (vivant) { setOptions(o); setActif(o.length ? 0 : -1); setOuvert(true); } })
        .finally(() => { if (vivant) setCharge(false); });
    }, 250);
    return () => { vivant = false; clearTimeout(t); };
  }, [texte, champ.nom, onChercher]);

  const choisir = (o: OptionReference) => {
    setNoms((n) => ({ ...n, [o.id]: o.sousTitre ? `${o.titre} — ${o.sousTitre}` : o.titre }));
    onChange(multiple ? [...valeurs.filter((x) => x !== o.id), o.id] : [o.id]);
    setTexte("");
    setOuvert(false);
  };
  const retirer = (v: string) => { onChange(valeurs.filter((x) => x !== v)); saisie.current?.focus(); };
  const montrerSaisie = multiple || valeurs.length === 0;

  return (
    <div className={`relative rounded-lg border p-1.5 ${classe}`}>
      {valeurs.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-1.5" aria-label={`${champ.libelle} : sélection`}>
          {valeurs.map((v) => (
            <li key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-white px-2 py-1 text-sm text-zinc-800 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100">
              <span className="truncate">{noms[v] ?? v}</span>
              <button type="button" onClick={() => retirer(v)} className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-800"
                aria-label={multiple ? `Retirer ${noms[v] ?? v}` : `Changer ${champ.libelle}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {montrerSaisie && (
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            ref={saisie} id={id} type="text" role="combobox" autoComplete="off"
            aria-expanded={ouvert && options.length > 0} aria-controls={liste} aria-autocomplete="list"
            aria-activedescendant={ouvert && actif >= 0 ? `${liste}-${actif}` : undefined}
            aria-invalid={invalide || undefined} aria-describedby={decrit} aria-required={champ.obligatoire || undefined}
            placeholder={champ.modele === "User" ? "Nom de la personne…" : "Nom ou référence…"}
            value={texte} onChange={(e) => setTexte(e.target.value)} onBlur={() => setTimeout(() => setOuvert(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setOuvert(true); setActif((a) => Math.min(options.length - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActif((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter" && ouvert && options[actif]) { e.preventDefault(); choisir(options[actif]!); }
              else if (e.key === "Escape") setOuvert(false);
            }}
            className="h-11 w-full rounded-md bg-transparent pl-8 pr-8 text-base text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-sm dark:text-zinc-100"
          />
          {charge && <Loader2 aria-hidden className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" />}
        </div>
      )}
      {ouvert && montrerSaisie && texte.trim().length >= 2 && (
        <ul id={liste} role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {options.length === 0 && !charge && <li className="px-3 py-2 text-sm text-zinc-500" role="option" aria-selected={false} aria-disabled>Aucune fiche visible ne correspond.</li>}
          {options.map((o, i) => (
            <li key={o.id} id={`${liste}-${i}`} role="option" aria-selected={i === actif}
              onMouseDown={(e) => { e.preventDefault(); choisir(o); }}
              className={`cursor-pointer px-3 py-2 text-sm ${i === actif ? "bg-blue-50 text-blue-900 dark:bg-blue-950/50 dark:text-blue-100" : "text-zinc-800 dark:text-zinc-200"}`}>
              <span className="font-medium">{o.titre}</span>
              {o.sousTitre && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{o.sousTitre}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
