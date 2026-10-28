import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { VisaCentreBanniere } from "@/modules/ad-pro/ecrans/visa-centre-banniere";
import { SupprimerDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-demande";
import { peutSupprimerUneDemandeAdPro, contextePiecesLiees, adProEditValues } from "@/modules/ad-pro/api";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, billingSuffix, isOverdue, isContractEditable, isAwaitingDecision, totalCommitment, canEditAdProRequest, isAdProDecided } from "@/modules/ad-pro/partage";
import { LinkedRecords } from "@/components/pieces/linked-records";
import type { DocItem } from "@/components/documents/document-list";
import { CONSULTING_STATUS, CONSULTING_BILLING } from "@/lib/labels";
import { ConsultingActions, type ContractTask } from "./actions-panel";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import {
  MODULE_DU_POLE, CHEMIN_LISTE_POLE, LIBELLE_POLE, poleDe, poleOppose, transfertAutorise,
} from "@/lib/lecteurs/consulting";
import { TransferPanel } from "./transfer-panel";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";

export const dynamic = "force-dynamic";

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words font-medium">{value}</p>
    </div>
  );
}

/**
 * LA FICHE D'UN CONTRAT.
 *
 * À gauche ce qui a été convenu et les pièces signées ; à droite ce qu'on peut FAIRE — et
 * seulement ce qui a un sens à cet instant du cycle de vie. Un bouton qui apparaît puis échoue
 * fait douter de tout le reste de l'écran.
 */
export default async function ConsultingContractPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // LA PORTE EST CELLE DU PÔLE DU CONTRAT (§118.150), pas « Consulting » en dur : un contrat passé
  // aux RH n'est plus lisible par la promotion — sa rémunération comprise — et il doit l'être
  // par les RH qui le suivent. Sans le module de son pôle, le contrat n'existe pas pour cette
  // personne : la même page qu'un contrat inexistant, parce qu'une redirection trahirait qu'il
  // existe, et où (§118.136).
  const user = await requireUser();
  const tete = await prisma.consultingContract.findUnique({ where: { id: params.id }, select: { pole: true } });
  const pole = poleDe(tete?.pole);
  const moduleDuContrat = MODULE_DU_POLE[pole];
  if (!tete || !userCan(user, moduleDuContrat, "VIEW")) notFound();
  // Les gardes d'écran habituelles du module — mot de passe à changer, module masqué.
  await requireModule(moduleDuContrat);

  const contract = await prisma.consultingContract.findUnique({
    where: { id: params.id },
    include: { company: { select: { name: true } }, tasks: { orderBy: { position: "asc" } } },
  });
  if (!contract) notFound();

  const [documents, people] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "CONSULTING_CONTRACT", entityId: contract.id },
      include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const names = new Map(people.map((p) => [p.id, p.name]));
  const mine = contract.requesterId === user.id || contract.createdById === user.id || hasGlobalView(user.role);
  const mayValidate = userCan(user, moduleDuContrat, "VALIDATE")
    && (contract.validatorId === null || contract.validatorId === user.id || hasGlobalView(user.role));
  const editable = isContractEditable(contract.status);
  // CORRIGER LE CONTRAT (audit 360°, R11) — la MÊME règle que les autres natures du pôle, lue sur le
  // module de SON pôle : le porteur tant que le contrat n'est pas actif, qui peut le valider jusque-là,
  // la vue globale toujours.
  const contratDecide = isAdProDecided("CONSULTING_CONTRACT", contract.status);
  const canEditContract = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user.role), canManage: userCan(user, moduleDuContrat, "VALIDATE") },
    { requesterId: contract.requesterId, decided: contratDecide },
  );
  const editValues = canEditContract ? await adProEditValues("CONSULTING_CONTRACT", contract.id) : null;
  // Une décision se dit par son SENS : « Validé par » sur un contrat refusé affirmait le contraire.
  const verbeDecision = contract.status === "ACTIVE" || contract.status === "EXPIRED" ? "Validé" : "Décision";
  const canUpload = (userCan(user, moduleDuContrat, "UPLOAD") || mine) && editable;
  // Ce que la personne peut ouvrir, déposer, créer parmi les pièces liées — la règle commune du
  // pôle, lue sur le module du CONTRAT (Consulting ou RH selon son pôle, §118.150).
  const ctxPieces = await contextePiecesLiees(user, moduleDuContrat);
  // TRANSFÉRER : modifier des DEUX côtés (`transfertAutorise`), la même règle que l'action.
  const versPole = poleOppose(pole);
  const canTransfer = transfertAutorise({
    modifieDepart: userCan(user, moduleDuContrat, "UPDATE"),
    modifieArrivee: userCan(user, MODULE_DU_POLE[versPole], "UPDATE"),
  });

  const amount = contract.amount == null ? null : toNumber(contract.amount);
  const total = totalCommitment({
    amount, billing: contract.billing,
    startDate: contract.startDate, endDate: contract.endDate,
  });

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));
  const taskItems: ContractTask[] = contract.tasks.map((t) => ({
    id: t.id, label: t.label,
    dueDate: t.dueDate ? formatDate(t.dueDate.toISOString()) : null,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
  }));

  return (
    <div className="space-y-5">
      <BackLink href={CHEMIN_LISTE_POLE[pole]}>
        <ArrowLeft className="h-4 w-4" /> {pole === "RH" ? "Consultants (RH)" : "Consulting"}
      </BackLink>
      <PageHeader title={contract.title} description={`Réf. ${contract.reference} · ${contract.counterparty}`}>
        <StatusBadge map={CONSULTING_STATUS} value={contract.status} />
        {/* LA MAISON DU CONTRAT, dite en toutes lettres : c'est elle qui décide qui le voit. */}
        <Badge tone={pole === "RH" ? "purple" : "neutral"} dot={false}>Suivi par {LIBELLE_POLE[pole]}</Badge>
        {isOverdue(contract) && <Badge tone="danger" dot={false}>terme dépassé</Badge>}
        {/* Une nature du pôle qui n'avait AUCUNE suppression (§118.162) : elle passe par le même
            lot que les autres — ses branches partent et reviennent avec elle. */}
        {editValues && <AdProEditButton kind="CONSULTING_CONTRACT" id={contract.id} decided={contratDecide} values={editValues} />}
        <SupprimerDemandeAdPro kind="CONSULTING_CONTRACT" id={contract.id} name={`${contract.reference} — ${contract.title}`} enabled={await peutSupprimerUneDemandeAdPro(user, "CONSULTING_CONTRACT", contract.id)} />
      </PageHeader>

      {/* RENVOYÉ POUR CORRECTION (audit 360°, R11) : le motif se lit ICI, avec le geste qui fait repartir
          le contrat — sans dérouler la discussion. */}
      {contract.status === "DRAFT" && contract.returnedAt && (
        <div className="space-y-1 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
          <p className="font-medium">
            Renvoyé pour correction le {formatDate(contract.returnedAt.toISOString())}
            {contract.returnedById && names.get(contract.returnedById) ? ` par ${names.get(contract.returnedById)}` : ""}
          </p>
          <p className="break-words">À corriger : « {contract.returnNote ?? "non renseigné"} ».</p>
          <p className="text-muted-foreground">
            {mine
              ? "Corrigez le contrat (« Modifier »), puis renvoyez-le pour validation."
              : "Son porteur le corrige, puis le renvoie pour validation."}
          </p>
        </div>
      )}

      {/* L'ÉTAT DU CENTRE AD & PRO (audit 360°, R07/R10) — un contrat suivi par les RH n'y passe pas. */}
      {pole === "AD_PRO" && (
        <VisaCentreBanniere entityType="CONSULTING_CONTRACT" entityId={contract.id} viewer={user} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Ce qui a été convenu</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 sm:gap-x-6">
              <Info label="Consultant / cabinet" value={contract.counterparty} />
              <Info label="Contact" value={contract.counterpartyContact} />
              <Info label="Entité signataire" value={contract.company?.name} />
              <Info label="Début" value={contract.startDate ? formatDate(contract.startDate.toISOString()) : null} />
              <Info label="Fin" value={contract.endDate ? formatDate(contract.endDate.toISOString()) : null} />
              <Info
                label="Rémunération"
                value={amount != null ? `${formatCurrency(amount)}${billingSuffix(contract.billing)}` : null}
              />
              <Info label="Rythme" value={CONSULTING_BILLING[contract.billing]} />
              {/* L'engagement TOTAL n'apparaît que s'il est CALCULABLE : sans terme connu, un
                  chiffre inventé finirait dans un tableau de budget sans marque d'origine. */}
              {total != null && total !== amount && <Info label="Engagement total estimé" value={formatCurrency(total)} />}
              <Info label="Porteur interne" value={contract.requesterId ? names.get(contract.requesterId) : null} />
              <Info label={`${verbeDecision} par`} value={contract.validatedById ? names.get(contract.validatedById) : null} />
              <Info label={`${verbeDecision} le`} value={contract.validatedAt ? formatDate(contract.validatedAt.toISOString()) : null} />
              {contract.scope && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Objet de la mission</p>
                  <p className="whitespace-pre-wrap break-words">{contract.scope}</p>
                </div>
              )}
              {contract.paymentTerms && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Modalités de paiement</p>
                  <p className="whitespace-pre-wrap break-words">{contract.paymentTerms}</p>
                </div>
              )}
              {contract.decisionNote && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Note de décision</p>
                  <p className="whitespace-pre-wrap break-words">{contract.decisionNote}</p>
                </div>
              )}
              {contract.notes && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Notes internes</p>
                  <p className="whitespace-pre-wrap break-words">{contract.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* LES PIÈCES LIÉES, comme sur les six autres natures du pôle (§118.161) : le bloc
              générique « Pièces (contrat signé, avenants, factures, livrables…) » disparaît. Les
              factures du consultant, ses devis et ses bons de commande ont leur fiche au registre ET
              leur PDF, dans la chaîne ; les pièces du contrat lui-même gardent leur place nommée. */}
          <LinkedRecords
            entityType="CONSULTING_CONTRACT" entityId={contract.id} reference={contract.reference} canCreate={canUpload}
            acces={ctxPieces.acces} candidatsLegal={ctxPieces.candidatsLegal} suppression
            piecesDeLaDemande={{
              titre: "Pièces du contrat (contrat signé, livrables, comptes rendus…)",
              documents: docItems,
              televerseur: canUpload
                ? <DocumentUpload entityType="CONSULTING_CONTRACT" entityId={contract.id} categories={categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES)} />
                : undefined,
              canDelete: userCan(user, moduleDuContrat, "DELETE") || hasGlobalView(user.role),
              canRename: canUpload,
              canEdit: onlyofficeConfigured() && canUpload,
              path: `/consulting/${contract.id}`,
            }}
          />
        </div>

        <ConsultingActions
          id={contract.id}
          status={contract.status}
          canSubmit={mine && contract.status === "DRAFT"}
          canDecide={mayValidate && isAwaitingDecision(contract.status)}
          canProlong={mayValidate && contract.status === "ACTIVE"}
          endDate={contract.endDate ? contract.endDate.toISOString().slice(0, 10) : null}
          resubmission={contract.status === "DRAFT" && contract.returnedAt !== null}
          validateurActuel={contract.validatorId}
          canClose={(mine || mayValidate) && (contract.status === "ACTIVE" || contract.status === "DRAFT" || contract.status === "AWAITING_VALIDATION")}
          canEditTasks={(mine || userCan(user, moduleDuContrat, "UPDATE")) && editable}
          validators={people.filter((p) => p.id !== user.id)}
          tasks={taskItems}
          transfer={canTransfer ? (
            <TransferPanel id={contract.id} depuis={LIBELLE_POLE[pole]} vers={versPole} versLibelle={LIBELLE_POLE[versPole]} />
          ) : null}
        />
      </div>
          {/* LA SECTION DISCUSSION — le fil CANONIQUE, monté sur les sept natures du pôle. */}
      <AdProDiscussionCard entityType="CONSULTING_CONTRACT" entityId={contract.id} user={user} />
</div>
  );
}
