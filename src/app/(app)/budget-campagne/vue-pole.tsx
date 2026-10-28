"use client";

import * as React from "react";
import Link from "next/link";
import { Paperclip, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { LIBELLE_DECISION_LIGNE, LIBELLE_SOURCE, TON_STATUT_PROPOSITION, type CampagnePourPole } from "@/lib/budget-campagne/regles";
import type { PropositionVue, LigneVue } from "@/lib/budget-campagne/vues";
import {
  preremplirProposition, enregistrerLigneProposition, supprimerLigneProposition, joindrePieceLigne,
  proposerJustificationLuna, soumettreProposition, commenterProposition, rouvrirRectificatif,
} from "@/lib/actions/budget-campagne-actions";
import { CHEMIN_CAMPAGNE_BUDGETAIRE } from "@/lib/chemins/budget-campagne";
import { useActions, th, td, num, btn, btnPrimaire, champ, m, Ecart } from "./commun";

type PropositionPole = Omit<PropositionVue, "cadrage">;

/**
 * LA VUE D'UN PÔLE — ses lignes (source, réalisé projeté, proposé, écart, justification, pièces), « Pré-remplir »,
 * « Soumettre ». Elle ne reçoit AUCUN cadrage (filtré côté serveur) : le pôle prépare librement.
 */
export function VuePole({ campagne, propositions, propositionId, retourDirection }: {
  campagne: CampagnePourPole;
  propositions: PropositionPole[];
  propositionId: string | null;
  retourDirection: boolean;
}) {
  const { run, busy, info } = useActions();
  const p = propositions.find((x) => x.id === propositionId) ?? propositions[0] ?? null;
  const [message, setMessage] = React.useState("");
  const [nouvelle, setNouvelle] = React.useState({ label: "", propose: "" });
  if (!p) return <p className="surface p-6 text-center text-sm text-muted-foreground">Aucun pôle à préparer dans cette campagne.</p>;
  const date = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const modifiable = p.gestes.MODIFIER;
  const manquantes = p.lignes.filter((l) => l.justificationRequise && !(l.justification ?? "").trim()).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Budget {campagne.year} — {p.pole}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            à remettre avant le {date(campagne.submitDeadline)}
            <Badge tone={TON_STATUT_PROPOSITION[p.statut]} dot={false}>{p.ouChezQui}</Badge>
            {p.version > 0 && <span>v{p.version}</span>}
            {p.estRectificatif && <Badge tone="purple" dot={false}>rectificatif</Badge>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {propositions.length > 1 && (
            <select className={champ} value={p.id} aria-label="Pôle" onChange={(e) => { window.location.href = `${CHEMIN_CAMPAGNE_BUDGETAIRE}?pole=${encodeURIComponent(e.target.value)}`; }}>
              {propositions.map((x) => <option key={x.id} value={x.id}>{x.pole}</option>)}
            </select>
          )}
          {retourDirection && <Link className={btn} href={`${CHEMIN_CAMPAGNE_BUDGETAIRE}?campagne=${encodeURIComponent(campagne.id)}`}>Vue d&apos;ensemble</Link>}
          {modifiable && <button type="button" className={btn} disabled={busy} onClick={() => void run(preremplirProposition, { proposalId: p.id })}>Pré-remplir depuis {campagne.year - 1}</button>}
          {p.gestes.SOUMETTRE && (
            <button type="button" className={btnPrimaire} disabled={busy || p.lignes.length === 0}
              title={manquantes ? `${manquantes} justification(s) manquante(s)` : undefined}
              onClick={() => void run(soumettreProposition, { proposalId: p.id }, { confirmer: `Soumettre la version ${p.version + 1} ?` })}>
              Soumettre
            </button>
          )}
          {p.gestes.ROUVRIR_RECTIFICATIF && (
            <button type="button" className={btn} disabled={busy} onClick={() => void run(rouvrirRectificatif, { proposalId: p.id }, { confirmer: "Rouvrir ce budget validé en rectificatif ? Il devra être re-validé." })}>Ouvrir un rectificatif</button>
          )}
        </div>
      </div>
      {info && <p className="whitespace-pre-line rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{info}</p>}
      {manquantes > 0 && modifiable && (
        <p className="text-sm text-warning">{manquantes} ligne(s) à justifier (écart de plus de {String(campagne.seuilJustificationPct).replace(".", ",")} %).</p>
      )}

      <section className="surface overflow-hidden">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Lignes</h2>
            <InfoBulle label="Comment se calcule une ligne">
              Chaque ligne part du réalisé {campagne.year - 1} projeté sur 12 mois. Les lignes automatiques se calculent : masse salariale
              depuis la Paie (total seulement) + recrutements prévus, BV depuis les dossiers réglementaires, Ad &amp; Pro depuis la
              tendance. Au-delà de ±{String(campagne.seuilJustificationPct).replace(".", ",")} %, une phrase (et une pièce) est demandée ; Luna peut en proposer une.
            </InfoBulle>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>Ligne</th><th className={th}>Source</th><th className={cn(th, num)}>{campagne.year - 1} réalisé</th>
              <th className={cn(th, num)}>{campagne.year} proposé</th><th className={cn(th, num)}>Écart</th><th className={th}>Justification</th><th className={th} />
            </tr></thead>
            <tbody>
              {p.lignes.length === 0 && <tr><td className={td} colSpan={7}><span className="text-muted-foreground">Aucune ligne — « Pré-remplir » part du réalisé.</span></td></tr>}
              {p.lignes.map((l) => <LignePole key={`${l.id}:${l.propose}:${l.justification ?? ""}`} proposalId={p.id} l={l} modifiable={modifiable} run={run} busy={busy} />)}
              {p.lignes.length > 0 && (
                <tr className="font-semibold">
                  <td className={td} colSpan={2}>Total</td><td className={cn(td, num)}>{m(p.realise)}</td><td className={cn(td, num)}>{m(p.demande)}</td>
                  <td className={cn(td, num)}><Ecart pct={p.ecart} /></td><td className={td} colSpan={2} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {modifiable && (
          <form className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
            onSubmit={(e) => { e.preventDefault(); void run(enregistrerLigneProposition, { proposalId: p.id, label: nouvelle.label, propose: nouvelle.propose }).then((r) => r.ok && setNouvelle({ label: "", propose: "" })); }}>
            <input className={cn(champ, "min-w-48 flex-1")} placeholder="Nouvelle ligne" value={nouvelle.label} onChange={(e) => setNouvelle({ ...nouvelle, label: e.target.value })} />
            <input className={cn(champ, "w-36")} inputMode="decimal" placeholder="Montant" value={nouvelle.propose} onChange={(e) => setNouvelle({ ...nouvelle, propose: e.target.value })} aria-label="Montant proposé" />
            <button type="submit" className={btn} disabled={busy || !nouvelle.label.trim()}><Plus className="h-4 w-4" /> Ajouter une ligne</button>
          </form>
        )}
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Fil d&apos;échanges</h2></header>
        {p.commentaires.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Aucun message.</p>}
        {p.commentaires.map((c) => (
          <div key={c.id} className="border-b border-border px-4 py-2.5 text-sm">
            <b>{c.auteur}</b> — {c.body}
            <small className="block text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString("fr-FR")}{c.ligne ? ` · sur la ligne « ${c.ligne} »` : ""}</small>
          </div>
        ))}
        <form className="flex gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void run(commenterProposition, { proposalId: p.id, body: message }).then((r) => r.ok && setMessage("")); }}>
          <input className={cn(champ, "min-w-0 flex-1")} placeholder="Répondre…" value={message} onChange={(e) => setMessage(e.target.value)} />
          <button type="submit" className={btn} disabled={busy || !message.trim()}>Envoyer</button>
        </form>
      </section>
    </div>
  );
}

function LignePole({ proposalId, l, modifiable, run, busy }: {
  proposalId: string; l: LigneVue; modifiable: boolean; busy: boolean; run: ReturnType<typeof useActions>["run"];
}) {
  const [propose, setPropose] = React.useState(String(l.propose));
  const [justif, setJustif] = React.useState(l.justification ?? "");
  const fichier = React.useRef<HTMLInputElement>(null);
  const enregistrer = (champs: Record<string, string>) => void run(enregistrerLigneProposition, { proposalId, lineId: l.id, ...champs });
  const manque = l.justificationRequise && !justif.trim();
  const decision = l.decision ? (l.decision === "AJUSTE" ? `ajusté à ${m(l.ajuste)}` : LIBELLE_DECISION_LIGNE[l.decision]) : null;
  return (
    <tr>
      <td className={cn(td, "whitespace-normal")}>
        {l.label}
        {decision && <Badge tone={l.decision === "ACCEPTE" ? "success" : l.decision === "REFUSE" ? "danger" : l.decision === "QUESTION" ? "purple" : "warning"} dot={false} className="ml-1.5">{decision}</Badge>}
      </td>
      <td className={td}><Badge tone={l.source === "SAISIE" || l.source === "REALISE_2026" ? "neutral" : "info"} dot={false}>{LIBELLE_SOURCE[l.source]}</Badge></td>
      <td className={cn(td, num)}>{m(l.realise2026)}</td>
      <td className={cn(td, num)}>
        {modifiable ? (
          <input className={cn(champ, "w-36 text-right")} inputMode="decimal" value={propose} aria-label={`Proposé — ${l.label}`}
            onChange={(e) => setPropose(e.target.value)} onBlur={() => { if (propose !== String(l.propose)) enregistrer({ propose }); }} />
        ) : m(l.propose)}
      </td>
      <td className={cn(td, num)}><Ecart pct={l.ecart} /></td>
      <td className={cn(td, "min-w-56 whitespace-normal")}>
        {modifiable ? (
          <span className="flex items-start gap-1">
            <textarea rows={1} className={cn(champ, "h-auto min-h-9 w-full py-1.5", manque && "border-warning")} value={justif} placeholder={l.justificationRequise ? "Justification requise" : "Justification"}
              aria-label={`Justification — ${l.label}`} onChange={(e) => setJustif(e.target.value)} onBlur={() => { if (justif !== (l.justification ?? "")) enregistrer({ justification: justif }); }} />
            <button type="button" className={btn} disabled={busy} title="Luna propose une rédaction" aria-label="Luna propose une rédaction"
              onClick={() => void run(proposerJustificationLuna, { lineId: l.id }).then((r) => { if (r.ok && r.message) setJustif(r.message); })}>
              <Sparkles className="h-4 w-4" />
            </button>
          </span>
        ) : <span className="text-muted-foreground">{l.justification ?? "—"}</span>}
        {l.pieces.map((pc) => <a key={pc.id} href={`/api/documents/${pc.id}`} className="mr-2 text-xs text-primary underline" target="_blank" rel="noreferrer">{pc.name}</a>)}
      </td>
      <td className={td}>
        {modifiable && (
          <span className="flex gap-1">
            <input ref={fichier} type="file" multiple className="hidden" onChange={(e) => {
              const fichiers = Array.from(e.target.files ?? []);
              if (fichiers.length) void run(joindrePieceLigne, { lineId: l.id, fichiers });
              e.target.value = "";
            }} />
            <button type="button" className={btn} disabled={busy} title="Joindre une pièce" aria-label="Joindre une pièce" onClick={() => fichier.current?.click()}><Paperclip className="h-4 w-4" /></button>
            <button type="button" className={btn} disabled={busy} title="Retirer la ligne" aria-label="Retirer la ligne"
              onClick={() => void run(supprimerLigneProposition, { lineId: l.id }, { confirmer: `Retirer « ${l.label} » ?` })}><Trash2 className="h-4 w-4" /></button>
          </span>
        )}
      </td>
    </tr>
  );
}
