"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { lireConsommationIa } from "@/modules/assistant-ia/actions-consommation";
import {
  intervallesResumes, jetonsDe, jourAlger, type AppelDetaille, type LigneVentilee, type Perimetre, type Totaux, type VueConsommation,
} from "@/modules/assistant-ia/partage";
import { dollarsArrondis, dollarsExacts } from "@/platform/ia/telemetry/tarifs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DE LA CONSOMMATION IA — jetons et dollars, au micro-dollar (lot K8, décision 0035).
 *
 * UN composant, DEUX écrans : les Réglages d'Adventum IA (jetons `--aia-*`) et Administration › IA de l'ERP
 * (jetons du thème). Les couleurs lisent les variables de l'app d'abord, celles de l'ERP en repli.
 *
 * Mobile d'abord (iPhone) : aucune table large — des listes qui se replient ; la seule zone qui défile en
 * largeur est le graphique, dans son propre cadre. Aucune donnée simulée : tout vient du journal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const C = {
  texte: "text-[color:var(--aia-texte,hsl(var(--foreground)))]",
  discret: "text-[color:var(--aia-discret,hsl(var(--muted-foreground)))]",
  filet: "border-[color:var(--aia-filet,hsl(var(--border)))]",
  carte: "rounded-xl border border-[color:var(--aia-filet,hsl(var(--border)))] bg-[color:var(--aia-fond-carte,transparent)]",
  accent: "var(--aia-accent,hsl(var(--primary)))",
  bouton: "inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--aia-filet,hsl(var(--border)))] px-2.5 py-1.5 text-[12.5px] hover:bg-[color:var(--aia-survol,hsl(var(--muted)))]",
};

const nf = (v: number) => v.toLocaleString("fr-FR").replace(/ | /g, " ");
const duree = (ms: number) => (ms >= 60_000 ? `${nf(Math.round(ms / 600) / 100)} min` : `${nf(Math.round(ms / 100) / 10)} s`);

function Montant({ usd, sansTarif = 0, fort = false, partiel = false }: { usd: string | null; sansTarif?: number; fort?: boolean; partiel?: boolean }) {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={`tabular-nums ${fort ? "text-[15px] font-semibold" : ""}`} title="Coût exact, au micro-dollar">{dollarsExacts(usd)}</span>
      <span className={`text-[11px] ${C.discret}`}>
        {usd == null ? "" : dollarsArrondis(usd)}{sansTarif > 0 ? ` · + ${sansTarif} appel(s) au tarif inconnu` : ""}{partiel ? " · + une part au tarif inconnu" : ""}
      </span>
    </span>
  );
}

/** Les jetons d'un total, ventilés — seulement les types consommés. */
function Ventilation({ t }: { t: Totaux }) {
  const texteIn = t.entree - t.audioEntree - t.imageEntree;
  const morceaux: [string, number][] = [
    ["entrée texte", texteIn - (t.entreeCache - t.audioEntreeCache - t.imageEntreeCache)],
    ["entrée en cache", t.entreeCache],
    ["sortie texte", t.sortie - t.audioSortie - t.imageSortie],
    ["dont raisonnement", t.raisonnement],
    ["audio entrée", t.audioEntree], ["audio sortie", t.audioSortie],
    ["image entrée", t.imageEntree], ["image sortie", t.imageSortie],
    ["recherches web", t.recherchesWeb], ["pages OCR", t.pages],
  ];
  const vus = morceaux.filter(([, v]) => v > 0);
  return (
    <p className={`text-[11.5px] ${C.discret}`}>
      {vus.map(([k, v]) => `${k} ${nf(v)}`).join(" · ")}
      {t.dureeMs > 0 ? `${vus.length ? " · " : ""}durée facturée ${duree(t.dureeMs)}` : ""}
      {t.estimes > 0 ? ` · ${t.estimes} appel(s) aux jetons estimés` : ""}
    </p>
  );
}

function Liste({ titre, lignes, vide }: { titre: string; lignes: LigneVentilee[]; vide: string }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={titre}>
      <h4 className="text-[13px] font-semibold">{titre}</h4>
      {lignes.length === 0 ? <p className={`text-[12.5px] ${C.discret}`}>{vide}</p> : lignes.map((l) => (
        <div key={l.cle} className={`flex items-start gap-2 border-b ${C.filet} py-1.5 last:border-b-0`}>
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] font-medium">{l.libelle}</p>
            {l.detail && <p className={`text-[11px] ${C.discret}`}>{l.detail}</p>}
            <p className={`text-[11.5px] ${C.discret}`}>{nf(jetonsDe(l))} jetons · {nf(l.appels)} appel(s)</p>
            <Ventilation t={l} />
          </div>
          <Montant usd={l.sansTarif === l.appels ? null : l.coutUsd} sansTarif={l.sansTarif === l.appels ? 0 : l.sansTarif} />
        </div>
      ))}
    </section>
  );
}

/** Le graphique jour par jour : une série (le coût), une barre par jour, l'info-bulle au survol, la table à côté. */
function Graphique({ jours }: { jours: VueConsommation["parJour"] }) {
  const [survol, setSurvol] = useState<number | null>(null);
  if (!jours.length) return <p className={`text-[12.5px] ${C.discret}`}>Aucun appel sur la période.</p>;
  const max = Math.max(...jours.map((j) => Number(j.coutUsd)), 1e-9);
  const L = 14, G = 2, H = 96;
  const largeur = jours.length * (L + G);
  const j = survol != null ? jours[survol] : jours[jours.length - 1];
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[12px]" aria-live="polite">
        <span className="font-medium">{j.jour}</span> — {dollarsExacts(j.coutUsd)} · {nf(j.jetons)} jetons · {nf(j.appels)} appel(s)
      </p>
      <div className="max-w-full overflow-x-auto">
        <svg width={largeur} height={H + 2} role="img" aria-label="Coût par jour sur la période" className="block">
          <line x1={0} x2={largeur} y1={H} y2={H} stroke="currentColor" strokeOpacity={0.15} />
          {jours.map((d, i) => {
            const h = Math.max(Number(d.coutUsd) > 0 ? 2 : 0, (Number(d.coutUsd) / max) * (H - 4));
            return (
              <g key={d.jour} onMouseEnter={() => setSurvol(i)} onFocus={() => setSurvol(i)} onClick={() => setSurvol(i)} tabIndex={0}>
                <rect x={i * (L + G)} y={0} width={L + G} height={H} fill="transparent" />
                <path
                  d={`M${i * (L + G)},${H} V${H - h + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, L / 2)},-${Math.min(4, h)} H${i * (L + G) + L - Math.min(4, L / 2)} q${Math.min(4, L / 2)},0 ${Math.min(4, L / 2)},${Math.min(4, h)} V${H} Z`}
                  fill={C.accent} fillOpacity={survol === i ? 1 : 0.75}
                >
                  <title>{`${d.jour} : ${dollarsExacts(d.coutUsd)}, ${nf(d.jetons)} jetons, ${nf(d.appels)} appel(s)`}</title>
                </path>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="text-[12px]">
        <summary className={`cursor-pointer ${C.discret}`}>Voir les jours en tableau</summary>
        <ul className="mt-1 flex flex-col">
          {jours.map((d) => (
            <li key={d.jour} className={`flex justify-between gap-2 border-b ${C.filet} py-0.5`}>
              <span>{d.jour}</span><span className="tabular-nums">{dollarsExacts(d.coutUsd)} · {nf(d.jetons)} j.</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Appel({ a, entreprise }: { a: AppelDetaille; entreprise: boolean }) {
  const heure = new Date(a.at).toLocaleString("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const t: Totaux = {
    appels: 1, entree: a.entree, entreeCache: a.entreeCache, sortie: a.sortie, raisonnement: a.raisonnement, audioEntree: a.audioEntree,
    audioEntreeCache: a.audioEntreeCache, audioSortie: a.audioSortie, imageEntree: a.imageEntree, imageEntreeCache: a.imageEntreeCache,
    imageSortie: a.imageSortie, recherchesWeb: a.recherchesWeb, dureeMs: a.dureeFactureeMs, pages: a.pages, coutUsd: a.coutUsd ?? "0", sansTarif: 0, estimes: a.estime ? 1 : 0,
  };
  return (
    <li className={`flex items-start gap-2 border-b ${C.filet} py-1.5`}>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px]"><span className="tabular-nums">{heure}</span> · <span className="font-medium break-all">{a.modele}</span></p>
        <p className={`text-[11.5px] ${C.discret} break-words`}>
          {a.usage}{entreprise && a.personne ? ` · ${a.personne}` : ""}{a.conversation ? ` · ${a.conversation}` : ""} · {duree(a.ms)}{a.lot ? " · API Batch" : ""}
        </p>
        <Ventilation t={t} />
      </div>
      <Montant usd={a.coutUsd} />
    </li>
  );
}

export function TableauConsommation({ superAdmin, perimetreInitial = "moi" }: { superAdmin: boolean; perimetreInitial?: Perimetre }) {
  const [perimetre, setPerimetre] = useState<Perimetre>(superAdmin ? perimetreInitial : "moi");
  const maintenant = new Date();
  const mois = intervallesResumes(maintenant).mois;
  const [du, setDu] = useState(jourAlger(mois.debut));
  const [au, setAu] = useState(jourAlger(maintenant));
  const [personne, setPersonne] = useState("");
  const [vue, setVue] = useState<VueConsommation | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [charge, setCharge] = useState(false);

  const lire = useCallback(async () => {
    setCharge(true);
    try {
      const r = await lireConsommationIa({ perimetre, du, au, personne: perimetre === "entreprise" ? personne || null : null });
      if (r.ok) { setVue(r.vue); setErreur(null); } else setErreur(r.erreur);
    } catch {
      setErreur("La consommation n'a pas pu être lue. Réessayez.");
    } finally { setCharge(false); }
  }, [perimetre, du, au, personne]);
  useEffect(() => { void lire(); }, [lire]);

  const preset = (cle: "aujourdhui" | "7j" | "mois" | "moisPrecedent") => {
    const i = intervallesResumes(new Date())[cle];
    setDu(jourAlger(i.debut)); setAu(jourAlger(new Date(i.fin.getTime() - 1)));
  };
  const exporter = (format: "csv" | "xlsx") =>
    `/api/assistant-ia/consommation/export?${new URLSearchParams({ perimetre, du, au, format, ...(perimetre === "entreprise" && personne ? { personne } : {}) })}`;
  const entreprise = perimetre === "entreprise";

  return (
    <div className={`flex min-w-0 flex-col gap-4 ${C.texte}`} data-testid="tableau-consommation">
      <div className="flex flex-wrap items-center gap-2">
        {superAdmin && (
          <div className={`inline-flex rounded-lg border ${C.filet} p-0.5`} role="group" aria-label="Périmètre">
            {(["moi", "entreprise"] as const).map((p) => (
              <button key={p} type="button" aria-pressed={perimetre === p} onClick={() => { setPerimetre(p); setPersonne(""); }}
                className="rounded-md px-2.5 py-1 text-[12.5px] aria-pressed:bg-[color:var(--aia-accent-doux,hsl(var(--muted)))] aria-pressed:font-semibold">
                {p === "moi" ? "Ma consommation" : "Toute l'entreprise"}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => void lire()} className={C.bouton} aria-label="Actualiser">
          <RefreshCw className={`h-3.5 w-3.5 ${charge ? "animate-spin" : ""}`} aria-hidden /> Actualiser
        </button>
      </div>

      {erreur && <p role="alert" className="text-[13px] text-[color:var(--aia-danger,hsl(var(--destructive)))]">{erreur}</p>}

      {vue && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {vue.resumes.map((r) => (
              <button key={r.cle} type="button" onClick={() => preset(r.cle)} className={`${C.carte} flex min-w-0 flex-col items-start gap-0.5 p-2.5 text-left`}>
                <span className={`text-[11.5px] ${C.discret}`}>{r.libelle}</span>
                <span className="text-[14px] font-semibold tabular-nums">{dollarsExacts(r.totaux.sansTarif === r.totaux.appels && r.totaux.appels ? null : r.totaux.coutUsd)}</span>
                <span className={`text-[11px] ${C.discret}`}>{nf(jetonsDe(r.totaux))} jetons · {nf(r.totaux.appels)} appels</span>
                {r.totaux.sansTarif > 0 && r.totaux.sansTarif < r.totaux.appels && <span className={`text-[11px] ${C.discret}`}>+ {nf(r.totaux.sansTarif)} au tarif inconnu</span>}
              </button>
            ))}
          </div>

          <section className={`${C.carte} flex flex-col gap-2 p-3`} aria-label="Période choisie">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-[11.5px]"><span className={C.discret}>Du</span>
                <input type="date" value={du} onChange={(e) => setDu(e.target.value)} className={`rounded-md border ${C.filet} bg-transparent px-2 py-1 text-[13px]`} />
              </label>
              <label className="flex flex-col text-[11.5px]"><span className={C.discret}>Au (inclus)</span>
                <input type="date" value={au} onChange={(e) => setAu(e.target.value)} className={`rounded-md border ${C.filet} bg-transparent px-2 py-1 text-[13px]`} />
              </label>
              {entreprise && vue.parPersonne.length > 0 && (
                <label className="flex min-w-0 flex-col text-[11.5px]"><span className={C.discret}>Personne</span>
                  <select value={personne} onChange={(e) => setPersonne(e.target.value)} className={`max-w-[14rem] rounded-md border ${C.filet} bg-transparent px-2 py-1 text-[13px]`}>
                    <option value="">Toutes</option>
                    {vue.parPersonne.filter((p) => p.cle !== "systeme").map((p) => <option key={p.cle} value={p.cle}>{p.libelle}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">Période {vue.periode.libelle}</p>
                <p className={`text-[11.5px] ${C.discret}`}>{nf(jetonsDe(vue.totaux))} jetons · {nf(vue.totaux.appels)} appels</p>
                <Ventilation t={vue.totaux} />
              </div>
              <Montant usd={vue.totaux.appels && vue.totaux.sansTarif === vue.totaux.appels ? null : vue.totaux.coutUsd} sansTarif={vue.totaux.sansTarif} fort />
            </div>
            <Graphique jours={vue.parJour} />
          </section>

          <section className="flex flex-col gap-1.5" aria-label="Par type de jeton">
            <h4 className="text-[13px] font-semibold">Par type de jeton</h4>
            {vue.postes.length === 0 ? <p className={`text-[12.5px] ${C.discret}`}>Aucun appel sur la période.</p> : vue.postes.map((p) => (
              <div key={p.poste} className={`flex items-start gap-2 border-b ${C.filet} py-1 last:border-b-0`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px]">{p.libelle}</p>
                  <p className={`text-[11.5px] ${C.discret}`}>{p.unite === "ms" ? duree(p.quantite) : `${nf(p.quantite)} ${p.unite}`}</p>
                </div>
                <Montant usd={p.coutUsd} partiel={p.partiel} />
              </div>
            ))}
            <p className={`text-[11px] ${C.discret}`}>
              Postes recalculés à la grille tarifaire du {vue.grilleRelevee} (le raisonnement est facturé comme de la sortie, déjà compris dedans) ;
              le total ci-dessus est la somme exacte du journal, arrondi appel par appel au micro-dollar.
            </p>
          </section>

          <Liste titre="Par usage" lignes={vue.parUsage} vide="Aucun appel sur la période." />
          <Liste titre="Par modèle" lignes={vue.parModele} vide="Aucun appel sur la période." />
          {entreprise && <Liste titre="Par personne" lignes={vue.parPersonne} vide="Aucun appel sur la période." />}
          <Liste titre="Par conversation" lignes={vue.parConversation} vide="Aucun appel rattaché à une conversation sur la période." />

          {vue.plafonds && (
            <section className={`${C.carte} flex flex-col gap-1 p-3 text-[12.5px]`} aria-label="Plafonds en cours">
              <h4 className="text-[13px] font-semibold">Plafonds en cours</h4>
              <p>{vue.plafonds.jetonsJour > 0 ? `${nf(vue.plafonds.jetonsJour)} jetons par personne et par jour` : "Sans plafond par jour"} · {nf(vue.plafonds.jetonsTour)} jetons par tour</p>
              <p>Travaux en arrière-plan : {vue.plafonds.travailUsd ?? 20} $ par travail · {vue.plafonds.mensuelUsd != null ? `${vue.plafonds.mensuelUsd} $` : "défaut"} par personne et par mois</p>
              {vue.plafonds.atteints.map((a) => (
                <p key={`${a.nom}-${a.jour}`} className={C.discret}>{a.jour} — {a.nom} a atteint son plafond : {nf(a.jetons)} jetons (plafond {nf(a.plafond)})</p>
              ))}
            </section>
          )}

          {vue.rapprochement && (
            <section className={`${C.carte} flex flex-col gap-1 p-3 text-[12.5px]`} aria-label="Rapprochement avec la facture">
              <h4 className="text-[13px] font-semibold">Rapprochement avec la facture OpenAI</h4>
              <p className={C.discret}>{vue.rapprochement.message}</p>
              {vue.rapprochement.factureUsd != null && (
                <p className="tabular-nums">
                  Facturé {dollarsExacts(vue.rapprochement.factureUsd)} · journalisé {dollarsExacts(vue.rapprochement.journaliseUsd ?? null)} ·
                  écart {vue.rapprochement.ecartUsd} ${vue.rapprochement.ecartPct != null ? ` (${vue.rapprochement.ecartPct} %)` : ""}
                </p>
              )}
            </section>
          )}

          <section className="flex flex-col gap-1.5" aria-label="Appel par appel">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="flex-1 text-[13px] font-semibold">Appel par appel</h4>
              <a href={exporter("csv")} className={C.bouton} download><Download className="h-3.5 w-3.5" aria-hidden /> CSV</a>
              <a href={exporter("xlsx")} className={C.bouton} download><Download className="h-3.5 w-3.5" aria-hidden /> Excel</a>
            </div>
            {vue.appels.length === 0 ? <p className={`text-[12.5px] ${C.discret}`}>Aucun appel sur la période.</p> : (
              <ul className="flex flex-col">{vue.appels.map((a) => <Appel key={a.id} a={a} entreprise={entreprise} />)}</ul>
            )}
            {vue.appelsTronques && <p className={`text-[11.5px] ${C.discret}`}>Les {vue.appels.length} appels les plus récents sont affichés ; l&apos;export contient toute la période.</p>}
          </section>
        </>
      )}
      {!vue && !erreur && <p className={`text-[12.5px] ${C.discret}`}>Lecture du journal…</p>}
    </div>
  );
}
