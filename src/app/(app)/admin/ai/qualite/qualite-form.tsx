"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";
import {
  appliquerModeleRole, enregistrerCalendrierBanc, lancerBancAB, lancerBancMaintenant, revenirModeleRole,
} from "@/modules/assistant-ia/actions-qualite";
import { EFFORTS_MODELE, FREQUENCES, JOURS_SEMAINE, PLAFOND_PASSAGE_MAX_USD, ROLES_MODELE, type ReglageBanc } from "@/modules/assistant-ia/partage";

const LIBELLE_FREQUENCE: Record<string, string> = { QUOTIDIEN: "Chaque jour", HEBDOMADAIRE: "Chaque semaine", MENSUEL: "Chaque mois" };
const LIBELLE_ROLE: Record<string, string> = { rapide: "Rapide (résumés)", standard: "Standard (conversation)", raisonnement: "Raisonnement (analyses, travaux)" };
const champ = "h-9 rounded-md border bg-background px-2 text-sm";

/** Le calendrier du banc programmé : fréquence, jour, heure (Alger), plafond par passage ; désactivable. */
export function CalendrierBancForm({ initial }: { initial: ReglageBanc }) {
  const [r, setR] = React.useState(initial);
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);
  const enregistrer = () => {
    const fd = new FormData();
    fd.set("actif", r.actif ? "true" : "false");
    fd.set("frequence", r.frequence);
    fd.set("jour", String(r.jour));
    fd.set("heure", String(r.heure));
    fd.set("plafondUsd", String(r.plafondUsd));
    setOk(false);
    void run(() => enregistrerCalendrierBanc(fd), () => setOk(true));
  };
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4" checked={r.actif} onChange={(e) => setR({ ...r, actif: e.target.checked })} />
        Banc programmé actif
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="space-y-1 text-sm"><span className="block font-medium">Fréquence</span>
          <select className={champ} value={r.frequence} onChange={(e) => setR({ ...r, frequence: e.target.value as ReglageBanc["frequence"], jour: e.target.value === "MENSUEL" ? 1 : 5 })}>
            {FREQUENCES.map((f) => <option key={f} value={f}>{LIBELLE_FREQUENCE[f]}</option>)}
          </select>
        </label>
        {r.frequence === "HEBDOMADAIRE" && (
          <label className="space-y-1 text-sm"><span className="block font-medium">Jour</span>
            <select className={champ} value={r.jour} onChange={(e) => setR({ ...r, jour: Number(e.target.value) })}>
              {JOURS_SEMAINE.map((j, i) => <option key={j} value={i}>{j}</option>)}
            </select>
          </label>
        )}
        {r.frequence === "MENSUEL" && (
          <label className="space-y-1 text-sm"><span className="block font-medium">Jour du mois</span>
            <Input type="number" min={1} max={28} value={r.jour} onChange={(e) => setR({ ...r, jour: Number(e.target.value) })} />
          </label>
        )}
        <label className="space-y-1 text-sm"><span className="block font-medium">Heure (Alger)</span>
          <Input type="number" min={0} max={23} value={r.heure} onChange={(e) => setR({ ...r, heure: Number(e.target.value) })} />
        </label>
        <label className="space-y-1 text-sm"><span className="block font-medium">Plafond par passage ($)</span>
          <Input type="number" min={0.1} max={PLAFOND_PASSAGE_MAX_USD} step={0.1} value={r.plafondUsd} onChange={(e) => setR({ ...r, plafondUsd: Number(e.target.value) })} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">Atteint, le passage s&apos;arrête : les scénarios restants sont dits « non joués », jamais comptés comme des échecs. Défaut : chaque semaine, 1 $.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={enregistrer} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Enregistrer le calendrier</Button>
        <LancerMaintenant />
        {ok && <span className="text-sm text-emerald-600">Enregistré.</span>}
        {err && <span className="text-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}

function LancerMaintenant() {
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);
  return (
    <>
      <Button variant="outline" disabled={saving} onClick={() => { setOk(false); void run(() => lancerBancMaintenant(), () => setOk(true)); }}>
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lancer un passage maintenant
      </Button>
      {ok && <span className="text-sm text-emerald-600">Demandé : le worker le lance à son prochain battement.</span>}
      {err && <span className="text-sm text-destructive">{err}</span>}
    </>
  );
}

/** Un banc A/B : le candidat tourne à la place du modèle de son rôle, contre la même référence. */
export function BancAbForm() {
  const [role, setRole] = React.useState<string>("standard");
  const [modelId, setModelId] = React.useState("");
  const [effort, setEffort] = React.useState("low");
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState(false);
  const lancer = () => {
    const fd = new FormData();
    fd.set("role", role); fd.set("modelId", modelId.trim()); fd.set("effort", effort);
    setOk(false);
    void run(() => lancerBancAB(fd), () => setOk(true));
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm"><span className="block font-medium">Rôle</span>
          <select className={champ} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES_MODELE.map((r) => <option key={r} value={r}>{LIBELLE_ROLE[r]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm"><span className="block font-medium">Modèle candidat</span>
          <Input placeholder="ex. gpt-6.2-terra" value={modelId} onChange={(e) => setModelId(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm"><span className="block font-medium">Effort de raisonnement</span>
          <select className={champ} value={effort} onChange={(e) => setEffort(e.target.value)}>
            {EFFORTS_MODELE.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={lancer} disabled={saving || !modelId.trim()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lancer le banc A/B</Button>
        {ok && <span className="text-sm text-emerald-600">Demandé. Le changement ne sera possible que si le banc est vert.</span>}
        {err && <span className="text-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}

/** Appliquer un candidat (banc vert) ou revenir au modèle de l'environnement. */
export function GesteModele({ geste, role, modelId, effort }: { geste: "appliquer" | "revenir"; role: string; modelId?: string; effort?: string }) {
  const { saving, err, run } = useAction();
  const go = () => {
    const fd = new FormData();
    fd.set("role", role);
    if (modelId) fd.set("modelId", modelId);
    if (effort) fd.set("effort", effort);
    void run(() => (geste === "appliquer" ? appliquerModeleRole(fd) : revenirModeleRole(fd)), undefined, {
      confirmer: geste === "appliquer" ? `Le rôle « ${role} » passera à ${modelId} (effort ${effort}) pour tous les tours. Confirmer ?` : `Le rôle « ${role} » revient au modèle de l'environnement. Confirmer ?`,
    });
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant={geste === "appliquer" ? "primary" : "outline"} disabled={saving} onClick={go}>
        {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{geste === "appliquer" ? "Appliquer" : "Revenir à l'environnement"}
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}
