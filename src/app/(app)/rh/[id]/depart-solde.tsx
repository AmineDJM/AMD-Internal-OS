"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { enregistrerSoldeDeToutCompte } from "@/modules/rh/actions-depart";
import { totauxSolde, type LigneSolde } from "@/modules/rh/partage";
import { formatCurrency } from "@/lib/utils";

/**
 * LE SOLDE DE TOUT COMPTE (lot rhdepart) — affiché comme un document, chaque ligne modifiable : libellé, gain ou
 * retenue, montant (vide = à saisir, jamais compté comme zéro). Prérempli à l'accord final avec ce que la plateforme
 * sait ; la paie se calcule ailleurs, les RH ajustent. Réservé à qui voit les salaires.
 */
export function DepartSolde({ departId, lignes: initiales, modifieLe, peutAgir }: {
  departId: string; lignes: LigneSolde[]; modifieLe: string | null; peutAgir: boolean;
}) {
  const { busy, err, run } = useAction();
  const [lignes, setLignes] = React.useState<LigneSolde[]>(initiales);
  const [modifie, setModifie] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  React.useEffect(() => { setLignes(initiales); setModifie(false); }, [initiales]);

  const maj = (i: number, p: Partial<LigneSolde>) => { setLignes((l) => l.map((x, k) => (k === i ? { ...x, ...p } : x))); setModifie(true); };
  const t = totauxSolde(lignes);
  const enregistrer = () => {
    const fd = new FormData(); fd.set("departId", departId); fd.set("lignes", JSON.stringify(lignes));
    void run(async () => { const r = await enregistrerSoldeDeToutCompte(fd); if (r.ok) { setMsg(r.message ?? null); setModifie(false); } return r; });
  };

  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Solde de tout compte {modifieLe && <span className="text-xs font-normal text-muted-foreground">· modifié le {modifieLe}</span>}</h3>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-secondary/50 text-xs text-muted-foreground">
            <tr><th className="px-2 py-1.5 text-left font-medium">Libellé</th><th className="px-2 py-1.5 text-left font-medium">Nature</th><th className="px-2 py-1.5 text-right font-medium">Montant (DZD)</th>{peutAgir && <th className="w-10" />}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lignes.map((l, i) => (
              <tr key={l.id}>
                <td className="px-2 py-1.5">
                  {peutAgir ? <Input value={l.libelle} onChange={(e) => maj(i, { libelle: e.target.value })} aria-label="Libellé" /> : l.libelle}
                  {l.detail && <p className="mt-0.5 text-xs text-muted-foreground">{l.detail}</p>}
                </td>
                <td className="px-2 py-1.5">
                  {peutAgir ? (
                    <Select value={l.sens} onChange={(e) => maj(i, { sens: e.target.value === "RETENUE" ? "RETENUE" : "GAIN" })} aria-label="Nature">
                      <option value="GAIN">À verser</option><option value="RETENUE">À retenir</option>
                    </Select>
                  ) : l.sens === "RETENUE" ? "À retenir" : "À verser"}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {peutAgir ? (
                    <Input type="number" min={0} step="0.01" inputMode="decimal" className="text-right" placeholder="à saisir" aria-label="Montant"
                      value={l.montant ?? ""} onChange={(e) => maj(i, { montant: e.target.value === "" ? null : Number(e.target.value) })} />
                  ) : l.montant == null ? <span className="text-warning">à saisir</span> : formatCurrency(l.montant)}
                </td>
                {peutAgir && (
                  <td className="px-1 text-center">
                    <Button type="button" size="icon" variant="ghost" aria-label={`Retirer la ligne ${l.libelle}`} onClick={() => { setLignes((x) => x.filter((_, k) => k !== i)); setModifie(true); }}><Trash2 className="h-4 w-4" /></Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border text-sm">
            <tr><td className="px-2 py-1" colSpan={2}>À verser</td><td className="px-2 py-1 text-right">{formatCurrency(t.gains)}</td>{peutAgir && <td />}</tr>
            <tr><td className="px-2 py-1" colSpan={2}>À retenir</td><td className="px-2 py-1 text-right">− {formatCurrency(t.retenues)}</td>{peutAgir && <td />}</tr>
            <tr className="font-semibold"><td className="px-2 py-1" colSpan={2}>Net {t.aSaisir > 0 && <span className="font-normal text-warning">({t.aSaisir} montant{t.aSaisir > 1 ? "s" : ""} à saisir)</span>}</td><td className="px-2 py-1 text-right">{formatCurrency(t.net)}</td>{peutAgir && <td />}</tr>
          </tfoot>
        </table>
      </div>
      {peutAgir && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { setLignes((l) => [...l, { id: `l${Date.now()}`, libelle: "", detail: null, montant: null, sens: "GAIN" }]); setModifie(true); }}>
            <Plus className="h-4 w-4" /> Ajouter une ligne
          </Button>
          <Button size="sm" onClick={enregistrer} disabled={busy || !modifie}>Enregistrer le solde</Button>
        </div>
      )}
      {msg && <Retour ton="succes" onFermer={() => setMsg(null)}>{msg}</Retour>}
      <Retour>{err}</Retour>
    </section>
  );
}
