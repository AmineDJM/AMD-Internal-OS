import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { PAYMENT_CENTRE_REFUSAL, type CentralStatus } from "@/modules/finances/partage";
import { chargerCentre, dossierHrefByOrder } from "@/modules/finances/api";
import { entityHref } from "@/lib/entity-href";
import { marquesDesOrdres } from "@/lib/factures/connues";
import { existingSources } from "@/lib/entity-exists";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { canAccessEntity } from "@/lib/entity-access";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { CentreBoard, type CentreOrder } from "./centre-board";
import { BarreEntites } from "./centre-navigation";
import { CompteursCentre, DecisionsDuCentre } from "./decisions-du-centre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de paiement — AMD Internal OS" };

/**
 * LE CENTRE DE PAIEMENT — le PDG, le Directeur Général et le Super Admin autorisent, la comptabilité exécute.
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
 * LA DISPOSITION : les ENTITÉS en haut (une pastille par société que la personne voit, avec ce qui
 * y attend), puis UNE file pour l'entité choisie — toutes origines confondues (Super Admin,
 * 24/11/2026 : « un même centre de paiement pour tout »). L'origine de chaque paiement reste dite
 * sur sa ligne (lien vers la demande d'origine). Un ancien lien `?section=` ouvre simplement cette file.
 */
export default async function CentreDePaiementPage(props: { searchParams?: Promise<{ entite?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();

  // Le chargeur lit les ordres que cet écran lisait déjà — tout le centre pour qui y siège, ses
  // propres demandes sinon — dans les sociétés auxquelles la personne a droit, les ordres SANS
  // société compris (`ficheScopedWhere` : une ligne sans entité reste visible pour qu'on la
  // rattache, §118.154). L'entité vient de l'adresse, VALIDÉE contre les pastilles réellement
  // présentes : une valeur forgée ne désigne rien. Sans paramètre, l'entité qui attend le plus.
  const centre = await chargerCentre(user, { entite: searchParams?.entite ?? null });
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

  // LES LIGNES DE L'ENTITÉ CHOISIE — les identifiants viennent du chargeur (portée et entité déjà
  // jugées) ; on les relit avec leurs liens, dans le même ordre.
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
  // LA MARQUE « DOUBLON POSSIBLE » de chaque paiement (Direction, 14/10/2026) — l'ordre, ses factures, le fil.
  const doublons = await marquesDesOrdres(orders.map((o) => o.id));

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
  const [produits, pieces, demandesDePiece] = await Promise.all([
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
    // LES PIÈCES RÉCLAMÉES DEPUIS LE CENTRE (« Demander une pièce », recette du 23/11/2026) et pas encore
    // closes : la carte dit ce qu'on attend et de qui — sans elle, le geste ne laissait aucune trace à
    // l'écran, et l'on redemandait la même facture.
    orders.length
      ? prisma.documentRequest.findMany({
          where: { entityType: "EXPENSE_ORDER", entityId: { in: orders.map((o) => o.id) }, status: { in: ["PENDING", "SUBMITTED"] } },
          select: { id: true, entityId: true, label: true, status: true, askedTo: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([] as { id: string; entityId: string; label: string; status: string; askedTo: { name: string } }[]),
  ]);
  const produitOuvrable = new Set(
    (await Promise.all(idsProduits.map(async (id) => ((await canAccessEntity(user, "REGULATORY_PRODUCT", id, "VIEW")) ? id : null))))
      .filter((v): v is string => Boolean(v)),
  );
  const produitDe = new Map(produits.map((p) => [p.id, p]));
  const piecesDe = new Map<string, { id: string; name: string }[]>();
  for (const d of pieces) piecesDe.set(d.entityId, [...(piecesDe.get(d.entityId) ?? []), { id: d.id, name: d.name }]);
  const demandesDe = new Map<string, CentreOrder["piecesDemandees"]>();
  for (const d of demandesDePiece) {
    demandesDe.set(d.entityId, [
      ...(demandesDe.get(d.entityId) ?? []),
      { id: d.id, label: d.label, a: d.askedTo?.name ?? null, deposee: d.status === "SUBMITTED" },
    ]);
  }
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
    doublonPossible: doublons.get(o.id) ?? null,
    pieces: piecesDe.get(o.id) ?? [],
    piecesDemandees: demandesDe.get(o.id) ?? [],
    isMine: o.requestedById === user.id,
    messages: o.centralMessages.map((m) => ({
      id: m.id, decision: m.decision, body: m.body,
      author: m.author?.name ?? null, createdAt: m.createdAt.toISOString(),
    })),
  }));

  const entite = centre.entites.find((e) => e.cle === centre.entiteChoisie) ?? null;
  const { bilan } = centre;
  // L'état de chaque ordre affiché, du MÊME rendu que le bilan : les compteurs n'ajoutent une décision
  // locale que tant que le serveur ne la reflète pas encore (`decisions-locales.ts`).
  const statuts = Object.fromEntries(rows.map((r) => [r.id, r.centralStatus])) as Record<string, CentralStatus>;

  return (
    <DecisionsDuCentre>
    <div className="space-y-5">
      <PageHeader
        title="Centre de paiement"
        description="Tous les paiements de l'entité, quelle que soit leur origine, s'autorisent ici avant d'atteindre les Finances : le centre AUTORISE ou REFUSE, la comptabilité exécute."
      >
        {/* L'EXPORT DE CE QUE L'ÉCRAN MONTRE — l'entité choisie, toutes les lignes (K7, décision 0037). */}
        <a
          href={`/api/finances/centre/export?entite=${encodeURIComponent(centre.entiteChoisie ?? "")}`}
          className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8"
        >Exporter</a>
      </PageHeader>

      <BarreEntites entites={centre.entites} choisie={centre.entiteChoisie} />

      {/* Les compteurs suivent AUSSITÔT une décision prise ici (`decisions-du-centre.tsx`). */}
      <CompteursCentre bilan={bilan} statuts={statuts} entite={entite?.label ?? null} />

      <CentreBoard
        orders={rows} canDecide={canDecide}
        titre={entite?.label ?? "Entité"}
        total={entite?.total ?? rows.length} nonAffiches={centre.nonAffiches}
      />
    </div>
    </DecisionsDuCentre>
  );
}
