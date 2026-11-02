import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getPromoMaterials } from "@/lib/queries/promo-material";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { NouvelleDemandeMaterielButton } from "@/modules/ad-pro/ecrans/demande-materiel-form";
import { optionsDesArticlesDemandes } from "@/lib/queries/promo-achats";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PROMO_MATERIAL_STATUS, EVENTS_TABS, MATERIAL_TYPE } from "@/lib/labels";
import { libelleEtape, type PromoState } from "@/lib/promo-material/circuit";
import { CompanyBadge } from "@/components/shared/company-badge";
import { formatCurrency, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PromoMaterialPage() {
  const user = await requireModule("PROMO_MATERIAL");
  const canCreate = userCan(user, "PROMO_MATERIAL", "CREATE");
  // LE CATALOGUE ET LES PRODUITS, pour composer la demande en LIGNES dès sa création (§118.171) —
  // le même chargement que la fiche, et le même formulaire que le panneau commun d'Ad & Pro.
  // Plus de gamme, d'assistante, de budget ni d'entité à choisir (décision du 01/10) : rien
  // d'autre à charger.
  const [items, options] = await Promise.all([
    getPromoMaterials(user),
    canCreate ? optionsDesArticlesDemandes() : Promise.resolve(null),
  ]);

  // Un dossier au circuit court se juge sur SON état ; un ancien dossier sur l'ancien statut.
  const isClosed = (i: { status: string; circuitState: string | null }) =>
    i.circuitState ? i.circuitState === "COMPLETED" || i.circuitState === "REFUSED" : i.status === "SETTLED" || i.status === "CANCELLED";
  const active = items.filter((i) => !isClosed(i)).length;
  const settled = items.filter((i) => (i.circuitState ? i.circuitState === "COMPLETED" : i.status === "SETTLED")).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Matériel promotionnel" description="Demande composée de lignes piochées dans le catalogue → validée (N+1 ou directrice marketing) → devis retranscrits par l'assistante → choix des lignes → Direction Marketing (et Directeur Général au-dessus du seuil) → bons de commande générés, factures ligne à ligne, réception au stock, paiements — visa publicitaire ou déclaration à chaque paiement.">
        {canCreate && options && <NouvelleDemandeMaterielButton catalogue={options.catalogue} produits={options.produits} />}
      </PageHeader>

      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiCard label="Dossiers" value={items.length} icon="Megaphone" />
        <KpiCard label="En cours" value={active} icon="Loader" tone={active > 0 ? "info" : "default"} />
        <KpiCard label="Réglés" value={settled} icon="CheckCircle2" tone="success" />
      </div>

      {items.length === 0 ? (
        <EmptyState icon="Megaphone" title="Aucun dossier" description={canCreate ? "Créez une demande de matériel promotionnel pour démarrer." : "Les dossiers de matériel promotionnel apparaîtront ici."} />
      ) : (
        <div className="surface overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead><TableHead>Campagne</TableHead><TableHead>Articles</TableHead><TableHead>Agence</TableHead>
                <TableHead className="text-right">Montant</TableHead><TableHead>Statut</TableHead><TableHead>Créé le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id} className="cursor-pointer">
                  <TableCell className="font-mono text-xs"><Link href={`/promo-material/${i.id}`} className="hover:underline">{i.reference}</Link></TableCell>
                  <TableCell className="font-medium">
                    <div>
                      <Link href={`/promo-material/${i.id}`} className="hover:underline">{i.title}</Link>
                      {i.company && <div className="mt-0.5"><CompanyBadge company={i.company} /></div>}
                    </div>
                  </TableCell>
                  {/* LES ARTICLES DE LA DEMANDE (§118.173) — ses lignes, et non plus un « type » saisi à
                      côté. Trois noms au plus, le reste COMPTÉ : une coupe muette se lirait comme
                      la liste entière. Un dossier d'avant les lignes garde son type d'alors. */}
                  <TableCell className="text-muted-foreground">
                    {i.articles.length > 0
                      ? `${i.articles.slice(0, 3).join(", ")}${i.articles.length > 3 ? ` (+${i.articles.length - 3})` : ""}`
                      : i.typeHerite ? MATERIAL_TYPE[i.typeHerite] ?? i.typeHerite : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{i.chosenAgency || "—"}</TableCell>
                  <TableCell className="text-right">{i.amount != null ? formatCurrency(i.amount) : "—"}</TableCell>
                  <TableCell>
                    {/* Un dossier au circuit court affiche l'état du circuit ; un dossier
                        d'avant la réforme garde son ancien statut. */}
                    {/* LE LIBELLÉ D'UNE ÉTAPE VIENT DU CIRCUIT (`libelleEtape`), comme sur la fiche : une
                        table recopiée ici disait encore « Validation du N+1 » pour l'étape de la
                        Direction Marketing, et ne connaissait pas celle du Directeur Général. Un
                        dossier annulé se lit « Annulé », pas « Refusé ». */}
                    {i.circuitState && i.status !== "CANCELLED"
                      ? <StatusBadge map={{ [i.circuitState]: { label: libelleEtape(i.circuitState as PromoState, i.circuitVersion === 2 ? 2 : 1), tone: i.circuitState === "REFUSED" ? "danger" : i.circuitState === "COMPLETED" ? "success" : "info" } }} value={i.circuitState} dot={false} />
                      : <StatusBadge map={PROMO_MATERIAL_STATUS} value={i.status} dot={false} />}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(i.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
