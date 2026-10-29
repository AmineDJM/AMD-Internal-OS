import { notFound, redirect } from "next/navigation";
import { CHEMIN_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { requireUser } from "@/lib/session";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { NouveauDocumentLegal } from "./nouveau-document-legal";
import { toNumber } from "@/lib/utils";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import { effectiveStatus, expiryLevel, daysLeft } from "@/lib/legal/lifecycle";
import { legalFields } from "./legal-fields";
import { peutDaterLeReglement } from "@/modules/finances/partage";
import { LegalTable, type LegalRow } from "./legal-table";
import { LegalFolderBar, type FolderRow } from "./folder-bar";
import { buildFolderTree, flattenFolders, indentedLabel } from "@/lib/legal/folders";
import { legalListScope } from "@/lib/legal/list-view";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { natureFromParam, invoiceTally, PURCHASE_CHAIN_KINDS } from "@/lib/legal/invoices";
import { totauxAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { ComposerPieceButton, type TypePieceComposable } from "@/components/pieces/composer-piece";
import { compositionDesPieces } from "@/lib/queries/composition-pieces";
import { piecesAmontProposees } from "@/lib/queries/legal-chain";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, LEGAL_DOC_KIND } from "@/lib/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Legal — AMD Internal OS" };

/**
 * LEGAL — LES ENGAGEMENTS DE LA SOCIÉTÉ.
 *
 * Contrats, bons de commande, conventions, assurances, baux : tout ce qui engage l'entreprise et
 * qu'il faut pouvoir ressortir. Le FICHIER, lui, reste dans le Drive — Legal le référence et
 * ajoute ce que le Drive ne sait pas dire : le titre exact, les dates, l'échéance, la partie en
 * face, et ce qu'il est devenu (renouvelé, annulé).
 *
 * Un document peut n'avoir AUCUNE date : c'est un cas normal (statuts, tacite reconduction), pas
 * un oubli. Il ne se périme jamais et ne déclenche donc aucun rappel — la règle vit dans le
 * module pur `legal/lifecycle`, testé, partagé par l'écran et par le balayage des échéances.
 *
 * ── LES FACTURES SONT ICI, ET NULLE PART AILLEURS ───────────────────────────────────────────
 *
 * Elles avaient leur écran ; elles sont désormais des documents de nature « facture », dans le
 * registre où vivent déjà les devis et les bons de commande dont elles découlent. « Les
 * factures » (`?nature=INVOICE`) est une VUE de cette liste, pas un autre endroit.
 *
 * Deux portes s'ouvrent donc dessus, et la seconde est étroite : Legal voit tout le registre, la
 * COMPTABILITÉ ne voit que les factures. Centraliser ne devait rien retirer à celle qui venait y
 * lire ce qui reste à payer — et ne devait pas non plus lui ouvrir les baux et les contrats de
 * cadre. La restriction est posée DANS LA REQUÊTE : un filtre d'écran se retire dans le navigateur.
 */
export default async function LegalPage(
  props: { searchParams?: Promise<{ echeances?: string; dossier?: string; nature?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  // LA PORTÉE ET SA CLAUSE, calculées UNE fois (`perimetreLegal`) et lues aussi par la recherche
  // globale : la palette ne doit trouver que ce que cette liste montre (§118.177).
  const { portee, where: visible } = await perimetreLegal(user);
  if (portee === "NONE") notFound();
  // LA PORTE DU MODULE « BONS DE COMMANDE » (§118.176) n'ouvre que les bons de commande, et ils ont
  // leur écran : le registre entier n'est pas le sien. On l'y conduit plutôt que de lui montrer une
  // liste d'engagements réduite à ce que sa propre file montre déjà mieux.
  if (portee === "BONS_DE_COMMANDE") redirect(CHEMIN_BONS_DE_COMMANDE);
  // Inatteignable : ces deux portées sont les seules sans clause. Le dire au typage plutôt que
  // d'affirmer une valeur non nulle qu'aucun code ne vérifierait.
  if (!visible) notFound();
  // LA CHAÎNE D'ACHAT SEULE : la comptabilité voit les factures et les bons de commande qu'elle
  // émet — pas les baux ni les contrats. La nature se choisit parmi ces deux-là, facture d'abord.
  const facturesSeules = portee === "PURCHASE_CHAIN";

  const nature = facturesSeules
    ? (natureFromParam(searchParams?.nature, PURCHASE_CHAIN_KINDS) || "INVOICE")
    : natureFromParam(searchParams?.nature, Object.keys(LEGAL_DOC_KIND));

  const canCreate = userCan(user, nature === "INVOICE" || facturesSeules ? "FINANCES" : "LEGAL", "CREATE") || userCan(user, "LEGAL", "CREATE");
  const canEdit = userCan(user, "LEGAL", "UPDATE") || (facturesSeules && userCan(user, "FINANCES", "UPDATE"));

  // LE BOUTON « COMPOSER » : les natures que cette personne a le droit d'ÉMETTRE — la même règle
  // que la fabrique et qu'Adam (`legalWriteAllowed`), rejouée par le serveur au moment d'émettre.
  // Calculée UNE fois pour Legal et pour le module « Bons de commande » (`compositionDesPieces`).
  const composition = await compositionDesPieces(user);
  const typesComposables: TypePieceComposable[] = composition?.types ?? [];
  const typeCompose: TypePieceComposable = nature === "PURCHASE_ORDER" ? "BON_DE_COMMANDE" : nature === "QUOTE" ? "DEVIS" : "FACTURE";
  const typeInitialCompose = typesComposables.includes(typeCompose) ? typeCompose : typesComposables[0];

  // LES LECTEURS DÉSIGNÉS, en plus du cloisonnement d'entité. Un document restreint n'apparaît
  // pas dans la liste de ceux qui n'y sont pas nommés — pas même en grisé : une ligne qu'on voit
  // sans pouvoir l'ouvrir révèle déjà le titre, la partie en face et le montant.
  const readerScope = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  // LE DOSSIER OUVERT. `dossier=none` = les engagements non classés — ils ont leur porte, sinon
  // un document déposé vite et jamais rangé devient invisible dès qu'on prend l'habitude
  // d'ouvrir un dossier.
  const openFolderId = searchParams?.dossier && searchParams.dossier !== "none" ? searchParams.dossier : null;
  const unfiledOnly = searchParams?.dossier === "none";
  const folderWhere = unfiledOnly ? { folderId: null } : openFolderId ? { folderId: openFolderId } : {};
  // LA PORTÉE, DANS LA REQUÊTE. `facturesSeules` n'est pas une préférence d'affichage : c'est le
  // droit de la personne, et il se tient côté serveur — dans `visible`, avec les lecteurs et
  // l'entité. Le dossier ouvert, lui, est un filtre d'affichage, composé EN `AND` par-dessus.
  const docs = await prisma.legalDocument.findMany({
    where: { AND: [visible, folderWhere] },
    orderBy: [{ endDate: "asc" }, { createdAt: "desc" }],
    include: {
      driveNode: { select: { id: true, name: true } },
      renewedFrom: { select: { title: true } },
      readers: { select: { userId: true } },
    },
  });

  // L'ANNUAIRE DE L'ENTREPRISE — d'où les PARTIES se choisissent. Il n'est chargé que pour qui
  // peut déposer une pièce : la liste ne sert qu'au formulaire.
  const partyOptions = canCreate ? await listPartyOptions(user.id) : [];
  const canCreateContact = userCan(user, "GENERAL_MEANS", "CREATE");

  // Les personnes désignables comme lecteurs : les comptes actifs, sauf soi-même — on a déjà
  // accès à ce qu'on dépose, et se proposer dans sa propre liste ne veut rien dire.
  const people = canCreate
    ? (await prisma.user.findMany({
        where: { isActive: true, id: { not: user.id } },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      })).map((u) => ({ value: u.id, label: `${u.name} — ${ROLE_LABELS[u.role] ?? u.role}` }))
    : [];

  const today = new Date();
  // LES AVOIRS ACTIFS de chaque facture (§118.195), en une requête et SANS le filtre de dossier : un avoir peut être
  // rangé ailleurs que sa facture, et ce qu'elle doit encore n'en dépend pas. Le compte « à régler », son total et
  // le filtre de la liste lisent le NET — le même que le règlement encaisse.
  const avoirsParFacture = await totauxAvoirsActifs(docs.filter((d) => d.kind === "INVOICE").map((d) => d.id));
  const rows: LegalRow[] = docs.map((d) => ({
    id: d.id,
    reference: d.reference,
    title: d.title,
    kind: d.kind,
    counterparty: d.counterparty,
    startDate: d.startDate?.toISOString() ?? null,
    endDate: d.endDate?.toISOString() ?? null,
    // Le statut AFFICHÉ tient compte du calendrier : un terme passé se voit sans qu'on ait
    // rouvert la fiche. On ne le réécrit pas en base à la lecture — ce serait une écriture furtive.
    status: effectiveStatus(d, today),
    expiry: expiryLevel(d, today),
    daysLeft: daysLeft(d, today),
    amount: d.amount !== null ? toNumber(d.amount) : null,
    driveNodeId: d.driveNode?.id ?? null,
    driveName: d.driveNode?.name ?? null,
    renewedFromTitle: d.renewedFrom?.title ?? null,
    restricted: d.readers.length > 0,
    // LE RÈGLEMENT d'une facture — vide sur toute autre nature.
    paidDate: d.paidDate?.toISOString() ?? null,
    expenseOrderId: d.expenseOrderId,
    avoirs: avoirsParFacture.get(d.id) ?? 0,
  }));

  // L'ARMOIRE. Le compte de documents par dossier respecte le MÊME cloisonnement que la liste :
  // afficher « Baux (12) » à quelqu'un qui n'a le droit d'en ouvrir aucun révélerait déjà qu'il
  // en existe douze.
  const [folderRows, myCompanies] = await Promise.all([
    prisma.legalFolder.findMany({ select: { id: true, name: true, parentId: true, companyId: true, company: { select: { name: true, shortName: true } } } }),
    getMyCompanies(user.id),
  ]);
  const counts = await prisma.legalDocument.groupBy({
    by: ["folderId"],
    where: { AND: [visible, { folderId: { not: null } }] },
    _count: { _all: true },
  });
  const countByFolder = new Map(counts.map((c) => [c.folderId as string, c._count._all]));
  const folders: FolderRow[] = folderRows.map((f) => ({
    id: f.id, name: f.name, parentId: f.parentId, companyId: f.companyId,
    companyLabel: f.company ? (f.company.shortName || f.company.name) : null,
    documentCount: countByFolder.get(f.id) ?? 0,
  }));

  // Le menu de classement montre l'ARBRE, indenté : « 2026 » seul ne dit pas de quoi.
  const folderOptions = flattenFolders(buildFolderTree(folders)).map((n) => ({ value: n.id, label: indentedLabel(n) }));

  // Les pièces AMONT possibles pour la chaîne d'achat (un BC suit son devis, une facture son BC).
  // Requête à part, SANS le filtre de dossier ouvert : le devis peut être rangé ailleurs que là où
  // l'on crée la facture. Même cloisonnement (entité + lecteurs) que la liste.
  const chainCandidates = canCreate ? await piecesAmontProposees({ userId: user.id, readerScope }) : [];

  const watch = rows.filter((r) => r.expiry === "SOON" || r.expiry === "IMMINENT").length;
  const overdue = rows.filter((r) => r.expiry === "OVERDUE").length;
  // CE QUI RESTE À PAYER — le seul chiffre que l'écran dédié apportait vraiment, calculé sur les
  // lignes servies. Il ne s'affiche que là où il veut dire quelque chose.
  const factures = invoiceTally(rows);

  return (
    <div className="space-y-5">
      <PageHeader
        title={facturesSeules ? "Factures et bons de commande" : "Legal"}
        description={facturesSeules
          ? "Les factures et les bons de commande de la société, dans le registre des engagements : une facture y suit le bon de commande dont elle découle. « Composer » produit la pièce au format de la société, sur son papier en-tête, en Word et en PDF ; renseigner la date de règlement d'une facture suffit à la déclarer réglée."
          : "Les engagements de la société : contrats, devis, bons de commande, factures, conventions, assurances, baux. Le fichier reste dans le Drive — Legal porte les dates, l'échéance et ce qu'il advient du document."}
      >
        {/* LE BOUTON DES BONS DE COMMANDE (§118.149) — « le bouton pour les BC c'est dans Legal ».
            Le compositeur général s'ouvre sur la nature de la vue (une facture, d'ordinaire) ; le
            BC a donc son PROPRE bouton, sur son propre papier en-tête, pour qu'on n'ait pas à le
            chercher dans une liste de natures. Il disparaît quand la vue est déjà celle des BC :
            deux boutons pour le même geste. */}
        {composition && typesComposables.includes("BON_DE_COMMANDE") && typeInitialCompose !== "BON_DE_COMMANDE" && (
          <ComposerPieceButton
            typeInitial="BON_DE_COMMANDE"
            typesAutorises={["BON_DE_COMMANDE"]}
            societes={composition.societes}
            societeParDefaut={composition.societeParDefaut}
            letterheads={composition.letterheads}
            peutReglerNumerotation={composition.peutReglerNumerotation}
            amont={composition.amont}
          />
        )}
        {composition && typeInitialCompose && (
          <ComposerPieceButton
            typeInitial={typeInitialCompose}
            typesAutorises={typesComposables}
            societes={composition.societes}
            societeParDefaut={composition.societeParDefaut}
            letterheads={composition.letterheads}
            peutReglerNumerotation={composition.peutReglerNumerotation}
            amont={composition.amont}
          />
        )}
        {/* LA PIÈCE D'ABORD : le formulaire s'ouvre rempli de ce qu'elle dit (`nouveau-document-legal.tsx`). */}
        {canCreate && (
          <NouveauDocumentLegal
            facture={nature === "INVOICE" || facturesSeules}
            label={nature === "INVOICE" ? "Nouvelle facture" : "Nouveau document"}
            title={nature === "INVOICE" ? "Enregistrer une facture" : "Déclarer un document légal"}
            description={nature === "INVOICE"
              ? "Une facture est un document légal de nature « facture » : elle se range avec les devis et les bons de commande dont elle découle. Renseigner la date de règlement suffit à la déclarer réglée."
              : "Un document peut n'avoir aucune date : laissez les dates vides, il ne se périmera jamais et ne déclenchera aucun rappel."}
            action={createLegalDocument}
            fields={legalFields(
              // La nature demandée par l'URL PRÉREMPLIT le formulaire : arriver par « les
              // factures » et devoir rechoisir « facture » dans une liste de dix est le genre
              // de frottement qui fait recréer un écran dédié.
              { folderId: openFolderId ?? undefined, kind: nature || undefined },
              "create", people, folderOptions, chainCandidates,
              facturesSeules,
              { options: partyOptions, canCreate: canCreateContact },
              false,
              peutDaterLeReglement({ financesModifier: userCan(user, "FINANCES", "UPDATE") }),
            )}
            redirectBase="/legal"
          />
        )}
      </PageHeader>

      <div className={cn("grid grid-cols-2 gap-3", factures.count > 0 ? "md:grid-cols-3" : "md:grid-cols-4")}>
        <KpiCard label={facturesSeules ? "Factures" : "Documents"} value={rows.length} icon="Scale" />
        {factures.count > 0 ? (
          <>
            {/* La case « Reste à payer » est retirée (Direction, 06/10). */}
            <KpiCard label="Factures à régler" value={factures.unpaid} icon="Hourglass" tone={factures.unpaid > 0 ? "warning" : "default"} />
            <KpiCard
              label="Échéance dépassée" value={factures.overdue + (facturesSeules ? 0 : overdue)}
              icon="AlertTriangle" tone={factures.overdue + overdue > 0 ? "danger" : "default"}
            />
          </>
        ) : (
          <>
            <KpiCard label="Échéance < 3 mois" value={watch} icon="AlarmClock" tone={watch > 0 ? "warning" : "default"} />
            <KpiCard label="Échéances dépassées" value={overdue} icon="AlertTriangle" tone={overdue > 0 ? "danger" : "default"} />
            <KpiCard label="Bons de commande" value={rows.filter((r) => r.kind === "PURCHASE_ORDER").length} icon="ClipboardList" tone="info" />
          </>
        )}
      </div>

      {/* L'ARMOIRE ne s'affiche pas à qui ne voit que les factures : ses dossiers rangent tout
          le registre, et une barre qui compte des documents qu'on ne peut pas ouvrir se lit
          comme une panne. */}
      {!facturesSeules && (
        <LegalFolderBar
          folders={folders}
          current={searchParams?.dossier ?? null}
          companies={myCompanies.map((c) => ({ id: c.id, label: companyLabel(c) }))}
          canManage={canCreate}
        />
      )}

      {/* `scope` DÉCLARE à quel ensemble de documents ces filtres s'appliquent. La barre de
          dossiers navigue par <Link> : sans lui, le filtre « à surveiller » posé par un rappel
          d'échéance survivait au changement de dossier et masquait des documents pourtant
          servis — les fameux bons de commande « disparus ». */}
      <LegalTable
        rows={rows} canEdit={canEdit} watchByDefault={searchParams?.echeances === "1"}
        droitsEcriture={{
          legal: { creer: userCan(user, "LEGAL", "CREATE"), modifier: userCan(user, "LEGAL", "UPDATE") },
          finances: { creer: userCan(user, "FINANCES", "CREATE"), modifier: userCan(user, "FINANCES", "UPDATE") },
        }}
        initialKind={nature}
        scope={legalListScope({
          folderId: openFolderId,
          unfiledOnly,
          fromExpiryAlert: searchParams?.echeances === "1",
          kind: nature,
        })}
        folders={folders.map((f) => ({ id: f.id, name: f.name }))}
        currentFolderId={openFolderId}
      />
    </div>
  );
}
