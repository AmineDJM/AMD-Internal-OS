"use client";

import * as React from "react";
import { FileSignature, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { genererCertificatDeTravail, enregistrerCertificatDeTravail } from "@/modules/rh/actions-depart";
// Les RÈGLES pures du certificat (aucun import lourd) : le texte se recompose ici comme au serveur.
import { CIVILITES, corpsCertificatParDefaut, type ChampsCertificat } from "@/modules/rh/partage";
import type { ActionResult } from "@/lib/actions/types";

type Cle = Exclude<keyof ChampsCertificat, "corps" | "civilite" | "signataireCivilite">;
const CHAMPS: { cle: Cle; label: string; type?: string }[] = [
  { cle: "salarie", label: "Salarié" },
  { cle: "dateNaissance", label: "Né(e) le", type: "date" },
  { cle: "lieuNaissance", label: "À" },
  { cle: "poste", label: "Poste" },
  { cle: "dateEmbauche", label: "Embauché(e) le", type: "date" },
  { cle: "dateFin", label: "Dernier jour", type: "date" },
  { cle: "societe", label: "Société (texte)" },
  { cle: "societeSignature", label: "Pour (signature)" },
  { cle: "signataire", label: "Signataire" },
  { cle: "signataireFonction", label: "Fonction du signataire" },
  { cle: "lieuSignature", label: "Fait à" },
  { cle: "dateSignature", label: "Le", type: "date" },
  { cle: "reference", label: "Référence (vide : registre)" },
];

/**
 * LE CERTIFICAT DE TRAVAIL (lot rhdepart) — prérempli à l'accord final, affiché, TOUT modifiable : chaque champ et le
 * texte lui-même. « Recomposer le texte » le réécrit depuis les champs ; « Émettre » produit le Word et le PDF sur le
 * papier de la société, rangés au dossier RH (le PDF remis au salarié). Réémettre = une nouvelle version.
 */
export function DepartCertificat({ departId, champs: initiaux, emisLe, reference, peutAgir }: {
  departId: string; champs: ChampsCertificat; emisLe: string | null; reference: string | null; peutAgir: boolean;
}) {
  const { busy, error, run } = useKeyedAction();
  const [c, setC] = React.useState<ChampsCertificat>(initiaux);
  const [msg, setMsg] = React.useState<string | null>(null);
  React.useEffect(() => { setC(initiaux); }, [initiaux]);
  const maj = (p: Partial<ChampsCertificat>) => setC((x) => ({ ...x, ...p }));
  const envoyer = (cle: string, fn: (fd: FormData) => Promise<ActionResult>) => {
    const fd = new FormData(); fd.set("departId", departId); fd.set("champs", JSON.stringify(c));
    void run(cle, async () => { const r = await fn(fd); if (r.ok) setMsg(r.message ?? null); return r; });
  };

  return (
    <section className="space-y-2">
      <h3 className="font-semibold">
        Certificat de travail
        {emisLe && <span className="text-xs font-normal text-muted-foreground"> · émis le {emisLe}{reference ? ` (réf. ${reference})` : ""} — dans les documents RH</span>}
      </h3>
      <fieldset disabled={!peutAgir} className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="cert-civilite">Civilité</Label>
            <Select id="cert-civilite" value={c.civilite} onChange={(e) => maj({ civilite: e.target.value as ChampsCertificat["civilite"] })}>
              <option value="">—</option>{CIVILITES.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
          {CHAMPS.map((f) => (
            <div key={f.cle} className="space-y-1">
              <Label htmlFor={`cert-${f.cle}`}>{f.label}</Label>
              <Input id={`cert-${f.cle}`} type={f.type ?? "text"} value={c[f.cle]} onChange={(e) => maj({ [f.cle]: e.target.value } as Partial<ChampsCertificat>)} />
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="cert-sigciv">Civilité du signataire</Label>
            <Select id="cert-sigciv" value={c.signataireCivilite} onChange={(e) => maj({ signataireCivilite: e.target.value as ChampsCertificat["signataireCivilite"] })}>
              <option value="">—</option>{CIVILITES.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="cert-corps">Texte du certificat</Label>
            <Button type="button" size="sm" variant="ghost" onClick={() => maj({ corps: corpsCertificatParDefaut(c) })}>
              <RotateCcw className="h-4 w-4" /> Recomposer le texte
            </Button>
          </div>
          <Textarea id="cert-corps" rows={6} value={c.corps} onChange={(e) => maj({ corps: e.target.value })} />
        </div>
        {peutAgir && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => envoyer("brouillon", enregistrerCertificatDeTravail)}>Enregistrer le brouillon</Button>
            <BoutonDecisif type="button" size="sm" disabled={!!busy} onClick={() => envoyer("emettre", genererCertificatDeTravail)}>
              <FileSignature className="h-4 w-4" /> {emisLe ? "Réémettre (nouvelle version)" : "Émettre le certificat"}
            </BoutonDecisif>
          </div>
        )}
      </fieldset>
      {msg && <Retour ton="succes" onFermer={() => setMsg(null)}>{msg}</Retour>}
      <Retour>{error}</Retour>
    </section>
  );
}
