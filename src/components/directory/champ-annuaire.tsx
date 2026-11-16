"use client";

import * as React from "react";
import { BookUser, Check, Plus, Search, Sparkles } from "lucide-react";
import { CreerContact } from "@/components/directory/party-picker";
import { partiesProches, type PartyOption } from "@/lib/contacts/parties";
import { cn } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN NOM QUI SE CHERCHE DANS L'ANNUAIRE, ET S'Y AJOUTE S'IL N'Y EST PAS (Direction, 16/11/2026 — « quand on choisit les
 * agences ou le lieu de l'événement, que ça vienne de l'annuaire, et si ça n'existe pas, qu'on puisse l'ajouter depuis
 * ce formulaire »).
 *
 * Le champ reste un TEXTE envoyé sous \`name\` (les actions lisent un nom, comme avant) : on peut taper un nom absent.
 * Dès deux lettres, il propose les contacts que la personne voit (\`/api/annuaire/parties\`, le cloisonnement de l'écran
 * de l'annuaire) ; choisir écrit le nom EXACT de la fiche. Absent, « Ajouter à l'annuaire » ouvre la fenêtre de
 * l'annuaire (mêmes champs, mêmes droits) et retient la fiche créée.
 *
 * \`lu\` : un nom qu'une lecture par l'IA vient de proposer — écrit dans le champ, marqué « Lu par l'IA », tant que la
 * personne ne l'a pas changé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function ChampAnnuaire({ name, defaultValue = "", lu = null, placeholder = "Chercher dans l'annuaire, ou taper un nom", required, className }: {
  name: string;
  defaultValue?: string;
  /** Une proposition lue sur une pièce (\`version\` change à chaque lecture, même pour un nom identique). */
  lu?: { nom: string; version: number } | null;
  placeholder?: string;
  required?: boolean;
  className?: string;
}) {
  const [annuaire, setAnnuaire] = React.useState<PartyOption[]>([]);
  const [peutCreer, setPeutCreer] = React.useState(false);
  const [valeur, setValeur] = React.useState(defaultValue);
  const [ouvert, setOuvert] = React.useState(false);
  const [actif, setActif] = React.useState(0);
  const [retenu, setRetenu] = React.useState<PartyOption | null>(null);
  const [parIa, setParIa] = React.useState(false);
  const [creation, setCreation] = React.useState(false);
  const listeId = React.useId();
  // NON CONTRÔLÉ : une lecture (Luna, une pièce) peut écrire le champ directement, comme les autres champs du formulaire.
  const champ = React.useRef<HTMLInputElement>(null);
  const ecrire = (v: string) => { setValeur(v); if (champ.current) champ.current.value = v; };

  React.useEffect(() => {
    let vivant = true;
    fetch("/api/annuaire/parties")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { parties?: PartyOption[]; canCreate?: boolean }) => {
        if (!vivant) return;
        setAnnuaire(d.parties ?? []);
        setPeutCreer(Boolean(d.canCreate));
      })
      // Sans annuaire (droit absent, réseau) : un simple champ de texte, rien ne se bloque.
      .catch(sansBloquer("champ-annuaire.fetch"));
    return () => { vivant = false; };
  }, []);

  // Une lecture propose un nom : la fiche au nom exact est retenue d'office, sinon le nom lu est écrit tel quel.
  React.useEffect(() => {
    if (!lu?.nom) return;
    const exact = partiesProches(annuaire, lu.nom, 1).find((p) => p.name.trim().toLowerCase() === lu.nom.trim().toLowerCase()) ?? null;
    ecrire(exact?.name ?? lu.nom);
    setRetenu(exact);
    setParIa(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seule une NOUVELLE lecture réécrit le champ
  }, [lu?.version, annuaire.length]);

  const proposes = React.useMemo(() => partiesProches(annuaire, valeur), [annuaire, valeur]);
  const listeVisible = ouvert && !retenu && valeur.trim().length >= 2;
  const absent = !retenu && valeur.trim().length >= 2 && !annuaire.some((p) => p.name.trim().toLowerCase() === valeur.trim().toLowerCase());
  const retenir = (p: PartyOption) => { setRetenu(p); ecrire(p.name); setOuvert(false); setParIa(false); };

  return (
    <div className={cn("relative", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          ref={champ} name={name} defaultValue={defaultValue} required={required} autoComplete="off" placeholder={placeholder}
          role="combobox" aria-autocomplete="list" aria-expanded={listeVisible} aria-controls={listeId}
          className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-2.5 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm"
          onChange={(e) => { setValeur(e.target.value); setRetenu(null); setParIa(false); setOuvert(true); setActif(0); }}
          onFocus={() => setOuvert(true)}
          onBlur={() => setOuvert(false)}
          onKeyDown={(e) => {
            if (!listeVisible || proposes.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActif((i) => Math.min(i + 1, proposes.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActif((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); retenir(proposes[actif] ?? proposes[0]); }
            else if (e.key === "Escape") setOuvert(false);
          }}
        />
      </div>

      {listeVisible && proposes.length > 0 && (
        <div id={listeId} role="listbox" className="absolute left-0 right-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {proposes.map((p, i) => (
            <button
              key={p.id} type="button" role="option" aria-selected={i === actif}
              onMouseDown={(e) => { e.preventDefault(); retenir(p); }}
              className={cn("flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1.5 text-left text-sm hover:bg-secondary", i === actif && "bg-secondary")}
            >
              <span className="font-medium">{p.name}</span>
              {p.kind && <span className="text-xs text-muted-foreground">{p.kind}</span>}
              {p.city && <span className="text-xs text-muted-foreground">· {p.city}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {parIa && <span className="inline-flex items-center gap-1 text-luna"><Sparkles className="h-3 w-3" /> Lu par l&apos;IA — vérifiez</span>}
        {retenu && <span className="inline-flex items-center gap-1 text-success"><Check className="h-3 w-3" /> Dans l&apos;annuaire{retenu.city ? ` · ${retenu.city}` : ""}</span>}
        {absent && peutCreer && (
          <button type="button" onClick={() => setCreation(true)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            <Plus className="h-3 w-3" /> Ajouter «&nbsp;{valeur.trim()}&nbsp;» à l&apos;annuaire
          </button>
        )}
        {absent && !peutCreer && annuaire.length > 0 && (
          <span className="inline-flex items-center gap-1 text-muted-foreground"><BookUser className="h-3 w-3" /> Absent de l&apos;annuaire — le nom tapé sera gardé</span>
        )}
      </div>

      {creation && (
        <CreerContact
          nomPropose={valeur.trim()}
          onClose={() => setCreation(false)}
          onCreated={(p) => { setAnnuaire((a) => [...a, p]); retenir(p); setCreation(false); }}
        />
      )}
    </div>
  );
}
