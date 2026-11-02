"use client";

import * as React from "react";
import { Search, Plus, X, Loader2, Mail, Phone, User2, MapPin, BookUser, ChevronDown } from "lucide-react";
import { createCompanyContact } from "@/lib/actions/company-contact-actions";
import {
  matchesParty, withParty, resolveParties,
  type PartyOption, type PartyArity,
} from "@/lib/contacts/parties";
import { CONTACT_KIND_SUGGESTIONS } from "@/lib/contacts/kinds";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sansBloquer } from "@/lib/journal";

/**
 * CHOISIR UNE PARTIE DANS L'ANNUAIRE DE L'ENTREPRISE — et pouvoir l'y créer sans partir.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ──────────────────────────────────────────────────────────────────
 *
 * « Partie », « Expéditeur », « Destinataire » étaient des champs de TEXTE LIBRE. Trois personnes
 * écrivaient trois orthographes du même prestataire, aucune ne portait un numéro, et le jour où
 * il fallait le joindre on cherchait sur une vieille facture. Un nom saisi à la main ne se
 * rattache à rien : ni au contrat précédent, ni au courrier de la semaine dernière.
 *
 * ── CE QUI S'AFFICHE, ET CE QUI SE CLIQUE ────────────────────────────────────────────────────
 *
 * On affiche le NOM seul — une fiche de contrat n'a pas à porter un pavé de coordonnées. Mais ce
 * nom S'OUVRE : le mail, les téléphones, la personne à demander sont là, en un clic, cliquables.
 *
 * ── « CRÉER UN CONTACT », SANS QUITTER SA SAISIE ─────────────────────────────────────────────
 *
 * Le prestataire absent de l'annuaire est le cas NORMAL, pas l'exception : c'est en saisissant un
 * contrat qu'on s'aperçoit qu'il n'y est pas. Renvoyer vers l'annuaire ferait perdre le
 * formulaire à moitié rempli — donc on ressaisirait le nom à la main, et l'on serait revenu au
 * texte libre. La fenêtre appartient à l'ANNUAIRE (mêmes champs, même action serveur, mêmes
 * droits) ; elle s'ouvre par-dessus, et le contact créé est sélectionné aussitôt.
 *
 * ── POURQUOI PAS UN FORMULAIRE IMBRIQUÉ ──────────────────────────────────────────────────────
 *
 * Ce sélecteur vit DANS le formulaire de la pièce, et un formulaire dans un formulaire est
 * invalide — le navigateur envoie alors n'importe quoi. On monte donc le `FormData` à la main et
 * l'on appelle l'action serveur directement : mêmes champs, même contrôle des droits au serveur.
 *
 * ── CE QUE LA LECTURE D'UNE PIÈCE PROPOSE (`propose`) ────────────────────────────────────────
 *
 * Une pièce lue nomme parfois sa partie sans la prouver : un contact au nom proche se PROPOSE, en
 * violet, et rien n'est choisi tant que la personne n'a pas cliqué. Absente de l'annuaire, « Créer
 * un contact » s'ouvre prérempli de ce qui a été lu — nom, NIF, RC, adresse —, jamais créé d'office.
 */
export interface ContactPropose {
  nom: string | null;
  nif: string | null;
  rc: string | null;
  adresse: string | null;
}

export interface PartiesProposees {
  /** Les contacts que la lecture désigne sans les prouver — aucun n'est choisi d'office. */
  candidats: { id: string; nom: string }[];
  /** Ce que la lecture en dit à la personne. */
  phrase: string;
  /** Ce qui a été lu, pour « Créer un contact ». */
  contact: ContactPropose | null;
}

export function PartyPicker({
  name, options, defaultValue = [], arity = "many", canCreate = false, placeholder, propose,
}: {
  /** Le nom du champ : le serveur lit `formData.getAll(name)`. */
  name: string;
  /**
   * Les contacts, passés par le serveur qui rend le formulaire. OMIS, le sélecteur va les
   * chercher lui-même (`/api/annuaire/parties`) — c'est le cas des écrans qui vivent à cinq
   * composants clients de toute page serveur, comme « Déclarer dans Legal » depuis le Drive.
   */
  options?: PartyOption[];
  defaultValue?: string[];
  arity?: PartyArity;
  /** Peut-on créer un contact d'ici ? C'est le droit d'écriture de l'annuaire, calculé au serveur. */
  canCreate?: boolean;
  placeholder?: string;
  propose?: PartiesProposees;
}) {
  const [connus, setConnus] = React.useState<PartyOption[]>(options ?? []);
  const [creationPermise, setCreationPermise] = React.useState(canCreate);
  // Chargement à la demande : seulement quand l'appelant n'a pas pu fournir la liste.
  const [chargement, setChargement] = React.useState(options === undefined);
  React.useEffect(() => {
    if (options !== undefined) return;
    let vivant = true;
    fetch("/api/annuaire/parties")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { parties: PartyOption[]; canCreate: boolean }) => {
        if (!vivant) return;
        setConnus(d.parties ?? []);
        setCreationPermise(Boolean(d.canCreate));
      })
      .catch(sansBloquer("party-picker.PartyPicker.fetch"))
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [options]);
  const [ids, setIds] = React.useState<string[]>(() => defaultValue.filter(Boolean));
  const [query, setQuery] = React.useState("");
  const [ouvert, setOuvert] = React.useState<string | null>(null);
  const [creation, setCreation] = React.useState(false);

  const choisies = resolveParties(connus, ids);
  const q = query.trim();
  const proposees = React.useMemo(
    () => connus.filter((o) => !ids.includes(o.id) && matchesParty(o, q)).slice(0, 40),
    [connus, ids, q],
  );

  const ajouter = (id: string) => { setIds((prev) => withParty(prev, id, arity)); setQuery(""); };
  const retirer = (id: string) => setIds((prev) => prev.filter((x) => x !== id));

  return (
    <div className="space-y-2">
      {/* CE QUE LE SERVEUR REÇOIT. Des champs cachés nommés : l'action lit `getAll(name)` comme
          pour n'importe quelle liste, sans code de transport particulier. */}
      {ids.map((id) => <input key={id} type="hidden" name={name} value={id} />)}

      {choisies.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {choisies.map((p) => (
            <li key={p.id} className="relative">
              <span className="inline-flex items-center gap-1 rounded-full border border-input bg-secondary/60 py-1 pl-2.5 pr-1 text-xs">
                <button
                  type="button"
                  onClick={() => setOuvert((o) => (o === p.id ? null : p.id))}
                  aria-expanded={ouvert === p.id}
                  title="Voir le mail et le contact"
                  className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                >
                  {p.name}
                  <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", ouvert === p.id && "rotate-180")} />
                </button>
                <button type="button" onClick={() => { retirer(p.id); setOuvert(null); }} title="Retirer cette partie"
                  aria-label={`Retirer ${p.name}`} className="-my-1 rounded-full p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:my-0 sm:p-0.5">
                  <X className="h-3 w-3" />
                </button>
              </span>
              {ouvert === p.id && <FicheContact p={p} />}
            </li>
          ))}
        </ul>
      )}

      {propose && ids.length === 0 && (propose.candidats.length > 0 || propose.contact) && (
        <div className="space-y-1.5 rounded-lg border border-dashed border-luna/40 bg-luna-soft px-2.5 py-2 text-xs">
          <p className="text-muted-foreground">{propose.phrase}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {propose.candidats.filter((c) => connus.some((o) => o.id === c.id)).map((c) => (
              <Button key={c.id} type="button" size="sm" variant="outline" onClick={() => ajouter(c.id)}>
                C&apos;est « {c.nom} »
              </Button>
            ))}
            {propose.candidats.length === 0 && propose.contact && (propose.contact.nom || propose.contact.nif || propose.contact.rc) && creationPermise && (
              <Button type="button" size="sm" onClick={() => setCreation(true)}>
                <Plus className="h-4 w-4" />
                {propose.contact.nom ? <>Créer « {propose.contact.nom} »</> : <>Créer le contact ({propose.contact.nif ? `NIF ${propose.contact.nif}` : `RC ${propose.contact.rc}`} lu)</>}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder ?? "Chercher dans l’annuaire — un métier, un nom, un numéro…"}
            aria-label="Chercher une partie dans l&apos;annuaire de l&apos;entreprise"
            className="h-10 pl-8 sm:h-9"
          />
        </div>
        {creationPermise && (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreation(true)}>
            <Plus className="h-4 w-4" /> Créer un contact
          </Button>
        )}
      </div>

      {/* La liste ne s'ouvre qu'à la recherche : déroulée en permanence, elle repousserait le
          reste du formulaire hors de l'écran sur un téléphone. */}
      {q.length > 0 && (
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-input p-1.5">
          {proposees.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              Aucun contact ne correspond à «&nbsp;{q}&nbsp;».{creationPermise ? " Créez-le : il servira aux pièces suivantes." : ""}
            </p>
          ) : proposees.map((o) => (
            <button key={o.id} type="button" onClick={() => ajouter(o.id)}
              className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-1.5 py-2 text-left text-sm hover:bg-secondary sm:py-1">
              <span className="font-medium">{o.name}</span>
              {o.kind && <span className="text-xs text-muted-foreground">{o.kind}</span>}
              {o.city && <span className="text-xs text-muted-foreground">· {o.city}</span>}
            </button>
          ))}
        </div>
      )}

      {connus.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {chargement ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement de l&apos;annuaire…</>
          ) : (
            <>
              <BookUser className="h-3.5 w-3.5" /> L&apos;annuaire de l&apos;entreprise est vide.
              {creationPermise ? " Le premier contact se crée ici." : " Demandez aux moyens généraux d’y ajouter ce prestataire."}
            </>
          )}
        </p>
      )}

      {creation && (
        <CreerContact
          onClose={() => setCreation(false)}
          onCreated={(p) => {
            setConnus((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name, "fr")));
            ajouter(p.id);
            setCreation(false);
          }}
          nomPropose={q || propose?.contact?.nom || ""}
          lu={q ? null : propose?.contact ?? null}
        />
      )}
    </div>
  );
}

/** LA FICHE SOUS LE NOM — le mail et le contact, cliquables, et rien de décoratif. */
function FicheContact({ p }: { p: PartyOption }) {
  const lignes: { Icone: typeof Mail; value: string; href?: string }[] = [];
  if (p.contactName) lignes.push({ Icone: User2, value: p.contactName });
  if (p.email) lignes.push({ Icone: Mail, value: p.email, href: `mailto:${p.email}` });
  if (p.phone) lignes.push({ Icone: Phone, value: p.phone, href: `tel:${p.phone.replace(/\s/g, "")}` });
  if (p.phoneAlt) lignes.push({ Icone: Phone, value: p.phoneAlt, href: `tel:${p.phoneAlt.replace(/\s/g, "")}` });
  if (p.city) lignes.push({ Icone: MapPin, value: p.city });
  return (
    <div className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg">
      <p className="font-medium text-foreground">{p.name}</p>
      {p.kind && <p className="text-muted-foreground">{p.kind}{p.companyLabel ? ` · ${p.companyLabel}` : ""}</p>}
      {lignes.length === 0 ? (
        <p className="text-muted-foreground">Aucune coordonnée enregistrée — complétez sa fiche dans l&apos;annuaire.</p>
      ) : lignes.map((l, i) => (
        <p key={i} className="flex items-center gap-1.5">
          <l.Icone className="h-3 w-3 shrink-0 text-muted-foreground" />
          {l.href
            ? <a href={l.href} className="min-w-0 flex-1 truncate text-primary hover:underline">{l.value}</a>
            : <span className="min-w-0 flex-1 truncate">{l.value}</span>}
        </p>
      ))}
    </div>
  );
}

/**
 * LA FENÊTRE DE L'ANNUAIRE — les champs qu'on remplit en ayant le prestataire au téléphone.
 *
 * Volontairement COURTE : seul le nom est obligatoire, le reste se complète dans l'annuaire.
 * Exiger le RC et le NIF au moment où l'on saisit un contrat ferait renoncer — et l'on
 * réécrirait le nom à la main.
 */
function CreerContact({
  onClose, onCreated, nomPropose, lu,
}: {
  onClose: () => void; onCreated: (p: PartyOption) => void; nomPropose: string;
  /** Ce que la lecture d'une pièce a lu de cette partie — proposé, modifiable, jamais créé d'office. */
  lu?: ContactPropose | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [v, setV] = React.useState({
    name: nomPropose, kind: "", contactName: "", email: "", phone: "", city: "",
    // Vides, ils ne s'envoient pas pour rien : l'action lit un champ vide comme absent (`fdStr`).
    nif: lu?.nif ?? "", rc: lu?.rc ?? "", address: lu?.adresse ?? "",
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  const enregistrer = async () => {
    const nom = v.name.trim();
    if (!nom) { setErr("Le nom du contact est obligatoire."); return; }
    setBusy(true); setErr(null);
    const fd = new FormData();
    for (const [k, val] of Object.entries(v)) fd.set(k, val.trim());
    try {
      const r = await createCompanyContact(undefined, fd);
      if (!r.ok || !r.id) { setErr(r.error ?? "Création impossible."); return; }
      onCreated({
        id: r.id, name: nom, kind: v.kind.trim() || null, contactName: v.contactName.trim() || null,
        email: v.email.trim() || null, phone: v.phone.trim() || null, phoneAlt: null,
        city: v.city.trim() || null, companyLabel: null,
      });
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={() => !busy && onClose()} width="md"
      title="Créer un contact dans l&apos;annuaire"
      description="Il rejoint l&apos;annuaire de l&apos;entreprise — il servira aux pièces suivantes. Seul le nom est obligatoire.">
      <div className="space-y-3">
        <Champ id="pp-name" label="Nom / raison sociale" value={v.name} onChange={set("name")} required />
        <div className="space-y-1.5">
          <Label htmlFor="pp-kind">Nature</Label>
          <Input id="pp-kind" list="party-kinds" value={v.kind} onChange={set("kind")} placeholder="Imprimeur, transitaire, cabinet d&apos;avocats…" />
          <datalist id="party-kinds">
            {CONTACT_KIND_SUGGESTIONS.map((k) => <option key={k} value={k} />)}
          </datalist>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Champ id="pp-contactName" label="Personne à demander" value={v.contactName} onChange={set("contactName")} />
          <Champ id="pp-city" label="Ville" value={v.city} onChange={set("city")} />
          <Champ id="pp-email" label="E-mail" value={v.email} onChange={set("email")} type="email" />
          <Champ id="pp-phone" label="Téléphone" value={v.phone} onChange={set("phone")} type="tel" />
        </div>
        {lu && (
          <div className="grid grid-cols-1 gap-3 rounded-lg bg-luna-soft p-2.5 sm:grid-cols-2">
            <p className="text-xs text-muted-foreground sm:col-span-2">Lu sur la pièce — vérifiez avant de créer.</p>
            <Champ id="pp-nif" label="NIF" value={v.nif} onChange={set("nif")} />
            <Champ id="pp-rc" label="RC" value={v.rc} onChange={set("rc")} />
            <div className="sm:col-span-2">
              <Champ id="pp-address" label="Adresse" value={v.address} onChange={set("address")} />
            </div>
          </div>
        )}
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="button" onClick={enregistrer} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer et sélectionner
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function Champ({ id, label, value, onChange, required, type }: {
  id: string; label: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; required?: boolean; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      <Input id={id} type={type ?? "text"} value={value} onChange={onChange} required={required} />
    </div>
  );
}
