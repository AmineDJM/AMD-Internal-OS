"use client";

import * as React from "react";
import { Check, Loader2, Minus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/components/shared/use-action";
import { enregistrerAccesAssistantIa } from "@/lib/actions/assistant-ia-consommation-actions";
import {
  AIDE_FAMILLE, FAMILLES_IA, FAMILLES_SENSIBLES, LIBELLE_FAMILLE, resoudreAccesIa, type FamilleIa, type ReglageFamilles,
} from "@/lib/agent/acces-regles";

export interface LigneRole { role: string; libelle: string; reglage: ReglageFamilles }
export interface LignePersonne {
  id: string; nom: string; email: string; role: string;
  droits: Record<FamilleIa, boolean>;
  reglageRole: ReglageFamilles;
  reglage: ReglageFamilles;
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

function ParPersonne({ personnes }: { personnes: LignePersonne[] }) {
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
          </div>
        ) : (
          <p className="self-center text-sm text-muted-foreground">Choisissez une personne pour voir ce que l&apos;assistant peut faire pour elle, et le régler.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AccesAssistantIaForm({ roles, personnes }: { roles: LigneRole[]; personnes: LignePersonne[] }) {
  return (
    <div className="space-y-5">
      <ParPersonne personnes={personnes} />
      <ParRole roles={roles} />
    </div>
  );
}
