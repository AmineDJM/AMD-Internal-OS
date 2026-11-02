"use client";

import * as React from "react";
import { Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  accorderDroitDateIa, apercuAssistantDe, enregistrerAvenantIa, revoquerAvenantIa, revoquerDroitDateIa,
} from "@/modules/assistant-ia/actions-consommation";
import {
  FAMILLES_IA, FAMILLES_SENSIBLES, LIBELLE_FAMILLE, LIBELLE_ORIGINE, type ApercuAssistant, type FamilleIa,
} from "@/modules/assistant-ia/partage";
import type { LignePersonne } from "./acces-form";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * S1 (décision 0048) — « CE QUE SON ASSISTANT VOIT » : pour UNE personne, le profil que l'assistant reçoit (la consigne
 * exacte), ses familles et l'ORIGINE de chacune (défaut des droits, réglage du rôle, réglage de la personne, avenant,
 * droit daté), ses périmètres sur les données d'autrui, ses avenants et droits datés — calculés par le moteur lui-même.
 */
type Origine = keyof typeof LIBELLE_ORIGINE;

function origineDe(f: FamilleIa, p: LignePersonne, a: ApercuAssistant): { ouverte: boolean; origine: Origine } {
  const ouverte = a.profil.famillesOuvertes.includes(f);
  const parPerimetre = a.profil.perimetres.find((x) => x.famille === f);
  if (p.reglage.fermees.includes(f)) return { ouverte, origine: "REGLAGE_PERSONNE" };
  if (p.reglage.ouvertes.includes(f)) return { ouverte, origine: "REGLAGE_PERSONNE" };
  if (parPerimetre) return { ouverte, origine: parPerimetre.origine };
  if (p.reglageRole.ouvertes.includes(f) || p.reglageRole.fermees.includes(f)) return { ouverte, origine: "REGLAGE_ROLE" };
  return { ouverte, origine: "DEFAUT" };
}

export function AssistantDeLaPersonne({ personnes }: { personnes: LignePersonne[] }) {
  const [id, setId] = React.useState("");
  const [apercu, setApercu] = React.useState<ApercuAssistant | null>(null);
  const [charge, setCharge] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const personne = personnes.find((p) => p.id === id) ?? null;

  const charger = React.useCallback(async (cible: string) => {
    if (!cible) { setApercu(null); return; }
    setCharge(true);
    setErreur(null);
    try {
      const r = await apercuAssistantDe(cible);
      if (r.ok) setApercu(r.apercu); else { setApercu(null); setErreur(r.error); }
    } catch {
      setErreur("Lecture impossible. Réessayez.");
    } finally {
      setCharge(false);
    }
  }, []);

  const agir = async (f: () => Promise<{ ok: boolean; error?: string }>) => {
    setErreur(null);
    try {
      const r = await f();
      if (!r.ok) setErreur(r.error ?? actionFailureMessage("THROWN"));
    } catch {
      // Un échec n'est pas un refus : le geste a pu aboutir — la liste, relue ci-dessous, le dit.
      setErreur(actionFailureMessage("THROWN"));
    }
    await charger(id);
  };
  const soumettre = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>) => async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const fd = new FormData(form);
    fd.set("userId", id);
    await agir(() => action(fd));
    form.reset();
  };
  const entite = (cid: string | null) => (cid ? apercu?.entites.find((e) => e.id === cid)?.nom ?? "entité" : "entités qui lui sont ouvertes");

  return (
    <Card data-testid="assistant-de-la-personne">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4" /> Ce que son assistant voit</CardTitle>
        <p className="text-sm text-muted-foreground">
          Pour une personne : à qui son assistant croit parler, ce qu&apos;il peut ouvrir, et d&apos;où vient chaque accès. Par défaut,
          chacun ne voit que ses propres données ; une donnée sensible d&apos;autrui ne s&apos;ouvre que par le droit de son rôle dans
          l&apos;application, un avenant de délégation daté, ou un droit daté accordé ici — jamais par un réglage de rôle.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <select
          aria-label="Personne" value={id}
          onChange={(e) => { setId(e.target.value); void charger(e.target.value); }}
          className="h-9 w-full max-w-md rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Choisir une personne…</option>
          {personnes.map((p) => <option key={p.id} value={p.id}>{p.nom} — {p.role}</option>)}
        </select>
        {charge && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Calcul par le moteur…</p>}
        {erreur && <p role="alert" className="text-sm text-destructive">{erreur}</p>}

        {apercu && personne && (
          <div className="space-y-4">
            {!apercu.assistantOuvert && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm">L&apos;Assistant IA n&apos;est pas ouvert à cette personne (Administration › Accès).</p>
            )}
            <section>
              <h3 className="mb-1 text-sm font-semibold">Profil reçu par l&apos;assistant</h3>
              <pre data-testid="consigne-profil" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 text-[12px] leading-relaxed">{apercu.consigne}</pre>
            </section>

            <section>
              <h3 className="mb-1 text-sm font-semibold">Familles et leur origine</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-normal">Famille</th><th className="py-1 pr-3 font-normal">État</th><th className="py-1 font-normal">Origine</th></tr></thead>
                  <tbody>
                    {FAMILLES_IA.map((f) => {
                      const o = origineDe(f, personne, apercu);
                      return (
                        <tr key={f} className="border-t">
                          <td className="py-1 pr-3">{LIBELLE_FAMILLE[f]}{FAMILLES_SENSIBLES.has(f) ? " · sensible" : ""}</td>
                          <td className={`py-1 pr-3 ${o.ouverte ? "text-success" : "text-muted-foreground"}`}>{o.ouverte ? "ouverte" : "fermée"}</td>
                          <td className="py-1">{LIBELLE_ORIGINE[o.origine]}{FAMILLES_SENSIBLES.has(f) && o.ouverte ? " — pour soi ; autrui seulement par un périmètre ci-dessous" : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-sm font-semibold">Périmètres sur les données d&apos;autrui (en vigueur)</h3>
              {apercu.profil.superAdmin ? <p className="text-sm">Super Admin : tout.</p> : apercu.profil.perimetres.length === 0
                ? <p className="text-sm text-muted-foreground">Aucun — hors droit applicatif de son rôle, rien d&apos;une autre personne.</p>
                : (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm">
                    {apercu.profil.perimetres.map((x) => (
                      <li key={`${x.origine}-${x.ref}`}>« {LIBELLE_FAMILLE[x.famille]} » — {entite(x.companyId)} · {LIBELLE_ORIGINE[x.origine]}{x.au ? `, jusqu'au ${x.au.slice(0, 10)}` : ""} · motif : {x.motif}</li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Droits datés de la console</h3>
              <ul className="space-y-1 text-sm">
                {apercu.droits.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <span className={d.revoqueLe ? "text-muted-foreground line-through" : ""}>
                      « {estFamille(d.famille) ? LIBELLE_FAMILLE[d.famille] : d.famille} » — {entite(d.companyId)} · du {d.du}{d.au ? ` au ${d.au}` : ", sans fin"} · {d.motif}
                    </span>
                    {!d.revoqueLe && <Button type="button" size="sm" variant="outline" onClick={() => void agir(() => revoquerDroitDateIa(d.id))}>Révoquer</Button>}
                  </li>
                ))}
              </ul>
              <form onSubmit={soumettre(accorderDroitDateIa)} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
                <select name="famille" aria-label="Famille du droit" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2">
                  {[...FAMILLES_SENSIBLES].map((f) => <option key={f} value={f}>{LIBELLE_FAMILLE[f]}</option>)}
                </select>
                <select name="companyId" aria-label="Entité du droit" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2">
                  <option value="">Entités qui lui sont ouvertes</option>
                  {apercu.entites.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
                </select>
                <Input name="du" type="date" aria-label="Du" required />
                <Input name="au" type="date" aria-label="Au" />
                <Input name="motif" placeholder="Motif (écrit au journal à chaque lecture)" aria-label="Motif du droit" required className="sm:col-span-5" />
                <Button type="submit" size="sm">Accorder</Button>
              </form>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Avenants au contrat</h3>
              {!apercu.profil.fiche && <p className="text-sm text-muted-foreground">Aucune fiche RH liée : un avenant suit un contrat — liez d&apos;abord la fiche.</p>}
              <ul className="space-y-1 text-sm">
                {apercu.avenants.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className={a.revoqueLe ? "text-muted-foreground line-through" : ""}>
                      {a.objet === "FONCTION" ? `Fonction : ${a.fonction ?? "—"}` : `Délégation « ${a.famille && estFamille(a.famille) ? LIBELLE_FAMILLE[a.famille] : a.famille} » — ${entite(a.companyId)}`} · du {a.effetLe}{a.finLe ? ` au ${a.finLe}` : ""} · {a.motif}
                    </span>
                    {!a.revoqueLe && <Button type="button" size="sm" variant="outline" onClick={() => void agir(() => revoquerAvenantIa(a.id))}>Révoquer</Button>}
                  </li>
                ))}
              </ul>
              {apercu.profil.fiche && (
                <form onSubmit={soumettre(enregistrerAvenantIa)} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
                  <select name="objet" aria-label="Objet de l'avenant" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2">
                    <option value="DELEGATION">Délégation d&apos;une famille</option>
                    <option value="FONCTION">Changement de fonction</option>
                  </select>
                  <select name="famille" aria-label="Famille déléguée" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2">
                    {FAMILLES_IA.map((f) => <option key={f} value={f}>{LIBELLE_FAMILLE[f]}</option>)}
                  </select>
                  <select name="companyId" aria-label="Entité déléguée" className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-2">
                    <option value="">Entité (obligatoire pour une délégation)</option>
                    {apercu.entites.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
                  </select>
                  <Input name="fonction" placeholder="Nouvelle fonction (changement de fonction)" aria-label="Fonction" className="sm:col-span-2" />
                  <Input name="effetLe" type="date" aria-label="Date d'effet" required />
                  <Input name="finLe" type="date" aria-label="Fin" />
                  <Input name="motif" placeholder="Motif / référence de l'avenant" aria-label="Motif de l'avenant" required className="sm:col-span-5" />
                  <Button type="submit" size="sm">Enregistrer</Button>
                </form>
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const estFamille = (f: string): f is FamilleIa => (FAMILLES_IA as readonly string[]).includes(f);
