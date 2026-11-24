import { BlocHistorique } from "@/modules/ad-pro/ecrans/bloc-historique";
import { demandeurAfficheDe } from "@/lib/budget-marketing/integration-serveur";
import { notFound } from "next/navigation";
import { ArrowLeft, Gavel } from "lucide-react";
import { userCan, hasGlobalView, hasRole, peutUtiliserAssistantIA, scopeSponsoring } from "@/lib/rbac";
import { SuggestionsDossier } from "@/modules/assistant-ia/ecrans/suggestions-dossier";
import { canAccessEntity } from "@/lib/entity-access";
import { getEntityMissions } from "@/lib/queries/missions";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { MissionAssignmentsCard } from "@/components/missions/mission-assignments-card";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader } from "@/components/shared/page-header";
import { MenuDossier } from "@/components/shared/menu-dossier";
import type { DocItem } from "@/components/documents/document-list";
import { AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, canAttachToAdPro, attachHint, breakdown, canEditAdProRequest, isAdProDecided, siegeAuCentreAdPro, bilanCloture, etatPostesSponsoring, peutCloturer, quiCloture as quiClotureDe, LIBELLE_QUI_CLOTURE } from "@/modules/ad-pro/partage";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { SPONSORING_STATUS, SPONSORING_NATURE, PRIORITY } from "@/lib/labels";
import { WorkflowPanel, WithdrawForm, HistoriqueDuCircuit, type EtapeDeFrise, type StatutDeLaDemande } from "@/components/workflow/workflow-panel";
import { AppealPanel } from "./decision-panel";
import { ThirdPartyButton } from "./third-party-button";
import { InvolvementConversations } from "@/modules/ad-pro/ecrans/involvement-conversations";
import { getInvolvementThreads } from "@/lib/queries/involvement";
import { SupprimerDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-demande";
import { peutSupprimerUneDemandeAdPro, loadAdProItems, adProBudgetOptions, contexteMaterielStock, postesPourCloture, contextePostes, adProEditValues, requireModuleOuAgences } from "@/modules/ad-pro/api";
import { promoMaterialOptions } from "@/modules/ad-pro/actions-postes";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";
import { PiecesLegalDeLaDemande } from "@/modules/ad-pro/ecrans/pieces-legal-demande";
import { CarteDetailsDemande } from "@/modules/ad-pro/ecrans/pieces-jointes-demande";
import { Faits, Fait, BandeauArgent, Chiffre, IntertitrePostes, CarteTracabilite } from "@/modules/ad-pro/ecrans/carte-demande";
import { SectionRepliable, Sections } from "@/components/shared/section-repliable";
import { resumeDuCircuit } from "@/lib/workflow/resume-circuit";
import { EspaceDiscussion } from "@/modules/ad-pro/ecrans/espace-discussion";
import { AdProTransferButton } from "@/modules/ad-pro/ecrans/transfer-button";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";
import { BackLink } from "@/components/shared/back-link";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import { MedecinsConcernesSection } from "@/modules/ad-pro/ecrans/medecins-concernes";
import { porteLeRoleQuiTranche } from "@/lib/personnes/referents-gamme";
import { etapeDeclaration } from "@/lib/medical-info/etape-ad-pro";
import { EtapeDeclarationAdPro } from "../../information-medicale/etape-declaration-ad-pro";
import { ClosurePanel } from "./closure-panel";


// Une page qui dépend de QUI regarde ne se met jamais en cache : la même adresse rend autre chose pour le
// demandeur, pour la Direction et pour le Super Admin en Vue exacte (voir `lib/vue-exacte.ts`).
export const dynamic = "force-dynamic";

export default async function SponsoringDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModuleOuAgences("SPONSORING");
  // LA PORTÉE PAR LIGNE (§118.185, I4) : un délégué n'ouvre que SES demandes — la même phrase
  // qu'une demande inexistante, pour ne pas confirmer qu'un identifiant deviné existe.
  const req = await prisma.sponsoringRequest.findFirst({
    where: { AND: [{ id: params.id }, scopeSponsoring(user)] },
    include: { requester: { select: { name: true } } },
  });
  if (!req) notFound();

  // Rôles dans le circuit
  const canDirection = hasGlobalView(user) || userCan(user, "SPONSORING", "VALIDATE");
  // Étape préliminaire (attribuer la Direction Marketing) : réservée au National Sales
  // (la demande émane d'un délégué). Ni la Direction ni la Direction Marketing n'y interviennent.
  const canPreliminary = hasRole(user, "NATIONAL_SALES") || user.role === "SUPER_ADMIN";
  const isProductManager = req.productManagerId === user.id;
  const isRequester = req.requesterId === user.id;

  const [pmUser, documents] = await Promise.all([
    req.productManagerId ? prisma.user.findUnique({ where: { id: req.productManagerId }, select: { name: true } }) : Promise.resolve(null),
    prisma.document.findMany({ where: { entityType: "SPONSORING", entityId: req.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
  ]);

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  // QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE. La règle vit dans
  // `ad-pro/attachments.ts` et elle est la MÊME sur les cinq écrans Ad&Pro : chacun l'épelait à
  // sa façon, et chaque orthographe oubliait quelqu'un — la Direction qui valide, le chef de
  // produit qui analyse — qui envoyait alors la facture par mail, dossier vide.
  const attacheur = {
    id: user.id,
    canUploadModule: userCan(user, "SPONSORING", "UPLOAD"),
    canUpdateModule: userCan(user, "SPONSORING", "UPDATE"),
    canValidateModule: userCan(user, "SPONSORING", "VALIDATE"),
    hasGlobalView: hasGlobalView(user),
  };
  const dossierAdPro = { requesterId: req.requesterId, productManagerId: req.productManagerId };
  const canUpload = canAttachToAdPro(attacheur, dossierAdPro);
  const uploadHint = attachHint(attacheur, dossierAdPro);
  const canDelete = userCan(user, "SPONSORING", "DELETE");

  // Postes du sponsoring : de quoi est fait le montant, à qui va l'argent, et où en est chacun
  // dans son propre circuit de validation (chargement mutualisé — voir queries/ad-pro-items).
  const [items, promoOptions, budgetOptions, contexte] = await Promise.all([
    loadAdProItems("SPONSORING", req.id),
    promoMaterialOptions(),
    adProBudgetOptions(user),
    contextePostes(user, "SPONSORING", req.id),
  ]);
  // DÉCIDÉE, TARDIVE, CLÔTURÉE — la MÊME lecture que les actions sur les postes (§118.151). La page
  // portait sa propre liste, sans la tenue pré-validée : « Émettre l'ordre » disparaissait sur
  // chaque poste d'un sponsoring pré-validé pendant que l'action l'aurait accepté (§118.5).
  const etatPostes = etatPostesSponsoring(req.status, req.closedAt);
  const decided = etatPostes.decide;

  // LA VALIDATION FINALE : le bilan que l'action relira au clic, et qui la tient — lu sur le
  // parcours GELÉ de l'instance (la borne dit si la Direction a tranché à la place de la
  // Direction Marketing, quand la demande venait d'elle).
  const [instanceBorne, closer] = await Promise.all([
    prisma.workflowInstance.findUnique({
      where: { entityType_entityId: { entityType: "SPONSORING", entityId: req.id } },
      select: { finalSlug: true },
    }),
    req.closedById ? prisma.user.findUnique({ where: { id: req.closedById }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const qui = quiClotureDe(instanceBorne?.finalSlug ?? null);
  // LE BILAN se juge sur les postes tels que la CLÔTURE les lit — nature et matériel réservé compris
  // (§118.167) : la MÊME lecture que l'action et que l'op d'Adam.
  const bilan = bilanCloture(req.status, await postesPourCloture(req.id));
  // LE MAGASIN où un poste « Matériel du stock » pioche, et qui confirme après l'événement (§118.167).
  const materielStock = await contexteMaterielStock(user, "SPONSORING", req.id, canDirection);
  const peutAgirSurLaCloture = peutCloturer({
    estSuperAdmin: user.role === "SUPER_ADMIN",
    porteLeRoleQuiTranche: porteLeRoleQuiTranche(user),
    aLaVueGlobale: hasGlobalView(user),
    estLeDemandeur: req.requesterId === user.id,
  }, qui);

  const [missions, canManageMissions, missionUsers, workflow, involvementThreads] = await Promise.all([
    getEntityMissions("SPONSORING", req.id),
    canAccessEntity(user, "SPONSORING", req.id, "UPDATE"),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getWorkflowForEntity(user, "SPONSORING", req.id, req.requesterId),
    getInvolvementThreads("SPONSORING", req.id),
  ]);

  // L'appel du délégué reste une action propre au sponsoring (après décision).
  const canAppeal = isRequester && ["APPROVED", "REFUSED"].includes(req.status);
  // L'ÉTAPE QUI TRANCHE cette demande — la dernière de SA route (la vue retire déjà les étapes hors
  // parcours) : c'est elle que l'appel rouvre (§118.186, R04), et la phrase doit la nommer.
  const etapeQuiTranche = workflow?.steps[workflow.steps.length - 1]?.title ?? null;
  const fmt = (v: unknown) => (v ? formatCurrency(toNumber(v as never)) : null);

  // Corriger la demande : le demandeur tant qu'elle n'est pas tranchée, la Direction toujours.
  const sponsoringDecided = isAdProDecided("SPONSORING", req.status);
  const canEditRequest = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user), canManage: userCan(user, "SPONSORING", "VALIDATE") },
    { requesterId: req.requesterId, decided: sponsoringDecided },
  );
  const editValues = canEditRequest ? await adProEditValues("SPONSORING", req.id) : null;

  // ── « ⋯ » : LES GESTES SECONDAIRES (Direction, 07/10) — les mêmes boutons, les mêmes droits, rangés. ──
  const peutSupprimer = await peutSupprimerUneDemandeAdPro(user, "SPONSORING", req.id);
  const peutImpliquer = canPreliminary || canDirection || isProductManager || isRequester;
  const peutTransferer = hasGlobalView(user);
  const peutRetirer = Boolean(workflow?.peutRetirer);
  const menu = Boolean(canEditRequest && editValues) || peutImpliquer || peutTransferer || peutSupprimer || peutRetirer;

  // ── LA SUITE DU CIRCUIT, SOUS LA RÈGLE DE LA TENUE (§118.151) : le circuit pré-valide la tenue ; viennent ensuite les
  // postes (devis, BC, factures), puis la validation finale qui range chaque poste dans un budget et clôture. Un ancien
  // accord à montant global (APPROVED / ACCEPTED / PAID), un refus ou un transfert n'ont pas cette suite. ──
  const regleDeLaTenue = !["APPROVED", "ACCEPTED", "PAID", "REFUSED"].includes(req.status) && !(req.status === "CLOSED" && !req.closedAt);
  const enPostes = req.status === "PRE_VALIDATED";
  const quiCourt = qui === "DIRECTION" ? "la Direction" : "la Direction Marketing";
  const suite: EtapeDeFrise[] = regleDeLaTenue ? [
    {
      cle: "__postes__", titre: "Postes", detail: "devis, BC, factures",
      etat: etatPostes.closParLaCloture || (enPostes && bilan.cloturable) ? "done" : enPostes ? "current" : "todo",
    },
    {
      cle: "__validation_finale__", titre: "Validation finale",
      detail: etatPostes.closParLaCloture
        ? [req.closedAt ? formatDate(req.closedAt, { day: "numeric", month: "short" }) : null, closer?.name ?? null].filter(Boolean).join(" · ")
        : quiCourt.replace(/^la /, ""),
      etat: etatPostes.closParLaCloture ? "done" : enPostes && bilan.cloturable ? "current" : "todo",
    },
  ] : [];
  // LA DERNIÈRE ÉTAPE : la déclaration de l'événement (information scientifique) — après la pré-validation, ou après la
  // validation finale quand il y en a une (Direction, 08/11/2026). Elle ne bloque rien ; elle se lit, et le pharmacien y agit.
  const declaration = await etapeDeclaration(
    user, "SPONSORING", req.id,
    workflow?.status === "APPROVED" || (isAdProDecided("SPONSORING", req.status) && req.status !== "REFUSED"),
  );
  if (declaration) suite.push({ cle: "__declaration__", titre: declaration.titre, detail: declaration.detail, etat: declaration.etat });

  const statutDemande: StatutDeLaDemande | null =
    etatPostes.closParLaCloture
      ? { phrase: `Validée et clôturée${req.closedAt ? ` le ${formatDate(req.closedAt)}` : ""}${closer?.name ? `, par ${closer.name}` : ""}`, ton: "succes" }
      : enPostes
        ? bilan.cloturable
          ? { phrase: `Validation finale — ${peutAgirSurLaCloture ? "à vous d'agir" : `chez ${quiCourt}`}`, ton: "info" }
          // LES POSTES SE PRÉPARENT CHEZ LA DIRECTION MARKETING (recette sponsoring, 23/11/2026) : « chez <demandeur> » envoyait
          // un délégué devant une demande où il n'a aucun geste (répartir, ajouter, soumettre sont à qui tranche les postes).
          : { phrase: `Postes en préparation — chez ${quiCourt}`, ensuite: `validation finale (${quiCourt.replace(/^la /, "")})`, ton: "info" }
        : req.status === "CLOSED" && !req.closedAt
          ? { phrase: "Transférée vers un autre module", ton: "neutre" }
          : null;

  // LES GESTES PROPRES AU SPONSORING, rangés avec ceux de l'étape : la validation finale (et la réouverture), l'appel.
  const gestes = (
    <>
      {(req.status !== "CLOSED" || etatPostes.closParLaCloture) && (
        <ClosurePanel
          id={req.id}
          statut={req.status}
          bilan={bilan}
          peutAgir={peutAgirSurLaCloture}
          quiCloture={LIBELLE_QUI_CLOTURE[qui]}
          cloture={etatPostes.closParLaCloture && req.closedAt
            ? {
                le: formatDateTime(req.closedAt),
                par: closer?.name ?? null,
                note: req.closingNote,
                montant: req.amountGranted != null ? toNumber(req.amountGranted) : null,
              }
            : null}
        />
      )}
      {canAppeal && <AppealPanel id={req.id} etape={etapeQuiTranche} />}
    </>
  );

  // L'ARGENT, EN UN BANDEAU (Direction, 07/10) : demandé, suggéré, affecté aux postes, accordé.
  const ventilation = breakdown(items, req.amountGranted != null ? toNumber(req.amountGranted) : null);
  const accorde = fmt(req.amountGranted);
  const medecin = [req.doctor, req.specialty].filter(Boolean).join(" · ");
  // CE QUE LES SECTIONS DISENT FERMÉES (17/11/2026).
  const aVousCircuit = Boolean(workflow?.action) || (peutAgirSurLaCloture && enPostes && bilan.cloturable) || canAppeal;
  // LE DÉLÉGUÉ MÉDICAL SUIT SANS LES MONTANTS DES POSTES (15/11/2026 ; recette du 21/11) : il garde ce qu'il a demandé et
  // suggéré, pas ce qui est affecté ni accordé.
  const suiviSimple = contexte.suiviSimple;
  const resumeMontants = [
    fmt(req.amountRequested) ? `demandé ${fmt(req.amountRequested)}` : null,
    suiviSimple ? null : `affecté ${formatCurrency(ventilation.totalRequestedDzd)}`,
    !suiviSimple && accorde ? `accordé ${accorde}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="space-y-5">
      <BackLink href="/sponsoring">
        <ArrowLeft className="h-4 w-4" /> Retour au sponsoring
      </BackLink>
      {/* J12 : à l'ouverture du dossier, ce que les veilleurs de l'Assistant IA ont constaté ici. */}
      {!user.impersonatedBy && peutUtiliserAssistantIA(user) && <SuggestionsDossier entiteType="SPONSORING" entiteId={req.id} />}

      <PageHeader
        title={req.institution}
        description={`${req.reference} · demandé par ${req.requester?.name ?? (await demandeurAfficheDe("SPONSORING", req.id)) ?? "—"} le ${formatDate(req.requestDate)}`}
      >
        <StatusBadge map={SPONSORING_STATUS} value={req.status} />
        {req.appealCount > 0 && (
          <Badge
            tone="purple" dot={false}
            title={`Réexamen par l'étape qui a tranché${etapeQuiTranche ? ` (« ${etapeQuiTranche} »)` : ""}`}
          >
            <Gavel className="mr-1 h-3 w-3" /> Appel ×{req.appealCount}
          </Badge>
        )}
        {menu && (
          <MenuDossier>
            {canEditRequest && editValues && (
              <AdProEditButton kind="SPONSORING" id={req.id} decided={sponsoringDecided} values={editValues} />
            )}
            {peutImpliquer && <ThirdPartyButton id={req.id} people={missionUsers} />}
            {peutTransferer && <AdProTransferButton from="SPONSORING" sourceId={req.id} title={req.institution} />}
            {peutRetirer && <WithdrawForm entityType="SPONSORING" entityId={req.id} dansUnMenu />}
            <SupprimerDemandeAdPro kind="SPONSORING" id={req.id} name={`${req.reference} — ${req.institution}`} enabled={peutSupprimer} />
          </MenuDossier>
        )}
      </PageHeader>

      <BlocHistorique user={user} type="SPONSORING" id={req.id} />

      {/* LA DEMANDE, EN UNE CARTE (Direction, 07/10) — « Détails de la demande », « Postes de la demande » et « Circuit de
          validation » fusionnés : la frise et la phrase de statut (avec les gestes de l'étape courante), les faits une fois,
          l'argent en un bandeau, la description et les pièces jointes repliées, puis les postes. « + Pièce jointe » en
          haut à droite ; la chaîne d'achat (devis → BC → facture) vit sur chaque poste. */}
      <CarteDetailsDemande
        titre="La demande"
        piecesRepliees
        contentClassName="space-y-3"
        pieces={{
          entityType: "SPONSORING", entityId: req.id, documents: docItems,
          peutDeposer: canUpload, motif: canUpload ? null : (uploadHint ?? null),
          categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
          canDelete, canRename: canUpload, canEdit: onlyofficeConfigured() && canUpload,
          path: `/sponsoring/${req.id}`,
        }}
        entete={
          // LA DEMANDE EN SECTIONS (17/11/2026) : fermées sur une ligne qui dit l'essentiel ; ouvertes d'office quand la
          // personne qui regarde y a un geste à faire (« À vous »).
          <div>
            <SectionRepliable titre="Circuit de validation" resume={statutDemande?.phrase ?? resumeDuCircuit(workflow)} aVous={aVousCircuit}>
              {workflow ? (
                <WorkflowPanel entityType="SPONSORING" entityId={req.id} view={workflow} compact suite={suite} statut={statutDemande} gestes={gestes} />
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">Circuit indisponible.</p>
                  {gestes}
                </div>
              )}
            </SectionRepliable>
            <SectionRepliable titre="Le sponsoring" resume={[req.type, req.city, medecin].filter(Boolean).join(" · ")}>
              <div className="space-y-3">
                <Faits>
                  <Fait label="Type" valeur={req.type} />
                  <Fait label="Ville" valeur={req.city} />
                  <Fait label="Produit" valeur={req.product} />
                  <Fait label="Nature" valeur={req.nature ? SPONSORING_NATURE[req.nature] : null} />
                  <Fait label="Médecin" valeur={medecin} />
                  <Fait label="Importance" valeur={PRIORITY[req.strategicImportance]?.label ?? req.strategicImportance} />
                  <Fait label="Référent Direction Marketing" valeur={pmUser?.name} />
                  {req.validatedBy && <Fait label="Validé par" valeur={req.validatedBy} />}
                </Faits>
                {(req.description || req.comments) && (
                  <div className="max-w-prose space-y-2 text-sm">
                    {req.description && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{req.description}</p>}
                    {req.comments && (
                      <p className="whitespace-pre-line [overflow-wrap:anywhere]"><span className="font-medium">Appréciation du délégué : </span>{req.comments}</p>
                    )}
                  </div>
                )}
              </div>
            </SectionRepliable>
            <SectionRepliable titre="Montants" resume={resumeMontants}>
              <BandeauArgent>
                <Chiffre label="Demandé (médecin)" valeur={fmt(req.amountRequested) ?? "—"} />
                <Chiffre label="Suggéré (délégué)" valeur={fmt(req.amountProposed) ?? "—"} />
                {!suiviSimple && (<>
                <Chiffre
                  label="Affecté aux postes"
                  valeur={formatCurrency(ventilation.totalRequestedDzd)}
                  note={ventilation.additionalDzd > 0
                    ? `dont ${formatCurrency(ventilation.additionalDzd)} en rallonge`
                    : `${ventilation.itemCount} poste${ventilation.itemCount > 1 ? "s" : ""}`}
                  ton={ventilation.additionalDzd > 0 ? "attente" : undefined}
                />
                <Chiffre
                  label={etatPostes.closParLaCloture ? "Accordé (clôture)" : "Accordé"}
                  valeur={accorde ?? (regleDeLaTenue ? "À la validation finale" : "—")}
                  discret={!accorde}
                />
                </>)}
              </BandeauArgent>
            </SectionRepliable>
          </div>
        }
      >
        {/* LES POSTES DE LA DEMANDE — « dans les postes on voit tous les postes relatifs à cette demande » (§118.151). Le
            premier est le sponsoring lui-même, né à la pré-validation de la tenue, en attente de la Direction Marketing (direct :
            versé à l'association ; indirect : prise en charge — recette 24/11/2026) ; les autres s'ajoutent ensuite. Avant la
            pré-validation, la liste est vide. Leur bandeau propre a rejoint celui de la carte. */}
        <IntertitrePostes n={items.length} />
        <AdProItemsPanel
          parent="SPONSORING"
          parentId={req.id}
          items={items}
          amountGranted={req.amountGranted != null ? toNumber(req.amountGranted) : null}
          decided={decided}
          tardif={etatPostes.tardif}
          fige={etatPostes.clos}
          canEdit={userCan(user, "SPONSORING", "CREATE") || userCan(user, "SPONSORING", "UPDATE") || canDirection}
          canAllocate={canDirection}
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
      <PiecesLegalDeLaDemande spectateur={user} entityType="SPONSORING" entityId={req.id} />

      {/* LE RESTE DE LA FICHE, REPLIÉ (17/11/2026) : médecins concernés, discussion, accompagnants, information médicale,
          traçabilité — une ligne chacun (recette 24/11/2026 : les médecins rejoignent les sections ; l'information médicale
          vient en dernier, juste avant la traçabilité). */}
      <Sections>
        {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
        <MedecinsConcernesSection user={user} entityType="SPONSORING" entityId={req.id} />
        <SectionRepliable titre="Discussion" sansCadre>
          <EspaceDiscussion>
            <AdProDiscussionCard entityType="SPONSORING" entityId={req.id} user={user} />
            <InvolvementConversations threads={involvementThreads} currentUserId={user.id} canManage={hasGlobalView(user)} />
          </EspaceDiscussion>
        </SectionRepliable>
        <SectionRepliable titre="Accompagnants & délégués" compte={missions.length} sansCadre>
          <MissionAssignmentsCard
            entityType="SPONSORING"
            entityId={req.id}
            assignments={missions}
            users={missionUsers}
            canManage={canManageMissions}
            currentUserId={user.id}
            path={`/sponsoring/${req.id}`}
          />
        </SectionRepliable>
        {declaration && (
          <SectionRepliable titre={declaration.titre} resume={declaration.detail ?? undefined} aVous={declaration.aVous}>
            <EtapeDeclarationAdPro etape={declaration} sourceType="SPONSORING" sourceId={req.id} />
          </SectionRepliable>
        )}
        <SectionRepliable titre="Traçabilité" resume={`créée le ${formatDateTime(req.createdAt)}`} sansCadre>
          <CarteTracabilite
            creeeLe={formatDateTime(req.createdAt)}
            modifieeLe={formatDateTime(req.updatedAt)}
            historique={user.role === "SUPER_ADMIN" && workflow && workflow.events.length > 0 ? <HistoriqueDuCircuit events={workflow.events} /> : null}
          />
        </SectionRepliable>
      </Sections>
    </div>
  );
}
