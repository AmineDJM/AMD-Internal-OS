"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { CheckCircle2, FileSpreadsheet, Loader2, AlertTriangle, Paperclip, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BADGE_HISTORIQUE, CATEGORIES_2026, DEMANDEUR_AFFICHE, LIBELLE_TYPE_DEMANDE, ORDRE_TYPES, SOUS_CATEGORIES_EVENEMENTS,
  formatCentimes, libelleImputation, montantDeLaDemande, type DemandePrevue,
} from "@/lib/budget-marketing/integration-2026";
import {
  apercuIntegrationAdPro, lireFichierIntegrationAdPro, validerIntegrationAdPro, type LectureIntegration,
} from "@/lib/actions/integration-adpro-actions";
import type { Apercu, ChoixDemande } from "@/lib/budget-marketing/integration-serveur";
import {
  appliquerDecisionsLocales, doublonsProbables, mentionDoublon, preselection, type DecisionAbsente, type DoublonProbable,
} from "@/lib/budget-marketing/integration-absentes";

/**
 * L'ASSISTANT D'INTÉGRATION — quatre étapes (maquette validée) : lire le fichier → trouver ou créer chaque demande →
 * pièces (facultatif) → vérifier et valider. Le fichier est RENVOYÉ et RELU par le serveur à chaque étape : l'écran ne
 * transporte que les choix, jamais le plan.
 *
 * « GARDER / EN SORTIR » AVANT LA VALIDATION (Direction, 14/10/2026 — « ça sort carrément et je dois refaire le calcul du
 * fichier à chaque fois ») : un choix de l'étape 4 effaçait l'aperçu — la table, la liste et la validation disparaissaient,
 * et il fallait renvoyer le fichier au serveur. Le choix est désormais LOCAL : l'aperçu reste et se RECALCULE à l'écran
 * (`appliquerDecisionsLocales`), rien n'est rechargé, aucune étape n'est perdue. Les choix partent avec la validation et
 * s'écrivent dans la même transaction que le lot. Rien ici ne remonte le composant (pas de `router.refresh()` avant la
 * validation réussie) : le fichier lu et les choix des étapes 1 à 3 vivent tant que l'assistant est ouvert.
 */

const MOIS = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const dzd = (n: number) => `${Math.round(n * 100) === 0 ? "0" : formatCentimes(Math.round(n * 100))} DZD`;
const ETAPES = ["Lire le fichier", "Trouver ou créer la demande", "Joindre les pièces", "Vérifier et valider"] as const;

export function AssistantIntegration({ envelopeId, enveloppe }: { envelopeId: string; enveloppe: string }) {
  const { rafraichir } = useRafraichir();
  const [etape, setEtape] = React.useState(0);
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [lecture, setLecture] = React.useState<LectureIntegration | null>(null);
  const [choix, setChoix] = React.useState<Record<string, ChoixDemande>>({});
  const [visa, setVisa] = React.useState<string>("");
  const [rattacherConnues, setRattacherConnues] = React.useState(true);
  const [decisions, setDecisions] = React.useState<Record<string, DecisionAbsente>>({});
  const [apercu, setApercu] = React.useState<Apercu | null>(null);
  const [doublons, setDoublons] = React.useState<Map<string, DoublonProbable>>(new Map());
  const proposees = React.useRef<Set<string>>(new Set());
  const [verifie, setVerifie] = React.useState(false);
  const [mot, setMot] = React.useState("");
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string; details?: string[] } | null>(null);

  const formulaire = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    if (fichier) fd.set("fichier", fichier);
    fd.set("envelopeId", envelopeId);
    fd.set("choix", JSON.stringify(Object.values(choix)));
    // Les choix des éléments de l'aperçu (libellé et montant pour le journal du lot) ; sans aperçu, ceux déjà faits.
    const lignes = apercu
      ? apercu.absentes.filter((a) => decisions[a.cle]).map((a) => ({ cleSource: a.cle, decision: decisions[a.cle], libelle: `${a.reference} — ${a.libelle}`, montant: a.montant }))
      : Object.entries(decisions).map(([cleSource, decision]) => ({ cleSource, decision }));
    fd.set("decisions", JSON.stringify(lignes));
    if (lecture?.sha256) fd.set("sha256", lecture.sha256);
    fd.set("dossierPromoDuVisa", visa);
    fd.set("rattacherConnues", rattacherConnues ? "on" : "off");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  async function lire() {
    if (!fichier) { setMsg({ ok: false, text: "Choisissez le fichier « Dépenses AP » (.xlsx)." }); return; }
    setOccupe("lire"); setMsg(null);
    try {
      const r = await lireFichierIntegrationAdPro(formulaire());
      if (!r.ok || !r.plan) { setMsg({ ok: false, text: r.error ?? "Lecture impossible.", details: r.erreurs }); setLecture(null); return; }
      setLecture(r);
      const init: Record<string, ChoixDemande> = {};
      for (const p of r.propositions ?? []) {
        init[p.cle] = p.parDefaut.mode === "COMPLETEE"
          ? { cle: p.cle, mode: "COMPLETEE", type: p.parDefaut.type, demandeId: p.parDefaut.demandeId, posteRepere: p.suggestions.find((s) => s.candidate.id === (p.parDefaut as { demandeId: string }).demandeId)?.posteRepere ?? null }
          : { cle: p.cle, mode: "CREEE" };
      }
      setChoix(init); setApercu(null);
    } finally { setOccupe(null); }
  }

  async function verifier() {
    setOccupe("apercu"); setMsg(null);
    try {
      const r = await apercuIntegrationAdPro(formulaire());
      if (!r.ok || !r.apercu) { setMsg({ ok: false, text: r.error ?? "Aperçu impossible." }); return; }
      // LA SÉLECTION PROPOSÉE : les doublons probables d'une ligne du fichier pré-réglés « En sortir » — une fois, jamais
      // par-dessus un choix de la personne.
      const d = doublonsProbables(r.apercu.absentes, lecture?.plan ?? { demandes: [] }, lecture?.correspondance, r.apercu.lignes);
      setDoublons(d);
      setDecisions((x) => preselection(x, d, proposees.current));
      for (const cle of d.keys()) proposees.current.add(cle);
      setApercu(r.apercu); setVerifie(false); setMot("");
    } finally { setOccupe(null); }
  }

  /** Un choix « garder / sortir » : local, l'aperçu se recalcule à l'écran — rien n'est rechargé ni relu. */
  const decider = (cles: readonly string[], v: DecisionAbsente) => {
    setDecisions((x) => { const n = { ...x }; for (const c of cles) n[c] = v; return n; });
    setVerifie(false); // la case « j'ai vérifié » porte sur le budget affiché : il vient de changer
  };

  // Arriver à l'étape 4 sans aperçu (premier passage, ou un choix des étapes 2-3 changé) : il se calcule de lui-même.
  React.useEffect(() => {
    if (etape === 3 && lecture?.plan && !apercu && occupe === null && fichier) void verifier();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etape, apercu, lecture]);

  async function valider() {
    setOccupe("valider"); setMsg(null);
    try {
      const r = await validerIntegrationAdPro(formulaire({ verifie: verifie ? "on" : "off", confirmation: mot }));
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Intégration validée.") : (r.error ?? "L'intégration n'a pas été validée.") });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally { setOccupe(null); }
  }

  const plan = lecture?.plan ?? null;
  // L'APERÇU AFFICHÉ = celui du serveur, recalculé avec les choix « garder / sortir » de l'écran.
  const vue = React.useMemo(() => (apercu ? appliquerDecisionsLocales(apercu, decisions) : null), [apercu, decisions]);
  const sorties = (vue?.absentes ?? []).filter((a) => decisions[a.cle] === "SORTIR");
  const propositions = new Map((lecture?.propositions ?? []).map((p) => [p.cle, p]));
  const parType = (t: string) => (plan?.demandes ?? []).filter((d) => d.type === t);
  const peutAvancer = etape === 0 ? Boolean(plan) : true;

  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {ETAPES.map((e, i) => (
          <li key={e}>
            <button
              type="button" disabled={!plan && i > 0} onClick={() => setEtape(i)}
              className={cn("w-full rounded-xl border p-3 text-left text-sm", i === etape ? "border-primary bg-primary/5" : "border-border", !plan && i > 0 && "opacity-50")}
            >
              <span className="block text-xs text-muted-foreground">Étape {i + 1}</span>
              <span className="font-medium">{e}</span>
            </button>
          </li>
        ))}
      </ol>

      {msg && (
        <div className={cn("rounded-xl border p-3 text-sm", msg.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5 text-destructive")}>
          <p>{msg.text}</p>
          {msg.details && msg.details.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}

      {/* ── 1. Lire le fichier ── */}
      {etape === 0 && (
        <section className="surface space-y-4 rounded-xl p-4">
          <p className="text-sm text-muted-foreground">
            Enveloppe : <strong className="text-foreground">{enveloppe}</strong>. Feuil1 fait foi : seules les lignes avec une dépense réelle entrent,
            les décisions de la Direction sont appliquées, et le total est contrôlé au centime. Un fichier qui ne correspond plus aux décisions est refusé.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-primary" />
              <span className="truncate">{fichier ? fichier.name : "Choisir le fichier « Dépenses AP » (.xlsx)"}</span>
              <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setLecture(null); setApercu(null); }} />
            </label>
            <Button type="button" onClick={lire} disabled={!fichier || occupe !== null}>
              {occupe === "lire" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Lire le fichier
            </Button>
          </div>
          {plan && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Tuile titre="Dépenses du fichier" valeur={`${plan.lignes.length}`} sous={`→ ${plan.demandes.length} demandes (2 symposiums en postes de leur congrès)`} />
                <Tuile titre="Total intégré" valeur={`${formatCentimes(plan.totalCentimes)} DZD`} sous="au centime" />
                <Tuile titre="Écartée" valeur={plan.ecartees.map((e) => `L${e.ligne}`).join(", ") || "—"} sous={plan.ecartees.map((e) => e.raison).join(" ")} />
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1">Imputation</th><th className="py-1">Dans l&apos;enveloppe</th><th className="py-1 text-right">Montant</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {CATEGORIES_2026.map((c) => (
                    <React.Fragment key={c}>
                      <tr><td className="py-1.5 font-medium">{c}</td><td>{lecture?.correspondance?.categories[c].id ? lecture.correspondance.categories[c].nom : <Badge tone="warning">à créer (allouée à 0)</Badge>}</td><td className="text-right tabular-nums">{formatCentimes(plan.parCategorie[c])}</td></tr>
                      {c === "Événements" && SOUS_CATEGORIES_EVENEMENTS.map((s) => (
                        <tr key={s} className="text-muted-foreground"><td className="py-1 pl-4">› {s}</td><td>{lecture?.correspondance?.sousCategories[s].id ? lecture.correspondance.sousCategories[s].nom : <Badge tone="warning">à créer</Badge>}</td><td className="text-right tabular-nums">{formatCentimes(plan.parSousCategorie[s])}</td></tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground">Les montants ALLOUÉS de l&apos;enveloppe ne sont pas modifiés.</p>
            </div>
          )}
        </section>
      )}

      {/* ── 2. Trouver ou créer chaque demande ── */}
      {etape === 1 && plan && (
        <section className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pour chaque ligne, les demandes 2026 qui ressemblent (nom, mois, montant). « Compléter » ajoute les postes payés à la demande existante ;
            « Créer » ouvre une demande <Badge tone="purple">{BADGE_HISTORIQUE}</Badge> demandée par la {DEMANDEUR_AFFICHE}, sans aucun circuit.
          </p>
          {ORDRE_TYPES.map((t) => parType(t).length > 0 && (
            <div key={t} className="surface overflow-hidden rounded-xl">
              <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">{LIBELLE_TYPE_DEMANDE[t]} <span className="font-normal text-muted-foreground">· {parType(t).length} demande{parType(t).length > 1 ? "s" : ""}</span></h3>
              <ul className="divide-y divide-border">
                {parType(t).map((d) => (
                  <LigneChoix
                    key={d.cle} d={d} proposition={propositions.get(d.cle) ?? null} choix={choix[d.cle] ?? { cle: d.cle, mode: "CREEE" }}
                    onChoix={(c) => { setChoix((x) => ({ ...x, [d.cle]: c })); setApercu(null); }}
                  />
                ))}
              </ul>
              {t === "MEDICAL_INFO_DECLARATION" && (
                <div className="border-t border-border px-4 py-3 text-sm">
                  <label className="block text-xs font-medium text-muted-foreground">Dossier de matériel promotionnel que couvre le visa (facultatif)</label>
                  <select className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 sm:w-96" value={visa} onChange={(e) => { setVisa(e.target.value); setApercu(null); }}>
                    <option value="">— Aucun pour l&apos;instant —</option>
                    {parType("PROMO_MATERIAL").filter((p) => choix[p.cle]?.mode !== "COMPLETEE").map((p) => <option key={p.cle} value={`lot:${p.cle}`}>{p.libelle} (créé par ce lot)</option>)}
                    {(lecture?.dossiersPromo ?? []).map((p) => <option key={p.id} value={p.id}>{p.libelle}</option>)}
                  </select>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ── 3. Les pièces — facultatives à ce stade ── */}
      {etape === 2 && plan && (
        <section className="surface space-y-3 rounded-xl p-4 text-sm">
          <p className="text-muted-foreground">
            Les pièces sont <strong className="text-foreground">obligatoires mais non bloquantes</strong> : chaque demande affichera « pièces manquantes » tant
            qu&apos;elles ne sont pas jointes, et elles se joignent <strong className="text-foreground">à tout moment</strong> sur sa fiche — plusieurs fichiers d&apos;un coup,
            lus par Luna et comparés à la ligne du fichier. Une pièce déjà dans la plateforme est rattachée, jamais redéposée.
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={rattacherConnues} onChange={(e) => setRattacherConnues(e.target.checked)} />
            Rattacher dès la validation les pièces déjà repérées dans la plateforme
          </label>
          <ul className="divide-y divide-border">
            {plan.demandes.map((d) => (
              <li key={d.cle} className="py-2">
                <p className="font-medium">L{d.lignes.join(" + L")} · {d.libelle}</p>
                <p className="text-xs text-muted-foreground">{d.piecesAttendues.map((p) => p.libelle).join(" · ")}</p>
                {(lecture?.piecesConnues?.[d.cle] ?? []).map((p) => (
                  <p key={p.legalDocumentId} className="mt-1 flex items-center gap-1 text-xs text-success"><Paperclip className="h-3 w-3" /> Déjà dans la plateforme : {p.nom} — rattachée{rattacherConnues ? "" : " (désactivé)"}</p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 4. Vérifier et valider ── */}
      {etape === 3 && plan && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={verifier} disabled={occupe !== null}>
              {occupe === "apercu" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} {apercu ? "Recalculer l'aperçu" : "Calculer le budget avant → après"}
            </Button>
            <span className="text-xs text-muted-foreground">Rien n&apos;est écrit tant que vous n&apos;avez pas validé.</span>
          </div>
          {vue && <TableAvantApres apercu={vue} />}
          {apercu && apercu.remplacees.length > 0 && (
            <div className="surface rounded-xl p-4 text-sm">
              <h3 className="font-semibold">Remplacées par le fichier ({apercu.remplacees.length})</h3>
              <p className="text-xs text-muted-foreground">Une dépense déjà dans la plateforme qui correspond à une ligne : un seul montant, celui du fichier.</p>
              <ul className="mt-2 divide-y divide-border">{apercu.remplacees.map((r) => <li key={r.cle} className="flex justify-between gap-2 py-1"><span>{r.libelle}</span><span className="tabular-nums">{dzd(r.montant)}</span></li>)}</ul>
            </div>
          )}
          {vue && (
            <div id="absentes" className="surface rounded-xl p-4 text-sm">
              <h3 className="font-semibold">Dans la plateforme, absentes du fichier ({vue.absentes.length})</h3>
              <p className="text-xs text-muted-foreground">Pour chacune : la garder dans le budget, ou l&apos;en sortir. Rien n&apos;est effacé, rien n&apos;est rechargé : le budget avant → après se recalcule à chaque choix. Sans choix, elle reste comptée — le choix se change encore à tout moment après la validation.</p>
              {vue.absentes.length === 0 ? <p className="mt-2 text-muted-foreground">Aucune.</p> : (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={() => decider(vue.absentes.map((a) => a.cle), "SORTIR")}>Tout sortir</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => decider(vue.absentes.map((a) => a.cle), "GARDER")}>Tout garder</Button>
                    {doublons.size > 0 && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => decider([...doublons.keys()], "SORTIR")}>
                        Sortir les {doublons.size} doublon{doublons.size > 1 ? "s" : ""} probable{doublons.size > 1 ? "s" : ""}
                      </Button>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {sorties.length} sortie{sorties.length > 1 ? "s" : ""} ({dzd(sorties.reduce((s, a) => s + a.montant, 0))}) · {vue.absentes.length - sorties.length} comptée{vue.absentes.length - sorties.length > 1 ? "s" : ""}
                    </span>
                  </div>
                  <ul className="mt-2 divide-y divide-border">
                    {vue.absentes.map((a) => {
                      const dbl = doublons.get(a.cle);
                      return (
                        <li key={a.cle} className="flex flex-wrap items-center gap-2 py-1.5">
                          <span className="min-w-0 flex-1 basis-[16rem] [overflow-wrap:anywhere]">
                            {a.reference} — {a.libelle} <span className="text-xs text-muted-foreground">· {a.categorie}</span>
                            {dbl && <span className="ml-1 text-xs text-warning">· {mentionDoublon(dbl)}</span>}
                          </span>
                          <span className="tabular-nums">{dzd(a.montant)}</span>
                          <ChoixAbsente valeur={decisions[a.cle] ?? null} onChange={(v) => decider([a.cle], v)} />
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
          {vue && (
            <div className="surface space-y-3 rounded-xl border-primary/40 p-4 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={verifie} onChange={(e) => setVerifie(e.target.checked)} className="mt-1" />
                <span>J&apos;ai vérifié le budget avant → après : {formatCentimes(vue.historiqueCentimes)} DZD intégrés au centime, {plan.demandes.length} demandes{sorties.length ? `, ${sorties.length} élément${sorties.length > 1 ? "s" : ""} absent${sorties.length > 1 ? "s" : ""} du fichier sorti${sorties.length > 1 ? "s" : ""} du budget` : ""}. Le livre de trésorerie et les ordres de paiement ne sont pas modifiés.</span>
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input value={mot} onChange={(e) => setMot(e.target.value)} placeholder="Tapez INTÉGRER" className="rounded-lg border border-border bg-background px-3 py-2 sm:w-56" aria-label="Seconde confirmation" />
                <Button type="button" onClick={valider} disabled={!verifie || mot.trim().toUpperCase() !== "INTÉGRER" || occupe !== null}>
                  {occupe === "valider" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Valider l&apos;intégration
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Annulable d&apos;un bloc : les demandes historiques créées sont retirées, les compléments défaits.</p>
            </div>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="secondary" disabled={etape === 0} onClick={() => setEtape((e) => Math.max(0, e - 1))}>Précédent</Button>
        {etape < 3 && <Button type="button" disabled={!peutAvancer} onClick={() => setEtape((e) => Math.min(3, e + 1))}>Suivant</Button>}
      </div>
    </div>
  );
}

function Tuile({ titre, valeur, sous }: { titre: string; valeur: string; sous?: string }) {
  return (
    <div className="surface rounded-xl p-3">
      <p className="text-xs text-muted-foreground">{titre}</p>
      <p className="text-lg font-semibold tabular-nums">{valeur}</p>
      {sous && <p className="text-xs text-muted-foreground">{sous}</p>}
    </div>
  );
}

function LigneChoix({ d, proposition, choix, onChoix }: {
  d: DemandePrevue;
  proposition: { suggestions: { candidate: { id: string; type: DemandePrevue["type"]; libelle: string; reference: string | null }; score: number; raisons: string[]; posteRepere: string | null }[] } | null;
  choix: ChoixDemande;
  onChoix: (c: ChoixDemande) => void;
}) {
  const nom = `choix-${d.cle}`;
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded bg-secondary px-1.5 text-xs tabular-nums">L{d.lignes.join(" + L")}</span>
        <strong>{d.libelle}</strong>
        <span className="text-xs text-muted-foreground">{d.sousType} · {MOIS[d.mois]}{d.lieu ? ` · ${d.lieu}` : ""}</span>
        <span className="ml-auto font-semibold tabular-nums">{formatCentimes(montantDeLaDemande(d))}</span>
      </div>
      <ul className="text-xs text-muted-foreground">
        {d.postes.map((p, i) => <li key={i}>{p.libelle} — {libelleImputation(p)} · <span className="tabular-nums">{formatCentimes(p.montant)}</span></li>)}
      </ul>
      {d.existant && <p className="text-xs text-primary">Repère : {d.existant.note}</p>}
      <div className="space-y-1">
        <label className="flex items-center gap-2"><input type="radio" name={nom} checked={choix.mode === "CREEE"} onChange={() => onChoix({ cle: d.cle, mode: "CREEE" })} /> Créer la demande historique</label>
        {(proposition?.suggestions ?? []).map((s) => (
          <label key={s.candidate.id} className="flex items-start gap-2">
            <input type="radio" name={nom} className="mt-1" checked={choix.mode === "COMPLETEE" && choix.demandeId === s.candidate.id}
              onChange={() => onChoix({ cle: d.cle, mode: "COMPLETEE", type: s.candidate.type, demandeId: s.candidate.id, posteRepere: s.posteRepere })} />
            <span>Compléter : <strong>{s.candidate.reference ? `${s.candidate.reference} — ` : ""}{s.candidate.libelle}</strong> <span className="text-xs text-muted-foreground">({s.raisons.join(", ")})</span></span>
          </label>
        ))}
        {(proposition?.suggestions ?? []).length === 0 && <p className="text-xs text-muted-foreground">Aucune demande 2026 ne ressemble à cette ligne : elle sera créée.</p>}
      </div>
    </li>
  );
}

export function ChoixAbsente({ valeur, onChange, disabled }: { valeur: "GARDER" | "SORTIR" | null; onChange: (v: "GARDER" | "SORTIR") => void; disabled?: boolean }) {
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
      {(["GARDER", "SORTIR"] as const).map((v) => (
        <button key={v} type="button" disabled={disabled} onClick={() => onChange(v)}
          className={cn("px-2.5 py-1", valeur === v ? (v === "GARDER" ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive") : "hover:bg-secondary")}>
          {v === "GARDER" ? "Garder dans le budget" : "En sortir"}
        </button>
      ))}
    </span>
  );
}

export function TableAvantApres({ apercu }: { apercu: Apercu }) {
  const tetes = apercu.lignes.filter((l) => l.parentId === null);
  const sous = (id: string) => apercu.lignes.filter((l) => l.parentId === id);
  const roule = (l: Apercu["lignes"][number], k: "avant" | "apres") => {
    const s = sous(l.id);
    return { consomme: l[k].consomme + s.reduce((a, x) => a + x[k].consomme, 0), engage: l[k].engage + s.reduce((a, x) => a + x[k].engage, 0) };
  };
  return (
    <div className="surface overflow-x-auto rounded-xl">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr><th className="px-3 py-2">Catégorie › sous-catégorie</th><th className="px-3 py-2 text-right">Alloué</th><th className="px-3 py-2 text-right">Consommé avant</th><th className="px-3 py-2 text-right">Consommé après</th><th className="px-3 py-2 text-right">Engagé avant</th><th className="px-3 py-2 text-right">Engagé après</th></tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tetes.map((t) => {
            const av = roule(t, "avant"), ap = roule(t, "apres");
            return (
              <React.Fragment key={t.id}>
                <tr className="font-medium">
                  <td className="px-3 py-1.5">{t.nom}{t.creee && <Badge tone="warning" className="ml-2">créée, allouée à 0</Badge>}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dzd(t.alloue)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dzd(av.consomme)}</td>
                  <td className={cn("px-3 py-1.5 text-right tabular-nums", ap.consomme > t.alloue && t.alloue > 0 && "text-destructive")}>{dzd(ap.consomme)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dzd(av.engage)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dzd(ap.engage)}</td>
                </tr>
                {sous(t.id).map((s) => (
                  <tr key={s.id} className="text-muted-foreground">
                    <td className="px-3 py-1 pl-7">› {s.nom}{s.creee && <Badge tone="warning" className="ml-2">créée</Badge>}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{dzd(s.alloue)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{dzd(s.avant.consomme)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{dzd(s.apres.consomme)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{dzd(s.avant.engage)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{dzd(s.apres.engage)}</td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot className="border-t border-border font-semibold">
          <tr>
            <td className="px-3 py-2">Total</td><td />
            <td className="px-3 py-2 text-right tabular-nums">{dzd(apercu.totalAvant.consomme)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{dzd(apercu.totalApres.consomme)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{dzd(apercu.totalAvant.engage)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{dzd(apercu.totalApres.engage)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground"><AlertTriangle className="h-3 w-3" /> Du fichier : {formatCentimes(apercu.historiqueCentimes)} DZD, chaque poste à sa date (dernier jour du mois) et dans sa catégorie.</p>
    </div>
  );
}
