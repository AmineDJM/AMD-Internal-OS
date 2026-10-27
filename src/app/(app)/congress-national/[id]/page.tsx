import { BlocHistorique } from "@/components/ad-pro/bloc-historique";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { getCongressDetail } from "@/lib/queries/congress";
import { getEntityMissions } from "@/lib/queries/missions";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { SupprimerDemandeAdPro } from "@/components/ad-pro/supprimer-demande";
import { peutSupprimerUneDemandeAdPro } from "@/lib/queries/ad-pro-suppression";
import { type DocItem } from "@/components/documents/document-list";
import { CONGRESS_REQUEST_STATUS } from "@/lib/labels";
import { CongressDetailView, AccompagnantsDeLaPriseEnCharge } from "../../congress-international/congress-detail-view";
import { CartePriseEnCharge } from "@/components/care/carte-prise-en-charge";
import { getInvolvementThreads } from "@/lib/queries/involvement";
import { toNumber } from "@/lib/utils";
import { promoMaterialOptions } from "@/lib/actions/ad-pro-item-actions";
import { AdProItemsPanel } from "@/components/ad-pro/items-panel";
import { PiecesLegalDeLaDemande } from "@/components/ad-pro/pieces-legal-demande";
import { loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes } from "@/lib/queries/ad-pro-items";
import { EspaceDiscussion } from "@/components/ad-pro/espace-discussion";
import { InvolvementConversations } from "@/components/ad-pro/involvement-conversations";
import { CarePanel } from "@/components/care/care-panel";
import { getCareDossier } from "@/lib/queries/care";
import { careDirectoryOptions, carePromoOptions } from "@/lib/actions/care-actions";
import { BoutonLivret } from "@/components/care/bouton-livret";
import { peutMarquerRealisee, peutTeleverserBillet, resumeDesFiches } from "@/lib/care-fiches";
import { envoiAuxFinances } from "@/lib/care-realisation";
import { AdProTransferButton } from "@/components/ad-pro/transfer-button";
import { AdProEditButton } from "@/components/ad-pro/edit-request-button";
import { canEditAdProRequest, isAdProDecided } from "@/lib/ad-pro-edit";
import { adProEditValues } from "@/lib/queries/ad-pro-edit";
import { BackLink } from "@/components/shared/back-link";
import { AdProDiscussionCard } from "@/components/ad-pro/discussion-card";
import { MedecinsConcernes } from "@/components/ad-pro/medecins-concernes";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande } from "@/lib/ad-pro/doc-categories";
import { canAttachToAdPro } from "@/lib/ad-pro/attachments";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";

// Une page qui dépend de QUI regarde ne se met jamais en cache : la même adresse rend autre chose pour le
// demandeur, pour la Direction et pour le Super Admin en Vue exacte (voir `lib/vue-exacte.ts`).
export const dynamic = "force-dynamic";

export default async function CongressNatDetailPage({ params }: { params: { id: string } }) {
  const user = await requireModule("CONGRESS_NATIONAL");
  const detail = await getCongressDetail("NATIONAL", user, params.id);
  if (!detail) notFound();

  // Impliquer une tierce personne : ouvert aux acteurs du circuit (le moteur pilote la validation).
  const canInvolveThirdParty = hasGlobalView(user) || hasRole(user, "NATIONAL_SALES") || detail.productManagerId === user.id;
  // QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE. La règle vit dans
  // `ad-pro/attachments.ts`, la MÊME sur les cinq écrans Ad&Pro : chacun l'épelait à sa façon, et
  // chaque orthographe oubliait quelqu'un — la Direction qui valide, la Direction Marketing qui
  // analyse — qui envoyait alors la facture par mail, dossier vide.
  const attacheur = {
    id: user.id,
    canUploadModule: userCan(user, "CONGRESS_NATIONAL", "UPLOAD"),
    canUpdateModule: userCan(user, "CONGRESS_NATIONAL", "UPDATE"),
    canValidateModule: userCan(user, "CONGRESS_NATIONAL", "VALIDATE"),
    hasGlobalView: hasGlobalView(user),
  };
  const dossierAdPro = { requesterId: detail.requesterId, productManagerId: detail.productManagerId };
  const canUpload = canAttachToAdPro(attacheur, dossierAdPro);
  const canDelete = userCan(user, "CONGRESS_NATIONAL", "DELETE") || hasGlobalView(user);
  const docs = await prisma.document.findMany({
    where: { entityType: "CONGRESS_NATIONAL", entityId: detail.id },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = docs.map((dc) => ({
    id: dc.id, name: dc.name, category: dc.category, version: dc.version, sizeBytes: dc.sizeBytes,
    confidentiality: dc.confidentiality, uploadedBy: dc.uploadedBy?.name ?? null, createdAt: dc.createdAt.toISOString(), hasFile: Boolean(dc.fileKey),
  }));

  const [missions, canManageMissions, missionUsers, workflow] = await Promise.all([
    getEntityMissions("CONGRESS_NATIONAL", detail.id),
    canAccessEntity(user, "CONGRESS_NATIONAL", detail.id, "UPDATE"),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getWorkflowForEntity(user, "CONGRESS_NATIONAL", detail.id, detail.requesterId),
  ]);

  // Postes de l'événement : de quoi est fait le montant, et à qui va l'argent. Le stand et le
  // symposium n'étaient jusqu'ici que des drapeaux — annoncés, jamais chiffrés.
  const congress = await prisma.congressNational.findUnique({
    where: { id: detail.id },
    select: { finalAmount: true, requestStatus: true, hasBooth: true, hasSymposium: true },
  });
  const [items, promoOptions, budgetOptions, contexte, involvementThreads] = await Promise.all([
    loadAdProItems("CONGRESS_NATIONAL", detail.id),
    promoMaterialOptions(),
    adProBudgetOptions(user),
    contextePostes(user, "CONGRESS_NATIONAL", detail.id),
    getInvolvementThreads("CONGRESS_NATIONAL", detail.id),
  ]);
  // L'enveloppe d'un congrès, c'est le montant accordé par la Direction à la décision définitive.
  const canAllocate = hasGlobalView(user) || userCan(user, "CONGRESS_NATIONAL", "VALIDATE");
  // LE MAGASIN où un poste « Matériel du stock » pioche, et qui confirme après l'événement (§118.167).
  const materielStock = await contexteMaterielStock(user, "CONGRESS_NATIONAL", detail.id, canAllocate);

  // Le dossier de prise en charge : les personnes, ce qu'il faut pour chacune, et les devis.
  const [care, directory, carePromo] = await Promise.all([getCareDossier("NATIONAL", detail.id), careDirectoryOptions(), carePromoOptions()]);
  const canEditCare = userCan(user, "CONGRESS_NATIONAL", "CREATE") || userCan(user, "CONGRESS_NATIONAL", "UPDATE") || canAllocate;
  // LES FICHES VOYAGEUR : l'estimé et les fiches prêtes, lus une fois pour le bandeau (`resumeDesFiches`).
  const fiches = resumeDesFiches("NATIONAL", care.beneficiaries, care.quotes, care.groupPostes);
  const peutTeleverser = peutTeleverserBillet(
    { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)), vueGlobale: hasGlobalView(user) },
    { requesterId: detail.requesterId },
  );

  // « Marquer réalisée » (Direction, 27/10) : après l'envoi aux Finances, le demandeur ou la Direction Marketing.
  const realisation = {
    envoyee: Boolean(await envoiAuxFinances("NATIONAL", detail.id)),
    realisee: detail.requestStatus === "COMPLETED",
    peutMarquer: peutMarquerRealisee(
      { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)) },
      { requesterId: detail.requesterId },
    ),
  };

  // Corriger la demande : le demandeur tant qu'elle n'est pas tranchée, la Direction toujours.
  const requestDecided = isAdProDecided("CONGRESS_NATIONAL", detail.requestStatus);
  const canEditRequest = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user), canManage: userCan(user, "CONGRESS_NATIONAL", "VALIDATE") },
    { requesterId: detail.requesterId, decided: requestDecided },
  );
  const editValues = canEditRequest ? await adProEditValues("CONGRESS_NATIONAL", detail.id) : null;

  return (
    <div className="space-y-5">
      <BackLink href="/congress-national">
        <ArrowLeft className="h-4 w-4" /> Prises en charge Nationales
      </BackLink>
      <PageHeader title={detail.name} description="Demande de prise en charge — événement national.">
        <StatusBadge map={CONGRESS_REQUEST_STATUS} value={detail.requestStatus} />
        {peutTeleverser && <BoutonLivret scope="NATIONAL" requestId={detail.id} libelle="Livret général" />}
        {canEditRequest && editValues && (
          <AdProEditButton kind="CONGRESS_NATIONAL" id={detail.id} decided={requestDecided} values={editValues} />
        )}
        {hasGlobalView(user) && <AdProTransferButton from="CONGRESS_NATIONAL" sourceId={detail.id} title={detail.name} />}
        <SupprimerDemandeAdPro kind="CONGRESS_NATIONAL" id={detail.id} name={detail.name} enabled={await peutSupprimerUneDemandeAdPro(user, "CONGRESS_NATIONAL", detail.id)} />
      </PageHeader>
      <BlocHistorique user={user} type="CONGRESS_NATIONAL" id={detail.id} />
      {/* LA PRISE EN CHARGE EN UNE CARTE (Direction, 07/10) — la même que l'international. */}
      <CartePriseEnCharge
        evenement={{ eventType: detail.eventType, location: detail.location, ville: detail.ville, pays: detail.pays, medecinsOrigine: detail.medecinsOrigine, date: detail.date, endDate: detail.endDate, requester: detail.requester, initiative: detail.initiative }}
        pieces={{
          entityType: "CONGRESS_NATIONAL", entityId: detail.id, documents: docItems,
          peutDeposer: canUpload, categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
          canDelete, canRename: canUpload, canEdit: onlyofficeConfigured() && canUpload,
          path: `/congress-national/${detail.id}`,
        }}
        beneficiaires={care.beneficiaries}
        devis={care.quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: q.amountDzd, cellIds: q.cellIds }))}
        postes={items.map((i) => ({ amountGranted: i.amountGranted, status: i.status }))}
        enveloppe={congress?.finalAmount != null ? toNumber(congress.finalAmount) : null}
        fiches={{ estime: fiches.estimations.total, pretes: fiches.pretes, vivantes: fiches.vivantes }}
        professionnels={
          <CarePanel
            scope="NATIONAL"
            requestId={detail.id}
            beneficiaries={care.beneficiaries}
            quotes={care.quotes}
            groupPostes={care.groupPostes}
            reglages={care.reglages}
            envois={care.envois}
            enveloppe={congress?.finalAmount != null ? toNumber(congress.finalAmount) : null}
            directory={directory}
            promoOptions={carePromo}
            eventApproved={["APPROVED", "COMPLETED"].includes(congress?.requestStatus ?? "")}
            canEdit={canEditCare}
            canDecide={canAllocate}
            peutTeleverser={peutTeleverser}
            realisation={realisation}
          />
        }
        couverture={
          <AdProItemsPanel
            parent="CONGRESS_NATIONAL"
            parentId={detail.id}
            items={items}
            amountGranted={congress?.finalAmount != null ? toNumber(congress.finalAmount) : null}
            decided={["APPROVED", "COMPLETED"].includes(congress?.requestStatus ?? "")}
            canEdit={userCan(user, "CONGRESS_NATIONAL", "CREATE") || userCan(user, "CONGRESS_NATIONAL", "UPDATE") || canAllocate}
            canAllocate={canAllocate}
            promoOptions={promoOptions}
            plan={{ hasBooth: congress?.hasBooth, hasSymposium: congress?.hasSymposium }}
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
      <PiecesLegalDeLaDemande spectateur={user} entityType="CONGRESS_NATIONAL" entityId={detail.id} />

      {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
      <MedecinsConcernes user={user} entityType="CONGRESS_NATIONAL" entityId={detail.id} />

      <CongressDetailView detail={detail} workflow={workflow} canInvolveThirdParty={canInvolveThirdParty} entityType="CONGRESS_NATIONAL" entityId={detail.id} missionUsers={missionUsers} />
      {/* LA SECTION DISCUSSION — le fil CANONIQUE de la demande et les échanges avec les personnes
          impliquées : un seul espace (la vue détaillée ne les rend plus à part). */}
      <EspaceDiscussion>
        <AdProDiscussionCard entityType="CONGRESS_NATIONAL" entityId={detail.id} user={user} />
        <InvolvementConversations threads={involvementThreads} currentUserId={user.id} canManage={hasGlobalView(user)} />
      </EspaceDiscussion>

      {/* EN BAS, PLEINE LARGEUR (Direction, 07/10). */}
      <AccompagnantsDeLaPriseEnCharge entityType="CONGRESS_NATIONAL" entityId={detail.id} missions={missions} missionUsers={missionUsers} canManageMissions={canManageMissions} currentUserId={user.id} path={`/congress-national/${detail.id}`} />

    </div>
  );
}
