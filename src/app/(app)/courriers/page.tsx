import { Filter } from "lucide-react";
import { requireModule } from "@/lib/session";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { hiddenByScopeMessage } from "@/lib/company-visibility";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getCompanyScope, companyIdForNew, companyScopedWhere } from "@/lib/company";
import { clauseCourriersVisibles } from "@/lib/queries/visibilite-listes";
import { PageHeader } from "@/components/shared/page-header";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { createMailEntry } from "@/lib/actions/mail-register-actions";
import { mailFields, champsRepliesCourrier } from "./mail-fields";
import { chargerFicheCourrier } from "@/lib/mail-register/fiche";
import { FicheCourrierPanneau } from "./fiche-courrier";
import { MailTable, type MailRow } from "./mail-table";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { MailPartnersManager } from "./mail-partners";
import { mailRoutingOptions } from "@/lib/queries/mail-routing";
import type { MailFolderRow } from "./mail-folder-bar";
import { buildFolderTree, flattenFolders, indentedLabel } from "@/lib/legal/folders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Courriers — AMD Internal OS" };

/**
 * COURRIERS — le carnet des plis entrants et sortants.
 *
 * C'est le registre de l'assistante de direction : ce qui est parti, quand, par qui, et ce qui
 * est revenu signé. Le Super Admin en ouvre l'accès à qui il veut (module `MAIL_REGISTER`) —
 * beaucoup d'organisations veulent que la Direction le lise sans pouvoir l'écrire.
 *
 * Les quatre dates ne se remplissent pas au même moment : on POSTE (avec l'heure), le pli
 * ARRIVE, puis l'ACCUSÉ revient. Aucune n'est obligatoire — exiger une date qu'on n'a pas encore
 * ferait inventer une information.
 *
 * Le tableau sert à RETROUVER ; le travail sur un pli (documents, correction, journal) se fait dans
 * son PANNEAU, ouvert par-dessus le tableau quand l'adresse porte `?courrier=<id>` — un lien partagé
 * ou une notification l'ouvrent directement. Il n'y a plus de page par courrier : `/courriers/<id>`
 * renvoie ici. Enregistrer un courrier ouvre son panneau — on vient presque toujours d'un scan.
 */
export default async function CourriersPage(props: { searchParams?: Promise<{ dossier?: string; courrier?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MAIL_REGISTER");
  const canCreate = userCan(user, "MAIL_REGISTER", "CREATE");
  const canEdit = userCan(user, "MAIL_REGISTER", "UPDATE");
  // L'ANNUAIRE DE L'ENTREPRISE — d'où l'expéditeur et le destinataire se choisissent.
  const partyOptions = canCreate ? await listPartyOptions(user.id) : [];
  const canCreateContact = userCan(user, "GENERAL_MEANS", "CREATE");

  // Le dossier ouvert : « none » = les plis non classés, un identifiant = ce dossier, absent = tout.
  const unfiledOnly = searchParams?.dossier === "none";
  const openFolderId = searchParams?.dossier && searchParams.dossier !== "none" ? searchParams.dossier : null;
  const folderWhere = unfiledOnly ? { folderId: null } : openFolderId ? { folderId: openFolderId } : {};

  // Les entités que CETTE personne peut choisir, les partenaires actifs du registre, et à qui
  // le pli s'adresse en interne (direction de l'organigramme, personne nommément visée).
  const [myCompanies, partners, routing] = await Promise.all([
    getMyCompanies(user.id),
    prisma.mailPartner.findMany({
      where: { isActive: true },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    }),
    mailRoutingOptions(),
  ]);
  const companyOpts = myCompanies.map((c) => ({ value: c.id, label: companyLabel(c) }));
  const partnerRows = partners.map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  const partnerOpts = partners.map((p) => ({ value: p.id, label: p.kind ? `${p.name} — ${p.kind}` : p.name }));

  // COMBIEN LE FILTRE D'ENTITÉ RETIRE — compté, puis DIT. Sans ce chiffre, on ouvre le registre
  // et l'on compte dix-neuf plis, on y revient et l'on en compte quatorze : rien à l'écran ne
  // relie les deux faits, et l'on conclut que le module perd des courriers.
  // Le PÉRIMÈTRE de la liste est celui que la recherche globale lit aussi (§118.177) ; le dossier
  // ouvert est un filtre d'affichage, composé EN `AND` par-dessus.
  const porteeWhere = { AND: [await clauseCourriersVisibles(user.id), folderWhere] };
  // L'ENTITÉ EST PRÉ-CHOISIE À LA CRÉATION — celle sur laquelle la personne travaille, ou la
  // sienne. Le menu s'ouvrait sur un choix vide : la plupart des plis étaient enregistrés sans
  // entité, et sortaient aussitôt de toutes les vues cloisonnées. Un pré-choix VISIBLE, qu'on
  // change en un clic, vaut mieux qu'un repli silencieux — l'assistante des trois sociétés voit
  // sur laquelle elle est en train de classer.
  const entiteParDefaut = await companyIdForNew(user.id);
  const [horsPortee, dansPortee] = await Promise.all([
    prisma.mailEntry.count({ where: folderWhere }),
    prisma.mailEntry.count({ where: porteeWhere }),
  ]);
  const scopeId = await getCompanyScope();
  const masques = hiddenByScopeMessage({
    shown: dansPortee,
    total: horsPortee,
    companyLabel: scopeId ? (myCompanies.find((c) => c.id === scopeId)?.name ?? null) : null,
  });

  const entries = await prisma.mailEntry.findMany({
    where: porteeWhere,
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    take: 500,
    include: {
      company: { select: { name: true, shortName: true } },
      partner: { select: { name: true } },
      department: { select: { name: true } },
      concernedUser: { select: { name: true } },
    },
  });

  // Le nombre de pièces jointes par courrier, en UNE requête : afficher « 0 » partout serait faux,
  // et interroger la table document par ligne mettrait 500 requêtes derrière un simple affichage.
  const attachments = await prisma.document.groupBy({
    by: ["entityId"],
    where: { entityType: "MAIL_ENTRY", entityId: { in: entries.map((m) => m.id) } },
    _count: { _all: true },
  });
  const attachmentCount = new Map(attachments.map((a) => [a.entityId, a._count._all]));

  // Les dossiers de classement et le nombre de plis rangés dans chacun — en deux requêtes, pas
  // une par dossier. L'armoire du registre : on classe cinq cents plis, on ne les filtre pas un
  // par un.
  // LE MÊME CLOISONNEMENT QUE LES PLIS (audit Courrier, 24/11) : les dossiers d'une société qu'on
  // ne voit pas n'apparaissaient pas moins dans la barre, avec le nombre de plis qu'ils rangent —
  // le nom des dossiers d'Alpha et le volume de son courrier, lus depuis Beta. Les compteurs ne
  // comptent que les plis de la portée : un dossier qui annonce 12 et en montre 7 ment.
  const [folderRows, folderCounts] = await Promise.all([
    prisma.mailEntryFolder.findMany({
      where: await companyScopedWhere(user.id, {}),
      select: { id: true, name: true, parentId: true, companyId: true, company: { select: { name: true, shortName: true } } },
    }),
    prisma.mailEntry.groupBy({
      by: ["folderId"],
      where: { AND: [await clauseCourriersVisibles(user.id), { folderId: { not: null } }] },
      _count: { _all: true },
    }),
  ]);
  const countByFolder = new Map(folderCounts.map((c) => [c.folderId as string, c._count._all]));
  const folders: MailFolderRow[] = folderRows.map((f) => ({
    id: f.id, name: f.name, parentId: f.parentId, companyId: f.companyId,
    companyLabel: f.company ? f.company.shortName ?? f.company.name : null,
    entryCount: countByFolder.get(f.id) ?? 0,
  }));
  const folderOptions = flattenFolders(buildFolderTree(folders)).map((n) => ({ value: n.id, label: indentedLabel(n) }));

  const rows: MailRow[] = entries.map((m) => ({
    id: m.id,
    reference: m.reference,
    title: m.title,
    direction: m.direction,
    sender: m.sender,
    recipient: m.recipient,
    sentAt: m.sentAt?.toISOString() ?? null,
    receivedAt: m.receivedAt?.toISOString() ?? null,
    acknowledgedAt: m.acknowledgedAt?.toISOString() ?? null,
    carrier: m.carrier,
    companyName: m.company?.shortName ?? m.company?.name ?? "",
    partnerName: m.partner?.name ?? "",
    departmentName: m.department?.name ?? "",
    concernedName: m.concernedUser?.name ?? "",
    attachments: attachmentCount.get(m.id) ?? 0,
  }));

  // LE COURRIER OUVERT DANS LE PANNEAU — l'identifiant vient de l'adresse, il ne vaut rien tant que
  // la clause de visibilité du registre ne l'a pas retrouvé (`chargerFicheCourrier`) : un pli hors
  // périmètre n'ouvre rien, comme l'ancienne page répondait 404.
  const courrierId = searchParams?.courrier ?? null;
  const fiche = courrierId ? await chargerFicheCourrier(user, courrierId) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Courriers">
        {/* LA LISTE DES PARTENAIRES, tenue depuis le module — pas depuis l'Administration :
            c'est l'assistante qui l'alimente en enregistrant ses plis, et l'envoyer ailleurs
            pour ajouter un nom qu'elle a sous les yeux, c'est garantir que la liste ne vivra pas. */}
        {canEdit && <MailPartnersManager partners={partnerRows} />}
        {canCreate && (
          <CreateRecordButton
            label="Enregistrer un courrier" title="Enregistrer un courrier" width="lg"
            action={createMailEntry}
            champsReplies={champsRepliesCourrier(companyOpts.length)}
            fields={mailFields(
              { ...(openFolderId ? { folderId: openFolderId } : {}), ...(entiteParDefaut ? { companyId: entiteParDefaut } : {}) },
              "create", companyOpts, partnerOpts, routing.departments, routing.people, folderOptions,
              { options: partyOptions, canCreate: canCreateContact },
            )}
            redirectBase="/courriers"
          />
        )}
      </PageHeader>

      {masques && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
          <Filter className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {masques}
        </p>
      )}

      {courrierId && !fiche && (
        <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
          Ce courrier n&apos;est pas dans votre vue : supprimé, ou d&apos;une autre entité — choisissez « Toutes les entités » en haut de l&apos;écran, ou demandez l&apos;accès à un administrateur.
        </p>
      )}

      {/* LA CARTE « DOSSIERS » EST RETIRÉE (Super Admin, 25/11/2026) : le tableau remonte. Les dossiers existants restent :
          un courrier se range par « Classer » dans son panneau. */}
      <MailTable rows={rows} canEdit={canEdit} canCreate={canCreate} dossier={searchParams?.dossier ?? null} selection={fiche?.entry.id ?? null} />

      {fiche && <FicheCourrierPanneau fiche={fiche} dossier={searchParams?.dossier ?? null} />}
    </div>
  );
}
