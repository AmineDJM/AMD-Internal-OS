import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { visibleStockScopes, canRequestStockState, keepVisibleSnapshots } from "@/lib/stocks/scopes";
import { explicationPortee, estRestreinte } from "@/lib/stocks/portee";
import { prisma } from "@/lib/prisma";
import { chargerPorteeStock, chargerHopitauxStock, chargerProduitsStock, clauseRelevesDePortee } from "@/lib/queries/stock-portee";
import { platformScope } from "@/lib/company";
import { PageHeader } from "@/components/shared/page-header";
import { StocksView, type SnapshotDTO } from "./stocks-view";
import { loadRecurrencesStock } from "@/lib/queries/stock-recurrence";
import { RecurrencesPanel } from "./recurrences-panel";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsStocks } from "@/lib/chemins/stocks";

export default async function StocksPage() {
  const user = await requireModule("STOCKS");
  const canRecord = userCan(user, "STOCKS", "CREATE") || userCan(user, "STOCKS", "UPDATE");
  const canDelete = userCan(user, "STOCKS", "DELETE");
  const isSuperAdmin = user.role === "SUPER_ADMIN";

  // ── QUI VOIT QUEL STOCK ────────────────────────────────────────────────────────
  //
  // PCH et ses ANNEXES sont la chaîne d'approvisionnement ; les HÔPITAUX sont le relevé de
  // terrain. Un délégué médical relève les hôpitaux qu'il visite — il n'a rien à faire dans la
  // position de la centrale d'achat, ni dans celle de ses annexes. La règle est portée par
  // `lib/stocks/scopes.ts` : elle ne nomme aucun rôle, elle lit l'accès à la chaîne.
  const viewer = { canSeeSupplyChain: userCan(user, "PCH", "VIEW"), hasGlobalView: hasGlobalView(user.role), isSuperAdmin, roles: [user.role, user.secondaryRole] };
  const scopes = visibleStockScopes(viewer);
  // Demander un état de stock est une RÉQUISITION adressée à quelqu'un : elle appartient à qui
  // tient la chaîne, jamais à qui y contribue. Le droit de suppression ne l'ouvre plus.
  const canRequest = canRequestStockState(viewer);

  // ── ET QUELS HÔPITAUX, QUELS PRODUITS (§118.134) ────────────────────────────────
  //
  // Les hôpitaux du module sont ceux de l'ANNUAIRE des établissements. Un KAM voit ceux de ses
  // secteurs dans sa BU et les produits de sa BU ; un National Sales voit toute sa BU ; la chaîne
  // d'approvisionnement, la Direction et le Super Admin voient tout. La décision vit dans
  // `lib/stocks/portee.ts`, le chargeur dans `queries/stock-portee.ts` — les actions relisent la
  // MÊME portée avant d'écrire.
  const portee = await chargerPorteeStock(user);

  const [products, lieux, annexRows, snapshots, users, recurrences] = await Promise.all([
    chargerProduitsStock(user, portee),
    chargerHopitauxStock(portee, { avecDisponibles: isSuperAdmin }),
    prisma.stockAnnex.findMany({ where: { kind: "ANNEX" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // Portée VALIDÉE contre les droits, comme Finances et Ad & Pro : le cookie d'entité est une
    // demande, pas une autorisation. Et elle laisse passer les relevés NON RATTACHÉS — un état
    // de stock saisi sans entité doit rester visible (et corrigeable), pas disparaître du
    // graphique dès qu'on sélectionne une société. La portée de secteur s'y AJOUTE : les relevés
    // hors secteur ne sont pas envoyés du tout.
    prisma.stockSnapshot.findMany({
      where: { AND: [await platformScope(user.id), clauseRelevesDePortee(portee)] },
      orderBy: { date: "asc" }, take: 5000,
    }),
    prisma.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // LES RÉCURRENCES ne sont chargées que pour qui peut RÉQUISITIONNER : les envoyer à tout le
    // monde apprendrait à un délégué qui la Direction fait compter, et où. La garde est la même
    // que celle du geste (§118.71) — pas un masquage d'écran par-dessus une donnée envoyée.
    canRequest ? loadRecurrencesStock() : Promise.resolve([]),
  ]);
  const annexes = annexRows.map((l) => ({ id: l.id, name: l.name }));
  // Les demandes et les récurrences visent des LIEUX existants : un établissement jamais relevé
  // n'a pas encore le sien, il n'est donc pas proposé à une réquisition.
  const hopitauxDemandables = lieux.hopitaux.filter((h) => h.annexId).map((h) => ({ id: h.annexId as string, name: h.name }));

  // LE FILTRE PORTE SUR LES DONNÉES, pas seulement sur les onglets : un relevé PCH qui part dans
  // la charge utile de la page se lit, même sans onglet pour l'afficher.
  const snaps: SnapshotDTO[] = keepVisibleSnapshots(viewer, snapshots).map((s) => ({
    id: s.id, scope: s.scope, annexId: s.annexId, productId: s.productId,
    date: s.date.toISOString(), quantity: s.quantity, mine: s.createdById === user.id,
  }));

  const perimetre = estRestreinte(portee)
    ? {
        mode: portee.mode,
        secteurs: portee.secteurs.map((s) => s.nom),
        explication: explicationPortee(portee),
      }
    : null;

  return (
    <div className="space-y-5">
      {/* LES ÉCRANS DU MODULE — la chaîne et le stock PCH central s'ouvrent à la chaîne d'approvisionnement (même règle). */}
      <ModuleTabs tabs={ongletsStocks(canRequest)} />
      <PageHeader
        title="Stocks"
        description="États de stock datés, par produit : PCH (centrale), hôpitaux et annexes PCH. On enregistre simplement « à cette date, il reste X » — la courbe se construit au fil des relevés. Les hôpitaux sont ceux de l'annuaire des établissements : un KAM relève ceux de son secteur, pour les produits de sa BU."
      >
        {/* DEMANDES DE STOCKS (DO → KAM) : le DO y lance et suit ; le KAM y renseigne ce qu'on lui demande. */}
        <Link href="/stocks/demandes" className="inline-flex h-10 items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-4 text-sm font-medium hover:bg-secondary">
          <PackageSearch className="h-4 w-4" /> Demandes de stocks
        </Link>
      </PageHeader>
      <StocksView
        products={products.map((p) => ({ id: p.id, label: p.label }))}
        hospitals={lieux.hopitaux}
        institutionsDisponibles={lieux.disponibles}
        annexes={annexes}
        snapshots={snaps}
        users={users.map((u) => ({ id: u.id, label: u.name }))}
        canRecord={canRecord}
        canDelete={canDelete}
        isSuperAdmin={isSuperAdmin}
        canRequest={canRequest}
        scopes={scopes}
        perimetre={perimetre}
      />
      {/* LES DEMANDES RÉCURRENTES — le même geste, mais qui repart seul. Placé juste après la
          vue : c'est en regardant les relevés qu'on constate qu'un hôpital n'a rien envoyé
          depuis deux mois, et donc qu'il faut le demander automatiquement. */}
      {canRequest && (
        <RecurrencesPanel
          recurrences={recurrences}
          hospitals={hopitauxDemandables}
          users={users.map((u) => ({ id: u.id, label: u.name }))}
        />
      )}
    </div>
  );
}
