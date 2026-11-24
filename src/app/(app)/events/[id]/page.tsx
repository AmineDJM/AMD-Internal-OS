import { BlocHistorique } from "@/modules/ad-pro/ecrans/bloc-historique";
import { notFound } from "next/navigation";
import { ArrowLeft, Video } from "lucide-react";
import { userCan, hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { porteeModificationEvenement, canEditAdProRequest, isAdProDecided, breakdown, AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, canAttachToAdPro, attachHint, barreDesEtapes, refusSuppressionDefinitive } from "@/modules/ad-pro/partage";
import { prisma } from "@/lib/prisma";
import { getEventDetail, peutSupprimerUneDemandeAdPro, adProEditValues, loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes, getAdProCreateData, requireModuleOuAgences } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { EVENT_TYPE, EVENT_SCOPE, EVENT_FORMAT, EVENT_STATUS, ROLE_LABELS } from "@/lib/labels";
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
import { SupprimerDefinitivementDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-definitivement";
import { BackLink } from "@/components/shared/back-link";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";
import { PiecesLegalDeLaDemande } from "@/modules/ad-pro/ecrans/pieces-legal-demande";
import { Faits, Fait, BandeauArgent, Chiffre, SectionTracabilite } from "@/modules/ad-pro/ecrans/carte-demande";
import { BarreEtapes, CarteAVous, CarteLaDemande, CartePostes, PlusDInformations, SectionDeclaration, SectionPieces, ligneDeLaDemande, type GesteAVous } from "@/modules/ad-pro/ecrans/fiche";
import { droitsDesPostes, gesteDeLaDeclaration, gestesDesPostes } from "@/modules/ad-pro/ecrans/fiche-gestes";
import { circuitPourLaBarre } from "@/lib/workflow/frise-circuit";
import { resumeDuCircuit } from "@/lib/workflow/resume-circuit";
import { SectionRepliable } from "@/components/shared/section-repliable";
import { EspaceDiscussion } from "@/modules/ad-pro/ecrans/espace-discussion";
import { promoMaterialOptions } from "@/modules/ad-pro/actions-postes";
import { toNumber } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import type { DocItem } from "@/components/documents/document-list";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import { etapeDeclaration } from "@/lib/medical-info/etape-ad-pro";
import { EtapeDeclarationAdPro } from "../../information-medicale/etape-declaration-ad-pro";
import { MedecinsConcernesSection } from "@/modules/ad-pro/ecrans/medecins-concernes";

export const dynamic = "force-dynamic";

export default async function EventDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModuleOuAgences("EVENTS");
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
  // LA DERNIÈRE ÉTAPE : la déclaration de l'événement (information scientifique, 08/11/2026) — seulement pour un
  // événement entré dans le circuit de prise en charge.
  const declaration = e.requestStatus ? await etapeDeclaration(user, "EVENT", e.id, workflow?.status === "APPROVED") : null;
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

  // LES RÉSUMÉS DES SECTIONS (Direction, 17/11/2026 — « l'information reste, mais repliée ») : ce qu'on lit sans ouvrir.
  const lieuTexte = [e.location, e.city, e.country].filter(Boolean).join(", ");
  // LE DÉLÉGUÉ MÉDICAL SUIT SANS LES MONTANTS (15/11/2026 ; recette du 21/11) : « affecté 2 064 770 DZD » disait la somme des
  // postes accordés que ses cartes lui cachent. Il garde le budget qu'il a lui-même estimé.
  const suiviSimple = contexte.suiviSimple;
  const resumeBudget = suiviSimple
    ? (e.estimatedBudget !== null ? `Estimé ${formatCurrency(e.estimatedBudget)}` : "")
    : [
    e.finalAmount != null ? `Enveloppe ${formatCurrency(e.finalAmount)}` : e.estimatedBudget !== null ? `Estimé ${formatCurrency(e.estimatedBudget)}` : null,
    `affecté ${formatCurrency(ventilation.totalRequestedDzd)}`,
    ventilation.overrunDzd > 0 ? `dépassement ${formatCurrency(ventilation.overrunDzd)}` : ventilation.envelopeDzd != null ? `reste ${formatCurrency(ventilation.unallocatedDzd)}` : null,
  ].filter(Boolean).join(" · ");

  // ── LA FICHE SIMPLIFIÉE (maquette « Fiche Ad & Pro » validée, 24/11/2026) : la barre d'étapes, la carte « À vous », la
  // demande, le tableau des postes, puis « Plus d'informations ». Mêmes données, mêmes composants, mêmes gestes. ──
  const postesDecides = e.requestStatus ? ["APPROVED", "COMPLETED"].includes(e.requestStatus) : e.status !== "DRAFT" && e.status !== "CANCELLED";
  const droitsPostes = droitsDesPostes(user, {
    canEdit: userCan(user, "EVENTS", "CREATE") || canManage || canAllocateItems,
    canAllocate: canAllocateItems, decided: postesDecides, contexte,
  });
  const postes = gestesDesPostes(items, droitsPostes);
  const panneauDeclaration = declaration ? <EtapeDeclarationAdPro etape={declaration} sourceType="EVENT" sourceId={e.id} /> : null;
  const suiteDeclaration = declaration ? [{ cle: "__declaration__", titre: declaration.titre, detail: declaration.detail, etat: declaration.etat }] : [];
  const barre = barreDesEtapes({
    nature: "EVENT",
    circuit: e.requestStatus ? circuitPourLaBarre(workflow) : null,
    deposee: { detail: creeeLe ? formatDate(creeeLe, { day: "numeric", month: "short" }) : null, aSoumettre: !e.requestStatus, aVous: canSubmit },
    postes: { ouverts: postesDecides && e.requestStatus !== "COMPLETED", termines: e.requestStatus === "COMPLETED", aVous: postes.posteAVous, n: items.length },
    validationFinale: null,
    declaration: declaration ? { etat: declaration.etat, detail: declaration.detail, aVous: declaration.aVous } : null,
  });
  // LE CIRCUIT DE PRISE EN CHARGE : soumettre ; décider l'étape, resoumettre, faire appel ; relancer après un refus.
  const relancable = Boolean(e.requestStatus) && canSubmit && (workflow?.status === "REJECTED" || workflow?.status === "CANCELLED");
  const circuitAVous = !e.requestStatus
    ? canSubmit
    : Boolean(workflow && (workflow.action || workflow.peutResoumettre || workflow.peutFaireAppel)) || relancable;
  const titreCircuit = !e.requestStatus ? "soumettre la demande de prise en charge"
    : workflow?.action ? `décider — étape « ${workflow.action.title} »`
      : workflow?.peutResoumettre ? "corriger et resoumettre la demande"
        : relancable ? "relancer la demande de prise en charge" : "faire appel de la décision";
  const aVous = [
    circuitAVous ? {
      cle: "circuit", titre: titreCircuit,
      contenu: <EventFundingPanel eventId={e.id} requestSubmitted={!!e.requestStatus} canSubmit={canSubmit} workflow={workflow} compact partie="gestes" />,
    } : null,
    ...postes.gestes,
    gesteDeLaDeclaration(declaration, panneauDeclaration),
  ].filter((g): g is GesteAVous => g !== null);
  const roleDemandeur = e.requesterId
    ? (await prisma.user.findUnique({ where: { id: e.requesterId }, select: { role: true } }))?.role ?? null
    : null;

  return (
    <div className="space-y-5">
      <BackLink href="/events"><ArrowLeft className="h-4 w-4" /> Events</BackLink>
      <PageHeader
        title={e.name}
        description={e.requesterName
          ? ligneDeLaDemande({ reference: EVENT_TYPE[e.type] ?? e.type, par: e.requesterName, role: roleDemandeur ? ROLE_LABELS[roleDemandeur] ?? null : null, le: creeeLe })
          : [EVENT_TYPE[e.type] ?? e.type, creeeLe ? `créé le ${formatDate(creeeLe)}` : null].filter(Boolean).join(" · ")}
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
            <SupprimerDefinitivementDemandeAdPro kind="EVENT" id={e.id} enabled={!refusSuppressionDefinitive(user)} />
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
          La SEULE frise de validation est celle du circuit de prise en charge — la barre d'étapes
          ci-dessous la résume — et `lib/events/statut.ts` interdit au formulaire d'écrire un verdict. */}
      <BarreEtapes etapes={barre} />
      <CarteAVous gestes={aVous} />

      <CarteLaDemande
        faits={[
          { label: "Type", valeur: EVENT_TYPE[e.type] ?? e.type },
          { label: "Lieu", valeur: lieuTexte },
          { label: "Dates", valeur: dateTexte },
          { label: "Produits", valeur: e.products },
        ]}
        description={e.description}
      />

      {/* POSTES de l'événement : consulting, traiteur, location de salle… chacun validé à part par la Direction, avec son
          budget et son bon de commande — comme sur le sponsoring. Un tableau ; « Ouvrir » déplie la carte complète du poste. */}
      <CartePostes>
        <AdProItemsPanel
          parent="EVENT"
          parentId={e.id}
          items={items}
          amountGranted={e.finalAmount != null ? toNumber(e.finalAmount) : null}
          decided={postesDecides}
          canEdit={droitsPostes.canEdit}
          canAllocate={canAllocateItems}
          promoOptions={promoOptions}
          budgetOptions={budgetOptions}
          materiel={materielStock}
          canIssueOrder={droitsPostes.canIssueOrder}
          canViserBC={droitsPostes.canViserBC}
          contexte={contexte}
          resume={false}
          tableau
        />
      </CartePostes>

      {/* LA DÉCLARATION (information scientifique) — seulement à SON étape ; avant, la barre la montre grisée. */}
      <SectionDeclaration etape={declaration}>{panneauDeclaration}</SectionDeclaration>

      {/* PLUS D'INFORMATIONS, REPLIÉ : tout le reste de la fiche, chaque partie avec son composant d'avant. */}
      <PlusDInformations resume={resumeBudget || null}>
        <SectionRepliable titre="Montants et budget" resume={resumeBudget}>
          {suiviSimple ? (
            <BandeauArgent>
              <Chiffre label="Budget estimé" valeur={e.estimatedBudget !== null ? formatCurrency(e.estimatedBudget) : "—"} />
            </BandeauArgent>
          ) : (
          <BandeauArgent>
            {e.finalAmount != null ? (
              <Chiffre
                label="Enveloppe accordée" valeur={formatCurrency(e.finalAmount)}
                note={e.estimatedBudget !== null ? `estimé : ${formatCurrency(e.estimatedBudget)}` : null}
              />
            ) : (
              <Chiffre label="Budget estimé" valeur={e.estimatedBudget !== null ? formatCurrency(e.estimatedBudget) : "—"} note="enveloppe non tranchée" />
            )}
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
          )}
        </SectionRepliable>
        <SectionRepliable titre="Détails de l'événement" resume={[e.responsibleName, EVENT_FORMAT[e.format] ?? e.format].filter(Boolean).join(" · ")}>
          <div className="space-y-3">
            <Faits>
              <Fait label="Responsable" valeur={e.responsibleName} />
              <Fait label="Portée" valeur={EVENT_SCOPE[e.scope] ?? e.scope} />
              <Fait label="Format" valeur={EVENT_FORMAT[e.format] ?? e.format} />
              <Fait label="Spécialité" valeur={e.specialty} />
              {e.doctor && <Fait label="Médecins" valeur={e.doctor} />}
              <Fait label="Organisateur" valeur={e.organizer} />
              {e.meetingLink && (
                <Fait
                  large
                  label="Webinar"
                  valeur={<a href={e.meetingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-primary hover:underline"><Video className="h-4 w-4" /> Lien de connexion</a>}
                />
              )}
            </Faits>
            {e.stats.bySpecialty.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {e.stats.bySpecialty.map((x) => `${x.name} · ${x.count}`).join(" — ")}
              </p>
            )}
          </div>
        </SectionRepliable>
        {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
        <MedecinsConcernesSection user={user} entityType="EVENT" entityId={e.id} />
        <SectionPieces
          pieces={{
            entityType: "EVENT", entityId: e.id, documents: docItems,
            peutDeposer: canUploadDocs, motif: uploadHint,
            categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
            canDelete: userCan(user, "EVENTS", "DELETE") || hasGlobalView(user),
            canRename: canUploadDocs, canEdit: onlyofficeConfigured() && canUploadDocs,
            path: `/events/${e.id}`,
          }}
        >
          {/* LES PIÈCES LEGAL RATTACHÉES À LA DEMANDE ELLE-MÊME, hors postes — d'avant les postes, ou qui ne sont pas des achats. */}
          <PiecesLegalDeLaDemande spectateur={user} entityType="EVENT" entityId={e.id} />
        </SectionPieces>
        <SectionRepliable titre="Discussion" sansCadre>
          <EspaceDiscussion>
            <AdProDiscussionCard entityType="EVENT" entityId={e.id} user={user} />
            <InvolvementConversations threads={involvementThreads} currentUserId={user.id} canManage={hasGlobalView(user)} />
          </EspaceDiscussion>
        </SectionRepliable>
        <SectionRepliable titre="Équipe Adventum" compte={missions.length} resume={missions.length === 0 ? "Personne d'invité" : undefined} sansCadre>
          <MissionAssignmentsCard
            entityType="EVENT"
            entityId={e.id}
            assignments={missions}
            users={responsibles}
            canManage={canManage}
            currentUserId={user.id}
            path={`/events/${e.id}`}
          />
        </SectionRepliable>
        {/* LE CIRCUIT DÉTAILLÉ : la frise complète et la phrase de statut, sans les gestes (ils sont dans « À vous »). */}
        <SectionRepliable titre="Circuit de validation détaillé" resume={resumeDuCircuit(workflow, Boolean(e.requestStatus))}>
          <EventFundingPanel
            eventId={e.id}
            requestSubmitted={!!e.requestStatus}
            canSubmit={canSubmit}
            workflow={workflow}
            compact
            partie="frise"
            suite={suiteDeclaration}
          />
        </SectionRepliable>
        <SectionTracabilite
          creeeLe={dates ? formatDateTime(dates.createdAt) : "—"}
          modifieeLe={dates ? formatDateTime(dates.updatedAt) : "—"}
          historique={user.role === "SUPER_ADMIN" && e.requestStatus && workflow && workflow.events.length > 0 ? <HistoriqueDuCircuit events={workflow.events} /> : null}
        />
      </PlusDInformations>
    </div>
  );
}
