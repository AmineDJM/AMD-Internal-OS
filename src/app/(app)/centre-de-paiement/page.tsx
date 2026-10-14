import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { CENTRAL_AUTH_THRESHOLD_DZD, PAYMENT_CENTRE_REFUSAL, type CentralStatus } from "@/lib/payments/authorization";
import { SECTION_CENTRE_LABEL } from "@/lib/payments/sections-centre";
import { chargerCentre } from "@/lib/queries/centre-paiement";
import { entityHref } from "@/lib/entity-href";
import { dossierHrefByOrder } from "@/lib/expense-orders";
import { existingSources } from "@/lib/entity-exists";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { canAccessEntity } from "@/lib/entity-access";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { CentreBoard, type CentreOrder } from "./centre-board";
import { BarreEntites, OngletsSections } from "./centre-navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de paiement — AMD Internal OS" };

/**
 * LE CENTRE DE PAIEMENT — le PDG et le Super Admin autorisent, la comptabilité exécute.
 *
 * AUCUN décaissement ne quitte les Finances sans passer par ici, quel que soit son montant —
 * « Concernant les paiements, c'est clair, tous passent par le centre de paiements » (Direction,
 * 09/2026). Le seuil de 50 000 DZD et l'exemption des moyens généraux ont disparu depuis
 * longtemps du CODE (`needsCentralAuthorization` rend toujours vrai) ; cet en-tête, lui, les
 * annonçait encore — et c'est lui qu'on lit en premier (§118.148). Le seuil survit comme un
 * MARQUEUR qui trie la file (`isHighValue`), jamais comme un filtre.
 *
 * Ce qui décaisse SANS ordre de dépense — la paie, la caisse d'avance — ne passe pas par ici :
 * ces exceptions sont ASSUMÉES par la Direction (28/09/2026), et chacune porte sa décision écrite
 * dans le registre des chemins de paiement (`finances/settlement.ts`, `horsCentre()`).
 *
 * L'écran est ouvert au CENTRE (qui décide) et au DEMANDEUR (qui répond quand on lui rend la
 * main) : les Finances, elles, n'ont rien à faire ici — un paiement leur arrive une fois autorisé.
 *
 * Le CENTRE, ce sont les deux rôles du sommet **et les personnes nommément désignées** (siège
 * nommé, `PaymentCentreSeat`). Qui n'y siège pas ne reçoit plus une page blanche : il lit ce qui
 * lui manque et par quel geste on l'y fait entrer.
 *
 * LA DISPOSITION (§118.211) : les ENTITÉS en haut (une pastille par société que la personne voit,
 * avec ce qui y attend), puis, sous l'entité choisie, trois sections — Regulatory, Sales &
 * Marketing, Autres — rangées d'après l'ORIGINE de la dépense (`payments/sections-centre.ts`).
 */
export default async function CentreDePaiementPage({ searchParams }: { searchParams?: { entite?: string; section?: string } }) {
  const user = await requireUser();

  // Le chargeur lit les ordres que cet écran lisait déjà — tout le centre pour qui y siège, ses
  // propres demandes sinon — dans les sociétés auxquelles la personne a droit, les ordres SANS
  // société compris (`ficheScopedWhere` : une ligne sans entité reste visible pour qu'on la
  // rattache, §118.154). L'entité et la section viennent de l'adresse, VALIDÉES contre les
  // pastilles réellement présentes : une valeur forgée ne désigne rien. Les anciens liens
  // (`/centre-de-paiement` sans paramètre) ouvrent l'entité qui attend le plus de décisions.
  const centre = await chargerCentre(user, { entite: searchParams?.entite ?? null, section: searchParams?.section ?? null });
  const { canDecide } = centre;

  // ── ON NE REND PLUS UN ÉCRAN MUET ────────────────────────────────────────────────────────
  //
  // Ici vivait un `notFound()` : quiconque n'était ni membre du centre ni demandeur tombait sur
  // une page blanche. C'est ce qu'on a vu — un Directeur Général à qui l'on croyait avoir donné
  // l'accès (module coché, « autre rôle » posé) et qui trouvait le vide, sans une ligne pour lui
  // dire ce qui manquait. Une page qui ne s'explique pas se lit comme une panne, et l'on cherche
  // le défaut ailleurs pendant des jours.
  //
  // On DIT donc la règle : qui siège, pourquoi vous n'y siégez pas, et le geste exact qui vous y
  // fait entrer. Rien n'est divulgué au passage — aucun paiement n'est chargé pour qui n'a pas le
  // droit de les voir, la requête du chargeur s'en est chargée.
  if (!canDecide && centre.aucunOrdre) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Centre de paiement"
          description="L'écran où les paiements de la société sont autorisés, avant d'atteindre les Finances."
        />
        <EmptyState
          icon="ShieldAlert"
          title="Vous ne siégez pas au centre de paiement"
          description={PAYMENT_CENTRE_REFUSAL}
        />
        <p className="text-center text-xs text-muted-foreground">
          Cocher le module « Centre de paiement » dans la grille des accès ne suffit pas, et poser un « autre rôle »
          non plus : le siège se donne <strong>par votre nom</strong>, depuis Administration → Accès → « Qui siège au
          centre de paiement ».
        </p>
      </div>
    );
  }

  // LES LIGNES DE LA SECTION CHOISIE — les identifiants viennent du chargeur (portée, entité,
  // section déjà jugées) ; on les relit avec leurs liens, dans le même ordre.
  const lus = centre.idsAffiches.length
    ? await prisma.expenseOrder.findMany({
        where: { id: { in: centre.idsAffiches } },
        include: {
          requestedBy: { select: { name: true } },
          company: { select: { name: true, shortName: true } },
          centralMessages: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } },
        },
      })
    : [];
  const rang = new Map(centre.idsAffiches.map((id, i) => [id, i]));
  const orders = lus.sort((a, b) => (rang.get(a.id) ?? 0) - (rang.get(b.id) ?? 0));

  const decidedByIds = [...new Set(orders.map((o) => o.centralDecidedById).filter((v): v is string => Boolean(v)))];
  const deciders = decidedByIds.length
    ? await prisma.user.findMany({ where: { id: { in: decidedByIds } }, select: { id: true, name: true } })
    : [];
  const deciderName = new Map(deciders.map((d) => [d.id, d.name]));

  // LE DOSSIER DE CHAQUE PAIEMENT — pièces, demandes de pièces, discussion. Le centre autorise
  // une sortie d'argent : sans pouvoir ouvrir la facture, il autorise une ligne de tableau.
  // Tout ordre en porte un désormais, quelle que soit sa provenance (`createExpenseOrder`).
  const dossiers = await dossierHrefByOrder(orders.map((o) => o.id));

  // LA SOURCE EXISTE-T-ELLE ENCORE ? Un ordre survit à la demande, au congrès ou au sponsoring
  // qui l'a fait naître ; `entityHref` en ferait un lien ordinaire vers une page 404 — l'audit
  // navigateur en a compté cinquante ici. Une requête par type, et le lien n'est proposé que
  // pour ce qui s'ouvre vraiment ; le reste est DIT (« source supprimée »), pas caché.
  const sourceVivante = await existingSources(orders.map((o) => ({ type: o.sourceType, id: o.sourceId })));

  // LE PRODUIT D'OÙ VIENT UN BV (« Demande du BV 25 % » cliquée sur l'étape du dossier) — et les
  // PIÈCES jointes à l'ordre par le demandeur. Le centre arbitre entre les BV de plusieurs dossiers :
  // « BV 25 % — REG-2026-014 » ne dit pas de quel médicament il s'agit. Le lien vers le dossier n'est
  // proposé qu'à qui peut l'ouvrir ; le nom, lui, se lit toujours.
  const idsProduits = [...new Set(orders.filter((o) => o.sourceType === "REGULATORY_PRODUCT" && o.sourceId).map((o) => o.sourceId!))];
  const [produits, pieces] = await Promise.all([
    idsProduits.length
      ? prisma.regulatoryProduct.findMany({ where: { id: { in: idsProduits } }, select: { id: true, reference: true, dci: true, brandName: true } })
      : Promise.resolve([] as { id: string; reference: string; dci: string; brandName: string | null }[]),
    orders.length
      ? prisma.document.findMany({
          where: { entityType: "EXPENSE_ORDER", entityId: { in: orders.map((o) => o.id) } },
          select: { id: true, name: true, entityId: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([] as { id: string; name: string; entityId: string }[]),
  ]);
  const produitOuvrable = new Set(
    (await Promise.all(idsProduits.map(async (id) => ((await canAccessEntity(user, "REGULATORY_PRODUCT", id, "VIEW")) ? id : null))))
      .filter((v): v is string => Boolean(v)),
  );
  const produitDe = new Map(produits.map((p) => [p.id, p]));
  const piecesDe = new Map<string, { id: string; name: string }[]>();
  for (const d of pieces) piecesDe.set(d.entityId, [...(piecesDe.get(d.entityId) ?? []), { id: d.id, name: d.name }]);
  const produitDeLOrdre = (o: (typeof orders)[number]): CentreOrder["produit"] => {
    const p = o.sourceType === "REGULATORY_PRODUCT" && o.sourceId ? produitDe.get(o.sourceId) : undefined;
    if (!p) return null;
    const nature = natureDeLOrdreBv(o);
    return {
      reference: p.reference, nom: p.brandName?.trim() || p.dci, dci: p.dci,
      nature: nature ? LIBELLE_NATURE_BV[nature] : null,
      href: produitOuvrable.has(p.id) ? `/regulatory/${p.id}` : null,
    };
  };

  const rows: CentreOrder[] = orders.map((o) => ({
    id: o.id,
    reference: o.reference,
    label: o.label,
    beneficiary: o.beneficiary,
    amount: toNumber(o.amount),
    proposedAmount: o.centralProposedAmount ? toNumber(o.centralProposedAmount) : null,
    centralStatus: o.centralStatus as CentralStatus,
    requestedBy: o.requestedBy?.name ?? null,
    companyLabel: o.company ? o.company.shortName ?? o.company.name : null,
    createdAt: o.createdAt.toISOString(),
    decidedBy: o.centralDecidedById ? deciderName.get(o.centralDecidedById) ?? null : null,
    decidedAt: o.centralDecidedAt?.toISOString() ?? null,
    dueDate: o.dueDate?.toISOString() ?? null,
    deadlineNature: o.deadlineNature,
    // LE TITRE OUVRE LE DOSSIER DU PAIEMENT — ses pièces, ses demandes de pièces, son fil. C'est
    // ce que le centre doit lire pour autoriser : la facture, le bon, la discussion. Il existe
    // maintenant pour TOUS les ordres, et non pour la seule demande de paiement.
    dossierHref: dossiers.get(o.id) ?? null,
    // ET LA DEMANDE D'ORIGINE RESTE ATTEIGNABLE, à côté — le sponsoring, le matériel
    // promotionnel, le dossier réglementaire. Deux objets distincts, deux liens : le dossier dit
    // ce qui justifie le paiement, l'origine dit ce qu'on achète. `entityHref` porte la table des
    // routes, et ce qu'elle ne sait pas ouvrir est DIT (voir `sourceLabel`).
    sourceHref: sourceVivante(o.sourceType, o.sourceId) ? entityHref(o.sourceType, o.sourceId) : null,
    sourceLabel: o.sourceType
      ? `${ENTITY_TYPE_LABELS[o.sourceType] ?? o.sourceType}${o.sourceId && !sourceVivante(o.sourceType, o.sourceId) ? " (source supprimée)" : ""}`
      : null,
    produit: produitDeLOrdre(o),
    note: o.notes?.trim() || null,
    pieces: piecesDe.get(o.id) ?? [],
    isMine: o.requestedById === user.id,
    messages: o.centralMessages.map((m) => ({
      id: m.id, decision: m.decision, body: m.body,
      author: m.author?.name ?? null, createdAt: m.createdAt.toISOString(),
    })),
  }));

  const entite = centre.entites.find((e) => e.cle === centre.entiteChoisie) ?? null;
  const section = centre.sections.find((s) => s.section === centre.sectionChoisie)!;
  const { bilan } = centre;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Centre de paiement"
        description={`Tout paiement de la société est autorisé ici avant d'atteindre les Finances, quel que soit son montant — ceux à partir de ${CENTRAL_AUTH_THRESHOLD_DZD.toLocaleString("fr-FR")} DZD en tête de file. Le centre autorise, la comptabilité exécute : c'est la séparation des deux gestes qui rend le contrôle réel. Le centre AUTORISE ou REFUSE — le montant et sa justification appartiennent à la demande et se corrigent avant d'arriver ici (décision de la Direction, 02/09/2026). Un refus dit toujours pourquoi : son motif reste dans le fil, que le demandeur lit sur sa propre ligne. On change d'entité en haut ; chaque entité range ses paiements en trois sections — Regulatory, Sales & Marketing, Autres — d'après l'origine de la dépense.`}
      />

      <BarreEntites entites={centre.entites} choisie={centre.entiteChoisie} section={centre.sectionChoisie} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="En attente" value={bilan.enAttente} icon="Hourglass" tone={bilan.enAttente > 0 ? "warning" : "default"} hint={entite?.label} />
        <KpiCard label="Montant en attente" value={formatCurrency(bilan.montantEnAttente)} icon="Coins" tone={bilan.enAttente > 0 ? "warning" : "default"} />
        <KpiCard label="Autorisés" value={bilan.autorises} icon="ShieldCheck" tone="success" />
        <KpiCard label="Refusés" value={bilan.refuses} icon="ShieldX" tone={bilan.refuses > 0 ? "danger" : "default"} />
      </div>

      <OngletsSections sections={centre.sections} choisie={centre.sectionChoisie} entite={centre.entiteChoisie} />

      {section.repli > 0 && (
        <p className="text-xs text-muted-foreground">
          {section.repli} paiement{section.repli > 1 ? "s" : ""} de cette section n&apos;{section.repli > 1 ? "ont" : "a"} pas d&apos;origine lisible
          (aucune demande rattachée) : {section.repli > 1 ? "ils sont rangés" : "il est rangé"} ici faute de mieux, non parce que l&apos;origine le décide.
        </p>
      )}

      <CentreBoard
        orders={rows} canDecide={canDecide}
        titre={`${entite?.label ?? "Entité"} — ${SECTION_CENTRE_LABEL[centre.sectionChoisie]}`}
        total={section.total} nonAffiches={centre.nonAffiches}
      />
    </div>
  );
}
