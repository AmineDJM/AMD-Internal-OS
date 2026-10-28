import { BlocHistorique } from "@/modules/ad-pro/ecrans/bloc-historique";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { getCongressDetail, peutSupprimerUneDemandeAdPro, getCareDossier, envoiAuxFinances, adProEditValues, loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes } from "@/modules/ad-pro/api";
import { getEntityMissions } from "@/lib/queries/missions";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { SupprimerDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-demande";
import { type DocItem } from "@/components/documents/document-list";
import { CONGRESS_REQUEST_STATUS } from "@/lib/labels";
import { CongressDetailView, AccompagnantsDeLaPriseEnCharge } from "../congress-detail-view";
import { CartePriseEnCharge } from "@/modules/ad-pro/ecrans/prise-en-charge/carte-prise-en-charge";
import { getInvolvementThreads } from "@/lib/queries/involvement";
import { CarePanel } from "@/modules/ad-pro/ecrans/prise-en-charge/care-panel";
import { careDirectoryOptions, carePromoOptions } from "@/modules/ad-pro/actions-prise-en-charge-logistique";
import { BoutonLivret } from "@/modules/ad-pro/ecrans/prise-en-charge/bouton-livret";
import { peutMarquerRealisee, peutTeleverserBillet, resumeDesFiches, canEditAdProRequest, isAdProDecided, AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, canAttachToAdPro, siegeAuCentreAdPro } from "@/modules/ad-pro/partage";
import { AdProTransferButton } from "@/modules/ad-pro/ecrans/transfer-button";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";
import { BackLink } from "@/components/shared/back-link";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import { MedecinsConcernes } from "@/modules/ad-pro/ecrans/medecins-concernes";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";
import { PiecesLegalDeLaDemande } from "@/modules/ad-pro/ecrans/pieces-legal-demande";
import { EspaceDiscussion } from "@/modules/ad-pro/ecrans/espace-discussion";
import { InvolvementConversations } from "@/modules/ad-pro/ecrans/involvement-conversations";
import { promoMaterialOptions } from "@/modules/ad-pro/actions-postes";
import { toNumber } from "@/lib/utils";

// Une page qui dépend de QUI regarde ne se met jamais en cache : la même adresse rend autre chose pour le
// demandeur, pour la Direction et pour le Super Admin en Vue exacte (voir `lib/vue-exacte.ts`).
export const dynamic = "force-dynamic";

export default async function CongressIntlDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("CONGRESS_INTERNATIONAL");
  const detail = await getCongressDetail("INTL", user, params.id);
  if (!detail) notFound();

  // Impliquer une tierce personne : ouvert aux acteurs du circuit (National Sales,
  // référent Direction Marketing assigné, Direction) — le moteur pilote désormais la validation.
  const canInvolveThirdParty = hasGlobalView(user) || hasRole(user, "NATIONAL_SALES") || detail.productManagerId === user.id;
  // Le demandeur peut joindre des pièces à sa demande, même si son rôle n'a pas UPLOAD.
  // QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE. La règle vit dans
  // `ad-pro/attachments.ts`, la MÊME sur les cinq écrans Ad&Pro : chacun l'épelait à sa façon, et
  // chaque orthographe oubliait quelqu'un — la Direction qui valide, la Direction Marketing qui
  // analyse — qui envoyait alors la facture par mail, dossier vide.
  const attacheur = {
    id: user.id,
    canUploadModule: userCan(user, "CONGRESS_INTERNATIONAL", "UPLOAD"),
    canUpdateModule: userCan(user, "CONGRESS_INTERNATIONAL", "UPDATE"),
    canValidateModule: userCan(user, "CONGRESS_INTERNATIONAL", "VALIDATE"),
    hasGlobalView: hasGlobalView(user),
  };
  const dossierAdPro = { requesterId: detail.requesterId, productManagerId: detail.productManagerId };
  const canUpload = canAttachToAdPro(attacheur, dossierAdPro);
  const canDelete = userCan(user, "CONGRESS_INTERNATIONAL", "DELETE") || hasGlobalView(user);
  const docs = await prisma.document.findMany({
    where: { entityType: "CONGRESS_INTERNATIONAL", entityId: detail.id },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = docs.map((dc) => ({
    id: dc.id, name: dc.name, category: dc.category, version: dc.version, sizeBytes: dc.sizeBytes,
    confidentiality: dc.confidentiality, uploadedBy: dc.uploadedBy?.name ?? null, createdAt: dc.createdAt.toISOString(), hasFile: Boolean(dc.fileKey),
  }));

  const [missions, canManageMissions, missionUsers, workflow] = await Promise.all([
    getEntityMissions("CONGRESS_INTERNATIONAL", detail.id),
    canAccessEntity(user, "CONGRESS_INTERNATIONAL", detail.id, "UPDATE"),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getWorkflowForEntity(user, "CONGRESS_INTERNATIONAL", detail.id, detail.requesterId),
  ]);

  // Le dossier de prise en charge : les personnes, ce qu'il faut pour chacune, et les devis.
  const canDecideCare = hasGlobalView(user) || userCan(user, "CONGRESS_INTERNATIONAL", "VALIDATE");
  const canEditCare = userCan(user, "CONGRESS_INTERNATIONAL", "CREATE") || userCan(user, "CONGRESS_INTERNATIONAL", "UPDATE") || canDecideCare;
  const [care, directory, intl, carePromo] = await Promise.all([
    getCareDossier("INTERNATIONAL", detail.id),
    careDirectoryOptions(),
    prisma.congressInternational.findUnique({ where: { id: detail.id }, select: { requestStatus: true, finalAmount: true } }),
    carePromoOptions(),
  ]);
  // LES FICHES VOYAGEUR : l'estimé et les fiches prêtes, lus une fois pour le bandeau (`resumeDesFiches`).
  const fiches = resumeDesFiches("INTERNATIONAL", care.beneficiaries, care.quotes, care.groupPostes);
  const peutTeleverser = peutTeleverserBillet(
    { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)), vueGlobale: hasGlobalView(user) },
    { requesterId: detail.requesterId },
  );

  // « Marquer réalisée » (Direction, 27/10) : après l'envoi aux Finances, le demandeur ou la Direction Marketing.
  const realisation = {
    envoyee: Boolean(await envoiAuxFinances("INTERNATIONAL", detail.id)),
    realisee: detail.requestStatus === "COMPLETED",
    peutMarquer: peutMarquerRealisee(
      { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)) },
      { requesterId: detail.requesterId },
    ),
  };

  // Corriger la demande : le demandeur tant qu'elle n'est pas tranchée, la Direction toujours.
  const requestDecided = isAdProDecided("CONGRESS_INTERNATIONAL", detail.requestStatus);
  const canEditRequest = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user), canManage: userCan(user, "CONGRESS_INTERNATIONAL", "VALIDATE") },
    { requesterId: detail.requesterId, decided: requestDecided },
  );
  const editValues = canEditRequest ? await adProEditValues("CONGRESS_INTERNATIONAL", detail.id) : null;

  // POSTES de la prise en charge : consulting, traiteur, salle… chacun validé à part par la
  // Direction, avec son budget et son bon de commande. Même panneau que les autres opérations
  // Ad & Pro — la question « de quoi est fait ce montant » ne change pas d'un module à l'autre.
  const [items, promoOptions, budgetOptions, contexte, involvementThreads] = await Promise.all([
    loadAdProItems("CONGRESS_INTERNATIONAL", detail.id),
    promoMaterialOptions(),
    adProBudgetOptions(user),
    contextePostes(user, "CONGRESS_INTERNATIONAL", detail.id),
    getInvolvementThreads("CONGRESS_INTERNATIONAL", detail.id),
  ]);
  const canAllocateItems = hasGlobalView(user) || userCan(user, "CONGRESS_INTERNATIONAL", "VALIDATE");
  // LE MAGASIN où un poste « Matériel du stock » pioche, et qui confirme après l'événement (§118.167).
  const materielStock = await contexteMaterielStock(user, "CONGRESS_INTERNATIONAL", detail.id, canAllocateItems);

  return (
    <div className="space-y-5">
      <BackLink href="/congress-international">
        <ArrowLeft className="h-4 w-4" /> Prises en charge Internationales
      </BackLink>
      <PageHeader title={detail.name} description="Demande de prise en charge — congrès international.">
        <StatusBadge map={CONGRESS_REQUEST_STATUS} value={detail.requestStatus} />
        {peutTeleverser && <BoutonLivret scope="INTERNATIONAL" requestId={detail.id} libelle="Livret général" />}
        {canEditRequest && editValues && (
          <AdProEditButton kind="CONGRESS_INTERNATIONAL" id={detail.id} decided={requestDecided} values={editValues} />
        )}
        {hasGlobalView(user) && <AdProTransferButton from="CONGRESS_INTERNATIONAL" sourceId={detail.id} title={detail.name} />}
        <SupprimerDemandeAdPro kind="CONGRESS_INTERNATIONAL" id={detail.id} name={detail.name} enabled={await peutSupprimerUneDemandeAdPro(user, "CONGRESS_INTERNATIONAL", detail.id)} />
      </PageHeader>
      <BlocHistorique user={user} type="CONGRESS_INTERNATIONAL" id={detail.id} />
      {/* LA PRISE EN CHARGE EN UNE CARTE (Direction, 07/10) : l'événement et ses pièces jointes, un seul bandeau de chiffres,
          les professionnels, puis ce que couvre la prise en charge — trois rubriques qui se répétaient, fusionnées. */}
      <CartePriseEnCharge
        evenement={{ eventType: detail.eventType, location: detail.location, ville: detail.ville, pays: detail.pays, medecinsOrigine: detail.medecinsOrigine, date: detail.date, endDate: detail.endDate, requester: detail.requester, initiative: detail.initiative }}
        pieces={{ entityType: "CONGRESS_INTERNATIONAL", entityId: detail.id, documents: docItems, peutDeposer: canUpload, categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES), canDelete, canRename: canUpload, canEdit: onlyofficeConfigured() && canUpload, path: `/congress-international/${detail.id}` }}
        beneficiaires={care.beneficiaries}
        devis={care.quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: q.amountDzd, cellIds: q.cellIds }))}
        postes={items.map((i) => ({ amountGranted: i.amountGranted, status: i.status }))}
        enveloppe={intl?.finalAmount != null ? toNumber(intl.finalAmount) : null}
        fiches={{ estime: fiches.estimations.total, pretes: fiches.pretes, vivantes: fiches.vivantes }}
        professionnels={
          <CarePanel
            scope="INTERNATIONAL"
            requestId={detail.id}
            beneficiaries={care.beneficiaries}
            quotes={care.quotes}
            groupPostes={care.groupPostes}
            reglages={care.reglages}
            envois={care.envois}
            enveloppe={intl?.finalAmount != null ? toNumber(intl.finalAmount) : null}
            directory={directory}
            promoOptions={carePromo}
            eventApproved={["APPROVED", "COMPLETED"].includes(intl?.requestStatus ?? "")}
            canEdit={canEditCare}
            canDecide={canDecideCare}
            peutTeleverser={peutTeleverser}
            budgetOptions={budgetOptions}
            realisation={realisation}
          />
        }
        couverture={
          <AdProItemsPanel
            parent="CONGRESS_INTERNATIONAL"
            parentId={detail.id}
            items={items}
            amountGranted={intl?.finalAmount != null ? toNumber(intl.finalAmount) : null}
            decided={["APPROVED", "COMPLETED"].includes(intl?.requestStatus ?? "")}
            canEdit={userCan(user, "CONGRESS_INTERNATIONAL", "CREATE") || userCan(user, "CONGRESS_INTERNATIONAL", "UPDATE") || canAllocateItems}
            canAllocate={canAllocateItems}
            promoOptions={promoOptions}
            budgetOptions={budgetOptions}
            materiel={materielStock}
            canIssueOrder={userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE")}
            canViserBC={siegeAuCentreAdPro(user)}
            contexte={contexte}
            resume={false}
          />
        }
      />

      {/* LES PIÈCES LEGAL RATTACHÉES À LA DEMANDE ELLE-MÊME, hors postes — d'avant les postes, ou qui ne sont pas des achats. */}
      <PiecesLegalDeLaDemande spectateur={user} entityType="CONGRESS_INTERNATIONAL" entityId={detail.id} />

      {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
      <MedecinsConcernes user={user} entityType="CONGRESS_INTERNATIONAL" entityId={detail.id} />

      <CongressDetailView detail={detail} workflow={workflow} canInvolveThirdParty={canInvolveThirdParty} entityType="CONGRESS_INTERNATIONAL" entityId={detail.id} missionUsers={missionUsers} />
      {/* LA SECTION DISCUSSION — le fil CANONIQUE de la demande et les échanges avec les personnes
          impliquées : un seul espace (la vue détaillée ne les rend plus à part). */}
      <EspaceDiscussion>
        <AdProDiscussionCard entityType="CONGRESS_INTERNATIONAL" entityId={detail.id} user={user} />
        <InvolvementConversations threads={involvementThreads} currentUserId={user.id} canManage={hasGlobalView(user)} />
      </EspaceDiscussion>

      {/* EN BAS, PLEINE LARGEUR (Direction, 07/10). */}
      <AccompagnantsDeLaPriseEnCharge entityType="CONGRESS_INTERNATIONAL" entityId={detail.id} missions={missions} missionUsers={missionUsers} canManageMissions={canManageMissions} currentUserId={user.id} path={`/congress-international/${detail.id}`} />

    </div>
  );
}
