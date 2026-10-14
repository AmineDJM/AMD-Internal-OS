"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, Loader2, Hand, Upload, FileText, AlertTriangle, Send, ExternalLink, Plane, BedDouble } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DocumentPreview } from "@/components/documents/document-preview";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { prendreFiche, signalerManque, deposerBillet, joindreDevisAgence } from "@/lib/actions/reservation-fiche-actions";
import { postDossierMessage } from "@/lib/actions/dossier-actions";
import { NATURE_LIBELLE, REFUS_AVANT_ACCORD } from "@/lib/reservation-fiche/etat";
import type { BureauAdProData, LigneFiche, TravailAdPro } from "@/lib/queries/reservations-fiches";

type Filtre = "TOUT" | "BILLET" | "HOTEL" | "BC_DEVIS";
type Tuile = "A_PRENDRE" | "EN_COURS" | "RELANCEES" | null;
type Resultat = { ok: boolean; error?: string; message?: string };

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const dateHeure = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
const CHAMP = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

const dansTuile = (l: LigneFiche, t: Tuile) =>
  t === null ? true
    : t === "A_PRENDRE" ? l.etat === "ENVOYEE"
      : t === "EN_COURS" ? l.etat === "PRISE" || l.etat === "DEVIS_RECU" || l.etat === "MODIFIEE_APRES_ENVOI"
        : (l.etat === "ENVOYEE" || l.etat === "PRISE" || l.etat === "DEVIS_RECU") && l.relances > 0;

/**
 * L'ONGLET « AD & PRO » DE L'ASSISTANTE (Direction, 14/10/2026) — les tuiles (à prendre, en cours, relancées, BC
 * de poste à établir, devis à retranscrire), le filtre Tout / Billets / Hôtels / BC & devis, la file GROUPÉE PAR
 * OPÉRATION, et le panneau de la fiche ouverte : ses gestes, ses pièces, son fil. Les gestes sont ceux de
 * `reservation-fiche-actions` ; leurs refus (déjà prise, avant l'accord…) sont ceux de l'action, affichés tels quels.
 */
export function TableauAdPro({ data, ficheInitiale }: { data: BureauAdProData; ficheInitiale: string | null }) {
  const { enCours, rafraichir } = useRafraichir();
  const [action, setAction] = React.useState<string | null>(null);
  const busy = action ?? (enCours ? "rafraichir" : null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [filtre, setFiltre] = React.useState<Filtre>("TOUT");
  const [tuile, setTuile] = React.useState<Tuile>(null);
  const toutes = React.useMemo(() => data.groupes.flatMap((g) => g.lignes), [data.groupes]);
  const [ouverte, setOuverte] = React.useState<string | null>(ficheInitiale && toutes.some((l) => l.demandeId === ficheInitiale) ? ficheInitiale : null);
  const verrou = React.useRef(false);

  const run = async (key: string, fn: () => Promise<Resultat>, okText: string): Promise<Resultat> => {
    if (verrou.current) return { ok: false };
    verrou.current = true;
    setAction(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText) : (r.error ?? "Échec.") });
      rafraichir();
      return r;
    } finally {
      setAction(null);
      verrou.current = false;
    }
  };

  const ouvrir = (id: string) => {
    setOuverte(id);
    // L'ONGLET ET LA FICHE SE MÉMORISENT PAR L'URL : un rafraîchissement, un lien partagé les rouvrent.
    try { window.history.replaceState(null, "", `/demandes?onglet=adpro&fiche=${id}`); } catch { /* navigation sans historique */ }
  };

  const groupes = data.groupes
    .map((g) => ({ ...g, lignes: g.lignes.filter((l) => (filtre === "TOUT" || filtre === l.nature) && dansTuile(l, tuile)) }))
    .filter((g) => g.lignes.length > 0);
  const fiche = toutes.find((l) => l.demandeId === ouverte) ?? null;
  const montrerFiches = filtre !== "BC_DEVIS";
  const montrerTravaux = filtre === "TOUT" || filtre === "BC_DEVIS";

  const tuiles: { cle: Tuile | "BC" | "DEVIS"; n: number; libelle: string }[] = [
    { cle: "A_PRENDRE", n: data.tuiles.aPrendre, libelle: "À prendre" },
    { cle: "EN_COURS", n: data.tuiles.enCours, libelle: "En cours" },
    { cle: "RELANCEES", n: data.tuiles.relancees, libelle: "Relancées" },
    { cle: "BC", n: data.tuiles.bc, libelle: "BC de poste à établir" },
    { cle: "DEVIS", n: data.tuiles.devis, libelle: "Devis à retranscrire" },
  ];

  return (
    <div className="space-y-4">
      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`} role="status">
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
        </p>
      )}

      {/* LES TUILES — un clic filtre la file ; « BC » et « devis » ouvrent leur liste. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {tuiles.map((t) => {
          const active = t.cle === "BC" || t.cle === "DEVIS" ? filtre === "BC_DEVIS" : tuile === t.cle;
          return (
            <button
              key={t.libelle} type="button" aria-pressed={active}
              onClick={() => {
                if (t.cle === "BC" || t.cle === "DEVIS") { setFiltre((f) => (f === "BC_DEVIS" ? "TOUT" : "BC_DEVIS")); setTuile(null); }
                else { setTuile((x) => (x === t.cle ? null : (t.cle as Tuile))); if (filtre === "BC_DEVIS") setFiltre("TOUT"); }
              }}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/40"}`}
            >
              <span className="block text-2xl font-semibold tabular-nums">{t.n}</span>
              <span className="block text-xs text-muted-foreground">{t.libelle}</span>
            </button>
          );
        })}
      </div>

      <div role="radiogroup" aria-label="Filtrer" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-secondary p-0.5">
        {([["TOUT", "Tout"], ["BILLET", "Billets"], ["HOTEL", "Hôtels"], ["BC_DEVIS", "BC & devis"]] as const).map(([v, l]) => (
          <button
            key={v} type="button" role="radio" aria-checked={filtre === v} onClick={() => setFiltre(v)}
            className={`min-h-9 rounded-md px-3 text-xs font-medium ${filtre === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {montrerFiches && (
            groupes.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Aucune fiche de voyage {tuile ? "dans ce filtre" : "envoyée pour l'instant"}.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-[900px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-secondary/40 text-left text-xs text-muted-foreground [&>th]:border-l [&>th]:border-border [&>th:first-child]:border-l-0">
                      <th className="px-3 py-2 font-medium">Personne</th>
                      <th className="px-3 py-2 font-medium">Nature</th>
                      <th className="px-3 py-2 font-medium">Trajet / séjour</th>
                      <th className="px-3 py-2 font-medium">Dates</th>
                      <th className="px-3 py-2 font-medium">Demandeur</th>
                      <th className="px-3 py-2 font-medium">Envoyée</th>
                      <th className="px-3 py-2 font-medium">État</th>
                      <th className="px-3 py-2 font-medium">Geste</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupes.map((g) => (
                      <React.Fragment key={g.cle}>
                        <tr className="border-t border-border bg-secondary/20">
                          <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold text-foreground [overflow-wrap:anywhere]">{g.titre}</td>
                        </tr>
                        {g.lignes.map((l) => (
                          <tr
                            key={l.demandeId} tabIndex={0} aria-selected={ouverte === l.demandeId}
                            onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) ouvrir(l.demandeId); }}
                            onKeyDown={(e) => { if (e.key === "Enter") ouvrir(l.demandeId); }}
                            className={`cursor-pointer border-t border-border align-top hover:bg-secondary/30 [&>td]:border-l [&>td]:border-border [&>td:first-child]:border-l-0 ${ouverte === l.demandeId ? "bg-primary/5" : ""}`}
                          >
                            <td className="px-3 py-2 font-medium [overflow-wrap:anywhere]">{l.personne}</td>
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center gap-1 text-xs">
                                {l.nature === "BILLET" ? <Plane className="h-3.5 w-3.5" /> : <BedDouble className="h-3.5 w-3.5" />}{NATURE_LIBELLE[l.nature]}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs [overflow-wrap:anywhere]">{l.resume}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs">{l.dates === "à préciser" ? <span className="text-warning">à préciser</span> : l.dates}</td>
                            <td className="px-3 py-2 text-xs">{l.demandeur}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs">
                              {l.etat === "RESERVEE" ? "—" : l.depuis}
                              {l.relances > 0 && <span className="text-warning"> · {l.relances} relance{l.relances > 1 ? "s" : ""}</span>}
                            </td>
                            <td className="px-3 py-2"><Badge tone={l.ton} dot={false}>{l.libelle}</Badge></td>
                            <td className="px-3 py-2"><GesteLigne l={l} busy={busy} run={run} onOuvrir={() => ouvrir(l.demandeId)} /></td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {montrerTravaux && <Travaux travaux={data.travaux} />}
        </div>

        <aside className="min-w-0">
          {fiche ? (
            <PanneauFiche key={fiche.demandeId} l={fiche} fil={fiche.sujet ? data.fils[fiche.sujet.id] ?? [] : []} busy={busy} run={run} />
          ) : (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Cliquez sur une ligne pour ouvrir la fiche : ses gestes, ses pièces et son fil.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

type Run = (key: string, fn: () => Promise<Resultat>, okText: string) => Promise<Resultat>;

/** LE GESTE DE LA LIGNE — le prochain : prendre, déposer, ou rien (la fiche est chez le demandeur). */
function GesteLigne({ l, busy, run, onOuvrir }: { l: LigneFiche; busy: string | null; run: Run; onOuvrir: () => void }) {
  if (l.etat === "ENVOYEE") {
    return (
      <Button size="sm" disabled={busy !== null} onClick={() => void run(`prendre:${l.demandeId}`, () => prendreFiche(fd({ id: l.demandeId })), "Fiche prise.")}>
        {busy === `prendre:${l.demandeId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />} Prendre
      </Button>
    );
  }
  if (l.etat === "PRISE" || l.etat === "DEVIS_RECU") {
    return <Button size="sm" variant="outline" disabled={busy !== null} onClick={onOuvrir}>{l.nature === "BILLET" ? "Déposer le billet" : "Déposer la confirmation"}</Button>;
  }
  if (l.etat === "RESERVEE") return <span className="text-xs text-muted-foreground">{l.nature === "BILLET" ? "billet joint" : "confirmation jointe"}</span>;
  if (l.etat === "MODIFIEE_APRES_ENVOI") return <span className="text-xs text-destructive">à renvoyer par le demandeur</span>;
  return <span className="text-xs text-muted-foreground">chez le demandeur</span>;
}

/** LES BC DE POSTE À ÉTABLIR ET LES DEVIS À RETRANSCRIRE — lus dans leurs files existantes ; on s'y rend d'un clic. */
function Travaux({ travaux }: { travaux: TravailAdPro[] }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">BC de poste et devis</h3>
      {travaux.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">Aucun BC de poste à établir, aucun devis à retranscrire.</p>
      ) : (
        <ul className="divide-y divide-border">
          {travaux.map((t) => (
            <li key={`${t.type}:${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <Badge tone={t.type === "BC" ? "purple" : "info"} dot={false}>{t.type === "BC" ? "BC de poste" : "Devis"}</Badge>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="font-medium">{t.titre}</span>
                <span className="block text-xs text-muted-foreground">{t.sousTitre}{t.depuis ? ` · depuis ${t.depuis}` : ""}</span>
              </span>
              <span className="text-xs text-muted-foreground">{t.statut}</span>
              <Link href={t.href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Ouvrir <ExternalLink className="h-3 w-3" /></Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** LE PANNEAU DE LA FICHE — gestes, détails, ce qui a changé, pièces, fil. */
function PanneauFiche({ l, fil, busy, run }: { l: LigneFiche; fil: BureauAdProData["fils"][string]; busy: string | null; run: Run }) {
  const [geste, setGeste] = React.useState<"DEPOSER" | "DEVIS" | "MANQUE" | null>(null);
  const [motif, setMotif] = React.useState("");
  const [message, setMessage] = React.useState("");
  const chezMoi = l.etat === "ENVOYEE" || l.etat === "PRISE" || l.etat === "DEVIS_RECU";
  const peutDeposer = (chezMoi || l.etat === "RESERVEE") && l.accorde;
  const k = (g: string) => `${g}:${l.demandeId}`;
  const billet = l.nature === "BILLET";

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-3 xl:sticky xl:top-4">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">Fiche ouverte</p>
        <h3 className="text-base font-semibold [overflow-wrap:anywhere]">{l.personne} · {NATURE_LIBELLE[l.nature].toLowerCase()}</h3>
        <Badge tone={l.ton} dot={false}>{l.libelle}</Badge>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {l.etat === "ENVOYEE" && (
          <Button size="sm" disabled={busy !== null} onClick={() => void run(k("prendre"), () => prendreFiche(fd({ id: l.demandeId })), "Fiche prise.")}>
            {busy === k("prendre") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />} Prendre
          </Button>
        )}
        {(chezMoi || l.etat === "RESERVEE") && (
          <Button size="sm" variant={geste === "DEPOSER" ? "primary" : "outline"} disabled={busy !== null || !l.accorde} title={l.accorde ? undefined : REFUS_AVANT_ACCORD} onClick={() => setGeste((g) => (g === "DEPOSER" ? null : "DEPOSER"))}>
            <Upload className="h-3.5 w-3.5" /> {billet ? "Déposer le billet" : "Déposer la confirmation"}
          </Button>
        )}
        {chezMoi && (
          <Button size="sm" variant={geste === "DEVIS" ? "primary" : "outline"} disabled={busy !== null} onClick={() => setGeste((g) => (g === "DEVIS" ? null : "DEVIS"))}>
            <FileText className="h-3.5 w-3.5" /> Joindre le devis de l&apos;agence
          </Button>
        )}
        {(chezMoi || l.etat === "MODIFIEE_APRES_ENVOI") && (
          <Button size="sm" variant={geste === "MANQUE" ? "primary" : "ghost"} disabled={busy !== null} onClick={() => setGeste((g) => (g === "MANQUE" ? null : "MANQUE"))}>
            <AlertTriangle className="h-3.5 w-3.5" /> Signaler un manque
          </Button>
        )}
      </div>
      {!l.accorde && (chezMoi || l.etat === "MODIFIEE_APRES_ENVOI") && <p className="text-xs text-warning">{REFUS_AVANT_ACCORD}</p>}

      {geste === "DEPOSER" && peutDeposer && (
        <form
          className="space-y-2 rounded-lg border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            f.set("id", l.demandeId);
            void run(k("deposer"), () => deposerBillet(f), billet ? "Billet déposé." : "Confirmation déposée.").then((r) => { if (r.ok) setGeste(null); });
          }}
        >
          <label className="block text-xs">
            {billet ? "E-billet(s) — aller, retour… (PDF ou scan)" : "Voucher / confirmation de l'hôtel (PDF ou scan)"}
            <input name="pieces" type="file" multiple required className={CHAMP} />
          </label>
          <label className="block text-xs">
            {billet ? "Référence (PNR)" : "N° de confirmation"}
            <input name="reference" maxLength={60} className={CHAMP} />
          </label>
          <Button size="sm" type="submit" disabled={busy !== null}>{busy === k("deposer") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Déposer</Button>
        </form>
      )}
      {geste === "DEVIS" && chezMoi && (
        <form
          className="space-y-2 rounded-lg border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            f.set("id", l.demandeId);
            void run(k("devis"), () => joindreDevisAgence(f), "Devis joint.").then((r) => { if (r.ok) setGeste(null); });
          }}
        >
          <p className="text-[0.6875rem] text-muted-foreground">
            Le devis suit le circuit devis du poste : {l.source === "CARE_CELL" ? "il rejoint les devis de la prise en charge, le demandeur le retient." : "il part au demandeur par la demande de pièce du poste ; accepté, il rejoint le poste."}
          </p>
          <label className="block text-xs">Fichier du devis<input name="attachment" type="file" required className={CHAMP} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">Agence<input name="fournisseur" required={l.source === "CARE_CELL"} className={CHAMP} /></label>
            <label className="block text-xs">Montant (DZD)<input name="montant" type="number" min="0" step="0.01" inputMode="decimal" required={l.source === "CARE_CELL"} className={CHAMP} /></label>
          </div>
          <Button size="sm" type="submit" disabled={busy !== null}>{busy === k("devis") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Joindre</Button>
        </form>
      )}
      {geste === "MANQUE" && (
        <form
          className="space-y-2 rounded-lg border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(k("manque"), () => signalerManque(fd({ id: l.demandeId, motif })), "Manque signalé.").then((r) => { if (r.ok) { setGeste(null); setMotif(""); } });
          }}
        >
          <label className="block text-xs" htmlFor={`manque-${l.demandeId}`}>Ce qui manque (le demandeur le lira)</label>
          <textarea id={`manque-${l.demandeId}`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} className={CHAMP} placeholder="Il me faut les dates de chaque étape pour demander le devis." />
          <Button size="sm" type="submit" disabled={busy !== null || motif.trim() === ""}>{busy === k("manque") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Renvoyer au demandeur</Button>
        </form>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Opération · poste</dt>
        <dd className="[overflow-wrap:anywhere]"><Link href={l.operation.chemin} className="text-primary hover:underline">{l.operation.ref}</Link> · {l.poste}</dd>
        <dt className="text-muted-foreground">Demandeur</dt><dd>{l.demandeur}</dd>
        <dt className="text-muted-foreground">{billet ? "Trajet" : "Séjour"}</dt><dd className="[overflow-wrap:anywhere]">{l.resume}</dd>
        <dt className="text-muted-foreground">Dates</dt><dd>{l.dates === "à préciser" ? <span className="text-warning">à préciser par le demandeur</span> : l.dates}</dd>
        <dt className="text-muted-foreground">Envoyée</dt>
        <dd>{jour(l.envoyeeLe)}{l.relances > 0 ? ` · relancée ${l.relances} fois${l.derniereRelanceLe ? ` (dernière le ${jour(l.derniereRelanceLe)})` : ""}` : ""}</dd>
        {l.priseParNom && <><dt className="text-muted-foreground">Prise par</dt><dd>{l.priseParNom}</dd></>}
        {l.budget != null && <><dt className="text-muted-foreground">Budget</dt><dd>{l.budget.toLocaleString("fr-FR")} DZD accordés au poste</dd></>}
        {l.reference && <><dt className="text-muted-foreground">Référence</dt><dd>{l.reference}</dd></>}
        {l.manqueMotif && l.etat === "MANQUE_SIGNALE" && <><dt className="text-muted-foreground">Manque signalé</dt><dd>{l.manqueMotif}</dd></>}
      </dl>

      {l.changements.length > 0 && (
        <div className="rounded-lg bg-destructive/5 p-2 text-xs">
          <p className="mb-1 font-medium text-destructive">Modifiée après l&apos;envoi — ce qui a changé :</p>
          <ul className="space-y-0.5">
            {l.changements.map((c) => <li key={c.champ}><span className="font-medium">{c.champ}</span> : <s>{c.avant}</s> → {c.apres}</li>)}
          </ul>
        </div>
      )}

      <div className="space-y-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pièces de la fiche</h4>
        {l.pieces.length === 0 ? <p className="text-xs text-muted-foreground">Aucune pièce jointe.</p> : (
          <ul className="space-y-1">
            {l.pieces.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">{p.role}</span>
                <DocumentPreview id={p.id} name={p.name} hasFile={p.hasFile} />
              </li>
            ))}
          </ul>
        )}
        {l.etat !== "RESERVEE" && (
          <p className="text-[0.6875rem] text-muted-foreground">
            {billet ? "Billet" : "Confirmation"} : pas encore déposé{billet ? "" : "e"}. {billet ? "Il" : "Elle"} s&apos;attachera à cette fiche et le demandeur {billet ? "le" : "la"} verra sur son poste.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <h4 className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Fil de la fiche
          {l.sujet && <Link href={`/dossiers/${l.sujet.id}`} className="font-normal normal-case text-primary hover:underline">sujet {l.sujet.reference}</Link>}
        </h4>
        {fil.length === 0 ? <p className="text-xs text-muted-foreground">Rien d&apos;écrit pour l&apos;instant.</p> : (
          <ol className="max-h-72 space-y-1.5 overflow-y-auto">
            {fil.map((m) => (
              <li key={m.id} className="rounded-lg bg-secondary/40 px-2 py-1.5 text-xs">
                <span className="font-medium">{m.auteur}</span> <span className="text-muted-foreground">{dateHeure(m.le)}</span>
                <p className="whitespace-pre-line [overflow-wrap:anywhere]">{m.body}</p>
              </li>
            ))}
          </ol>
        )}
        {l.sujet && (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const body = `${NATURE_LIBELLE[l.nature]} · ${l.personne} — ${message}`;
              void run(k("fil"), () => postDossierMessage(fd({ id: l.sujet!.id, body })), "Message envoyé.").then((r) => { if (r.ok) setMessage(""); });
            }}
          >
            <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Écrire au demandeur…" aria-label="Message dans le fil" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs" />
            <Button size="sm" type="submit" disabled={busy !== null || message.trim() === ""}>Envoyer</Button>
          </form>
        )}
      </div>
    </section>
  );
}
