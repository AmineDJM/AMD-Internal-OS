"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, CalendarRange, Check, Clock, FilePlus2, Loader2, MapPin, RotateCcw, Send, ShieldAlert, Users, X,
} from "lucide-react";
import { lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import {
  planifierVisites, soumettrePlanTournee, escaladerPlanTournee, deciderPlanTournee, demanderRevisionPlanTournee,
} from "@/lib/actions/tour-plan-actions";
import { useAction } from "@/components/shared/use-action";
import { STATUT_PLAN_LABELS, aResoumettre, gestesPossibles, type StatutPlan } from "@/lib/sfe/tournee";
import { deplacerCellule, etatCellule, gesteCellule, grilleModifiable, retirerCellule } from "@/lib/sfe/grille-tournee";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import {
  FeuilleNonTenue, FeuilleRapportVisite, FeuilleVisiteImprevue, type GammeVue,
} from "../ma-journee/emploi-du-temps";
import { GrilleTournee, jourLisible as jourDeLaGrille, type InfoPraticien, type LigneDuPlan } from "./grille";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { EntreeMenu, MenuPlus } from "../menu-plus";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import type { Lettre } from "@/lib/segmentation/regles";

/**
 * Au téléphone, les deux gestes de la barre se partagent la largeur à hauteur de pouce, et leur
 * libellé passe à la ligne plutôt que de déborder ; au bureau, ils reprennent leur taille.
 */
const BOUTON_BARRE =
  "h-auto min-h-12 min-w-0 flex-1 basis-32 whitespace-normal py-2 leading-tight sm:h-10 sm:min-h-0 sm:flex-none sm:basis-auto sm:whitespace-nowrap sm:py-0";

/** La barre d'action collée au bas d'une feuille (même principe que les feuilles de « Ma journée »). */
const BARRE_FEUILLE =
  "sticky bottom-0 z-10 -mx-4 flex gap-2 border-t border-border bg-card px-4 py-3 shadow-[0_3rem_0_0_hsl(var(--card))] sm:-mx-5 sm:justify-end sm:px-5";

export interface PraticienVue {
  id: string; name: string; specialty: string | null; institution: string | null;
  wilaya: string | null; potential: string | null; secteur: string | null;
  /** La lettre de segmentation (Direction, 07/10) et les visites qu'elle demande par cycle ; null = hors segmentation. */
  lettre?: Lettre | null; requis?: number;
}

/**
 * LE PLANIFICATEUR DE TOURNÉE — un EMPLOI DU TEMPS : les jours en colonnes, les professionnels de santé dans les
 * cellules (Direction, 06/10).
 *
 * ── LA GRILLE, ET LA FAÇON D'AJOUTER QUI RESTE ─────────────────────────────────────────────
 *
 * La grille (`GrilleTournee`) montre la semaine : sur ordinateur, une colonne par jour ; sur téléphone, un jour par
 * écran. On y AJOUTE comme avant — le « + » d'une colonne ouvre le même choix : la wilaya où l'on sera, le secteur,
 * la recherche, et les praticiens du panel à cocher pour ce jour. On y DÉPLACE (glisser une carte, ou son menu) et
 * on y RETIRE, tant que le plan est ouvert (brouillon, rejeté, rouvert en révision) — `grilleModifiable`, la même règle
 * que l'action `planifierVisites`, qui la revérifie.
 *
 * ── UNE FOIS VALIDÉ, LA GRILLE OUVRE LE RAPPORT ─────────────────────────────────────────────
 *
 * Toucher un praticien « à faire » ouvre le rapport de SA visite — la même feuille, la même action (`rapporterVisite`)
 * que « Ma journée » : une seule porte vers le compte rendu d'une visite planifiée, et la cellule passe au vert sur le
 * même fait que la ligne de l'emploi du temps. Le bouton « Faire un rapport », au-dessus de la grille, ouvre une
 * visite du plan à rapporter, ou la visite IMPRÉVUE de « Ma journée » pour une rencontre hors plan.
 *
 * ── POURQUOI LE CHOIX SE FAIT TOUJOURS PAR JOUR ─────────────────────────────────────────────
 *
 * La demande le dit dans ces termes : « il sélectionne la ville dans laquelle il sera dispo la
 * semaine du 18, puis les médecins qu'il va voir — chaque jour de cette semaine ». On choisit donc un
 * JOUR, on cadre par VILLE ou par SECTEUR, et les praticiens du cadre s'offrent à cocher.
 *
 * ── CE QUI EST PRÉ-SÉLECTIONNÉ ──────────────────────────────────────────────────────────────
 *
 * Rien n'est coché à sa place : ce serait décider de sa tournée. Ce qui est PRÉ-CADRÉ, c'est le
 * panel — les praticiens de ses secteurs et ceux qui lui sont rattachés, et eux seuls. Cocher un
 * praticien qui n'est pas à lui est impossible parce qu'il n'apparaît pas.
 *
 * ── LA SÉLECTION PART COMPLÈTE ──────────────────────────────────────────────────────────────
 *
 * L'enregistrement REMPLACE la sélection du plan : c'est ce qui fait que décocher retire. Les
 * visites DÉJÀ RAPPORTÉES sont montrées verrouillées — elles ont eu lieu, et les retirer
 * effacerait un fait au profit d'une intention.
 */
export function Planificateur({
  planId, repName, status, periodStart, periodEnd, joursOuvres, submittedAt, retard,
  reviewerName, escalatedToName, rejectionComment,
  praticiens, panelVide, pairesInitiales, pairesAcquises, pairesNonTenues, pairesPassees, jePeuxDecider, jePeuxEscalader,
  revisionNote, revisionPar, revisionLe, jePeuxDemanderRevision, jeSuisLeKam,
  aujourdhui, dejaValide, lignes, gamme, stock, peutRapporter, peutSignalerPv = false,
}: {
  /** Le KAM peut signaler un cas de pharmacovigilance (`signaleDesCasPv`) : le bouton au-dessus de la grille, et la feuille d'une visite. */
  peutSignalerPv?: boolean;
  /** `AAAA-MM-JJ` du jour, calculé par le serveur. */
  aujourdhui: string;
  /** Validé au moins une fois : ses visites sont dans l'emploi du temps, et la grille ouvre leur rapport. */
  dejaValide: boolean;
  /** Les visites ENREGISTRÉES du plan, lues comme « Ma journée » les lit (`loadVisitesDuPlan`). */
  lignes: LigneDuPlan[];
  /** La gamme du KAM — ce que le formulaire de rapport propose. */
  gamme: GammeVue;
  /** Le matériel en main du KAM (bloc « Matériel remis » du rapport). */
  stock: StockPourVisite;
  /** Le lecteur est le KAM et peut saisir ses visites : la grille ouvre ses rapports. */
  peutRapporter: boolean;
  planId: string;
  repName: string;
  status: StatutPlan;
  periodStart: string;
  periodEnd: string;
  /** Les jours OUVRÉS de la période (semaine algérienne) — les seuls où l'on peut poser une visite. */
  joursOuvres: string[];
  submittedAt: string | null;
  /** Le retard de soumission, CALCULÉ par le chargeur — l'écran l'affiche, il ne le recalcule pas
   *  (un `new Date()` au rendu diverge entre serveur et navigateur). `echeance` est celle qui
   *  compte : la resoumission sur un plan rejeté, la soumission sinon. */
  retard: { enRetard: boolean; jours: number; echeance: string };
  reviewerName: string | null;
  escalatedToName: string | null;
  rejectionComment: string | null;
  /** Lu par l'échéance de l'en-tête (`retard.echeance`) ; gardé au contrat de la page. */
  resubmitDueAt: string | null;
  praticiens: PraticienVue[];
  /** La VRAIE cause d'un panel vide (`diagnosticPanelVide`), ou null quand le panel ne l'est pas. */
  panelVide?: string | null;
  pairesInitiales: string[];
  pairesAcquises: string[];
  /** Parmi les acquises, celles DITES non tenues (reportées, annulées) — le reste est rapporté. */
  pairesNonTenues: string[];
  /** Les visites passées d'un plan déjà validé : une révision ne les retire pas (§118.193). */
  pairesPassees: string[];
  /** Le lecteur est-il le KAM du plan ? (La phrase d'état dit « chez vous » ; la grille s'en remet à `peutRapporter` et `grilleModifiable`.) */
  jeSuisLeKam: boolean;
  jePeuxDecider: boolean;
  jePeuxEscalader: boolean;
  /** La révision en cours d'un plan validé — son motif, qui, quand. */
  revisionNote: string | null;
  revisionPar: string | null;
  revisionLe: string | null;
  /** Peut-il ÉCRIRE ce plan (le KAM, le superviseur de sa BU, la Direction) ? La même règle que l'action. */
  jePeuxDemanderRevision: boolean;
}) {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : les gestes restent fermés tant que l'écran montre l'état d'avant.
  const { busy: occupe, err, setErr, run: lancer } = useAction();
  const gestes = gestesPossibles(status);
  const acquises = React.useMemo(() => new Set(pairesAcquises), [pairesAcquises]);
  const nonTenues = React.useMemo(() => new Set(pairesNonTenues), [pairesNonTenues]);
  const passees = React.useMemo(() => new Set(pairesPassees), [pairesPassees]);

  const [paires, setPaires] = React.useState<Set<string>>(() => new Set(pairesInitiales));
  const [jour, setJour] = React.useState(joursOuvres[0] ?? "");
  const [wilaya, setWilaya] = React.useState("");
  const [secteur, setSecteur] = React.useState("");
  const [q, setQ] = React.useState("");
  const [rejet, setRejet] = React.useState(false);
  const [sale, setSale] = React.useState(false);
  const [revision, setRevision] = React.useState(false);
  const [motifRevision, setMotifRevision] = React.useState("");
  /** Le choix des praticiens d'un jour (le « + » d'une colonne) est-il ouvert ? */
  const [choixOuvert, setChoixOuvert] = React.useState(false);
  /** La visite dont on rédige (ou corrige) le rapport, celle qu'on dit non tenue, le choix « Nouveau rapport ». */
  const [aRapporter, setARapporter] = React.useState<LigneDuPlan | null>(null);
  const [nonTenue, setNonTenue] = React.useState<LigneDuPlan | null>(null);
  const [nouveauRapport, setNouveauRapport] = React.useState(false);
  const [imprevue, setImprevue] = React.useState(false);
  // QUI MODIFIE LA GRILLE : la MÊME règle que l'action — plan ouvert, et le KAM, le superviseur de sa BU ou la Direction.
  const modifiable = grilleModifiable(status, jePeuxDemanderRevision);
  const verrouillees = React.useMemo(() => new Set([...acquises, ...passees]), [acquises, passees]);

  // LA WILAYA, pas la ville : la ville a quitté les annuaires (texte libre tapé de trois façons
  // pour le même endroit) ; la wilaya est une liste fermée, donc un filtre qui ne ment pas.
  const wilayas = React.useMemo(
    () => [...new Set(praticiens.map((p) => p.wilaya).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, "fr")),
    [praticiens],
  );
  const secteurs = React.useMemo(
    () => [...new Set(praticiens.map((p) => p.secteur).filter((s): s is string => Boolean(s)))].sort((a, b) => a.localeCompare(b, "fr")),
    [praticiens],
  );

  const visibles = praticiens.filter((p) => {
    if (wilaya && p.wilaya !== wilaya) return false;
    if (secteur && p.secteur !== secteur) return false;
    if (!q.trim()) return true;
    return `${p.name} ${p.specialty ?? ""} ${p.institution ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
  });

  const cle = (j: string, id: string) => `${j}|${id}`;
  const compteDuJour = (j: string) => [...paires].filter((k) => k.startsWith(`${j}|`)).length;

  const basculer = (j: string, id: string) => {
    const k = cle(j, id);
    // UNE VISITE DÉJÀ RAPPORTÉE NE SE DÉPLANIFIE PAS : elle a eu lieu. Celle d'un plan déjà validé dont l'heure
    // est passée non plus : la révision ne change que l'avenir (§118.193).
    if (acquises.has(k) || passees.has(k)) return;
    setPaires((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
    setSale(true);
  };

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => lancer(() => action(fd));

  const enregistrer = async () => {
    const fd = new FormData();
    fd.set("planId", planId);
    for (const k of paires) fd.append("visite", k);
    if (await run(planifierVisites, fd)) setSale(false);
  };

  const jourLisible = (j: string) => jourDeLaGrille(j);

  const tonStatut = status === "APPROVED" ? "success" : status === "REJECTED" ? "danger"
    : status === "SUBMITTED" || status === "ESCALATED" || status === "REVISION" ? "warning" : "neutral";

  // CE QUE LA CELLULE MONTRE D'UN PRATICIEN : le panel d'abord ; un praticien sorti du panel depuis se lit sur sa
  // visite enregistrée, et reste nommé — jamais une cellule vide (§118.71).
  const lignesParCle = React.useMemo(() => new Map(lignes.map((l) => [l.cle, l])), [lignes]);
  const infos = React.useMemo(() => {
    const m = new Map<string, InfoPraticien>();
    for (const l of lignes) {
      const id = l.cle.slice(l.cle.indexOf("|") + 1);
      m.set(id, { name: l.doctorName, specialty: l.specialty, institution: l.institution, wilaya: l.wilaya, potential: null, secteur: null });
    }
    for (const p of praticiens) {
      m.set(p.id, { name: p.name, specialty: p.specialty, institution: p.institution, wilaya: p.wilaya, potential: p.potential, lettre: p.lettre ?? null, secteur: p.secteur });
    }
    return m;
  }, [lignes, praticiens]);
  const infoDe = React.useCallback(
    (id: string): InfoPraticien => infos.get(id) ?? { name: "Praticien hors panel", specialty: null, institution: null, wilaya: null, potential: null, secteur: null },
    [infos],
  );

  // ── LES GESTES DE LA GRILLE — le module pur décide, l'écran applique (la sélection part complète à l'enregistrement).
  const ajouterAuJour = (j: string) => { setErr(null); setJour(j); setChoixOuvert(true); };
  const deplacer = (cle: string, versJour: string): string | null => {
    const r = deplacerCellule(paires, cle, versJour, joursOuvres, verrouillees);
    if (!r.ok) { setErr(r.raison); return r.raison; }
    if (r.paires.size !== paires.size || [...r.paires].some((k) => !paires.has(k))) { setPaires(r.paires); setSale(true); }
    return null;
  };
  const retirer = (cle: string): string | null => {
    const r = retirerCellule(paires, cle, verrouillees);
    if (!r.ok) { setErr(r.raison); return r.raison; }
    setPaires(r.paires); setSale(true);
    return null;
  };

  // LES VISITES À RAPPORTER MAINTENANT — pour le choix « Faire un rapport » : celles que la grille ouvrirait
  // (la même règle, `etatCellule` + `gesteCellule`), la plus récente d'abord.
  const aRapporterMaintenant = React.useMemo(
    () => lignes
      .filter((l) => gesteCellule({
        etat: etatCellule({ etatEnregistre: l.etat, planValide: dejaValide, jour: l.cle.slice(0, 10), aujourdhui }),
        heuresRestantes: l.heuresRestantes, planValide: dejaValide, jeSuisLeKam: peutRapporter,
      }) === "RAPPORTER")
      .sort((a, b) => b.date.localeCompare(a.date)),
    [lignes, aujourdhui, dejaValide, peutRapporter],
  );

  // ── L'ÉTAT DU PLAN EN UNE PHRASE « état — chez qui » (Direction, 07/10) ──────────────────────
  const chezLeKam = jeSuisLeKam ? "chez vous" : `chez ${repName}`;
  const phraseStatut = status === "APPROVED" ? "Validé"
    : status === "SUBMITTED" ? `Soumis — ${jePeuxDecider ? "chez vous" : reviewerName ? `chez ${reviewerName}` : "chez le validateur"}`
      : status === "ESCALATED" ? `Escaladé — ${jePeuxDecider ? "chez vous" : escalatedToName ? `chez ${escalatedToName}` : "chez le N+2"}`
        : status === "REJECTED" ? `Rejeté — ${chezLeKam}`
          : status === "REVISION" ? `En révision — ${chezLeKam}`
            : `Brouillon — ${chezLeKam}`;
  // LES GESTES SECONDAIRES DU PLAN, rangés dans « ⋯ » : l'escalade et la demande de révision.
  const peutEscalader = jePeuxEscalader && gestes.escaladable && gestes.decidable;
  const peutReviser = gestes.revisable && jePeuxDemanderRevision;

  return (
    <div className="space-y-4">
      {/* ── L'ÉTAT DU PLAN, ET CE QU'ON ATTEND ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border p-3 text-sm">
        <Badge tone={tonStatut}>{phraseStatut}</Badge>
        <span className="min-w-0 text-xs text-muted-foreground">
          {repName} · {new Date(periodStart).toLocaleDateString("fr-FR")} → {new Date(periodEnd).toLocaleDateString("fr-FR")}
          {" · "}<strong className="text-foreground tabular-nums">{paires.size}</strong> visite(s)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {/* UN PLAN OUVERT (brouillon, rejeté) montre son échéance — ou son RETARD. Un plan rejeté
              porte encore la date de sa première soumission : la montrer ici dirait « soumis »
              d'un plan qu'il faut resoumettre. */}
          {!gestes.soumettable
            ? (submittedAt ? `Soumis le ${new Date(submittedAt).toLocaleDateString("fr-FR")}` : STATUT_PLAN_LABELS[status])
            : retard.enRetard
              ? (
                <span className="font-medium text-destructive">
                  En retard de {retard.jours} j — échéance dépassée le {new Date(retard.echeance).toLocaleDateString("fr-FR")}
                </span>
              )
              : `À ${aResoumettre(status) ? "resoumettre" : "soumettre"} avant le ${new Date(retard.echeance).toLocaleDateString("fr-FR")}`}
        </span>
        {(peutEscalader || peutReviser) && (
          <MenuPlus label="Autres actions sur le plan">
            {peutEscalader && (
              <EntreeMenu disabled={occupe} onClick={() => { const fd = new FormData(); fd.set("planId", planId); void run(escaladerPlanTournee, fd); }}>
                <ArrowUpRight className="h-4 w-4" /> Demander à mon N+1
              </EntreeMenu>
            )}
            {peutReviser && (
              <EntreeMenu disabled={occupe} onClick={() => { setErr(null); setRevision(true); }}>
                <RotateCcw className="h-4 w-4" /> Demander une révision
              </EntreeMenu>
            )}
          </MenuPlus>
        )}
      </div>

      {/* LE REJET PORTE SON MOTIF. Un rejet sans motif ne se corrige pas, il se subit ; son délai est l'échéance
          de l'en-tête (`retard.echeance` est celle de la resoumission). */}
      {status === "REJECTED" && rejectionComment && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p className="text-xs font-medium text-destructive">Motif du rejet</p>
          <p className="mt-1 whitespace-pre-wrap">{rejectionComment}</p>
        </div>
      )}

      {/* LA RÉVISION D'UN PLAN VALIDÉ PORTE SON MOTIF, QUI, QUAND (§118.193). Le validateur la lit aussi une fois le
          plan resoumis : c'est ce qu'il doit juger. Son délai est l'échéance de l'en-tête. */}
      {revisionNote && (status === "REVISION" || status === "SUBMITTED" || status === "ESCALATED") && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="text-xs font-medium">
            Révision demandée{revisionPar ? ` par ${revisionPar}` : ""}{revisionLe ? ` le ${new Date(revisionLe).toLocaleDateString("fr-FR")}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap">« {revisionNote} »</p>
        </div>
      )}

      {err && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {/* ── LA DÉCISION DU VALIDATEUR — un geste principal (Valider), le rejet à côté, l'escalade dans « ⋯ ». ── */}
      {jePeuxDecider && gestes.decidable && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
          <p className="mr-auto text-sm font-medium">À votre décision</p>
          <Button variant="outline" size="sm" className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={occupe} onClick={() => { setErr(null); setRejet(true); }}>
            <X className="h-4 w-4" /> Rejeter
          </Button>
          <BoutonDecisif
            size="sm" className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={occupe}
            onClick={() => {
              const fd = new FormData();
              fd.set("planId", planId); fd.set("decision", "APPROVE");
              void run(deciderPlanTournee, fd);
            }}
          >
            <Check className="h-4 w-4" /> Valider le plan
          </BoutonDecisif>
        </div>
      )}

      {/* ── DEMANDER UNE RÉVISION (§118.193) — un plan validé ne se réécrit pas sous les pieds du KAM : il se
          rouvre, motif à l'appui, et repasse en validation. Ouvert depuis « ⋯ ». ─────────────────── */}
      <Sheet
        open={revision && peutReviser}
        onClose={() => { setRevision(false); setMotifRevision(""); }}
        title="Demander une révision"
        description="Le plan repasse en validation."
        width="md"
      >
        <form
          className="space-y-3"
          action={async (fd) => {
            fd.set("planId", planId);
            if (await run(demanderRevisionPlanTournee, fd)) { setRevision(false); setMotifRevision(""); }
          }}
        >
          <div>
            <div className="flex items-center gap-1">
              <Label htmlFor="revision-note">Ce qui change dans la tournée</Label>
              <InfoBulle label="Ce qui se passe ensuite" align="left">
                Le plan repassera « En révision » : vous le modifiez, puis vous le resoumettez (48 h). Les visites déjà passées
                restent au plan.
              </InfoBulle>
            </div>
            <Textarea id="revision-note" name="note" rows={3} value={motifRevision} onChange={(e) => setMotifRevision(e.target.value)}
              placeholder="Le Dr Amrani est en congé la semaine du 18 ; je reporte ses visites et ajoute le CHU de Blida." />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className={BARRE_FEUILLE}>
            <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" disabled={occupe} onClick={() => { setRevision(false); setMotifRevision(""); }}>Annuler</Button>
            <BoutonDecisif type="submit" className="h-12 flex-1 sm:h-10" disabled={occupe || motifRevision.trim().length === 0}>
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Rouvrir pour révision
            </BoutonDecisif>
          </div>
        </form>
      </Sheet>

      {/* ── L'EMPLOI DU TEMPS DE LA TOURNÉE — les jours en colonnes, les praticiens dans les cellules ─────────── */}
      <section className="space-y-2" aria-labelledby="grille-titre">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="grille-titre" className="mr-auto flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {modifiable ? <CalendarRange className="h-3.5 w-3.5" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />}
            {modifiable ? "Emploi du temps de la tournée" : "Visites prévues"}
            {/* LE DÉTAIL, EN LECTURE (§118.184) : le validateur voit, jour par jour, qui le KAM va voir. Pourquoi il ne
                se modifie pas se lit derrière le ⓘ, plus en paragraphe sous la grille (Direction, 07/10). */}
            {!modifiable && (
              <InfoBulle label="Pourquoi en lecture" align="left" className="normal-case tracking-normal">
                {gestes.modifiable
                  ? "Seul le KAM (ou le superviseur de sa BU) modifie ce plan."
                  : gestes.revisable
                    ? "Un plan validé ne se modifie pas en direct : sa tournée a commencé. « Demander une révision » (menu ⋯) le rouvre, motif à l'appui — il repasse en validation, et ce qui a déjà eu lieu reste."
                    : "Un plan soumis attend la décision de son validateur : il ne se modifie qu'une fois rejeté, ou validé puis rouvert en révision."}
              </InfoBulle>
            )}
          </h2>
          {/* LE RAPPORT TERRAIN, AU-DESSUS DE L'EMPLOI DU TEMPS (Direction, 06-07/10) : une visite du plan à rapporter, ou
              une rencontre hors plan — les deux portes de « Ma journée », jamais une troisième. Sans visite à rapporter
              maintenant, le bouton ouvre directement la rencontre hors plan. La pharmacovigilance, en geste secondaire. */}
          {peutRapporter && (
            <div className="grid w-full grid-cols-[1fr_auto] gap-2 sm:flex sm:w-auto">
              <Button
                size="sm" className="h-12 text-sm sm:h-8 sm:text-xs" disabled={occupe}
                onClick={() => { setErr(null); if (dejaValide && aRapporterMaintenant.length > 0) setNouveauRapport(true); else setImprevue(true); }}
              >
                <FilePlus2 className="h-4 w-4" /> Faire un rapport
              </Button>
              {peutSignalerPv && (
                <Link href={lienSignalerPv()} className="inline-flex h-12 items-center justify-center gap-1.5 rounded-lg border border-warning/50 px-3 text-sm font-medium hover:bg-warning/10 sm:h-8 sm:text-xs">
                  <ShieldAlert className="h-4 w-4" /> Pharmacovigilance
                </Link>
              )}
            </div>
          )}
        </div>
        {praticiens.length === 0 && modifiable && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <strong>Panel vide.</strong>{" "}
            {panelVide ?? "Aucun praticien rattaché à votre territoire."}
          </p>
        )}
        <GrilleTournee
          joursOuvres={joursOuvres}
          paires={paires}
          aujourdhui={aujourdhui}
          infoDe={infoDe}
          lignesParCle={lignesParCle}
          verrouillees={verrouillees}
          planValide={dejaValide}
          exportHref={dejaValide ? `/api/medical/plan-de-tournee/${planId}/pdf` : null}
          jeSuisLeKam={peutRapporter}
          modifiable={modifiable}
          occupe={occupe}
          onAjouter={ajouterAuJour}
          onDeplacer={deplacer}
          onRetirer={retirer}
          onRapporter={(l) => { setErr(null); setARapporter(l); }}
          onNonTenue={(l) => { setErr(null); setNonTenue(l); }}
          lienPv={peutRapporter && peutSignalerPv ? lienSignalerPv : null}
        />
      </section>

      {modifiable && (
        // ENREGISTRER, PUIS SOUMETTRE — UN geste à la fois (Direction, 07/10) : tant qu'il y a à enregistrer, seul
        // « Enregistrer le plan » se montre (soumettre une sélection non enregistrée ferait valider un plan que le
        // validateur ne verrait pas) ; une fois enregistré, « Soumettre à validation » prend sa place. La barre
        // reste sous le pouce, en bas de l'écran, tant qu'il y a à enregistrer.
        <div className={cn(
          "flex flex-wrap items-center justify-end gap-2 rounded-xl border border-border bg-card/95 p-2.5 backdrop-blur",
          sale && "sticky bottom-2 z-10 border-warning/50 shadow-md",
        )}>
          {sale
            ? <span className="w-full text-xs text-warning sm:mr-auto sm:w-auto">Modifications non enregistrées</span>
            : <span className="w-full text-xs text-muted-foreground sm:mr-auto sm:w-auto"><strong className="text-foreground tabular-nums">{paires.size}</strong> visite(s) au plan</span>}
          {sale ? (
            <Button className={BOUTON_BARRE} onClick={() => void enregistrer()} disabled={occupe}>
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer le plan
            </Button>
          ) : (
            <Button
              className={BOUTON_BARRE}
              disabled={occupe || paires.size === 0}
              onClick={() => { const fd = new FormData(); fd.set("planId", planId); void run(soumettrePlanTournee, fd); }}
            >
              <Send className="h-4 w-4" /> Soumettre à validation
            </Button>
          )}
        </div>
      )}

      {/* ── AJOUTER DES PRATICIENS À UN JOUR — la façon d'ajouter d'avant, ouverte par le « + » d'une colonne ── */}
      <Sheet
        open={choixOuvert && modifiable}
        onClose={() => setChoixOuvert(false)}
        title={`Praticiens à voir le ${jour ? jourLisible(jour) : "—"}`}
        width="lg"
      >
        <div className="space-y-4">
          {/* LES JOURS OUVRÉS, avec leur compte. La semaine ouvrée algérienne va du dimanche au
              jeudi : proposer un vendredi ferait planifier un jour où personne ne sort. */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Jour de la tournée</p>
            <div className="flex flex-wrap gap-1.5">
              {joursOuvres.map((j) => {
                const n = compteDuJour(j);
                return (
                  <button
                    key={j} type="button" onClick={() => setJour(j)}
                    aria-current={j === jour ? "true" : undefined}
                    className={cn(
                      "min-h-10 rounded-lg px-2.5 py-2 text-xs tabular-nums sm:min-h-0 sm:px-2 sm:py-1.5",
                      j === jour ? "bg-primary text-primary-foreground" : "border border-input hover:bg-secondary",
                    )}
                  >
                    {jourLisible(j)}
                    {n > 0 && <span className={cn("ml-1 rounded px-1", j === jour ? "bg-primary-foreground/20" : "bg-secondary")}>{n}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* LE CADRE : la wilaya où il sera, ou son secteur. */}
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-end">
            <div className="min-w-0 sm:min-w-40 sm:flex-1">
              <Label htmlFor="plan-wilaya">Wilaya où je serai</Label>
              {/* Le menu se nourrit du panel : vide, il le DIT au lieu d'un « Toutes les wilayas » sans rien. */}
              <Select id="plan-wilaya" value={wilaya} onChange={(e) => setWilaya(e.target.value)} disabled={praticiens.length === 0}>
                <option value="">{praticiens.length === 0 ? "Aucune wilaya — panel vide" : "Toutes les wilayas"}</option>
                {wilayas.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </div>
            {secteurs.length > 0 && (
              <div className="min-w-0 sm:min-w-40 sm:flex-1">
                <Label htmlFor="plan-secteur">Secteur</Label>
                <Select id="plan-secteur" value={secteur} onChange={(e) => setSecteur(e.target.value)}>
                  <option value="">Tous mes secteurs</option>
                  {secteurs.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
            )}
            <div className="min-w-0 sm:min-w-48 sm:flex-[2]">
              <Label htmlFor="plan-q">Chercher un praticien</Label>
              <Input id="plan-q" type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, spécialité, établissement" />
            </div>
          </div>

          {/* LES PRATICIENS DU CADRE, à cocher pour le jour choisi. */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" aria-hidden /> {visibles.length} praticien(s) dans ce cadre
            </p>
            {praticiens.length === 0 ? (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">Panel vide.</p>
            ) : (
              <div className="divide-y divide-border rounded-xl border border-border">
                {visibles.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">Aucun praticien dans ce cadre.</p>
                )}
                {visibles.map((p) => {
                  const k = cle(jour, p.id);
                  const rapportee = acquises.has(k);
                  const passee = !rapportee && passees.has(k);
                  const fige = rapportee || passee;
                  return (
                    <label
                      key={p.id}
                      className={cn("flex cursor-pointer items-start gap-3 px-3 py-3 text-sm hover:bg-secondary has-[:checked]:bg-primary/5 sm:gap-2 sm:py-2.5", fige && "cursor-not-allowed opacity-70")}
                    >
                      <input
                        type="checkbox" checked={paires.has(k)} disabled={fige || !jour}
                        onChange={() => basculer(jour, p.id)}
                        className="mt-0.5 h-5 w-5 shrink-0 rounded border-input sm:h-4 sm:w-4"
                      />
                      {/* LA LETTRE DE SEGMENTATION d'abord (H, A–D) : elle dit qui voir en priorité et combien de fois. */}
                      {p.lettre && <LettreBadge lettre={p.lettre} className="mt-0.5 shrink-0" />}
                      <span className="min-w-0 flex-1">
                        <span className="font-medium [overflow-wrap:anywhere]">{p.name}</span>
                        {p.requis ? <span className="ml-1.5 text-xs text-muted-foreground">{p.requis} visite{p.requis > 1 ? "s" : ""} / cycle</span> : null}
                        <span className="block text-xs text-muted-foreground">
                          {[p.specialty, p.institution].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </span>
                      <span className="flex max-w-[40%] shrink-0 flex-col items-end gap-0.5 text-right [overflow-wrap:anywhere]">
                        {p.wilaya && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" aria-hidden /> {p.wilaya}
                          </span>
                        )}
                        {p.secteur && <Badge tone="neutral" dot={false}>{p.secteur}</Badge>}
                        {rapportee && (nonTenues.has(k)
                          ? <span className="text-xs text-muted-foreground">dite non tenue</span>
                          : <span className="text-xs text-success">déjà rapportée</span>)}
                        {passee && <span className="text-xs text-muted-foreground">passée — reste au plan</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className={BARRE_FEUILLE}>
            <Button type="button" className="h-12 w-full sm:h-10 sm:w-auto" onClick={() => setChoixOuvert(false)}>
              <Check className="h-4 w-4" /> Terminé — {compteDuJour(jour)} praticien(s) ce jour
            </Button>
          </div>
        </div>
      </Sheet>

      {/* ── NOUVEAU RAPPORT TERRAIN — une visite du plan, ou une rencontre hors plan ─────────────────────── */}
      <Sheet
        open={nouveauRapport}
        onClose={() => setNouveauRapport(false)}
        title="Faire un rapport"
        width="md"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Une visite de mon plan</p>
            {!dejaValide ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                Plan pas encore validé — chez votre N+1
              </p>
            ) : aRapporterMaintenant.length === 0 ? (
              <p className="flex items-center gap-1 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                <span className="min-w-0 flex-1">Aucune visite à rapporter maintenant.</span>
                <InfoBulle label="Quand">Les rapports s&apos;ouvrent le jour de la visite, pour 48 h.</InfoBulle>
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {aRapporterMaintenant.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button" disabled={occupe}
                      onClick={() => { setNouveauRapport(false); setARapporter(l); }}
                      className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm hover:bg-secondary active:bg-secondary focus-ring sm:py-2.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{l.doctorName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {jourLisible(l.cle.slice(0, 10))} · {[l.specialty, l.institution].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" aria-hidden /> {l.heuresRestantes} h
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Une rencontre hors plan</p>
            <Button type="button" variant="outline" className="h-12 w-full sm:h-10 sm:w-auto" disabled={occupe} onClick={() => { setNouveauRapport(false); setImprevue(true); }}>
              <FilePlus2 className="h-4 w-4" /> Visite imprévue
            </Button>
          </div>
        </div>
      </Sheet>

      {/* ── LE RAPPORT, LA NON-TENUE, L'IMPRÉVUE — les feuilles de « Ma journée », jamais une copie ─────────── */}
      {peutRapporter && (
        <>
          <FeuilleRapportVisite ouverte={aRapporter} onClose={() => setARapporter(null)} gamme={gamme} stock={stock} executer={run} occupe={occupe} err={err} />
          <FeuilleNonTenue visite={nonTenue} onClose={() => setNonTenue(null)} executer={run} occupe={occupe} err={err} />
          <FeuilleVisiteImprevue
            open={imprevue} onClose={() => setImprevue(false)}
            panel={praticiens.map((p) => ({ id: p.id, name: p.name }))}
            gamme={gamme} stock={stock} executer={run} occupe={occupe} err={err}
          />
        </>
      )}

      {/* ── LE REJET, AVEC SES COMMENTAIRES ─────────────────────────────────── */}
      <Sheet open={rejet} onClose={() => setRejet(false)} title="Rejeter le plan" width="md"
        description="Le KAM aura 48 h pour resoumettre.">
        <form
          className="space-y-3"
          action={async (fd) => {
            fd.set("planId", planId); fd.set("decision", "REJECT");
            if (await run(deciderPlanTournee, fd)) setRejet(false);
          }}
        >
          <div>
            <Label htmlFor="rejet-comment">Commentaires de rectification</Label>
            <Textarea id="rejet-comment" name="comment" rows={4} required
              placeholder="Trop de libéraux la première semaine, pas assez de CHU ; revoir le mardi 20." />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className={BARRE_FEUILLE}>
            <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" onClick={() => setRejet(false)} disabled={occupe}>Annuler</Button>
            <BoutonDecisif type="submit" variant="destructive" className="h-12 flex-1 sm:h-10" disabled={occupe}>
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Rejeter
            </BoutonDecisif>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
