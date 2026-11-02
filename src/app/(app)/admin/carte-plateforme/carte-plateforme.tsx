"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowRight, BookOpen, ChevronLeft, ChevronRight, ExternalLink, GitBranch, Info, Map as MapIcon,
  Search, ShieldCheck, Users, Workflow, X,
} from "lucide-react";
import { cn, plier } from "@/lib/utils";
import {
  CIRCUITS, DOMAINES, MECANISMES, MODULES_PLATEFORME, TYPES_ACTEUR, circuitsDuModule, voisinsDuModule,
  type CleDomaine, type ModulePlateforme, type TypeActeur,
} from "@/lib/carte-plateforme/catalogue";
import { AIDE_NIVEAU, LIBELLES_NIVEAU, NIVEAUX, type MatriceAcces, type Niveau } from "@/lib/carte-plateforme/acces";

/**
 * LA CARTE DE LA PLATEFORME — l'écran. Quatre vues :
 *   • Carte : les modules rangés par domaine ; un clic relie le module à ses voisins et ouvre sa fiche ;
 *     un circuit choisi se dessine sur la carte, étape par étape, numéroté.
 *   • Circuits : un fait métier de bout en bout, acteur par acteur, avec une lecture pas à pas.
 *   • Rôles & droits : la matrice réelle (défauts des rôles), lue par le serveur dans `PERMISSIONS`.
 *   • Règles transverses : ce qui vaut partout.
 *
 * Les couleurs sont écrites ICI en classes littérales : Tailwind ne lit pas `src/lib`.
 */

type Vue = "carte" | "circuits" | "roles" | "regles";

interface Teinte {
  carte: string;
  pastille: string;
  texte: string;
  barre: string;
  trait: string;
}

const TEINTES: Record<CleDomaine, Teinte> = {
  pilotage: { carte: "border-sky-200 bg-sky-50/70 dark:border-sky-900/70 dark:bg-sky-950/30", pastille: "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200", texte: "text-sky-700 dark:text-sky-300", barre: "bg-sky-500", trait: "#0ea5e9" },
  regulatory: { carte: "border-violet-200 bg-violet-50/70 dark:border-violet-900/70 dark:bg-violet-950/30", pastille: "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200", texte: "text-violet-700 dark:text-violet-300", barre: "bg-violet-500", trait: "#8b5cf6" },
  marketing: { carte: "border-pink-200 bg-pink-50/70 dark:border-pink-900/70 dark:bg-pink-950/30", pastille: "bg-pink-100 text-pink-800 dark:bg-pink-900/60 dark:text-pink-200", texte: "text-pink-700 dark:text-pink-300", barre: "bg-pink-500", trait: "#ec4899" },
  operations: { carte: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/70 dark:bg-emerald-950/30", pastille: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200", texte: "text-emerald-700 dark:text-emerald-300", barre: "bg-emerald-500", trait: "#10b981" },
  administration: { carte: "border-amber-200 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/30", pastille: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200", texte: "text-amber-700 dark:text-amber-300", barre: "bg-amber-500", trait: "#f59e0b" },
  argent: { carte: "border-rose-200 bg-rose-50/70 dark:border-rose-900/70 dark:bg-rose-950/30", pastille: "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200", texte: "text-rose-700 dark:text-rose-300", barre: "bg-rose-500", trait: "#f43f5e" },
  transverse: { carte: "border-cyan-200 bg-cyan-50/70 dark:border-cyan-900/70 dark:bg-cyan-950/30", pastille: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/60 dark:text-cyan-200", texte: "text-cyan-700 dark:text-cyan-300", barre: "bg-cyan-500", trait: "#06b6d4" },
  systeme: { carte: "border-indigo-200 bg-indigo-50/70 dark:border-indigo-900/70 dark:bg-indigo-950/30", pastille: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200", texte: "text-indigo-700 dark:text-indigo-300", barre: "bg-indigo-500", trait: "#6366f1" },
  externe: { carte: "border-stone-200 bg-stone-50/70 dark:border-stone-800 dark:bg-stone-900/30", pastille: "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200", texte: "text-stone-700 dark:text-stone-300", barre: "bg-stone-500", trait: "#78716c" },
};

const TEINTES_ACTEUR: Record<TypeActeur, { pastille: string; rond: string }> = {
  demandeur: { pastille: "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200", rond: "bg-sky-500" },
  decideur: { pastille: "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200", rond: "bg-violet-500" },
  execution: { pastille: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200", rond: "bg-amber-500" },
  argent: { pastille: "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200", rond: "bg-rose-500" },
  systeme: { pastille: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200", rond: "bg-slate-500" },
  externe: { pastille: "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200", rond: "bg-stone-500" },
};

const TEINTES_NIVEAU: Record<Niveau, string> = {
  gerer: "bg-emerald-500 text-white",
  valider: "bg-violet-500 text-white",
  ecrire: "bg-sky-500 text-white",
  lire: "bg-slate-300 text-slate-800 dark:bg-slate-600 dark:text-slate-100",
  aucun: "bg-transparent text-muted-foreground",
};

const INITIALE_NIVEAU: Record<Niveau, string> = { gerer: "G", valider: "V", ecrire: "C", lire: "L", aucun: "·" };

const PAR_ID = new Map(MODULES_PLATEFORME.map((m) => [m.id, m]));
const NOM_DOMAINE = new Map(DOMAINES.map((d) => [d.cle, d.nom]));

function correspond(m: ModulePlateforme, q: string): boolean {
  if (!q) return false;
  const texte = [m.nom, m.resume, m.pourQui, m.route ?? "", ...m.gestes.map((g) => `${g.label} ${g.qui} ${g.effet}`), ...m.regles].join(" ");
  return plier(texte).includes(q);
}

interface Props {
  acces: MatriceAcces;
  roles: { cle: string; libelle: string }[];
  vueInitiale: Vue;
  moduleInitial: string | null;
  circuitInitial: string | null;
}

export function CartePlateforme({ acces, roles, vueInitiale, moduleInitial, circuitInitial }: Props) {
  const [vue, setVue] = useState<Vue>(vueInitiale);
  const [moduleId, setModuleId] = useState<string | null>(moduleInitial && PAR_ID.has(moduleInitial) ? moduleInitial : null);
  const [circuitId, setCircuitId] = useState<string>(circuitInitial && CIRCUITS.some((c) => c.id === circuitInitial) ? circuitInitial : CIRCUITS[0].id);
  const [circuitSurCarte, setCircuitSurCarte] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const panneauRef = useRef<HTMLDivElement>(null);

  const ouvrirModule = useCallback((id: string) => {
    setModuleId(id);
    setVue("carte");
    // Sur téléphone, la fiche est SOUS la carte : on l'amène à l'écran.
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1023px)").matches) panneauRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const ouvrirCircuit = useCallback((id: string) => {
    setCircuitId(id);
    setVue("circuits");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const montrerSurCarte = useCallback((id: string) => {
    setCircuitSurCarte(id);
    setModuleId(null);
    setVue("carte");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const onglets: { cle: Vue; libelle: string; icone: typeof MapIcon }[] = [
    { cle: "carte", libelle: "Carte", icone: MapIcon },
    { cle: "circuits", libelle: "Circuits", icone: Workflow },
    { cle: "roles", libelle: "Rôles & droits", icone: Users },
    { cle: "regles", libelle: "Règles transverses", icone: BookOpen },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"><MapIcon className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              Carte de la plateforme
              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">Super Admin</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              {MODULES_PLATEFORME.length} modules · {CIRCUITS.length} circuits · {roles.length} rôles — cliquez sur un module pour voir ce qu&apos;il fait, qui y agit et à quoi il est relié.
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1" role="tablist">
        {onglets.map((o) => (
          <button
            key={o.cle}
            type="button"
            role="tab"
            aria-selected={vue === o.cle}
            onClick={() => setVue(o.cle)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              vue === o.cle ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <o.icone className="h-4 w-4" /> {o.libelle}
          </button>
        ))}
      </div>

      {vue === "carte" && (
        <VueCarte
          acces={acces}
          roles={roles}
          moduleId={moduleId}
          setModuleId={setModuleId}
          ouvrirModule={ouvrirModule}
          ouvrirCircuit={ouvrirCircuit}
          circuitSurCarte={circuitSurCarte}
          setCircuitSurCarte={setCircuitSurCarte}
          recherche={recherche}
          setRecherche={setRecherche}
          panneauRef={panneauRef}
        />
      )}
      {vue === "circuits" && (
        <VueCircuits circuitId={circuitId} setCircuitId={setCircuitId} ouvrirModule={ouvrirModule} montrerSurCarte={montrerSurCarte} />
      )}
      {vue === "roles" && <VueRoles acces={acces} roles={roles} ouvrirModule={ouvrirModule} />}
      {vue === "regles" && <VueRegles />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VUE CARTE
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Trait {
  cle: string;
  d: string;
  couleur: string;
  epais: boolean;
  /** La flèche d'un circuit, à la couleur de son domaine (un marqueur SVG ne prend pas la couleur du trait). */
  marqueur?: CleDomaine;
}

function VueCarte(props: {
  acces: MatriceAcces;
  roles: { cle: string; libelle: string }[];
  moduleId: string | null;
  setModuleId: (id: string | null) => void;
  ouvrirModule: (id: string) => void;
  ouvrirCircuit: (id: string) => void;
  circuitSurCarte: string | null;
  setCircuitSurCarte: (id: string | null) => void;
  recherche: string;
  setRecherche: (s: string) => void;
  panneauRef: RefObject<HTMLDivElement | null>;
}) {
  const { acces, roles, moduleId, setModuleId, ouvrirModule, ouvrirCircuit, circuitSurCarte, setCircuitSurCarte, recherche, setRecherche, panneauRef } = props;
  const zoneRef = useRef<HTMLDivElement>(null);
  const noeuds = useRef<Record<string, HTMLButtonElement | null>>({});
  const [traits, setTraits] = useState<Trait[]>([]);
  const [taille, setTaille] = useState({ l: 0, h: 0 });
  const [survol, setSurvol] = useState<string | null>(null);

  const q = plier(recherche.trim());
  const actif = survol ?? moduleId;
  const voisins = useMemo(() => new Set(actif ? voisinsDuModule(actif) : []), [actif]);
  const circuit = circuitSurCarte ? CIRCUITS.find((c) => c.id === circuitSurCarte) ?? null : null;

  /** Le parcours d'un circuit sur la carte : les modules dans l'ordre, sans répéter un module consécutif. */
  const parcours = useMemo(() => {
    if (!circuit) return [] as { module: string; etapes: number[] }[];
    const out: { module: string; etapes: number[] }[] = [];
    circuit.etapes.forEach((e, i) => {
      const dernier = out[out.length - 1];
      if (dernier && dernier.module === e.module) dernier.etapes.push(i + 1);
      else out.push({ module: e.module, etapes: [i + 1] });
    });
    return out;
  }, [circuit]);
  const numerosParModule = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const p of parcours) m.set(p.module, [...(m.get(p.module) ?? []), ...p.etapes]);
    return m;
  }, [parcours]);

  const tracer = useCallback(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const base = zone.getBoundingClientRect();
    setTaille({ l: zone.scrollWidth, h: zone.scrollHeight });
    const centre = (id: string) => {
      const el = noeuds.current[id];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
    };
    const courbe = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = (b.x - a.x) / 2;
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };
    const out: Trait[] = [];
    if (circuit) {
      for (let i = 0; i < parcours.length - 1; i++) {
        const a = centre(parcours[i].module);
        const b = centre(parcours[i + 1].module);
        if (a && b) out.push({ cle: `c-${i}`, d: courbe(a, b), couleur: TEINTES[circuit.domaine].trait, epais: true, marqueur: circuit.domaine });
      }
    } else if (actif) {
      const a = centre(actif);
      const source = PAR_ID.get(actif);
      if (a && source) {
        for (const v of voisins) {
          const b = centre(v);
          if (b) out.push({ cle: `v-${v}`, d: courbe(a, b), couleur: TEINTES[source.domaine].trait, epais: false });
        }
      }
    }
    setTraits(out);
  }, [actif, voisins, circuit, parcours]);

  useLayoutEffect(() => {
    tracer();
  }, [tracer, recherche]);

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => tracer());
    obs.observe(zone);
    return () => obs.disconnect();
  }, [tracer]);

  const choisi = moduleId ? PAR_ID.get(moduleId) ?? null : null;
  const trouves = q ? MODULES_PLATEFORME.filter((m) => correspond(m, q)).length : 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              placeholder="Chercher un module, un bouton, un rôle… (ex. « cadenas », « BC », « intérim »)"
              className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {recherche && (
              <button type="button" onClick={() => setRecherche("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Effacer la recherche">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <select
            value={circuitSurCarte ?? ""}
            onChange={(e) => { setCircuitSurCarte(e.target.value || null); if (e.target.value) setModuleId(null); }}
            className="h-10 max-w-full rounded-lg border border-input bg-card px-3 text-sm"
            aria-label="Dessiner un circuit sur la carte"
          >
            <option value="">Dessiner un circuit sur la carte…</option>
            {CIRCUITS.map((c) => <option key={c.id} value={c.id}>{c.titre}</option>)}
          </select>
        </div>

        {q && <p className="text-xs text-muted-foreground">{trouves} module{trouves > 1 ? "s" : ""} correspond{trouves > 1 ? "ent" : ""} à « {recherche} » — surlignés en jaune.</p>}
        {circuit && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
            <GitBranch className={cn("h-4 w-4", TEINTES[circuit.domaine].texte)} />
            <span className="font-medium">{circuit.titre}</span>
            <span className="text-muted-foreground">— les numéros sont les étapes ; la ligne suit l&apos;ordre.</span>
            <button type="button" onClick={() => ouvrirCircuit(circuit.id)} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Lire le circuit <ArrowRight className="h-3 w-3" /></button>
            <button type="button" onClick={() => setCircuitSurCarte(null)} className="rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Retirer le circuit de la carte"><X className="h-4 w-4" /></button>
          </div>
        )}

        <div ref={zoneRef} className="relative">
          <svg className="pointer-events-none absolute left-0 top-0 z-10" width={taille.l} height={taille.h} aria-hidden>
            <defs>
              {DOMAINES.map((d) => (
                <marker key={d.cle} id={`fleche-carte-${d.cle}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={TEINTES[d.cle].trait} />
                </marker>
              ))}
            </defs>
            {traits.map((t) => (
              <path
                key={t.cle}
                d={t.d}
                fill="none"
                stroke={t.couleur}
                strokeWidth={t.epais ? 3 : 2}
                strokeOpacity={t.epais ? 0.85 : 0.6}
                strokeDasharray={t.epais ? undefined : "5 4"}
                markerEnd={t.marqueur ? `url(#fleche-carte-${t.marqueur})` : undefined}
              />
            ))}
          </svg>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {DOMAINES.map((d) => {
              const modules = MODULES_PLATEFORME.filter((m) => m.domaine === d.cle);
              const t = TEINTES[d.cle];
              return (
                <section key={d.cle} className={cn("rounded-2xl border p-3", t.carte)}>
                  <header className="mb-2.5">
                    <h2 className={cn("flex items-center gap-2 text-sm font-semibold", t.texte)}>
                      <span className={cn("h-2.5 w-2.5 rounded-full", t.barre)} />
                      {d.nom}
                      <span className="text-xs font-normal text-muted-foreground">({modules.length})</span>
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{d.resume}</p>
                  </header>
                  <div className="flex flex-wrap gap-1.5">
                    {modules.map((m) => {
                      const estChoisi = m.id === moduleId;
                      const estVoisin = voisins.has(m.id);
                      const numeros = numerosParModule.get(m.id);
                      const surCircuit = Boolean(numeros);
                      const trouve = q ? correspond(m, q) : false;
                      const eteint = (circuit && !surCircuit) || (!circuit && actif && m.id !== actif && !estVoisin) || (q && !trouve);
                      return (
                        <button
                          key={m.id}
                          ref={(el) => { noeuds.current[m.id] = el; }}
                          type="button"
                          onClick={() => (estChoisi ? setModuleId(null) : ouvrirModule(m.id))}
                          onMouseEnter={() => setSurvol(m.id)}
                          onMouseLeave={() => setSurvol(null)}
                          onFocus={() => setSurvol(m.id)}
                          onBlur={() => setSurvol(null)}
                          title={m.resume}
                          className={cn(
                            "relative z-20 flex items-center gap-1.5 rounded-lg border bg-card py-1.5 pl-1.5 pr-2.5 text-left text-xs font-medium shadow-sm transition-all",
                            "hover:-translate-y-px hover:shadow-md",
                            estChoisi && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                            estVoisin && !estChoisi && "border-foreground/30 font-semibold",
                            trouve && "bg-yellow-100 dark:bg-yellow-900/50",
                            eteint && "opacity-35",
                          )}
                        >
                          <span className={cn("h-5 w-1 shrink-0 rounded-full", t.barre)} />
                          {m.nom}
                          {numeros && (
                            <span className="ml-1 flex gap-0.5">
                              {numeros.map((n) => (
                                <span key={n} className={cn("flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white", circuit ? TEINTES[circuit.domaine].barre : "bg-slate-500")}>{n}</span>
                              ))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Survolez un module pour voir ses connexions (pointillés) ; cliquez pour ouvrir sa fiche. Choisissez un circuit pour le voir parcourir la carte.
        </p>
      </div>

      <div ref={panneauRef} className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        {choisi ? (
          <FicheModule module={choisi} acces={acces[choisi.id]} roles={roles} ouvrirModule={ouvrirModule} ouvrirCircuit={ouvrirCircuit} fermer={() => setModuleId(null)} />
        ) : (
          <div className="rounded-2xl border bg-card p-5">
            <h2 className="text-sm font-semibold">Comment lire cette carte</h2>
            <ul className="mt-3 space-y-2.5 text-sm text-muted-foreground">
              <li className="flex gap-2"><MapIcon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" /> Chaque <b className="text-foreground">couleur</b> est un domaine de l&apos;ERP (pôle du menu).</li>
              <li className="flex gap-2"><ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" /> Un <b className="text-foreground">clic</b> sur un module ouvre ici : à quoi il sert, ses boutons et qui les utilise, ses règles, les rôles qui y ont accès, et les circuits qui le traversent.</li>
              <li className="flex gap-2"><Workflow className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" /> L&apos;onglet <b className="text-foreground">Circuits</b> raconte un fait de bout en bout : qui fait quoi, dans quel ordre, et ce que chaque geste déclenche.</li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" /> Les droits affichés sont lus <b className="text-foreground">en direct</b> dans la matrice des rôles du code.</li>
            </ul>
            <div className="mt-4 border-t pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Par où commencer</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {["ad-pro-kam", "paiement", "regulatory", "secretariat"].map((id) => {
                  const c = CIRCUITS.find((x) => x.id === id);
                  return c ? (
                    <button key={id} type="button" onClick={() => setCircuitSurCarte(id)} className={cn("rounded-full px-2.5 py-1 text-xs font-medium", TEINTES[c.domaine].pastille)}>{c.titre}</button>
                  ) : null;
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FicheModule({ module: m, acces, roles, ouvrirModule, ouvrirCircuit, fermer }: {
  module: ModulePlateforme;
  acces: MatriceAcces[string] | undefined;
  roles: { cle: string; libelle: string }[];
  ouvrirModule: (id: string) => void;
  ouvrirCircuit: (id: string) => void;
  fermer: () => void;
}) {
  const t = TEINTES[m.domaine];
  const circuits = circuitsDuModule(m.id);
  const voisins = voisinsDuModule(m.id).map((id) => PAR_ID.get(id)).filter((x): x is ModulePlateforme => Boolean(x));
  const pourquoi = (id: string) => m.liens.find((l) => l.vers === id)?.pourquoi ?? PAR_ID.get(id)?.liens.find((l) => l.vers === m.id)?.pourquoi ?? "";

  const parNiveau = new Map<Niveau, { cle: string; libelle: string; detail: string[] }[]>();
  if (acces) {
    for (const r of roles) {
      const a = acces[r.cle];
      if (!a) continue;
      parNiveau.set(a.niveau, [...(parNiveau.get(a.niveau) ?? []), { ...r, detail: a.detail }]);
    }
  }

  return (
    <article className="overflow-hidden rounded-2xl border bg-card">
      <div className={cn("h-1.5", t.barre)} />
      <div className="space-y-5 p-5">
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", t.pastille)}>{NOM_DOMAINE.get(m.domaine)}</span>
            <button type="button" onClick={fermer} className="rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Fermer la fiche"><X className="h-4 w-4" /></button>
          </div>
          <h2 className="text-lg font-semibold leading-tight">{m.nom}</h2>
          <p className="text-sm text-muted-foreground">{m.resume}</p>
          {m.route && (
            <Link href={m.route} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
              <ExternalLink className="h-3.5 w-3.5" /> Ouvrir l&apos;écran <code className="text-muted-foreground">{m.route}</code>
            </Link>
          )}
        </header>

        <Bloc titre="Qui l'utilise">
          <p className="text-sm">{m.pourQui}</p>
        </Bloc>

        <Bloc titre="Droits par défaut des rôles">
          {m.rbac.length === 0 ? (
            <p className="text-sm text-muted-foreground">Pas de module dans la matrice : l&apos;accès est décrit ci-dessus (espace personnel, porte ouverte à tous, ou garde propre).</p>
          ) : (
            <div className="space-y-2">
              {NIVEAUX.filter((n) => n !== "aucun" && parNiveau.has(n)).map((n) => (
                <div key={n} className="flex flex-wrap items-start gap-1.5">
                  <span className={cn("mt-0.5 w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold", TEINTES_NIVEAU[n])} title={AIDE_NIVEAU[n]}>{LIBELLES_NIVEAU[n]}</span>
                  {parNiveau.get(n)!.map((r) => (
                    <span key={r.cle} title={r.detail.join("\n")} className="rounded-md border bg-background px-1.5 py-0.5 text-[11px]">{r.libelle}</span>
                  ))}
                </div>
              ))}
              {parNiveau.has("aucun") && (
                <p className="text-[11px] text-muted-foreground">Sans accès par défaut : {parNiveau.get("aucun")!.map((r) => r.libelle).join(", ")}.</p>
              )}
              <p className="text-[11px] text-muted-foreground">Survolez un rôle pour le détail des actions. La console peut ouvrir ou bloquer par personne.</p>
            </div>
          )}
        </Bloc>

        <Bloc titre="Les gestes — qui fait quoi">
          <ol className="space-y-2.5">
            {m.gestes.map((g) => (
              <li key={g.label} className="rounded-lg border bg-background p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-semibold">{g.label}</span>
                  <span className="text-[11px] text-muted-foreground">par</span>
                  <span className="text-xs font-medium">{g.qui}</span>
                </div>
                <p className="mt-1 flex gap-1.5 text-xs text-muted-foreground"><ArrowRight className="mt-0.5 h-3 w-3 shrink-0" />{g.effet}</p>
              </li>
            ))}
          </ol>
        </Bloc>

        {m.regles.length > 0 && (
          <Bloc titre="Règles à connaître">
            <ul className="list-disc space-y-1 pl-4 text-sm">
              {m.regles.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </Bloc>
        )}

        {voisins.length > 0 && (
          <Bloc titre="Connexions">
            <ul className="space-y-1">
              {voisins.map((v) => (
                <li key={v.id}>
                  <button type="button" onClick={() => ouvrirModule(v.id)} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-secondary">
                    <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", TEINTES[v.domaine].barre)} />
                    <span className="min-w-0 text-sm"><b className="font-medium">{v.nom}</b>{pourquoi(v.id) && <span className="text-muted-foreground"> — {pourquoi(v.id)}</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Bloc>
        )}

        {circuits.length > 0 && (
          <Bloc titre="Circuits qui passent ici">
            <div className="flex flex-wrap gap-1.5">
              {circuits.map((c) => (
                <button key={c.id} type="button" onClick={() => ouvrirCircuit(c.id)} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", TEINTES[c.domaine].pastille)}>
                  <Workflow className="h-3 w-3" /> {c.titre}
                </button>
              ))}
            </div>
          </Bloc>
        )}
      </div>
    </article>
  );
}

function Bloc({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titre}</h3>
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VUE CIRCUITS
// ─────────────────────────────────────────────────────────────────────────────────────────────

function VueCircuits({ circuitId, setCircuitId, ouvrirModule, montrerSurCarte }: {
  circuitId: string;
  setCircuitId: (id: string) => void;
  ouvrirModule: (id: string) => void;
  montrerSurCarte: (id: string) => void;
}) {
  const circuit = CIRCUITS.find((c) => c.id === circuitId) ?? CIRCUITS[0];
  const [pas, setPas] = useState<number | null>(null);
  useEffect(() => setPas(null), [circuitId]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <nav className="min-w-0 space-y-1.5" aria-label="Circuits">
        {CIRCUITS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCircuitId(c.id)}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
              c.id === circuit.id ? cn("shadow-sm", TEINTES[c.domaine].carte) : "bg-card hover:bg-secondary",
            )}
          >
            <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", TEINTES[c.domaine].barre)} />
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-snug">{c.titre}</span>
              <span className="block text-[11px] text-muted-foreground">{c.etapes.length} étapes · {NOM_DOMAINE.get(c.domaine)}</span>
            </span>
          </button>
        ))}
      </nav>

      <article className="min-w-0 overflow-hidden rounded-2xl border bg-card">
        <div className={cn("h-1.5", TEINTES[circuit.domaine].barre)} />
        <div className="space-y-5 p-5">
          <header className="space-y-2">
            <h2 className="text-xl font-semibold leading-tight">{circuit.titre}</h2>
            <p className="text-sm text-muted-foreground">{circuit.resume}</p>
            <div className={cn("rounded-lg border px-3 py-2 text-sm", TEINTES[circuit.domaine].carte)}>
              <span className="font-semibold">Point de départ : </span>{circuit.declencheur}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" onClick={() => montrerSurCarte(circuit.id)} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
                <MapIcon className="h-3.5 w-3.5" /> Voir sur la carte
              </button>
              <div className="inline-flex items-center gap-1 rounded-lg border p-0.5">
                <button type="button" onClick={() => setPas((p) => (p === null || p <= 0 ? 0 : p - 1))} className="rounded p-1 hover:bg-secondary" aria-label="Étape précédente"><ChevronLeft className="h-4 w-4" /></button>
                <span className="min-w-24 text-center text-xs font-medium">{pas === null ? "Lecture pas à pas" : `Étape ${pas + 1} / ${circuit.etapes.length}`}</span>
                <button type="button" onClick={() => setPas((p) => (p === null ? 0 : Math.min(circuit.etapes.length - 1, p + 1)))} className="rounded p-1 hover:bg-secondary" aria-label="Étape suivante"><ChevronRight className="h-4 w-4" /></button>
              </div>
              {pas !== null && <button type="button" onClick={() => setPas(null)} className="text-xs text-muted-foreground hover:underline">Tout afficher</button>}
            </div>
          </header>

          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TYPES_ACTEUR) as TypeActeur[]).map((k) => (
              <span key={k} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", TEINTES_ACTEUR[k].pastille)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", TEINTES_ACTEUR[k].rond)} /> {TYPES_ACTEUR[k]}
              </span>
            ))}
          </div>

          <ol className="relative space-y-0">
            {circuit.etapes.map((e, i) => {
              const mod = PAR_ID.get(e.module);
              const eteinte = pas !== null && i !== pas;
              const derniere = i === circuit.etapes.length - 1;
              return (
                <li key={i} className={cn("relative flex gap-3 pb-5 transition-opacity", eteinte && "opacity-30")}>
                  {!derniere && <span className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-0.5 bg-border" aria-hidden />}
                  <span className={cn("relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow", TEINTES_ACTEUR[e.type].rond)}>{i + 1}</span>
                  <div className={cn("min-w-0 flex-1 rounded-xl border p-3", pas === i ? "border-primary shadow-md" : "bg-background")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TEINTES_ACTEUR[e.type].pastille)}>{e.acteur}</span>
                      {e.decision && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-violet-300 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-700 dark:text-violet-300">
                          <GitBranch className="h-3 w-3" /> Décision
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-semibold">{e.action}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{e.effet}</p>
                    {mod && (
                      <button type="button" onClick={() => ouvrirModule(mod.id)} className={cn("mt-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium", TEINTES[mod.domaine].pastille)}>
                        {mod.nom} <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {circuit.aRetenir.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"><Info className="h-4 w-4" /> À retenir</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {circuit.aRetenir.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VUE RÔLES
// ─────────────────────────────────────────────────────────────────────────────────────────────

function VueRoles({ acces, roles, ouvrirModule }: { acces: MatriceAcces; roles: { cle: string; libelle: string }[]; ouvrirModule: (id: string) => void }) {
  const [role, setRole] = useState<string | null>(null);
  const avecMatrice = MODULES_PLATEFORME.filter((m) => m.rbac.length > 0);
  const choisi = role ? roles.find((r) => r.cle === role) ?? null : null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card p-4 text-sm">
        <p className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
          <span>
            Ce tableau montre les <b>droits par défaut de chaque rôle</b>, lus en direct dans la matrice du code (<code>PERMISSIONS</code>, <code>lib/rbac.ts</code>).
            La console d&apos;administration peut ensuite ouvrir, restreindre ou <b>bloquer</b> un module pour une personne, et certains accès sont implicites
            (Mon équipe, Annuaires, intérim, siège au centre de paiement…) — voir « Règles transverses ».
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {NIVEAUX.map((n) => (
            <span key={n} className="inline-flex items-center gap-1.5 text-xs" title={AIDE_NIVEAU[n]}>
              <span className={cn("flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold", TEINTES_NIVEAU[n], n === "aucun" && "border")}>{INITIALE_NIVEAU[n]}</span>
              {LIBELLES_NIVEAU[n]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {roles.map((r) => (
          <button
            key={r.cle}
            type="button"
            onClick={() => setRole(role === r.cle ? null : r.cle)}
            className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", role === r.cle ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-secondary")}
          >
            {r.libelle}
          </button>
        ))}
      </div>

      {choisi && (
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="text-lg font-semibold">Ce que peut faire « {choisi.libelle} » par défaut</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {NIVEAUX.filter((n) => n !== "aucun").map((n) => {
              const liste = avecMatrice.filter((m) => acces[m.id]?.[choisi.cle]?.niveau === n);
              return (
                <div key={n} className="rounded-xl border p-3">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px]", TEINTES_NIVEAU[n])}>{LIBELLES_NIVEAU[n]}</span>
                    <span className="text-muted-foreground">{liste.length}</span>
                  </h3>
                  <p className="mt-1 text-[11px] text-muted-foreground">{AIDE_NIVEAU[n]}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {liste.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                    {liste.map((m) => (
                      <button key={m.id} type="button" onClick={() => ouvrirModule(m.id)} className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", TEINTES[m.domaine].pastille)}>{m.nom}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[1100px] border-collapse text-xs">
          <thead>
            <tr className="border-b">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">Module</th>
              {roles.map((r) => (
                <th key={r.cle} className={cn("px-1 py-2 align-bottom font-medium", role === r.cle ? "text-primary" : "text-muted-foreground")}>
                  <button type="button" onClick={() => setRole(role === r.cle ? null : r.cle)} className="mx-auto block max-w-[70px] whitespace-normal text-[10px] leading-tight hover:text-foreground">{r.libelle}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOMAINES.map((d) => {
              const lignes = avecMatrice.filter((m) => m.domaine === d.cle);
              if (lignes.length === 0) return null;
              return [
                <tr key={`d-${d.cle}`} className={TEINTES[d.cle].carte}>
                  <td colSpan={roles.length + 1} className={cn("sticky left-0 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide", TEINTES[d.cle].texte)}>{d.nom}</td>
                </tr>,
                ...lignes.map((m) => (
                  <tr key={m.id} className="border-b last:border-0 hover:bg-secondary/50">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                      <button type="button" onClick={() => ouvrirModule(m.id)} className="whitespace-nowrap font-medium hover:underline">{m.nom}</button>
                    </td>
                    {roles.map((r) => {
                      const a = acces[m.id]?.[r.cle];
                      const n: Niveau = a?.niveau ?? "aucun";
                      return (
                        <td key={r.cle} className={cn("px-1 py-1 text-center", role === r.cle && "bg-primary/5")}>
                          <span
                            title={`${r.libelle} — ${m.nom}\n${(a?.detail ?? []).join("\n")}`}
                            className={cn("mx-auto flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold", TEINTES_NIVEAU[n])}
                          >
                            {INITIALE_NIVEAU[n]}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VUE RÈGLES TRANSVERSES
// ─────────────────────────────────────────────────────────────────────────────────────────────

function VueRegles() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {MECANISMES.map((m) => (
        <article key={m.titre} className="rounded-2xl border bg-card p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-4 w-4 text-indigo-500" /> {m.titre}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{m.resume}</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
            {m.details.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </article>
      ))}
    </div>
  );
}

