"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Save, Send } from "lucide-react";
import { saisirStocksDemande } from "@/lib/actions/demande-stocks-actions";
import { ligneRemplie } from "@/lib/stocks/demande-stocks";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Textarea } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

/**
 * LA SAISIE DU KAM — pensée pour le téléphone : un établissement par carte, une ligne par
 * produit (quantité en boîtes + « rupture »), une note par établissement.
 *
 * Le formulaire part en TABLEAUX PARALLÈLES (`hopitalId[i]`, `produitId[i]`, `quantite[i]`,
 * `rupture[i]`), construits ici — aucune case à cocher nommée, donc aucun témoin caché à lire de
 * travers (§118.172). Le brouillon s'enregistre à tout moment ; l'envoi exige toutes les cases.
 */

interface HopitalSaisie { institutionId: string; hopitalId: string; name: string; wilaya: string | null; note: string | null }
interface LigneSaisie {
  hopitalId: string;
  institutionId: string;
  productId: string;
  label: string;
  quantite: number | null;
  rupture: boolean;
  savedBy: string | null;
  savedAt: string | null;
}

type Valeur = { q: string; r: boolean };
const cle = (l: { institutionId: string; productId: string }) => `${l.institutionId}|${l.productId}`;

export function SaisieStocks({ demandeId, ouverte, envoyeLe, hopitaux, lignes }: {
  demandeId: string;
  ouverte: boolean;
  envoyeLe: string | null;
  hopitaux: HopitalSaisie[];
  lignes: LigneSaisie[];
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = useState(false);
  const [retour, setRetour] = useState<{ ok: boolean; texte: string } | null>(null);
  const [valeurs, setValeurs] = useState<Record<string, Valeur>>(() =>
    Object.fromEntries(lignes.map((l) => [cle(l), { q: l.rupture ? "" : l.quantite === null ? "" : String(l.quantite), r: l.rupture }])));
  const [notes, setNotes] = useState<Record<string, string>>(() => Object.fromEntries(hopitaux.map((h) => [h.institutionId, h.note ?? ""])));
  const [fermes, setFermes] = useState<string[]>([]);
  const [modifie, setModifie] = useState(false);
  const occupe = busy || enCours;
  const lectureSeule = !ouverte;

  const parHopital = useMemo(() => {
    const m = new Map<string, LigneSaisie[]>();
    for (const l of lignes) m.set(l.institutionId, [...(m.get(l.institutionId) ?? []), l]);
    return m;
  }, [lignes]);
  const remplie = (k: string) => { const v = valeurs[k]; return !!v && ligneRemplie({ quantite: v.q.trim() === "" ? null : 0, rupture: v.r }); };
  const total = lignes.length;
  const faites = lignes.filter((l) => remplie(cle(l))).length;

  const poser = (k: string, v: Partial<Valeur>) => { setValeurs((m) => ({ ...m, [k]: { ...m[k]!, ...v } })); setModifie(true); };

  const envoyer = async (geste: "BROUILLON" | "ENVOYER") => {
    setBusy(true); setRetour(null);
    const fd = new FormData();
    fd.set("demandeId", demandeId);
    fd.set("geste", geste);
    for (const l of lignes) {
      const v = valeurs[cle(l)]!;
      fd.append("hopitalId", l.institutionId);
      fd.append("produitId", l.productId);
      fd.append("quantite", v.r ? "" : v.q.trim());
      fd.append("rupture", v.r ? "1" : "0");
    }
    for (const h of hopitaux) {
      if ((notes[h.institutionId] ?? "") === (h.note ?? "")) continue;
      fd.append("noteHopitalId", h.institutionId);
      fd.append("noteHopital", notes[h.institutionId] ?? "");
    }
    try {
      const r = await saisirStocksDemande(fd);
      setRetour({ ok: r.ok, texte: r.ok ? r.message ?? "Enregistré." : r.error ?? "La saisie n'a pas été enregistrée." });
      // Le brouillon est enregistré même quand l'envoi est refusé faute de cases : on rafraîchit
      // dans les deux cas, pour que l'écran montre ce qui est EN BASE.
      setModifie(false);
      rafraichir();
    } catch {
      // Rien n'est sûr : la saisie reste marquée « modifiée », l'écran ne prétend pas l'avoir enregistrée.
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };

  if (lignes.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
        Aucun stock à renseigner pour vous dans cette demande.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Vos stocks à renseigner</h2>
        <span className="text-sm"><strong>{faites}</strong>/{total} renseignés</span>
      </div>
      {envoyeLe && (
        <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          Envoyé le {formatDateTime(envoyeLe)}.{ouverte ? " Vous pouvez encore corriger et renvoyer tant que la demande est ouverte." : ""}
        </p>
      )}
      {lectureSeule && <p className="text-sm text-muted-foreground">Demande clôturée : la saisie est figée.</p>}

      <div className="space-y-3">
        {hopitaux.map((h) => {
          const siennes = parHopital.get(h.institutionId) ?? [];
          const n = siennes.filter((l) => remplie(cle(l))).length;
          const ferme = fermes.includes(h.institutionId);
          return (
            <div key={h.institutionId} className="surface overflow-hidden">
              <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                onClick={() => setFermes((v) => (v.includes(h.institutionId) ? v.filter((x) => x !== h.institutionId) : [...v, h.institutionId]))}>
                <span className="flex min-w-0 items-center gap-1.5">
                  {ferme ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{h.name}</span>
                    <span className="block text-xs text-muted-foreground">{h.wilaya ?? "—"}</span>
                  </span>
                </span>
                <span className={`shrink-0 text-xs ${n === siennes.length ? "text-success" : "text-muted-foreground"}`}>{n}/{siennes.length}</span>
              </button>
              {!ferme && (
                <div className="space-y-2 border-t border-border px-3 py-2.5">
                  {siennes.map((l) => {
                    const k = cle(l);
                    const v = valeurs[k]!;
                    return (
                      <div key={k} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_8rem_auto] sm:items-center">
                        <span className="min-w-0 text-sm">
                          {l.label}
                          {l.savedBy && l.savedAt && <span className="block text-xs text-muted-foreground">saisi par {l.savedBy}, {formatDateTime(l.savedAt)}</span>}
                        </span>
                        <div className="flex items-center gap-3">
                          <Input
                            type="number" inputMode="numeric" min={0} step={1}
                            aria-label={`Stock de ${l.label} — ${h.name} (boîtes)`}
                            placeholder="boîtes"
                            className="w-full sm:w-32"
                            value={v.r ? "0" : v.q}
                            disabled={v.r || lectureSeule || occupe}
                            onChange={(e) => poser(k, { q: e.target.value })}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4" checked={v.r} disabled={lectureSeule || occupe}
                            onChange={(e) => poser(k, { r: e.target.checked })} />
                          Rupture
                        </label>
                      </div>
                    );
                  })}
                  <Textarea
                    rows={2}
                    aria-label={`Note sur ${h.name}`}
                    placeholder="Note sur cet établissement (facultatif)"
                    value={notes[h.institutionId] ?? ""}
                    disabled={lectureSeule || occupe}
                    onChange={(e) => { setNotes((m) => ({ ...m, [h.institutionId]: e.target.value })); setModifie(true); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {retour && (
        <p className={`rounded border px-3 py-2 text-sm ${retour.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{retour.texte}</p>
      )}

      {ouverte && (
        // LA BARRE DES GESTES reste sous le pouce au téléphone : la liste est longue, et
        // remonter tout en haut pour enregistrer fait perdre une saisie sur deux.
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap gap-2 border-t border-border bg-background/95 px-1 py-2 backdrop-blur">
          <Button type="button" variant="outline" disabled={occupe} onClick={() => envoyer("BROUILLON")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer le brouillon
          </Button>
          <BoutonDecisif type="button" disabled={occupe || faites < total} onClick={() => envoyer("ENVOYER")}
            confirmation={`Envoyer ${total} stock${total > 1 ? "s" : ""} à la Direction des opérations`}>
            <Send className="h-4 w-4" /> {envoyeLe ? "Renvoyer" : "Envoyer"}
          </BoutonDecisif>
          {faites < total && <span className="self-center text-xs text-muted-foreground">{total - faites} à renseigner avant l&apos;envoi</span>}
          {modifie && <span className="self-center text-xs text-warning">Modifications non enregistrées</span>}
        </div>
      )}
    </section>
  );
}
