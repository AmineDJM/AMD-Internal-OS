import type { ReactNode } from "react";
import Link from "next/link";
import { Paperclip, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { SectionRepliable, Sections } from "@/components/shared/section-repliable";
import { PartyLink } from "@/components/directory/party-link";
import { PartagerButton } from "@/components/shared/partager-button";
import { RecordDeleteButton } from "@/components/shared/record-delete-button";
import { EntityLinks } from "@/components/shared/entity-links";
import { HistoriqueAnnulable } from "@/modules/assistant-ia/ecrans/barre-annulation";
import type { DocItem } from "@/components/documents/document-list";
import { MAIL_DIRECTION, AUDIT_ACTION } from "@/lib/labels";
import { formatDate, formatDateTime } from "@/lib/utils";
import { renderTraceValue } from "@/lib/mail-register/trace";
import type { FicheCourrier as Fiche } from "@/lib/mail-register/fiche";
import { sourceHref, sourceCaption } from "@/lib/links/source-link";
import { lienCourrier, lienRegistreCourriers } from "@/lib/chemins/courriers";
import { mailFields, dateInput, dateTimeInput, champsRepliesCourrier } from "./mail-fields";
import { PanneauCourrier } from "./panneau-courrier";
import { DocumentsCourrier } from "./documents-courrier";
import { ClasserCourrier } from "./classer-courrier";
import { MailPieces } from "./mail-pieces";

/**
 * LA FICHE D'UN COURRIER, DANS SON PANNEAU — rendue au serveur, posée par-dessus le registre.
 *
 * L'ordre suit la question qu'on pose au pli : quoi et quand (en-tête), avec qui (correspondants),
 * quels papiers (documents), où il est rangé (dossier). Le reste — notes, dates, porteur, à qui il
 * s'adresse en interne, pièces nominatives, liens, historique — est replié : présent, pas affiché.
 */
export function FicheCourrierPanneau({ fiche, dossier }: { fiche: Fiche; dossier: string | null }) {
  const { entry, droits, documents, history, liens, partyOptions, driveLisible, menus } = fiche;
  const dir = MAIL_DIRECTION[entry.direction];

  const champs = droits.canEdit
    ? mailFields({
        title: entry.title,
        direction: entry.direction,
        reference: entry.reference ?? undefined,
        sender: entry.sender ?? undefined,
        recipient: entry.recipient ?? undefined,
        sentAt: dateTimeInput(entry.sentAt),
        receivedAt: dateInput(entry.receivedAt),
        acknowledgedAt: dateInput(entry.acknowledgedAt),
        carrier: entry.carrier ?? undefined,
        notes: entry.notes ?? undefined,
        companyId: entry.companyId ?? undefined,
        partnerId: entry.partnerId ?? undefined,
        departmentId: entry.departmentId ?? undefined,
        concernedUserId: entry.concernedUserId ?? undefined,
        folderId: entry.folderId ?? undefined,
      }, "edit", menus.companies, menus.partners, menus.departments, menus.people, menus.folders, {
        options: partyOptions, canCreate: droits.canCreateContact,
        selected: {
          sender: entry.senderContactId ? [entry.senderContactId] : [],
          recipient: entry.recipientContactId ? [entry.recipientContactId] : [],
        },
      })
    : null;

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  // LA DATE QUI DIT LE PLI : son arrivée pour un entrant, son départ pour un sortant.
  const dateEnTete = entry.direction === "INCOMING"
    ? (entry.receivedAt ? `Reçu le ${formatDate(entry.receivedAt)}` : entry.sentAt ? `Envoyé le ${formatDateTime(entry.sentAt)}` : null)
    : (entry.sentAt ? `Envoyé le ${formatDateTime(entry.sentAt)}` : null);

  const libellePartage = entry.reference ? `${entry.reference} — ${entry.title}` : entry.title;
  const concerne = [entry.company?.shortName || entry.company?.name, entry.partner?.name, entry.department?.name, entry.concernedUser?.name].filter(Boolean).join(" · ");

  // LE FICHIER DU DRIVE RÉFÉRENCÉ — son nom n'est montré qu'à qui peut l'ouvrir.
  const drive = entry.driveNode ? (
    driveLisible.has(entry.driveNode.id) ? (
      <Link href={`/drive/${entry.driveNode.id}`} className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-primary hover:underline">
        <Paperclip className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{entry.driveNode.name}</span> <ExternalLink className="h-3 w-3 shrink-0" />
      </Link>
    ) : (
      <p className="text-sm text-muted-foreground">Un fichier du Drive vous est fermé — demandez-le à son propriétaire.</p>
    )
  ) : null;

  const menu = (
    <>
      <PartagerButton variant="ghost" refType="MAIL_ENTRY" refId={entry.id} refLabel={libellePartage} href={lienCourrier(entry.id)} />
      {droits.canEdit && <ClasserCourrier entryId={entry.id} dossierActuel={entry.folderId} dossiers={menus.folders} />}
      <RecordDeleteButton kind="MAIL_ENTRY" id={entry.id} name={entry.title} typeLabel="ce courrier" enabled={droits.canDelete} />
    </>
  );

  return (
    <PanneauCourrier
      key={entry.id}
      id={entry.id}
      titre={`Courrier ${(dir?.label ?? entry.direction).toLowerCase()}`}
      fermerHref={lienRegistreCourriers(dossier)}
      champs={champs}
      champsReplies={champsRepliesCourrier(menus.companies.length)}
      menu={menu}
    >
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={dir?.tone ?? "neutral"} dot={false}>{dir?.label ?? entry.direction}</Badge>
          {entry.reference && <span className="font-mono">{entry.reference}</span>}
          {dateEnTete && <span>{dateEnTete}</span>}
        </div>
        <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">{entry.title}</h3>
      </header>

      <Bloc titre="Correspondants">
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Expéditeur</p>
            <PartyLink parties={partyOptions.filter((o) => o.id === entry.senderContactId)} fallback={entry.sender} className="font-medium" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Destinataire</p>
            <PartyLink parties={partyOptions.filter((o) => o.id === entry.recipientContactId)} fallback={entry.recipient} className="font-medium" />
          </div>
        </div>
      </Bloc>

      <Bloc titre={`Documents${docItems.length ? ` (${docItems.length})` : ""}`}>
        <DocumentsCourrier entryId={entry.id} documents={docItems} canUpload={droits.canUpload} canEdit={droits.canEdit} drive={drive} />
      </Bloc>

      <Bloc titre="Dossier">
        {entry.folder ? (
          <Link href={lienRegistreCourriers(entry.folder.id)} scroll={false} className="text-sm font-medium text-primary hover:underline">{entry.folder.name}</Link>
        ) : (
          <p className="text-sm text-muted-foreground">Non classé{droits.canEdit ? " — « ⋯ › Classer » pour le ranger." : "."}</p>
        )}
      </Bloc>

      <Sections>
        {entry.notes && (
          <SectionRepliable titre="Notes" dense>
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{entry.notes}</p>
          </SectionRepliable>
        )}
        <SectionRepliable titre="Dates et porteur" dense resume={entry.acknowledgedAt ? `Accusé le ${formatDate(entry.acknowledgedAt)}` : "Sans accusé"}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {/* Le départ garde son HEURE : deux plis du même jour ne partent pas ensemble. */}
            <Info label="Départ" value={entry.sentAt ? formatDateTime(entry.sentAt) : null} />
            <Info label="Arrivée" value={entry.receivedAt ? formatDate(entry.receivedAt) : null} />
            <Info label="Accusé de réception" value={entry.acknowledgedAt ? formatDate(entry.acknowledgedAt) : null} />
            <Info label="Porteur" value={entry.carrier} />
          </div>
        </SectionRepliable>
        <SectionRepliable titre="Concerne" dense resume={concerne || undefined}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Entité" value={entry.company ? entry.company.shortName || entry.company.name : null} />
            <Info label="Partenaire" value={entry.partner?.name} />
            <Info label="Direction" value={entry.department?.name} />
            <Info label="Personne" value={entry.concernedUser?.name} />
            {/* D'OÙ ÇA VIENT : le chemin de retour vers l'affaire qui a motivé ce pli. */}
            {entry.sourceType && (
              <div className="col-span-2 min-w-0">
                <p className="text-xs text-muted-foreground">Rattaché à</p>
                {sourceHref(entry.sourceType, entry.sourceId) ? (
                  <Link href={sourceHref(entry.sourceType, entry.sourceId)!} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    {sourceCaption(entry.sourceType)} <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : (
                  <p className="font-medium">{sourceCaption(entry.sourceType)}</p>
                )}
              </div>
            )}
          </div>
        </SectionRepliable>
        {/* LES PIÈCES NOMINATIVES — qui a reçu quel papier, quand un même pli part à plusieurs endroits. */}
        <SectionRepliable titre="Pièces et destinataires" dense compte={entry.pieces.length} sansCadre>
          <MailPieces
            entryId={entry.id}
            canEdit={droits.canEdit}
            pieces={entry.pieces.map((p) => ({
              id: p.id, label: p.label, recipient: p.recipient, notes: p.notes,
              documentId: p.documentId, driveNodeId: p.driveNodeId,
              driveName: p.driveNodeId && driveLisible.has(p.driveNodeId) ? (p.driveNode?.name ?? null) : null,
            }))}
          />
        </SectionRepliable>
        {(liens.length > 0 || droits.canEdit) && (
          <SectionRepliable titre="Liens" dense compte={liens.length} sansCadre>
            <EntityLinks self={{ type: "MAIL_ENTRY", id: entry.id }} links={liens} canEdit={droits.canEdit} emptyHint="Aucun lien. « Relier » pour l'attacher à un marché, un contrat, une facture…" />
          </SectionRepliable>
        )}
        <SectionRepliable titre="Historique" dense resume={`Enregistré par ${entry.createdBy?.name ?? "—"} le ${formatDate(entry.createdAt)}`}>
          <div className="space-y-3">
            {/* Les gestes faits sur ce pli, chacun annulable (et rétablissable). */}
            <HistoriqueAnnulable modele="MailEntry" id={entry.id} />
            <div className="space-y-2.5 text-xs">
              {history.length === 0 ? (
                <p className="text-muted-foreground">Aucun mouvement.</p>
              ) : history.map((h) => (
                <div key={h.id} className="space-y-0.5 border-b border-border pb-2 last:border-0 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <StatusBadge map={AUDIT_ACTION} value={h.action} dot={false} />
                    <span className="shrink-0 text-muted-foreground">{formatDateTime(h.createdAt)}</span>
                  </div>
                  {/* Le champ touché et ses deux valeurs : ce qui distingue un journal utile d'un « modifié ». */}
                  {h.field ? (
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">{h.field}</span>{" : "}
                      {renderTraceValue(h.oldValue)} → <span className="text-foreground">{renderTraceValue(h.newValue)}</span>
                    </p>
                  ) : (
                    <p className="text-muted-foreground">{h.summary ?? "—"}</p>
                  )}
                  <p className="text-muted-foreground">{h.actor?.name ?? "Système"}</p>
                </div>
              ))}
            </div>
          </div>
        </SectionRepliable>
      </Sections>
    </PanneauCourrier>
  );
}

function Bloc({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titre}</h4>
      {children}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium [overflow-wrap:anywhere]">{value || "—"}</p>
    </div>
  );
}
