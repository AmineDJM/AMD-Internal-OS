import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { aiConfigured } from "@/lib/ai";
import { prisma } from "@/lib/prisma";
import { getPchTenderDetail, lecturesDuMarche } from "@/lib/queries/pch";
import { loadMarket360 } from "@/lib/queries/market-360";
import { loadEngagementsAilleurs, reserveEngagement } from "@/lib/queries/pch-engagements";
import { storyMarche } from "@/lib/queries/story";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { PCH_MARKET_NIVEAU } from "@/lib/labels";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils";
import { EditTenderButton, OrdersManager } from "./pch-detail-client";
import { TenderLines } from "./tender-lines";
import { AllocationsPanel } from "./allocations-panel";
import { TenderLogistics } from "./tender-logistics";
import { SubmissionPanel } from "./submission-panel";
import { ContractPanel } from "./contract-panel";
import { MarketGaps, MarketKpis, MarketProgress } from "./market-header";
import { MarketTimeline } from "./market-timeline";
import { BackLink } from "@/components/shared/back-link";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { createMailEntry } from "@/lib/actions/mail-register-actions";
import { mailFields } from "../../courriers/mail-fields";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { canAccessEntity } from "@/lib/entity-access";
import { mailRoutingOptions } from "@/lib/queries/mail-routing";

/**
 * LA FICHE MARCHÉ 360° — un appel d'offres se lit de bout en bout : cahier des charges →
 * soumission versionnée → attribution → contrat & avenants → bons de commande → livraisons →
 * factures → paiements, plus les courriers et la frise. Le niveau d'en-tête est DÉRIVÉ des
 * faits ; les montants viennent tous du même module de calcul.
 */
export default async function PchTenderPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("PCH");
  // LA PORTE AVANT LE CHARGEMENT (§118.184 — audit 360°, S11) : la fiche chargeait le marché par son seul
  // identifiant, et un gestionnaire PCH d'une société lisait le marché d'une autre — montants, contrat,
  // bons de commande, pièces. Hors de portée, la même page qu'un marché qui n'existe pas.
  if (!(await canAccessEntity(user, "PCH_TENDER", params.id, "VIEW"))) notFound();
  const [t, market, story, businessUnits, affectations] = await Promise.all([
    getPchTenderDetail(params.id),
    loadMarket360(params.id),
    storyMarche(params.id),
    // LES GAMMES OÙ L'ON PEUT RANGER UN PRODUIT GAGNÉ. Seules les BU ACTIVES : proposer une
    // gamme dissoute ferait confier un produit à une équipe qui n'existe plus.
    prisma.businessUnit.findMany({
      where: { isActive: true },
      select: { id: true, name: true, color: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.pchTenderLineBusinessUnit.findMany({
      where: { tenderLine: { tenderId: params.id } },
      select: { tenderLineId: true, businessUnitId: true },
    }),
  ]);
  if (!t || !market) notFound();

  // « CE PRODUIT EST-IL DÉJÀ ENGAGÉ AILLEURS ? » — la cardinalité que la Direction énonce (un
  // produit, un AO, donc un marché), lue APRÈS le détail parce qu'elle a besoin de ses produits.
  // Une requête pour tout l'écran, pas une par lot : un AO en porte couramment cinquante.
  const engagements = await loadEngagementsAilleurs(
    user, t.id, t.lines.map((l) => l.productId).filter((x): x is string => Boolean(x)),
  );
  const reserves: Record<string, string> = {};
  for (const [pid, e] of engagements) {
    const phrase = reserveEngagement(e);
    if (phrase) reserves[pid] = phrase;
  }
  const canEdit = userCan(user, "PCH", "UPDATE");
  // LES LECTURES DU DOCUMENT (lot D1c — F2) : ce que chaque lecture a fait, montré à qui peut en relancer une.
  const lectures = canEdit ? await lecturesDuMarche(t.id) : { liste: [], total: 0 };
  const canDelete = userCan(user, "PCH", "DELETE");
  const canUpload = userCan(user, "PCH", "UPLOAD");
  const canLegal = userCan(user, "LEGAL", "CREATE") && userCan(user, "LEGAL", "UPDATE");
  const cautionExpired = t.cautionEnd && new Date(t.cautionEnd) < new Date();
  const deadlineProche = market.tender.submissionDeadline
    && market.tender.submittedAt === null
    && new Date(market.tender.submissionDeadline).getTime() - Date.now() < 7 * 86_400_000;

  // Options du formulaire d'édition : responsables possibles (comptes actifs). Les BU sont déjà
  // chargées plus haut, pour le bloc d'affectations — les relire ici ferait deux requêtes pour la
  // même liste, et deux listes qui pourraient un jour diverger sur leur filtre.
  const usersOptions = await prisma.user.findMany({
    where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" },
  });

  // COURRIER PRÉ-ASSOCIÉ (§26-27) : le pli naît DEPUIS le marché, déjà rattaché — personne ne
  // ressaisit le lien. Le formulaire est celui du registre, à l'identique ; seuls le
  // rattachement (caché) et le destinataire (l'organisme) sont pré-remplis.
  const canMail = userCan(user, "MAIL_REGISTER", "CREATE");
  // La facture d'un bon reste une pièce FINANCES : le bouton n'apparaît qu'avec ce droit-là.
  const canInvoice = userCan(user, "FINANCES", "CREATE");
  const [mailCompanies, mailPartners, mailRouting, mailParties] = canMail
    ? await Promise.all([
        getMyCompanies(user.id),
        prisma.mailPartner.findMany({ where: { isActive: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } }),
        mailRoutingOptions(),
        // L'annuaire de l'entreprise : le destinataire du pli s'y choisit, comme au registre.
        listPartyOptions(user.id),
      ])
    : [[], [], { departments: [], people: [] }, []];
  const mailFormFields = canMail
    ? [
        ...mailFields(
          { recipient: t.client },
          "create",
          mailCompanies.map((c) => ({ value: c.id, label: companyLabel(c) })),
          mailPartners.map((x) => ({ value: x.id, label: x.kind ? `${x.name} — ${x.kind}` : x.name })),
          mailRouting.departments,
          mailRouting.people,
          [],
          { options: mailParties, canCreate: userCan(user, "GENERAL_MEANS", "CREATE") },
        ),
        { type: "hidden", name: "sourceType", value: "PCH_TENDER" } as const,
        { type: "hidden", name: "sourceId", value: t.id } as const,
      ]
    : [];

  const docs = await prisma.document.findMany({
    where: { entityType: "PCH_TENDER", entityId: t.id },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const docItems: DocItem[] = docs.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version,
    sizeBytes: d.sizeBytes, confidentiality: d.confidentiality,
    uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  return (
    <div className="space-y-5">
      <BackLink href="/pch">
        <ArrowLeft className="h-4 w-4" /> Marchés PCH
      </BackLink>
      <PageHeader
        title={`${t.reference}${t.title ? ` — ${t.title}` : ""}`}
        description={[
          market.tender.client,
          market.tender.responsible ? `Responsable : ${market.tender.responsible.name}` : null,
          market.tender.businessUnit ? `BU ${market.tender.businessUnit.name}` : null,
          market.tender.submissionDeadline && !market.tender.submittedAt
            ? `Dépôt avant le ${formatDate(market.tender.submissionDeadline.toString())}`
            : market.tender.submittedAt ? `Déposé le ${formatDate(market.tender.submittedAt.toString())}` : null,
        ].filter(Boolean).join(" · ")}
      >
        {/* LE NIVEAU DÉRIVÉ — pas un menu : les faits décident (annulé/suspendu restent des
            décisions, posées dans « Modifier »). L'infobulle dit d'où vient le verdict. */}
        <span title={market.niveau.raison}>
          <StatusBadge map={PCH_MARKET_NIVEAU} value={market.niveau.niveau} />
        </span>
        {deadlineProche && <Badge tone="danger" dot={false}>Échéance de dépôt sous 7 jours</Badge>}
        {canEdit && <EditTenderButton tender={t} canDelete={canDelete} users={usersOptions} businessUnits={businessUnits} />}
      </PageHeader>

      <MarketProgress etape={market.niveau.etape} />
      <MarketGaps manques={market.manques} />
      <MarketKpis finances={market.finances} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Info label="Organisme" value={t.client} />
            <Info label="Référence interne" value={market.tender.internalReference} />
            <Info label="Publié le" value={market.tender.publishedAt ? formatDate(market.tender.publishedAt.toString()) : null} />
            <Info label="Date limite de dépôt" value={market.tender.submissionDeadline ? formatDate(market.tender.submissionDeadline.toString()) : null} />
            <Info label="Déposé le" value={market.tender.submittedAt ? formatDate(market.tender.submittedAt.toString()) : null} />
            <Info label="Date d'attribution" value={t.awardDate ? formatDate(t.awardDate) : null} />
            <Info label="Produits" value={t.products} />
            <Info label="Quantité totale" value={formatNumber(t.quantity)} />
            <Info label="Valeur annoncée" value={t.value !== null ? formatCurrency(t.value) : null} />
            {t.notes && <div className="col-span-full"><p className="text-xs text-muted-foreground">Notes</p><p className="whitespace-pre-wrap">{t.notes}</p></div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Caution</CardTitle>
            <Badge tone={t.cautionDeposited ? (cautionExpired ? "danger" : "success") : "warning"} dot={false}>
              {t.cautionDeposited ? (cautionExpired ? "Expirée" : "Déposée") : "Non déposée"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Info label="Montant" value={t.cautionAmount !== null ? formatCurrency(t.cautionAmount) : null} />
            <Info label="Début de validité" value={t.cautionStart ? formatDate(t.cautionStart) : null} />
            <Info label="Fin de validité" value={t.cautionEnd ? formatDate(t.cautionEnd) : null} />
            {cautionExpired && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">⚠ Caution expirée — à renouveler.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <SubmissionPanel tenderId={t.id} soumissions={market.soumissions} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Documents — appel d&apos;offres &amp; pièces</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {docItems.length > 0 ? (
            <DocumentList documents={docItems} canDelete={canDelete || canUpload} canRename={canUpload} path={`/pch/${t.id}`} />
          ) : (
            <p className="text-sm text-muted-foreground">Aucun document. Téléversez l&apos;appel d&apos;offres (cahier des charges, PV d&apos;ouverture…) et les pièces liées.</p>
          )}
          {canUpload && <DocumentUpload entityType="PCH_TENDER" entityId={t.id} categories={["SUPPORTING_DOC", "PURCHASE_ORDER", "INVOICE", "OTHER"]} />}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <TenderLines tenderId={t.id} lines={t.lines} canEdit={canEdit} aiConfigured={aiConfigured()} reserves={reserves} lectures={lectures} />
        </CardContent>
      </Card>

      {/* QUI PORTE CHAQUE PRODUIT — le maillon entre le marché gagné et la force de vente.
          Placé JUSTE APRÈS les produits : c'est en lisant la liste des lots qu'on se demande à
          qui les confier, pas trois écrans plus bas. */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <AllocationsPanel
            tenderId={t.id}
            businessUnits={businessUnits}
            canEdit={canEdit}
            lines={t.lines.map((l) => ({
              id: l.id,
              designation: l.designation,
              status: l.status,
              businessUnitIds: affectations.filter((a) => a.tenderLineId === l.id).map((a) => a.businessUnitId),
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <ContractPanel
            tenderId={t.id}
            contrats={market.contrats}
            lignesAo={market.lignes.map((l) => ({ id: l.id, designation: l.designation, produitId: l.produit?.id ?? null }))}
            aDesGagnes={market.lignes.some((l) => l.status === "WON")}
            canPch={canEdit}
            canLegal={canLegal}
          />
        </CardContent>
      </Card>

      <OrdersManager tenderId={t.id} orders={t.orders} canEdit={canEdit} canDelete={canDelete} canInvoice={canInvoice} details={market.bons} contrats={market.contrats} />

      {t.orders.length > 0 && (
        <Card>
          <CardContent className="p-3 sm:p-4">
            <TenderLogistics tenderId={t.id} orders={t.orders} canEdit={canEdit} />
          </CardContent>
        </Card>
      )}

      {(market.courriers.length > 0 || canMail) && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Courriers du marché</CardTitle>
            {canMail && (
              <CreateRecordButton
                label="Nouveau courrier lié"
                title="Courrier du marché"
                description={`Le pli naît déjà rattaché à ${t.reference} — il apparaîtra ici et au registre des courriers.`}
                redirectBase="/courriers"
                action={createMailEntry}
                width="lg"
                fields={mailFormFields}
              />
            )}
          </CardHeader>
          <CardContent>
            {market.courriers.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucun courrier rattaché à ce marché.</p>
            )}
            <ul className="space-y-1.5">
              {market.courriers.map((c) => (
                <li key={c.id}>
                  <Link href={`/courriers/${c.id}`} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary">
                    <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{c.reference ? `${c.reference} — ` : ""}{c.title}</span>
                    <span className="text-xs text-muted-foreground">{c.direction === "OUTGOING" ? "sortant" : "entrant"}{c.date ? ` · ${formatDate(c.date.toString())}` : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {story && story.events.length > 1 && (
        <Card>
          <CardHeader><CardTitle>Frise du marché</CardTitle></CardHeader>
          <CardContent>
            <MarketTimeline story={story} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium [overflow-wrap:anywhere]">{value || "—"}</p></div>;
}
