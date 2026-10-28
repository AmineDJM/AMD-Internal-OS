"use client";

import * as React from "react";
import { useAutoOpen } from "@/components/shared/use-auto-open";
import { useRouter } from "next/navigation";
import { Plus, Loader2, AlertCircle, X, Search, Check, UserPlus } from "lucide-react";
import { createCongressRequest } from "@/modules/ad-pro/actions-congres";
import { creerProfilProfessionnel } from "@/modules/ad-pro/actions-prise-en-charge";
import { listBeneficiaryRefs } from "@/modules/ad-pro/actions-congres-beneficiaires";
import { filtrerAnnuaire, PLAFOND_MENU } from "@/modules/ad-pro/ecrans/prise-en-charge/filtrer-annuaire";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Label } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { wilayaOptions } from "@/lib/geo/algeria";
import { NATIONAL_EVENT_TYPE } from "@/lib/labels";
import { businessUnitField } from "@/modules/ad-pro/partage";
import type { ProductRow, SpecialtyRow } from "@/modules/ad-pro/partage";

const WILAYA_OPTIONS = wilayaOptions();

export interface DoctorOpt { id: string; name: string; specialty: string; city: string }
export interface UserOpt { id: string; name: string; role: string }


export interface CongressFormProps {
  national?: boolean;
  doctors: DoctorOpt[];
  users: UserOpt[];
  /**
   * LES RÉFÉRENTIELS — produits promouvables, spécialités, gammes. Facultatifs dans le TYPE et
   * non dans l'écran : les trois points de montage les passent tous, et un défaut vide fait
   * retomber chaque champ sur son repli plutôt que d'échouer au rendu.
   */
  products?: ProductRow[];
  specialties?: SpecialtyRow[];
  specialtiesHeritees?: string[];
  businessUnits?: { id: string; name: string }[];
  businessUnitDeduite?: { id: string; name: string; raison: string } | null;
}

interface CongressRequestFormProps extends CongressFormProps {
  /** Demande envoyée — l'appelant referme le panneau qui porte ce formulaire. */
  onDone: () => void;
  /** Bouton secondaire : fermer ici, revenir au choix de la nature depuis Ad & Pro. */
  onCancel: () => void;
  cancelLabel?: string;
}

/**
 * LE FORMULAIRE SEUL, sans son bouton ni son panneau.
 *
 * Il se monte à deux endroits : l'écran de la nature (via `CongressRequestButton`) et le panneau
 * commun d'Ad & Pro, où la nature vient d'être choisie — on y ouvrirait sinon un panneau
 * par-dessus le panneau.
 */
export function CongressRequestForm({
  national, doctors, onDone, onCancel, cancelLabel = "Annuler",
  businessUnits = [], businessUnitDeduite = null,
}: CongressRequestFormProps) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const [pickedDoctors, setPickedDoctors] = React.useState<Set<string>>(new Set());
  // QUI EST À L'ORIGINE DE LA DEMANDE (Direction, 07/10) — et, à l'initiative du médecin, lequel (ou lesquels).
  const [initiative, setInitiative] = React.useState<"" | "DEMANDEUR" | "MEDECIN">("");
  // LE MODE DE PRISE EN CHARGE (Direction, 10/2026) : individuelle (par défaut) ou de groupe.
  const [careMode, setCareMode] = React.useState<"INDIVIDUAL" | "GROUP">("INDIVIDUAL");

  /*
   * NI SPÉCIALITÉ NI PRODUITS sur une prise en charge (décision de la Direction, 04/10/2026). La
   * spécialité filtrait la liste des médecins : la liste se CHERCHE désormais, par nom, spécialité ou
   * établissement, dans tout l'annuaire.
   */
  const [annuaire, setAnnuaire] = React.useState<DoctorOpt[]>(doctors);
  const [doctorQuery, setDoctorQuery] = React.useState("");
  const champGamme = React.useMemo(
    () => businessUnitField(businessUnits, businessUnitDeduite)[0] ?? null,
    [businessUnits, businessUnitDeduite],
  );
  const trouves = React.useMemo(
    () => filtrerAnnuaire(annuaire.map((d) => ({ ...d, institution: d.city })), doctorQuery),
    [annuaire, doctorQuery],
  );
  const doctorById = React.useMemo(() => new Map(annuaire.map((d) => [d.id, d])), [annuaire]);

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setter(n);
  };

  const submit = async () => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    fd.set("type", national ? "NATIONAL" : "INTL");
    // LE OU LES MÉDECINS À L'ORIGINE (initiative du médecin) — l'origine de la demande, pas une prise en charge :
    // les professionnels pris en charge s'ajoutent DANS la demande, fiche par fiche (Direction, 10/2026).
    if (initiative === "MEDECIN") pickedDoctors.forEach((id) => fd.append("initiativeDoctorIds", id));
    fd.set("initiative", initiative);
    fd.set("careMode", careMode);
    // Tout ce qui manque, en une fois — le serveur dit la même chose (`createCongressRequest`).
    const manque = [
      String(fd.get("name") ?? "").trim() ? null : "le nom de l'événement",
      String(fd.get(national ? "date" : "startDate") ?? "") ? null : "la date de début de l'événement",
      String(fd.get("endDate") ?? "") ? null : "la date de fin de l'événement",
      initiative ? null : "qui est à l'origine de l'événement (votre initiative ou celle du médecin)",
      initiative === "MEDECIN" && pickedDoctors.size === 0 ? "le ou les médecins à l'origine de la demande" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length > 0) { setErr(`À renseigner : ${manque.join(", ")}.`); return; }
    setSaving(true); setErr(null);
    const r = await createCongressRequest(undefined, fd);
    setSaving(false);
    // On atterrit sur la demande, section Professionnels : c'est là qu'on ajoute les personnes prises en charge.
    if (r.ok) { onDone(); router.refresh(); if (r.id) router.push(`${national ? "/congress-national" : "/congress-international"}/${r.id}#professionnels`); }
    else setErr(r.error ?? "Erreur.");
  };

  return (
    <form ref={formRef} action={submit} className="space-y-5">
        {/* Infos générales — même cadre que les deux sections suivantes, pour que le formulaire se
            lise en trois blocs au téléphone ; une colonne au téléphone, deux au-delà. */}
        <div className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-sm font-medium">L&apos;événement</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          {/* LA GAMME QUI PORTE LA DEMANDE — le champ MANQUAIT sur ce formulaire, alors que
              l'action le lisait déjà : les deux prises en charge sortaient donc sans gamme, et
              leur dépense n'était rattachable à aucune équipe (§118.108, §118.140). La décision
              (options, obligation, gamme déduite du demandeur, disparition quand aucune gamme
              n'existe) vient du module partagé — seul le rendu est local. */}
          {champGamme && champGamme.type === "select" && (
            <Field full label={champGamme.label} required={champGamme.required}>
              <Select name={champGamme.name} required={champGamme.required} defaultValue={typeof champGamme.defaultValue === "string" ? champGamme.defaultValue : ""}>
                {!champGamme.defaultValue && <option value="">{champGamme.placeholder ?? "— Choisir —"}</option>}
                {champGamme.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {champGamme.hint && <p className="mt-1 text-[0.6875rem] text-muted-foreground">{champGamme.hint}</p>}
            </Field>
          )}
          <Field full label="Nom de l'événement" required><Input name="name" required placeholder="Ex. ECCMID 2026" /></Field>
          <Field full label={initiative === "MEDECIN" ? "Demande(s) du médecin" : "Pièces jointes (invitation, programme…)"}>
            <input name="files" type="file" multiple
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm" />

          </Field>
          <Field label="Type d'événement">
            <Select name="eventType" defaultValue="CONGRESS">
              {Object.entries(NATIONAL_EVENT_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {national ? (
            <>
              {/* LA VILLE SE CHOISIT, elle ne se tape plus : on lisait « Alger », « alger »,
                  « ALGER », « Algiers » dans la même colonne — remplie, mais inexploitable. Plus de
                  « Pays » sur une prise en charge NATIONALE (décision du 04/10/2026). */}
              <Field label="Ville (wilaya)">
                <Select name="city" defaultValue="">
                  <option value="">— Choisir la wilaya —</option>
                  {WILAYA_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </Select>
              </Field>
              <Field label="Institution hôte"><Input name="hostInstitution" placeholder="Hôpital / association" /></Field>
              <Field label="Date de début de l'événement" required><Input name="date" type="date" required /></Field>
              <Field label="Date de fin de l'événement" required><Input name="endDate" type="date" required /></Field>
            </>
          ) : (
            <>
              <Field label="Pays"><Input name="country" placeholder="Ex. France" /></Field>
              {/* LA VILLE SE SAISIT (Direction, 07/10) : un congrès international ne se tient pas dans une wilaya. */}
              <Field label="Ville"><Input name="city" placeholder="Ex. Paris" /></Field>
              <Field label="Date de début de l'événement" required><Input name="startDate" type="date" required /></Field>
              <Field label="Date de fin de l'événement" required><Input name="endDate" type="date" required /></Field>
            </>
          )}
        </div>
        </div>

        {/* LES PROFESSIONNELS PROPOSÉS POUR LA PRISE EN CHARGE — un menu AVEC RECHERCHE dans
            l'annuaire, et la création d'un profil pour un médecin qui n'y figure pas. Ce sont des
            PROPOSITIONS : la Direction tranche personne par personne sur la fiche, où la MÊME liste
            se complète (personne libre comprise) et où leurs pièces se demandent et se suivent. */}
        {/* CET ÉVÉNEMENT EST… (Direction, 07/10) — mon initiative, ou celle du médecin : dans ce cas, le ou les médecins
            de l'annuaire qui l'ont demandée, choisis dans la même liste que les professionnels proposés. */}
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">Cet événement est <span className="text-destructive">*</span></legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([["DEMANDEUR", "Mon initiative"], ["MEDECIN", "Initiative du médecin"]] as const).map(([v, l]) => (
              <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-10">
                <input type="radio" name="initiative-choix" value={v} checked={initiative === v} onChange={() => setInitiative(v)} className="h-4 w-4 shrink-0" />
                {l}
              </label>
            ))}
          </div>
        </fieldset>

        {/* LE MODE DE PRISE EN CHARGE (Direction, 10/2026) — modifiable ensuite en corrigeant la demande. */}
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="flex items-center gap-1 px-1 text-sm font-medium">
            Mode de prise en charge
            <InfoBulle label="Individuelle ou de groupe ?">
              Individuelle : chaque personne a ses postes et ses devis. De groupe : un devis par catégorie (billets, hôtel…) couvre tout le monde, et un poste « par personne » (ex. repas) s&apos;applique à chacun.
              {!national && " À l'international, tout sauf la billetterie se saisit en dollars."}
            </InfoBulle>
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([["INDIVIDUAL", "Individuelle"], ["GROUP", "De groupe"]] as const).map(([v, l]) => (
              <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-10">
                <input type="radio" name="careMode-choix" value={v} checked={careMode === v} onChange={() => setCareMode(v)} className="h-4 w-4 shrink-0" />
                {l}
              </label>
            ))}
          </div>
        </fieldset>

        {/* LES PROFESSIONNELS NE SE SAISISSENT PLUS ICI (Direction, 10/2026) : ils s'ajoutent dans la demande, chacun
            avec sa fiche voyageur. Seule l'INITIATIVE DU MÉDECIN demande ici le ou les médecins à l'origine. */}
        {initiative === "MEDECIN" && <div className="space-y-2 rounded-lg border border-border p-3">
          <Label>
            Médecin(s) à l&apos;origine de la demande
            <span className="ml-0.5 text-destructive">*</span>
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={doctorQuery} onChange={(e) => setDoctorQuery(e.target.value)} placeholder="Rechercher un praticien (nom, spécialité, ville)…" className="pl-8" aria-label="Rechercher un praticien" />
          </div>
          <div className="max-h-44 space-y-1 overflow-auto rounded-md bg-muted/30 p-2">
            {trouves.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">Aucun praticien ne correspond — créez son profil ci-dessous.</p>
            ) : trouves.map((d) => (
              <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-2 text-sm hover:bg-secondary sm:py-1">
                <input type="checkbox" checked={pickedDoctors.has(d.id)} onChange={() => toggle(pickedDoctors, d.id, setPickedDoctors)} className="h-4 w-4 shrink-0 rounded border-input" />
                <span className="min-w-0 break-words">
                  <span>{d.name}</span>{(d.specialty || d.city) && <span className="text-xs text-muted-foreground"> · {[d.specialty, d.city].filter(Boolean).join(" · ")}</span>}
                </span>
              </label>
            ))}
            {trouves.length >= PLAFOND_MENU && <p className="px-1 text-[0.6875rem] text-muted-foreground">Les {PLAFOND_MENU} premiers seulement — précisez la recherche.</p>}
          </div>
          {pickedDoctors.size > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[...pickedDoctors].map((id) => (
                <Chip key={id} label={doctorById.get(id)?.name ?? id} onRemove={() => toggle(pickedDoctors, id, setPickedDoctors)} />
              ))}
            </div>
          )}
          <NouveauProfil
            scope={national ? "NATIONAL" : "INTERNATIONAL"}
            onCree={(d) => {
              setAnnuaire((a) => [d, ...a]);
              setPickedDoctors((p) => new Set(p).add(d.id));
            }}
          />
        </div>}

        {err && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{err}</span></div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} className="w-full sm:w-auto">{cancelLabel}</Button>
          <Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Envoyer la demande</Button>
        </div>
      </form>
  );
}

/**
 * Le bouton de l'écran Prises en charge : déclencheur et panneau autour du formulaire.
 *
 * Le formulaire se remonte à chaque ouverture — les médecins cochés et l'erreur affichée
 * la fois précédente ne reviennent donc pas accueillir la demande suivante.
 */
export function CongressRequestButton(props: CongressFormProps) {
  const [open, setOpen] = React.useState(false);
  // Lien direct `?new=1` vers ce formulaire — voir `useAutoOpen`.
  useAutoOpen("new", () => setOpen(true));
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvelle demande</Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={props.national ? "Nouvelle prise en charge \u2014 nationale" : "Nouvelle prise en charge \u2014 internationale"}
        description={"L\u2019\u00e9v\u00e9nement d\u2019abord. Les professionnels s\u2019ajoutent dans la demande, une fois cr\u00e9\u00e9e."}
        width="lg"
      >
        <CongressRequestForm {...props} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

/**
 * CRÉER LE PROFIL D'UN MÉDECIN qui n'est pas encore à l'annuaire — il y entre tout de suite, et il
 * est coché parmi les professionnels proposés. Pas de `<form>` imbriqué : le formulaire parent
 * enverrait la demande à la place du profil.
 */
function NouveauProfil({ scope, onCree }: { scope: "NATIONAL" | "INTERNATIONAL"; onCree: (d: DoctorOpt) => void }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [nom, setNom] = React.useState("");
  const [specialite, setSpecialite] = React.useState("");
  const [etablissement, setEtablissement] = React.useState("");
  const [secteur, setSecteur] = React.useState("");
  const [refs, setRefs] = React.useState<{ specialties: { id: string; name: string }[]; institutions: { id: string; name: string; wilaya: string | null }[] } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!ouvert || refs) return;
    listBeneficiaryRefs().then((r) => setRefs({ specialties: r.specialties, institutions: r.institutions })).catch(() => setRefs({ specialties: [], institutions: [] }));
  }, [ouvert, refs]);

  if (!ouvert) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOuvert(true)}>
        <UserPlus className="h-4 w-4" /> Créer un profil de médecin
      </Button>
    );
  }
  const creer = async () => {
    if (!nom.trim()) { setErreur("Le nom du médecin est obligatoire."); return; }
    const fd = new FormData();
    fd.set("scope", scope);
    fd.set("doctorName", nom);
    if (specialite) fd.set("specialtyId", specialite);
    if (etablissement) fd.set("institutionId", etablissement);
    if (secteur) fd.set("sector", secteur);
    setBusy(true); setErreur(null);
    const r = await creerProfilProfessionnel(undefined, fd);
    setBusy(false);
    if (!r.ok || !r.id) { setErreur(r.error ?? "Le profil n'a pas pu être créé."); return; }
    onCree({
      id: r.id, name: r.message ?? nom.trim(),
      specialty: refs?.specialties.find((x) => x.id === specialite)?.name ?? "",
      city: refs?.institutions.find((x) => x.id === etablissement)?.name ?? "",
    });
    setNom(""); setSpecialite(""); setEtablissement(""); setSecteur(""); setOuvert(false);
  };
  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-dashed border-border p-2 sm:grid-cols-2">
      <div className="sm:col-span-2"><Input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Nom du médecin" aria-label="Nom du médecin" /></div>
      <Select value={specialite} onChange={(e) => setSpecialite(e.target.value)} aria-label="Spécialité du médecin">
        <option value="">— Spécialité —</option>
        {(refs?.specialties ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </Select>
      <Select value={secteur} onChange={(e) => setSecteur(e.target.value)} aria-label="Secteur du médecin">
        <option value="">— Secteur —</option>
        <option value="HOSPITAL">Hospitalier</option><option value="LIBERAL">Libéral</option><option value="BOTH">Les deux</option>
      </Select>
      <div className="sm:col-span-2">
        <Select value={etablissement} onChange={(e) => setEtablissement(e.target.value)} aria-label="Établissement du médecin">
          <option value="">— Établissement —</option>
          {(refs?.institutions ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.wilaya ? ` · ${x.wilaya}` : ""}</option>)}
        </Select>
      </div>
      {erreur && <p className="text-xs text-destructive sm:col-span-2">{erreur}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="button" size="sm" onClick={() => void creer()} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Créer et proposer</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOuvert(false)}>Annuler</Button>
      </div>
    </div>
  );
}

function Field({ label, full, required, children }: { label: string; full?: boolean; required?: boolean; children: React.ReactNode }) {
  return (
    // `sm:col-span-2` ET NON `col-span-2` : la grille passe à UNE colonne sous le point de
    // rupture (le garde-fou responsive l'exige), et un `col-span-2` non préfixé y déborderait
    // donc de sa grille — un défilement latéral sur mobile, exactement ce que la règle ferme.
    <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      {children}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-0.5 text-xs text-primary">
      <span className="min-w-0 truncate">{label}</span>
      {/* Croix assez grande pour le doigt au téléphone, compacte au bureau. */}
      <button type="button" onClick={onRemove} aria-label={`Retirer ${label}`} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-primary/20 sm:h-5 sm:w-5"><X className="h-3 w-3" /></button>
    </span>
  );
}
