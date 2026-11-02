"use client";

import * as React from "react";
import type { EntityType } from "@prisma/client";
import { Scale, ReceiptText, Mails, FileText, ShoppingCart, FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { MAIL_DIRECTION, natureLegale } from "@/lib/labels";
import { naturesDEngagement } from "@/modules/ad-pro/partage";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import { createInvoice } from "@/lib/actions/invoice-actions";
import { createMailEntry } from "@/lib/actions/mail-register-actions";

/**
 * CRÉER UNE PIÈCE DÉJÀ RATTACHÉE À CETTE FICHE.
 *
 * Le rattachement ne se fait bien qu'à UN seul moment : celui où l'on crée la pièce depuis
 * l'objet qui la justifie. Demander plus tard « à quelle demande cette facture se rapporte-t-elle ? »
 * suppose de rechercher parmi des centaines d'objets — personne ne le fait, et le lien n'existe
 * jamais. Ici, le contexte est déjà là : `sourceType` / `sourceId` partent avec le formulaire, en
 * champs cachés, et le serveur les enregistre tels quels.
 *
 * ── CINQ NATURES, ET LA CHAÎNE (§118.161) ────────────────────────────────────────────────
 *
 * Décision de la Direction : les pièces liées se lisent Devis → Bon de commande → Facture, puis
 * les Engagements (conventions d'orateurs, contrats, tout le reste) et les courriers. Le bouton
 * « Engagement » créait jusqu'ici un bon de commande PAR DÉFAUT : un BC rangé parmi les
 * engagements, exactement ce que la Direction a demandé de retirer. Chaque maillon a donc SON
 * bouton, et sa nature part en champ caché — on ne choisit plus « Devis » dans un menu qui propose
 * aussi « Bail ». Le bouton « Engagement » ne propose plus que les natures d'engagement.
 *
 * Le « → » est un LIEN, pas une flèche dessinée : le bon de commande dit de quel devis il DÉCOULE,
 * la facture de quel bon (`chainFromId`, la chaîne du dossier d'achat que le registre porte déjà).
 * C'est ce lien qui fait attendre la validation du BC avant de payer sa facture (§118.148).
 */

export type NaturePieceLiee = "quote" | "order" | "invoice" | "legal" | "mail";

/** Un maillon amont proposable : un devis pour un BC, un BC pour une facture. */
export interface MaillonAmont { value: string; label: string }

/** Un fichier déjà déposé sur la demande, qu'une fiche va ranger (« Créer sa fiche »). */
export interface PieceExistante { id: string; nom: string }

const TITRES: Record<NaturePieceLiee, { title: string; description: string; label: string; creer: string }> = {
  quote: {
    title: "Nouveau devis rattaché",
    description: "Le devis reçu du fournisseur : sa fiche au registre, et son PDF. Il restera lié à cette demande.",
    label: "Devis", creer: "Créer le devis",
  },
  order: {
    title: "Nouveau bon de commande rattaché",
    description: "Le BC et son PDF. Il passe par son centre de validation au-dessus du seuil, puis à la signature des Finances.",
    label: "Bon de commande", creer: "Créer le bon de commande",
  },
  invoice: {
    title: "Nouvelle facture rattachée",
    description: "La facture et son PDF. Elle restera liée à cette demande — on saura toujours de quoi elle vient.",
    label: "Facture", creer: "Créer la facture",
  },
  legal: {
    title: "Nouvel engagement rattaché",
    description: "Convention d'orateur, contrat, avenant, accord… Il restera lié à cette fiche.",
    label: "Engagement", creer: "Créer l'engagement",
  },
  mail: {
    title: "Nouveau courrier rattaché",
    description: "Le pli parti ou reçu pour cette affaire, inscrit au registre et lié à cette fiche.",
    label: "Courrier", creer: "Créer le courrier",
  },
};

/**
 * Les natures d'ENGAGEMENT : tout Legal, moins la chaîne devis → BC → facture, qui a ses boutons.
 * Lues sur la MÊME règle que celle qui range les pièces dans leur section (`sectionDeLaNature`) :
 * une nature proposée ici se retrouve toujours sous « Engagements », là où on l'a créée.
 */
const NATURES_ENGAGEMENT = naturesDEngagement().map((value) => ({ value, label: natureLegale(value) }));

interface ContexteFormulaire {
  entityType: EntityType;
  entityId: string;
  reference: string | null;
  devis: MaillonAmont[];
  bons: MaillonAmont[];
  pieceExistante?: PieceExistante | null;
  /**
   * LA DATE DE PAIEMENT D'UNE FACTURE ne s'offre qu'à qui règle aux Finances (`peutDaterLeReglement`, calculé par
   * l'appelant serveur — audit Assistante de direction, 10/2026). Absent : le champ n'est pas proposé.
   */
  daterLeReglement?: boolean;
}

/** Le nom d'un fichier sans son extension — le titre qu'on aurait tapé. */
const sansExtension = (nom: string) => nom.replace(/\.[A-Za-z0-9]{1,5}$/, "");

/**
 * LES CHAMPS D'UNE NATURE — une seule écriture pour les boutons de section et pour « Créer sa
 * fiche » : deux formulaires de la même pièce finiraient par ne plus demander la même chose.
 */
function champs(kind: NaturePieceLiee, ctx: ContexteFormulaire): FieldDef[] {
  // Le rattachement voyage en champs cachés : ce n'est pas un secret (le serveur revérifie ce
  // qu'il en fait), c'est un contexte que l'utilisateur n'a pas à ressaisir.
  const link: FieldDef[] = [
    { type: "hidden", name: "sourceType", value: ctx.entityType },
    { type: "hidden", name: "sourceId", value: ctx.entityId },
  ];
  // La référence de l'objet d'origine préremplit celle d'un ENGAGEMENT ou d'un courrier : c'est
  // ce qu'on écrirait à la main. Pas celle d'un devis, d'un BC ou d'une facture : leur numéro est
  // celui qu'imprime la pièce, et y mettre celui de la demande ferait rapprocher deux choses qui
  // ne se correspondent pas.
  const ref = (ctx.reference ?? "").trim() || undefined;
  const existante = ctx.pieceExistante ?? null;

  // LE FICHIER DÉJÀ DÉPOSÉ, s'il y en a un, est RANGÉ dans la fiche — pas téléversé une seconde
  // fois (§118.161). Le serveur vérifie qu'il appartient bien à CETTE demande.
  const adoption: FieldDef[] = existante ? [{ type: "hidden", name: "pieceExistanteId", value: existante.id }] : [];

  // ── LE SCAN PART AVEC LA PIÈCE, ET C'EST TOUT L'INTÉRÊT ────────────────────────────────────
  //
  // On créait ici une facture ou un engagement SANS pouvoir y joindre quoi que ce soit : il
  // fallait enregistrer, retrouver la fiche dans son module, puis y téléverser le PDF. Trois
  // écrans pour une pièce qu'on a sous la main au moment où l'on saisit — donc, en pratique, un
  // PDF qui reste dans la boîte mail et une ligne d'ERP sans justificatif.
  //
  // Le champ s'appelle `attachment` : c'est le nom que `attachFormFiles` lit côté serveur, le
  // même pour les natures. Un second nom aurait été un second chemin à maintenir.
  const piece = (label: string, exigee = false): FieldDef[] => [{
    // EXIGÉE pour un devis (§118.175) — sauf si le fichier est déjà déposé sur la demande : il sera
    // rangé dans la fiche, et le redemander ferait téléverser une seconde copie.
    type: "file", name: "attachment", label, multiple: true, full: true, required: exigee && !existante,
    hint: existante
      ? `« ${existante.nom} » est déjà déposé sur la demande : il sera rangé dans cette fiche. Ajoutez ici d'autres fichiers seulement s'il en manque.`
      : "Joint dès la création : c'est le seul moment où on l'a sous la main.",
  }];

  // LA PARTIE SE CHOISIT DANS L'ANNUAIRE (§118.148). Ce formulaire l'écrivait en texte libre
  // (`counterparty`), que `createLegalDocument` ne lit plus depuis que la partie vient de
  // l'annuaire : TOUT engagement créé d'ici était refusé — « choisissez au moins une partie » —
  // alors que la personne venait de la taper. Et c'est ce bouton-là que le refus du chantier
  // « bon de commande » nomme comme remède : un remède qui échoue est une impasse (§118.63).
  const partie = (label: string, requise = true): FieldDef => ({
    type: "parties", name: "counterpartyIds", label, required: requise, full: true, arity: "many",
    placeholder: "Chercher la partie dans l’annuaire — un métier, un nom, un numéro…",
    hint: "Choisissez-la dans l’annuaire de l’entreprise. Absente ? « Créer un contact » l’y ajoute sans quitter cette saisie.",
  });

  const titre = existante ? sansExtension(existante.nom) : undefined;
  const amont = (options: MaillonAmont[], label: string, hint: string): FieldDef[] => options.length
    ? [{ type: "select", name: "chainFromId", label, options: [{ value: "", label: "— aucun —" }, ...options], defaultValue: options.length === 1 ? options[0]!.value : "", hint, full: true }]
    : [];

  switch (kind) {
    case "quote":
      return [
        ...link, ...adoption,
        { type: "hidden", name: "kind", value: "QUOTE" },
        { type: "text", name: "title", label: "Titre exact du devis", required: true, full: true, defaultValue: titre },
        { type: "text", name: "reference", label: "N° du devis (celui du fournisseur)" },
        // « À part le titre du devis et la PJ, rien n'est obligatoire » (Direction, 01/10).
        partie("Fournisseur (facultatif)", false),
        { type: "date", name: "startDate", label: "Date du devis" },
        { type: "date", name: "endDate", label: "Valable jusqu'au (facultatif)" },
        { type: "number", name: "amount", label: "Montant (DZD)" },
        { type: "textarea", name: "notes", label: "Notes", full: true },
        ...piece("PDF du devis", true),
      ];
    case "order":
      return [
        ...link, ...adoption,
        { type: "hidden", name: "kind", value: "PURCHASE_ORDER" },
        ...amont(ctx.devis, "Découle du devis", "Le devis dont ce bon de commande reprend les lignes — c'est le « → » de la chaîne."),
        { type: "text", name: "title", label: "Titre exact du bon de commande", required: true, full: true, defaultValue: titre },
        { type: "text", name: "reference", label: "N° du bon de commande" },
        partie("Fournisseur"),
        { type: "date", name: "startDate", label: "Date du bon de commande" },
        { type: "number", name: "amount", label: "Montant (DZD)" },
        { type: "textarea", name: "notes", label: "Notes", full: true },
        ...piece("PDF du bon de commande"),
      ];
    case "invoice":
      return [
        ...link, ...adoption,
        ...amont(ctx.bons, "Découle du bon de commande", "Le BC que cette facture exécute : son règlement attendra que le BC ait été validé."),
        { type: "text", name: "title", label: "Objet de la facture", required: true, full: true, defaultValue: titre },
        { type: "text", name: "number", label: "N° de facture" },
        { type: "number", name: "amount", label: "Montant (DZD)" },
        { type: "date", name: "issueDate", label: "Date d'émission" },
        { type: "date", name: "dueDate", label: "Échéance de règlement" },
        ...(ctx.daterLeReglement ? [{ type: "date", name: "paidDate", label: "Date de paiement (si déjà réglée)" } as FieldDef] : []),
        // UN SEUL NOM, ET LE SENS. « Destinataire » et « payeur » demandaient deux fois la même
        // chose : l'un des deux est TOUJOURS nous. On saisit donc la partie EN FACE, et le sens
        // dit de quel côté elle se tient.
        {
          type: "select", name: "direction", label: "Sens", defaultValue: "OUT",
          options: [
            { value: "OUT", label: "Reçue — nous payons" },
            { value: "IN", label: "Émise — nous encaissons" },
          ],
        },
        { type: "text", name: "counterparty", label: "Partie (fournisseur, client)", full: true },
        { type: "textarea", name: "notes", label: "Notes", full: true },
        ...piece("PDF de la facture"),
      ];
    case "legal":
      return [
        ...link, ...adoption,
        { type: "text", name: "title", label: "Titre exact du document", required: true, full: true, defaultValue: titre },
        { type: "text", name: "reference", label: "Référence / n°", defaultValue: ref },
        {
          type: "select", name: "kind", label: "Nature", options: NATURES_ENGAGEMENT,
          // Une convention d'orateur est l'engagement le plus courant d'une fiche Ad & Pro.
          defaultValue: "AGREEMENT",
          hint: "Devis, bons de commande et factures ont leurs propres boutons, dans la chaîne au-dessus.",
        },
        partie("Partie (orateur, prestataire, établissement…)"),
        { type: "date", name: "startDate", label: "Date de début (facultative)" },
        { type: "date", name: "endDate", label: "Date de fin — vide = sans échéance" },
        { type: "number", name: "amount", label: "Montant (DZD)" },
        { type: "textarea", name: "notes", label: "Notes", full: true },
        ...piece("Pièces jointes (document signé…)"),
      ];
    case "mail":
      return [
        ...link,
        { type: "text", name: "title", label: "Objet du courrier", required: true, full: true },
        {
          type: "select", name: "direction", label: "Sens",
          options: Object.entries(MAIL_DIRECTION).map(([value, d]) => ({ value, label: d.label })),
          defaultValue: "OUTGOING",
        },
        { type: "text", name: "reference", label: "N° de chrono", defaultValue: ref },
        // EXPÉDITEUR ET DESTINATAIRE DEPUIS L'ANNUAIRE — `createMailEntry` ne lit plus `sender` ni
        // `recipient` en texte : ces deux champs étaient saisis puis JETÉS en silence, et le pli
        // entrait au registre sans correspondant. Un seul chacun, comme sur l'écran des courriers.
        { type: "parties", name: "senderContactId", label: "Expéditeur", arity: 1, placeholder: "Chercher l’expéditeur dans l’annuaire…" },
        { type: "parties", name: "recipientContactId", label: "Destinataire", arity: 1, placeholder: "Chercher le destinataire dans l’annuaire…" },
        { type: "datetime-local", name: "sentAt", label: "Départ (date et heure)" },
        { type: "date", name: "receivedAt", label: "Arrivée" },
        { type: "text", name: "carrier", label: "Porteur (poste, coursier, e-mail…)" },
        { type: "textarea", name: "notes", label: "Notes", full: true },
        ...piece("Pièces jointes"),
      ];
  }
}

const ACTIONS: Record<NaturePieceLiee, typeof createLegalDocument> = {
  quote: createLegalDocument, order: createLegalDocument, legal: createLegalDocument,
  invoice: createInvoice, mail: createMailEntry,
};

const ICONES: Record<NaturePieceLiee, React.ReactNode> = {
  quote: <FileText className="h-3.5 w-3.5" />,
  order: <ShoppingCart className="h-3.5 w-3.5" />,
  invoice: <ReceiptText className="h-3.5 w-3.5" />,
  legal: <Scale className="h-3.5 w-3.5" />,
  mail: <Mails className="h-3.5 w-3.5" />,
};

function FeuilleDeCreation({ kind, ctx, onClose }: { kind: NaturePieceLiee; ctx: ContexteFormulaire; onClose: () => void }) {
  const t = TITRES[kind];
  const description = ctx.pieceExistante
    ? `Le fichier « ${ctx.pieceExistante.nom} », déjà déposé sur la demande, sera rangé dans cette fiche — sans nouveau téléversement.`
    : t.description;
  return (
    <Sheet open onClose={onClose} width="lg" title={t.title} description={description}>
      <RecordForm
        fields={champs(kind, ctx)}
        action={ACTIONS[kind]}
        onDone={onClose}
        onCancel={onClose}
        submitLabel={t.creer}
      />
    </Sheet>
  );
}

export function AttachToSourceButtons({ entityType, entityId, reference, kinds, devis, bons, daterLeReglement = false }: {
  entityType: EntityType;
  entityId: string;
  reference: string | null;
  /** Proposer la date de paiement d'une facture (`peutDaterLeReglement`) — faux par défaut. */
  daterLeReglement?: boolean;
  /** Natures proposées — par défaut engagement, facture, courrier. Un bon de commande PCH, lui, n'appelle qu'une facture. */
  kinds?: NaturePieceLiee[];
  /** Les devis de la fiche — un BC dit duquel il découle. */
  devis?: MaillonAmont[];
  /** Les bons de commande de la fiche — une facture dit duquel elle découle. */
  bons?: MaillonAmont[];
}) {
  const [open, setOpen] = React.useState<NaturePieceLiee | null>(null);
  const offered: NaturePieceLiee[] = kinds ?? ["legal", "invoice", "mail"];
  const ctx: ContexteFormulaire = { entityType, entityId, reference, devis: devis ?? [], bons: bons ?? [], daterLeReglement };

  return (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        {offered.map((k) => (
          <Button key={k} size="sm" variant="outline" onClick={() => setOpen(k)}>
            {ICONES[k]} {TITRES[k].label}
          </Button>
        ))}
      </span>
      {open && <FeuilleDeCreation kind={open} ctx={ctx} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * « CRÉER SA FICHE » — pour un fichier déposé sur la demande AVANT que les devis, bons de commande
 * et factures aient leur place (§118.161). Il ouvre le formulaire de sa nature, prérempli de son
 * nom, et le fichier est RANGÉ dans la fiche créée : rien n'est téléversé une seconde fois, et
 * rien ne disparaît.
 */
export function CreerFicheDepuisPiece({ entityType, entityId, reference, kind, piece, devis, bons, daterLeReglement = false }: {
  entityType: EntityType;
  entityId: string;
  reference: string | null;
  /** Proposer la date de paiement d'une facture (`peutDaterLeReglement`) — faux par défaut. */
  daterLeReglement?: boolean;
  kind: Exclude<NaturePieceLiee, "mail">;
  piece: PieceExistante;
  devis?: MaillonAmont[];
  bons?: MaillonAmont[];
}) {
  const [open, setOpen] = React.useState(false);
  const ctx: ContexteFormulaire = { entityType, entityId, reference, devis: devis ?? [], bons: bons ?? [], pieceExistante: piece, daterLeReglement };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title={`Créer la fiche de « ${piece.nom} » et y ranger le fichier`}>
        <FolderInput className="h-3.5 w-3.5" /> Créer sa fiche
      </Button>
      {open && <FeuilleDeCreation kind={kind} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}
