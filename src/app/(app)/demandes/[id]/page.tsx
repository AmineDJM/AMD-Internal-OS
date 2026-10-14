import { suppressionPermise } from "@/lib/suppression/delegation";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, XCircle, Clock, RotateCcw, MinusCircle } from "lucide-react";
import { lireCircuit, libelleDuMode, type EtatEtape } from "@/lib/validations/lecture-circuit";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, isTopManagement } from "@/lib/rbac";
import { clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { prisma } from "@/lib/prisma";
import { fieldLabels, REQUEST_TYPE_FIELDS } from "@/lib/admin-requests";
import { addRequestComment } from "@/lib/actions/admin-request-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommentThread, type CommentItem } from "@/components/shared/comment-thread";
import { DocumentUpload } from "@/components/documents/document-upload";
import { PROMO_MATERIAL_DOC_CATEGORIES } from "@/lib/ad-pro/doc-categories";
import { dejaPorteParSaFiche } from "@/lib/ad-pro/unified";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { LinkedRecords } from "@/components/shared/linked-records";
import { accesPiecesLiees } from "@/lib/ad-pro/pieces-liees";
import { AttachmentValidationBlock } from "./attachment-validation";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, ADMIN_APPROVAL_STATUS, DRIVER_MISSION_STATUS, PRIORITY, AUDIT_ACTION, VALIDATION_STATUS } from "@/lib/labels";
import { formatDate, formatDateTime, formatCurrency, toNumber, cn } from "@/lib/utils";
import { RequestActions } from "./request-actions";
import { refusFinApresDecision } from "@/lib/secretariat/traitement";
import { RequesterWindow } from "./requester-window";
import { ApprovalButtons } from "../approval-buttons";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { ReminderButton } from "@/components/reminders/reminder-button";
import { PromoActionPanel } from "../../promo-material/[id]/promo-panels";
import { BackLink } from "@/components/shared/back-link";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";
import { statutDuDossier } from "@/lib/promo-material/statut";
import { lireLignesDAchat } from "@/lib/general-means/purchase-request";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { PurchaseLines } from "@/components/purchase/purchase-lines";
import { porteDuDemandeur, refusDeModification, suitLaDemandeDeBcDuPoste, refusDemandeDeBcDuPoste } from "@/lib/secretariat/porte-demandeur";
import { decideurAffiche, libelleMotif, interditSurSaPropreDemande } from "@/lib/secretariat/decision-approbation";
import { statutAffiche, chezQui, lireParticipants } from "@/lib/secretariat/traitement";

const REQ_DOC_CATEGORIES = ["QUOTE", "INVOICE", "REQUEST_LETTER", "CONVENTION", "SUPPORTING_DOC", "PHOTO", "OTHER"];

export default async function RequestDetailPage({ params }: { params: { id: string } }) {
  const user = await requireModule("ADMIN_REQUESTS");
  // VALIDATEUR D'UNE PIÈCE = ACCÈS À TOUTE LA DEMANDE. On ne valide pas une facture hors de son
  // contexte : le validateur choisi voit la demande entière, même hors de son périmètre habituel.
  // La règle vit dans `clauseDemandeLisible`, lue aussi par le geste de commentaire (§118.184).
  const req = await prisma.administrativeRequest.findFirst({
    where: await clauseDemandeLisible(user, params.id),
    include: {
      requester: { select: { name: true, employee: { select: { departmentId: true } } } },
      concerned: { select: { name: true } },
      assignedTo: { select: { name: true } },
      validator: { select: { name: true } },
      department: { select: { name: true } },
      approvals: { include: { validator: { select: { name: true } }, decidedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
      missions: { include: { assignedTo: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!req) notFound();

  // IMPUTATION AUX MOYENS GÉNÉRAUX : chaque département a les siens. On propose les NOMS des
  // départements (et rien de leurs montants — l'assistante impute chez eux, elle ne consulte
  // pas leurs budgets), en pré-sélectionnant celui du demandeur : c'est lui qui consomme.
  const departments = await prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  // Ce qui vient d'Ad & Pro est déjà porté par le budget de l'opération : l'imputer une
  // seconde fois le compterait deux fois.
  // LA LISTE SE DÉRIVE DU REGISTRE CANONIQUE des sept natures du pôle, plus le POSTE.
  //
  // Écrite à la main, elle oubliait `CONSULTING_CONTRACT`, `AD_PRO_OTHER` et `AD_PRO_ITEM` —
  // donc une demande de devis ou de facture ouverte depuis un poste pouvait être imputée une
  // seconde fois au budget d'un département, alors que l'enveloppe de l'opération la porte
  // déjà. Aucune erreur visible, et le double comptage ne se lit que sur le budget (§118.73).
  // La MÊME fonction que l'action qui clôt la demande : écrite deux fois, la liste de l'action
  // (à la main, cinq natures) laissait l'écran masquer l'imputation que l'action exigeait (§118.150).
  const fromAdPro = dejaPorteParSaFiche(req.linkedEntityType);
  const alreadyImputed = (await prisma.departmentBudgetExpense.count({ where: { adminRequestId: req.id } })) > 0;

  // L'Assistante de Direction tient le bureau du secrétariat : elle gère et modère toute demande.
  const isSecretary = hasRole(user, "DIRECTION_ASSISTANT");
  const canManage = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE") || req.assignedToId === user.id || isSecretary;
  // Trancher une approbation : le validateur nommé, son intérimaire ou le sommet — la règle de `decideApproval`.
  const canValidate = isTopManagement(user);
  // L'INTÉRIMAIRE tranche l'approbation adressée à l'absent — la même règle que l'action (I18).
  const auNomInterim = await auNomDeQui(user.id);
  const canUpload = userCan(user, "ADMIN_REQUESTS", "UPLOAD") || isSecretary;
  // CE QUE LE DEMANDEUR PEUT ENCORE FAIRE (§118.187 — audit 360°, R08) : la règle de l'action, lue ici
  // pour ne montrer que des gestes qu'elle acceptera.
  // Une demande « BC à établir » se corrige et se retire depuis son poste : l'encart n'offrirait que des refus.
  const porteDemandeur = req.deletedAt || suitLaDemandeDeBcDuPoste(req) ? null : porteDuDemandeur(req, user.id, Date.now());
  const ordresEmis = porteDemandeur?.ok
    ? await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: req.id, status: { not: "CANCELLED" } } })
    : 0;

  const [documents, comments, history, users, linkedValidations, siblings] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.comment.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.auditLog.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: { name: true } } } }),
    canManage || req.requesterId === user.id ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([] as { id: string; name: string }[]),
    prisma.validationRequest.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { steps: { include: { validator: { select: { name: true } } }, orderBy: { order: "asc" } } }, orderBy: { createdAt: "desc" } }),
    req.batchId ? prisma.administrativeRequest.findMany({ where: { batchId: req.batchId, deletedAt: null }, select: { id: true, reference: true, title: true, status: true, type: true, blockedReason: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve([] as { id: string; reference: string; title: string; status: string; type: string; blockedReason: string | null }[]),
  ]);

  // Dossier Matériel promotionnel lié : l'assistante le pilote ici (sans accès au module).
  const promo = await prisma.promoMaterial.findFirst({ where: { adminRequestId: req.id } });
  const isPromoAssistant = hasGlobalView(user.role) || hasRole(user, "DIRECTION_ASSISTANT");
  const promoDocs = promo
    ? await prisma.document.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: promo.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } })
    : [];
  const promoDocItems: DocItem[] = promoDocs.map((d) => ({ id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes, confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey) }));
  const promoAmount = promo ? (promo.chosenAmount != null ? toNumber(promo.chosenAmount) : promo.amount != null ? toNumber(promo.amount) : null) : null;
  // UN DOSSIER À CIRCUIT SE PILOTE SUR SA FICHE (§118.153). Son `status` hérité reste figé à
  // « Prospection demandée » : ce bloc l'affichait, et proposait à l'assistante les boutons de
  // l'ANCIEN circuit — que les actions refusent sur un dossier du nouveau. Un bouton qu'une action
  // refuse n'est pas un bouton ; on montre l'étape réelle et le chemin de la fiche.
  const promoStatut = promo ? statutDuDossier(promo) : null;
  const promoACircuit = Boolean(promo?.circuitState);

  const modificationFermee = porteDemandeur?.ok
    ? refusDeModification({
        validationEnCours: linkedValidations.some((v) => v.status === "PENDING" && !v.documentId) || req.approvals.some((a) => a.status === "PENDING"),
        paiementEmis: ordresEmis > 0,
      })
    : null;

  // Ce que lit chacun : une étape retirée se lit « En cours », chez l'assistante de direction (10/2026).
  const statut = statutAffiche(req.status, req.blockedReason);
  const participantIds = lireParticipants(req.fields);
  const participants = participantIds.length
    ? (await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { name: true }, orderBy: { name: "asc" } })).map((u) => u.name)
    : [];

  const labels = fieldLabels(req.type);
  const fields = (req.fields as Record<string, unknown> | null) ?? {};
  const fieldEntries = Object.entries(labels).filter(([k]) => fields[k] !== undefined && fields[k] !== "");
  // LES ARTICLES D'UNE DEMANDE D'ACHAT vivent dans `fields.purchaseLines`, hors des champs déclarés
  // du type : sans ce bloc, ni le N+1 qui valide ni l'assistante qui achète ne les voyaient (I14).
  const lignesAchat = req.type === "PURCHASE" ? lireLignesDAchat(fields) : [];
  const docItems: DocItem[] = documents.map((d) => ({ id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes, confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey) }));
  const commentItems: CommentItem[] = comments.map((c) => ({ id: c.id, author: c.author?.name ?? "Utilisateur", authorId: c.authorId, body: c.body, createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null }));

  return (
    <div className="space-y-5">
      <BackLink href="/demandes">
        <ArrowLeft className="h-4 w-4" /> Retour aux demandes
      </BackLink>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{req.reference}</span>
            <StatusBadge map={PRIORITY} value={req.priority} dot={false} />
            <Badge tone="neutral" dot={false}>{ADMIN_REQUEST_TYPE[req.type] ?? req.type}</Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{req.title}</h1>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge map={ADMIN_REQUEST_STATUS} value={statut} />
          {chezQui(statut) && <p className="text-xs text-muted-foreground">{chezQui(statut)}</p>}
          <div className="flex items-center gap-2">
            <ReminderButton defaultTitle={`Demande ${req.reference} — ${req.title}`} link={`/demandes/${req.id}`} entityType="ADMIN_REQUEST" entityId={req.id} />
            <SuperAdminDeleteButton kind="ADMIN_REQUEST" id={req.id} name={`${req.reference} — ${req.title}`} enabled={suppressionPermise(user, "ADMIN_REQUEST")} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Info label="Demandeur" value={req.requester?.name} />
              <Info label="Responsable" value={req.assignedTo?.name} />
              <Info label="Validateur" value={req.validator?.name} />
              {/* « Personne concernée » ne se saisit plus (10/2026) : elle se relit sur les demandes qui la portent. */}
              {req.concerned?.name && <Info label="Personne concernée" value={req.concerned.name} />}
              {participants.length > 0 && <Info label="Participants" value={participants.join(", ")} />}
              <Info label="Département" value={req.department?.name} />
              <Info label="Échéance" value={req.deadline ? formatDate(req.deadline) : null} />
              {req.description && <div className="col-span-full"><p className="text-xs text-muted-foreground">Description</p><p className="font-medium">{req.description}</p></div>}
              {req.blockedReason && <div className="col-span-full"><p className="text-xs text-muted-foreground">Motif de blocage</p><p className="font-medium text-destructive">{req.blockedReason}</p></div>}
              {fieldEntries.length > 0 && (
                <div className="col-span-full grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-3">
                  {fieldEntries.map(([k, label]) => <Info key={k} label={label} value={String(fields[k])} />)}
                </div>
              )}
            </CardContent>
          </Card>

          {lignesAchat.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Articles demandés ({lignesAchat.length})</CardTitle></CardHeader>
              <CardContent><PurchaseLines lines={lignesAchat} /></CardContent>
            </Card>
          )}

          {porteDemandeur?.ok && (
            <RequesterWindow
              requestId={req.id}
              createdAt={req.createdAt.toISOString()}
              discret={porteDemandeur.discret}
              modificationFermee={modificationFermee}
              values={{
                title: req.title,
                description: req.description,
                priority: req.priority,
                deadline: req.deadline ? req.deadline.toISOString().slice(0, 10) : null,
                fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v == null ? "" : String(v)])),
              }}
              typeFields={(REQUEST_TYPE_FIELDS[req.type] ?? []).map((f) => ({ type: f.type, name: f.name, label: f.label, full: f.full, // `parties` porte aussi des `options`, mais ce sont des contacts d'annuaire, pas des
                // couples valeur/libellé : les demandes administratives n'en ont pas.
                options: "options" in f && f.type !== "parties" ? f.options : undefined }))}
            />
          )}

          {siblings.length > 1 && (
            <Card>
              <CardHeader><CardTitle>Demande groupée ({siblings.length} cellules)</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {siblings.map((s) => (
                  <Link key={s.id} href={`/demandes/${s.id}`} className={cn("flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-secondary", s.id === req.id && "bg-secondary font-medium")}>
                    <span className="min-w-0 truncate"><span className="font-mono text-xs text-muted-foreground">{s.reference}</span> — {s.title}</span>
                    <StatusBadge map={ADMIN_REQUEST_STATUS} value={statutAffiche(s.status, s.blockedReason)} dot={false} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {canManage && (
            <Card>
              <CardHeader><CardTitle>Traitement</CardTitle></CardHeader>
              <CardContent>
                <RequestActions
                  requestId={req.id} status={req.status} commencee={req.processingStartedAt !== null} type={req.type}
                  canManage={canManage}
                  departments={departments}
                  defaultDepartmentId={req.departmentId ?? req.requester?.employee?.departmentId ?? null}
                  fromAdPro={fromAdPro}
                  alreadyImputed={alreadyImputed}
                  refusAnnulation={suitLaDemandeDeBcDuPoste(req) ? refusDemandeDeBcDuPoste("annuler") : null}
                  refusFin={refusFinApresDecision(req.approvals[0] ?? null)}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between"><CardTitle>Documents</CardTitle><Badge tone="neutral">{docItems.length}</Badge></CardHeader>
            <CardContent className="space-y-4">
              {canUpload && <DocumentUpload entityType="ADMIN_REQUEST" entityId={req.id} categories={REQ_DOC_CATEGORIES} />}
              <DocumentList documents={docItems} canDelete={canManage} canEdit={onlyofficeConfigured() && canUpload} path={`/demandes/${req.id}`} />
              <AttachmentValidationBlock
                requestId={req.id}
                documents={documents.map((d) => ({ id: d.id, name: d.name }))}
                validations={linkedValidations
                  .filter((v) => v.documentId)
                  .map((v) => ({
                    id: v.id, reference: v.reference, documentId: v.documentId!, status: v.status,
                    createdAt: v.createdAt.toISOString(),
                    steps: v.steps.map((st) => ({ validator: st.validator?.name ?? "?", status: st.status })),
                  }))}
                users={users}
                canSubmit={canManage || req.requesterId === user.id}
              />
            </CardContent>
          </Card>

          {promo && (
            <Card className="border-primary/40">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Matériel promotionnel</CardTitle>
                {promoStatut && <Badge tone={promoStatut.ton} dot={false}>{promoStatut.libelle}</Badge>}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                  <Info label="Agence retenue" value={promo.chosenAgency} />
                  <Info label="Montant" value={promoAmount != null ? formatCurrency(promoAmount) : null} />
                  <Info label="N° bon de commande" value={promo.bcReference} />
                </div>
                {promoACircuit && (
                  <p className="text-sm text-muted-foreground">
                    La retranscription des devis et la suite du circuit se font sur la fiche du dossier —{" "}
                    <Link href={`/promo-material/${promo.id}`} className="font-medium text-primary hover:underline">ouvrir {promo.reference}</Link>.
                  </p>
                )}
                {isPromoAssistant && !promoACircuit && (
                  <>
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Pièces du dossier (devis, bon de commande, facture…)</p>
                      <DocumentUpload entityType="PROMO_MATERIAL" entityId={promo.id} categories={[...PROMO_MATERIAL_DOC_CATEGORIES]} />
                      <DocumentList documents={promoDocItems} canDelete canEdit={onlyofficeConfigured()} path={`/demandes/${req.id}`} />
                    </div>
                    <PromoActionPanel
                      id={promo.id}
                      status={promo.status}
                      flags={{ isMarketing: false, isAssistant: true, isFinance: false, isMedicalInfo: false, isDirection: hasGlobalView(user.role), isCentreAdPro: siegeAuCentreAdPro(user) }}
                      chosenAgency={promo.chosenAgency}
                      bcReference={promo.bcReference}
                      visaReference={promo.visaReference}
                      authorityRef={promo.authorityRef}
                      amount={promoAmount}
                      reminderCount={promo.financeReminderCount}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* CE QUI EN DÉCOULE : bon de commande, facture, courrier. Créés d'ici, ils gardent le
              lien vers cette demande — c'est le seul moment où l'on sait de quoi ils viennent. */}
          <LinkedRecords entityType="ADMIN_REQUEST" entityId={req.id} reference={req.reference} canCreate={canManage} acces={accesPiecesLiees(user)} />

          <Card>
            <CardHeader><CardTitle>Commentaires</CardTitle></CardHeader>
            <CardContent><CommentThread comments={commentItems} action={addRequestComment} hiddenFields={{ requestId: req.id }} currentUserId={user.id} canModerate={canManage} updateAction={updateComment} deleteAction={deleteComment} path={`/demandes/${req.id}`} /></CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Validations</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {req.approvals.length === 0 ? (
                <p className="text-muted-foreground">Aucune validation demandée.</p>
              ) : req.approvals.map((a) => {
                // QUI A TRANCHÉ, ET CE QU'IL A DIT (lot E5 — M14, M15) : « Validateur : X » se lisait comme la
                // signature de X, alors que son intérimaire, l'assistante ou la Direction tranchent aussi.
                const decideur = decideurAffiche({ status: a.status, decidedAt: a.decidedAt, decidedByName: a.decidedBy?.name ?? null });
                return (
                  <div key={a.id} className="space-y-1 border-b border-border pb-2 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <StatusBadge map={ADMIN_APPROVAL_STATUS} value={a.status} dot={false} />
                      {a.amount && <span className="font-medium">{formatCurrency(toNumber(a.amount))}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">Validateur : {a.validator?.name ?? "—"}</p>
                    {a.comment && <p className="text-xs">{a.comment}</p>}
                    {decideur && <p className="text-xs text-muted-foreground">{decideur}{a.decidedAt ? ` le ${formatDateTime(a.decidedAt)}` : ""}</p>}
                    {a.decisionNote && <p className="text-xs"><span className="text-muted-foreground">{libelleMotif(a.status)} :</span> {a.decisionNote}</p>}
                    {/* Un bouton que l'action refuserait n'est pas un geste (§118.83) : on ne tranche pas sa propre demande. */}
                    {a.status === "PENDING" && (canValidate || a.validatorId === user.id
                      || (req.requesterId !== user.id && auNomInterim.nomDe(a.validatorId) !== null))
                      && !interditSurSaPropreDemande({ estDemandeur: req.requesterId === user.id, sommet: isTopManagement(user) })
                      && <ApprovalButtons approvalId={a.id} />}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {linkedValidations.length > 0 && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Validations (bureau central)</CardTitle>
                <Badge tone="neutral">{linkedValidations.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {linkedValidations.map((v) => {
                  // CE QUE CHAQUE VALIDATEUR A DIT (Direction, 06/10) : le statut global seul, avec un motif sans
                  // auteur, laissait lire « Je valide… » sous « En attente » — sans dire qu'un second accord restait dû.
                  const circuit = lireCircuit({
                    status: v.status, mode: v.mode, currentOrder: v.currentOrder,
                    steps: v.steps.map((s) => ({ order: s.order, status: s.status, validateur: s.validator?.name ?? "—", motif: s.reason, decideeLe: s.decidedAt })),
                  });
                  return (
                    <div key={v.id} className="space-y-1.5 border-b border-border pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/validations/${v.id}`} className="font-mono text-xs text-muted-foreground hover:text-primary hover:underline">{v.reference}</Link>
                        <StatusBadge map={VALIDATION_STATUS} value={v.status} dot={false} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {v.module}{libelleDuMode(v.mode, v.steps.length) ? ` · ${libelleDuMode(v.mode, v.steps.length)}` : ""}
                      </p>
                      <p className="text-xs font-medium">{circuit.resume}</p>
                      <ul className="space-y-1">
                        {circuit.lignes.map((l, i) => (
                          <li key={i} className="text-xs">
                            <span className="flex items-start gap-1.5">
                              <IconeEtape etat={l.etat} />
                              <span className="min-w-0">
                                <span className="font-medium">{l.validateur}</span>
                                <span className="text-muted-foreground"> — {l.libelle}{l.decideeLe ? ` le ${formatDateTime(l.decideeLe)}` : ""}</span>
                              </span>
                            </span>
                            {l.motif && <span className="mt-0.5 block pl-5">« {l.motif} »</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <Link href="/validations" className="text-xs text-primary hover:underline">Ouvrir le bureau des validations →</Link>
              </CardContent>
            </Card>
          )}

          {/* Les missions chauffeur ne se créent plus (10/2026) : celles déjà posées se relisent ici. */}
          {req.missions.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Missions chauffeur</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {req.missions.map((m) => (
                <div key={m.id} className="flex items-center justify-between">
                  <span className="min-w-0"><span className="block truncate font-medium">{m.title}</span><span className="text-xs text-muted-foreground">{m.assignedTo?.name ?? "Non assignée"}</span></span>
                  <StatusBadge map={DRIVER_MISSION_STATUS} value={m.status} dot={false} />
                </div>
              ))}
            </CardContent>
          </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Historique</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              {history.length === 0 ? <p className="text-muted-foreground">—</p> : history.map((h) => (
                <div key={h.id} className="flex items-start justify-between gap-2">
                  <span><StatusBadge map={AUDIT_ACTION} value={h.action} dot={false} /> <span className="text-muted-foreground">{h.summary ?? h.field ?? ""}</span></span>
                  <span className="shrink-0 text-muted-foreground">{formatDateTime(h.createdAt)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** ✓ validé · ✗ refusé · ↺ correction demandée · ⏳ en attente · — non sollicité. */
function IconeEtape({ etat }: { etat: EtatEtape }) {
  const cls = "mt-0.5 h-3.5 w-3.5 shrink-0";
  if (etat === "VALIDE") return <CheckCircle2 className={cn(cls, "text-success")} aria-label="Validé" />;
  if (etat === "REFUSE") return <XCircle className={cn(cls, "text-destructive")} aria-label="Refusé" />;
  if (etat === "A_CORRIGER") return <RotateCcw className={cn(cls, "text-amber-600")} aria-label="Correction demandée" />;
  if (etat === "SANS_OBJET") return <MinusCircle className={cn(cls, "text-muted-foreground")} aria-label="Non sollicité" />;
  return <Clock className={cn(cls, etat === "A_SON_TOUR" ? "text-amber-600" : "text-muted-foreground")} aria-label="En attente" />;
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium">{value || "—"}</p></div>;
}
