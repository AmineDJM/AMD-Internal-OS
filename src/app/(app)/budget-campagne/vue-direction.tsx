"use client";

import * as React from "react";
import Link from "next/link";
import { Settings, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Tuile } from "@/components/shared/tuile";
import { cn } from "@/lib/utils";
import {
  ETAPES_FRISE, LIBELLE_DECISION_LIGNE, LIBELLE_SOURCE, LIBELLE_STATUT_CAMPAGNE, TON_STATUT_PROPOSITION,
  TRANSITIONS_CAMPAGNE, etapeCourante, type DroitsCampagne,
} from "@/lib/budget-campagne/regles";
import { tuilesDirection, type CampagneVueDirection, type PropositionVue, type LigneVue } from "@/lib/budget-campagne/vues";
import {
  changerStatutCampagne, deciderLigneProposition, voterProposition, renvoyerProposition, reprendreProposition,
  commenterProposition, autoriserRevisionProposition,
} from "@/lib/actions/budget-campagne-actions";
import { lienPropositionPole } from "@/lib/chemins/budget-campagne";
import { useActions, th, td, num, btn, btnPrimaire, champ, m, Ecart, BarreCadrage } from "./commun";

/**
 * LA VUE DE LA DIRECTION — frise des six étapes, quatre tuiles, les propositions par pôle (écart, cadrage, « où — chez
 * qui », version), et le panneau d'examen ligne par ligne avec son fil d'échanges et les résumés de Luna.
 * Le cadrage n'arrive ici que pour qui le voit (DG, valideurs, Super Admin) : absent des données, il n'est pas affiché.
 */
export function VueDirection({ campagne, propositions, droits, campagnes, examenId }: {
  campagne: CampagneVueDirection;
  propositions: PropositionVue[];
  droits: DroitsCampagne;
  campagnes: { id: string; year: number; title: string; status: string }[];
  examenId: string | null;
}) {
  const { run, busy, info } = useActions();
  const [examen, setExamen] = React.useState<string | null>(examenId);
  const voitCadrage = campagne.cadrageTotal !== undefined;
  const t = tuilesDirection(propositions, campagne.cadrageTotal);
  const etape = etapeCourante(campagne.status, propositions.map((p) => p.statut));
  const suivants = TRANSITIONS_CAMPAGNE[campagne.status];
  const choisie = propositions.find((p) => p.id === examen) ?? null;
  const date = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{campagne.title}</h1>
          <p className="text-sm text-muted-foreground">
            ouverte le {date(campagne.opensAt)} · remise avant le {date(campagne.submitDeadline)} · validation avant le {date(campagne.validationDeadline)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {campagnes.length > 1 && (
            <select className={champ} value={campagne.id} aria-label="Campagne" onChange={(e) => { window.location.href = `?campagne=${encodeURIComponent(e.target.value)}`; }}>
              {campagnes.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          )}
          {droits.peutPiloter && suivants.map((s) => (
            <button key={s} type="button" disabled={busy} className={s === suivants[suivants.length - 1] ? btnPrimaire : btn}
              onClick={() => void run(changerStatutCampagne, { id: campagne.id, statut: s }, { confirmer: `Passer la campagne à « ${LIBELLE_STATUT_CAMPAGNE[s]} » ?` })}>
              {LIBELLE_STATUT_CAMPAGNE[s]}
            </button>
          ))}
          {droits.peutPiloter && <Link className={btn} href={`?campagne=${encodeURIComponent(campagne.id)}&vue=reglages`}><Settings className="h-4 w-4" /> Réglages</Link>}
          {droits.peutPiloter && <Link className={btn} href="?vue=nouvelle"><Plus className="h-4 w-4" /> Nouvelle</Link>}
        </div>
      </div>
      {info && <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{info}</p>}

      {/* LA FRISE */}
      <ol className="surface flex overflow-x-auto px-4 py-3" aria-label="Étapes de la campagne">
        {ETAPES_FRISE.map((nom, i) => (
          <li key={nom} className="relative min-w-28 flex-1 pt-5 text-xs">
            <span className={cn("absolute left-0 right-0 top-[5px] h-0.5", i < etape ? "bg-success" : "bg-border")} />
            <span className={cn("absolute left-0 top-0 h-3 w-3 rounded-full border-2",
              i < etape ? "border-success bg-success" : i === etape ? "border-primary bg-primary ring-4 ring-primary/20" : "border-border bg-background")} />
            <b className={cn("block text-[13px]", i > etape && "font-medium text-muted-foreground")}>{nom}</b>
            {i === 1 && <span className="text-muted-foreground">{t.remises} / {t.total} remis</span>}
            {i === 0 && voitCadrage && campagne.cadrageTotal ? <span className="text-muted-foreground">enveloppe {m(campagne.cadrageTotal)}</span> : null}
          </li>
        ))}
      </ol>

      {/* LES TUILES */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Tuile label="Demandé" valeur={m(t.demande)} ton={t.ecartCadrage !== null && t.ecartCadrage > 0 ? "alerte" : "defaut"}
          contexte={t.ecartCadrage !== null ? `${t.ecartCadrage > 0 ? "+" : ""}${String(t.ecartCadrage).replace(".", ",")} % par rapport au cadrage` : undefined} />
        {voitCadrage ? (
          <Tuile label="Cadrage" valeur={campagne.cadrageTotal ? m(campagne.cadrageTotal) : "—"}
            info={<InfoBulle label="Cadrage privé">Visible du DG, des valideurs et du Super Admin seulement. Les pôles préparent librement : ils ne le voient jamais.</InfoBulle>} />
        ) : (
          <Tuile label="Retenu (validé)" valeur={m(t.retenu)} />
        )}
        <Tuile label={`Réalisé ${campagne.year - 1} (projection)`} valeur={m(t.realise)}
          contexte={t.ecartRealise !== null ? `${t.ecartRealise > 0 ? "+" : ""}${String(t.ecartRealise).replace(".", ",")} % demandé` : undefined} />
        <Tuile label="À revoir" valeur={t.aRevoir} contexte="renvoyés aux pôles" />
      </div>

      {/* LES PROPOSITIONS PAR PÔLE (l'arbitrage se lit ici : demandé, réalisé, cadrage) */}
      <section className="surface overflow-hidden">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Propositions par pôle</h2>
          <span className="text-xs text-muted-foreground">validation : {campagne.validateurs.map((v) => v.nom).join(" + ") || "—"} · {campagne.validatorRule === "ALL" ? "tous" : "un seul"}</span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>Pôle · responsable</th><th className={cn(th, num)}>{campagne.year - 1} projeté</th><th className={cn(th, num)}>{campagne.year} demandé</th>
              <th className={cn(th, num)}>Écart</th>{voitCadrage && <th className={th}>Cadrage</th>}<th className={th}>État</th><th className={th}>Version</th><th className={th} />
            </tr></thead>
            <tbody>
              {propositions.length === 0 && <tr><td className={td} colSpan={8}><span className="text-muted-foreground">Aucun pôle — ajoutez-en dans les réglages.</span></td></tr>}
              {propositions.map((p) => (
                <tr key={p.id} className={cn(choisie?.id === p.id && "bg-primary/5")}>
                  <td className={td}>{p.pole}{p.responsable && <span className="text-muted-foreground"> · {p.responsable}</span>}{p.estRectificatif && <Badge tone="purple" dot={false} className="ml-1.5">rectificatif</Badge>}</td>
                  <td className={cn(td, num)}>{m(p.realise)}</td>
                  <td className={cn(td, num)}>{p.version > 0 ? m(p.demande) : <span className="text-muted-foreground">—</span>}</td>
                  <td className={cn(td, num)}>{p.version > 0 ? <Ecart pct={p.ecart} /> : null}</td>
                  {voitCadrage && <td className={td}><BarreCadrage demande={p.demande} cadrage={p.cadrage} /></td>}
                  <td className={td}><Badge tone={TON_STATUT_PROPOSITION[p.statut]} dot={false}>{p.ouChezQui}</Badge></td>
                  <td className={td}>{p.version > 0 ? `v${p.version}` : "—"}</td>
                  <td className={td}>
                    <span className="flex gap-1.5">
                      <button type="button" className={p.statut === "SOUMIS" && droits.estValideur ? btnPrimaire : btn} onClick={() => setExamen(p.id)}>
                        {p.statut === "SOUMIS" && droits.estValideur ? "Examiner" : "Ouvrir"}
                      </button>
                      <Link className={btn} href={lienPropositionPole(p.id)}>Pôle</Link>
                    </span>
                  </td>
                </tr>
              ))}
              {propositions.length > 1 && (
                <tr className="font-semibold">
                  <td className={td}>Total</td><td className={cn(td, num)}>{m(t.realise)}</td><td className={cn(td, num)}>{m(t.demande)}</td>
                  <td className={cn(td, num)}><Ecart pct={t.ecartRealise} /></td>
                  {voitCadrage && <td className={td}><BarreCadrage demande={t.demande} cadrage={campagne.cadrageTotal} /></td>}
                  <td className={td} colSpan={3} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {choisie && <Examen p={choisie} droits={droits} run={run} busy={busy} onFermer={() => setExamen(null)} />}
    </div>
  );
}

function Examen({ p, droits, run, busy, onFermer }: {
  p: PropositionVue; droits: DroitsCampagne; busy: boolean; onFermer: () => void;
  run: ReturnType<typeof useActions>["run"];
}) {
  const [message, setMessage] = React.useState("");
  const [renvoi, setRenvoi] = React.useState("");
  const peutTrancher = droits.estValideur && p.gestes.DECIDER_LIGNE;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <section className="surface min-w-0 overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Examen — {p.pole} {p.version > 0 ? `v${p.version}` : ""}</h2>
          <button type="button" className={btn} onClick={onFermer}>Fermer</button>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>Ligne</th><th className={cn(th, num)}>Réalisé</th><th className={cn(th, num)}>Demandé</th><th className={th}>Décision</th>
            </tr></thead>
            <tbody>
              {p.lignes.map((l) => <LigneExamen key={l.id} l={l} peutTrancher={peutTrancher} peutQuestionner={p.gestes.DECIDER_LIGNE} run={run} busy={busy} />)}
            </tbody>
          </table>
        </div>
        {p.avis.length > 0 && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Avis : {p.avis.map((a) => `${a.nom} ${a.decision === "REFUSE" ? "refuse" : "accepte"}`).join(" · ")}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {p.gestes.RENVOYER && (droits.estValideur || droits.peutPiloter) && (
            <>
              <input className={cn(champ, "min-w-48 flex-1")} placeholder="Ce qu'il faut revoir…" value={renvoi} onChange={(e) => setRenvoi(e.target.value)} />
              <button type="button" className={btn} disabled={busy || !renvoi.trim()} onClick={() => void run(renvoyerProposition, { proposalId: p.id, comment: renvoi }).then((r) => r.ok && setRenvoi(""))}>Renvoyer pour révision</button>
            </>
          )}
          {p.gestes.VOTER && droits.estValideur && (
            <>
              <button type="button" className={btn} disabled={busy} onClick={() => void run(voterProposition, { proposalId: p.id, decision: "REFUSE" }, { confirmer: "Refuser cette proposition ?" })}>Refuser</button>
              <button type="button" className={btnPrimaire} disabled={busy} onClick={() => void run(voterProposition, { proposalId: p.id, decision: "ACCEPTE" })}>
                {p.lignes.some((l) => l.decision === "AJUSTE" || l.decision === "REFUSE") ? "Accepter avec ajustements" : "Accepter"}
              </button>
            </>
          )}
          {p.gestes.REPRENDRE && (droits.estValideur || droits.peutPiloter) && (
            <button type="button" className={btn} disabled={busy} onClick={() => void run(reprendreProposition, { proposalId: p.id })}>Rouvrir au pôle</button>
          )}
          {p.gestes.AUTORISER_REVISION && droits.peutAutoriserRevision && !p.revisionAutorisee && (
            <button type="button" className={btn} disabled={busy} onClick={() => void run(autoriserRevisionProposition, { proposalId: p.id }, { confirmer: "Autoriser une révision de ce budget validé ? (audité)" })}>Autoriser une révision</button>
          )}
          {p.revisionAutorisee && <Badge tone="purple" dot={false}>révision autorisée</Badge>}
        </div>
      </section>

      <section className="surface min-w-0 overflow-hidden">
        <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Fil d&apos;échanges</h2></header>
        {p.commentaires.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Aucun message.</p>}
        {p.commentaires.map((c) => (
          <div key={c.id} className="border-b border-border px-4 py-2.5 text-sm">
            <b className={cn(c.parLuna && "text-purple-700 dark:text-purple-300")}>{c.auteur}</b> — {c.body}
            <small className="block text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString("fr-FR")}{c.ligne ? ` · sur la ligne « ${c.ligne} »` : ""}{c.parLuna ? " · résumé des changements" : ""}</small>
          </div>
        ))}
        <form className="flex gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void run(commenterProposition, { proposalId: p.id, body: message }).then((r) => r.ok && setMessage("")); }}>
          <input className={cn(champ, "min-w-0 flex-1")} placeholder="Écrire au pôle…" value={message} onChange={(e) => setMessage(e.target.value)} />
          <button type="submit" className={btn} disabled={busy || !message.trim()}>Envoyer</button>
        </form>
        {p.versions.length > 0 && (
          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {p.versions.map((v) => <div key={v.version}>v{v.version}{v.rectificatif ? " (rectificatif)" : ""} · {new Date(v.submittedAt).toLocaleDateString("fr-FR")} · {m(v.total)}</div>)}
          </div>
        )}
      </section>
    </div>
  );
}

function LigneExamen({ l, peutTrancher, peutQuestionner, run, busy }: {
  l: LigneVue; peutTrancher: boolean; peutQuestionner: boolean; busy: boolean; run: ReturnType<typeof useActions>["run"];
}) {
  const [mode, setMode] = React.useState<"AJUSTE" | "QUESTION" | null>(null);
  const [valeur, setValeur] = React.useState("");
  const decision = l.decision ? (l.decision === "AJUSTE" ? `ajusté à ${m(l.ajuste)}` : LIBELLE_DECISION_LIGNE[l.decision]) : null;
  const ton = l.decision === "ACCEPTE" ? "success" : l.decision === "REFUSE" ? "danger" : l.decision === "QUESTION" ? "purple" : "warning";
  const envoyer = () => {
    if (!mode) return;
    void run(deciderLigneProposition, { lineId: l.id, decision: mode, ...(mode === "AJUSTE" ? { ajuste: valeur } : { question: valeur }) })
      .then((r) => { if (r.ok) { setMode(null); setValeur(""); } });
  };
  return (
    <tr>
      <td className={cn(td, "whitespace-normal")}>
        {l.label} <span className="text-xs text-muted-foreground">({LIBELLE_SOURCE[l.source]})</span>
        {l.justification && <span className="block text-xs text-muted-foreground">{l.justification}</span>}
        {l.pieces.map((pc) => <a key={pc.id} href={`/api/documents/${pc.id}`} className="mr-2 text-xs text-primary underline" target="_blank" rel="noreferrer">{pc.name}</a>)}
      </td>
      <td className={cn(td, num)}>{m(l.realise2026)}</td>
      <td className={cn(td, num)}>{m(l.propose)} <span className="block text-xs"><Ecart pct={l.ecart} /></span></td>
      <td className={td}>
        {decision && <Badge tone={ton} dot={false}>{decision}</Badge>}
        {(peutTrancher || peutQuestionner) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {peutTrancher && <button type="button" className={btn} disabled={busy} onClick={() => void run(deciderLigneProposition, { lineId: l.id, decision: "ACCEPTE" })}>✓</button>}
            {peutTrancher && <button type="button" className={btn} disabled={busy} onClick={() => { setMode("AJUSTE"); setValeur(String(l.propose)); }}>Ajuster</button>}
            <button type="button" className={btn} disabled={busy} onClick={() => { setMode("QUESTION"); setValeur(""); }}>?</button>
            {peutTrancher && <button type="button" className={btn} disabled={busy} onClick={() => void run(deciderLigneProposition, { lineId: l.id, decision: "REFUSE" })}>✕</button>}
          </span>
        )}
        {mode && (
          <span className="mt-1 flex gap-1">
            <input className={cn(champ, "w-40")} inputMode={mode === "AJUSTE" ? "decimal" : "text"} autoFocus value={valeur} onChange={(e) => setValeur(e.target.value)}
              placeholder={mode === "AJUSTE" ? "Montant" : "Question"} aria-label={mode === "AJUSTE" ? "Montant ajusté" : "Question"} />
            <button type="button" className={btnPrimaire} disabled={busy || !valeur.trim()} onClick={envoyer}>OK</button>
          </span>
        )}
      </td>
    </tr>
  );
}
