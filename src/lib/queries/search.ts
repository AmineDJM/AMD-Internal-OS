import type { SessionUser } from "@/lib/rbac";
import { Prisma, type LegalDocKind } from "@prisma/client";
import { natureDuMot } from "@/lib/legal/classement";
import { natureLegale } from "@/lib/labels";
import { userCan, hasGlobalView, scopeBusinessDevelopment, regulatoryLockWhere } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { accessibleDocumentWhere } from "@/lib/queries/documents";
import { clausePraticiensVisibles } from "@/lib/queries/annuaires";
import { clauseDirectivesVisibles } from "@/lib/queries/directives";
import { clauseTachesVisibles } from "@/lib/tasks/request-flow";
import {
  clauseBonsDeCommandePchVisibles, clauseCommandesLogistiqueVisibles, clauseCongresInternationauxVisibles,
  clauseCongresNationauxVisibles, clauseConversationsVisibles, clauseCourriersVisibles, clauseDemandesSecretariatVisibles,
  clauseEcrituresVisibles, clauseEvenementsVisibles, clauseMarchesPchVisibles, clauseMessagesVisibles,
  clauseSalariesVisibles, clauseSponsoringsVisibles, clauseVentesVisibles, perimetreLegal,
} from "@/lib/queries/visibilite-listes";

export interface SearchResult {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  href: string;
  icon: string;
}

/**
 * RECHERCHE GLOBALE multi-modules, RBAC-aware et MULTI-TERMES : ne requête que les modules que
 * l'utilisateur peut voir, et exige que CHAQUE mot de la requête apparaisse dans au moins un champ
 * (ET des mots, OU des champs) → « module 2 amox » retrouve un dossier même si les mots sont dans
 * des champs différents. Couvre dossiers CTD, demandes du secrétariat, discussions, congrès,
 * événements, directives, en plus des objets métier. Alimente la palette ⌘K et la page /search.
 *
 * ── ELLE CHERCHE DANS CE QUE L'ÉCRAN MONTRE, ET NULLE PART AILLEURS (§118.177) ──────────────
 *
 * Chaque famille lit la CLAUSE DE SA LISTE — `regulatoryVisibleWhere`, `visibilite-listes.ts`,
 * `accessibleDocumentWhere`… —, jamais une portée recomposée ici. Elle en composait sa propre
 * version, et quinze familles sur vingt-trois montraient les lignes des autres sociétés du
 * groupe ; les dossiers CTD sortaient sans la permission du module ni l'entité où il est activé,
 * les directives sans leur publication, les messages des groupes qu'on avait quittés. Aucune
 * construction de portée ne doit réapparaître dans ce fichier : `visibilite-listes.test.ts` le
 * vérifie, et rejoue chaque famille avec un lecteur sans vue globale.
 */
export async function globalSearch(user: SessionUser, q: string, perGroup = 6): Promise<SearchResult[]> {
  const raw = q.trim();
  if (raw.length < 2) return [];
  // Mots saillants (≥ 2 caractères, max 6) — la recherche exige TOUS les mots (robustesse).
  const terms = raw.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 6);
  const search = terms.length > 0 ? terms : [raw];
  const take = perGroup;

  /** ET des mots × OU des champs — renvoyé en tableau à insérer dans un `AND`. */
  const match = (fields: string[]) =>
    search.map((t) => ({ OR: fields.map((f) => ({ [f]: { contains: t, mode: "insensitive" } })) }));

  const driveAll = user.role === "SUPER_ADMIN" || user.access.modules.get("DRIVE")?.scope === "ALL";
  const canMessaging = userCan(user, "MESSAGING", "VIEW");
  // Les dossiers CTD : la porte de l'écran est TRIPLE — le module Regulatory, la permission du
  // module CTD, et l'organisation où il est activé, résolue pour CETTE personne.
  const ctdCompanyId = userCan(user, "REGULATORY", "VIEW") && regCan(user, "regulatory.workspace.view")
    ? await resolveRegCompanyIdFor(user.id)
    : null;
  const legal = await perimetreLegal(user);

  const [
    regulatory, dossiers, sponsoring, finances, employees, sales, logistics, doctors, bd, drive, documents, tasks,
    adminReqs, congressIntl, congressNat, events, directives, conversations, messages,
    tenders, pchOrders, legalDocs, mailEntries,
  ] = await Promise.all([
    // Le suivi OU le pipeline (Direction, 08/10) : la clause ne rend que la moitié que chaque module ouvre.
    userCan(user, "REGULATORY", "VIEW") || userCan(user, "REGULATORY_PIPELINE", "VIEW")
      ? prisma.regulatoryProduct.findMany({ where: { AND: [await regulatoryVisibleWhere(user) as Prisma.RegulatoryProductWhereInput, ...(match(["dci", "reference", "brandName", "partnerLab", "manufacturer"]) as Prisma.RegulatoryProductWhereInput[])] }, take, select: { id: true, dci: true, reference: true, brandName: true } })
      : [],
    ctdCompanyId
      ? prisma.regulatoryDossier.findMany({ where: { AND: [{ companyId: ctdCompanyId }, ...(match(["reference", "title"]) as Prisma.RegulatoryDossierWhereInput[])] }, take, select: { id: true, reference: true, title: true } })
      : [],
    userCan(user, "SPONSORING", "VIEW")
      ? prisma.sponsoringRequest.findMany({ where: { AND: [await clauseSponsoringsVisibles(user), ...(match(["institution", "reference", "doctor"]) as Prisma.SponsoringRequestWhereInput[])] }, take, select: { id: true, institution: true, reference: true } })
      : [],
    userCan(user, "FINANCES", "VIEW")
      ? prisma.financeTransaction.findMany({ where: { AND: [await clauseEcrituresVisibles(user.id), ...(match(["label", "reference", "counterparty"]) as Prisma.FinanceTransactionWhereInput[])] }, take, select: { id: true, label: true, reference: true } })
      : [],
    userCan(user, "EMPLOYEES", "VIEW")
      ? prisma.employee.findMany({ where: { AND: [await clauseSalariesVisibles(user.id), ...(match(["fullName", "position", "department"]) as Prisma.EmployeeWhereInput[])] }, take, select: { id: true, fullName: true, position: true } })
      : [],
    userCan(user, "SALES", "VIEW")
      ? prisma.sale.findMany({ where: { AND: [await clauseVentesVisibles(user), ...(match(["product", "client"]) as Prisma.SaleWhereInput[])] }, take, select: { id: true, product: true, client: true } })
      : [],
    userCan(user, "LOGISTICS", "VIEW")
      ? prisma.logisticsOrder.findMany({ where: { AND: [await clauseCommandesLogistiqueVisibles(user.id), ...(match(["product", "reference", "supplier"]) as Prisma.LogisticsOrderWhereInput[])] }, take, select: { id: true, product: true, reference: true } })
      : [],
    userCan(user, "MEDICAL", "VIEW")
      ? prisma.medicalDoctor.findMany({ where: { AND: [await clausePraticiensVisibles(user, { entier: false }), ...(match(["name", "institution", "city"]) as Prisma.MedicalDoctorWhereInput[])] }, take, select: { id: true, name: true, specialty: true } })
      : [],
    userCan(user, "BUSINESS_DEVELOPMENT", "VIEW")
      ? prisma.businessDevelopmentOpportunity.findMany({ where: { AND: [scopeBusinessDevelopment(user), ...(match(["name", "dci"]) as Prisma.BusinessDevelopmentOpportunityWhereInput[])] }, take, select: { id: true, name: true, dci: true } })
      : [],
    userCan(user, "DRIVE", "VIEW")
      ? prisma.driveNode.findMany({ where: { AND: [{ isTrashed: false, type: "FILE" }, driveAll ? {} : { OR: [{ ownerId: user.id }, { shares: { some: { userId: user.id } } }] }, ...(match(["name"]) as Prisma.DriveNodeWhereInput[])] }, take, select: { id: true, name: true, mimeType: true } })
      : [],
    userCan(user, "DOCUMENTS", "VIEW")
      ? prisma.document.findMany({ where: { AND: [await accessibleDocumentWhere(user), ...(match(["name"]) as Prisma.DocumentWhereInput[])] }, take, select: { id: true, name: true, category: true } })
      : [],
    userCan(user, "WORKSPACE", "VIEW")
      ? prisma.task.findMany({ where: { AND: [clauseTachesVisibles(user.id, hasGlobalView(user.role)), ...(match(["title", "description"]) as Prisma.TaskWhereInput[])] }, take, select: { id: true, title: true, status: true } })
      : [],
    userCan(user, "ADMIN_REQUESTS", "VIEW")
      ? prisma.administrativeRequest.findMany({ where: { AND: [await clauseDemandesSecretariatVisibles(user), ...(match(["reference", "title", "description"]) as Prisma.AdministrativeRequestWhereInput[])] }, take, select: { id: true, reference: true, title: true } })
      : [],
    userCan(user, "CONGRESS_INTERNATIONAL", "VIEW")
      ? prisma.congressInternational.findMany({ where: { AND: [await clauseCongresInternationauxVisibles(user), ...(match(["name", "city", "specialty"]) as Prisma.CongressInternationalWhereInput[])] }, take, select: { id: true, name: true, city: true } })
      : [],
    userCan(user, "CONGRESS_NATIONAL", "VIEW")
      ? prisma.congressNational.findMany({ where: { AND: [await clauseCongresNationauxVisibles(user), ...(match(["name", "city", "specialty"]) as Prisma.CongressNationalWhereInput[])] }, take, select: { id: true, name: true, city: true } })
      : [],
    userCan(user, "EVENTS", "VIEW")
      ? prisma.event.findMany({ where: { AND: [await clauseEvenementsVisibles(user.id), ...(match(["name", "location", "city", "specialty"]) as Prisma.EventWhereInput[])] }, take, select: { id: true, name: true, city: true } })
      : [],
    userCan(user, "DIRECTIVES", "VIEW")
      ? prisma.directive.findMany({ where: { AND: [await clauseDirectivesVisibles(user), ...(match(["reference", "title", "body"]) as Prisma.DirectiveWhereInput[])] }, take, select: { id: true, reference: true, title: true } })
      : [],
    // Discussions : canaux/groupes nommés dont l'utilisateur est membre ACTIF.
    canMessaging
      ? prisma.conversation.findMany({ where: { AND: [clauseConversationsVisibles(user.id), ...(match(["title", "description"]) as Prisma.ConversationWhereInput[])] }, take, select: { id: true, title: true } })
      : [],
    // Discussions : messages (contenu) dans les conversations dont l'utilisateur est membre ACTIF.
    canMessaging
      ? prisma.message.findMany({ where: { AND: [clauseMessagesVisibles(user.id), ...(match(["body"]) as Prisma.MessageWhereInput[])] }, take, orderBy: { createdAt: "desc" }, select: { id: true, body: true, conversationId: true, conversation: { select: { title: true } } } })
      : [],
    // MARCHÉS PCH (§44) : un AO se retrouve par sa référence (externe OU interne), son intitulé,
    // ses produits ou son organisme — le point d'entrée de toute la chaîne marché.
    userCan(user, "PCH", "VIEW")
      ? prisma.pchTender.findMany({ where: { AND: [await clauseMarchesPchVisibles(user.id), ...(match(["reference", "internalReference", "title", "products", "client"]) as Prisma.PchTenderWhereInput[])] }, take, select: { id: true, reference: true, title: true, client: true } })
      : [],
    // Les BONS DE COMMANDE mènent à la fiche de LEUR marché — pas d'écran BC isolé.
    userCan(user, "PCH", "VIEW")
      ? prisma.pchOrder.findMany({ where: { AND: [await clauseBonsDeCommandePchVisibles(user.id), ...(match(["reference", "products"]) as Prisma.PchOrderWhereInput[])] }, take, select: { id: true, reference: true, products: true, tenderId: true, tender: { select: { reference: true } } } })
      : [],
    // LEGAL : la portée de la personne (tout le registre, ou la chaîne d'achat seule pour les
    // Finances), les LECTEURS désignés et l'entité — un document restreint ne se découvre pas par
    // la palette de recherche.
    // Chaque mot se lit aussi dans le DOSSIER de classement et son parent (« BC cardiologie » : le BC rangé sous
    // « Événements › 2026 › Journée de cardiologie »), et « BC », « facture », « devis » désignent la nature (23/11/2026).
    legal.where
      ? prisma.legalDocument.findMany({
          where: {
            AND: [legal.where, ...search.map((t): Prisma.LegalDocumentWhereInput => {
              const kind = natureDuMot(t);
              return {
                OR: [
                  ...(["title", "reference", "counterparty"] as const).map((f) => ({ [f]: { contains: t, mode: "insensitive" as const } })),
                  { folder: { name: { contains: t, mode: "insensitive" } } },
                  { folder: { parent: { name: { contains: t, mode: "insensitive" } } } },
                  ...(kind ? [{ kind: kind as LegalDocKind }] : []),
                ],
              };
            })],
          },
          take,
          select: { id: true, title: true, reference: true, kind: true, folder: { select: { name: true } } },
        })
      : [],
    userCan(user, "MAIL_REGISTER", "VIEW")
      ? prisma.mailEntry.findMany({ where: { AND: [await clauseCourriersVisibles(user.id), ...(match(["title", "reference", "sender", "recipient"]) as Prisma.MailEntryWhereInput[])] }, take, select: { id: true, title: true, reference: true } })
      : [],
  ]);

  const out: SearchResult[] = [];
  for (const r of regulatory) out.push({ id: r.id, group: "Regulatory", title: r.dci, subtitle: [r.reference, r.brandName].filter(Boolean).join(" · "), href: `/regulatory/${r.id}`, icon: "FileCheck2" });
  for (const r of dossiers) out.push({ id: r.id, group: "Dossiers CTD", title: r.title, subtitle: r.reference, href: `/regulatory/enregistrement/analyse/${r.id}`, icon: "FolderSearch" });
  for (const r of sponsoring) out.push({ id: r.id, group: "Sponsoring", title: r.institution, subtitle: r.reference, href: `/sponsoring/${r.id}`, icon: "HandCoins" });
  for (const r of finances) out.push({ id: r.id, group: "Finances", title: r.label, subtitle: r.reference, href: `/finances`, icon: "Landmark" });
  for (const r of employees) out.push({ id: r.id, group: "RH", title: r.fullName, subtitle: r.position ?? "", href: `/rh/${r.id}`, icon: "UsersRound" });
  for (const r of sales) out.push({ id: r.id, group: "Ventes", title: r.product, subtitle: r.client, href: `/sales/historique`, icon: "TrendingUp" });
  for (const r of logistics) out.push({ id: r.id, group: "Logistique PCH", title: r.product, subtitle: r.reference, href: `/logistics/${r.id}`, icon: "Truck" });
  for (const r of doctors) out.push({ id: r.id, group: "Annuaire", title: r.name, subtitle: r.specialty ?? "", href: `/praticiens/${r.id}`, icon: "Stethoscope" });
  for (const r of bd) out.push({ id: r.id, group: "Business Development", title: r.name, subtitle: r.dci ?? "", href: `/business-development`, icon: "Lightbulb" });
  for (const r of drive) out.push({ id: r.id, group: "Drive", title: r.name, subtitle: r.mimeType ?? "", href: `/drive/${r.id}`, icon: "HardDrive" });
  for (const r of documents) out.push({ id: r.id, group: "Documents", title: r.name, subtitle: "Télécharger", href: `/api/documents/${r.id}`, icon: "FolderOpen" });
  for (const r of tasks) out.push({ id: r.id, group: "Mes tâches", title: r.title, subtitle: r.status, href: `/mon-espace/taches/${r.id}`, icon: "ListTodo" });
  for (const r of adminReqs) out.push({ id: r.id, group: "Bureau du secrétariat", title: r.title, subtitle: r.reference, href: `/demandes/${r.id}`, icon: "ClipboardList" });
  for (const r of congressIntl) out.push({ id: r.id, group: "Prise en charge Internationale", title: r.name, subtitle: r.city ?? "", href: `/congress-international/${r.id}`, icon: "Globe" });
  for (const r of congressNat) out.push({ id: r.id, group: "Prise en charge Nationale", title: r.name, subtitle: r.city ?? "", href: `/congress-national/${r.id}`, icon: "MapPin" });
  for (const r of events) out.push({ id: r.id, group: "Événements", title: r.name, subtitle: r.city ?? "", href: `/events/${r.id}`, icon: "CalendarDays" });
  for (const r of directives) out.push({ id: r.id, group: "Directives", title: r.title, subtitle: r.reference, href: `/directives`, icon: "Megaphone" });
  for (const r of conversations) out.push({ id: r.id, group: "Discussions", title: r.title ?? "Conversation", subtitle: "Canal / groupe", href: `/messages?c=${r.id}`, icon: "MessagesSquare" });
  for (const r of messages) out.push({ id: r.id, group: "Discussions", title: (r.conversation?.title ?? "Message"), subtitle: r.body.slice(0, 80), href: `/messages?c=${r.conversationId}`, icon: "MessageCircle" });
  for (const r of tenders) out.push({ id: r.id, group: "Marchés PCH", title: r.reference, subtitle: [r.title, r.client].filter(Boolean).join(" · "), href: `/pch/${r.id}`, icon: "Gavel" });
  for (const r of pchOrders) out.push({ id: r.id, group: "Marchés PCH", title: `BC ${r.reference ?? "s/n"}`, subtitle: [r.tender.reference, r.products].filter(Boolean).join(" · "), href: `/pch/${r.tenderId}`, icon: "ReceiptText" });
  // La demande où la pièce est rangée se lit dans le sous-titre : on sait à quel événement est ce BC.
  for (const r of legalDocs) out.push({ id: r.id, group: "Legal", title: r.title, subtitle: [r.reference ?? natureLegale(r.kind), r.folder?.name].filter(Boolean).join(" · "), href: `/legal/${r.id}`, icon: "Scale" });
  for (const r of mailEntries) out.push({ id: r.id, group: "Courriers", title: r.title, subtitle: r.reference ?? "", href: `/courriers/${r.id}`, icon: "Mails" });
  out.push(...(await rechercheReliee(user, match, take)));
  return out;
}

/**
 * LES OBJETS CENTRAUX (cahier des charges §58) — « Raltégravir » retrouve LE produit (une seule identité, ouverte
 * sur sa vue 360°), les BU et les stratégies de segmentation. La porte est celle de leur écran : un produit à qui
 * a le module Produits, une BU à qui a la Force de vente, une stratégie à qui a le
 * Segmentation Studio.
 */
async function rechercheReliee(
  user: SessionUser,
  match: (fields: string[]) => { OR: Record<string, unknown>[] }[],
  take: number,
): Promise<SearchResult[]> {
  const voitProduits = userCan(user, "PRODUCTS", "VIEW");
  const [produits, bus, strategies] = await Promise.all([
    voitProduits
      // UN SEUL CATALOGUE (Produits 360, 07/10) : commercialisés ET en enregistrement — sauf les dossiers verrouillés.
      ? prisma.product.findMany({ where: { AND: [{ isActive: true }, { regulatoryProfiles: { some: regulatoryLockWhere(user) } }, { OR: [{ AND: match(["canonicalName", "dci", "code"]) as Prisma.ProductWhereInput[] }, { aliases: { some: { AND: match(["label"]) as Prisma.ProductAliasWhereInput[] } } }] }] }, take, select: { id: true, canonicalName: true, code: true, dci: true } })
      : [],
    userCan(user, "SALES_PLANNING", "VIEW")
      ? prisma.businessUnit.findMany({ where: { AND: [{ isActive: true }, ...(match(["name", "code"]) as Prisma.BusinessUnitWhereInput[])] }, take, select: { id: true, name: true, code: true } })
      : [],
    userCan(user, "SEGMENTATION", "VIEW")
      ? prisma.segmentationStrategie.findMany({ where: { AND: [{ statut: "ACTIVE" }, { OR: [{ AND: match(["nom"]) as Prisma.SegmentationStrategieWhereInput[] }, { produits: { some: { jusqua: null, product: { AND: match(["canonicalName", "dci"]) as Prisma.ProductWhereInput[] } } } }] }] }, take, select: { id: true, nom: true, businessUnit: { select: { name: true } } } })
      : [],
  ]);
  return [
    ...produits.map((r) => ({ id: r.id, group: "Produits", title: r.canonicalName, subtitle: [r.code, r.dci].join(" · "), href: `/produits/${r.id}`, icon: "Pill" })),
    ...bus.map((r) => ({ id: r.id, group: "Business Units", title: r.name, subtitle: r.code ?? "Cockpit de la BU", href: `/business-units/${r.id}`, icon: "Building2" })),
    ...strategies.map((r) => ({ id: r.id, group: "Segmentation", title: r.nom, subtitle: `BU ${r.businessUnit.name}`, href: `/segmentation?s=${r.id}`, icon: "Layers" })),
  ];
}
