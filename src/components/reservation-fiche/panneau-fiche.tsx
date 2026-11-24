"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, Loader2, Hand, Upload, FileText, AlertTriangle, Send, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { DocumentPreview } from "@/components/documents/document-preview";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { prendreFiche, signalerManque, deposerBillet, joindreDevisAgence } from "@/lib/actions/reservation-fiche-actions";
import { postDossierMessage } from "@/lib/actions/dossier-actions";
import { NATURE_LIBELLE, REFUS_AVANT_ACCORD } from "@/lib/reservation-fiche/etat";
import { LIBELLE_ETAT_BUREAU } from "@/lib/secretariat/ligne-bureau";
import { etatFicheVoyage } from "@/lib/secretariat/etat-unifie";
import type { LigneFiche, MessageFil } from "@/lib/queries/reservations-fiches";

type Resultat = { ok: boolean; error?: string; message?: string };
type Run = (key: string, fn: () => Promise<Resultat>, okText: string) => Promise<Resultat>;

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const dateHeure = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });
const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Africa/Algiers" });
const CHAMP = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

/**
 * LA FICHE D'UN BILLET OU D'UN HÔTEL, EN PLEINE PAGE (`/demandes/fiches/<id>`, 24/11/2026) — ce qui était le panneau de
 * l'ancien onglet « Ad & Pro » du bureau. En tête : le type, l'objet, l'état, chez qui, et UN bouton selon l'état
 * (« Prendre la demande », puis « Déposer le billet / la confirmation ») ; le reste replié ; la DISCUSSION de la fiche
 * (messages et fichiers) toujours en bas. Les gestes sont ceux de `reservation-fiche-actions`, leurs refus affichés tels
 * quels ; `gere` (l'assistante, le Super Admin — la règle des actions) les montre, le demandeur lit sa fiche et écrit au fil.
 */
export function PanneauFiche({ l, freres, fil, gere }: { l: LigneFiche; freres: LigneFiche[]; fil: MessageFil[]; gere: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [action, setAction] = React.useState<string | null>(null);
  const busy = action ?? (enCours ? "rafraichir" : null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const verrou = React.useRef(false);
  const [geste, setGeste] = React.useState<"DEPOSER" | "DEVIS" | "MANQUE" | null>(null);
  const [motif, setMotif] = React.useState("");

  const run: Run = async (key, fn, okText) => {
    if (verrou.current) return { ok: false };
    verrou.current = true;
    setAction(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText) : (r.error ?? "La fiche n'a pas été mise à jour.") });
      rafraichir();
      return r;
    } catch {
      const error = actionFailureMessage("THROWN");
      setMsg({ ok: false, text: error });
      return { ok: false, error };
    } finally {
      setAction(null);
      verrou.current = false;
    }
  };

  const chezMoi = l.etat === "ENVOYEE" || l.etat === "PRISE" || l.etat === "DEVIS_RECU";
  const peutDeposer = gere && (chezMoi || l.etat === "RESERVEE") && l.accorde;
  const k = (g: string) => `${g}:${l.demandeId}`;
  const billet = l.nature === "BILLET";
  const etat = etatFicheVoyage(l.etat);
  const chezQui = etat === "A_PRENDRE" ? "Assistante de direction — à prendre"
    : etat === "EN_COURS" ? `Assistante${l.priseParNom ? ` — ${l.priseParNom}` : ""}`
      : etat === "CHEZ_LE_DEMANDEUR" ? `${l.demandeur} — ${l.etat === "MANQUE_SIGNALE" ? "manque signalé" : "modifiée après l'envoi, à renvoyer"}`
        : null;

  return (
    <div className="space-y-4">
      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`} role="status">
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
        </p>
      )}

      {/* ─────────── En tête : type, objet, état, chez qui, UN bouton ─────────── */}
      <section className="surface grid gap-4 rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{NATURE_LIBELLE[l.nature]} — {l.personne}</h1>
            <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              <Link href={l.operation.chemin} className="text-primary hover:underline">{l.operation.ref}</Link> · {l.poste} · demandé par {l.demandeur}
            </p>
            <p className="mt-1 text-sm">
              <span className="font-semibold">{LIBELLE_ETAT_BUREAU[etat]}</span>
              {chezQui && <span className="text-muted-foreground"> · chez {chezQui}</span>}
            </p>
          </div>
          {gere && l.etat === "ENVOYEE" && (
            <BoutonDecisif disabled={busy !== null} onClick={() => void run(k("prendre"), () => prendreFiche(fd({ id: l.demandeId })), "Fiche prise.")}>
              {busy === k("prendre") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hand className="h-4 w-4" />} Prendre la demande
            </BoutonDecisif>
          )}
          {gere && (l.etat === "PRISE" || l.etat === "DEVIS_RECU") && (
            <Button disabled={busy !== null || !l.accorde} title={l.accorde ? undefined : REFUS_AVANT_ACCORD} onClick={() => setGeste((g) => (g === "DEPOSER" ? null : "DEPOSER"))}>
              <Upload className="h-4 w-4" /> {billet ? "Déposer le billet" : "Déposer la confirmation"}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Carte titre={billet ? "Trajet" : "Séjour"} valeur={l.resume} />
          <Carte titre="Dates" valeur={l.dates === "à préciser" ? "À préciser par le demandeur" : l.dates} alerte={l.dates === "à préciser"} />
          <Carte
            titre="État" valeur={l.libelle}
            detail={`Envoyée le ${jour(l.envoyeeLe)}${l.relances > 0 ? ` · relancée ${l.relances} fois` : ""}`}
          />
        </div>
        {gere && !l.accorde && (chezMoi || l.etat === "MODIFIEE_APRES_ENVOI") && <p className="text-xs text-warning">{REFUS_AVANT_ACCORD}</p>}

        {geste === "DEPOSER" && peutDeposer && (
          <form
            className="space-y-2 rounded-lg border border-border p-3"
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

        {/* ─────────── Le reste, replié ─────────── */}
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-semibold">
            {gere ? "Joindre le devis de l'agence · Signaler un manque · " : ""}Détails · Pièces ({l.pieces.length})
          </summary>
          <div className="mt-3 space-y-4">
            {gere && (
              <div className="flex flex-wrap gap-1.5">
                {l.etat === "RESERVEE" && (
                  <Button size="sm" variant={geste === "DEPOSER" ? "primary" : "outline"} disabled={busy !== null || !l.accorde} onClick={() => setGeste((g) => (g === "DEPOSER" ? null : "DEPOSER"))}>
                    <Upload className="h-3.5 w-3.5" /> {billet ? "Remplacer le billet" : "Remplacer la confirmation"}
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
            )}

            {gere && geste === "DEVIS" && chezMoi && (
              <form
                className="space-y-2 rounded-lg border border-border p-3"
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
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                  <label className="block text-xs">Agence<input name="fournisseur" required={l.source === "CARE_CELL"} className={CHAMP} /></label>
                  <label className="block text-xs">{freres.length > 0 ? "Montant total" : "Montant"}<input name="montant" type="number" min="0" step="0.01" inputMode="decimal" required={l.source === "CARE_CELL"} className={CHAMP} /></label>
                  {/* La devise DITE : un montant en DZD reste en DZD ; en USD, il est converti une fois (1 USD = 240 DZD). */}
                  <label className="block text-xs">Devise
                    <select name="devise" defaultValue="DZD" className={CHAMP}>
                      <option value="DZD">DZD</option>
                      <option value="USD">USD</option>
                    </select>
                  </label>
                </div>
                {/* UN DEVIS POUR PLUSIEURS VOYAGEURS (recette du 23/11/2026) : les fiches cochées partagent la même pièce. */}
                {l.source !== "CARE_CELL" && freres.length > 0 && (
                  <fieldset className="space-y-1 text-xs">
                    <legend className="font-medium">Ce devis couvre aussi :</legend>
                    {freres.map((x) => (
                      <label key={x.demandeId} className="flex min-h-9 items-center gap-2 sm:min-h-0">
                        <input type="checkbox" name="aussi" value={x.demandeId} className="shrink-0 max-sm:h-5 max-sm:w-5" />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{x.personne} · {NATURE_LIBELLE[x.nature].toLowerCase()}</span>
                      </label>
                    ))}
                    <p className="text-[0.6875rem] text-muted-foreground">Les fiches cochées partagent ce devis : une seule pièce sur le poste, et le montant saisi est le total du devis.</p>
                  </fieldset>
                )}
                <Button size="sm" type="submit" disabled={busy !== null}>{busy === k("devis") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Joindre</Button>
              </form>
            )}
            {gere && geste === "MANQUE" && (
              <form
                className="space-y-2 rounded-lg border border-border p-3"
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

            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Personne · nature</dt><dd className="[overflow-wrap:anywhere]">{l.personne} · {NATURE_LIBELLE[l.nature].toLowerCase()}</dd>
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
              <div className="rounded-lg bg-destructive/5 p-3 text-xs">
                <p className="mb-1 font-medium text-destructive">Modifiée après l&apos;envoi — ce qui a changé :</p>
                <ul className="space-y-0.5">
                  {l.changements.map((c) => <li key={c.champ}><span className="font-medium">{c.champ}</span> : <s>{c.avant}</s> → {c.apres}</li>)}
                </ul>
              </div>
            )}

            <div className="space-y-1.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pièces de la fiche</h2>
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
          </div>
        </details>
      </section>

      <DiscussionFiche l={l} fil={fil} busy={busy} run={run} />
    </div>
  );
}

function Carte({ titre, valeur, detail, alerte }: { titre: string; valeur: string; detail?: string; alerte?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{titre}</p>
      <p className={`mt-1 text-base font-bold [overflow-wrap:anywhere] ${alerte ? "text-warning" : ""}`}>{valeur}</p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** LA DISCUSSION DE LA FICHE — le fil du sujet (DOS) du poste ou de la prise en charge : messages et fichiers. */
function DiscussionFiche({ l, fil, busy, run }: { l: LigneFiche; fil: MessageFil[]; busy: string | null; run: Run }) {
  const [message, setMessage] = React.useState("");
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const k = `fil:${l.demandeId}`;
  return (
    <section className="surface rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Discussion <span className="font-normal text-muted-foreground">({fil.length})</span></h2>
        {l.sujet && <Link href={`/dossiers/${l.sujet.id}`} className="text-xs text-primary hover:underline">sujet {l.sujet.reference}</Link>}
      </header>
      <div className="space-y-3 p-4">
        {fil.length === 0 ? <p className="text-sm text-muted-foreground">Rien d&apos;écrit pour l&apos;instant.</p> : (
          <ol className="space-y-2">
            {fil.map((m) => (
              <li key={m.id} className="rounded-lg bg-secondary/40 px-3 py-2 text-sm">
                <span className="font-medium">{m.auteur}</span> <span className="text-xs text-muted-foreground">{dateHeure(m.le)}</span>
                {m.body && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{m.body}</p>}
                {m.fichiers.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                    {m.fichiers.map((f) => (
                      <li key={f.id}>
                        <a href={`/api/dossiers/message-attachment/${f.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                          <Paperclip className="h-3 w-3" />{f.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        {l.sujet ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData();
              f.set("id", l.sujet!.id);
              f.set("body", message.trim() ? `${NATURE_LIBELLE[l.nature]} · ${l.personne} — ${message.trim()}` : "");
              for (const x of fichiers) f.append("files", x);
              void run(k, () => postDossierMessage(f), "Message envoyé.").then((r) => {
                if (r.ok) { setMessage(""); setFichiers([]); if (inputRef.current) inputRef.current.value = ""; }
              });
            }}
          >
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Écrire dans la discussion de la fiche…" aria-label="Message" className={CHAMP} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                {fichiers.length > 0 ? `${fichiers.length} fichier${fichiers.length > 1 ? "s" : ""} joint${fichiers.length > 1 ? "s" : ""}` : "Joindre des fichiers"}
                <input ref={inputRef} type="file" multiple className="sr-only" onChange={(e) => setFichiers([...(e.target.files ?? [])])} />
              </label>
              <Button size="sm" type="submit" disabled={busy !== null || (message.trim() === "" && fichiers.length === 0)}>
                {busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Envoyer
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">La discussion s&apos;ouvre au premier envoi de la fiche.</p>
        )}
      </div>
    </section>
  );
}
