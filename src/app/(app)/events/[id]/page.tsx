import { BlocHistorique } from "@/modules/ad-pro/ecrans/bloc-historique";
import { notFound } from "next/navigation";
import { ArrowLeft, Video } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { porteeModificationEvenement, canEditAdProRequest, isAdProDecided, breakdown, AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, canAttachToAdPro, attachHint, siegeAuCentreAdPro } from "@/modules/ad-pro/partage";
import { prisma } from "@/lib/prisma";
import { getEventDetail, peutSupprimerUneDemandeAdPro, adProEditValues, loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes, getAdProCreateData } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EVENT_TYPE, EVENT_SCOPE, EVENT_FORMAT, EVENT_STATUS } from "@/lib/labels";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { EditEventButton } from "../event-form";
import { EventFundingPanel } from "./funding-panel";
import { ThirdPartyInvolveButton } from "@/modules/ad-pro/ecrans/third-party-involve";
import { InvolvementConversations } from "@/modules/ad-pro/ecrans/involvement-conversations";
import { getInvolvementThreads } from "@/lib/queries/involvement";
import { getEntityMissions } from "@/lib/queries/missions";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { WithdrawForm, HistoriqueDuCircuit } from "@/components/workflow/workflow-panel";
import { MissionAssignmentsCard } from "@/components/missions/mission-assignments-card";
import { SupprimerDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-demande";
import { BackLink } from "@/components/shared/back-link";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";
import { PiecesLegalDeLaDemande } from "@/modules/ad-pro/ecrans/pieces-legal-demande";
import { CarteDetailsDemande } from "@/modules/ad-pro/ecrans/pieces-jointes-demande";
import { Faits, Fait, BandeauArgent, Chiffre, Repli, IntertitrePostes, CarteTracabilite } from "@/modules/ad-pro/ecrans/carte-demande";
import { EspaceDiscussion } from "@/modules/ad-pro/ecrans/espace-discussion";
import { promoMaterialOptions } from "@/modules/ad-pro/actions-postes";
import { toNumber } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import type { DocItem } from "@/components/documents/document-list";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import { MedecinsConcernes } from "@/modules/ad-pro/ecrans/medecins-concernes";

export const dynamic = "force-dynamic";

export default async function EventDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("EVENTS");
  const e = await getEventDetail(params.id);
  if (!e) notFound();
  // LA PORTE DE LA FICHE (§118.184) : société, parties prenantes. Un identifiant ne suffit plus à ouvrir
  // l'événement d'une autre société — hors de cette porte, il est introuvable, comme s'il n'existait pas.
  if (!(await canAccessEntity(user, "EVENT", e.id, "VIEW"))) notFound();
  // LE FORMULAIRE COMPLET : qui tranche les événements, ou la vue globale — et après la décision, la
  // seule organisation (`events/modification.ts`, la même règle que l'action). Le droit UPDATE seul
  // l'ouvrait à tous les délégués, sur les événements de leurs collègues.
  const eventDecided = e.requestStatus ? isAdProDecided("EVENT", e.requestStatus) : false;
  const porteeEdition = porteeModificationEvenement({
    vueGlobale: hasGlobalView(user), tranche: userCan(user, "EVENTS", "VALIDATE"), decided: eventDecided,
  });
  const canManage = porteeEdition !== "AUCUNE" && (await canAccessEntity(user, "EVENT", e.id, "UPDATE"));
  const canDelete = userCan(user, "EVENTS", "DELETE");
  // Circuit de prise en charge (financement) — mêmes rôles que pour les congrès.
  const canMarketing = hasRole(user, "NATIONAL_SALES") || user.role === "SUPER_ADMIN";
  const canValidate = hasGlobalView(user);
  // SOUMETTRE — ET RELANCER APRÈS UN REFUS (§118.186) — : l'organisateur, ou qui modifie l'événement en
  // entier. La même règle que l'action : un bouton offert à qui l'action refusera fait chercher une
  // panne qui n'existe pas (§118.83).
  const sonEvenement = e.requesterId === user.id || (!e.requesterId && e.createdById === user.id);
  const canSubmit = userCan(user, "EVENTS", "CREATE") && (sonEvenement || hasGlobalView(user) || userCan(user, "EVENTS", "VALIDATE"));
  // LES MÊMES RÉFÉRENTIELS QU'À LA CRÉATION. Le formulaire de modification porte les mêmes champs
  // obligatoires (`champsManquants` est lu par les deux actions) : sans les menus, la personne
  // devrait ressaisir en texte libre ce qu'elle avait choisi dans l'annuaire — et l'action la
  // refuserait pour un champ qu'elle ne sait plus proposer.
  const [items, promoOptions, budgetOptions, adPro, contexte] = await Promise.all([
    loadAdProItems("EVENT", e.id),
    promoMaterialOptions(),
    adProBudgetOptions(user),
    canManage ? getAdProCreateData(user.id, ["EVENT"]) : Promise.resolve(null),
    contextePostes(user, "EVENT", e.id),
  ]);
  const canAllocateItems = hasGlobalView(user) || userCan(user, "EVENTS", "VALIDATE");
  // LE MAGASIN où un poste « Matériel du stock » pioche, et qui confirme après l'événement (§118.167).
  const materielStock = await contexteMaterielStock(user, "EVENT", e.id, canAllocateItems);

  // CORRIGER LA DEMANDE : le demandeur tant qu'elle n'est pas tranchée, la Direction toujours.
  const canEditEventRequest = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user), canManage: userCan(user, "EVENTS", "VALIDATE") },
    { requesterId: e.requesterId ?? null, decided: eventDecided },
  );
  const eventEditValues = canEditEventRequest ? await adProEditValues("EVENT", e.id) : null;
  const [responsibles, missions, workflow, documents, involvementThreads, dates] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getEntityMissions("EVENT", e.id),
    getWorkflowForEntity(user, "EVENT", e.id, e.requesterId ?? null),
    prisma.document.findMany({ where: { entityType: "EVENT", entityId: e.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    getInvolvementThreads("EVENT", e.id),
    // « Traçabilité » : créée le, modifiée le.
    prisma.event.findUnique({ where: { id: e.id }, select: { createdAt: true, updatedAt: true } }),
  ]);
  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));
  // QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE — la MÊME règle sur les cinq écrans
  // Ad&Pro (`ad-pro/attachments.ts`) : chacun l'épelait à sa façon, et chaque orthographe
  // oubliait quelqu'un, qui envoyait alors la facture par mail avec un dossier vide.
  const attacheur = {
    id: user.id,
    canUploadModule: userCan(user, "EVENTS", "UPLOAD"),
    canUpdateModule: userCan(user, "EVENTS", "UPDATE"),
    canValidateModule: userCan(user, "EVENTS", "VALIDATE"),
    hasGlobalView: hasGlobalView(user),
  };
  const dossierAdPro = { requesterId: e.requesterId ?? null, productManagerId: e.productManagerId ?? null };
  const canUploadDocs = canAttachToAdPro(attacheur, dossierAdPro) || canManage;
  const uploadHint = canUploadDocs ? null : attachHint(attacheur, dossierAdPro);

  // ── « ⋯ » : LES GESTES SECONDAIRES (Direction, 07/10) — les mêmes boutons, les mêmes droits, rangés. ──
  const peutSupprimer = await peutSupprimerUneDemandeAdPro(user, "EVENT", e.id);
  // Le DEMANDEUR corrige sa demande tant qu'elle n'est pas tranchée (les gestionnaires ont déjà l'édition complète —
  // inutile de doubler leur bouton).
  const peutCorriger = !canManage && canEditEventRequest && eventEditValues !== null;
  const peutImpliquer = canManage || canMarketing || canValidate;
  const peutRetirer = Boolean(e.requestStatus) && Boolean(workflow?.peutRetirer);
  const menu = canManage || peutCorriger || peutImpliquer || peutRetirer || peutSupprimer;

  // L'ARGENT, EN UN BANDEAU (Direction, 07/10) : budget estimé, enveloppe accordée, affecté aux postes, reste ou dépassement.
  const ventilation = breakdown(items, e.finalAmount);
  const dateTexte = [e.startDate && formatDate(e.startDate), e.endDate && formatDate(e.endDate)].filter(Boolean).join(" → ");
  const creeeLe = dates?.createdAt ?? null;

  return (
    <div className="space-y-5">
      <BackLink href="/events"><ArrowLeft className="h-4 w-4" /> Events</BackLink>
      <PageHeader
        title={e.name}
        description={[
          EVENT_TYPE[e.type] ?? e.type,
          e.requesterName
            ? `demandé par ${e.requesterName}${creeeLe ? ` le ${formatDate(creeeLe)}` : ""}`
            : creeeLe ? `créé le ${formatDate(creeeLe)}` : null,
        ].filter(Boolean).join(" · ")}
      >
        <StatusBadge map={EVENT_STATUS} value={e.status} />
        {menu && (
          <MenuDossier>
            {canManage && (
              <EditEventButton
                event={e}
                responsibles={responsibles}
                referentiels={adPro ? {
                  doctors: adPro.doctors, products: adPro.products,
                  specialties: adPro.specialties, specialtiesHeritees: adPro.specialtiesHeritees,
                  businessUnits: adPro.businessUnits, businessUnitDeduite: adPro.businessUnitDeduite,
                } : undefined}
                canDelete={canDelete}
                organisationSeule={porteeEdition === "ORGANISATION"}
              />
            )}
            {peutCorriger && eventEditValues && (
              <AdProEditButton kind="EVENT" id={e.id} decided={eventDecided} values={eventEditValues} />
            )}
            {peutImpliquer && <ThirdPartyInvolveButton type="EVENT" id={e.id} people={responsibles} />}
            {peutRetirer && <WithdrawForm entityType="EVENT" entityId={e.id} dansUnMenu />}
            <SupprimerDemandeAdPro kind="EVENT" id={e.id} name={e.name} enabled={peutSupprimer} />
          </MenuDossier>
        )}
      </PageHeader>

      <BlocHistorique user={user} type="EVENT" id={e.id} />

      {/* LE BLOC « SUIVI DE VALIDATION » A ÉTÉ RETIRÉ (demande de la Direction, 09/2026).
          Il montrait une frise « Brouillon → En attente → Validé » dérivée de `Event.status`,
          c'est-à-dire d'un champ que le formulaire « Modifier » écrivait à la main — et il
          invitait même à le faire (« Faites avancer la validation via Modifier »). Un événement
          pouvait donc s'afficher « Validé » sans qu'aucune étape ne l'ait validé : deux vérités
          sur la même question, et c'est la plus flatteuse qui gagnait (§118.5, §118.138).
          La SEULE frise de validation est celle du circuit de prise en charge, en tête de la carte
          « La demande », et `lib/events/statut.ts` interdit au formulaire d'écrire un verdict. */}

      {/* LA DEMANDE, EN UNE CARTE (Direction, 07/10) — « Informations », « Demande de prise en charge (financement) » et
          « Ce que couvre cet événement » fusionnés : la frise et la phrase de statut de la prise en charge (avec ses gestes :
          soumettre, décider, relancer), les faits une fois, l'argent en un bandeau, la description et les pièces jointes
          repliées, puis les postes. « + Pièce jointe » en haut à droite ; la chaîne d'achat vit sur chaque poste. */}
      <CarteDetailsDemande
        titre="La demande"
        piecesRepliees
        contentClassName="space-y-3"
        pieces={{
          entityType: "EVENT", entityId: e.id, documents: docItems,
          peutDeposer: canUploadDocs, motif: uploadHint,
          categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
          canDelete: userCan(user, "EVENTS", "DELETE") || hasGlobalView(user),
          canRename: canUploadDocs, canEdit: onlyofficeConfigured() && canUploadDocs,
          path: `/events/${e.id}`,
        }}
        entete={
          <div className="space-y-4">
            <EventFundingPanel
              eventId={e.id}
              requestSubmitted={!!e.requestStatus}
              canSubmit={canSubmit}
              workflow={workflow}
              compact
            />

            <Faits>
              <Fait label="Dates" valeur={dateTexte} />
              <Fait label="Lieu" valeur={[e.location, e.city, e.country].filter(Boolean).join(", ")} />
              <Fait label="Portée" valeur={EVENT_SCOPE[e.scope] ?? e.scope} />
              <Fait label="Format" valeur={EVENT_FORMAT[e.format] ?? e.format} />
              <Fait label="Spécialité" valeur={e.specialty} />
              <Fait label="Produits" valeur={e.products} />
              {e.doctor && <Fait label="Médecins" valeur={e.doctor} />}
              <Fait label="Organisateur" valeur={e.organizer} />
              <Fait label="Responsable" valeur={e.responsibleName} />
              {e.meetingLink && (
                <Fait
                  large
                  label="Webinar"
                  valeur={<a href={e.meetingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-primary hover:underline"><Video className="h-4 w-4" /> Lien de connexion</a>}
                />
              )}
            </Faits>

            <BandeauArgent>
              <Chiffre label="Budget estimé" valeur={e.estimatedBudget !== null ? formatCurrency(e.estimatedBudget) : "—"} />
              <Chiffre label="Enveloppe accordée" valeur={e.finalAmount != null ? formatCurrency(e.finalAmount) : "Non tranchée"} discret={e.finalAmount == null} />
              <Chiffre
                label="Affecté aux postes"
                valeur={formatCurrency(ventilation.totalRequestedDzd)}
                note={ventilation.additionalDzd > 0
                  ? `dont ${formatCurrency(ventilation.additionalDzd)} en rallonge`
                  : `${ventilation.itemCount} poste${ventilation.itemCount > 1 ? "s" : ""}`}
                ton={ventilation.additionalDzd > 0 ? "attente" : undefined}
              />
              {ventilation.overrunDzd > 0 ? (
                <Chiffre label="Dépassement" valeur={formatCurrency(ventilation.overrunDzd)} ton="alerte" />
              ) : (
                <Chiffre
                  label="Reste à affecter"
                  valeur={ventilation.envelopeDzd != null ? formatCurrency(ventilation.unallocatedDzd) : "—"}
                  note={ventilation.balanced ? "ventilation complète" : null}
                  ton={ventilation.balanced ? "succes" : undefined}
                />
              )}
            </BandeauArgent>

            {e.description && (
              <Repli titre="Description">
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{e.description}</p>
              </Repli>
            )}
          </div>
        }
      >
        {/* POSTES de l'événement : consulting, traiteur, location de salle… chacun validé à part par la Direction, avec son
            budget et son bon de commande — comme sur le sponsoring. Leur bandeau propre a rejoint celui de la carte. */}
        <IntertitrePostes n={items.length} />
        <AdProItemsPanel
          parent="EVENT"
          parentId={e.id}
          items={items}
          amountGranted={e.finalAmount != null ? toNumber(e.finalAmount) : null}
          decided={e.requestStatus ? ["APPROVED", "COMPLETED"].includes(e.requestStatus) : e.status !== "DRAFT" && e.status !== "CANCELLED"}
          canEdit={userCan(user, "EVENTS", "CREATE") || canManage || canAllocateItems}
          canAllocate={canAllocateItems}
          promoOptions={promoOptions}
          budgetOptions={budgetOptions}
          materiel={materielStock}
          canIssueOrder={userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE")}
          canViserBC={siegeAuCentreAdPro(user)}
          contexte={contexte}
          resume={false}
        />
      </CarteDetailsDemande>

      {/* LES PIÈCES LEGAL RATTACHÉES À LA DEMANDE ELLE-MÊME, hors postes — d'avant les postes, ou qui ne sont pas des achats. */}
      <PiecesLegalDeLaDemande spectateur={user} entityType="EVENT" entityId={e.id} />

      {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
      <MedecinsConcernes user={user} entityType="EVENT" entityId={e.id} />

      {e.stats.bySpecialty.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Répartition par spécialité</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {e.stats.bySpecialty.map((s) => <Badge key={s.name} tone="info" dot={false}>{s.name} · {s.count}</Badge>)}
          </CardContent>
        </Card>
      )}

      {/* LA SECTION DISCUSSION — le fil CANONIQUE de la demande et les échanges avec les personnes
          impliquées : un seul espace. */}
      <EspaceDiscussion>
        <AdProDiscussionCard entityType="EVENT" entityId={e.id} user={user} />
        <InvolvementConversations threads={involvementThreads} currentUserId={user.id} canManage={hasGlobalView(user)} />
      </EspaceDiscussion>

      {/* TOUT EN BAS, PLEINE LARGEUR (Direction, 07/10) : « Accompagnants & délégués » et « Traçabilité ». L'historique du
          circuit (qui a fait quoi, quand) vit dans « Traçabilité », et pour le Super Admin seulement. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <MissionAssignmentsCard
            entityType="EVENT"
            entityId={e.id}
            assignments={missions}
            users={responsibles}
            canManage={canManage}
            currentUserId={user.id}
            path={`/events/${e.id}`}
          />
        </div>
        <CarteTracabilite
          creeeLe={dates ? formatDateTime(dates.createdAt) : "—"}
          modifieeLe={dates ? formatDateTime(dates.updatedAt) : "—"}
          historique={user.role === "SUPER_ADMIN" && e.requestStatus && workflow && workflow.events.length > 0 ? <HistoriqueDuCircuit events={workflow.events} /> : null}
        />
      </div>
    </div>
  );
}
