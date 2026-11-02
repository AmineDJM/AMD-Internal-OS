import Link from "next/link";
import { requireModule } from "@/lib/session";
import { resolveRepScope, peutConfigurerBu } from "@/lib/sfe";
import { cn } from "@/lib/utils";
import { STATUT_LABELS } from "@/lib/segmentation/regles";
import { busDuPerimetre, chargerTerritoires } from "@/lib/queries/force-de-vente";
import { uneDecimale } from "@/lib/force-de-vente/calculs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { EnteteFdv, lireParametres } from "../entete";
import { HorsPanel } from "./hors-panel";
import { NomTerritoire } from "@/app/(app)/business-units/nom-territoire";

export const dynamic = "force-dynamic";

/**
 * FORCE DE VENTE › TERRITOIRES (Direction, 07/10 — maquette validée) : par BU, ses secteurs — délégué (ou vacant),
 * établissements, panel par lettre, charge face à la capacité (les chiffres de la Segmentation), cibles H ou A hors panel
 * qu'un clic affecte au délégué du secteur.
 */
export default async function TerritoiresPage(props: { searchParams?: Promise<{ bu?: string; y?: string; m?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SALES_PLANNING");
  const scope = await resolveRepScope(user);
  const bus = await busDuPerimetre(scope, user.id);
  const { year, month, buId } = lireParametres(searchParams, bus);
  const territoires = await chargerTerritoires(scope, user.id, buId);
  const peutAffecter = !scope.lectureSeule && (scope.canConfigure || scope.mode === "team");
  // NOMMER UN TERRITOIRE (Direction, 08/10) : le droit qui règle les secteurs — le module « Business Units ».
  const peutRenommer = peutConfigurerBu(user);

  return (
    <div className="space-y-4">
      <EnteteFdv user={user} scope={scope} bus={bus} chemin="/planning/territoires" buId={buId} year={year} month={month} />

      {territoires.length === 0 && <p className="surface rounded-xl p-5 text-sm text-muted-foreground">Aucune BU dans votre périmètre.</p>}

      {territoires.map((t) => (
        <section key={t.buId} className="surface min-w-0 rounded-xl">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold">Secteurs de la BU {t.buNom}</h2>
            {peutRenommer && (
              <Link href={`/business-units/secteurs?bu=${t.buId}`} className="inline-flex h-8 items-center rounded-[var(--radius)] border border-border bg-card px-2.5 text-xs font-medium hover:bg-secondary">Nouveau secteur</Link>
            )}
          </header>
          {!t.segmentee && <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Segmentation non publiée pour cette BU : panel et charge s&apos;afficheront à la première version des règles.</p>}
          {t.secteurs.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Aucun secteur actif.</p> : (
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <Th className="sticky left-0 z-[1] bg-card">Secteur</Th>
                    <Th>Délégué</Th>
                    <Th className="text-center">Établissements</Th>
                    <Th>Panel</Th>
                    <Th className="text-right">
                      <span className="inline-flex items-center gap-1">Charge<InfoBulle label="À propos de la charge" align="left">Contacts par jour que le secteur demande (lettres × fréquences de la segmentation), face à la capacité d&apos;un délégué. Orange au-delà de 90 %, rouge au-delà de 100 %.</InfoBulle></span>
                    </Th>
                    <Th className="text-center">
                      <span className="inline-flex items-center gap-1">Hors panel<InfoBulle label="À propos des cibles hors panel" align="left">Praticiens classés H ou A dans la segmentation du secteur, mais rattachés à aucun délégué. Un clic les affecte.</InfoBulle></span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {t.secteurs.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium [overflow-wrap:anywhere]"><NomTerritoire id={s.id} nom={s.nom} peutRenommer={peutRenommer} /></td>
                      <td className="px-3 py-2">
                        {s.delegues.length ? s.delegues.map((d) => d.nom).join(", ") : <span className="inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">vacant</span>}
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{s.etablissements}</td>
                      <td className="px-3 py-2">
                        {(["H", "A", "B", "C", "D"] as const).some((l) => s.panel[l]) ? (
                          <span className="flex flex-wrap gap-1">
                            {(["H", "A", "B", "C", "D"] as const).filter((l) => s.panel[l]).map((l) => (
                              <span key={l} className="inline-flex items-center gap-1" title={`${s.panel[l]} en ${l}`}><LettreBadge lettre={l} className="h-5 min-w-[22px]" /><span className="text-xs tabular-nums">{s.panel[l]}</span></span>
                            ))}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", s.charge?.ton === "depasse" ? "font-medium text-destructive" : s.charge?.ton === "attention" ? "font-medium text-warning" : s.charge ? "text-success" : "")}>
                        {s.charge ? `${uneDecimale(s.charge.parJour)} / ${s.charge.cap}` : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {s.delegues.length === 0 ? <span className="text-muted-foreground">—</span> : (
                          <HorsPanel
                            secteur={s.nom}
                            delegue={s.delegues[0] ?? null}
                            peutAffecter={peutAffecter}
                            cibles={s.horsPanel.map((c) => ({ ...c, statut: c.statut ? STATUT_LABELS[c.statut] : null }))}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return <th className={cn("whitespace-nowrap px-3 py-2 font-medium", className)}>{children}</th>;
}
