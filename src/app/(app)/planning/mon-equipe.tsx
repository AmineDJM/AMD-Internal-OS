import Link from "next/link";
import { cn, initials } from "@/lib/utils";
import type { LigneDelegue } from "@/lib/queries/force-de-vente";
import type { chargerRapportARelire } from "@/lib/queries/equipe-terrain";
import { ETAT_PLAN_LABELS, type EtatPlan } from "@/lib/force-de-vente/calculs";
import type { ActionEquipe } from "@/lib/force-de-vente/file-actions";
import { LIBELLE_PV, appelleUnHumain, estNiveauPv } from "@/lib/sfe/rapport-visite";
import { lienCasPvKam } from "@/lib/chemins/rapports-terrain";
import { RangeeLien } from "./pilotage-client";
import { RelectureForm } from "./relecture-form";

/**
 * « MON ÉQUIPE TERRAIN » — l'écran du SUPERVISEUR dans Force de vente › Pilotage (Visite médicale, Super Admin 11/2026 :
 * « le superviseur relit les rapports et suit les retards »).
 *
 * En tête, la FILE D'ACTIONS : une ligne = un fait = un bouton — les rapports à relire (les possibles cas de
 * pharmacovigilance d'abord, avec la raison et la phrase exacte), puis les plans à décider, les rapports non faits, les
 * panels vides, les coachings dus, les signalements en cours. Dessous, le tableau de l'équipe, réduit à ce qui se suit
 * au quotidien. Tout est calculé ailleurs (pilotage, `chargerEquipeTerrain`, `file-actions.ts`) : ici, on affiche.
 */

const POINT: Record<ActionEquipe["ton"], string> = { ko: "bg-destructive", w: "bg-warning", i: "bg-primary" };
const btn = "inline-flex h-9 shrink-0 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8";

function LigneAction({ a }: { a: ActionEquipe }) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <i className={cn("h-2 w-2 shrink-0 rounded-full", POINT[a.ton])} aria-hidden />
      <div className="min-w-0 flex-1">
        <b className="block text-sm font-medium [overflow-wrap:anywhere]">{a.titre}</b>
        {a.sous && <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{a.sous}</small>}
        {a.citation && <small className="block text-xs italic [overflow-wrap:anywhere]">« {a.citation} »</small>}
      </div>
      {a.bouton && <Link href={a.bouton.href} scroll={false} className={btn}>{a.bouton.libelle}</Link>}
    </li>
  );
}

export function FileActionsEquipe({ aRelire, totalARelire, autres, tousLesRapports }: {
  aRelire: ActionEquipe[];
  totalARelire: number;
  autres: ActionEquipe[];
  /** La liste des Rapports, pour lire au-delà des premiers de la file (null : la personne ne la lit pas). */
  tousLesRapports: string | null;
}) {
  const rien = totalARelire === 0 && autres.length === 0;
  return (
    <section className="surface min-w-0 rounded-xl">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">À faire</h2>
        <span className="text-xs text-muted-foreground">une ligne, un geste</span>
      </header>
      {rien ? <p className="px-4 py-5 text-sm text-muted-foreground">Rien en attente : l&apos;équipe est à jour.</p> : (
        <>
          {totalARelire > 0 && (
            <div>
              <h3 className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Rapports à relire ({totalARelire})</span>
                {tousLesRapports && totalARelire > aRelire.length && (
                  <Link href={tousLesRapports} className="normal-case tracking-normal text-primary hover:underline">Tous les rapports</Link>
                )}
              </h3>
              <ul>{aRelire.map((a) => <LigneAction key={a.cle} a={a} />)}</ul>
            </div>
          )}
          {autres.length > 0 && <ul className={cn(totalARelire > 0 && "border-t border-border")}>{autres.map((a) => <LigneAction key={a.cle} a={a} />)}</ul>}
        </>
      )}
    </section>
  );
}

const PILLE: Record<EtatPlan, string> = {
  VALIDE: "bg-success/10 text-success",
  A_VALIDER: "bg-warning/10 text-warning",
  BROUILLON: "bg-muted text-muted-foreground",
  ABSENT: "bg-destructive/10 text-destructive",
};

function joursDepuis(d: Date | null, maintenant: Date): string {
  if (!d) return "jamais";
  const j = Math.floor((maintenant.getTime() - d.getTime()) / 86_400_000);
  return j <= 0 ? "aujourd'hui" : `il y a ${j} j`;
}

/** LE TABLEAU DE L'ÉQUIPE, RÉDUIT — KAM, visites du mois, couverture, retards, plan, coaching. Une ligne ouvre sa fiche. */
export function TableauEquipe({ lignes, lienFiche, maintenant, kamOuvert }: {
  lignes: readonly LigneDelegue[];
  lienFiche: (repId: string) => string;
  maintenant: Date;
  kamOuvert: string | null;
}) {
  return (
    <section className="surface min-w-0 rounded-xl">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">Mon équipe</h2>
        <span className="text-xs text-muted-foreground">{lignes.length} délégué{lignes.length > 1 ? "s" : ""}, triés par retard</span>
      </header>
      {lignes.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Aucun délégué dans les BU que vous supervisez.</p> : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-[1] whitespace-nowrap bg-card px-3 py-2 font-medium">KAM</th>
                <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Faites / planifiées</th>
                <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Couverture H·A·B</th>
                <th className="whitespace-nowrap px-3 py-2 text-center font-medium">Rapports en retard</th>
                <th className="whitespace-nowrap px-3 py-2 text-center font-medium">Plan</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">Dernier coaching</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <RangeeLien key={l.repId} href={lienFiche(l.repId)} label={`Ouvrir la fiche de ${l.nom}`}
                  className={cn("group cursor-pointer border-t border-border hover:bg-secondary/40 focus:bg-secondary/40 focus:outline-none", kamOuvert === l.repId && "bg-secondary/40")}>
                  <td className="sticky left-0 z-[1] bg-card px-3 py-2 group-hover:bg-secondary">
                    <span className="flex min-w-[9rem] items-center gap-2.5">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{initials(l.nom)}</span>
                      <span className="min-w-0">
                        <span className="block font-medium [overflow-wrap:anywhere]">{l.nom}</span>
                        <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.secteurNom ?? "sans secteur"}</small>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.visites.faites} / {l.visites.planifiees}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.couverture.pct === null ? <span className="text-xs text-muted-foreground">aucune cible</span> : `${l.couverture.pct} %`}</td>
                  <td className={cn("px-3 py-2 text-center tabular-nums", l.rapportsEnRetard > 0 && "font-medium text-warning")}>{l.rapportsEnRetard}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", PILLE[l.plan.etat])}>{ETAT_PLAN_LABELS[l.plan.etat]}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{joursDepuis(l.dernierCoaching, maintenant)}</td>
                </RangeeLien>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type RapportARelire = NonNullable<Awaited<ReturnType<typeof chargerRapportARelire>>>;

/** LE RAPPORT, EN LECTURE, ET LE GESTE « RELU » — le contenu du panneau ouvert par `?relire=`. */
export function RapportEnRelecture({ r }: { r: RapportARelire }) {
  const v = r.visite;
  const bloc = (titre: string, texte: string | null) => texte && (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titre}</p>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{texte}</p>
    </div>
  );
  return (
    <div className="space-y-4 text-sm">
      {appelleUnHumain(v.pvIa) && estNiveauPv(v.pvIa) && (
        <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="font-medium">{LIBELLE_PV[v.pvIa]} <span className="font-normal text-muted-foreground">— relevé par l&apos;IA, à confirmer</span></p>
          {v.pvIaRaison && <p className="text-muted-foreground">{v.pvIaRaison}</p>}
          {v.pvIaExtrait && <p className="italic">« {v.pvIaExtrait} »</p>}
          {v.casPharmacovigilance.length === 0 && <p className="text-xs text-muted-foreground">Le délégué a été invité à le signaler ; aucun cas n&apos;est encore rattaché à cette visite.</p>}
        </div>
      )}
      {v.casPharmacovigilance.length > 0 && (
        <p>
          Signalement{v.casPharmacovigilance.length > 1 ? "s" : ""} rattaché{v.casPharmacovigilance.length > 1 ? "s" : ""} :{" "}
          {v.casPharmacovigilance.map((c, i) => (
            <span key={c.id}>{i > 0 && ", "}<Link href={lienCasPvKam(c.id)} className="text-primary hover:underline">{c.reference}</Link></span>
          ))}
        </p>
      )}
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Produits · messages</p>
        <p>{v.productLinks.map((l) => l.product.canonicalName).join(" · ") || "—"}</p>
        {v.messageLinks.length > 0 && <p className="text-muted-foreground">{v.messageLinks.map((l) => l.message.title).join(" · ")}</p>}
      </div>
      {bloc("Compte rendu", v.report)}
      {bloc("Retour du médecin", v.doctorFeedback)}
      {bloc("Ce qu'il reste à faire", v.followUpActions)}
      <div className="border-t border-border pt-4">
        {v.reluLe ? (
          <div className="space-y-1">
            <p>Relu{r.relecteur ? ` par ${r.relecteur}` : ""} le {v.reluLe.toLocaleDateString("fr-FR")}.</p>
            {v.reluCommentaire && <p className="whitespace-pre-wrap rounded-lg bg-secondary/50 px-3 py-2 [overflow-wrap:anywhere]">{v.reluCommentaire}</p>}
          </div>
        ) : r.peutRelire ? <RelectureForm visitId={v.id} /> : (
          <p className="text-muted-foreground">Seul le superviseur de la BU de ce délégué, ou son N+1, marque ce rapport relu.</p>
        )}
      </div>
    </div>
  );
}
