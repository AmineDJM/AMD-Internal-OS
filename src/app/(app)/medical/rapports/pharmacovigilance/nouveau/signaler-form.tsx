"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { signalerCasPv } from "@/lib/actions/pharmacovigilance-actions";
import { GRAVITES_PV, GRAVITE_PV } from "@/lib/pharmacovigilance/regles";
import { lienCasPvKam } from "@/lib/chemins/rapports-terrain";
import { plier } from "@/lib/utils";

const AUTRE = "__autre__";

/**
 * LE FORMULAIRE DE SIGNALEMENT (Direction, 06/10) — pensé pour le téléphone, en visite : produit (ses produits
 * d'abord, recherche), hôpital (recherche dans l'annuaire), date, ce qui s'est passé ; gravité, patient et pièces
 * (photos d'une boîte, d'un lot, un compte rendu) facultatifs. Un produit ou un établissement absent se saisit.
 */
export function SignalerCasForm({ produits, etablissements, aujourdhui, initial }: {
  produits: { id: string; nom: string; bu: string | null; mien: boolean }[];
  etablissements: { id: string; nom: string; lieu: string | null }[];
  aujourdhui: string;
  /** Le praticien touché dans le planning : son nom et son établissement arrivent préremplis (relus par le serveur). */
  initial?: { doctorName: string; institutionId: string };
}) {
  const router = useRouter();
  const [qProduit, setQProduit] = React.useState("");
  const [produit, setProduit] = React.useState("");
  const [qEtab, setQEtab] = React.useState("");
  const [etab, setEtab] = React.useState(initial?.institutionId ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [nbFichiers, setNbFichiers] = React.useState(0);

  const produitsFiltres = React.useMemo(() => {
    const q = plier(qProduit.trim());
    return produits.filter((p) => !q || plier(p.nom).includes(q) || (p.bu && plier(p.bu).includes(q))).slice(0, 150);
  }, [produits, qProduit]);
  const miens = produitsFiltres.filter((p) => p.mien);
  const autres = produitsFiltres.filter((p) => !p.mien);
  const etabsFiltres = React.useMemo(() => {
    const q = plier(qEtab.trim());
    return etablissements.filter((e) => !q || plier(e.nom).includes(q) || (e.lieu && plier(e.lieu).includes(q))).slice(0, 150);
  }, [etablissements, qEtab]);

  // Une recherche qui ne laisse qu'un résultat le choisit : au téléphone, c'est un geste de moins.
  React.useEffect(() => { if (produitsFiltres.length === 1 && qProduit.trim()) setProduit(produitsFiltres[0].id); }, [produitsFiltres, qProduit]);
  React.useEffect(() => { if (etabsFiltres.length === 1 && qEtab.trim()) setEtab(etabsFiltres[0].id); }, [etabsFiltres, qEtab]);

  async function envoyer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);
    if (produit === AUTRE) fd.delete("promoProductId");
    if (etab === AUTRE) fd.delete("institutionId");
    setBusy(true);
    const r = await signalerCasPv(fd);
    if (!r.ok || !r.id) { setBusy(false); setErr(r.error ?? "Le signalement n'a pas pu être enregistré."); return; }
    router.push(lienCasPvKam(r.id));
  }

  const champ = "space-y-1.5";
  const libelle = "text-sm font-medium";

  return (
    <form onSubmit={envoyer} className="surface space-y-5 p-4 sm:p-5">
      <div className={champ}>
        <label className={libelle} htmlFor="pv-produit">Produit concerné *</label>
        <Input type="search" enterKeyHint="search" autoComplete="off" value={qProduit} onChange={(e) => setQProduit(e.target.value)} placeholder="Rechercher un produit…" aria-label="Rechercher un produit" />
        <Select id="pv-produit" name="promoProductId" value={produit} onChange={(e) => setProduit(e.target.value)} required>
          <option value="">— Choisir le produit —</option>
          {miens.length > 0 && (
            <optgroup label="Mes produits">
              {miens.map((p) => <option key={p.id} value={p.id}>{p.nom}{p.bu ? ` — ${p.bu}` : ""}</option>)}
            </optgroup>
          )}
          {autres.length > 0 && (
            <optgroup label={miens.length > 0 ? "Autres produits" : "Produits"}>
              {autres.map((p) => <option key={p.id} value={p.id}>{p.nom}{p.bu ? ` — ${p.bu}` : ""}</option>)}
            </optgroup>
          )}
          <option value={AUTRE}>Autre produit (saisir le nom)</option>
        </Select>
        {produit === AUTRE && <Input name="produitAutre" required placeholder="Nom du produit (DCI, dosage…)" aria-label="Nom du produit" />}
      </div>

      <div className={champ}>
        <label className={libelle} htmlFor="pv-etab">Hôpital / établissement *</label>
        <Input type="search" enterKeyHint="search" autoComplete="off" value={qEtab} onChange={(e) => setQEtab(e.target.value)} placeholder="Rechercher dans l'annuaire (nom, ville, wilaya)…" aria-label="Rechercher un établissement" />
        <Select id="pv-etab" name="institutionId" value={etab} onChange={(e) => setEtab(e.target.value)} required>
          <option value="">— Choisir l&apos;établissement —</option>
          {etabsFiltres.map((x) => <option key={x.id} value={x.id}>{x.nom}{x.lieu ? ` — ${x.lieu}` : ""}</option>)}
          <option value={AUTRE}>Autre établissement (saisir le nom)</option>
        </Select>
        {etab === AUTRE && <Input name="etablissementAutre" required placeholder="Nom de l'établissement, ville" aria-label="Nom de l'établissement" />}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className={champ}>
          <label className={libelle} htmlFor="pv-date">Date de survenue *</label>
          <Input id="pv-date" type="date" name="occurredOn" defaultValue={aujourdhui} max={aujourdhui} required />
        </div>
        <div className={champ}>
          <label className={libelle} htmlFor="pv-gravite">Gravité</label>
          <Select id="pv-gravite" name="severity" defaultValue="">
            <option value="">Non précisée</option>
            {GRAVITES_PV.map((g) => <option key={g} value={g}>{GRAVITE_PV[g].label}</option>)}
          </Select>
        </div>
      </div>

      <div className={champ}>
        <label className={libelle} htmlFor="pv-description">Ce qui s&apos;est passé *</label>
        <Textarea
          id="pv-description" name="description" required minLength={10} className="min-h-[140px]"
          placeholder="L'événement observé, quand il est apparu après la prise, la posologie, l'évolution, ce qui a été fait…"
        />
      </div>

      {/* Au téléphone, l'âge et le sexe se partagent une ligne : deux petits champs, un seul coup d'œil. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <div className={`${champ} col-span-2 sm:col-span-1`}>
          <label className={libelle} htmlFor="pv-medecin">Médecin (facultatif)</label>
          <Input id="pv-medecin" name="doctorName" autoComplete="off" placeholder="Dr …" defaultValue={initial?.doctorName ?? ""} />
        </div>
        <div className={champ}>
          <label className={libelle} htmlFor="pv-age">Âge du patient</label>
          <Input id="pv-age" name="patientAge" type="number" inputMode="numeric" min={0} max={120} placeholder="—" />
        </div>
        <div className={champ}>
          <label className={libelle} htmlFor="pv-sexe">Sexe du patient</label>
          <Select id="pv-sexe" name="patientSex" defaultValue="">
            <option value="">Non précisé</option>
            <option value="F">Femme</option>
            <option value="M">Homme</option>
          </Select>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">Aucun nom ni donnée permettant d&apos;identifier le patient.</p>

      <div className={champ}>
        <label className={`${libelle} flex items-center gap-1.5`} htmlFor="pv-pieces"><Paperclip className="h-4 w-4" /> Pièces jointes (photos, documents)</label>
        <input
          id="pv-pieces" name="files" type="file" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
          onChange={(e) => setNbFichiers(e.target.files?.length ?? 0)}
          className="block w-full min-w-0 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:py-2.5 file:text-sm file:font-medium sm:file:min-h-0 sm:file:px-3 sm:file:py-2"
        />
        {nbFichiers > 0 && <p className="text-xs text-muted-foreground">{nbFichiers} fichier{nbFichiers > 1 ? "s" : ""} sélectionné{nbFichiers > 1 ? "s" : ""}.</p>}
      </div>

      {err && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      {/* TÉLÉPHONE : l'envoi colle au bas de l'écran pendant toute la saisie, sous le pouce. */}
      <div className="sticky bottom-2 z-10 -mx-2 rounded-xl border border-border bg-card/95 p-2 shadow-md backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
        <Button type="submit" disabled={busy} className="h-12 w-full sm:h-10 sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />} Signaler à Regulatory
        </Button>
      </div>
    </form>
  );
}
