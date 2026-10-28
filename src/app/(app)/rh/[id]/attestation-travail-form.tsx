"use client";

import * as React from "react";
import { FileSignature, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { ChampReference } from "@/components/references/champ-reference";
import { genererAttestationDeTravail, preparerAttestationDeTravail } from "@/modules/rh/actions-documents";
// Le module de RÈGLES, sans aucun import : le formulaire ne tire ni le modèle Word (jszip) ni le serveur.
import {
  CIVILITES, LIBELLE_PROVENANCE, phraseNaissance, accords, dateLongueFr, dateCourteFr,
  type ChampsAttestation, type ProvenanceChamp,
} from "@/modules/rh/partage";
import { cn } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

type Preparation = Extract<Awaited<ReturnType<typeof preparerAttestationDeTravail>>, { ok: true }>;

/**
 * « GÉNÉRER L'ATTESTATION » (Direction, 10/2026) — sur la demande d'attestation de travail du salarié, côté RH, comme
 * l'ordre de mission. Le formulaire s'ouvre PRÉREMPLI (fiche RH, puis ce que Luna a lu dans le contrat de travail —
 * chaque valeur dit d'où elle vient) ; tout reste modifiable. Le SIGNATAIRE se choisit à la fin, dans la liste des
 * personnes (sa fonction suit, modifiable). « Fait à Alger le » : aujourd'hui, à l'heure d'Alger.
 */
export function AttestationTravailForm({ requestId, details, dejaGeneree = false }: {
  requestId: string; details: string | null;
  /** Une version existe déjà : le bouton dit « nouvelle version ». */
  dejaGeneree?: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [prep, setPrep] = React.useState<Preparation | null>(null);
  const [chargement, setChargement] = React.useState(false);
  const [champs, setChamps] = React.useState<ChampsAttestation | null>(null);
  const [modifies, setModifies] = React.useState<Set<keyof ChampsAttestation>>(new Set());
  const [signataireId, setSignataireId] = React.useState("");
  const [garderRef, setGarderRef] = React.useState(false);
  const [refRefusee, setRefRefusee] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const ouvrir = async () => {
    setOuvert(true); setChargement(true); setMsg(null);
    const fd = new FormData(); fd.set("requestId", requestId);
    const r = await preparerAttestationDeTravail(fd).catch(sansBloquer("attestation-travail-form.ouvrir.preparerAttestationDeTravail", { ok: false as const, error: "Le préremplissage a échoué." }));
    setChargement(false);
    if (!r.ok) { setMsg({ ok: false, texte: r.error }); return; }
    setPrep(r);
    setChamps(r.champs);
    setModifies(new Set());
    setGarderRef(Boolean(r.referenceExistante));
    const connu = r.signataires.find((s) => s.nom.trim().toLowerCase() === r.champs.signataire.trim().toLowerCase());
    setSignataireId(connu?.id ?? "");
  };

  if (!ouvert) {
    return (
      <div className="space-y-1">
        <Button size="sm" variant={dejaGeneree ? "outline" : "primary"} onClick={ouvrir}>
          <FileSignature className="h-4 w-4" /> {dejaGeneree ? "Régénérer l'attestation (nouvelle version)" : "Générer l'attestation"}
        </Button>
        {msg?.ok && <p className="text-xs text-success [overflow-wrap:anywhere]">{msg.texte}</p>}
      </div>
    );
  }
  if (chargement || !prep || !champs) {
    return (
      <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        {chargement
          ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préremplissage — fiche RH et contrat de travail…</p>
          : msg && <p className="text-xs text-destructive">{msg.texte}</p>}
        {!chargement && <Button size="sm" variant="ghost" onClick={() => setOuvert(false)}>Fermer</Button>}
      </div>
    );
  }

  const maj = (k: keyof ChampsAttestation, v: string) => {
    setChamps((c) => (c ? { ...c, [k]: v } : c));
    setModifies((m) => new Set(m).add(k));
  };
  const provenance = (k: keyof ChampsAttestation): ProvenanceChamp | "modifie" => (modifies.has(k) ? "modifie" : prep.provenance[k]);
  const origine = (k: keyof ChampsAttestation) => {
    const p = provenance(k);
    if (p === "defaut") return null;
    const lu = p === "contrat" || p === "luna";
    return (
      <span
        className={cn(
          "ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 text-[11px] font-normal",
          lu && "bg-warning/10 text-warning",
          p === "vide" && "bg-destructive/10 text-destructive",
          (p === "fiche" || p === "societe" || p === "modifie") && "text-muted-foreground",
        )}
      >
        {p === "luna" && <Sparkles className="h-3 w-3" />}
        {p === "modifie" ? "modifié" : LIBELLE_PROVENANCE[p]}
      </span>
    );
  };
  const champ = (k: keyof ChampsAttestation, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`att-${k}-${requestId}`}>{label}{origine(k)}</Label>
      <Input id={`att-${k}-${requestId}`} name={k} value={champs[k]} onChange={(e) => maj(k, e.target.value)} autoComplete="off" {...props} />
    </div>
  );
  const civiliteSelect = (k: "civilite" | "signataireCivilite", label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`att-${k}-${requestId}`}>{label}{origine(k)}</Label>
      <Select id={`att-${k}-${requestId}`} name={k} value={champs[k]} onChange={(e) => maj(k, e.target.value)}>
        <option value="">—</option>
        {CIVILITES.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    </div>
  );
  const choisirSignataire = (id: string) => {
    setSignataireId(id);
    const s = prep.signataires.find((x) => x.id === id);
    if (!s) return;
    setChamps((c) => (c ? { ...c, signataire: s.nom, signataireFonction: s.fonction || c.signataireFonction, signataireCivilite: s.civilite || c.signataireCivilite } : c));
    setModifies((m) => new Set(m).add("signataire").add("signataireFonction").add("signataireCivilite"));
  };
  const registreActif = prep.registre.ok && prep.registre.actif;
  const a = accords(champs.civilite);
  const apercu = `${champs.civilite ? `${champs.civilite} ` : ""}${champs.salarie}${phraseNaissance(champs)} est ${a.employe} au sein de ${champs.societe} en qualité de ${champs.poste} depuis le ${dateCourteFr(champs.dateEmbauche)} à ce jour.`;

  return (
    <form
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("requestId", requestId);
        setBusy(true); setMsg(null);
        const r = await genererAttestationDeTravail(fd).catch(sansBloquer("attestation-travail-form.AttestationTravailForm.genererAttestationDeTravail", { ok: false as const, error: "La génération a échoué.", message: undefined }));
        setBusy(false);
        setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Attestation générée.") : (r.error ?? "L'attestation n'a pas été générée.") });
        if (r.ok) { setOuvert(false); rafraichir(); }
      }}
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium">
          Attestation de travail — sur le papier à en-tête de la société{prep.version > 1 ? ` · version ${prep.version}` : ""}
        </p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {prep.contrat ? `Contrat de travail : « ${prep.contrat.nom} ». ` : ""}{prep.note}
        </p>
      </div>
      {details && <p className="rounded bg-background px-2 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">Demande du salarié : « {details} »</p>}

      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Le salarié</legend>
        {civiliteSelect("civilite", "Civilité")}
        {champ("salarie", "Nom et prénom(s)", { required: true })}
        {champ("dateNaissance", "Date de naissance", { type: "date" })}
        {champ("lieuNaissance", "Lieu de naissance", { placeholder: "Alger" })}
        {champ("poste", "Poste (« en qualité de »)", { required: true })}
        {champ("dateEmbauche", "Date d'embauche (« depuis le »)", { type: "date", required: true })}
        {champ("societe", "Société (dans le texte)", { required: true })}
        {champ("societeSignature", "Société (« Pour … »)")}
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Référence et date</legend>
        {registreActif && garderRef && prep.referenceExistante ? (
          <div className="space-y-1">
            <Label htmlFor={`att-ref-${requestId}`}>Référence (version précédente)</Label>
            <Input id={`att-ref-${requestId}`} name="reference" value={prep.referenceExistante} readOnly />
            <button type="button" onClick={() => setGarderRef(false)} className="inline-flex items-center gap-1 py-1 text-xs text-primary hover:underline sm:py-0">
              <RotateCcw className="h-3 w-3" /> Prendre un nouveau numéro
            </button>
          </div>
        ) : registreActif ? (
          <ChampReference
            label="Référence (N°)" cle={requestId}
            charger={() => Promise.resolve(prep.registre)}
            onChange={(e) => setRefRefusee(e.erreur !== null)}
          />
        ) : (
          champ("reference", "Référence (facultative)", { placeholder: "—" })
        )}
        {champ("lieuSignature", "Fait à", { required: true })}
        {champ("dateSignature", "Le", { type: "date", required: true })}
      </fieldset>

      {/* LE SIGNATAIRE, À LA FIN — « le RH écrit le signataire en le sélectionnant » ; tout reste modifiable. */}
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Le signataire</legend>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`att-choix-${requestId}`}>Choisir dans la liste</Label>
          <Select id={`att-choix-${requestId}`} value={signataireId} onChange={(e) => choisirSignataire(e.target.value)}>
            <option value="">— Sélectionner une personne —</option>
            {prep.signataires.map((s) => <option key={s.id} value={s.id}>{s.nom}{s.fonction ? ` — ${s.fonction}` : ""}</option>)}
          </Select>
        </div>
        {civiliteSelect("signataireCivilite", "Civilité du signataire")}
        {champ("signataire", "Signataire", { required: true })}
        <div className="sm:col-span-2">{champ("signataireFonction", "Fonction du signataire (« agissant en qualité de »)", { required: true })}</div>
      </fieldset>

      <p className="rounded bg-background px-2 py-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span className="font-medium text-foreground">Aperçu : </span>{apercu} Fait à {champs.lieuSignature} le, {dateLongueFr(champs.dateSignature)}.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button size="sm" type="submit" className="w-full sm:w-auto" disabled={busy || enCours || (refRefusee && !garderRef)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />}
          {prep.version > 1 ? " Générer la nouvelle version et la remettre" : " Générer et remettre au salarié"}
        </Button>
        <Button size="sm" type="button" variant="ghost" className="w-full sm:w-auto" onClick={() => setOuvert(false)}>Annuler</Button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.texte}</p>}
    </form>
  );
}
