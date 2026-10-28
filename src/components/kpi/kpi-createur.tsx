"use client";

import * as React from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { NATURE_LABELS } from "@/lib/kpi/briques";
import { phraseCalcul, type DefinitionKpi } from "@/lib/kpi/definition";
import { afficherValeur } from "@/lib/kpi/score";
import { MODULE_FEEDBACK_KPI, messagePropositionKpi, type HorsBriques } from "@/lib/kpi/luna-pur";
import type { ApercuKpi } from "@/lib/kpi/types";
import { apercuKpi, creerKpi, proposerKpiDepuisPhrase } from "@/lib/actions/kpi-actions";
import { submitFeedback } from "@/lib/actions/feedback-actions";
import { PastilleKpi } from "@/components/kpi/kpi-commun";
import { sansBloquer } from "@/lib/journal";

type Bulle = { de: "moi" | "luna"; texte: string };
interface Proposee { def: DefinitionKpi; explication: string | null; retenue: boolean; justificationCible?: string | null; cibleParLuna?: boolean }

/**
 * NOUVEAU KPI — l'assistant (maquette validée) : une phrase → des définitions proposées par Luna, contraintes aux
 * briques → un aperçu sur les 3 derniers mois RÉELS de l'équipe (rien n'est enregistré) → « Ajouter ». Ce que les
 * briques ne savent pas mesurer remonte au Super Admin comme un retour « KPI ».
 */
export function KpiCreateur({ personnes, roles = [], onAjoute }: {
  personnes: { userId: string; nom: string }[];
  /** Super Admin : les rôles auxquels le KPI peut être affecté comme modèle (catalogue). */
  roles?: { cle: string; libelle: string }[];
  onAjoute: () => void;
}) {
  const [phrase, setPhrase] = React.useState("");
  const [bulles, setBulles] = React.useState<Bulle[]>([]);
  const [props, setProps] = React.useState<Proposee[]>([]);
  const [horsBriques, setHorsBriques] = React.useState<{ h: HorsBriques; phrase: string } | null>(null);
  const [apercu, setApercu] = React.useState<ApercuKpi | null>(null);
  const [pour, setPour] = React.useState<string>(personnes.length === 0 && roles.length > 0 ? `ROLE:${roles[0]!.cle}` : "EQUIPE");
  const [poids, setPoids] = React.useState("10");
  const [busy, setBusy] = React.useState<"luna" | "apercu" | "ajout" | "feedback" | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const retenues = props.filter((p) => p.retenue);

  const demander = async (e: React.FormEvent) => {
    e.preventDefault();
    const texte = phrase.trim();
    if (!texte) return;
    setBusy("luna"); setMsg(null); setApercu(null);
    setBulles((b) => [...b, { de: "moi", texte }]);
    const fd = new FormData(); fd.set("phrase", texte);
    const r = await proposerKpiDepuisPhrase(fd).catch(sansBloquer("kpi-createur.demander.proposerKpiDepuisPhrase", null));
    setBusy(null);
    if (!r?.ok) { setMsg({ ok: false, texte: r?.error ?? "Luna n'a pas répondu." }); return; }
    const notes = [r.message, ...(r.rejets ?? []), r.note].filter(Boolean).join(" ");
    setBulles((b) => [...b, { de: "luna", texte: notes || "Voici ce que je propose." }]);
    setProps((p) => [...p, ...(r.propositions ?? []).map((x) => ({ ...x, retenue: true }))]);
    setHorsBriques(r.horsBriques ? { h: r.horsBriques, phrase: texte } : null);
    setPhrase("");
  };

  const voirApercu = async () => {
    if (retenues.length === 0) return;
    setBusy("apercu"); setMsg(null);
    const fd = new FormData(); fd.set("definitions", JSON.stringify(retenues.map((p) => p.def)));
    // La cible se lit sur l'historique de la personne visée (en plus de celui de l'équipe).
    if (pour !== "EQUIPE" && !pour.startsWith("ROLE:")) fd.set("pour", pour);
    const r = await apercuKpi(fd).catch(sansBloquer("kpi-createur.voirApercu.apercuKpi", null));
    setBusy(null);
    if (r?.ok) {
      setApercu(r.apercu);
      // La cible proposée d'après l'historique réel vient remplir celles que la définition laissait vides.
      setProps((ps) => {
        let i = 0;
        return ps.map((p) => {
          if (!p.retenue) return p;
          const c = r.apercu.colonnes[i++];
          return c && p.def.cible === null && c.cibleProposee !== null ? { ...p, def: { ...p.def, cible: c.cibleProposee }, justificationCible: c.justification, cibleParLuna: c.parLuna } : p;
        });
      });
      if (r.apercu.noteCibles) setMsg({ ok: true, texte: r.apercu.noteCibles });
    } else setMsg({ ok: false, texte: r && !r.ok ? r.error : "L'aperçu n'a pas pu se calculer." });
  };

  const ajouter = async () => {
    if (retenues.length === 0) return;
    setBusy("ajout"); setMsg(null);
    const fd = new FormData();
    fd.set("definitions", JSON.stringify(retenues.map((p) => p.def)));
    if (pour.startsWith("ROLE:")) { fd.set("pour", "ROLE"); fd.set("role", pour.slice(5)); }
    else if (pour === "EQUIPE") fd.set("pour", "EQUIPE");
    else { fd.set("pour", "PERSONNE"); fd.set("userId", pour); }
    fd.set("poids", poids);
    const r = await creerKpi(fd).catch(sansBloquer("kpi-createur.ajouter.creerKpi", null));
    setBusy(null);
    setMsg({ ok: Boolean(r?.ok), texte: r?.ok ? r.message ?? "Ajouté." : r?.error ?? "Échec." });
    if (r?.ok) { setProps([]); setApercu(null); setBulles([]); onAjoute(); }
  };

  const proposerMesure = async () => {
    if (!horsBriques) return;
    setBusy("feedback");
    const fd = new FormData();
    fd.set("message", messagePropositionKpi({ phrase: horsBriques.phrase, ...horsBriques.h }));
    fd.set("module", MODULE_FEEDBACK_KPI);
    const r = await submitFeedback(undefined, fd).catch(sansBloquer("kpi-createur.proposerMesure.submitFeedback", null));
    setBusy(null);
    setMsg({ ok: Boolean(r?.ok), texte: r?.ok ? "Proposition envoyée au Super Admin — suivez-la dans « Mes propositions »." : r?.error ?? "Échec de l'envoi." });
    if (r?.ok) { setHorsBriques(null); onAjoute(); }
  };

  const changerCible = (i: number, v: string) => setProps((ps) => ps.map((p, j) => (j === i ? { ...p, def: { ...p.def, cible: v.trim() === "" ? null : Number(v.replace(",", ".")) } } : p)));

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-3">
        {bulles.length === 0 && (
          <p className="text-muted-foreground">
            Décrivez ce que vous voulez mesurer.
            <InfoBulle align="left">Luna traduit la phrase en définitions construites sur les mesures existantes (visites, cibles, rapports, plans, coaching, tâches…). Elle ne calcule jamais le chiffre : la plateforme le calcule. Ce qui ne se mesure pas devient un KPI évalué (grille notée par vous) ou déclaré (avec une pièce), ou une demande de nouvelle mesure au Super Admin.</InfoBulle>
          </p>
        )}
        {bulles.map((b, i) => (
          <div key={i} className={cn("max-w-[44rem] rounded-xl px-3.5 py-2.5", b.de === "moi" ? "ml-auto bg-secondary" : "border border-purple-500/30 bg-purple-500/5")}>{b.texte}</div>
        ))}
      </div>

      {props.map((p, i) => (
        <div key={i} className={cn("grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border p-3", p.retenue ? "border-border" : "border-dashed border-border opacity-60")}>
          <span className="text-muted-foreground">Nom</span>
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" checked={p.retenue} onChange={() => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, retenue: !x.retenue } : x)))} aria-label="Retenir ce KPI" />
            {p.def.nom}
          </label>
          <span className="text-muted-foreground">Nature</span><span>{NATURE_LABELS[p.def.nature]}</span>
          <span className="text-muted-foreground">Calcul</span><span>{phraseCalcul(p.def)}</span>
          {p.explication && (<><span className="text-muted-foreground">Pourquoi</span><span className="text-muted-foreground">{p.explication}</span></>)}
          {p.def.grille && (<><span className="text-muted-foreground">Grille</span><span>{p.def.grille.map((n, k) => `${k + 1}. ${n.libelle}`).join(" · ")}</span></>)}
          <span className="text-muted-foreground">Cible</span>
          <span className="flex flex-wrap items-center gap-2">
            <input
              value={p.def.cible ?? ""} onChange={(e) => changerCible(i, e.target.value)} inputMode="decimal" aria-label="Cible"
              className="h-8 w-24 rounded-md border border-input bg-background px-2"
            />
            <span className="text-xs text-muted-foreground">{p.def.unite === "POURCENT" ? "%" : p.def.unite === "NIVEAU" ? `niveau sur ${p.def.grille?.length ?? 4}` : p.def.periode === "TRIMESTRE" ? "par trimestre" : "par mois"}</span>
            {p.cibleParLuna && <Sparkles className="h-3.5 w-3.5 text-purple-500" aria-label="Cible proposée par Luna" />}
            {p.justificationCible && (
              <InfoBulle align="left">{p.cibleParLuna ? "Cible proposée par Luna d'après l'historique des derniers mois. " : ""}{p.justificationCible}</InfoBulle>
            )}
          </span>
        </div>
      ))}

      {apercu && (
        <section className="surface min-w-0 rounded-xl">
          <h3 className="flex items-center gap-1 border-b border-border px-4 py-2.5 text-sm font-semibold">
            Aperçu · {apercu.periodes[0]}
            <InfoBulle align="left">Données réelles de votre équipe ; rien n&apos;est encore enregistré. Luna propose la cible d&apos;après l&apos;historique mensuel (3 à 6 mois) de l&apos;équipe et de la personne choisie ; sans historique suffisant ou sans Luna, elle se place entre la moyenne et le meilleur de l&apos;équipe. La justification s&apos;ouvre à côté de la cible.</InfoBulle>
          </h3>
          <Table className="min-w-[28rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 z-10 bg-card">Personne</TableHead>
                {apercu.colonnes.map((c) => (
                  <TableHead key={c.nom} className="text-right">
                    {c.nom}
                    {c.cibleProposee !== null && <span className="block text-xs font-normal text-muted-foreground">cible {afficherValeur(c.cibleProposee, c.unite)}{c.moyenne !== null ? ` · moy. ${afficherValeur(c.moyenne, c.unite)}` : ""}</span>}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {apercu.lignes.map((l) => (
                <TableRow key={l.nom}>
                  <TableCell className="sticky left-0 z-10 bg-card">{l.nom}</TableCell>
                  {l.valeurs.map((v, j) => <TableCell key={j} className="text-right"><PastilleKpi couleur={v.couleur}>{v.affichage}</PastilleKpi></TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {retenues.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Pour
            <select value={pour} onChange={(e) => setPour(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
              {personnes.length > 0 && <option value="EQUIPE">toute mon équipe</option>}
              {personnes.map((p) => <option key={p.userId} value={p.userId}>{p.nom}</option>)}
              {roles.map((r) => <option key={r.cle} value={`ROLE:${r.cle}`}>modèle : {r.libelle}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Poids
            <input value={poids} onChange={(e) => setPoids(e.target.value)} inputMode="numeric" aria-label="Poids" className="h-9 w-16 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
          </label>
          <div className="flex gap-2 sm:ml-auto">
            <Button size="sm" variant="outline" onClick={() => void voirApercu()} disabled={busy !== null}>
              {busy === "apercu" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Aperçu 3 mois
            </Button>
            <Button size="sm" onClick={() => void ajouter()} disabled={busy !== null}>
              {busy === "ajout" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Ajouter {retenues.length > 1 ? `les ${retenues.length} KPI` : "le KPI"}
            </Button>
          </div>
        </div>
      )}

      {horsBriques && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="font-medium">Une mesure que la plateforme ne tient pas encore</p>
          <p className="text-xs text-muted-foreground">{horsBriques.h.intention}{horsBriques.h.donnees ? ` — données : ${horsBriques.h.donnees}` : ""}</p>
          <Button size="sm" variant="outline" onClick={() => void proposerMesure()} disabled={busy !== null}>
            {busy === "feedback" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Proposer une nouvelle mesure
          </Button>
        </div>
      )}

      <form onSubmit={(e) => void demander(e)} className="flex gap-2">
        <input
          value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Ce que vous voulez mesurer"
          placeholder="« Mes KAM voient leurs décideurs deux fois par mois et rendent leur rapport en 48 h »"
          className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 py-2"
        />
        <Button type="submit" disabled={busy !== null || !phrase.trim()}>
          {busy === "luna" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Luna
        </Button>
      </form>

      {msg && <p className={cn("text-xs", msg.ok ? "text-success" : "text-destructive")}>{msg.texte}</p>}
    </div>
  );
}
