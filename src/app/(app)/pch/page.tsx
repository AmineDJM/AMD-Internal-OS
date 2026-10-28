import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getPchTenders, pchSummary } from "@/lib/queries/pch";
import { createTender } from "@/lib/actions/pch-actions";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { PCH_MARKET_NIVEAU } from "@/lib/labels";
import { getMyCompanies, companyOptions } from "@/lib/company";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils";

/** L'ordre de LECTURE du cycle de vie — du plus amont au plus aval, puis les états hors chemin. */
const ORDRE_NIVEAUX = [
  "BROUILLON", "PREPARATION", "SOUMIS", "CONTRACTUALISATION", "EXECUTION", "CLOTURE",
  "PERDU", "ANNULE", "SUSPENDU",
] as const;

export default async function PchPage(props: { searchParams?: Promise<{ niveau?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PCH");
  const canCreate = userCan(user, "PCH", "CREATE");
  // LES BUSINESS UNITS NE SONT PLUS CHARGÉES ICI : l'affectation ne se décide pas à l'ouverture
  // du dossier, mais PRODUIT PAR PRODUIT une fois l'attribution connue — un marché sert souvent
  // plusieurs gammes, et le champ unique du formulaire forçait à n'en nommer qu'une.
  const [tenders, companies, usersOptions] = await Promise.all([
    getPchTenders(user.id),
    getMyCompanies(user.id),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const s = pchSummary(tenders);

  // UN SEUL ÉCRAN, des filtres — pas un onglet par état (§3). Le filtre est un lien : l'URL
  // se partage, le retour arrière marche, aucun état client à maintenir.
  const parNiveau = new Map<string, number>();
  for (const t of tenders) parNiveau.set(t.niveau.niveau, (parNiveau.get(t.niveau.niveau) ?? 0) + 1);
  const filtre = searchParams?.niveau && PCH_MARKET_NIVEAU[searchParams.niveau] ? searchParams.niveau : null;
  const visibles = filtre ? tenders.filter((t) => t.niveau.niveau === filtre) : tenders;
  const enExecution = parNiveau.get("EXECUTION") ?? 0;
  const now = Date.now();
  const depotsProches = tenders.filter((t) =>
    t.submissionDeadline && !t.submittedAt
    && !["ANNULE", "SUSPENDU", "PERDU", "CLOTURE"].includes(t.niveau.niveau)
    && new Date(t.submissionDeadline).getTime() - now < 7 * 86_400_000,
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader title="PCH — Marchés publics" description="Le cycle de vie complet : appel d'offres → soumission → attribution → contrat → bons de commande → livraisons — avec suivi des cautions.">
        {canCreate && (
          <CreateRecordButton
            label="Nouvel appel d'offres"
            title="Appel d'offres"
            description="Référence laissée vide = numérotation automatique (AO-année-n)."
            redirectBase="/pch"
            action={createTender}
            /**
             * CE QU'ON SAIT LE JOUR DE LA PUBLICATION, ET RIEN DE PLUS.
             *
             * Le formulaire demandait vingt et un champs : la Business Unit, les produits, le
             * fournisseur, son pays, la quantité, la valeur, la date d'attribution, les quatre
             * champs de caution, les notes. Aucun n'est CONNU à la création — on ouvre un dossier
             * le jour où l'organisme publie l'appel d'offres, avant d'avoir chiffré quoi que ce
             * soit, avant de savoir ce qu'on gagnera, avant même de savoir si l'on soumissionne.
             *
             * Un champ qu'on ne peut pas remplir se remplit quand même : d'une estimation, d'un
             * zéro, d'un « à voir ». Il devient alors une donnée FAUSSE que plus personne ne
             * corrige, parce qu'elle a l'air renseignée. Et un formulaire de vingt et un champs
             * dont dix-huit sont vides apprend surtout à passer au suivant sans lire.
             *
             * Tout ce qui a été retiré se pose ENSUITE, sur la fiche, au moment où le fait
             * existe : les produits ligne par ligne (avec leurs quantités et nos prix), la
             * soumission et ses pièces, l'attribution lot par lot, le contrat et ses avenants,
             * les bons de commande, les affectations aux Business Units. Rien n'est perdu ;
             * chaque chose est demandée là où on la connaît.
             */
            fields={[
              { type: "text", name: "reference", label: "Référence (optionnel)" },
              { type: "text", name: "internalReference", label: "Référence interne AMD" },
              { type: "select", name: "companyId", label: "Entité", options: companyOptions(companies), placeholder: "— Entité —" },
              { type: "text", name: "title", label: "Intitulé", full: true },
              { type: "file", name: "tenderDoc", label: "Cahier des charges (optionnel)", multiple: true, hint: "Ajoutable aussi plus tard depuis la fiche du marché.", full: true },
              { type: "text", name: "client", label: "Organisme", defaultValue: "PCH" },
              { type: "date", name: "publishedAt", label: "Publié le" },
              { type: "date", name: "submissionDeadline", label: "Date limite de dépôt" },
              { type: "select", name: "responsibleId", label: "Responsable du dossier", options: usersOptions.map((u) => ({ value: u.id, label: u.name })), placeholder: "— Personne —" },
            ]}
          />
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <KpiCard label="Marchés" value={s.count} icon="Gavel" />
        <KpiCard label="En exécution" value={enExecution} icon="Activity" tone="info" />
        <KpiCard label="Dépôts sous 7 j" value={depotsProches} icon="AlarmClock" tone={depotsProches > 0 ? "danger" : "default"} />
        <KpiCard label="Valeur totale" value={formatCurrency(s.totalValue)} icon="Coins" tone="success" />
        <KpiCard label="Cautions à déposer" value={s.cautionsToDeposit} icon="ShieldAlert" tone={s.cautionsToDeposit > 0 ? "warning" : "default"} />
        <KpiCard label="Cautions < 30j" value={s.cautionsExpiringSoon} icon="AlarmClock" tone={s.cautionsExpiringSoon > 0 ? "danger" : "default"} />
      </div>

      {tenders.length > 0 && (
        <nav aria-label="Filtrer par niveau" className="flex flex-wrap items-center gap-1.5">
          <FiltreChip href="/pch" actif={filtre === null} label={`Tous (${tenders.length})`} />
          {ORDRE_NIVEAUX.filter((n) => (parNiveau.get(n) ?? 0) > 0).map((n) => (
            <FiltreChip
              key={n}
              href={`/pch?niveau=${n}`}
              actif={filtre === n}
              label={`${PCH_MARKET_NIVEAU[n].label} (${parNiveau.get(n)})`}
            />
          ))}
        </nav>
      )}

      {tenders.length === 0 ? (
        <EmptyState icon="Gavel" title="Aucun appel d'offres" description={canCreate ? "Créez un appel d'offres dès sa publication : la fiche suit ensuite la soumission, l'attribution, le contrat et les bons de commande." : "Les marchés PCH apparaîtront ici."} />
      ) : visibles.length === 0 ? (
        <EmptyState icon="Gavel" title="Aucun marché à ce niveau" description="Changez de filtre pour retrouver les autres marchés." />
      ) : (
        <div className="surface overflow-x-auto">
          <Table mobileCards>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead><TableHead>Intitulé / Produits</TableHead><TableHead>Fournisseur</TableHead>
                <TableHead className="text-right">Qté</TableHead><TableHead className="text-right">Valeur</TableHead>
                <TableHead>Caution</TableHead><TableHead>Bons</TableHead><TableHead>Niveau</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibles.map((t) => {
                const cautionExpired = t.cautionEnd && new Date(t.cautionEnd) < new Date();
                const deadline = t.submissionDeadline && !t.submittedAt
                  && !["ANNULE", "SUSPENDU", "PERDU", "CLOTURE"].includes(t.niveau.niveau)
                  ? new Date(t.submissionDeadline).getTime() - now : null;
                return (
                  <TableRow key={t.id}>
                    <TableCell label="Référence" className="font-mono text-xs [overflow-wrap:anywhere]"><Link href={`/pch/${t.id}`} className="hover:underline">{t.reference}</Link></TableCell>
                    <TableCell label="Intitulé" className="font-medium">{t.title || "—"}{t.products && <p className="text-xs text-muted-foreground">{t.products}</p>}</TableCell>
                    <TableCell label="Fournisseur" className="text-muted-foreground">{[t.supplier, t.supplierCountry].filter(Boolean).join(" · ") || "—"}</TableCell>
                    <TableCell label="Qté" className="text-right">{formatNumber(t.quantity)}</TableCell>
                    <TableCell label="Valeur" className="text-right">{t.value !== null ? formatCurrency(t.value) : "—"}</TableCell>
                    <TableCell label="Caution">
                      {(t.cautionAmount ?? 0) > 0 || t.cautionDeposited ? (
                        <Badge tone={t.cautionDeposited ? (cautionExpired ? "danger" : "success") : "warning"} dot={false}>
                          {t.cautionDeposited ? (cautionExpired ? "Expirée" : "Déposée") : "Non déposée"}
                        </Badge>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell label="Bons" className="text-muted-foreground">{t.orderCount}</TableCell>
                    <TableCell label="Niveau">
                      <span title={t.niveau.raison}>
                        <StatusBadge map={PCH_MARKET_NIVEAU} value={t.niveau.niveau} />
                      </span>
                      {deadline !== null && deadline < 7 * 86_400_000 && (
                        <p className={`mt-0.5 text-xs ${deadline < 0 ? "text-destructive" : "text-warning"}`}>
                          {deadline < 0
                            ? `Échéance de dépôt dépassée (${formatDate(t.submissionDeadline!)})`
                            : `Dépôt avant le ${formatDate(t.submissionDeadline!)}`}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function FiltreChip({ href, actif, label }: { href: string; actif: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={actif ? "true" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors sm:min-h-0 ${
        actif
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
