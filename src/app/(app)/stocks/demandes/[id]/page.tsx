import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireModule } from "@/lib/session";
import { peutPiloterDemandesStocks, chargerDemandeStocks, suiviDemande } from "@/lib/queries/demande-stocks";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatDate } from "@/lib/utils";
import type { Cellule } from "@/lib/stocks/demande-stocks";
import { SaisieStocks } from "./saisie-stocks";
import { SuiviKams, GestesDemande } from "./suivi-gestes";

/**
 * UNE DEMANDE DE STOCKS — la saisie du KAM destinataire, le suivi de qui la pilote.
 *
 * Un KAM ne reçoit QUE ses cases (ses établissements × les produits de sa BU) : la matrice
 * entière, les autres KAM et leurs chiffres ne partent pas dans sa page.
 */
export default async function DemandeStocksPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("STOCKS");
  const d = await chargerDemandeStocks(params.id);
  if (!d) notFound();
  const pilote = peutPiloterDemandesStocks(user);
  const destinataire = d.destinataires.find((x) => x.kamId === user.id) ?? null;
  if (!pilote && !destinataire) notFound();

  const ouverte = d.status === "OUVERTE";
  const entete = (
    <p className="text-xs text-muted-foreground">
      {d.auteur ? `Demandée par ${d.auteur} · ` : ""}{formatDate(d.createdAt)}
      {d.dueDate ? <> · échéance <strong className="text-foreground">{formatDate(d.dueDate)}</strong></> : null}
      {!ouverte && d.closedAt ? ` · clôturée le ${formatDate(d.closedAt)}` : ""}
    </p>
  );

  // ── LA SAISIE DU KAM : ses cases, et elles seules ──────────────────────────────────────
  let saisie: ReactNode = null;
  if (destinataire) {
    const siennes = d.lignes.filter((l) => l.kamIds.includes(user.id) && l.institutionId && l.productId);
    const ids = new Set(siennes.map((l) => l.hopitalId));
    saisie = (
      <SaisieStocks
        demandeId={d.id}
        ouverte={ouverte}
        envoyeLe={destinataire.envoyeLe}
        hopitaux={d.hopitaux.filter((h) => ids.has(h.id) && h.institutionId).map((h) => ({ institutionId: h.institutionId!, hopitalId: h.id, name: h.name, wilaya: h.wilaya, note: h.note }))}
        lignes={siennes.map((l) => ({ hopitalId: l.hopitalId, institutionId: l.institutionId!, productId: l.productId!, label: l.productLabel, quantite: l.quantite, rupture: l.rupture, savedBy: l.savedBy, savedAt: l.savedAt }))}
      />
    );
  }

  const suivi = pilote ? suiviDemande(d) : null;
  const lignesParHopital = new Map<string, number>();
  const rempliesParHopital = new Map<string, number>();
  if (suivi) {
    for (const l of d.lignes) {
      if (l.kamIds.length === 0) continue;
      lignesParHopital.set(l.hopitalId, (lignesParHopital.get(l.hopitalId) ?? 0) + 1);
      if (l.rupture || l.quantite !== null) rempliesParHopital.set(l.hopitalId, (rempliesParHopital.get(l.hopitalId) ?? 0) + 1);
    }
  }
  const sansKam = d.hopitaux.filter((h) => h.sansKam);
  const nomKam = new Map(d.destinataires.map((x) => [x.kamId, x.nom]));
  const kamsParHopital = new Map<string, Set<string>>();
  for (const l of d.lignes) for (const k of l.kamIds) kamsParHopital.set(l.hopitalId, (kamsParHopital.get(l.hopitalId) ?? new Set()).add(k));
  const kamsDuHopital = (hid: string) => [...(kamsParHopital.get(hid) ?? [])].map((k) => nomKam.get(k) ?? "—").join(", ");
  const hopitalParId = new Map(d.hopitaux.map((h) => [h.id, h]));

  return (
    <div className="space-y-5">
      <PageHeader title={d.title} description={d.notes ?? undefined}>
        <Link href="/stocks/demandes" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Demandes
        </Link>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        {ouverte ? <Badge tone="info">Ouverte</Badge> : <Badge tone="neutral">Clôturée</Badge>}
        {entete}
      </div>

      {saisie}

      {suivi && (
        <>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Avancement</h2>
              <div className="flex flex-wrap items-center gap-2">
                <a href={`/api/stocks/demandes/${d.id}/export`} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium hover:bg-secondary sm:h-8">
                  <Download className="h-3.5 w-3.5" /> Exporter (CSV)
                </a>
                <GestesDemande demandeId={d.id} ouverte={ouverte} peutSupprimer={d.createdById === user.id || user.role === "SUPER_ADMIN"} />
              </div>
            </div>
            <div className="surface space-y-1.5 p-3">
              <Progress value={suivi.global.pourcentage} tone={suivi.global.pourcentage === 100 ? "success" : "primary"} />
              <p className="text-sm">
                <strong>{suivi.global.remplies}</strong>/{suivi.global.total} stocks renseignés ({suivi.global.pourcentage} %) ·{" "}
                {suivi.parKam.filter((k) => k.envoye).length}/{suivi.parKam.length} KAM ont envoyé
                {d.toutHopitaux ? " · tous les établissements" : ""}
              </p>
            </div>
            <SuiviKams demandeId={d.id} ouverte={ouverte} kams={suivi.parKam} />
          </section>

          {sansKam.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-warning">Sans KAM ({sansKam.length})</h2>
              <p className="text-xs text-muted-foreground">
                Aucun secteur actif ne couvre ces établissements : la demande n&apos;a été adressée à personne pour eux.
                Les rattacher à un secteur se fait dans Business Units › Secteurs.
              </p>
              <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{sansKam.map((h) => h.name).join(", ")}</p>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tableau consolidé (boîtes)</h2>
            {suivi.matrice.produits.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun produit dans cette demande.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-secondary/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="sticky left-0 z-10 bg-secondary px-2 py-1.5 text-left font-medium">Établissement</th>
                      <th className="px-2 py-1.5 text-left font-medium">KAM</th>
                      <th className="px-2 py-1.5 text-right font-medium">Renseigné</th>
                      {suivi.matrice.produits.map((p) => <th key={p.id} className="px-2 py-1.5 text-right font-medium">{p.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {suivi.matrice.lignes.map((ligne) => {
                      const h = hopitalParId.get(ligne.hopitalId)!;
                      const total = lignesParHopital.get(h.id) ?? 0;
                      return (
                        <tr key={h.id} className="border-t border-border">
                          <td className="sticky left-0 z-10 max-w-[10rem] bg-card px-2 py-1.5 sm:max-w-none">
                            <span className="block font-medium [overflow-wrap:anywhere]">{h.name}</span>
                            <span className="block text-xs text-muted-foreground">{h.wilaya ?? "—"}{h.note ? ` · « ${h.note} »` : ""}</span>
                          </td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">{h.sansKam ? <span className="text-warning">sans KAM</span> : kamsDuHopital(h.id) || "—"}</td>
                          <td className="px-2 py-1.5 text-right text-xs">{total ? `${rempliesParHopital.get(h.id) ?? 0}/${total}` : "—"}</td>
                          {ligne.cellules.map((c, i) => <td key={suivi.matrice.produits[i]!.id} className="px-2 py-1.5 text-right">{rendreCellule(c)}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-border bg-secondary/30 text-xs">
                    <tr>
                      <td className="sticky left-0 z-10 bg-secondary px-2 py-1.5 font-medium" colSpan={1}>Total</td>
                      <td className="px-2 py-1.5" />
                      <td className="px-2 py-1.5" />
                      {suivi.matrice.produits.map((p) => <td key={p.id} className="px-2 py-1.5 text-right font-medium">{p.total.toLocaleString("fr-FR")}</td>)}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              « — » à renseigner · <span className="text-destructive">R</span> rupture · vide : produit non demandé pour cet établissement.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function rendreCellule(c: Cellule) {
  switch (c.etat) {
    case "QUANTITE": return <span className="tabular-nums">{c.quantite.toLocaleString("fr-FR")}</span>;
    case "RUPTURE": return <span className="font-semibold text-destructive" title="Rupture">R</span>;
    case "A_RENSEIGNER": return <span className="text-muted-foreground">—</span>;
    case "SANS_KAM": return <span className="text-xs text-warning">sans KAM</span>;
    default: return null;
  }
}
