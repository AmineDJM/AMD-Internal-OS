"use client";

import * as React from "react";
import { useAutoOpen } from "@/components/shared/use-auto-open";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { EVENT_TYPE, EVENT_SCOPE, EVENT_FORMAT, EVENT_STATUS } from "@/lib/labels";
import { createEvent, updateEvent, deleteEvent } from "@/lib/actions/event-actions";
import { addAdProItem } from "@/lib/actions/ad-pro-item-actions";
import { DescriptionLuna, remplirChampsVidesEvenement } from "@/components/ad-pro/description-luna";
import { versFormulairePoste, type PostePropose } from "@/lib/ad-pro/postes-luna";
import type { EventDetail } from "@/lib/queries/events";
import { MultiSelectField } from "@/components/shared/create-record-button";
import { ConfirmationSuppression } from "@/components/shared/super-admin-delete";
import { wilayaOptions } from "@/lib/geo/algeria";
import {
  availableProductOptions, doctorOptions, specialtyOptions, splitMulti, repartirMedecins, CHAMPS_MEDECINS,
  type DoctorRow, type ProductRow, type SpecialtyRow,
} from "@/lib/ad-pro/pickers";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉFÉRENTIELS D'UN ÉVÉNEMENT — les mêmes que ceux d'un sponsoring, et c'est le point.
 *
 * Décision de la Direction (22/09/2026) : « dans événements de Ad&Pro, mets la création de la
 * demande quasi tout obligatoire comme sponsoring, et le choix de la ville, médecins etc. selon
 * annuaires, menu déroulant etc. comme sponsoring vraiment avec budget obligatoire. »
 *
 * Mesuré avant de corriger : SEUL `name` portait `required`. La ville, la spécialité et les
 * produits étaient en saisie LIBRE, il n'y avait aucun champ pour les médecins, et le BUDGET
 * était facultatif.
 *
 * ── LE BUDGET FACULTATIF ÉTAIT LA CAUSE D'UNE AUTRE PLAINTE, ET C'EST LA MESURE QUI LE DIT ──
 *
 * « Le DG n'a pas à valider un événement Ad&Pro alors que le seuil est en dessous de
 * 1 000 000 DZD. » La chaîne, bout à bout : budget non saisi ⇒ `estimatedBudget` nul ⇒ le moteur
 * lit un montant de ZÉRO ⇒ `settleAutoSkips` refuse de franchir une porte de contrôle sur un
 * montant inconnu (`!(amount > 0)`) ⇒ la porte du DG reste ouverte. Cette garde est JUSTE — on
 * ne franchit pas une porte de contrôle sur un trou (§118.132) — donc le remède n'est pas de
 * l'assouplir, c'est de rendre le budget obligatoire. Les deux plaintes n'en faisaient qu'une.
 *
 * ── UN SEUL FORMULAIRE POUR CRÉER ET POUR MODIFIER ──────────────────────────────────────
 *
 * Ce composant sert les deux, et il se monte à DEUX endroits (l'écran Événements et le panneau
 * commun d'Ad & Pro). En passer un au socle `FieldDef` et laisser l'autre dessiné à la main
 * aurait fait deux listes de champs pour la même entité — la garantie qu'un champ ajouté d'un
 * côté manque de l'autre (c'est l'en-tête de `ad-pro/create-fields.ts`, lu à l'envers). Les
 * référentiels, eux, viennent des MÊMES lecteurs purs que le sponsoring : `ad-pro/pickers.ts`
 * et `geo/algeria.ts`. Une liste de wilayas recopiée ici serait fausse au premier ajout.
 *
 * RÉFÉRENTIEL VIDE ⇒ SAISIE LIBRE, mais toujours obligatoire. Un menu sans option est un
 * cul-de-sac, et une demande légitime ne doit pas attendre qu'on peuple une table (§118.108).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface EventReferentiels {
  doctors?: readonly DoctorRow[];
  products?: readonly ProductRow[];
  specialties?: readonly SpecialtyRow[];
  specialtiesHeritees?: readonly (string | null | undefined)[];
  businessUnits?: readonly { id: string; name: string }[];
  /** La gamme DÉDUITE du demandeur — le menu ne propose alors que celle-là (§118.108). */
  businessUnitDeduite?: { id: string; name: string; raison: string } | null;
}

type Result = { ok: boolean; error?: string; id?: string };
const d10 = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function W({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}><Label>{label}</Label>{children}</div>;
}

/** Intertitre d'une section du formulaire — le formulaire est long, il se lit par blocs au téléphone. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-border pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:border-t-0 first:pt-0 sm:col-span-2">
      {children}
    </p>
  );
}

function EventFields({ e, responsibles, referentiels = {}, descriptionEnTete }: {
  e?: EventDetail;
  /**
   * À LA CRÉATION, la description passe EN TÊTE (maquette « luna-postes ») : on y colle le mail
   * d'organisation, et Luna en tire le reste du formulaire. À la modification, elle reste en bas.
   */
  descriptionEnTete?: React.ReactNode;
  responsibles: { id: string; name: string }[];
  /**
   * NE JAMAIS NOMMER CETTE PROP `ref` : React l'INTERCEPTE sur un composant de fonction, elle
   * n'arrive pas dans les props, et tous les menus retombent alors sur leur saisie libre — un
   * défaut parfaitement silencieux, qui ressemble à un référentiel vide.
   */
  referentiels?: EventReferentiels;
}) {
  const medecins = doctorOptions(referentiels.doctors ?? []);
  // ROUVRIR SANS PERDRE (§118.175) : un médecin écrit à la main n'a pas de case où se recocher —
  // il revient dans la saisie « non présent », sinon le premier enregistrement l'effacerait.
  const medecinsDejaNommes = repartirMedecins(e?.doctor ?? null, medecins);
  const produits = availableProductOptions(referentiels.products ?? []);
  const specialites = specialtyOptions(referentiels.specialties ?? [], referentiels.specialtiesHeritees ?? []);
  const wilayas = wilayaOptions();
  const gammes = referentiels.businessUnits ?? [];
  const deduite = referentiels.businessUnitDeduite ?? null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
      {descriptionEnTete && <><Section>La demande</Section>{descriptionEnTete}</>}
      <Section>L&apos;événement</Section>
      <W full label="Nom de l'événement"><Input name="name" defaultValue={e?.name} required placeholder="Ex. Symposium Cardiologie 2027" /></W>
      {/* LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé. Quand elle se lit
          sur le demandeur (un KAM rattaché à sa BU, un superviseur d'UNE gamme), le champ n'est PAS
          proposé : le serveur la pose et ignore toute valeur postée (`gammeImposee`) — un champ de
          formulaire se forge, et une gamme forgée fait peser la dépense sur une autre équipe. */}
      {!deduite && gammes.length > 0 && (
        <W full label="Business Unit">
          <Select name="businessUnitId" defaultValue={e?.businessUnitId ?? ""} required>
            <option value="">— Choisir la gamme —</option>
            {gammes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </W>
      )}
      {/* TYPE, PORTÉE, FORMAT : un choix EXPLICITE, plus une valeur pré-remplie. C'est sur eux que
          l'arbitrage se fait, et une valeur par défaut EST une décision prise à la place du
          demandeur (§118.108). À la MODIFICATION la valeur existe, donc le repère ne gêne pas. */}
      <W label="Type">
        <Select name="type" defaultValue={e?.type ?? ""} required>
          <option value="">— Choisir le type —</option>
          {Object.entries(EVENT_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </W>
      <W label="Portée">
        <Select name="scope" defaultValue={e?.scope ?? ""} required>
          <option value="">— Choisir la portée —</option>
          {Object.entries(EVENT_SCOPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </W>
      <W label="Format">
        <Select name="format" defaultValue={e?.format ?? ""} required>
          <option value="">— Choisir le format —</option>
          {Object.entries(EVENT_FORMAT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </W>
      {/* LE STATUT NE SE SAISIT QUE SUR UN ÉVÉNEMENT EXISTANT, et jamais pendant qu'un circuit de
          prise en charge le gouverne (§118.138 : deux vérités sur l'état, la plus flatteuse
          gagnait). À la création il n'y a rien à corriger — l'événement naît en brouillon. */}
      {e && !e.requestStatus && (
        <W label="Statut"><Select name="status" defaultValue={e.status}>{Object.entries(EVENT_STATUS).map(([v, x]) => <option key={v} value={v}>{x.label}</option>)}</Select></W>
      )}
      <Section>Dates et lieu</Section>
      <W label="Début"><Input type="date" name="startDate" defaultValue={d10(e?.startDate ?? null)} required /></W>
      <W label="Fin"><Input type="date" name="endDate" defaultValue={d10(e?.endDate ?? null)} required /></W>
      <W label="Lieu / salle"><Input name="location" defaultValue={e?.location ?? ""} required /></W>
      {/* LA VILLE VIENT DU RÉFÉRENTIEL DES WILAYAS — elle s'écrivait en huit orthographes. */}
      <W label="Ville (wilaya)">
        <Select name="city" defaultValue={e?.city ?? ""} required>
          <option value="">— Choisir la wilaya —</option>
          {wilayas.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </Select>
      </W>
      <W label="Pays"><Input name="country" defaultValue={e?.country ?? "Algérie"} required /></W>
      <Section>Public, budget et produits</Section>
      {specialites.length > 0 ? (
        <W label="Spécialité">
          <Select name="specialty" defaultValue={e?.specialty ?? ""} required>
            <option value="">— Choisir la spécialité —</option>
            {specialites.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </W>
      ) : (
        <W label="Spécialité"><Input name="specialty" defaultValue={e?.specialty ?? ""} required placeholder="Le référentiel est vide : saisissez-la." /></W>
      )}
      <W label="Capacité max."><Input type="number" inputMode="numeric" name="capacity" defaultValue={e?.capacity ?? ""} /></W>
      {/* LE BUDGET EST OBLIGATOIRE, et c'est ce qui ferme la plainte du DG (voir l'en-tête). */}
      <W label="Budget estimé (DZD)">
        <Input type="number" step="any" min="0" inputMode="decimal" name="estimatedBudget" defaultValue={e?.estimatedBudget ?? ""} required />
      </W>
      {/* MÉDECINS ET PRODUITS : PLUSIEURS de chaque, choisis dans le réel. Repli en saisie libre
          quand le référentiel est muet — obligatoire, mais libre. */}
      <div className="min-w-0 sm:col-span-2">
        {medecins.length > 0 ? (
          <MultiSelectField field={{
            type: "multiselect", name: "doctorIds", label: "Médecin(s) concerné(s)", required: true, full: true,
            options: medecins, defaultValue: medecinsDejaNommes.coches,
            horsListe: {
              name: CHAMPS_MEDECINS.horsAnnuaire, label: "Médecin non présent dans l'annuaire",
              placeholder: "Un nom par ligne — Dr …", defaultValue: medecinsDejaNommes.horsAnnuaire,
            },
            searchPlaceholder: "Chercher un médecin de l'annuaire…",
            emptyLabel: "Aucun médecin dans l'annuaire.",
            hint: "Depuis l'annuaire des praticiens. Plusieurs choix possibles.",
          }} />
        ) : (
          <W full label="Médecin(s) concerné(s)">
            <Input name="doctor" defaultValue={e?.doctor ?? ""} required placeholder="L'annuaire des praticiens est vide : saisissez le ou les noms." />
          </W>
        )}
      </div>
      <div className="min-w-0 sm:col-span-2">
        {produits.length > 0 ? (
          <MultiSelectField field={{
            type: "multiselect", name: "productIds", label: "Produit(s) concerné(s)", required: true, full: true,
            options: produits, defaultValue: splitMulti(e?.products ?? null),
            searchPlaceholder: "Chercher un produit…",
            emptyLabel: "Aucun produit au traitement terminé.",
            hint: "Seuls les produits dont le traitement réglementaire est TERMINÉ — les seuls qu'on ait le droit de promouvoir.",
          }} />
        ) : (
          <W full label="Produit(s) concerné(s)">
            <Input name="product" defaultValue={e?.products ?? ""} required placeholder="Aucun dossier réglementaire n'est encore au traitement terminé." />
          </W>
        )}
      </div>
      <Section>Organisation</Section>
      <W full label="Lien Meet / Zoom / Teams (webinar/hybride)"><Input name="meetingLink" inputMode="url" autoComplete="url" defaultValue={e?.meetingLink ?? ""} placeholder="https://meet.google.com/…" /></W>
      <W label="Responsable interne">
        <Select name="responsibleId" defaultValue={e?.responsibleId ?? ""} required>
          <option value="">— Choisir le responsable —</option>
          {responsibles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
      </W>
      {!descriptionEnTete && <W full label="Description"><Textarea name="description" defaultValue={e?.description ?? ""} rows={3} required /></W>}
    </div>
  );
}

/**
 * LE FORMULAIRE SEUL, sans son bouton ni son panneau — il se monte aussi bien sur l'écran Events
 * que dans le panneau commun d'Ad & Pro, où la nature vient d'être choisie.
 */
export function CreateEventForm({ responsibles, referentiels, onDone, onCancel, cancelLabel = "Annuler" }: {
  responsibles: { id: string; name: string }[];
  /** Annuaires et gammes — sans eux, chaque menu retombe sur sa saisie libre (voir l'en-tête). */
  referentiels?: EventReferentiels;
  onDone: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // LES POSTES REPRIS DE LUNA — créés APRÈS la demande, un par un, par l'action ordinaire d'ajout de
  // poste (`addAdProItem`) : mêmes gardes, mêmes fiches que l'écran des postes.
  const [postesLuna, setPostesLuna] = React.useState<PostePropose[]>([]);
  // Demande créée mais un poste refusé : on ne renvoie pas le formulaire (il créerait une seconde demande).
  const [cree, setCree] = React.useState<{ id: string; echecs: string[] } | null>(null);

  async function creer(fd: FormData) {
    setSaving(true); setErr(null);
    const r: Result = await createEvent(fd);
    if (!r.ok || !r.id) { setSaving(false); setErr(r.error ?? "Erreur."); return; }
    const echecs: string[] = [];
    for (const p of postesLuna) {
      const f = new FormData();
      for (const [k, v] of versFormulairePoste(p, "EVENT", r.id)) f.append(k, v);
      const x = await addAdProItem(undefined, f).catch(() => ({ ok: false as const, error: "réessayez depuis la demande." }));
      if (!x.ok) echecs.push(`${p.libelle} : ${x.error ?? "refusé."}`);
    }
    setSaving(false);
    if (echecs.length > 0) { setCree({ id: r.id, echecs }); return; }
    onDone();
    router.push(`/events/${r.id}`);
  }

  if (cree) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Demande créée. {cree.echecs.length} poste{cree.echecs.length > 1 ? "s" : ""} non ajouté{cree.echecs.length > 1 ? "s" : ""} — à ajouter depuis la demande :
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm [overflow-wrap:anywhere]">{cree.echecs.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="flex justify-end"><Button type="button" onClick={() => { onDone(); router.push(`/events/${cree.id}`); }}>Ouvrir la demande</Button></div>
      </div>
    );
  }

  return (
    <form ref={formRef} action={creer} className="space-y-4">
      <EventFields
        responsibles={responsibles}
        referentiels={referentiels}
        descriptionEnTete={
          <DescriptionLuna
            onReprendre={(p) => { setPostesLuna(p.postes); return formRef.current ? remplirChampsVidesEvenement(formRef.current, p.evenement) : 0; }}
            onRetirer={() => setPostesLuna([])}
          />
        }
      />
      {err && <p className="break-words text-sm text-destructive">{err}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onCancel} className="w-full sm:w-auto">{cancelLabel}</Button><Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Créer{postesLuna.length > 0 ? ` avec ${postesLuna.length} poste${postesLuna.length > 1 ? "s" : ""}` : ""}</Button></div>
    </form>
  );
}

export function CreateEventButton({ responsibles, referentiels }: {
  responsibles: { id: string; name: string }[];
  referentiels?: EventReferentiels;
}) {
  const [open, setOpen] = React.useState(false);
  // Lien direct `?new=1` vers ce formulaire — voir `useAutoOpen`.
  useAutoOpen("new", () => setOpen(true));
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvel événement</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouvel événement" width="lg">
        <CreateEventForm responsibles={responsibles} referentiels={referentiels} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

export function EditEventButton({ event, responsibles, referentiels, canDelete, organisationSeule = false }: {
  event: EventDetail;
  responsibles: { id: string; name: string }[];
  referentiels?: EventReferentiels;
  canDelete: boolean;
  /**
   * La prise en charge est DÉCIDÉE et la personne ne voit pas tout le groupe : seule l'organisation se
   * modifie encore (`events/modification.ts`). On le dit AVANT l'enregistrement — le serveur refuserait
   * de toute façon, en nommant les champs, mais découvrir la règle après avoir tout ressaisi coûte un tour.
   */
  organisationSeule?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // LA SUPPRESSION passe par la même fenêtre que le bouton du Super Admin (§118.162) : elle lit
  // AVANT le clic ce qui part avec l'événement (sa déclaration d'information médicale, son
  // circuit, ses postes, ses inscriptions…) et dit le refus quand une branche porte un paiement
  // ou une signature. C'était un `window.confirm` qui annonçait « et ses inscriptions », puis
  // taisait l'échec : un refus du serveur ne s'affichait nulle part.
  const [suppression, setSuppression] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setErr(null); setOpen(true); }}><Pencil className="h-4 w-4" /> Modifier</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Modifier l'événement" width="lg">
        <form action={async (fd) => { fd.set("id", event.id); setSaving(true); setErr(null); const r: Result = await updateEvent(fd); setSaving(false); if (r.ok) { setOpen(false); router.refresh(); } else setErr(r.error ?? "Erreur."); }} className="space-y-4">
          {organisationSeule && (
            <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              La prise en charge est décidée : le nom, les dates, le lieu, les médecins, les produits et le budget ne se modifient plus
              qu&apos;avec la Direction. L&apos;organisation — lien de connexion, capacité, responsable, description, état — reste modifiable.
            </p>
          )}
          <EventFields e={event} responsibles={responsibles} referentiels={referentiels} />
          {err && <p className="break-words text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {canDelete ? <Button type="button" variant="ghost" className="w-full text-destructive sm:w-auto" onClick={() => { setOpen(false); setSuppression(true); }}><Trash2 className="h-4 w-4" /> Supprimer</Button> : <span className="hidden sm:block" />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row"><Button type="button" variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto">Annuler</Button><Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
          </div>
        </form>
      </Sheet>
      {canDelete && (
        <ConfirmationSuppression
          open={suppression}
          onClose={() => setSuppression(false)}
          kind="EVENT"
          id={event.id}
          name={event.name}
          executer={deleteEvent}
          onSupprime={() => { setSuppression(false); router.push("/events"); router.refresh(); }}
        />
      )}
    </>
  );
}
