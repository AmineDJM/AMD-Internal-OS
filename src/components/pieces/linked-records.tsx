import Link from "next/link";
import type { EntityType } from "@prisma/client";
import { Scale, ReceiptText, Mails, ExternalLink, Paperclip, FileText, ShoppingCart, ArrowDown } from "lucide-react";
import { userCan, type SessionUser } from "@/lib/rbac";
import { peutDaterLeReglement } from "@/lib/finances/settlement";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { lienFichierEmis, type FichiersEmis } from "@/lib/legal/fichiers-emis";
import type { NatureDeChaine } from "@/modules/ad-pro/partage";
import { chargerPiecesLiees, type LignePiece, type LigneCourrier, type Ton } from "@/lib/queries/chaine-des-pieces";
import { AttachToSourceButtons, CreerFicheDepuisPiece, type NaturePieceLiee } from "./attach-to-source";
import { AttacherLegalExistant } from "./attacher-legal-existant";
import { JoindrePdf } from "@/components/shared/joindre-pdf";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { RaisonPieceNonSupprimable, SupprimerPieceLegal } from "@/components/pieces/supprimer-piece-legal";
import { supprimerFichierDePieceDeLaDemande } from "@/modules/ad-pro/actions-pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI SE RATTACHE À CET OBJET — devis, bons de commande, factures, engagements, courriers,
 * ET LEURS PIÈCES.
 *
 * Un bon de commande naît d'une demande de sponsoring ; une facture naît d'un événement ou d'une
 * demande au secrétariat ; un courrier accompagne un marché. Ces liens existent dans la vraie vie
 * et se perdaient dans l'ERP : chaque pièce vivait dans son module, et six semaines plus tard
 * personne ne savait plus quelle facture correspondait à quelle demande.
 *
 * Ce bloc se pose sur N'IMPORTE QUELLE fiche : il lit `sourceType` / `sourceId` — que les trois
 * modèles portaient déjà — et affiche ce qui pointe vers l'objet courant. Les boutons créent une
 * pièce DÉJÀ rattachée : c'est le seul moment où l'on sait de quoi elle vient, et le seul moment
 * où le rattachement ne coûte rien.
 *
 * ── LA CHAÎNE, PUIS LES ENGAGEMENTS (§118.161) ──────────────────────────────────────────
 *
 * Décision de la Direction (30/09/2026) : « Devis (un ou plusieurs, avec version plateforme et
 * PDF associé) → Bon de commande (idem) → Facture (idem), et une autre partie (Engagement) qui
 * inclut les conventions d'orateurs, les contrats et tout autre chose. Enlève les BC des
 * engagements, même si tous les BC sont enregistrés dans Legal. »
 *
 * Le bloc regroupait jusqu'ici « Engagements » (tout Legal sauf les factures — les BC et les devis
 * y compris) et « Factures ». Il se lit désormais dans l'ordre d'un achat : chaque DEVIS, chaque
 * BON DE COMMANDE et le devis dont il découle, chaque FACTURE et le BC qu'elle exécute — la
 * chaîne que le registre porte déjà (`chainFromId`). Chaque ligne montre sa « version plateforme »
 * (la fiche au registre, et le Word / PDF qu'a produits la fabrique quand c'est elle qui l'a
 * émise) et SES PDF, avec « Joindre le PDF » quand la porte du serveur l'acceptera. Les
 * engagements et les courriers viennent ensuite, dans leur propre partie.
 *
 * ── CE QUI NE DISPARAÎT PAS ─────────────────────────────────────────────────────────────
 *
 * La pièce de la demande ELLE-MÊME (§118.109) garde son emplacement NOMMÉ (`piecesDeLaDemande`).
 * Et les fichiers qu'on y avait déposés comme « Devis », « Bon de commande », « Facture » ou
 * « Convention », avant que ces pièces aient une fiche : ils sont montrés dans la section de leur
 * nature, avec « Créer sa fiche », qui leur crée leur fiche au registre en y RANGEANT le fichier.
 * Rien n'est retiré de la vue, rien n'est téléversé deux fois.
 *
 * ── LA GARDE ────────────────────────────────────────────────────────────────────────────
 *
 * Tout ce que la personne peut OUVRIR, DÉPOSER, RENOMMER se lit pièce par pièce, par la porte même
 * du serveur, dans `chargerPiecesLiees` (`queries/chaine-des-pieces.ts`) — c'est là qu'elle se
 * prouve, sur la base, avec de vrais acteurs. Sans spectateur connu, rien n'est chargé.
 *
 * Composant SERVEUR : il interroge la base. La création, elle, passe par un client (le panneau).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que l'appelant sait des droits du spectateur sur les modules des pièces liées. */
export interface AccesPiecesLiees {
  /** Peut lire le module Legal (ou Finances) — indicatif ; la porte pièce par pièce fait foi. */
  legal?: boolean;
  /** Peut lire les documents d'un courrier (module Courriers). */
  courriers?: boolean;
  /**
   * La personne qui regarde : le bloc lit, pièce par pièce, ce que la porte Legal lui ouvrira
   * (lire, déposer, renommer, supprimer). Absente ⇒ aucun document de pièce n'est chargé.
   */
  spectateur?: SessionUser;
  /** Ce qu'elle peut CRÉER d'ici, nature par nature — la porte d'écriture de Legal, pas celle de la fiche. */
  creer?: { devis: boolean; bonDeCommande: boolean; facture: boolean; engagement: boolean; courrier: boolean };
}

/** L'emplacement NOMMÉ des pièces de la demande elle-même — jamais un dépôt générique. */
export interface PiecesDeLaDemande {
  /** Ce qu'on attend, appelé par son nom (« Demande(s) du médecin »). */
  titre: string;
  documents: DocItem[];
  /** Le téléverseur, rendu par l'appelant : c'est un composant CLIENT. */
  televerseur?: React.ReactNode;
  /** Pourquoi le dépôt n'est pas offert, quand il ne l'est pas. */
  motif?: string | null;
  canDelete?: boolean;
  canRename?: boolean;
  canEdit?: boolean;
  /** Le chemin à revalider après un renommage ou une suppression. */
  path: string;
  /**
   * Ce que sont les fichiers de nature « devis / BC / facture / convention » déposés sur la fiche,
   * quand ce n'est PAS « un fichier sans fiche » — au circuit 2 du matériel promotionnel, ce sont
   * les scans des devis retranscrits. Absent : la phrase par défaut, et « Créer sa fiche ».
   */
  noteLibres?: string;
}

/** La nature d'une pièce libre (catégorie de fichier) → le formulaire qui lui crée sa fiche. */
const FORMULAIRE_DE: Record<NatureDeChaine, Exclude<NaturePieceLiee, "mail">> = {
  QUOTE: "quote", PURCHASE_ORDER: "order", INVOICE: "invoice", AGREEMENT: "legal",
};

export async function LinkedRecords({
  entityType, entityId, reference, canCreate = false, acces, piecesDeLaDemande, candidatsLegal, suppression = false,
}: {
  entityType: EntityType;
  entityId: string;
  /** La référence lisible de l'objet (« SPO-2026-014 ») : elle préremplit les engagements créés. */
  reference?: string | null;
  canCreate?: boolean;
  /** Droits du spectateur sur les modules des pièces liées. Absent ⇒ aucun document n'est chargé. */
  acces?: AccesPiecesLiees;
  /** La pièce que la demande porte elle-même, dans son emplacement nommé. */
  piecesDeLaDemande?: PiecesDeLaDemande;
  /**
   * Les documents Legal LIBRES que la personne peut rattacher — préparés par l'appelant, qui
   * SEUL connaît son cloisonnement (`contextePiecesLiees`). Vide ⇒ pas de bouton : un bouton
   * qui ouvre un menu vide fait chercher ce qui n'y est pas.
   */
  candidatsLegal?: { value: string; label: string }[];
  /**
   * SUPPRIMER pièces et fichiers depuis la demande (§118.209) — les fiches Ad & Pro le demandent ; la fiche
   * d'une demande au secrétariat, qui monte aussi ce bloc, garde ses gestes d'avant.
   */
  suppression?: boolean;
}) {
  const p = await chargerPiecesLiees({
    suppression,
    entityType, entityId, canCreate,
    spectateur: acces?.spectateur ?? null,
    courriers: acces?.courriers === true,
    creer: acces?.creer ?? null,
    documentsDeLaFiche: piecesDeLaDemande?.documents,
  });

  // Rien à montrer, rien à créer ET aucune pièce propre : on n'affiche pas une carte vide sur
  // toutes les fiches de l'ERP.
  if (p.total === 0 && !canCreate && !piecesDeLaDemande) return null;

  const ref = reference ?? null;
  const boutonsChaine = (["quote", "order", "invoice"] as const).filter((k) => p.droitDeCreer[k]);
  const boutonsEngagement = (["legal", "mail"] as const).filter((k) => p.droitDeCreer[k]);
  // La date de paiement d'une facture créée d'ici : à qui règle aux Finances seulement (`peutDaterLeReglement`).
  const dater = acces?.spectateur ? peutDaterLeReglement({ financesModifier: userCan(acces.spectateur, "FINANCES", "UPDATE") }) : false;

  const fichiersLibres = (nature: NatureDeChaine) => p.libres[nature].length > 0 && piecesDeLaDemande ? (
    <FichiersLibres
      documents={p.libres[nature]} slot={piecesDeLaDemande}
      creer={p.droitDeCreer[FORMULAIRE_DE[nature]] && !piecesDeLaDemande.noteLibres
        ? (doc) => (
            <CreerFicheDepuisPiece
              entityType={entityType} entityId={entityId} reference={ref}
              kind={FORMULAIRE_DE[nature]} piece={{ id: doc.id, nom: doc.name }} devis={p.devisAmont} bons={p.bonsAmont}
              daterLeReglement={dater}
            />
          )
        : null}
    />
  ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Pièces liées{p.total > 0 && <span className="ml-1 text-sm font-normal text-muted-foreground">({p.total})</span>}</span>
          {/* RATTACHER CE QUI EXISTE DÉJÀ — un devis, un BC, une facture ou une convention déjà
              enregistrés dans Legal. Les boutons des sections CRÉENT — la bonne façon quand la
              pièce n'existe pas encore. Sans celui-ci, la seule issue pour une pièce déjà au
              registre était de la RECRÉER : deux lignes pour la même dépense, deux montants dans
              les totaux, et celle qui porte les pièces jointes n'est pas celle qui porte le lien. */}
          {canCreate && <AttacherLegalExistant entityType={entityType} entityId={entityId} candidats={candidatsLegal ?? []} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {/* LA PIÈCE DE LA DEMANDE, appelée par son nom — elle vient EN PREMIER parce que c'est
            elle qui justifie tout le reste, et parce qu'elle est obligatoire à la création. */}
        {piecesDeLaDemande && (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Paperclip className="mr-1 inline h-3.5 w-3.5" />{piecesDeLaDemande.titre}
            </p>
            {piecesDeLaDemande.televerseur ?? (piecesDeLaDemande.motif
              ? <p className="text-xs text-muted-foreground">{piecesDeLaDemande.motif}</p>
              : null)}
            <DocumentList
              documents={p.propres}
              canDelete={piecesDeLaDemande.canDelete}
              canRename={piecesDeLaDemande.canRename}
              canEdit={piecesDeLaDemande.canEdit}
              path={piecesDeLaDemande.path}
            />
          </div>
        )}

        {/* ── LA CHAÎNE : devis → bon de commande → facture ─────────────────────────────── */}
        <Partie
          titre="Devis → Bon de commande → Facture"
          boutons={boutonsChaine.length > 0
            ? <AttachToSourceButtons entityType={entityType} entityId={entityId} reference={ref} kinds={[...boutonsChaine]} devis={p.devisAmont} bons={p.bonsAmont} daterLeReglement={dater} />
            : null}
        >
          <Maillon icone={<FileText className="h-3.5 w-3.5" />} titre="Devis" affiches={p.sections.QUOTE.length} total={p.totaux.QUOTE}
            vide={p.libres.QUOTE.length === 0 ? "Aucun devis." : null}>
            {p.sections.QUOTE.map((l) => <LignePieceRow key={l.id} l={l} />)}
            {fichiersLibres("QUOTE")}
          </Maillon>
          <Fleche />
          <Maillon icone={<ShoppingCart className="h-3.5 w-3.5" />} titre="Bons de commande" affiches={p.sections.PURCHASE_ORDER.length} total={p.totaux.PURCHASE_ORDER}
            vide={p.libres.PURCHASE_ORDER.length === 0 ? "Aucun bon de commande." : null}>
            {p.sections.PURCHASE_ORDER.map((l) => <LignePieceRow key={l.id} l={l} />)}
            {fichiersLibres("PURCHASE_ORDER")}
          </Maillon>
          <Fleche />
          <Maillon icone={<ReceiptText className="h-3.5 w-3.5" />} titre="Factures" affiches={p.sections.INVOICE.length} total={p.totaux.INVOICE}
            vide={p.libres.INVOICE.length === 0 ? "Aucune facture." : null}>
            {p.sections.INVOICE.map((l) => <LignePieceRow key={l.id} l={l} />)}
            {fichiersLibres("INVOICE")}
          </Maillon>
        </Partie>

        {/* ── LES ENGAGEMENTS (et les courriers) — sans les BC, qui ont leur maillon ─────────── */}
        <Partie
          titre="Engagements"
          sousTitre="Conventions d'orateurs, contrats, avenants, et tout le reste — puis les courriers."
          boutons={boutonsEngagement.length > 0
            ? <AttachToSourceButtons entityType={entityType} entityId={entityId} reference={ref} kinds={[...boutonsEngagement]} />
            : null}
        >
          <Maillon icone={<Scale className="h-3.5 w-3.5" />} titre="Engagements" affiches={p.sections.ENGAGEMENT.length} total={p.totaux.ENGAGEMENT}
            vide={p.libres.AGREEMENT.length === 0 ? "Aucun engagement." : null}>
            {p.sections.ENGAGEMENT.map((l) => <LignePieceRow key={l.id} l={l} />)}
            {fichiersLibres("AGREEMENT")}
          </Maillon>
          {p.nbCourriers > 0 && (
            <Maillon icone={<Mails className="h-3.5 w-3.5" />} titre="Courriers" affiches={p.courriers.length} total={p.nbCourriers} vide={null}>
              {p.courriers.map((c) => <LigneCourrierRow key={c.id} c={c} />)}
            </Maillon>
          )}
        </Partie>
      </CardContent>
    </Card>
  );
}

function Partie({ titre, sousTitre, boutons, children }: { titre: string; sousTitre?: string; boutons: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{titre}</h3>
          {sousTitre && <p className="text-xs text-muted-foreground">{sousTitre}</p>}
        </div>
        {boutons}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Un maillon de la chaîne (ou la liste des engagements) — son compte, et ce qu'il ne montre pas. */
function Maillon({ icone, titre, affiches, total, vide, children }: {
  icone: React.ReactNode; titre: string; affiches: number; total: number; vide: string | null; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icone} {titre} <span className="font-normal normal-case">({total})</span>
      </p>
      {/* UNE COUPE SE DIT (§118.60) : une liste tronquée qui se tait se lit comme exhaustive. */}
      {total > affiches && (
        <p className="text-[0.6875rem] text-muted-foreground">Les {affiches} plus récents sur {total} — la liste complète est dans Legal.</p>
      )}
      {affiches === 0 && vide ? <p className="text-xs text-muted-foreground">{vide}</p> : null}
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

/** Le « → » entre deux maillons — un repère de lecture ; le LIEN, lui, est `chainFromId`. */
function Fleche() {
  return <ArrowDown className="mx-auto h-4 w-4 text-muted-foreground" aria-hidden />;
}

/**
 * LES FICHIERS DÉPOSÉS SUR LA DEMANDE AVANT QUE LA CHAÎNE EXISTE — dans la section de leur
 * nature, avec leurs droits d'origine, et « Créer sa fiche » quand la personne peut la créer.
 */
function FichiersLibres({ documents, slot, creer }: {
  documents: DocItem[];
  slot: PiecesDeLaDemande;
  creer: ((doc: DocItem) => React.ReactNode) | null;
}) {
  return (
    <li className="space-y-1 py-1.5">
      <p className="text-[0.6875rem] text-muted-foreground">
        {slot.noteLibres ?? (
          <>
            Déposé{documents.length > 1 ? "s" : ""} directement sur la demande, sans fiche au registre
            {creer ? " — « Créer sa fiche » l'y range, sans le téléverser une seconde fois." : "."}
          </>
        )}
      </p>
      {documents.map((doc) => (
        <div key={doc.id} className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <DocumentList documents={[doc]} canDelete={slot.canDelete} canRename={slot.canRename} canEdit={slot.canEdit} path={slot.path} />
          </div>
          {creer?.(doc)}
        </div>
      ))}
    </li>
  );
}

/**
 * UNE PIÈCE LIÉE, SA VERSION PLATEFORME ET SES DOCUMENTS EN DESSOUS.
 *
 * Les documents sont rendus À L'INTÉRIEUR de la ligne et non dans un bloc séparé : c'est ce qui
 * répond à « de quoi vient ce fichier ? » sans qu'on ait à faire le rapprochement de tête. Un
 * second bloc « tous les fichiers des pièces liées » reproduirait exactement le défaut qu'on
 * corrige — une liste à plat où la facture du traiteur et le bon de commande se ressemblent.
 *
 * Le compte est TOUJOURS affiché, zéro compris : « aucune pièce » sur une facture est une
 * information (le justificatif manque), et le taire ferait chercher ailleurs.
 */
export function LignePieceRow({ l }: { l: LignePiece }) {
  const plateforme: FichiersEmis | null = l.plateforme;
  const aPlateforme = Boolean(plateforme?.pdf || plateforme?.docx);
  // Sur une fiche Ad & Pro (§118.209), la suppression de pièce et de fichier suit LE verdict de la demande — la
  // même décision que les actions —, plus le droit « gérer » d'avant, qui ne regardait ni la demande ni ce qui engage.
  const s = l.suppression;
  return (
    <li className="py-1.5">
      <EnTete href={l.fiche ? `/legal/${l.id}` : null} titre={l.titre} reference={l.reference} meta={l.meta} badge={l.badge}
        action={s ? <SupprimerPieceLegal id={l.id} nom={l.reference ? `${l.reference} — ${l.titre}` : l.titre} offert={s.piece.offert} /> : null} />
      {s && !s.piece.offert && <RaisonPieceNonSupprimable raison={s.piece.raison} />}
      {aPlateforme && (
        <p className="mt-1 flex flex-wrap items-center gap-2 pl-3 text-[0.6875rem] text-muted-foreground">
          Version plateforme :
          {plateforme?.pdf && <a className="font-medium text-foreground hover:underline" href={lienFichierEmis(l.id, "pdf")} target="_blank" rel="noreferrer">PDF</a>}
          {plateforme?.docx && <a className="font-medium text-foreground hover:underline" href={lienFichierEmis(l.id, "docx")} target="_blank" rel="noreferrer">Word</a>}
        </p>
      )}
      {l.documents && (
        l.documents.length > 0 ? (
          <div className="mt-1.5 border-l-2 border-border pl-3">
            <DocumentList
              documents={l.documents} canDelete={s ? s.fichiers.offert : l.gerable} canRename={l.gerable} canEdit={l.editable}
              path={`/legal/${l.id}`} supprimer={s ? supprimerFichierDePieceDeLaDemande : undefined}
            />
          </div>
        ) : (
          <p className="mt-1 pl-3 text-[0.6875rem] text-muted-foreground">
            {aPlateforme ? "Aucun PDF joint (signé, tamponné…) en plus de la version plateforme." : "Aucun PDF joint à cette pièce."}
          </p>
        )
      )}
      {l.joindre && <div className="pl-3"><JoindrePdf entityId={l.id} categorie={l.joindre} /></div>}
    </li>
  );
}

function LigneCourrierRow({ c }: { c: LigneCourrier }) {
  return (
    <li className="py-1.5">
      {/* Sans le module Courriers, la fiche du courrier est refusée : le titre se lit sans lien. */}
      <EnTete href={c.documents !== null ? `/courriers/${c.id}` : null} titre={c.titre} reference={c.reference} meta={c.meta} badge={c.badge} />
      {c.documents && (
        c.documents.length > 0 ? (
          <div className="mt-1.5 border-l-2 border-border pl-3">
            <DocumentList documents={c.documents} canDelete={false} canRename={false} canEdit={false} path={`/courriers/${c.id}`} />
          </div>
        ) : (
          <p className="mt-1 pl-3 text-[0.6875rem] text-muted-foreground">Aucune pièce jointe à ce courrier.</p>
        )
      )}
    </li>
  );
}

function EnTete({ href, titre, reference, meta, badge, action }: {
  /** `null` : la fiche ne s'ouvre pas à la personne — le titre se lit, il ne mène nulle part. */
  href: string | null; titre: string; reference: string | null; meta: string; badge: { label: string; tone: Ton } | null;
  /** Un geste posé à côté du badge (supprimer la pièce) — rendu par l'appelant, qui sait ce qui est offert. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0">
        {href ? (
          <Link href={href} className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline">
            <span className="truncate">{titre}</span> <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Link>
        ) : (
          <span className="block truncate font-medium">{titre}</span>
        )}
        <span className="block truncate text-[0.6875rem] text-muted-foreground">
          {[reference, meta].filter(Boolean).join(" · ") || "—"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {badge && <Badge tone={badge.tone} dot={false}>{badge.label}</Badge>}
        {action}
      </span>
    </div>
  );
}
