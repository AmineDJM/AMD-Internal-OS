"use client";

import * as React from "react";
import { Check, Loader2, Minus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/components/shared/use-action";
import { enregistrerAccesAssistantIa, enregistrerPlafondsTravaux, enregistrerRetentionEffets, enregistrerTravauxDOffice, enregistrerVisibiliteEquipe } from "@/modules/assistant-ia/actions-consommation";
import {
  AIDE_FAMILLE, FAMILLES_IA, FAMILLES_SENSIBLES, LIBELLE_FAMILLE, resoudreAccesIa, type FamilleIa, type ReglageFamilles,
} from "@/modules/assistant-ia/partage";

export interface LigneRole { role: string; libelle: string; reglage: ReglageFamilles; dOffice?: boolean | null }
export interface LignePersonne {
  id: string; nom: string; email: string; role: string;
  droits: Record<FamilleIa, boolean>;
  reglageRole: ReglageFamilles;
  reglage: ReglageFamilles;
  plafonds: { travailUsd: number | null; mensuelUsd: number | null };
}

type Etat = "DEFAUT" | "OUVERTE" | "FERMEE";
const etatDe = (r: ReglageFamilles, f: FamilleIa): Etat => (r.ouvertes.includes(f) ? "OUVERTE" : r.fermees.includes(f) ? "FERMEE" : "DEFAUT");
const avec = (r: ReglageFamilles, f: FamilleIa, e: Etat): ReglageFamilles => ({
  ouvertes: e === "OUVERTE" ? [...r.ouvertes.filter((x) => x !== f), f] : r.ouvertes.filter((x) => x !== f),
  fermees: e === "FERMEE" ? [...r.fermees.filter((x) => x !== f), f] : r.fermees.filter((x) => x !== f),
});

/** Un choix à trois positions : défaut · ouverte · fermée — lisible d'un coup d'œil, au clavier comme à la souris. */
function TroisEtats({ etat, onChange, libelle }: { etat: Etat; onChange: (e: Etat) => void; libelle: string }) {
  const options: { e: Etat; icone: React.ReactNode; titre: string; actif: string }[] = [
    { e: "DEFAUT", icone: <Minus className="h-3.5 w-3.5" />, titre: "Défaut", actif: "bg-muted text-foreground" },
    { e: "OUVERTE", icone: <Check className="h-3.5 w-3.5" />, titre: "Ouverte", actif: "bg-success/15 text-success" },
    { e: "FERMEE", icone: <X className="h-3.5 w-3.5" />, titre: "Fermée", actif: "bg-destructive/15 text-destructive" },
  ];
  return (
    <div role="radiogroup" aria-label={libelle} className="inline-flex overflow-hidden rounded-md border">
      {options.map((o) => (
        <button
          key={o.e} type="button" role="radio" aria-checked={etat === o.e} title={`${libelle} : ${o.titre}`}
          onClick={() => onChange(o.e)}
          className={`flex h-7 w-8 items-center justify-center transition-colors ${etat === o.e ? o.actif : "text-muted-foreground hover:bg-muted/60"}`}
        >
          {o.icone}<span className="sr-only">{o.titre}</span>
        </button>
      ))}
    </div>
  );
}

function Enregistrer({ cible, reglage, apres }: { cible: string; reglage: ReglageFamilles; apres?: () => void }) {
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);
  const go = () => {
    const fd = new FormData();
    fd.set("cible", cible);
    fd.set("ouvertes", reglage.ouvertes.join(","));
    fd.set("fermees", reglage.fermees.join(","));
    setOk(false);
    void run(() => enregistrerAccesAssistantIa(fd), () => { setOk(true); apres?.(); });
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" onClick={go} disabled={saving}>{saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Enregistrer</Button>
      {ok && !err && <span className="text-xs text-success">Enregistré.</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}

/**
 * LES PLAFONDS DE DÉPENSE DES TRAVAUX (J2) — un travail qui atteint le sien, ou une personne qui atteint son plafond du
 * mois, DORT : il n'échoue pas et repart seul quand le plafond le permet. `cible` : « global » (défauts) ou une personne.
 */
function Plafonds({ cible, travail, mensuel, defauts }: { cible: string; travail: number | null; mensuel: number | null; defauts?: { travailUsd: number; mensuelUsd: number } }) {
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);
  const [t, setT] = React.useState(travail === null ? "" : String(travail));
  const [m, setM] = React.useState(mensuel === null ? "" : String(mensuel));
  React.useEffect(() => { setT(travail === null ? "" : String(travail)); setM(mensuel === null ? "" : String(mensuel)); setOk(false); }, [cible, travail, mensuel]);
  const go = () => {
    const fd = new FormData();
    fd.set("cible", cible);
    fd.set("plafondTravailUsd", t);
    fd.set("plafondMensuelUsd", m);
    setOk(false);
    void run(() => enregistrerPlafondsTravaux(fd), () => setOk(true));
  };
  const idT = `plafond-travail-${cible}`;
  const idM = `plafond-mois-${cible}`;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={idT} className="space-y-1 text-xs text-muted-foreground">
        <span className="block">Par travail ($)</span>
        <Input id={idT} inputMode="decimal" value={t} onChange={(e) => setT(e.target.value)} placeholder={defauts ? `défaut : ${defauts.travailUsd}` : ""} className="h-9 w-32" />
      </label>
      <label htmlFor={idM} className="space-y-1 text-xs text-muted-foreground">
        <span className="block">Par mois ($)</span>
        <Input id={idM} inputMode="decimal" value={m} onChange={(e) => setM(e.target.value)} placeholder={defauts ? `défaut : ${defauts.mensuelUsd}` : ""} className="h-9 w-32" />
      </label>
      <Button type="button" size="sm" onClick={go} disabled={saving}>{saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Enregistrer</Button>
      {ok && !err && <span className="text-xs text-success">Enregistré.</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}

function Legende() {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><Minus className="h-3.5 w-3.5" /> Défaut : droits de la personne (salaires et contrats fermés)</span>
      <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" /> Ouverte par la Direction</span>
      <span className="inline-flex items-center gap-1 text-destructive"><X className="h-3.5 w-3.5" /> Fermée par la Direction</span>
    </div>
  );
}

function ParRole({ roles }: { roles: LigneRole[] }) {
  const [etat, setEtat] = React.useState<Record<string, ReglageFamilles>>(() => Object.fromEntries(roles.map((r) => [r.role, r.reglage])));
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Par rôle — le défaut de ses membres</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Legende />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Rôle</th>
                {FAMILLES_IA.map((f) => <th key={f} className="px-1 py-2 text-center font-medium" title={AIDE_FAMILLE[f]}>{LIBELLE_FAMILLE[f]}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.role} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{r.libelle}</td>
                  {FAMILLES_IA.map((f) => (
                    <td key={f} className="px-1 py-2 text-center">
                      <TroisEtats libelle={`${r.libelle} — ${LIBELLE_FAMILLE[f]}`} etat={etatDe(etat[r.role]!, f)} onChange={(e) => setEtat({ ...etat, [r.role]: avec(etat[r.role]!, f, e) })} />
                    </td>
                  ))}
                  <td className="py-2 pl-2 text-right"><Enregistrer cible={`role:${r.role}`} reglage={etat[r.role]!} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ParPersonne({ personnes, plafondsGlobaux }: { personnes: LignePersonne[]; plafondsGlobaux: { travailUsd: number; mensuelUsd: number } }) {
  const [q, setQ] = React.useState("");
  const [choisie, setChoisie] = React.useState<string | null>(null);
  const [reglage, setReglage] = React.useState<ReglageFamilles>({ ouvertes: [], fermees: [] });
  const p = personnes.find((x) => x.id === choisie) ?? null;
  const filtre = q.trim().toLowerCase();
  const liste = personnes.filter((x) => !filtre || x.nom.toLowerCase().includes(filtre) || x.email.toLowerCase().includes(filtre) || x.role.toLowerCase().includes(filtre));
  const effectif = p ? resoudreAccesIa({ superAdmin: false, droits: p.droits, role: p.reglageRole, personne: reglage }).ouvertes : [];
  const choisir = (x: LignePersonne) => { setChoisie(x.id); setReglage(x.reglage); };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Par personne — prime sur son rôle</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, e-mail ou rôle…" className="pl-8" />
          </div>
          <ul className="max-h-[420px] overflow-y-auto rounded-md border">
            {liste.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => choisir(x)} className={`w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ${choisie === x.id ? "bg-primary/10" : ""}`}>
                  <span className="block font-medium">{x.nom}</span>
                  <span className="block text-xs text-muted-foreground">
                    {x.role}{x.reglage.ouvertes.length + x.reglage.fermees.length > 0 ? " · réglage personnel" : ""}
                  </span>
                </button>
              </li>
            ))}
            {!liste.length && <li className="px-3 py-2 text-sm text-muted-foreground">Personne ne correspond.</li>}
          </ul>
        </div>
        {p ? (
          <div className="space-y-3">
            <div>
              <p className="font-medium">{p.nom}</p>
              <p className="text-xs text-muted-foreground">{p.role} · {p.email}</p>
            </div>
            <Legende />
            <div className="divide-y rounded-md border">
              {FAMILLES_IA.map((f) => {
                const ouverte = effectif.includes(f);
                const defaut = FAMILLES_SENSIBLES.has(f) ? "fermée (famille sensible)" : p.droits[f] ? "ouverte (droit de l'application)" : "fermée (pas de droit dans l'application)";
                const parRole = etatDe(p.reglageRole, f);
                return (
                  <div key={f} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{LIBELLE_FAMILLE[f]}</p>
                      <p className="text-xs text-muted-foreground">
                        {AIDE_FAMILLE[f]} Défaut : {defaut}{parRole !== "DEFAUT" ? ` ; son rôle : ${parRole === "OUVERTE" ? "ouverte" : "fermée"}` : ""}.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ouverte ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                        {ouverte ? "Ouverte" : "Fermée"}
                      </span>
                      <TroisEtats libelle={`${p.nom} — ${LIBELLE_FAMILLE[f]}`} etat={etatDe(reglage, f)} onChange={(e) => setReglage(avec(reglage, f, e))} />
                    </div>
                  </div>
                );
              })}
            </div>
            <Enregistrer cible={`user:${p.id}`} reglage={reglage} />
            <div className="space-y-2 rounded-md border px-3 py-3">
              <p className="text-sm font-medium">Plafonds de dépense de ses travaux</p>
              <p className="text-xs text-muted-foreground">Vide : le défaut ({plafondsGlobaux.travailUsd} $ par travail, {plafondsGlobaux.mensuelUsd} $ par mois).</p>
              <Plafonds cible={`user:${p.id}`} travail={p.plafonds.travailUsd} mensuel={p.plafonds.mensuelUsd} defauts={plafondsGlobaux} />
            </div>
          </div>
        ) : (
          <p className="self-center text-sm text-muted-foreground">Choisissez une personne pour voir ce que l&apos;assistant peut faire pour elle, et le régler.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** L'état d'un réglage qui s'enregistre : en cours, enregistré, ou l'erreur dite. */
function EtatEnregistrement({ saving, ok, err }: { saving: boolean; ok: boolean; err: string | null }) {
  return (
    <>
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {ok && !err && <span className="text-xs text-success">Enregistré.</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </>
  );
}

/**
 * J8 (décision 0023) — UN RESPONSABLE VOIT-IL LES TRAVAUX DE SON ÉQUIPE ? Défaut : non. Oui : en lecture seule, le
 * résumé et les étapes (jamais le carnet), et chaque consultation est enregistrée à l'audit.
 */
function VisibiliteEquipe({ initial }: { initial: boolean }) {
  const { saving, err, run } = useAction();
  const [voit, setVoit] = React.useState(initial);
  const [ok, setOk] = React.useState(false);
  const basculer = (v: boolean) => {
    const fd = new FormData();
    fd.set("managerVoitEquipe", v ? "true" : "false");
    setOk(false);
    void run(() => enregistrerVisibiliteEquipe(fd), () => { setVoit(v); setOk(true); });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={voit} disabled={saving} onChange={(e) => basculer(e.target.checked)} className="h-4 w-4" />
        Un responsable voit les travaux de son équipe
      </label>
      <EtatEnregistrement saving={saving} ok={ok} err={err} />
    </div>
  );
}

/** J7 (décision 0029) — combien de jours un geste de l'assistant reste annulable (journal des effets). */
function RetentionEffets({ initial }: { initial: number }) {
  const { saving, err, run } = useAction();
  const [jours, setJours] = React.useState(String(initial));
  const [ok, setOk] = React.useState(false);
  const enregistrer = () => {
    const fd = new FormData();
    fd.set("retentionEffetsJours", jours);
    setOk(false);
    void run(() => enregistrerRetentionEffets(fd), () => setOk(true));
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="inline-flex items-center gap-2 text-sm">
        Garder le journal
        <input type="number" min={7} max={1095} value={jours} onChange={(e) => setJours(e.target.value)} className="h-10 w-24 rounded-md border px-2 text-base sm:text-sm" />
        jours
      </label>
      <button type="button" onClick={enregistrer} disabled={saving} className="h-10 rounded-md border px-3 text-sm">Enregistrer</button>
      <EtatEnregistrement saving={saving} ok={ok} err={err} />
    </div>
  );
}

/** K3 (décision 0033) : « démarrer d'office les travaux sans geste », par rôle — défaut, oui, non. */
function DOfficeParRole({ roles }: { roles: LigneRole[] }) {
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState<string | null>(null);
  const [valeurs, setValeurs] = React.useState<Record<string, string>>(() => Object.fromEntries(roles.map((r) => [r.role, r.dOffice === true ? "oui" : r.dOffice === false ? "non" : ""])));
  const changer = (role: string, v: string) => {
    setValeurs((x) => ({ ...x, [role]: v }));
    const fd = new FormData();
    fd.set("cible", `role:${role}`);
    fd.set("valeur", v);
    setOk(null);
    void run(() => enregistrerTravauxDOffice(fd), () => setOk(role));
  };
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map((r) => (
        <label key={r.role} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
          <span className="min-w-0 truncate">{r.libelle}</span>
          <select value={valeurs[r.role] ?? ""} disabled={saving} onChange={(e) => changer(r.role, e.target.value)} aria-label={`Démarrage d'office — ${r.libelle}`}
            className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">Défaut (non)</option>
            <option value="oui">Oui</option>
            <option value="non">Non</option>
          </select>
          {ok === r.role && !err && <span className="sr-only">Enregistré.</span>}
        </label>
      ))}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

export function AccesAssistantIaForm({ roles, personnes, plafondsGlobaux, managerVoitEquipe, retentionEffetsJours }: {
  roles: LigneRole[]; personnes: LignePersonne[]; plafondsGlobaux: { travailUsd: number; mensuelUsd: number }; managerVoitEquipe: boolean; retentionEffetsJours: number;
}) {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle className="text-base">Travaux longs — plafonds de dépense par défaut</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Un travail confié à l&apos;assistant tourne en arrière-plan jusqu&apos;à son livrable. Atteint, son plafond — ou celui de la
            personne sur le mois — le met en <strong>sommeil</strong> : rien n&apos;est perdu, il reprend seul quand le plafond le permet.
            Chaque personne peut avoir les siens (ci-dessous).
          </p>
          <Plafonds cible="global" travail={plafondsGlobaux.travailUsd} mensuel={plafondsGlobaux.mensuelUsd} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Sous-missions — démarrer d&apos;office les travaux sans geste</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Un plan qui ne fait que lire, analyser et déposer un livrable dans le Drive de la personne peut démarrer sans clic : la
            conversation continue pendant qu&apos;il tourne. Tout plan avec un geste, une demande à un collègue ou une attente reste
            approuvé à la main. Défaut : oui pour le Super Admin, non pour les autres ; chacun peut changer le sien dans ses réglages.
          </p>
          <DOfficeParRole roles={roles} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Travaux de l&apos;équipe</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Par défaut, chacun ne voit que ses travaux. Activé, un responsable voit ceux des personnes de son équipe (ligne hiérarchique
            de l&apos;organigramme) : en lecture seule, le résumé et les étapes — jamais le carnet ni les livrables. Chaque consultation
            est enregistrée à l&apos;audit.
          </p>
          <VisibiliteEquipe initial={managerVoitEquipe} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Journal des effets — annuler un geste de l&apos;assistant</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Chaque geste de l&apos;assistant (carte confirmée, étape d&apos;un travail, geste sous mandat) garde la valeur d&apos;avant de ce qu&apos;il
            a écrit : la personne peut l&apos;annuler depuis « Ce que l&apos;assistant a fait ». Au-delà de cette durée, le journal est purgé
            et le geste ne s&apos;annule plus.
          </p>
          <RetentionEffets initial={retentionEffetsJours} />
        </CardContent>
      </Card>
      <ParPersonne personnes={personnes} plafondsGlobaux={plafondsGlobaux} />
      <ParRole roles={roles} />
    </div>
  );
}
