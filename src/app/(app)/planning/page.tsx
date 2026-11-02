import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { resolveRepScope, peutConfigurerBu } from "@/lib/sfe";
import { cn, initials } from "@/lib/utils";
import { effortSummary } from "@/lib/sfe-performance";
import { chargerEffortVentes } from "@/lib/queries/sfe-effort";
import { busDuPerimetre, chargerPilotage, chargerFicheDelegue, type LigneDelegue, type FicheDelegue } from "@/lib/queries/force-de-vente";
import {
  ETAT_PLAN_LABELS, cyclesSansVisite, libelleRetardCible, pointsSparkline, sensTendance, type EtatPlan,
} from "@/lib/force-de-vente/calculs";
import { peutAdministrerLeCoaching } from "@/lib/coaching/acces";
import { viewsAllReports } from "@/lib/queries/field-reports";
import { lienRapportsDeDelegue } from "@/lib/chemins/rapports-terrain";
import { InfoBulle } from "@/components/ui/info-bulle";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { EnteteFdv, lireParametres, lienFdv } from "./entete";
import { RangeeLien, PanneauAdresse, BoutonEcrire, LienAction } from "./pilotage-client";

export const dynamic = "force-dynamic";

/**
 * FORCE DE VENTE › PILOTAGE (Direction, 07/10 — maquette validée) — l'écran du superviseur et de la Direction.
 *
 * Quatre tuiles, les délégués TRIÉS PAR RETARD sur le requis, « À traiter » (plans à valider, cibles H/A non vues,
 * secteurs sans délégué, coachings en retard). Une ligne ouvre la fiche du délégué. Le requis est UN seul nombre : la
 * segmentation (lettre × In/Out × fréquence du secteur) — plus de « planifié », de « capacité » ni de « fréquence
 * cible » concurrents. L'effort × ventes reste, replié, pour qui le lisait.
 */
export default async function PilotagePage(
  props: { searchParams?: Promise<{ bu?: string; y?: string; m?: string; kam?: string; liste?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SALES_PLANNING");
  const scope = await resolveRepScope(user);
  const bus = await busDuPerimetre(scope, user.id);
  const { year, month, buId } = lireParametres(searchParams, bus);
  const p = { buId, year, month };
  const pilotage = await chargerPilotage({ scope, userId: user.id, buId, year, month });
  const { tuiles, lignes, aTraiter, jour, total } = pilotage;

  const debut = new Date(year, month - 1, 1), fin = new Date(year, month, 1);
  const repIds = lignes.map((l) => l.repId);
  const { lisible: ventesLisibles, lignes: effort } = await chargerEffortVentes(user.id, scope, repIds, debut, fin);

  const fiche = searchParams?.kam ? await chargerFicheDelegue(pilotage, searchParams.kam, year, month) : null;
  const peutCoacher = !scope.lectureSeule && (scope.canConfigure || scope.mode === "team" || peutAdministrerLeCoaching(user));
  const ecrire = userCan(user, "MESSAGING", "VIEW");
  // « Voir ses rapports » : la liste des Rapports filtrée sur ce délégué — le filtre n'existe que pour qui voit les rapports de tous.
  const voirRapports = userCan(user, "FIELD_REPORTS", "VIEW") && viewsAllReports(user);
  const enCours = jour > 0 && jour < total;

  return (
    <div className="space-y-4">
      <EnteteFdv user={user} scope={scope} bus={bus} chemin="/planning" buId={buId} year={year} month={month} exporter={lignes.length > 0} />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tuile titre="Cibles H · A · B vues à fréquence" info="Part des praticiens classés H, A ou B dans les panels qui ont reçu au moins leur nombre de visites requis ce cycle. L'écart se lit face au cycle précédent, avec les lettres d'aujourd'hui."
          valeur={tuiles.couverture.pct === null ? "—" : `${tuiles.couverture.pct} %`}
          pied={tuiles.couverture.delta === null ? `${tuiles.couverture.vues} / ${tuiles.couverture.cibles} cibles` : `${tuiles.couverture.delta >= 0 ? "+" : ""}${tuiles.couverture.delta} pts vs cycle précédent`}
          ton={tuiles.couverture.delta === null ? undefined : tuiles.couverture.delta >= 0 ? "ok" : "ko"} />
        <Tuile titre="Contacts réalisés / requis" info="Requis : la somme des visites que la segmentation demande pour chaque praticien des panels (lettre × In/Out × fréquence du secteur ; l'ancien palier de potentiel pour un praticien hors segmentation). Réalisé : les visites terminées, plafonnées au requis de chaque praticien."
          valeur={`${tuiles.contacts.realise} / ${tuiles.contacts.requis}`}
          pied={enCours ? `attendu à J${jour} : ${tuiles.contacts.attendu}` : `${total} jours ouvrés`}
          ton={enCours && tuiles.contacts.realise < tuiles.contacts.attendu ? "w" : undefined} />
        <Tuile titre="Plans de tournée" info="Plans du cycle validés, sur le nombre de délégués. « À valider » : soumis, en attente du superviseur."
          valeur={`${tuiles.plans.valides} / ${tuiles.plans.total}`}
          pied={tuiles.plans.aValider ? `${tuiles.plans.aValider} à valider` : "aucun en attente"}
          ton={tuiles.plans.aValider ? "w" : undefined} />
        <Tuile titre="Rapports en retard" info="Visites dont la fenêtre de rapport de 48 h s'est fermée sans compte rendu (la règle du plan de tournée)."
          valeur={String(tuiles.rapports.enRetard)} valeurTon={tuiles.rapports.enRetard ? "w" : undefined}
          pied={tuiles.rapports.delegues ? `chez ${tuiles.rapports.delegues} délégué${tuiles.rapports.delegues > 1 ? "s" : ""}` : "aucun"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="surface min-w-0 rounded-xl">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold">Délégués</h2>
            <span className="text-xs text-muted-foreground">triés par retard sur le requis</span>
          </header>
          {lignes.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Aucun délégué dans votre périmètre{buId ? " pour cette BU" : ""}.</p>
          ) : (
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <Th className="sticky left-0 z-[1] bg-card">Délégué</Th>
                    <Th>Couverture H · A · B</Th>
                    <Th className="text-right">Réalisé / requis</Th>
                    <Th className="text-center">Plan</Th>
                    <Th className="text-center">Rapports</Th>
                    <Th>6 cycles</Th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((l) => (
                    <RangeeLien key={l.repId} href={lienFdv("/planning", p, { kam: l.repId })} label={`Ouvrir la fiche de ${l.nom}`}
                      className={cn("group cursor-pointer border-t border-border hover:bg-secondary/40 focus:bg-secondary/40 focus:outline-none", searchParams?.kam === l.repId && "bg-secondary/40")}>
                      <td className="sticky left-0 z-[1] bg-card px-3 py-2 group-hover:bg-secondary">
                        <Qui nom={l.nom} sous={[l.secteurNom, !buId ? l.buNom : null].filter(Boolean).join(" · ") || "sans secteur"} />
                      </td>
                      <td className="px-3 py-2"><Couverture pct={l.couverture.pct} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.realise} / {l.requis}</td>
                      <td className="px-3 py-2 text-center"><PillePlan etat={l.plan.etat} /></td>
                      <td className={cn("px-3 py-2 text-center tabular-nums", l.rapportsEnRetard > 0 && "font-medium text-warning")}>{l.rapportsEnRetard}</td>
                      <td className="px-3 py-2"><Tendance taux={l.tendance} /></td>
                    </RangeeLien>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="surface h-fit min-w-0 rounded-xl">
          <header className="border-b border-border px-4 py-3"><h2 className="text-[15px] font-semibold">À traiter</h2></header>
          <ATraiter aTraiter={aTraiter} canConfigure={peutConfigurerBu(user)} peutCoacher={peutCoacher} nonVuesHref={lienFdv("/planning", p, { liste: "non-vues" })} />
        </section>
      </div>

      {ventesLisibles && effort.length > 0 && (
        <details className="surface rounded-xl">
          <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-4 py-3">
            <span className="text-[15px] font-semibold">Effort × ventes</span>
            <span className="text-xs text-muted-foreground">{effortSummary(effort)}</span>
          </summary>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <Th className="sticky left-0 z-[1] bg-card">Produit</Th>
                  <Th className="text-right">Visites</Th>
                  <Th className="text-right">Effort</Th>
                  <Th className="text-right">CA du mois</Th>
                  <Th className="text-right">Part CA</Th>
                  <Th className="text-right">DZD / visite</Th>
                </tr>
              </thead>
              <tbody>
                {effort.map((e) => (
                  <tr key={e.productId} className="border-t border-border">
                    <td className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">
                      {e.name}
                      {e.note && <span className={cn("block text-[0.6875rem] font-normal", e.verdict === "EFFORT_SANS_VENTE" ? "text-destructive" : "text-warning")}>{e.note}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.visits}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{e.effortShare} %</td>
                    <td className="px-3 py-2 text-right tabular-nums">{new Intl.NumberFormat("fr-DZ").format(Math.round(e.revenue))}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{e.revenueShare} %</td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.perVisit === null ? "—" : new Intl.NumberFormat("fr-DZ").format(e.perVisit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {fiche && (
        <PanneauAdresse titre={fiche.ligne.nom} description={[fiche.ligne.buNom, fiche.ligne.secteurNom, fiche.superviseur ? `superviseur ${fiche.superviseur}` : null].filter(Boolean).join(" · ")} fermer={lienFdv("/planning", p)}>
          <FicheDelegueVue fiche={fiche} jour={jour} enCours={enCours} peutCoacher={peutCoacher && fiche.ligne.repId !== user.id} ecrire={ecrire && fiche.ligne.repId !== user.id} voirRapports={voirRapports} />
        </PanneauAdresse>
      )}

      {searchParams?.liste === "non-vues" && (
        <PanneauAdresse titre="Cibles H/A non vues depuis 2 cycles" fermer={lienFdv("/planning", p)}>
          <ListeNonVues pilotage={pilotage} year={year} month={month} />
        </PanneauAdresse>
      )}
    </div>
  );
}

// ─────────────────────────────────────────── morceaux ───────────────────────────────────────────

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return <th className={cn("whitespace-nowrap px-3 py-2 font-medium", className)}>{children}</th>;
}

const TON: Record<"ok" | "w" | "ko", string> = { ok: "text-success", w: "text-warning", ko: "text-destructive" };

function Tuile({ titre, info, valeur, pied, ton, valeurTon }: { titre: string; info: string; valeur: string; pied: string; ton?: "ok" | "w" | "ko"; valeurTon?: "ok" | "w" | "ko" }) {
  return (
    <div className="surface flex min-w-0 flex-col gap-0.5 rounded-xl px-3.5 py-3">
      <span className="flex items-start justify-between gap-1 text-xs text-muted-foreground">{titre}<InfoBulle label={`À propos : ${titre}`}>{info}</InfoBulle></span>
      <strong className={cn("text-[22px] font-semibold tabular-nums", valeurTon && TON[valeurTon])}>{valeur}</strong>
      <span className={cn("text-xs", ton ? TON[ton] : "text-muted-foreground")}>{pied}</span>
    </div>
  );
}

function Qui({ nom, sous }: { nom: string; sous: string }) {
  return (
    <span className="flex min-w-[10rem] items-center gap-2.5">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{initials(nom)}</span>
      <span className="min-w-0">
        <span className="block font-medium [overflow-wrap:anywhere]">{nom}</span>
        <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{sous}</small>
      </span>
    </span>
  );
}

function Couverture({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">aucune cible</span>;
  const ton = pct >= 70 ? "bg-success" : pct >= 40 ? "bg-warning" : "bg-destructive";
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-[90px] overflow-hidden rounded-full bg-secondary"><span className={cn("block h-full", ton)} style={{ width: `${pct}%` }} /></span>
      <span className="text-xs tabular-nums text-muted-foreground">{pct} %</span>
    </span>
  );
}

const PILLE: Record<EtatPlan, string> = {
  VALIDE: "bg-success/10 text-success",
  A_VALIDER: "bg-warning/10 text-warning",
  BROUILLON: "bg-muted text-muted-foreground",
  ABSENT: "bg-destructive/10 text-destructive",
};
function PillePlan({ etat }: { etat: EtatPlan }) {
  return <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", PILLE[etat])}>{ETAT_PLAN_LABELS[etat]}</span>;
}

function Tendance({ taux }: { taux: (number | null)[] }) {
  const pts = pointsSparkline(taux);
  if (!pts) return <span className="text-xs text-muted-foreground">—</span>;
  const sens = sensTendance(taux);
  const couleur = sens === "hausse" ? "var(--success, #16a34a)" : sens === "baisse" ? "var(--destructive, #dc2626)" : "currentColor";
  return (
    <svg width="70" height="20" viewBox="0 0 70 20" aria-label={`Tendance : ${sens ?? "—"}`} className="text-muted-foreground">
      <polyline points={pts} fill="none" stroke={couleur} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function LigneATraiter({ ton, titre, sous, action }: { ton: "w" | "ko" | "i"; titre: string; sous: string; action?: React.ReactNode }) {
  const point = ton === "w" ? "bg-warning" : ton === "ko" ? "bg-destructive" : "bg-primary";
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <i className={cn("h-2 w-2 shrink-0 rounded-full", point)} aria-hidden />
      <div className="min-w-0 flex-1">
        <b className="block text-sm font-medium [overflow-wrap:anywhere]">{titre}</b>
        <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{sous}</small>
      </div>
      {action}
    </div>
  );
}

const btnSm = "inline-flex h-8 shrink-0 items-center rounded-[var(--radius)] border border-border bg-card px-2.5 text-xs font-medium hover:bg-secondary";

function ATraiter({ aTraiter, canConfigure, peutCoacher, nonVuesHref }: { aTraiter: Awaited<ReturnType<typeof chargerPilotage>>["aTraiter"]; canConfigure: boolean; peutCoacher: boolean; nonVuesHref: string }) {
  const { plansAValider, ciblesNonVues, secteursVacants, coachingsEnRetard } = aTraiter;
  const rien = !plansAValider.length && !ciblesNonVues.total && !secteursVacants.length && !coachingsEnRetard.length;
  if (rien) return <p className="px-4 py-5 text-sm text-muted-foreground">Rien en attente.</p>;
  const prenoms = (noms: string[]) => noms.slice(0, 3).map((n) => n.split(" ")[0]).join(", ") + (noms.length > 3 ? ` +${noms.length - 3}` : "");
  return (
    <div>
      {plansAValider.length > 0 && (
        <LigneATraiter ton="w" titre={`${plansAValider.length} plan${plansAValider.length > 1 ? "s" : ""} de tournée à valider`} sous={prenoms(plansAValider.map((x) => x.nom))}
          action={<Link href={plansAValider.length === 1 && plansAValider[0].planId ? `/medical/plan-de-tournee?plan=${plansAValider[0].planId}` : "/medical/plan-de-tournee"} className={btnSm}>Ouvrir</Link>} />
      )}
      {ciblesNonVues.total > 0 && (
        <LigneATraiter ton="ko" titre={`${ciblesNonVues.total} cible${ciblesNonVues.total > 1 ? "s" : ""} H/A non vue${ciblesNonVues.total > 1 ? "s" : ""} depuis 2 cycles`}
          sous={ciblesNonVues.decideurs ? `dont ${ciblesNonVues.decideurs} décideur${ciblesNonVues.decideurs > 1 ? "s" : ""}` : "aucun décideur"}
          action={<Link href={nonVuesHref} scroll={false} className={btnSm}>Voir</Link>} />
      )}
      {secteursVacants.map((s) => (
        <LigneATraiter key={s.id} ton="i" titre={`Secteur ${s.nom} sans délégué`} sous={`${s.cibles} praticien${s.cibles > 1 ? "s" : ""} ciblé${s.cibles > 1 ? "s" : ""}, ${s.enA} en A`}
          action={canConfigure ? <Link href={`/business-units?bu=${s.buId}&etape=kams`} className={btnSm}>Affecter</Link> : undefined} />
      ))}
      {coachingsEnRetard.length > 0 && (
        <LigneATraiter ton="i" titre={`${coachingsEnRetard.length} coaching${coachingsEnRetard.length > 1 ? "s" : ""} en retard`} sous={`${prenoms(coachingsEnRetard.map((c) => c.nom))} · dernier il y a plus de 60 j`}
          action={peutCoacher ? <Link href={coachingsEnRetard.length === 1 ? `/medical/coaching/nouvelle?collaborateur=${coachingsEnRetard[0].repId}` : "/medical/coaching"} className={btnSm}>Planifier</Link> : undefined} />
      )}
    </div>
  );
}

function joursDepuis(d: Date | null): string {
  if (!d) return "aucun";
  const j = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return j <= 0 ? "aujourd'hui" : `il y a ${j} j`;
}

function FicheDelegueVue({ fiche, jour, enCours, peutCoacher, ecrire, voirRapports }: { fiche: FicheDelegue; jour: number; enCours: boolean; peutCoacher: boolean; ecrire: boolean; voirRapports: boolean }) {
  const l: LigneDelegue = fiche.ligne;
  const coachingVieux = !fiche.dernierCoaching || Date.now() - fiche.dernierCoaching.getTime() > 60 * 86_400_000;
  return (
    <div className="space-y-5 text-sm">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ce cycle</h3>
        <div className="grid grid-cols-3 gap-2">
          <Kv k="Réalisé / requis" v={`${l.realise} / ${l.requis}`} />
          <Kv k={enCours ? `Attendu à J${jour}` : "Attendu"} v={String(l.attendu)} />
          <Kv k="Rapports en retard" v={String(l.rapportsEnRetard)} ton={l.rapportsEnRetard ? "w" : undefined} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Couverture par lettre</h3>
        {fiche.parLettre.every((x) => x.cibles === 0) ? <p className="text-muted-foreground">Aucune cible segmentée dans son panel.</p> : (
          <div className="space-y-1.5">
            {fiche.parLettre.filter((x) => x.cibles > 0).map((x) => (
              <div key={x.lettre} className="flex items-center gap-3">
                <span className="flex w-28 shrink-0 items-center gap-1.5"><LettreBadge lettre={x.lettre} /> {x.cibles} cible{x.cibles > 1 ? "s" : ""}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary"><span className="block h-full bg-success" style={{ width: `${Math.round((x.vues / x.cibles) * 100)}%` }} /></span>
                <b className="w-8 text-right tabular-nums">{x.vues}</b>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">À voir en priorité</h3>
        {fiche.aVoir.length === 0 ? <p className="text-muted-foreground">Toutes ses cibles H et A ont été vues ce cycle.</p> : (
          <ul className="space-y-1.5">
            {fiche.aVoir.map((c) => (
              <li key={c.doctorId} className="flex items-center justify-between gap-2">
                <Link href={`/praticiens/${c.doctorId}`} className="min-w-0 [overflow-wrap:anywhere] hover:underline">{c.nom}{c.lieu ? ` — ${c.lieu}` : ""}</Link>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", c.lettre === "H" ? "bg-violet-500/10 text-violet-600 dark:text-violet-300" : "bg-warning/10 text-warning")}>{libelleRetardCible(c)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Autour de ses médecins</h3>
        <ul className="space-y-1.5">
          {fiche.adPro.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 [overflow-wrap:anywhere]">{c.nom} — {c.medecins} de ses médecins{c.h ? ` (dont ${c.h} H)` : ""}</span>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Ad &amp; Pro</span>
            </li>
          ))}
          {fiche.adPro.length === 0 && <li className="text-muted-foreground">Aucune prise en charge de ses médecins sur 12 mois.</li>}
          <li className="flex items-center justify-between gap-2"><span>Messages portés ce cycle</span><b className="tabular-nums">{fiche.messagesCeCycle}</b></li>
          <li className="flex items-center justify-between gap-2"><span>Dernier coaching</span><span className={cn(coachingVieux && "text-warning")}>{joursDepuis(fiche.dernierCoaching)}</span></li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <LienAction principal href={l.plan.planId ? `/medical/plan-de-tournee?plan=${l.plan.planId}` : "/medical/plan-de-tournee"}>Voir son plan</LienAction>
        {voirRapports && <LienAction href={lienRapportsDeDelegue(l.repId)}>Voir ses rapports</LienAction>}
        {peutCoacher && <LienAction href={`/medical/coaching/nouvelle?collaborateur=${l.repId}`}>Planifier un coaching</LienAction>}
        {ecrire && <BoutonEcrire userId={l.repId} />}
      </div>
    </div>
  );
}

function Kv({ k, v, ton }: { k: string; v: string; ton?: "w" }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2.5 py-2">
      <span className="block text-[11px] text-muted-foreground">{k}</span>
      <strong className={cn("text-base tabular-nums", ton && "text-warning")}>{v}</strong>
    </div>
  );
}

function ListeNonVues({ pilotage, year, month }: { pilotage: Awaited<ReturnType<typeof chargerPilotage>>; year: number; month: number }) {
  const vus = new Map<string, { nom: string; lieu: string | null; lettre: "H" | "A"; decideur: boolean; cycles: number | null; kams: string[] }>();
  for (const l of pilotage.lignes) {
    for (const d of pilotage.panels.get(l.repId) ?? []) {
      if (d.lettre !== "H" && d.lettre !== "A") continue;
      const cycles = cyclesSansVisite(d.derniereVisite, year, month);
      if (cycles !== null && cycles < 2) continue;
      const cur = vus.get(d.doctorId) ?? { nom: d.nom, lieu: d.lieu, lettre: d.lettre, decideur: d.statut === "DECIDEUR", cycles, kams: [] };
      cur.kams.push(l.nom);
      vus.set(d.doctorId, cur);
    }
  }
  const liste = [...vus].sort(([, a], [, b]) => (a.lettre === b.lettre ? 0 : a.lettre === "H" ? -1 : 1) || (b.cycles ?? Infinity) - (a.cycles ?? Infinity));
  if (liste.length === 0) return <p className="text-sm text-muted-foreground">Aucune.</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {liste.map(([id, d]) => (
        <li key={id} className="flex items-center justify-between gap-2 py-2">
          <span className="min-w-0">
            <Link href={`/praticiens/${id}`} className="font-medium [overflow-wrap:anywhere] hover:underline">{d.nom}</Link>
            <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{[d.lieu, d.kams.join(", "), d.decideur ? "décideur" : null].filter(Boolean).join(" · ")}</small>
          </span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", d.lettre === "H" ? "bg-violet-500/10 text-violet-600 dark:text-violet-300" : "bg-warning/10 text-warning")}>{libelleRetardCible(d)}</span>
        </li>
      ))}
    </ul>
  );
}
