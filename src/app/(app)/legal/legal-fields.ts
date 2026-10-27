import type { FieldDef } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { LEGAL_DOC_KIND } from "@/lib/labels";
import type { PartyOption } from "@/lib/contacts/parties";
import { LIBELLE_CHAMP_DU_FICHIER } from "@/lib/legal/piece-emise";

/**
 * LES CHAMPS D'UN DOCUMENT LÉGAL — une seule définition pour la création ET la modification.
 *
 * Deux listes séparées finiraient par diverger : on ajouterait un champ à la création, la fiche
 * ne saurait plus le corriger, et l'on aurait un engagement qu'on ne peut plus rectifier.
 *
 * ── LES DEUX CHAMPS D'UNE FACTURE ───────────────────────────────────────────────────────────
 *
 * Le SENS de l'argent et la DATE DE RÈGLEMENT n'ont de sens que sur une facture. Ils figurent
 * pourtant dans le formulaire commun, et c'est le prix assumé de n'avoir qu'un seul formulaire :
 * un second, réservé aux factures, redeviendrait l'endroit spécial qu'on vient de fermer. Leurs
 * libellés le disent (« facture »), et le serveur les ignore sur toute autre nature — un bail ne
 * portera jamais de sens de l'argent, même si quelqu'un remplit le champ.
 */
/**
 * LES LIBELLÉS QUE PREND UNE FACTURE — lus ici par `legalFields`, et par la saisie préremplie (`champs-preremplis.ts`)
 * quand la pièce lue se révèle une facture alors que le formulaire s'est ouvert en « document » (§118.5 : une source).
 */
export const LIBELLES_FACTURE = {
  title: "Objet de la facture",
  reference: "N° de facture",
  startDate: "Date d’émission",
  endDate: "Échéance de règlement",
} as const;

export function legalFields(
  values: Partial<Record<string, string>> = {},
  mode: "create" | "edit" = "edit",
  /** Personnes désignables comme lecteurs. Vide → la case n'apparaît pas. */
  people: { value: string; label: string }[] = [],
  /** Dossiers de classement. Vide → le champ n'apparaît pas (aucune armoire à ranger). */
  folders: { value: string; label: string }[] = [],
  /** Pièces amont possibles (devis, BC…) pour la CHAÎNE. Vide → le champ n'apparaît pas. */
  chainCandidates: { value: string; label: string }[] = [],
  /**
   * La personne ne tient QUE les factures (comptabilité). La nature n'est alors pas un choix :
   * la proposer laisserait enregistrer un bail qu'on ne pourrait plus ni voir ni corriger.
   */
  invoiceOnly = false,
  /**
   * L'ANNUAIRE DE L'ENTREPRISE — d'où les PARTIES se choisissent, une ou plusieurs.
   *
   * `selected` porte celles déjà retenues sur la pièce ; `canCreate` est le droit d'écriture de
   * l'annuaire, calculé au serveur.
   */
  parties: { options: PartyOption[]; canCreate: boolean; selected?: string[] } = { options: [], canCreate: false },
  /**
   * UNE PIÈCE ÉMISE PAR LA PLATEFORME (§118.194) : son montant, sa partie, son numéro, sa nature, ses dates et
   * son sens viennent de son FICHIER. Ces champs ne s'offrent pas ici — le serveur les garde, et refuse de les
   * changer : la révision (ou, pour une facture, l'annulation) est le geste qui les corrige.
   */
  pieceEmise = false,
  /**
   * LA DATE DE RÈGLEMENT NE S'OFFRE QU'À QUI RÈGLE AUX FINANCES (`peutDaterLeReglement`, audit Assistante de
   * direction, 10/2026) : la poser déclare la facture réglée et écrit au livre. Absente du formulaire, le serveur
   * garde la date existante — il ne l'efface pas.
   */
  daterLeReglement = true,
): FieldDef[] {
  const v = (k: string) => values[k] ?? undefined;
  const facture = invoiceOnly || v("kind") === "INVOICE";
  const tous = construire();
  const champs = daterLeReglement ? tous : tous.filter((c) => !("name" in c) || c.name !== "paidDate");
  return pieceEmise ? champs.filter((c) => !("name" in c) || !CHAMPS_DU_FICHIER.has(c.name)) : champs;

  function construire(): FieldDef[] {
  return [
    {
      type: "text", name: "title",
      label: facture ? LIBELLES_FACTURE.title : "Titre exact du document",
      required: true, full: true, defaultValue: v("title"),
    },
    { type: "text", name: "reference", label: facture ? LIBELLES_FACTURE.reference : "Référence / n°", defaultValue: v("reference") },
    ...(invoiceOnly
      ? ([{ type: "hidden", name: "kind", value: "INVOICE" }] as FieldDef[])
      : ([{ type: "select", name: "kind", label: "Nature", options: optionsFromMap(LEGAL_DOC_KIND), defaultValue: v("kind") ?? "CONTRACT" }] as FieldDef[])),
    // LA PARTIE SE CHOISIT — elle ne se tape plus. Une ou plusieurs (co-traitance, groupement,
    // avenant tripartite), et le nom affiché s'ouvre sur le mail et le contact.
    {
      type: "parties", name: "counterpartyIds", label: "Partie (fournisseur, client, prestataire)",
      required: true, full: true, arity: "many",
      options: parties.options, canCreate: parties.canCreate,
      defaultValue: parties.selected ?? [],
      placeholder: "Chercher la partie dans l\u2019annuaire — un métier, un nom, un numéro…",
      hint: v("counterparty") && !(parties.selected ?? []).length
        ? `Partie enregistrée en texte : « ${v("counterparty")} ». Choisissez-la dans l\u2019annuaire pour qu\u2019on puisse la joindre.`
        : "Choisissez-la dans l\u2019annuaire de l\u2019entreprise. Absente ? « Créer un contact » l\u2019y ajoute sans quitter cette saisie.",
    },
    { type: "date", name: "startDate", label: facture ? LIBELLES_FACTURE.startDate : "Date de début (facultative)", defaultValue: v("startDate") },
    { type: "date", name: "endDate", label: facture ? LIBELLES_FACTURE.endDate : "Date de fin — vide = sans échéance", defaultValue: v("endDate") },
    { type: "number", name: "amount", label: "Montant (DZD)", defaultValue: v("amount") },
    // LE SENS DE L'ARGENT — jamais deviné du nom de la partie en face : selon la facture, la
    // même société est celle qu'on paie ou celle qui nous paie, et une écriture posée à
    // l'envers est pire qu'une écriture absente parce qu'elle se voit moins.
    {
      type: "select", name: "direction", label: "Facture — sens de l’argent",
      options: [
        { value: "OUT", label: "Reçue — nous payons" },
        { value: "IN", label: "Émise — nous encaissons" },
      ],
      defaultValue: v("direction") ?? "OUT",
    },
    {
      type: "date", name: "paidDate", label: "Facture — date de règlement (si déjà réglée)",
      defaultValue: v("paidDate"),
      hint: "La renseigner déclare la facture réglée et inscrit le mouvement aux Finances ; l’effacer le retire. Une facture partie au règlement se solde par son paiement — cette date lui est refusée.",
    },
    { type: "textarea", name: "notes", label: "Notes", full: true, defaultValue: v("notes") },
    // LA CHAÎNE DU DOSSIER D'ACHAT : la pièce dont celle-ci DÉCOULE. C'est ce lien qui permet de
    // lire devis → BC → facture → règlement d'un seul écran, avec les validateurs et les délais.
    ...(chainCandidates.length > 0
      ? ([{
          type: "select", name: "chainFromId", label: "Fait suite à (devis, bon de commande…)",
          options: chainCandidates, placeholder: "— Pièce isolée —", defaultValue: v("chainFromId"), full: true,
          hint: "Un bon de commande suit son devis ; une facture suit son bon de commande. La fiche montrera la chaîne entière.",
        }] as FieldDef[])
      : []),
    // OÙ ON LE RANGE. Facultatif, et ça compte : un engagement se dépose vite, il se classe
    // ensuite. Le dossier RANGE, il n'autorise pas — la restriction reste sur le document.
    ...(folders.length > 0
      ? ([{
          type: "select", name: "folderId", label: "Dossier de classement", options: folders,
          placeholder: "— Non classé —", defaultValue: v("folderId"), full: true,
        }] as FieldDef[])
      : []),
    // LA PIÈCE, DÈS LA CRÉATION. Un engagement sans son document n'est qu'une ligne de tableau :
    // ou bien on téléverse le fichier, ou bien on désigne celui qui EXISTE DÉJÀ dans le Drive —
    // et dans ce cas il n'est pas recopié, il est référencé. Sur la fiche, ces deux gestes ont
    // leurs propres blocs (bibliothèque de pièces, lien Drive) : les redoubler ici ferait deux
    // chemins pour la même chose.
    // QUI POURRA L'OUVRIR. Un engagement de la société n'est pas une pièce d'équipe : le
    // déposant nomme ses lecteurs. Aucun nom coché = document visible de tout le module, ce
    // qui reste le cas normal d'une police d'assurance ou d'un bon de commande courant.
    ...(people.length > 0
      ? ([{
          type: "multiselect", name: "readerId", label: "Lecteurs autorisés", options: people, full: true,
          hint: "Personne d'autre ne verra ce document — ni dans la liste, ni par son lien. Vous y gardez accès, et le Super Admin arbitre. Aucun nom coché : visible de tout le module Legal.",
        }] as FieldDef[])
      : []),
    ...(mode === "create"
      ? ([
          {
            type: "file", name: "attachment", label: "Pièces jointes", multiple: true, full: true,
            hint: "Une ou plusieurs pièces — elles sont rattachées au document dès sa création.",
          },
          {
            type: "drivepicker", name: "driveNodeId", label: "…ou un dossier / fichier du Drive", full: true,
            hint: "Le fichier RESTE dans le Drive : il continuera de s'y versionner, et Legal en montrera toujours la version courante.",
          },
        ] as FieldDef[])
      // UNE PIÈCE DÉPOSÉE se corrige aussi par son FICHIER (Direction, 10/2026 — « modifiable de A à Z ») : la nouvelle
      // version s'ajoute aux pièces jointes de la fiche, où l'ancienne se retire. Une pièce ÉMISE n'a pas ce champ : son
      // fichier, c'est la fabrique qui le réécrit (révision).
      : pieceEmise
        ? []
        : ([{
            type: "file", name: "attachment", label: "Remplacer / ajouter le fichier de la pièce", multiple: true, full: true,
            hint: "Le nouveau fichier rejoint les pièces jointes de la fiche ; retirez l'ancien depuis « Pièces jointes ». Sur un bon de commande, un nouveau fichier n'est plus la pièce signée : la signature tombe et le circuit de validation repart.",
          }] as FieldDef[])),
  ];
  }
}

/** Les noms de champ que le fichier d'une pièce émise porte — lus du module pur, jamais recopiés (§118.5). */
const CHAMPS_DU_FICHIER = new Set<string>(Object.keys(LIBELLE_CHAMP_DU_FICHIER));

/** Une date pour un `<input type="date">`, dans le fuseau du serveur (celui qui la relira). */
export function dateInput(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
