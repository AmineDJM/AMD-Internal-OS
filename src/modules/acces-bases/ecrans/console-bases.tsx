"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { actionFailureMessage } from "@/lib/action-outcome";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { poserReglageBase, reglerAccesBasesStrict, reglerPropresDonneesBase, revoquerReglageBase } from "@/modules/acces-bases/actions";
import { LIBELLE_NIVEAU_BASE, type ModeStrict, type NiveauBase, type Sensibilite } from "@/modules/acces-bases/partage";

/**
 * LA CONSOLE « ACCÈS PAR BASE » (lot D2, décision 0057) — Administration › Accès › Par base.
 * La liste des bases (sensibilité, nombre de tables, réglages en vigueur), et pour une base : « Qui voit cette base ? »
 * (calculé), ses réglages datés (poser, révoquer), et l'accès à ses propres données quand elle est fermée.
 */

export interface LigneBaseConsole {
  cle: string;
  nom: string;
  nature: "metier" | "technique";
  sensibilite: Sensibilite;
  tables: number;
  reglages: number;
  propresDonnees: boolean;
}
export interface ReglageConsole {
  id: string;
  cible: string;
  niveau: NiveauBase;
  ecriture: boolean;
  du: string;
  au: string | null;
  motif: string;
  revoque: boolean;
  enVigueur: boolean;
}
export interface LigneQuiVoitConsole {
  userId: string;
  nom: string;
  role: string;
  lecture: boolean;
  ecriture: boolean;
  niveau: NiveauBase;
  chemin: string;
}
export interface ObservationConsole {
  jour: string;
  nom: string;
  geste: string;
  niveau: string;
  nombre: number;
  modeles: string[];
}
export interface DetailBaseConsole {
  cle: string;
  nom: string;
  tables: string[];
  modules: string[];
  reglages: ReglageConsole[];
  quiVoit: LigneQuiVoitConsole[];
  propresDonnees: boolean;
  observations: ObservationConsole[];
}

const TEINTE: Record<Sensibilite, string> = {
  "public-interne": "Public interne",
  restreint: "Restreint",
  confidentiel: "Confidentiel",
  secret: "Secret",
};

const MODES: { mode: ModeStrict; libelle: string; aide: string }[] = [
  { mode: "AUCUNE", libelle: "Désactivée", aide: "La garde observe et compte ; rien n'est refusé." },
  { mode: "SENSIBLES", libelle: "Bases sensibles", aide: "Refus appliqués sur les bases secrètes et confidentielles." },
  { mode: "TOUTES", libelle: "Toutes les bases métier", aide: "Refus appliqués sur toutes les bases métier." },
];

export function ConsoleBases({ bases, detail, personnes, roles, modeStrict }: {
  modeStrict: ModeStrict;
  bases: LigneBaseConsole[];
  detail: DetailBaseConsole | null;
  personnes: { id: string; nom: string }[];
  roles: { cle: string; libelle: string }[];
}) {
  const { rafraichir } = useRafraichir();
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [confirmer, setConfirmer] = React.useState(false);
  const [enCours, setEnCours] = React.useState(false);
  const [modeAConfirmer, setModeAConfirmer] = React.useState<ModeStrict | null>(null);
  const choisirMode = (mode: ModeStrict) => void agir(async () => {
    const r = await reglerAccesBasesStrict(mode, modeAConfirmer === mode);
    setModeAConfirmer(!r.ok && r.confirmation ? mode : null);
    return r;
  });

  const agir = async (f: () => Promise<{ ok: boolean; error?: string; confirmation?: true }>) => {
    setErreur(null);
    setEnCours(true);
    try {
      const r = await f();
      if (!r.ok) {
        setErreur(r.error ?? actionFailureMessage("THROWN"));
        if (r.confirmation) setConfirmer(true);
      } else setConfirmer(false);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnCours(false);
      rafraichir();
    }
  };
  const soumettre = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    if (detail) fd.set("base", detail.cle);
    if (confirmer) fd.set("confirmeSuperAdmin", "oui");
    await agir(() => poserReglageBase(fd));
  };

  return (
    <div className="space-y-4" data-testid="console-bases">
      {erreur && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{erreur}</p>}
      <Card data-testid="mode-strict">
        <CardHeader>
          <CardTitle className="text-base">Application stricte</CardTitle>
          <p className="text-sm text-muted-foreground">
            Tant qu&apos;elle est désactivée, les réglages ci-dessous — fermetures comme ouvertures — sont mesurés (« ce que la garde aurait refusé ») sans rien changer.
            Activée, elle s&apos;applique partout : écrans et menus, exports, API, SQL libre, Assistant IA — Super Admin compris ; les bases techniques (comptes, journaux, plateforme) restent toujours ouvertes.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <Button key={m.mode} type="button" size="sm" variant={modeStrict === m.mode ? "primary" : "outline"} disabled={enCours || modeStrict === m.mode}
              title={m.aide} onClick={() => choisirMode(m.mode)}>
              {modeAConfirmer === m.mode ? `Confirmer : ${m.libelle}` : m.libelle}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Les bases</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <ul className="divide-y text-sm">
            {bases.map((b) => (
              <li key={b.cle} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`?base=${b.cle}`} className="font-medium underline-offset-2 hover:underline">{b.nom}</Link>
                <Badge tone={b.sensibilite === "secret" ? "danger" : b.sensibilite === "confidentiel" ? "warning" : "neutral"}>{TEINTE[b.sensibilite]}</Badge>
                <span className="text-muted-foreground">{b.tables} tables{b.nature === "technique" ? " · technique" : ""}</span>
                {b.reglages > 0 && <Badge tone="info">{b.reglages} réglage{b.reglages > 1 ? "s" : ""}</Badge>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {detail && (
        <Card data-testid="detail-base">
          <CardHeader>
            <CardTitle className="text-base">{detail.nom}</CardTitle>
            <p className="text-sm text-muted-foreground">Modules qui y mènent : {detail.modules.join(", ") || "aucun"} — {detail.tables.length} tables.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Réglages</h3>
              <ul className="space-y-1 text-sm">
                {detail.reglages.length === 0 && <li className="text-muted-foreground">Aucun réglage : les modules décident seuls (Normal).</li>}
                {detail.reglages.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.enVigueur ? "info" : "neutral"}>{LIBELLE_NIVEAU_BASE[r.niveau]}{r.niveau === "OUVERTE" && r.ecriture ? " + écriture" : ""}</Badge>
                    <span>{r.cible} — du {r.du}{r.au ? ` au ${r.au}` : ", sans fin"}{r.revoque ? " (révoqué)" : r.enVigueur ? "" : " (pas en vigueur)"} — {r.motif}</span>
                    {!r.revoque && <Button type="button" size="sm" variant="outline" disabled={enCours} onClick={() => void agir(() => revoquerReglageBase(r.id))}>Révoquer</Button>}
                  </li>
                ))}
              </ul>
              <form onSubmit={soumettre} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
                <select name="userId" aria-label="Personne" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2" defaultValue="">
                  <option value="">— une personne —</option>
                  {personnes.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
                </select>
                <select name="role" aria-label="Rôle" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2" defaultValue="">
                  <option value="">— ou un rôle —</option>
                  {roles.map((r) => <option key={r.cle} value={r.cle}>{r.libelle}</option>)}
                </select>
                <select name="niveau" aria-label="Niveau" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2" defaultValue="FERMEE">
                  <option value="FERMEE">Fermée</option>
                  <option value="LECTURE_SEULE">Lecture seule</option>
                  <option value="OUVERTE">Ouverte</option>
                </select>
                <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="ecriture" value="oui" /> Ouverte : avec l&apos;écriture</label>
                <Input name="du" type="date" aria-label="Du" required />
                <Input name="au" type="date" aria-label="Au" />
                <Input name="motif" placeholder="Motif (obligatoire, écrit au journal)" aria-label="Motif" required className="sm:col-span-4" />
                {confirmer && <p className="text-sm text-destructive sm:col-span-6">Ce réglage restreint un Super Admin : renvoyez le formulaire pour confirmer.</p>}
                <Button type="submit" size="sm" disabled={enCours}>{confirmer ? "Confirmer" : "Appliquer"}</Button>
              </form>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Base fermée : ses propres données</h3>
              <p className="text-sm text-muted-foreground">
                Quand cette base est fermée à quelqu&apos;un, garde-t-il l&apos;accès à SES propres données (son dossier) ? Aujourd&apos;hui : <strong>{detail.propresDonnees ? "oui" : "non"}</strong>.
              </p>
              <Button type="button" size="sm" variant="outline" disabled={enCours} onClick={() => void agir(() => reglerPropresDonneesBase(detail.cle, !detail.propresDonnees))}>
                {detail.propresDonnees ? "Ne plus les laisser visibles" : "Les laisser visibles"}
              </Button>
            </section>

            <section className="space-y-2" data-testid="observations-base">
              <h3 className="text-sm font-semibold">Ce que la garde aurait refusé (14 derniers jours)</h3>
              <p className="text-xs text-muted-foreground">
                Mode observation : rien n&apos;est bloqué. Chaque ligne compte les requêtes qu&apos;un réglage de cette base aurait refusées,
                y compris par la jointure d&apos;un autre écran (tables en cause entre parenthèses). L&apos;application stricte attend la décision de la Direction.
              </p>
              <ul className="divide-y text-sm">
                {detail.observations.length === 0 && <li className="text-muted-foreground">Rien d&apos;observé.</li>}
                {detail.observations.map((o) => (
                  <li key={`${o.jour}-${o.nom}-${o.geste}`} className="flex flex-wrap items-center gap-2 py-1">
                    <span className="text-muted-foreground">{o.jour}</span>
                    <span className="font-medium">{o.nom}</span>
                    <Badge tone="warning">{o.geste === "lecture" ? "Lecture" : "Écriture"} × {o.nombre}</Badge>
                    <span className="text-muted-foreground">{LIBELLE_NIVEAU_BASE[o.niveau as NiveauBase] ?? o.niveau} ({o.modeles.join(", ")})</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Qui voit cette base aujourd&apos;hui ?</h3>
              <ul className="divide-y text-sm">
                {detail.quiVoit.filter((l) => l.lecture || l.niveau !== "NORMAL").map((l) => (
                  <li key={l.userId} className="flex flex-wrap items-center gap-2 py-1">
                    <span className="font-medium">{l.nom}</span>
                    <span className="text-muted-foreground">{l.role}</span>
                    <Badge tone={l.lecture ? "success" : "neutral"}>{l.lecture ? (l.ecriture ? "Lit et écrit" : "Lit") : "Aucun accès"}</Badge>
                    <span className="text-muted-foreground">{l.chemin}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{detail.quiVoit.filter((l) => !l.lecture && l.niveau === "NORMAL").length} autre(s) personne(s) active(s) sans accès.</p>
            </section>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
