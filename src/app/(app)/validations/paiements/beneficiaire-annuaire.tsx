"use client";

import * as React from "react";
import { BookUser, Check, Mail, Phone, Plus, Search, User2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreerContact } from "@/components/directory/party-picker";
import { partiesProches, type PartyOption } from "@/lib/contacts/parties";
import type { AnnuaireDeLaPiece } from "@/modules/finances/partage";
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
 * LA PIÈCE CHOISIT QUAND C'EST CERTAIN (`retenuAuto`) : même NIF ou RC qu'une fiche, la fiche liée au registre Legal,
 * ou une seule fiche au nom exact — rapproché au serveur (`AnnuaireDeLaPiece`). Le champ le dit (« Trouvé dans
 * l'annuaire — vérifiez ») et « Changer » le défait. Pas certain, la pièce PROPOSE (« C'est … ») ou propose d'ajouter.
 *
 * Le texte libre reste permis : on paie aussi un salarié, un médecin, un organisme qui n'a rien à faire dans
 * l'annuaire. Absent, le contact peut y être AJOUTÉ d'ici — la fenêtre de l'annuaire, mêmes champs, mêmes droits.
 *
 * Le champ reste un `<input name="payee">` non contrôlé : la lecture d'une pièce l'écrit comme les autres champs du
 * formulaire, et la saisie de la personne le marque « touché » par le même `onInput` du formulaire.
 */
export function BeneficiaireAnnuaire({ lu, annuaireLu, retenuAuto, onChoisir, onChanger }: {
  /** Le nom qu'une pièce lue vient d'écrire dans le champ — `null` tant qu'aucune ne l'a fait. */
  lu: string | null;
  /** Ce que cette pièce dit de son bénéficiaire, rapproché de l'annuaire au serveur. */
  annuaireLu: AnnuaireDeLaPiece | null;
  /** Le contact que la pièce a choisi de lui-même, parce que c'était certain — et pourquoi. */
  retenuAuto: { contact: PartyOption; preuve: string | null } | null;
  /** Un contact de l'annuaire est retenu PAR LA PERSONNE : l'appelant écrit son nom et ses coordonnées. */
  onChoisir: (p: PartyOption) => void;
  /** « Changer » : la personne reprend la main sur le bénéficiaire. */
  onChanger: () => void;
}) {
  const [annuaire, setAnnuaire] = React.useState<PartyOption[]>([]);
  const [peutCreer, setPeutCreer] = React.useState(false);
  const [saisie, setSaisie] = React.useState("");
  const [ouvert, setOuvert] = React.useState(false);
  const [actif, setActif] = React.useState(0);
  const [choisi, setChoisi] = React.useState<{ contact: PartyOption; auto: boolean; preuve: string | null } | null>(null);
  const [creation, setCreation] = React.useState<{ nom: string; lu: AnnuaireDeLaPiece["aCreer"] } | null>(null);
  const listeId = React.useId();
  const champ = React.useRef<HTMLInputElement>(null);

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
    setChoisi((c) => (c?.auto ? c : null));
  }, [lu]);

  // La pièce a choisi parce que c'était certain.
  React.useEffect(() => {
    if (!retenuAuto) return;
    setChoisi({ contact: retenuAuto.contact, auto: true, preuve: retenuAuto.preuve });
    setSaisie(retenuAuto.contact.name);
  }, [retenuAuto]);

  const proposes = React.useMemo(() => partiesProches(annuaire, saisie), [annuaire, saisie]);
  const retenir = (p: PartyOption) => {
    setChoisi({ contact: p, auto: false, preuve: null }); setSaisie(p.name); setOuvert(false);
    onChoisir(p);
  };
  const changer = () => {
    setChoisi(null); onChanger();
    champ.current?.focus(); champ.current?.select(); setOuvert(true);
  };

  // CE QUE LA PIÈCE A LU, quand elle n'a pas pu choisir : ses candidats (ceux que la personne voit), sinon les noms
  // proches de l'annuaire, sinon l'ajout.
  const parId = new Map(annuaire.map((p) => [p.id, p]));
  const candidats = !choisi && annuaireLu
    ? annuaireLu.candidats.flatMap((c) => { const p = parId.get(c.id); return p ? [p] : []; }).slice(0, 3)
    : [];
  const proches = !choisi && lu && candidats.length === 0 ? partiesProches(annuaire, lu, 3) : [];
  const aCreer = !choisi && lu && candidats.length === 0 && proches.length === 0 && peutCreer
    ? { nom: annuaireLu?.aCreer?.nom ?? lu, lu: annuaireLu?.aCreer ?? null }
    : null;
  const listeVisible = ouvert && !choisi && saisie.trim().length >= 2;

  return (
    <div className="relative space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={champ} id="pay-payee" name="payee" required autoComplete="off" className="pl-8"
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
              type="button" onMouseDown={(e) => { e.preventDefault(); setOuvert(false); setCreation({ nom: saisie.trim(), lu: null }); }}
              className="mt-0.5 flex w-full items-center gap-1.5 rounded border-t border-border px-2 py-2 text-left text-sm text-primary hover:bg-secondary sm:py-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Ajouter «&nbsp;{saisie.trim()}&nbsp;» à l&apos;annuaire
            </button>
          )}
        </div>
      )}

      {choisi && (
        <div className={cn("space-y-1 rounded-lg px-2.5 py-2 text-xs", choisi.auto ? "border border-dashed border-luna/40 bg-luna-soft" : "bg-secondary/40")}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={cn("inline-flex items-center gap-1 font-medium", choisi.auto ? "text-luna" : "text-success")}>
              <Check className="h-3.5 w-3.5" /> {choisi.auto ? "Trouvé dans l'annuaire — vérifiez" : "Dans l'annuaire"}
            </span>
            <button type="button" onClick={changer} className="text-primary underline-offset-2 hover:underline">Changer</button>
          </div>
          {choisi.auto && choisi.preuve && <p className="text-muted-foreground">{choisi.preuve}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            {choisi.contact.kind && <span>{choisi.contact.kind}{choisi.contact.city ? ` · ${choisi.contact.city}` : ""}</span>}
            {choisi.contact.contactName && <span className="inline-flex items-center gap-1"><User2 className="h-3 w-3" />{choisi.contact.contactName}</span>}
            {choisi.contact.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{choisi.contact.phone}</span>}
            {choisi.contact.email && <span className="inline-flex min-w-0 items-center gap-1 truncate"><Mail className="h-3 w-3 shrink-0" />{choisi.contact.email}</span>}
          </div>
        </div>
      )}

      {(candidats.length > 0 || proches.length > 0 || aCreer) && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-luna/40 bg-luna-soft px-2.5 py-2 text-xs">
          <BookUser className="h-3.5 w-3.5 shrink-0 text-luna" aria-hidden />
          {candidats.length > 0 || proches.length > 0 ? (
            <>
              <span className="text-muted-foreground">{candidats.length > 0 ? "Plusieurs fiches possibles :" : "Dans l'annuaire :"}</span>
              {(candidats.length > 0 ? candidats : proches).map((p) => (
                <Button key={p.id} type="button" size="sm" variant="outline" onClick={() => retenir(p)}>C&apos;est «&nbsp;{p.name}&nbsp;»</Button>
              ))}
            </>
          ) : aCreer && (
            <>
              <span className="text-muted-foreground">
                «&nbsp;{aCreer.nom}&nbsp;» n&apos;est pas dans l&apos;annuaire. Il y entrera à l&apos;envoi si c&apos;est une facture ou un devis.
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => setCreation(aCreer)}><Plus className="h-3.5 w-3.5" /> L&apos;ajouter maintenant</Button>
            </>
          )}
        </div>
      )}

      {creation !== null && (
        <CreerContact
          nomPropose={creation.nom}
          lu={creation.lu}
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
