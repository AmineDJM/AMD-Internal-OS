import Link from "next/link";
import { requireModule } from "@/lib/session";
import { hasGlobalView, userCan } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import type { EntityType } from "@prisma/client";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils";
import { recenserDoublonsFactures, examensDesGroupes } from "@/lib/factures/recensement";
import { BoutonExamen } from "./bouton-examen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Doublons de factures — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FINANCES › DOUBLONS DE FACTURES — le recensement unique des doublons déjà en base (Direction, 14/10/2026).
 *
 * « On fait un passage unique sur les factures déjà en base pour lister aux Finances les doublons existants. »
 * Les groupes CERTAINS (même fichier ; même fournisseur et même numéro lus) d'abord, puis les PROBABLES (même
 * fournisseur, même montant, même date, ou même numéro à confirmer) : pièces, modules, montants, états de paiement,
 * liens. L'écran NE MODIFIE RIEN — une facture se corrige dans son module. Le seul geste est « examiné » (journal
 * d'audit), réservé à qui peut modifier les Finances. Les liens ne s'ouvrent qu'à qui a accès au dossier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function DoublonsFacturesPage() {
  const user = await requireModule("FINANCES");
  const peutExaminer = userCan(user, "FINANCES", "UPDATE") || hasGlobalView(user.role);
  const { groupes, facturesExaminees } = await recenserDoublonsFactures();
  const examens = await examensDesGroupes(groupes.map((g) => g.signature));

  // LES LIENS : seulement vers ce que la personne peut ouvrir (une requête par dossier distinct).
  const dossiers = new Map<string, { type: string; id: string }>();
  for (const g of groupes) for (const m of g.membres) dossiers.set(`${m.dossier.type}:${m.dossier.id}`, m.dossier);
  const ouvrables = new Set(
    (await Promise.all([...dossiers.entries()].map(async ([k, d]) => ((await canAccessEntity(user, d.type as EntityType, d.id, "VIEW").catch(() => false)) ? k : null))))
      .filter((k): k is string => Boolean(k)),
  );
  const certains = groupes.filter((g) => g.niveau === "CERTAIN");
  const probables = groupes.filter((g) => g.niveau === "PROBABLE");
  const aExaminer = groupes.filter((g) => !examens.get(g.signature)?.examine).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Finances — Doublons de factures"
        description="Les factures déjà en base qui sont, ou semblent être, la même pièce — au registre, dans une demande de paiement, sur un poste Ad & Pro, au secrétariat. CERTAIN : le même fichier, ou le même fournisseur et le même numéro lus sur la pièce. PROBABLE : même fournisseur, même montant et même date sans numéro lisible, ou un même numéro à confirmer. Rien n'est modifié ici : chaque pièce se corrige dans son module, pièce en main. Une pro forma face à sa facture finale, un avoir ou deux acomptes ne sont pas des doublons."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Factures examinées" value={facturesExaminees} icon="ReceiptText" tone="info" />
        <KpiCard label="Groupes certains" value={certains.length} icon="Copy" tone={certains.length > 0 ? "danger" : "default"} />
        <KpiCard label="Groupes probables" value={probables.length} icon="CopyCheck" tone={probables.length > 0 ? "warning" : "default"} />
        <KpiCard label="À examiner" value={aExaminer} icon="Hourglass" tone={aExaminer > 0 ? "warning" : "success"} />
      </div>

      {groupes.length === 0 ? (
        <EmptyState icon="CheckCircle2" title="Aucun doublon de facture" description="Aucune facture en base ne partage son fichier, ni son fournisseur et son numéro, avec une autre." />
      ) : (
        <div className="space-y-3">
          {groupes.map((g) => {
            const examen = examens.get(g.signature) ?? null;
            return (
              <section key={g.signature} className="surface space-y-2 p-3 sm:p-4" data-groupe-doublon={g.niveau}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-semibold">
                      <span className={g.niveau === "CERTAIN" ? "text-destructive" : "text-warning"}>{g.niveau === "CERTAIN" ? "Doublon certain" : "Doublon possible"}</span>
                      {" "}· {g.membres.length} pièces
                    </p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{g.raisons.join(" ")}</p>
                  </div>
                  <BoutonExamen signature={g.signature} examine={examen?.examine ?? false} par={examen?.par ?? null} le={examen?.le ?? null} peutExaminer={peutExaminer} />
                </div>
                <ul className="divide-y divide-border text-xs">
                  {g.membres.map((m) => {
                    const lien = m.dossier.lien && ouvrables.has(`${m.dossier.type}:${m.dossier.id}`) ? m.dossier.lien : null;
                    return (
                      <li key={m.cle} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[1.4fr_1fr_1fr] sm:gap-3">
                        <div className="min-w-0">
                          <p className="font-medium [overflow-wrap:anywhere]">{m.piece}</p>
                          <p className="text-muted-foreground [overflow-wrap:anywhere]">
                            {m.module} ·{" "}
                            {lien ? <Link href={lien} className="text-primary hover:underline">{m.dossier.titre}</Link> : <span>{m.dossier.titre}</span>}
                          </p>
                        </div>
                        <div className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                          {[m.nature, m.numero ? `n° ${m.numero}` : null, m.fournisseur, m.date ? formatDate(m.date) : null].filter(Boolean).join(" · ") || "Pièce non lue"}
                          {m.ttc != null && <span className="block font-medium tabular-nums text-foreground">{formatCurrency(m.ttc)}</span>}
                        </div>
                        <div className="min-w-0 [overflow-wrap:anywhere]">
                          {m.paiement && <span className="font-medium">{m.paiement} · </span>}
                          <span className="text-muted-foreground">{m.etat}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
