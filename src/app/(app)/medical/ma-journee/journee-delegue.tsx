"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, CloudOff, RefreshCw, Search, WifiOff } from "lucide-react";
import { useAction, REFUS_SANS_MOTIF } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { InfoBulle } from "@/components/ui/info-bulle";
import { tonDuDelai } from "@/lib/sfe/compte-rendu-envoye";
import { cibleDuPraticien, prochaineVisite, type CarteVisite, type CibleVisite } from "@/lib/sfe/journee-visite";
import { apresEnvoi, champsDuFormulaire, nouveauBrouillon, phraseAttente } from "@/lib/sfe/brouillons-visite";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { useBrouillonsVisite } from "./brouillons-locaux";
import { envoyerAvecDelai } from "./envoi-visite";
import { FeuilleVisite } from "./feuille-visite";
import { FeuilleNonTenue } from "./emploi-du-temps";
import { CarteVisiteDuJour } from "./carte-visite";
import { CompteRenduEnvoye } from "./compte-rendu-envoye";
import { indexerContextes, type FrequenceVue } from "./contexte-visite";
import type { DerniereVisiteVue, Executer, GammeVue, LigneVue, OuvertureVisite, PraticienVisite } from "./types-visite";

/** Une suggestion « à rattraper » — la tournée proposée par la fréquence (`buildTournee`). */
export interface RattrapageVue extends PraticienVisite {
  doctorId: string;
  reason: string;
  missing: number;
}

const nouvelId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** « lun. 23 nov. à 11:00 » — le jour d'une visite en retard, et son heure quand le plan en a posé une. */
const jourEtHeure = (iso: string) => {
  const d = new Date(iso);
  const jour = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  return d.getHours() === 0 && d.getMinutes() === 0 ? jour : `${jour} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
};

const plier = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — la liste du délégué, au téléphone comme à l'ordinateur (11/2026).
 *
 * UNE liste : les visites du jour (précédées de celles d'hier encore rapportables), puis « À rattraper ». Chaque
 * carte dit la lettre, le nom, spécialité · établissement, l'état et le délai. UN bouton plein, « Commencer la
 * visite », sur la prochaine visite à faire — collé en bas de l'écran au téléphone ; « Commencer » sur les autres ;
 * « Corriger » discret tant que la fenêtre de 48 h est ouverte. « Voir un médecin hors plan » cherche dans tout le
 * panel : un médecin prévu aujourd'hui ouvre le rapport de SA visite, tout autre est une visite hors plan.
 *
 * SANS RÉSEAU, le rapport est gardé dans le téléphone et part au retour (`brouillons-locaux.ts`) ; l'indicateur le
 * dit en haut de la liste. Le serveur reste le juge : un rapport arrivé après ses 48 h est refusé, et l'écran le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function JourneeDelegue({
  personneId, aujourdhui, fermes, aRattraper, panel, gamme, stock, precoches, frequences, dernieres, peutSignalerPv, ouvrirHorsPlan = false,
}: {
  personneId: string;
  /** La liste du jour, déjà rangée par le serveur (`fusionnerJournee`) : les visites des jours passés encore rapportables en tête. */
  aujourdhui: CarteVisite<LigneVue>[];
  /** Les visites récentes dont la fenêtre de 48 h s'est fermée sans compte rendu (`comptesRendusEnRetard`). */
  fermes: LigneVue[];
  /** Arrivée par « + Visite hors plan » de l'en-tête (`?horsPlan=1`) : le choix du médecin s'ouvre. */
  ouvrirHorsPlan?: boolean;
  aRattraper: RattrapageVue[];
  /** Le panel entier — « + Visite hors plan ». */
  panel: PraticienVisite[];
  gamme: GammeVue;
  stock: StockPourVisite;
  precoches: string[];
  frequences: FrequenceVue[];
  dernieres: DerniereVisiteVue[];
  peutSignalerPv: boolean;
}) {
  const { rafraichir } = useRafraichir();
  // « LA VISITE N'A PAS EU LIEU » passe par le geste suivi ordinaire (§118.172).
  const { busy: occupeNonTenue, err: errNonTenue, setErr: setErrNonTenue, run: lancer } = useAction();
  const executer: Executer = (action, fd) => lancer(() => action(fd));
  const file = useBrouillonsVisite(personneId, rafraichir);

  const [ouverte, setOuverte] = React.useState<OuvertureVisite | null>(null);
  const [nonTenue, setNonTenue] = React.useState<LigneVue | null>(null);
  const [choixOuvert, setChoixOuvert] = React.useState(ouvrirHorsPlan);
  /** Le compte rendu envoyé qu'on relit (« Voir ») — par son identifiant : la feuille suit la ligne rafraîchie. */
  const [vueId, setVueId] = React.useState<string | null>(null);
  const vue = vueId ? aujourdhui.find((l) => l.id === vueId) ?? null : null;
  // L'ADRESSE NE REDEMANDE PAS : « ?horsPlan=1 » a ouvert le choix une fois, un rafraîchissement ne le rouvre pas.
  React.useEffect(() => {
    if (ouvrirHorsPlan && typeof window !== "undefined") window.history.replaceState(null, "", window.location.pathname);
  }, [ouvrirHorsPlan]);
  const [occupe, setOccupe] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  /** Ce qui vient de se passer, dit en une ligne au-dessus de la liste — et la visite suivante. */
  const [annonce, setAnnonce] = React.useState<{ texte: string; suivante: CibleVisite | null } | null>(null);

  const { lettreDe, contexteDe } = React.useMemo(() => indexerContextes(frequences, dernieres), [frequences, dernieres]);

  const journee = { aujourdhui, aRattraper };
  const prochaine = prochaineVisite(journee);
  const praticienDe = (doctorId: string): PraticienVisite | null =>
    aRattraper.find((r) => r.doctorId === doctorId) ?? panel.find((p) => p.id === doctorId) ?? null;

  const ouvrirCible = (c: CibleVisite) => {
    setErr(null); setAnnonce(null);
    if (c.sorte === "PLANIFIEE") {
      const l = aujourdhui.find((x) => x.id === c.visitId);
      if (l) setOuverte({ sorte: "PLANIFIEE", ligne: l });
      return;
    }
    const p = praticienDe(c.doctorId);
    if (p) setOuverte({ sorte: "HORS_PLAN", praticien: p });
  };
  const nomDe = (c: CibleVisite | null): string | null => {
    if (!c) return null;
    return c.sorte === "PLANIFIEE" ? aujourdhui.find((x) => x.id === c.visitId)?.doctorName ?? null : praticienDe(c.doctorId)?.name ?? null;
  };

  // ── ENREGISTRER : en ligne, l'action ; sans réseau, la file du téléphone ─────────────────────────────
  const enregistrer = async (fd: FormData, o: OuvertureVisite): Promise<boolean> => {
    const sorte = o.sorte === "PLANIFIEE" ? "RAPPORT" as const : "HORS_PLAN" as const;
    const visitId = o.sorte === "PLANIFIEE" ? o.ligne.id : null;
    const doctorId = o.sorte === "PLANIFIEE" ? o.ligne.doctorId ?? null : o.praticien.id;
    const nom = o.sorte === "PLANIFIEE" ? o.ligne.doctorName : o.praticien.name;
    const suivante = prochaineVisite(journee, { visitId, doctorId });
    const brouillon = nouveauBrouillon({
      id: nouvelId(), sorte, visitId, doctorId, praticien: nom, champs: champsDuFormulaire(fd.entries()), maintenant: Date.now(),
    });
    setErr(null);
    if (!file.enLigne || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      file.garder(brouillon);
      setAnnonce({ texte: `Pas de réseau : le rapport de ${nom} est gardé dans ce téléphone et partira tout seul.`, suivante });
      return true;
    }
    setOccupe(true);
    try {
      const r = await envoyerAvecDelai(sorte, fd);
      if (!r.ok) { setErr(r.error ?? REFUS_SANS_MOTIF); return false; }
      rafraichir();
      setAnnonce({ texte: "Enregistré.", suivante });
      return true;
    } catch {
      // LE RÉSEAU A COUPÉ PENDANT L'ENVOI : un rapport se rejoue sans risque ; une visite hors plan a pu être créée —
      // elle attend que la personne vérifie (`apresEnvoi`).
      const suite = apresEnvoi(brouillon, { kind: "RESEAU" }, true);
      if (suite) file.garder(suite);
      setAnnonce({
        texte: suite?.etat === "A_VERIFIER"
          ? `L'envoi de la visite chez ${nom} s'est interrompu : vérifiez « Mes dernières visites » avant de la renvoyer.`
          : `Le réseau a coupé : le rapport de ${nom} est gardé dans ce téléphone et partira tout seul.`,
        suivante,
      });
      return true;
    } finally {
      setOccupe(false);
    }
  };

  const attente = phraseAttente(file.liste);
  const aRegarder = file.liste.filter((b) => b.etat !== "EN_ATTENTE");
  const nomProchaine = nomDe(prochaine);

  const auJour = aujourdhui.filter((l) => !l.jourPasse);
  const enRetard = aujourdhui.filter((l) => l.jourPasse);
  const dernierPassageDe = (l: LigneVue): string | null =>
    dernieres.find((d) => d.doctorId === l.doctorId && d.visitId !== l.id)?.date ?? null;

  return (
    <div className="space-y-4 pb-24 lg:pb-0">
      {/* ── L'ÉTAT DU RÉSEAU ET DE LA FILE — toujours dit, jamais deviné ────────────────────── */}
      {(!file.enLigne || attente) && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {file.enLigne ? <CloudOff className="h-4 w-4 shrink-0 text-warning" aria-hidden /> : <WifiOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />}
          <span className="min-w-0 flex-1">
            {!file.enLigne && "Hors ligne — vos comptes rendus sont gardés dans ce téléphone et partiront tout seuls. "}
            {attente}
          </span>
          {file.enLigne && attente && (
            <Button size="sm" variant="outline" className="h-9" onClick={() => void file.vider()}>
              <RefreshCw className="h-3.5 w-3.5" /> Envoyer maintenant
            </Button>
          )}
        </div>
      )}
      {aRegarder.map((b) => (
        <div key={b.id} role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <p>
            <strong>{b.etat === "REFUSE" ? "Compte rendu refusé à l'envoi" : "Visite à vérifier"} — {b.praticien}.</strong>{" "}
            <span className="text-muted-foreground">{b.erreur}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {b.etat === "A_VERIFIER" && (
              <Button size="sm" variant="outline" className="h-9" onClick={() => file.renvoyer(b.id)}>Renvoyer</Button>
            )}
            <BoutonDecisif size="sm" variant="ghost" className="h-9" onClick={() => file.retirer(b.id)} confirmation="retirer ce brouillon du téléphone">
              Retirer ce brouillon
            </BoutonDecisif>
          </div>
        </div>
      ))}

      {annonce && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
          <span className="min-w-0 flex-1">
            {annonce.texte}
            {annonce.suivante && nomDe(annonce.suivante) && <> Prochaine : <strong>{nomDe(annonce.suivante)}</strong></>}
          </span>
          {annonce.suivante && nomDe(annonce.suivante) && (
            <Button size="sm" className="h-9" onClick={() => ouvrirCible(annonce.suivante!)}>Commencer</Button>
          )}
        </div>
      )}

      {/* ── LES COMPTES RENDUS EN RETARD — la fenêtre de 48 h, ce qui se sauve encore et ce qui est perdu ─────── */}
      {(enRetard.length > 0 || fermes.length > 0) && (
        <section aria-labelledby="titre-retard" className="overflow-hidden rounded-xl border border-destructive/40 bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-destructive/5 px-3 py-2.5 sm:px-4">
            <h2 id="titre-retard" className="text-sm font-semibold text-destructive">Comptes rendus en retard · {enRetard.length}</h2>
            <InfoBulle label="La règle des 48 h" align="right">
              Le compte rendu d&apos;une visite s&apos;écrit dans les 48 h. Passé ce délai, il ne s&apos;écrit plus ni ne se corrige :
              la visite reste comptée non rapportée, et votre superviseur voit les retards.
            </InfoBulle>
          </div>
          <ul className="divide-y divide-border">
            {enRetard.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
                {lettreDe(l.doctorId) && <LettreBadge lettre={lettreDe(l.doctorId)!} className="h-5 min-w-[22px] shrink-0" />}
                <span className="min-w-0 flex-1 basis-52">
                  <span className="block truncate font-medium">{l.doctorName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{jourEtHeure(l.date)} · {l.institution ?? "—"}</span>
                </span>
                <Badge tone={tonDuDelai(l.heuresRestantes)}>reste {l.heuresRestantes} h</Badge>
                <Button size="sm" variant={tonDuDelai(l.heuresRestantes) === "danger" ? "primary" : "outline"} className="h-10 sm:h-9"
                  onClick={() => ouvrirCible({ sorte: "PLANIFIEE", visitId: l.id })} disabled={occupe}>
                  Écrire le compte rendu
                </Button>
              </li>
            ))}
            {fermes.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 text-muted-foreground sm:px-4">
                {lettreDe(l.doctorId) && <LettreBadge lettre={lettreDe(l.doctorId)!} className="h-5 min-w-[22px] shrink-0" />}
                <span className="min-w-0 flex-1 basis-52">
                  <span className="block truncate font-medium text-foreground">{l.doctorName}</span>
                  <span className="block truncate text-xs">{jourEtHeure(l.date)} · {l.institution ?? "—"}</span>
                </span>
                <Badge tone="neutral">fenêtre fermée — non rapportée</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── LES VISITES DU JOUR, DANS L'ORDRE DE LA TOURNÉE ─────────────────────────────────── */}
      <section aria-labelledby="titre-jour" id="visites-du-jour" className="scroll-mt-20 space-y-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="titre-jour" className="text-base font-semibold">Visites du jour · dans l&apos;ordre de la tournée</h2>
          {auJour.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {auJour.filter((l) => l.etat === "FAITE").length} faite(s) sur {auJour.length}
              {nomProchaine ? ` · prochaine : ${nomProchaine}` : ""}
            </span>
          )}
        </div>
        {auJour.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Aucune visite prévue aujourd&apos;hui. Un médecin vu sans être prévu : « + Visite hors plan ».
          </p>
        ) : (
          <ol className="space-y-2.5">
            {auJour.map((l, i) => (
              <CarteVisiteDuJour
                key={l.id}
                l={l}
                rang={i + 1}
                lettre={lettreDe(l.doctorId)}
                dernierPassage={dernierPassageDe(l)}
                estProchaine={prochaine?.sorte === "PLANIFIEE" && prochaine.visitId === l.id}
                occupe={occupe}
                peutSignalerPv={peutSignalerPv}
                onCommencer={() => ouvrirCible({ sorte: "PLANIFIEE", visitId: l.id })}
                onVoir={() => { setErr(null); setVueId(l.id); }}
                onNonTenue={() => { setErrNonTenue(null); setNonTenue(l); }}
              />
            ))}
          </ol>
        )}
      </section>

      {/* ── À RATTRAPER — la fréquence en retard, sous la tournée ─────────────────────────── */}
      {aRattraper.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="a-rattraper">
          <h2 id="a-rattraper" className="px-3 pb-1 pt-3 text-base font-semibold sm:px-4">À rattraper si vous avez un creux</h2>
          <ul className="divide-y divide-border">
            {aRattraper.map((r) => (
              <li key={r.doctorId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
                {r.lettre && <LettreBadge lettre={r.lettre} className="h-5 min-w-[22px] shrink-0" />}
                <span className="min-w-0 flex-1 basis-52">
                  <Link href={`/praticiens/${r.doctorId}`} className="block truncate font-medium hover:underline">{r.name}</Link>
                  {/* LA RAISON, chiffrée : un ordre sans justification se subit. */}
                  <span className="block text-xs text-warning">{r.reason}{r.institution ? ` · ${r.institution}` : ""}</span>
                </span>
                <Button variant="outline" className="h-10 shrink-0 sm:h-9" onClick={() => ouvrirCible({ sorte: "HORS_PLAN", doctorId: r.doctorId })} disabled={occupe}>
                  Commencer (hors plan)
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── LA BARRE DU POUCE (téléphone) : la prochaine visite, toujours à portée ────────────── */}
      {prochaine && nomProchaine && !ouverte && !vue && (
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-card/95 px-4 py-2 backdrop-blur lg:hidden">
          <Button className="h-12 w-full min-w-0 text-base" onClick={() => ouvrirCible(prochaine)} disabled={occupe}>
            <span className="truncate">Commencer la visite — {nomProchaine}</span>
          </Button>
        </div>
      )}

      {choixOuvert && (
        <ChoixPraticien
          panel={panel}
          onClose={() => setChoixOuvert(false)}
          onChoisir={(id) => { setChoixOuvert(false); ouvrirCible(cibleDuPraticien(id, aujourdhui)); }}
        />
      )}

      <FeuilleVisite
        ouverte={ouverte}
        contexte={ouverte ? contexteDe(
          ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.doctorId : ouverte.praticien.id,
          ouverte.sorte === "HORS_PLAN" ? ouverte.praticien.lettre ?? null : null,
        ) : null}
        onClose={() => setOuverte(null)}
        gamme={gamme}
        stock={stock}
        precoches={precoches}
        occupe={occupe}
        err={err}
        enregistrer={enregistrer}
        onNonTenue={(l) => { setErrNonTenue(null); setOuverte(null); setNonTenue(l); }}
        peutSignalerPv={peutSignalerPv}
      />
      <CompteRenduEnvoye
        ligne={vue}
        onClose={() => setVueId(null)}
        onCorriger={(l) => { setVueId(null); setOuverte({ sorte: "PLANIFIEE", ligne: l }); }}
        peutSignalerPv={peutSignalerPv}
      />
      <FeuilleNonTenue visite={nonTenue} onClose={() => setNonTenue(null)} executer={executer} occupe={occupeNonTenue} err={errNonTenue} />
    </div>
  );
}

/** Le panel, cherchable. Une liste de deux cents noms sans recherche n'est pas une liste. */
function ChoixPraticien({ panel, onChoisir, onClose }: { panel: PraticienVisite[]; onChoisir: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = React.useState("");
  const trouves = q.trim()
    ? panel.filter((d) => plier(`${d.name} ${d.specialty ?? ""} ${d.institution ?? ""} ${d.wilaya ?? ""}`).includes(plier(q.trim())))
    : panel;
  return (
    <Sheet open onClose={onClose} title="Quel médecin ?" description="Un médecin prévu aujourd'hui ouvre le rapport de sa visite." width="md">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, spécialité, établissement, wilaya…" className="pl-8" aria-label="Chercher un médecin" />
        </div>
        {trouves.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Aucun médecin de votre panel ne correspond.</p>
        ) : (
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {trouves.slice(0, 100).map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onChoisir(d.id)} className="w-full rounded-md px-3 py-3 text-left text-sm hover:bg-secondary active:bg-secondary sm:py-2">
                  <span className="font-medium">{d.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[d.specialty, d.institution, d.wilaya].filter(Boolean).join(" · ") || "—"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Link href={`/medical/mes-medecins?ajouter=1${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`} className="inline-flex min-h-10 items-center text-sm font-medium text-primary hover:underline sm:min-h-0">
          Il n&apos;est pas dans mon panel → l&apos;ajouter
        </Link>
      </div>
    </Sheet>
  );
}
