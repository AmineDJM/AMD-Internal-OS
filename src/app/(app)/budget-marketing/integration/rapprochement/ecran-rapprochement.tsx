"use client";

import * as React from "react";
import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { CheckCircle2, Copy, FileSearch, Link2, Loader2, Pause, Play, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { cn } from "@/lib/utils";
import { dzd as montant } from "@/lib/budget-marketing/rapprochement";
import type { Certitude, Proposition } from "@/lib/budget-marketing/rapprochement";
import type { CibleChoix, DemandePiecesVue, DepenseVue, PropositionPiece, VueRapprochement } from "@/lib/budget-marketing/rapprochement-serveur";
import {
  accepterRapprochementsCertains, annulerDecisionRapprochement, deciderRapprochement, lireTranchePiecesRapprochement,
} from "@/lib/actions/rapprochement-adpro-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING › INTÉGRATION 2026 › RAPPROCHEMENT (Direction, 14/10/2026) — l'écran.
 *
 * Quatre onglets : DÉPENSES → DEMANDES (chaque dépense hors poste et chaque écriture « à imputer », ses propositions
 * triées par certitude), PIÈCES → DEMANDES (par demande, les Historique 2026 aux pièces manquantes d'abord), DOUBLONS
 * PROBABLES (avec l'outil qui tranche), DÉCISIONS (le journal, chaque décision annulable). Rien n'est rattaché sans un
 * clic ; « Accepter toutes les propositions certaines » ne touche que la règle stricte, affichée.
 *
 * La lecture des pièces par Luna se fait PAR TRANCHES depuis cet écran : quelques fichiers par appel, la barre avance,
 * « Pause » arrête après la tranche en cours, et la lecture reprend où elle s'était arrêtée (chaque pièce n'est lue
 * qu'une fois). Ne montre JAMAIS de donnée d'exemple : sans lot, la page le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Onglet = "DEPENSES" | "PIECES" | "DOUBLONS" | "DECISIONS";
type Filtre = "TOUT" | Certitude | "SANS";

const jour = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const DZD = (n: number) => `${montant(n) || "0"} DZD`;
const TON: Record<Certitude, "success" | "info" | "neutral"> = { CERTAINE: "success", PROBABLE: "info", POSSIBLE: "neutral" };
const LIBELLE_CERTITUDE: Record<Certitude, string> = { CERTAINE: "Certaine", PROBABLE: "Probable", POSSIBLE: "Possible" };
const NATURE: Record<string, string> = { ECRITURE: "Écriture", LIGNE: "Ligne budgétaire", ORDRE: "Ordre de dépense" };

export function EcranRapprochement({ vue }: { vue: VueRapprochement }) {
  const { rafraichir } = useRafraichir();
  const [onglet, setOnglet] = React.useState<Onglet>("DEPENSES");
  const [filtre, setFiltre] = React.useState<Filtre>("TOUT");
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [prog, setProg] = React.useState(vue.lecture);
  const [lecture, setLecture] = React.useState(false);
  const [erreursLecture, setErreursLecture] = React.useState<string[]>([]);
  const arret = React.useRef(false);

  React.useEffect(() => setProg(vue.lecture), [vue.lecture]);
  React.useEffect(() => {
    if (!msg) return;
    const h = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(h);
  }, [msg]);

  async function lire() {
    if (lecture) return;
    arret.current = false;
    setLecture(true);
    setErreursLecture([]);
    try {
      for (;;) {
        const fd = new FormData();
        fd.set("envelopeId", vue.envelopeId);
        const r = await lireTranchePiecesRapprochement(fd);
        if (!r.ok || !r.progression) { setMsg({ ok: false, text: r.error ?? "La lecture n'a pas abouti." }); break; }
        setProg(r.progression);
        if (r.progression.erreurs.length) setErreursLecture((e) => [...e, ...r.progression!.erreurs].slice(-5));
        if (arret.current || r.progression.restantes === 0 || r.progression.luesCetteFois === 0) break;
      }
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setLecture(false);
      rafraichir();
    }
  }

  async function agir(cle: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    if (occupe) return;
    setOccupe(cle);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Enregistré." : r.error ?? "L'action n'a pas abouti." });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setOccupe(null);
    }
  }

  const decider = (champs: Record<string, string | null | undefined>) => agir(`${champs.source}:${champs.decision}:${champs.demandeRowId ?? ""}`, () => {
    const fd = new FormData();
    fd.set("envelopeId", vue.envelopeId);
    for (const [k, v] of Object.entries(champs)) if (v) fd.set(k, v);
    return deciderRapprochement(fd);
  });

  const comptes = {
    TOUT: vue.depenses.length,
    CERTAINE: vue.depenses.filter((d) => d.propositions[0]?.certitude === "CERTAINE").length,
    PROBABLE: vue.depenses.filter((d) => d.propositions[0]?.certitude === "PROBABLE").length,
    POSSIBLE: vue.depenses.filter((d) => d.propositions[0]?.certitude === "POSSIBLE").length,
    SANS: vue.depenses.filter((d) => d.propositions.length === 0).length,
  } satisfies Record<Filtre, number>;
  const depenses = vue.depenses.filter((d) => filtre === "TOUT" || (filtre === "SANS" ? d.propositions.length === 0 : d.propositions[0]?.certitude === filtre));
  const nbPieces = vue.pieces.reduce((s, d) => s + d.propositions.length, 0);
  const actives = vue.decisions.filter((d) => !d.annuleLe).length;
  const pc = prog.total ? Math.round(((prog.lues + prog.nonLues) / prog.total) * 100) : 100;

  return (
    <div className="space-y-4">
      {/* ── Les chiffres ─────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Le rapprochement en chiffres">
        <Tuile k="Dépenses à rapprocher" v={String(vue.depenses.length)} c={`${comptes.CERTAINE} certaine(s) · ${comptes.PROBABLE} probable(s) · ${comptes.SANS} sans proposition`} />
        <Tuile k="Pièces proposées" v={String(nbPieces)} c={`${vue.pieces.filter((d) => d.manquantes.length > 0).length} demande(s) avec des pièces manquantes`} />
        <Tuile k="Doublons probables" v={String(vue.doublons.length)} c="Rien n'est supprimé : à trancher dans l'outil indiqué" alerte={vue.doublons.length > 0} />
        <Tuile k="Décisions" v={String(actives)} c="Auditées, chacune annulable" />
      </section>

      {/* ── La lecture des pièces par Luna ─────────────────────────────────── */}
      <section className="surface space-y-2 rounded-xl p-4" aria-label="Lecture des pièces par Luna">
        <div className="flex flex-wrap items-center gap-2">
          <FileSearch className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Lecture des pièces par Luna</h2>
          <span className="text-xs text-muted-foreground">{prog.lues} lue(s) · {prog.nonLues} non lisible(s) · {prog.restantes} à lire, sur {prog.total} fichier(s) de la plateforme</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {lecture ? (
              <Button size="sm" variant="outline" onClick={() => { arret.current = true; }}><Pause className="h-3.5 w-3.5" /> Pause après cette tranche</Button>
            ) : (
              <Button size="sm" onClick={lire} disabled={prog.restantes === 0}><Play className="h-3.5 w-3.5" /> {prog.lues + prog.nonLues > 0 && prog.restantes > 0 ? "Reprendre la lecture" : "Lire les pièces"}</Button>
            )}
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full border border-border bg-muted" role="progressbar" aria-valuenow={pc} aria-valuemin={0} aria-valuemax={100} aria-label="Pièces lues">
          <span className="block h-full bg-primary motion-safe:transition-[width]" style={{ width: `${pc}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          Legal (BC, contrats, factures, devis, conventions), pièces des demandes Ad &amp; Pro et de leurs postes, secrétariat, ordres, demandes de paiement, écritures, fichiers commerciaux du Drive et pièces jointes de vos conversations.
          Chaque pièce n&apos;est lue qu&apos;une fois (empreinte du fichier) ; une pièce confidentielle n&apos;est jamais montrée à un modèle. Les propositions se mettent à jour à la fin de chaque lecture.
          {lecture && <span className="ml-1 inline-flex items-center gap-1 text-primary"><Loader2 className="h-3 w-3 animate-spin" /> lecture en cours…</span>}
        </p>
        {erreursLecture.length > 0 && <ul className="text-xs text-destructive">{erreursLecture.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </section>

      {/* ── La règle « certaine », et le geste qui l'applique ─────────────────────────────────── */}
      <section className="surface flex flex-wrap items-center gap-3 rounded-xl p-4 text-sm" aria-label="Accepter les propositions certaines">
        <p className="min-w-0 flex-1 basis-[18rem] text-muted-foreground">{vue.regleCertaine}</p>
        <BoutonDecisif
          type="button" size="sm" disabled={vue.certaines === 0 || occupe !== null}
          confirmation={`Accepter les ${vue.certaines} proposition(s) certaine(s)`}
          onClick={() => agir("certaines", () => { const fd = new FormData(); fd.set("envelopeId", vue.envelopeId); fd.set("confirme", "on"); return accepterRapprochementsCertains(fd); })}
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Accepter toutes les propositions certaines ({vue.certaines})
        </BoutonDecisif>
      </section>

      {/* ── Les onglets ─────────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Rapprochement">
        {([
          ["DEPENSES", `Dépenses → demandes (${vue.depenses.length})`],
          ["PIECES", `Pièces → demandes (${nbPieces})`],
          ["DOUBLONS", `Doublons probables (${vue.doublons.length})`],
          ["DECISIONS", `Décisions (${vue.decisions.length})`],
        ] as [Onglet, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={onglet === k} onClick={() => setOnglet(k)}
            className={cn("rounded-full border px-3 py-1.5 text-xs font-medium focus-ring", onglet === k ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-secondary")}>
            {l}
          </button>
        ))}
      </div>

      {onglet === "DEPENSES" && (
        <section className="space-y-3" aria-label="Dépenses → demandes">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer par certitude">
            {(["TOUT", "CERTAINE", "PROBABLE", "POSSIBLE", "SANS"] as Filtre[]).map((f) => (
              <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}
                className={cn("rounded-full border px-2.5 py-1 text-xs focus-ring", filtre === f ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-secondary")}>
                {f === "TOUT" ? "Toutes" : f === "SANS" ? "Sans proposition" : `${LIBELLE_CERTITUDE[f]}s`} <span className="tabular-nums text-muted-foreground">{comptes[f]}</span>
              </button>
            ))}
          </div>
          {depenses.length === 0 ? (
            <p className="surface rounded-xl p-4 text-sm text-muted-foreground">{vue.depenses.length === 0 ? "Aucune dépense hors poste ni écriture à imputer à rapprocher sur cette enveloppe." : "Aucune dépense dans ce filtre."}</p>
          ) : depenses.map((d) => (
            <CarteDepense key={d.source} d={d} cibles={vue.cibles} occupe={occupe} onDecider={decider} />
          ))}
        </section>
      )}

      {onglet === "PIECES" && (
        <section className="space-y-3" aria-label="Pièces → demandes">
          {vue.pieces.every((d) => d.propositions.length === 0) && (
            <p className="surface rounded-xl p-4 text-sm text-muted-foreground">
              {prog.restantes > 0 ? "Aucune pièce proposée pour l'instant : lancez la lecture des pièces par Luna, les propositions apparaissent au fil des tranches." : "Aucune pièce de la plateforme ne correspond aux demandes du lot."}
            </p>
          )}
          {vue.pieces.filter((d) => d.propositions.length > 0 || d.manquantes.length > 0).map((d) => (
            <CartePiecesDemande key={d.rowId} d={d} cibles={vue.cibles} occupe={occupe} onDecider={decider} />
          ))}
        </section>
      )}

      {onglet === "DOUBLONS" && (
        <section className="space-y-3" aria-label="Doublons probables">
          <p className="text-xs text-muted-foreground">Trouvés en chemin. Rien n&apos;est supprimé ni sorti du budget d&apos;ici : chaque doublon renvoie vers l&apos;outil qui tranche (garder / sortir de l&apos;intégration, recensement des doublons de factures).</p>
          {vue.doublons.length === 0 ? <p className="surface rounded-xl p-4 text-sm text-muted-foreground">Aucun doublon probable.</p> : vue.doublons.map((x) => (
            <article key={x.cle} className="surface space-y-2 rounded-xl p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Copy className="h-4 w-4 text-warning" aria-hidden />
                <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{x.raison}</span>
              </div>
              <ul className="space-y-1 text-xs">
                {x.elements.map((e) => (
                  <li key={e.cle} className="flex flex-wrap items-baseline gap-x-2">
                    <Badge tone="neutral" dot={false}>{e.nature === "POSTE_HISTORIQUE" ? "Historique 2026" : e.nature === "POSTE" ? "Poste" : e.nature === "A_IMPUTER" ? "À imputer" : NATURE[e.nature] ?? e.nature}</Badge>
                    {e.href ? <Link href={e.href} className="text-primary hover:underline [overflow-wrap:anywhere]">{e.reference} — {e.libelle}</Link> : <span className="[overflow-wrap:anywhere]">{e.reference} — {e.libelle}</span>}
                    <span className="font-semibold tabular-nums">{DZD(e.montant)}</span>
                  </li>
                ))}
              </ul>
              {x.renvois.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {x.renvois.map((r) => <Link key={r.href} href={r.href} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary">{r.libelle} →</Link>)}
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {onglet === "DECISIONS" && (
        <section className="space-y-2" aria-label="Décisions">
          {vue.decisions.length === 0 ? <p className="surface rounded-xl p-4 text-sm text-muted-foreground">Aucune décision pour l&apos;instant.</p> : (
            <ul className="surface divide-y divide-border rounded-xl">
              {vue.decisions.map((d) => (
                <li key={d.id} className={cn("flex flex-wrap items-start gap-3 px-4 py-3 text-sm", d.annuleLe && "opacity-60")}>
                  <div className="min-w-0 flex-1 basis-[16rem] space-y-0.5">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {d.decision === "ACCEPTEE" ? "Rattachée" : d.decision === "REFUSEE" ? "Refusée" : "Pas Ad & Pro"} — {d.sourceLibelle}
                      {d.montant != null && <span className="ml-1 tabular-nums text-muted-foreground">({DZD(d.montant)})</span>}
                    </p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {d.demandeLibelle ? `→ ${d.demandeLibelle}${d.posteLibelle ? ` › ${d.posteLibelle}` : ""}${d.pieceLibelle ? ` · « ${d.pieceLibelle} »` : ""}` : d.enveloppeSuggeree ? `Enveloppe plausible : ${d.enveloppeSuggeree}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{d.justification}</p>
                    <p className="text-[11px] text-muted-foreground">{jour(d.decideLe)}{d.decidePar ? ` · ${d.decidePar}` : ""}{d.certitude ? ` · ${d.certitude.toLowerCase()}` : " · choix manuel"}{d.annuleLe ? ` · annulée le ${jour(d.annuleLe)}` : ""}</p>
                  </div>
                  {!d.annuleLe && (
                    <Button size="sm" variant="outline" disabled={occupe !== null} onClick={() => agir(`annuler:${d.id}`, () => { const fd = new FormData(); fd.set("id", d.id); return annulerDecisionRapprochement(fd); })}>
                      <Undo2 className="h-3.5 w-3.5" /> Annuler
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {msg && (
        <div role="status" className={cn("fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-[70] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg", msg.ok ? "bg-foreground text-background" : "bg-destructive text-destructive-foreground")}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

function Tuile({ k, v, c, alerte }: { k: string; v: string; c: string; alerte?: boolean }) {
  return (
    <div className="surface grid min-w-0 gap-1 rounded-xl px-4 py-3.5">
      <span className="text-xs font-medium text-muted-foreground">{k}</span>
      <span className={cn("text-xl font-bold tabular-nums", alerte && "text-warning")}>{v}</span>
      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{c}</span>
    </div>
  );
}

type Decider = (champs: Record<string, string | null | undefined>) => void;

function LigneProposition({ p, occupe, onAccepter, onRefuser, enTete }: { p: Proposition; occupe: string | null; onAccepter: () => void; onRefuser: () => void; enTete?: React.ReactNode }) {
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TON[p.certitude]} dot={false}>{LIBELLE_CERTITUDE[p.certitude]} · {p.score}</Badge>
        <span className="min-w-0 flex-1 basis-[14rem] text-sm font-medium [overflow-wrap:anywhere]">
          {enTete ?? <>{p.demandeLibelle}{p.posteLibelle ? <span className="text-muted-foreground"> › {p.posteLibelle}</span> : null}</>}
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onAccepter} disabled={occupe !== null}><Link2 className="h-3.5 w-3.5" /> Accepter</Button>
          <Button size="sm" variant="outline" onClick={onRefuser} disabled={occupe !== null}><XCircle className="h-3.5 w-3.5" /> Refuser</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.justification}</p>
    </li>
  );
}

function CarteDepense({ d, cibles, occupe, onDecider }: { d: DepenseVue; cibles: CibleChoix[]; occupe: string | null; onDecider: Decider }) {
  const [autre, setAutre] = React.useState(false);
  const [choix, setChoix] = React.useState("");
  const [enveloppe, setEnveloppe] = React.useState(d.horsAdPro?.enveloppe ?? "Operations & Sales");
  const [horsOuvert, setHorsOuvert] = React.useState(false);
  const base = { sens: "DEPENSE", source: d.source };
  return (
    <article className="surface space-y-2 rounded-xl p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-[16rem]">
          <p className="font-semibold [overflow-wrap:anywhere]">{d.reference} — {d.libelle}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {jour(d.date)}{d.fournisseur ? ` · ${d.fournisseur}` : ""} · {NATURE[d.nature] ?? d.nature}
          </p>
        </div>
        {d.aImputer ? <Badge tone="warning" dot={false}>À imputer</Badge> : <Badge tone="neutral" dot={false}>Imputée hors poste</Badge>}
        <span className="whitespace-nowrap font-semibold tabular-nums">{DZD(d.montant)}</span>
      </div>
      {d.piecesLues.length > 0 && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Lu par Luna — {d.piecesLues.join(" ; ")}</p>}
      {d.horsAdPro && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs [overflow-wrap:anywhere]">
          Ressemble à une dépense hors Ad &amp; Pro ({d.horsAdPro.raison}) — enveloppe plausible : <b>{d.horsAdPro.enveloppe}</b>. Rien n&apos;est imputé automatiquement.
        </p>
      )}
      {d.propositions.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {d.propositions.map((p) => (
            <LigneProposition
              key={`${p.demandeRowId}:${p.posteId ?? ""}`} p={p} occupe={occupe}
              onAccepter={() => onDecider({ ...base, decision: "ACCEPTEE", demandeRowId: p.demandeRowId, posteId: p.posteId })}
              onRefuser={() => onDecider({ ...base, decision: "REFUSEE", demandeRowId: p.demandeRowId, posteId: p.posteId })}
            />
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">Aucune demande du lot ne lui ressemble assez (montant, fournisseur, date, libellé, références, pièces lues).</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="rounded text-primary hover:underline focus-ring" onClick={() => setAutre((x) => !x)} aria-expanded={autre}>Choisir une autre demande</button>
        <span className="text-muted-foreground">·</span>
        <button type="button" className="rounded text-primary hover:underline focus-ring" onClick={() => setHorsOuvert((x) => !x)} aria-expanded={horsOuvert}>Pas Ad &amp; Pro…</button>
      </div>
      {autre && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select value={choix} onChange={(e) => setChoix(e.target.value)} aria-label={`Demande pour ${d.reference}`}
            className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:max-w-md">
            <option value="">Choisir la demande (et le poste)…</option>
            {cibles.map((c) => (
              <optgroup key={c.rowId} label={c.libelle}>
                <option value={`${c.rowId}|`}>{c.libelle} — toute la demande</option>
                {c.postes.map((p) => <option key={p.id} value={`${c.rowId}|${p.id}`}>› {p.libelle} ({DZD(p.montant)})</option>)}
              </optgroup>
            ))}
          </select>
          <Button size="sm" disabled={!choix || occupe !== null} onClick={() => { const [rowId, posteId] = choix.split("|"); onDecider({ ...base, decision: "ACCEPTEE", demandeRowId: rowId, posteId: posteId || null }); }}>
            <Link2 className="h-3.5 w-3.5" /> Rattacher
          </Button>
        </div>
      )}
      {horsOuvert && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-xs text-muted-foreground" htmlFor={`env-${d.source}`}>Enveloppe plausible</label>
          <input id={`env-${d.source}`} value={enveloppe} onChange={(e) => setEnveloppe(e.target.value)} className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:w-56" />
          <Button size="sm" variant="outline" disabled={occupe !== null} onClick={() => onDecider({ ...base, decision: "PAS_ADPRO", enveloppe })}>Signaler « pas Ad &amp; Pro »</Button>
        </div>
      )}
    </article>
  );
}

function CartePiecesDemande({ d, cibles, occupe, onDecider }: { d: DemandePiecesVue; cibles: CibleChoix[]; occupe: string | null; onDecider: Decider }) {
  return (
    <article className="surface space-y-2 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        {d.href ? <Link href={d.href} className="min-w-0 flex-1 font-semibold text-primary hover:underline [overflow-wrap:anywhere]">{d.libelle}</Link> : <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{d.libelle}</span>}
        {d.historique && <Badge tone="purple" dot={false}>Historique 2026</Badge>}
        {d.manquantes.length > 0 ? <Badge tone="warning" dot={false}>{d.manquantes.length} pièce(s) manquante(s)</Badge> : <Badge tone="success" dot={false}>pièces complètes</Badge>}
      </div>
      {d.manquantes.length > 0 && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Manquent : {d.manquantes.map((m) => m.libelle).join(" · ")}</p>}
      {d.propositions.length === 0 ? <p className="text-xs text-muted-foreground">Aucune pièce de la plateforme proposée pour l&apos;instant.</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {d.propositions.map((p) => <LignePiece key={`${p.source}:${p.demandeRowId}`} p={p} cibles={cibles} occupe={occupe} onDecider={onDecider} />)}
        </ul>
      )}
    </article>
  );
}

function LignePiece({ p, cibles, occupe, onDecider }: { p: PropositionPiece; cibles: CibleChoix[]; occupe: string | null; onDecider: Decider }) {
  const cible = cibles.find((c) => c.rowId === p.demandeRowId);
  const [cle, setCle] = React.useState(p.pieceCle ?? cible?.attendues[0]?.cle ?? "");
  const [autre, setAutre] = React.useState(false);
  const [autreRow, setAutreRow] = React.useState("");
  const [autreCle, setAutreCle] = React.useState("");
  const autreCible = cibles.find((c) => c.rowId === autreRow);
  const base = { sens: "PIECE", source: p.source };
  return (
    <LigneProposition
      p={p} occupe={occupe}
      onAccepter={() => onDecider({ ...base, decision: "ACCEPTEE", demandeRowId: p.demandeRowId, pieceCle: cle })}
      onRefuser={() => onDecider({ ...base, decision: "REFUSEE", demandeRowId: p.demandeRowId })}
      enTete={(
        <span className="grid gap-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {p.piece.href ? <a href={p.piece.href} target="_blank" rel="noreferrer" className="text-primary hover:underline [overflow-wrap:anywhere]">{p.piece.nom}</a> : <span>{p.piece.nom}</span>}
            <span className="text-xs font-normal text-muted-foreground">{p.piece.ou} · {p.piece.type}</span>
          </span>
          {p.piece.resume && <span className="text-xs font-normal text-muted-foreground">Lu par Luna : {p.piece.resume}</span>}
          <span className="flex flex-col gap-1 text-xs font-normal sm:flex-row sm:items-center">
            <span className="text-muted-foreground">Couvre</span>
            <select value={cle} onChange={(e) => setCle(e.target.value)} aria-label={`Pièce attendue couverte par ${p.piece.nom}`} className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 sm:w-auto">
              {(cible?.attendues ?? []).map((a) => <option key={a.cle} value={a.cle}>{a.libelle}</option>)}
            </select>
            <button type="button" className="rounded text-left text-primary hover:underline focus-ring" onClick={() => setAutre((x) => !x)} aria-expanded={autre}>Choisir une autre demande</button>
          </span>
          {autre && (
            <span className="flex flex-col gap-1 text-xs font-normal sm:flex-row sm:items-center">
              <select value={autreRow} onChange={(e) => { setAutreRow(e.target.value); setAutreCle(cibles.find((c) => c.rowId === e.target.value)?.attendues[0]?.cle ?? ""); }} aria-label="Autre demande" className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 sm:max-w-xs">
                <option value="">Demande…</option>
                {cibles.map((c) => <option key={c.rowId} value={c.rowId}>{c.libelle}</option>)}
              </select>
              {autreCible && (
                <select value={autreCle} onChange={(e) => setAutreCle(e.target.value)} aria-label="Pièce attendue" className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 sm:w-auto">
                  {autreCible.attendues.map((a) => <option key={a.cle} value={a.cle}>{a.libelle}</option>)}
                </select>
              )}
              <Button size="sm" variant="outline" disabled={!autreRow || !autreCle || occupe !== null} onClick={() => onDecider({ ...base, decision: "ACCEPTEE", demandeRowId: autreRow, pieceCle: autreCle })}>
                <Link2 className="h-3.5 w-3.5" /> Rattacher
              </Button>
            </span>
          )}
        </span>
      )}
    />
  );
}
