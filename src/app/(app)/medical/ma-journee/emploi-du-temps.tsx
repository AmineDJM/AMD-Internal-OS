"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Clock, Loader2, Mic, Package, Pencil, Plus, ShieldAlert, Square } from "lucide-react";
import { rapporterVisite, ajouterVisiteImprevue, direVisiteNonTenue } from "@/lib/actions/tour-visit-actions";
import { useAction } from "@/components/shared/use-action";
import { ETAT_VISITE_LABELS, VUES, VUE_LABELS, type EtatVisite, type VueTournee } from "@/lib/sfe/tournee";
import type { AvancementTournee } from "@/lib/sfe/tournee";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import { BlocMaterielRemis, type RemisesInitiales } from "./materiel-remis";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";

export interface LigneVue {
  id: string;
  date: string;
  doctorName: string;
  institution: string | null;
  wilaya: string | null;
  specialty: string | null;
  etat: EtatVisite;
  origine: string;
  objectif: string | null;
  rapport: string | null;
  produits: string[];
  messages: string[];
  produitIds: string[];
  messageIds: string[];
  suite: string | null;
  remises: RemisesInitiales;
  heuresRestantes: number;
  vocal: boolean;
  /** Pourquoi elle n'a pas eu lieu, quand elle est dite reportée ou annulée (§118.193). */
  motifNonTenue: string | null;
  /** Le potentiel à mettre à jour, quand le praticien est dans le panel d'une stratégie de segmentation. */
  potentiel: PotentielVue | null;
  /** Le besoin annuel du service, quand le praticien est décideur d'une stratégie de sa BU (Marketing cockpit · terrain). */
  besoin?: BesoinVue | null;
}

/** Le service du décideur, l'an annoncé et les produits classés, avec ce qui est déjà saisi. */
interface BesoinVue {
  annee: number;
  lieu: string;
  produits: { productId: string; nom: string; actuel: number | null }[];
}

/** Ce que la segmentation sait déjà du praticien — pour ne demander que la mise à jour du fait (§17, §18). */
interface PotentielVue {
  metrique: string;
  productId: string | null;
  produit: string | null;
  dernier: { potentiel: number | null; sur10: number | null; le: string } | null;
}

/** Ce qui pré-remplit le formulaire quand on CORRIGE un rapport fait (§118.166). */
interface RapportInitial {
  texte: string;
  suite: string;
  produitIds: string[];
  messageIds: string[];
  remises: RemisesInitiales;
}

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

/**
 * La barre d'actions des feuilles de saisie : collée au bas de la feuille pendant qu'on défile, pour
 * que « Enregistrer » reste sous le pouce. L'ombre pleine, couleur carte, couvre la marge basse de
 * la feuille sous la barre (sinon le texte défilerait dans l'interstice).
 */
const BARRE_ACTIONS =
  "sticky bottom-0 z-10 -mx-4 flex gap-2 border-t border-border bg-card px-4 py-3 shadow-[0_3rem_0_0_hsl(var(--card))] sm:-mx-5 sm:justify-end sm:px-5";

/**
 * L'EMPLOI DU TEMPS DU KAM — gris tant que le rapport n'est pas fait, vert après.
 *
 * ── TROIS COULEURS, PAS DEUX ────────────────────────────────────────────────────────────────
 *
 * La demande dit gris → vert. Mais la fenêtre de rapport se ferme 48 h après la visite : une
 * visite du 3 sans rapport le 10 n'est plus « en attente », elle est PERDUE. La laisser grise
 * ferait lire un retard rattrapable là où il n'y a plus rien à rattraper — d'où l'ambre, et le
 * compte des heures restantes tant qu'il en reste.
 *
 * ── LE MINIMUM DE CLICS ─────────────────────────────────────────────────────────────────────
 *
 * Un clic sur la ligne ouvre le rapport. Les produits de sa gamme sont là, cochables ; les
 * messages de la Direction Marketing aussi. Le premier produit arrive PRÉ-COCHÉ quand la gamme
 * n'en compte qu'un — décocher est plus rapide que chercher, et c'est ce qui fait rentrer les
 * rapports le soir même.
 *
 * ── LA DICTÉE ───────────────────────────────────────────────────────────────────────────────
 *
 * La reconnaissance vocale du navigateur remplit le champ ; si elle n'existe pas, le bouton le
 * DIT et le clavier reste. Annoncer une dictée qui ne marche pas est pire que ne pas l'offrir.
 */
export function EmploiDuTemps({
  vue, lignes, avancement, produits, produitsIncomplets, messages, sansBu, panel, stock, lienPv = null,
}: {
  /** Le formulaire de signalement de pharmacovigilance — passé seulement à qui peut signaler. */
  lienPv?: string | null;
  vue: VueTournee;
  lignes: LigneVue[];
  avancement: AvancementTournee;
  produits: { productId: string; name: string }[];
  produitsIncomplets: string[];
  messages: { id: string; title: string; body: string | null; buName: string | null }[];
  sansBu: boolean;
  /** Le panel, pour la visite imprévue. */
  panel: { id: string; name: string }[];
  /** Le matériel en main du délégué, pour le bloc « Matériel remis » (§118.166). */
  stock: StockPourVisite;
}) {
  const router = useRouter();
  const params = useSearchParams();
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : une fiche rouverte avant la fin montrerait la visite d'avant.
  // `busy` de `useAction` court jusqu'à l'arrivée des nouvelles données (§118.172).
  const { busy: occupe, err, setErr, run: lancer } = useAction();
  const [ouverte, setOuverte] = React.useState<LigneVue | null>(null);
  /** La visite qu'on dit NON TENUE (reportée, annulée) — §118.193. */
  const [nonTenue, setNonTenue] = React.useState<LigneVue | null>(null);
  const [imprevue, setImprevue] = React.useState(false);
  const gamme: GammeVue = { produits, produitsIncomplets, messages, sansBu };

  const changerVue = (v: VueTournee) => {
    const q = new URLSearchParams(params?.toString() ?? "");
    q.set("vue", v);
    router.push(`/medical/ma-journee?${q.toString()}`);
  };

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => lancer(() => action(fd));

  const tonDe = (e: EtatVisite): "neutral" | "success" | "warning" | "info" =>
    e === "FAITE" ? "success" : e === "PERDUE" ? "warning" : e === "ANNULEE" || e === "REPORTEE" ? "info" : "neutral";

  const jourDe = (iso: string) =>
    new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });

  return (
    <div className="space-y-3">
      {/* ── LE RAPPORT TERRAIN LIBRE, EN TÊTE (Direction, 10/2026) : le geste principal de « Ma journée » — la même
          feuille que « Faire un rapport » du plan de tournée (visite hors plan, `ajouterVisiteImprevue`). ── */}
      <Button
        className="h-12 w-full text-sm sm:h-9 sm:w-auto"
        onClick={() => { setErr(null); setImprevue(true); }}
        disabled={occupe}
      >
        <Plus className="h-4 w-4" /> Faire un rapport terrain
      </Button>

      {/* ── LES QUATRE VUES ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5">
        {/* Au téléphone, les vues forment une rangée qui glisse, à hauteur de pouce. */}
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {VUES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => changerVue(v)}
              aria-current={v === vue ? "page" : undefined}
              className={cn(
                "h-10 shrink-0 whitespace-nowrap rounded-lg px-3 text-sm sm:h-auto sm:px-2.5 sm:py-1.5",
                v === vue ? "bg-primary text-primary-foreground" : "border border-input hover:bg-secondary",
              )}
            >
              {VUE_LABELS[v]}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {/* LE DÉNOMINATEUR DE LA DIRECTION, sur le MOIS — « Aujourd'hui » ne dit rien d'un
              objectif mensuel, et afficher le taux du jour ferait lire 0 % chaque matin. */}
          Ce mois : <strong className="text-foreground tabular-nums">{avancement.visitees}/{avancement.planifiees}</strong> visitées
          {avancement.imprevues > 0 && <> · {avancement.imprevues} imprévue(s)</>}
          {avancement.perdues > 0 && <> · <span className="text-warning">{avancement.perdues} hors délai</span></>}
        </span>
      </div>

      {err && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {/* ── L'EMPLOI DU TEMPS EN TABLEAU ───────────── */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Jour</th>
              <th className="px-3 py-2 font-medium">Praticien</th>
              <th className="px-3 py-2 font-medium">État</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {lignes.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  Aucune visite sur « {VUE_LABELS[vue]} ».
                </td>
              </tr>
            )}
            {lignes.map((l) => (
              <tr
                key={l.id}
                className={cn(
                  "border-t border-border",
                  // GRIS / VERT / AMBRE : la couleur EST l'information, la pastille la nomme.
                  l.etat === "FAITE" && "bg-success/5",
                  l.etat === "PERDUE" && "bg-warning/5",
                )}
              >
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{jourDe(l.date)}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{l.doctorName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[l.specialty, l.institution, l.wilaya].filter(Boolean).join(" · ") || "—"}
                  </span>
                  {l.origine === "DIRECTION" && (
                    <Badge tone="info" dot={false}>Demandée par la Direction{l.objectif ? ` — ${l.objectif}` : ""}</Badge>
                  )}
                  {l.origine === "UNPLANNED" && <Badge tone="neutral" dot={false}>Imprévue</Badge>}
                  {l.etat === "FAITE" && l.produits.length > 0 && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{l.produits.join(" · ")}</span>
                  )}
                  {/* CE QUI A ÉTÉ REMIS SE VOIT sur la ligne : le délégué relit sa journée sans
                      rouvrir chaque rapport, et une erreur de quantité se repère avant la fin des 48 h. */}
                  {(l.remises.materiel.length > 0 || l.remises.numeriques.length > 0) && (
                    <span className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                      <Package className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      <span>
                        {[
                          ...l.remises.materiel.map((m) => `${nombre(m.quantite)} ${m.libelle}`),
                          ...l.remises.numeriques.map((n) => `${n.libelle} (présenté)`),
                        ].join(" · ")}
                      </span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={tonDe(l.etat)}>{ETAT_VISITE_LABELS[l.etat]}</Badge>
                  {/* LES HEURES RESTANTES : c'est ce qui fait rentrer un rapport le soir même.
                      Un « à faire » sans délai se remet à demain, puis se perd. */}
                  {l.etat === "A_FAIRE" && (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" aria-hidden /> {l.heuresRestantes} h restantes
                    </span>
                  )}
                  {l.vocal && <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Mic className="h-3 w-3" aria-hidden /> vocal</span>}
                  {l.motifNonTenue && (l.etat === "ANNULEE" || l.etat === "REPORTEE") && (
                    <span className="mt-0.5 block max-w-56 text-xs text-muted-foreground">« {l.motifNonTenue} »</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {l.etat === "A_FAIRE" ? (
                    // UN SEUL GESTE PAR LIGNE (Direction, 07/10) : « Rapport ». Dire qu'elle n'a pas eu lieu
                    // (§118.193) se fait depuis la feuille du rapport — un lien discret en tête.
                    <Button size="sm" className="h-10 sm:h-8" onClick={() => { setErr(null); setOuverte(l); }} disabled={occupe}>
                      Rapport
                    </Button>
                  ) : l.etat === "PERDUE" ? (
                    <span className="text-xs text-warning">Délai dépassé</span>
                  ) : l.etat === "FAITE" && l.heuresRestantes > 0 ? (
                    // CORRIGER DANS LA FENÊTRE : une quantité remise mal tapée se rattrape ici, et le
                    // stock suit — seuls les articles dont la quantité change sont repris (§118.166).
                    <Button size="sm" variant="ghost" className="h-10 sm:h-8" onClick={() => { setErr(null); setOuverte(l); }} disabled={occupe}>
                      <Pencil className="h-3.5 w-3.5" /> Corriger
                    </Button>
                  ) : l.etat === "FAITE" ? (
                    <Check className="ml-auto h-4 w-4 text-success" aria-label="Rapport fait" />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* La visite imprévue : un lien discret sous le tableau, pas un second gros bouton (Direction, 07/10). La
          pharmacovigilance à côté, du même poids. */}
      {lienPv && (
        <div className="flex flex-wrap items-center gap-x-4">
          <Link href={lienPv} className="inline-flex min-h-10 items-center gap-1.5 text-sm text-warning hover:underline">
            <ShieldAlert className="h-4 w-4" /> Pharmacovigilance
          </Link>
        </div>
      )}

      {/* ── LE RAPPORT TERRAIN ──────────────────────────────────────────────── */}
      <FeuilleRapportVisite ouverte={ouverte} onClose={() => setOuverte(null)} gamme={gamme} stock={stock} executer={run} occupe={occupe} err={err}
        onNonTenue={(l) => { setErr(null); setOuverte(null); setNonTenue(l); }}
      />

      {/* ── LA VISITE QUI N'A PAS EU LIEU (§118.193) ───────────────────────────── */}
      <FeuilleNonTenue visite={nonTenue} onClose={() => setNonTenue(null)} executer={run} occupe={occupe} err={err} />

      {/* ── LA VISITE IMPRÉVUE ──────────────────────────────────────────────── */}
      <FeuilleVisiteImprevue open={imprevue} onClose={() => setImprevue(false)} panel={panel} gamme={gamme} stock={stock} executer={run} occupe={occupe} err={err} />
    </div>
  );
}

/** La gamme du KAM qui rapporte : ses produits, ses messages — ce que le formulaire de rapport propose. */
export interface GammeVue {
  produits: { productId: string; name: string }[];
  produitsIncomplets: string[];
  messages: { id: string; title: string; body: string | null; buName: string | null }[];
  sansBu: boolean;
}

/** Le geste suivi de l'écran hôte : appelle l'action, montre l'erreur, rafraîchit (`useRafraichir`). Vrai si réussi. */
export type Executer = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => Promise<boolean>;

/**
 * LE RAPPORT D'UNE VISITE PLANIFIÉE — UNE feuille, ouverte depuis « Ma journée » ET depuis la grille du plan de
 * tournée (Direction, 06/10). Deux écrans, une porte : la même action (`rapporterVisite`), le même formulaire, les
 * mêmes exigences. En écrire une seconde pour la grille ferait diverger les deux saisies au premier champ ajouté.
 */
export function FeuilleRapportVisite({
  ouverte, onClose, gamme, stock, executer, occupe, err, onNonTenue,
}: {
  ouverte: LigneVue | null;
  onClose: () => void;
  gamme: GammeVue;
  stock: StockPourVisite;
  executer: Executer;
  occupe: boolean;
  err: string | null;
  /**
   * « Elle n'a pas eu lieu » (§118.193), offert en lien discret en tête de la feuille quand l'écran hôte le passe :
   * la ligne de « Ma journée » ne porte plus qu'un geste, « Rapport » (Direction, 07/10).
   */
  onNonTenue?: (l: LigneVue) => void;
}) {
  /** La visite ouverte l'est-elle pour une CORRECTION (rapport déjà fait, fenêtre encore ouverte) ? */
  const correction = ouverte?.etat === "FAITE";
  return (
    <Sheet
      open={ouverte !== null}
      onClose={onClose}
      title={ouverte ? `${correction ? "Corriger le rapport" : "Rapport"} — ${ouverte.doctorName}` : ""}
      description={ouverte
        ? `Visite du ${new Date(ouverte.date).toLocaleDateString("fr-FR")} · ${ouverte.heuresRestantes} h restantes`
        : ""}
      width="md"
    >
      {ouverte && onNonTenue && ouverte.etat === "A_FAIRE" && (
        <button
          type="button"
          onClick={() => onNonTenue(ouverte)}
          disabled={occupe}
          className="-mt-1 mb-2 inline-flex min-h-10 items-center text-sm text-primary hover:underline disabled:opacity-50 sm:min-h-8"
        >
          La visite n&apos;a pas eu lieu ?
        </button>
      )}
      {ouverte && (
        <FormulaireRapport
          key={ouverte.id}
          action={async (fd) => {
            fd.set("visitId", ouverte.id);
            if (await executer(rapporterVisite, fd)) onClose();
          }}
          produits={gamme.produits}
          produitsIncomplets={gamme.produitsIncomplets}
          messages={gamme.messages}
          sansBu={gamme.sansBu}
          // UNE CORRECTION N'EXIGE PAS PLUS QUE LA CRÉATION : la règle est au serveur, l'écran la
          // reflète — une imprévue, ou une visite rapportée sans message, se corrige sans message.
          messageObligatoire={ouverte.origine !== "UNPLANNED" && !(correction && ouverte.messageIds.length === 0)}
          produitObligatoire={ouverte.origine !== "UNPLANNED" && !(correction && ouverte.produitIds.length === 0)}
          stock={stock}
          initial={correction ? {
            texte: ouverte.rapport ?? "", suite: ouverte.suite ?? "",
            produitIds: ouverte.produitIds, messageIds: ouverte.messageIds, remises: ouverte.remises,
          } : undefined}
          libelleEnvoi={correction ? "Enregistrer la correction" : "Enregistrer le rapport"}
          potentiel={ouverte.potentiel}
          besoin={ouverte.besoin ?? null}
          busy={occupe}
          err={err}
          onCancel={onClose}
        />
      )}
    </Sheet>
  );
}

/** LA VISITE QUI N'A PAS EU LIEU (§118.193) — la même feuille pour « Ma journée » et la grille du plan. */
export function FeuilleNonTenue({
  visite, onClose, executer, occupe, err,
}: {
  visite: LigneVue | null;
  onClose: () => void;
  executer: Executer;
  occupe: boolean;
  err: string | null;
}) {
  const [motif, setMotif] = React.useState("");
  // Une feuille rouverte sur une autre visite repart d'un motif vide.
  React.useEffect(() => { setMotif(""); }, [visite?.id]);
  return (
    <Sheet
      open={visite !== null}
      onClose={onClose}
      title={visite ? `La visite n'a pas eu lieu — ${visite.doctorName}` : ""}
      description={visite ? `Visite du ${new Date(visite.date).toLocaleDateString("fr-FR")}` : ""}
      width="md"
    >
      {visite && (
        <form
          className="space-y-3"
          action={async (fd) => {
            fd.set("visitId", visite.id);
            if (await executer(direVisiteNonTenue, fd)) onClose();
          }}
        >
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 flex items-center gap-1 text-sm font-medium">
              Ce qui s&apos;est passé
              <InfoBulle label="Pourquoi le dire" align="left">
                Reportée ou annulée, la visite sort du dénominateur de votre plan — à condition de le dire, motif à l&apos;appui.
              </InfoBulle>
            </legend>
            {/* Deux grandes cases côte à côte : un choix d'un seul pouce. */}
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-col sm:gap-1.5">
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-0 sm:border-0 sm:px-0 sm:has-[:checked]:bg-transparent">
                <input type="radio" name="issue" value="POSTPONED" defaultChecked className="h-5 w-5 sm:h-4 sm:w-4" /> Reportée
              </label>
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-0 sm:border-0 sm:px-0 sm:has-[:checked]:bg-transparent">
                <input type="radio" name="issue" value="CANCELLED" className="h-5 w-5 sm:h-4 sm:w-4" /> Annulée
              </label>
            </div>
          </fieldset>
          <div>
            <Label htmlFor="non-tenue-motif">Pourquoi</Label>
            <Textarea id="non-tenue-motif" name="motif" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)}
              placeholder="Le Dr Amrani était en congé ; je le revois mardi prochain." />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className={BARRE_ACTIONS}>
            <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" onClick={onClose} disabled={occupe}>Annuler</Button>
            <BoutonDecisif type="submit" className="h-12 flex-1 sm:h-10" disabled={occupe || motif.trim().length === 0} confirmation="dire que la visite n’a pas eu lieu">
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
            </BoutonDecisif>
          </div>
        </form>
      )}
    </Sheet>
  );
}

/**
 * LA VISITE IMPRÉVUE — la rencontre que le plan ne prévoyait pas. La même feuille pour « Ma journée » et pour le
 * bouton « Faire un rapport » de la grille du plan : elle crée la `MedicalVisit` hors plan (`ajouterVisiteImprevue`),
 * comptée au nombre de visites, jamais au dénominateur du plan.
 */
export function FeuilleVisiteImprevue({
  open, onClose, panel, gamme, stock, executer, occupe, err,
}: {
  open: boolean;
  onClose: () => void;
  panel: { id: string; name: string }[];
  gamme: GammeVue;
  stock: StockPourVisite;
  executer: Executer;
  occupe: boolean;
  err: string | null;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Visite imprévue"
      description="Rencontre hors plan"
      width="md"
    >
      <FormulaireRapport
        action={async (fd) => { if (await executer(ajouterVisiteImprevue, fd)) onClose(); }}
        produits={gamme.produits}
        produitsIncomplets={gamme.produitsIncomplets}
        messages={gamme.messages}
        sansBu={gamme.sansBu}
        // LE MESSAGE EST FACULTATIF ICI — la demande le dit, et une rencontre de couloir n'a
        // pas d'ordre de mission.
        messageObligatoire={false}
        produitObligatoire={false}
        stock={stock}
        busy={occupe}
        err={err}
        onCancel={onClose}
        entete={
          <>
            <div>
              <Label htmlFor="imp-doctor">Praticien rencontré</Label>
              <Select id="imp-doctor" name="doctorId" required defaultValue="">
                <option value="" disabled>— Choisir dans votre panel —</option>
                {panel.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>
            <div>
              <div className="flex items-center gap-1">
                <Label htmlFor="imp-date">Jour de la rencontre</Label>
                <InfoBulle label="Quelle date" align="left">
                  Jamais dans le futur, et dans les 48 h : la même borne que pour une visite planifiée. Elle compte au nombre
                  de visites, jamais au dénominateur du plan.
                </InfoBulle>
              </div>
              <Input id="imp-date" name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
          </>
        }
      />
    </Sheet>
  );
}

/**
 * LE FORMULAIRE DE RAPPORT — le même pour une visite planifiée et pour un imprévu.
 *
 * L'écrire deux fois ferait diverger les deux saisies au premier champ ajouté, et le KAM
 * apprendrait deux gestes pour une seule chose (§118.5).
 */
function FormulaireRapport({
  action, produits, produitsIncomplets, messages, sansBu, messageObligatoire, produitObligatoire, stock, initial,
  libelleEnvoi = "Enregistrer le rapport", busy, err, onCancel, entete, potentiel, besoin,
}: {
  action: (fd: FormData) => void | Promise<void>;
  /** Le potentiel que la segmentation attend de ce praticien — facultatif, la dernière valeur affichée. */
  potentiel?: PotentielVue | null;
  /** Le besoin annuel du service — facultatif, proposé quand le praticien est décideur. */
  besoin?: BesoinVue | null;
  produits: { productId: string; name: string }[];
  produitsIncomplets: string[];
  messages: { id: string; title: string; body: string | null; buName: string | null }[];
  sansBu: boolean;
  messageObligatoire: boolean;
  produitObligatoire: boolean;
  stock: StockPourVisite;
  /** Le rapport tel qu'il a été fait — pour une correction dans la fenêtre des 48 h. */
  initial?: RapportInitial | undefined;
  libelleEnvoi?: string;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  entete?: React.ReactNode;
}) {
  const [texte, setTexte] = React.useState(initial?.texte ?? "");
  // LES PRODUITS COCHÉS sont un état : le bloc « Matériel remis » met en tête les articles de ces
  // produits. UN SEUL PRODUIT DANS LA GAMME arrive coché (hors correction) — décocher est plus
  // rapide que chercher, et c'est ce qui fait tenir « le minimum de clics ».
  const [coches, setCoches] = React.useState<Set<string>>(() => new Set(
    initial ? initial.produitIds : produits.length === 1 && produits[0] ? [produits[0].productId] : [],
  ));
  const basculer = (id: string) => setCoches((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [dictee, setDictee] = React.useState<"absente" | "prete" | "en-cours">("absente");
  const recRef = React.useRef<{ start: () => void; stop: () => void } | null>(null);

  React.useEffect(() => {
    // LA DICTÉE N'EST PAS PROMISE AVANT D'ÊTRE LÀ : annoncer un micro qui ne marche pas est pire
    // que ne pas l'offrir — la personne appuie, rien ne se passe, et elle cesse de faire
    // confiance à l'écran.
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor() as {
      lang: string; continuous: boolean; interimResults: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void; start: () => void; stop: () => void;
    };
    rec.lang = "fr-FR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let ajout = "";
      for (let i = 0; i < e.results.length; i += 1) ajout += `${e.results[i]![0]!.transcript} `;
      setTexte(ajout.trim());
    };
    rec.onend = () => setDictee("prete");
    recRef.current = rec;
    setDictee("prete");
  }, []);

  const basculerDictee = () => {
    if (!recRef.current) return;
    if (dictee === "en-cours") { recRef.current.stop(); setDictee("prete"); }
    else { recRef.current.start(); setDictee("en-cours"); }
  };

  return (
    <form className="space-y-3" action={action}>
      {entete}

      {/* ── LES PRODUITS DE SA GAMME ─────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Produits discutés {produitObligatoire && <span className="text-destructive">*</span>}</span>
          {/* Ce qui manque à la gamme, dit derrière le ⓘ plutôt qu'en paragraphe (Direction, 07/10). */}
          {!sansBu && produitsIncomplets.length > 0 && (
            <InfoBulle label="Produits absents" align="left" className="normal-case tracking-normal">
              {produitsIncomplets.length} produit(s) promu(s) ({produitsIncomplets.slice(0, 3).join(", ")}) ne sont rattachés
              à aucun dossier réglementaire et ne peuvent donc pas figurer dans un rapport — à rapprocher dans Produits 360
              (⋯ › « Rapprocher un produit BD / BU »).
            </InfoBulle>
          )}
        </p>
        {sansBu ? (
          <p className="flex items-center gap-1 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1">Aucune gamme rattachée — chez votre superviseur</span>
            <InfoBulle label="Pourquoi">
              Sans Business Unit, la liste de vos produits est vide et le rapport sera refusé. Votre superviseur vous
              rattache à une gamme depuis Business Units.
            </InfoBulle>
          </p>
        ) : produits.length === 0 ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">Aucun produit actif dans votre gamme.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {produits.map((p) => (
              <label key={p.productId} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm [overflow-wrap:anywhere] has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-0 sm:gap-1.5 sm:px-2 sm:py-1">
                <input
                  type="checkbox" name="productId" value={p.productId}
                  checked={coches.has(p.productId)} onChange={() => basculer(p.productId)}
                  className="h-5 w-5 shrink-0 rounded border-input sm:h-4 sm:w-4"
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── LES MESSAGES DE LA DIRECTION MARKETING ───────────────────────────── */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Messages portés {messageObligatoire && <span className="text-destructive">*</span>}</span>
          {messageObligatoire && (
            <InfoBulle label="Pourquoi obligatoires" align="left" className="normal-case tracking-normal">
              Produits et messages sont exigés : sans eux, ni l&apos;effort par produit ni l&apos;efficacité d&apos;un message
              ne se mesurent — c&apos;est ce que la Direction demande de savoir.
            </InfoBulle>
          )}
        </p>
        {messages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-foreground">
            {messageObligatoire
              ? "Aucun message publié pour votre gamme — chez la Direction Marketing (rapport refusé sans message)"
              : "Aucun message publié pour votre gamme."}
          </p>
        ) : (
          // Au téléphone, la liste ne s'enferme pas dans une petite boîte défilante : défiler dans un
          // défilement, au pouce, fait manquer des messages. Elle s'y range à partir de la tablette.
          <div className="space-y-1 rounded-lg border border-border p-1.5 sm:max-h-40 sm:overflow-y-auto sm:p-2">
            {messages.map((m) => (
              <label key={m.id} className="flex items-start gap-2.5 rounded-md px-2 py-2.5 text-sm hover:bg-secondary has-[:checked]:bg-primary/5 sm:gap-2 sm:px-1 sm:py-1">
                <input type="checkbox" name="messageId" value={m.id} defaultChecked={initial?.messageIds.includes(m.id) ?? false} className="mt-0.5 h-5 w-5 shrink-0 rounded border-input sm:h-4 sm:w-4" />
                <span className="min-w-0">
                  <span className="font-medium">{m.title}</span>
                  {m.body && <span className="block text-xs text-muted-foreground">{m.body}</span>}
                  {m.buName && <span className="block text-xs text-muted-foreground">Gamme {m.buName}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── VOCAL OU ÉCRIT ───────────────────────────────────────────────────── */}
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <Label htmlFor="rapport-texte">Compte rendu <span className="text-destructive">*</span></Label>
          {/* Sans dictée sur ce navigateur, pas de bouton — et pas de phrase pour le dire. */}
          {dictee !== "absente" && (
            <Button type="button" size="sm" className="h-10 px-4 sm:h-8 sm:px-3" variant={dictee === "en-cours" ? "destructive" : "outline"} onClick={basculerDictee}>
              {dictee === "en-cours" ? <><Square className="h-3.5 w-3.5" /> Arrêter</> : <><Mic className="h-3.5 w-3.5" /> Dicter</>}
            </Button>
          )}
        </div>
        <Textarea
          id="rapport-texte" name="report" rows={4} required
          value={texte} onChange={(e) => setTexte(e.target.value)}
          placeholder="Ce que le médecin a dit, ses objections, ce qu'il attend."
        />
        {/* LA TRANSCRIPTION VOYAGE À PART quand elle vient du micro : elle crée un rapport
            vocal (`FieldReport`) rattaché à la visite, avec sa propre relecture. */}
        {dictee !== "absente" && <input type="hidden" name="transcript" value={dictee === "prete" && texte ? texte : ""} />}
      </div>

      {/* ── LE MATÉRIEL REMIS (§118.166) ─────────────────────────────────────── */}
      <BlocMaterielRemis stock={stock} produitsCoches={coches} initial={initial?.remises} />

      {/* ── LE POTENTIEL (Segmentation Studio) — facultatif : le fait, AMD calcule la conséquence ─── */}
      {potentiel && (
        <div className="space-y-1.5 rounded-lg border border-border p-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Potentiel (facultatif)</p>
          <p className="text-xs text-muted-foreground">
            {potentiel.dernier
              ? `Dernière valeur : ${potentiel.dernier.potentiel ?? "—"} ${potentiel.metrique}${potentiel.dernier.sur10 !== null ? `, ${potentiel.dernier.sur10}/10 sous ${potentiel.produit ?? "le produit"}` : ""} — ${new Date(potentiel.dernier.le).toLocaleDateString("fr-FR")}.`
              : "Jamais renseigné."}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <div className="min-w-0"><Label htmlFor="pot-patients" className="text-xs">{potentiel.metrique}</Label><Input id="pot-patients" name="potentielPatients" inputMode="decimal" className="w-full sm:w-28" /></div>
            {potentiel.productId && <div className="min-w-0"><Label htmlFor="pot-sur10" className="text-xs">Sur 10, sous {potentiel.produit}</Label><Input id="pot-sur10" name="potentielSur10" inputMode="decimal" className="w-full sm:w-28" /></div>}
          </div>
          {potentiel.productId && <input type="hidden" name="potentielProduitId" value={potentiel.productId} />}
        </div>
      )}

      {/* ── LE BESOIN ANNUEL DU SERVICE (décideur) — facultatif : ce qu'il annonce fixe le volume de l'AO ─── */}
      {besoin && besoin.produits.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border p-2.5">
          <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Besoin annuel du service {besoin.annee} (facultatif)</span>
            <InfoBulle label="Besoin annuel du service" align="left" className="normal-case tracking-normal">
              Le décideur fixe les prévisions de son service ({besoin.lieu}), qui fixent le volume de l&apos;appel d&apos;offres.
              Notez les boîtes qu&apos;il annonce pour {besoin.annee} ; une case vide ne change rien.
            </InfoBulle>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {besoin.produits.map((p) => (
              <div key={p.productId} className="min-w-0">
                <input type="hidden" name="besoinProduitId" value={p.productId} />
                <Label htmlFor={`besoin-${p.productId}`} className="text-xs">{p.nom} (boîtes)</Label>
                <Input id={`besoin-${p.productId}`} name="besoinQuantite" inputMode="numeric" className="w-full sm:w-32"
                  placeholder={p.actuel !== null ? p.actuel.toLocaleString("fr-FR") : ""} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="rapport-suite">Ce qu&apos;il reste à faire</Label>
        <Input id="rapport-suite" name="followUpActions" defaultValue={initial?.suite ?? ""} placeholder="Rappeler après le comité du 12, envoyer l'étude…" />
      </div>

      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <div className={BARRE_ACTIONS}>
        <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" onClick={onCancel} disabled={busy}>Annuler</Button>
        <Button type="submit" className="h-12 min-w-0 flex-[2] sm:h-10 sm:flex-none" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} <span className="truncate">{libelleEnvoi}</span>
        </Button>
      </div>
    </form>
  );
}
