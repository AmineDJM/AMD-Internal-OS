import type { FieldDef } from "@/components/shared/create-record-button";
import { MAIL_DIRECTION } from "@/lib/labels";
import type { PartyOption } from "@/lib/contacts/parties";

/**
 * LES CHAMPS D'UN COURRIER — une seule définition pour la création ET la modification.
 *
 * Deux listes séparées finiraient par diverger : on ajouterait un champ à la création, la fiche
 * ne saurait plus le corriger, et le registre aurait une colonne qu'on ne peut plus rectifier.
 *
 * `values` pré-remplit le formulaire quand on rouvre une fiche. Les dates y arrivent au format
 * attendu par les champs du navigateur (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`) — voir `dateInput` /
 * `dateTimeInput` côté serveur, qui les produisent dans le MÊME fuseau que celui où l'action
 * serveur les relira : sans quoi ouvrir puis enregistrer sans rien toucher décalerait l'heure.
 */
export function mailFields(
  values: Partial<Record<string, string>> = {},
  mode: "create" | "edit" = "edit",
  /** Entités que CETTE personne a le droit de choisir. Une seule → le menu la présélectionne. */
  companies: { value: string; label: string }[] = [],
  /** Partenaires actifs du registre — la liste que tient l'assistante de direction. */
  partners: { value: string; label: string }[] = [],
  /** Directions (départements) de l'organigramme, indentées selon leur profondeur. */
  departments: { value: string; label: string }[] = [],
  /** Comptes actifs — la personne nommément visée par le pli. */
  people: { value: string; label: string }[] = [],
  /** Dossiers de classement du registre, indentés selon leur profondeur. */
  folders: { value: string; label: string }[] = [],
  /**
   * L'ANNUAIRE DE L'ENTREPRISE — d'où l'expéditeur et le destinataire se CHOISISSENT.
   *
   * Ils étaient du texte libre : trois orthographes du même correspondant, aucune ne portant un
   * numéro. `canCreate` est le droit d'écriture de l'annuaire, calculé au serveur : sans lui, le
   * bouton « Créer un contact » n'apparaît pas — un bouton qui mène à un refus est pire qu'un
   * bouton absent.
   */
  parties: { options: PartyOption[]; canCreate: boolean; selected?: Partial<Record<"sender" | "recipient", string[]>> } = { options: [], canCreate: false },
): FieldDef[] {
  const v = (k: string) => values[k] ?? undefined;
  return [
    { type: "text", name: "title", label: "Objet du courrier", required: true, full: true, defaultValue: v("title") },
    {
      type: "select", name: "direction", label: "Sens",
      options: Object.entries(MAIL_DIRECTION).map(([value, d]) => ({ value, label: d.label })),
      defaultValue: v("direction") ?? "OUTGOING",
    },
    { type: "text", name: "reference", label: "N° de chrono", defaultValue: v("reference") },
    // L'ENTITÉ SE CHOISIT. Elle était déduite de la portée du sélecteur : un courrier saisi en
    // vue « toutes les entités » n'en portait aucune, et l'assistante qui traite les plis des
    // trois sociétés devait changer de portée entre deux enregistrements.
    ...(companies.length > 0
      ? ([{
          type: "select", name: "companyId", label: "Entité concernée", options: companies,
          placeholder: companies.length > 1 ? "— Choisir l'entité —" : undefined,
          defaultValue: v("companyId") ?? (companies.length === 1 ? companies[0].value : undefined),
        }] as FieldDef[])
      : []),
    // LE PARTENAIRE, s'il y en a un. Facultatif : beaucoup de plis sont internes, et rendre le
    // champ obligatoire ferait inventer des partenaires pour pouvoir enregistrer un courrier.
    ...(partners.length > 0
      ? ([{
          type: "select", name: "partnerId", label: "Partenaire concerné", options: partners,
          placeholder: "— Aucun —", defaultValue: v("partnerId"),
        }] as FieldDef[])
      : []),
    // À QUI LE PLI S'ADRESSE, en interne. Un courrier arrive au registre, mais il vise quelqu'un :
    // sans ces deux champs, l'assistante devait se souvenir de qui l'attendait, et un pli non
    // relevé ne se retrouvait que par son objet. Les deux sont FACULTATIFS et se CUMULENT — un
    // contrat vise « la Direction Générale » ET son directeur, une convocation une seule personne,
    // une mise en demeure un seul service.
    ...(departments.length > 0
      ? ([{
          type: "select", name: "departmentId", label: "Direction concernée", options: departments,
          placeholder: "— Aucune —", defaultValue: v("departmentId"),
        }] as FieldDef[])
      : []),
    ...(people.length > 0
      ? ([{
          type: "select", name: "concernedUserId", label: "Personne concernée", options: people,
          placeholder: "— Aucune —", defaultValue: v("concernedUserId"),
        }] as FieldDef[])
      : []),
    // EXPÉDITEUR ET DESTINATAIRE — un seul chacun, choisi dans l'annuaire de l'entreprise. Un
    // pli part d'un endroit et arrive à un autre : la cardinalité n'est pas celle des parties
    // d'un contrat, qui sont réellement plusieurs. Laissés vides, ils ne postent rien et la
    // correction garde le correspondant en texte ; RETIRER le contact poste `…__vide` et l'efface.
    {
      type: "parties", name: "senderContactId", label: "Expéditeur", arity: 1,
      options: parties.options, canCreate: parties.canCreate,
      defaultValue: parties.selected?.sender ?? [], signalerVidage: true,
      placeholder: "Chercher l\u2019expéditeur dans l\u2019annuaire…",
      hint: v("sender") && !(parties.selected?.sender ?? []).length
        ? `Correspondant enregistré en texte : « ${v("sender")} ». Choisissez-le dans l\u2019annuaire pour qu\u2019on puisse le joindre.`
        : undefined,
    },
    {
      type: "parties", name: "recipientContactId", label: "Destinataire", arity: 1,
      options: parties.options, canCreate: parties.canCreate,
      defaultValue: parties.selected?.recipient ?? [], signalerVidage: true,
      placeholder: "Chercher le destinataire dans l\u2019annuaire…",
      hint: v("recipient") && !(parties.selected?.recipient ?? []).length
        ? `Correspondant enregistré en texte : « ${v("recipient")} ». Choisissez-le dans l\u2019annuaire pour qu\u2019on puisse le joindre.`
        : undefined,
    },
    // Le départ porte l'HEURE : c'est ce qui départage deux plis du même jour.
    { type: "datetime-local", name: "sentAt", label: "Départ (date et heure)", defaultValue: v("sentAt") },
    { type: "date", name: "receivedAt", label: "Arrivée", defaultValue: v("receivedAt") },
    { type: "date", name: "acknowledgedAt", label: "Accusé de réception", defaultValue: v("acknowledgedAt") },
    { type: "text", name: "carrier", label: "Porteur (poste, coursier, e-mail…)", defaultValue: v("carrier") },
    // LE DOSSIER DE CLASSEMENT, s'il y en a un. Facultatif : un pli s'enregistre vite et se range
    // ensuite. Un dossier RANGE, il n'autorise pas — le cloisonnement par entité ne change pas.
    ...(folders.length > 0
      ? ([{
          type: "select", name: "folderId", label: "Dossier de classement", options: folders,
          placeholder: "— Non classé —", defaultValue: v("folderId"),
        }] as FieldDef[])
      : []),
    { type: "textarea", name: "notes", label: "Notes", full: true, defaultValue: v("notes") },
    // LE PLI SCANNÉ, DÈS L'ENREGISTREMENT — c'est le moment où on l'a en main. Ou bien on
    // téléverse le scan, ou bien on désigne le fichier qui est DÉJÀ dans le Drive, qui n'est
    // alors pas recopié mais référencé. La fiche porte ensuite ses propres blocs pour les deux.
    ...(mode === "create"
      ? ([
          {
            type: "file", name: "attachment", label: "Pièces jointes", multiple: true, full: true,
            hint: "Le scan du pli, l'accusé de réception… rattachés au courrier dès sa création.",
          },
          {
            type: "drivepicker", name: "driveNodeId", label: "…ou un dossier / fichier du Drive", full: true,
            hint: "Le fichier RESTE dans le Drive : le courrier le référence, il ne le duplique pas.",
          },
        ] as FieldDef[])
      : []),
  ];
}

/** Une date pour un `<input type="date">`, dans le fuseau du serveur (celui qui la relira). */
export function dateInput(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Idem pour un `<input type="datetime-local">` : « YYYY-MM-DDTHH:mm ». */
export function dateTimeInput(d: Date | null | undefined): string | undefined {
  const day = dateInput(d);
  if (!day || !d) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
