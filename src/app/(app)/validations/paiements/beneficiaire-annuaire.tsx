"use client";

import * as React from "react";
import { BookUser, Check, Mail, Phone, Plus, Search, User2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreerContact } from "@/components/directory/party-picker";
import { partieDuNom, partiesProches, type PartyOption } from "@/lib/contacts/parties";
import { cn } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

/**
 * LE BÉNÉFICIAIRE SE CHERCHE DANS L'ANNUAIRE (Direction, 08/11/2026) — et reste un nom qu'on peut taper.
 *
 * On tapait le bénéficiaire à la main : trois orthographes du même imprimeur, et pas de téléphone le jour où le
 * virement revient. Le champ propose désormais, dès deux lettres, les contacts de l'annuaire que la personne voit
 * (`/api/annuaire/parties`, le même cloisonnement par société que l'écran de l'annuaire). Choisir un contact écrit son
 * nom EXACT et reprend ses coordonnées dans « Contact chez le bénéficiaire » (`onChoisir`, chez l'appelant).
 *
 * Le texte libre reste permis : on paie aussi un salarié, un médecin, un organisme qui n'a rien à faire dans
 * l'annuaire. Absent, le contact peut y être AJOUTÉ d'ici — la fenêtre de l'annuaire, mêmes champs, mêmes droits.
 *
 * Un nom LU sur une pièce (`lu`) ne choisit rien tout seul : s'il désigne un contact, on le PROPOSE ; s'il n'en
 * désigne aucun, on propose de l'ajouter.
 *
 * Le champ reste un `<input name="payee">` non contrôlé : la lecture d'une pièce l'écrit comme les autres champs du
 * formulaire, et la saisie de la personne le marque « touché » par le même `onInput` du formulaire.
 */
export function BeneficiaireAnnuaire({ lu, onChoisir }: {
  /** Le nom qu'une pièce lue vient d'écrire dans le champ — `null` tant qu'aucune ne l'a fait. */
  lu: string | null;
  /** Un contact de l'annuaire est retenu : l'appelant écrit son nom et ses coordonnées. */
  onChoisir: (p: PartyOption) => void;
}) {
  const [annuaire, setAnnuaire] = React.useState<PartyOption[]>([]);
  const [peutCreer, setPeutCreer] = React.useState(false);
  const [saisie, setSaisie] = React.useState("");
  const [ouvert, setOuvert] = React.useState(false);
  const [actif, setActif] = React.useState(0);
  const [choisi, setChoisi] = React.useState<PartyOption | null>(null);
  const [creation, setCreation] = React.useState<string | null>(null);
  const listeId = React.useId();

  React.useEffect(() => {
    let vivant = true;
    fetch("/api/annuaire/parties")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { parties?: PartyOption[]; canCreate?: boolean }) => {
        if (!vivant) return;
        setAnnuaire(d.parties ?? []);
        setPeutCreer(Boolean(d.canCreate));
      })
      // Sans annuaire (droit absent, réseau), le champ reste un champ de texte : rien ne se bloque.
      .catch(sansBloquer("beneficiaire-annuaire.fetch"));
    return () => { vivant = false; };
  }, []);

  // Une pièce lue a écrit le nom : on le reprend comme saisie, sans ouvrir la liste.
  React.useEffect(() => {
    if (lu == null) return;
    setSaisie(lu);
    setChoisi(null);
  }, [lu]);

  const proposes = React.useMemo(() => partiesProches(annuaire, saisie), [annuaire, saisie]);
  const retenir = (p: PartyOption) => {
    setChoisi(p); setSaisie(p.name); setOuvert(false);
    onChoisir(p);
  };

  // CE QUE LA PIÈCE A LU, rapproché de l'annuaire : le contact exact, sinon les plus proches, sinon l'ajout.
  const exact = lu && !choisi ? partieDuNom(annuaire, lu) : null;
  const prochesDuLu = lu && !choisi && !exact ? partiesProches(annuaire, lu, 3) : [];
  const listeVisible = ouvert && !choisi && saisie.trim().length >= 2;

  return (
    <div className="relative space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id="pay-payee" name="payee" required autoComplete="off" className="pl-8"
          placeholder="Chercher dans l'annuaire, ou taper un nom"
          role="combobox" aria-autocomplete="list" aria-expanded={listeVisible} aria-controls={listeId}
          onChange={(e) => { setSaisie(e.target.value); setChoisi(null); setOuvert(true); setActif(0); }}
          onFocus={() => setOuvert(true)}
          // Le clic sur une ligne passe avant la perte du focus (`onMouseDown` sur les lignes).
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

      {listeVisible && (
        <div id={listeId} role="listbox" className="absolute left-0 right-0 top-[2.6rem] z-20 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {proposes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              «&nbsp;{saisie.trim()}&nbsp;» n&apos;est pas dans l&apos;annuaire — vous pouvez garder ce nom.
            </p>
          ) : proposes.map((p, i) => (
            <button
              key={p.id} type="button" role="option" aria-selected={i === actif}
              onMouseDown={(e) => { e.preventDefault(); retenir(p); }}
              className={cn("flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-2 text-left text-sm hover:bg-secondary sm:py-1.5", i === actif && "bg-secondary")}
            >
              <span className="font-medium">{p.name}</span>
              {p.kind && <span className="text-xs text-muted-foreground">{p.kind}</span>}
              {p.city && <span className="text-xs text-muted-foreground">· {p.city}</span>}
            </button>
          ))}
          {peutCreer && proposes.every((p) => p.name.trim().toLowerCase() !== saisie.trim().toLowerCase()) && (
            <button
              type="button" onMouseDown={(e) => { e.preventDefault(); setOuvert(false); setCreation(saisie.trim()); }}
              className="mt-0.5 flex w-full items-center gap-1.5 rounded border-t border-border px-2 py-2 text-left text-sm text-primary hover:bg-secondary sm:py-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Ajouter «&nbsp;{saisie.trim()}&nbsp;» à l&apos;annuaire
            </button>
          )}
        </div>
      )}

      {choisi && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-success"><Check className="h-3.5 w-3.5" /> Dans l&apos;annuaire</span>
          {choisi.kind && <span>{choisi.kind}{choisi.city ? ` · ${choisi.city}` : ""}</span>}
          {choisi.contactName && <span className="inline-flex items-center gap-1"><User2 className="h-3 w-3" />{choisi.contactName}</span>}
          {choisi.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{choisi.phone}</span>}
          {choisi.email && <span className="inline-flex min-w-0 items-center gap-1 truncate"><Mail className="h-3 w-3 shrink-0" />{choisi.email}</span>}
        </div>
      )}

      {lu && !choisi && (exact || prochesDuLu.length > 0 || peutCreer) && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-luna/40 bg-luna-soft px-2.5 py-2 text-xs">
          <BookUser className="h-3.5 w-3.5 shrink-0 text-luna" aria-hidden />
          {exact ? (
            <>
              <span className="text-muted-foreground">«&nbsp;{exact.name}&nbsp;» est dans l&apos;annuaire.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => retenir(exact)}>Reprendre sa fiche</Button>
            </>
          ) : prochesDuLu.length > 0 ? (
            <>
              <span className="text-muted-foreground">Dans l&apos;annuaire :</span>
              {prochesDuLu.map((p) => (
                <Button key={p.id} type="button" size="sm" variant="outline" onClick={() => retenir(p)}>C&apos;est «&nbsp;{p.name}&nbsp;»</Button>
              ))}
            </>
          ) : (
            <>
              <span className="text-muted-foreground">«&nbsp;{lu}&nbsp;» n&apos;est pas dans l&apos;annuaire.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setCreation(lu)}><Plus className="h-3.5 w-3.5" /> L&apos;ajouter</Button>
            </>
          )}
        </div>
      )}

      {creation !== null && (
        <CreerContact
          nomPropose={creation}
          onClose={() => setCreation(null)}
          onCreated={(p) => {
            setAnnuaire((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name, "fr")));
            setCreation(null);
            retenir(p);
          }}
        />
      )}
    </div>
  );
}
