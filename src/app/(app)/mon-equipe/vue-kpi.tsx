"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Settings2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn, formatDate } from "@/lib/utils";
import { FREQUENCE_LABELS, NATURE_LABELS, type FrequenceRevue } from "@/lib/kpi/briques";
import type { TableauKpi } from "@/lib/kpi/types";
import { reglerFrequenceRevue } from "@/lib/actions/kpi-actions";
import { BilanKpiVue } from "@/components/kpi/bilan-kpi";
import { KpiCreateur } from "@/components/kpi/kpi-createur";
import { GestionKpi } from "@/components/kpi/gestion-kpi";
import { LIBELLE_STATUT_REVUE, PastilleKpi, couleurScore } from "@/components/kpi/kpi-commun";
import { Avatar } from "./equipe-commun";
import { sansBloquer } from "@/lib/journal";

const STATUT_FEEDBACK: Record<string, string> = { NEW: "envoyée", SEEN: "vue", IN_PROGRESS: "en cours", DONE: "traitée" };

/**
 * MON ÉQUIPE › KPI — une ligne par personne, une colonne par KPI (poids et nature dans l'en-tête), le score pondéré,
 * l'état de la revue. Un clic sur une ligne ouvre le bilan de la personne. « Nouveau KPI » ouvre l'assistant Luna.
 * Au téléphone, le tableau reste un tableau : il défile dans son cadre, le nom collé à gauche.
 */
export function VueKpi({ kpi }: { kpi: TableauKpi }) {
  const router = useRouter();
  const { rafraichir, enCours } = useRafraichir();
  const [ouverte, setOuverte] = React.useState<string | null>(null);
  const [panneau, setPanneau] = React.useState<"creer" | "gerer" | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const ligne = ouverte ? kpi.lignes.find((l) => l.userId === ouverte) ?? null : null;
  const personnes = kpi.lignes.map((l) => ({ userId: l.userId, nom: l.nom }));

  const changerFrequence = async (f: FrequenceRevue) => {
    const fd = new FormData(); fd.set("frequence", f);
    const r = await reglerFrequenceRevue(fd).catch(sansBloquer("vue-kpi.changerFrequence.reglerFrequenceRevue", null));
    setMsg(r?.ok ? null : r?.error ?? "La fréquence de revue n'a pas été changée.");
    if (r?.ok) router.push("/mon-equipe?vue=kpi");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kpi.periode.cle} aria-label="Période"
            onChange={(e) => router.push(`/mon-equipe?vue=kpi&periode=${e.target.value}`)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {kpi.periodes.map((p) => <option key={p.cle} value={p.cle}>{p.libelle}</option>)}
            {!kpi.periodes.some((p) => p.cle === kpi.periode.cle) && <option value={kpi.periode.cle}>{kpi.periode.libelle}</option>}
          </select>
          {kpi.droits.signer && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Revue
              <select
                value={kpi.frequence} aria-label="Fréquence de revue"
                onChange={(e) => void changerFrequence(e.target.value as FrequenceRevue)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                {(Object.keys(FREQUENCE_LABELS) as FrequenceRevue[]).map((f) => <option key={f} value={f}>{FREQUENCE_LABELS[f]}</option>)}
              </select>
              <InfoBulle align="left">La fréquence de revue de votre équipe : chaque KPI se calcule sur la période (un mois, un trimestre, un semestre) ; une cible mensuelle en nombre se multiplie d&apos;autant.</InfoBulle>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kpi.droits.superAdmin && (
            <Link href="/admin/kpi" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary sm:h-8">
              Modèles par rôle
            </Link>
          )}
          {kpi.droits.creer && (
            <>
              <Button size="sm" variant="outline" onClick={() => setPanneau("gerer")}><Settings2 className="h-3.5 w-3.5" /> Gérer</Button>
              <Button size="sm" onClick={() => setPanneau("creer")}><Plus className="h-3.5 w-3.5" /> Nouveau KPI</Button>
            </>
          )}
        </div>
      </div>

      <section className="surface min-w-0 rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            KPI · {kpi.periode.libelle}
            <InfoBulle align="left">Valeurs calculées en continu par la plateforme, jamais estimées. « — » = pas de donnée : le KPI sort du score et son poids se répartit. Un clic sur une ligne ouvre le bilan de la personne.</InfoBulle>
          </h2>
          {enCours && <span className="text-xs text-muted-foreground">Mise à jour…</span>}
        </div>
        {kpi.colonnes.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Aucun KPI ne s&apos;applique encore à votre équipe.</p>
        ) : (
          <Table className="min-w-[48rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 z-10 w-[11rem] max-w-[11rem] bg-card sm:w-[14rem] sm:max-w-[14rem]">Personne</TableHead>
                {kpi.colonnes.map((c) => (
                  <TableHead key={c.famille} className="text-center" title={`${c.calcul}${c.definitionBrique ? ` — ${c.definitionBrique}` : ""}`}>
                    <span className="block max-w-[9rem] truncate">{c.nom}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{c.nature !== "RATIO" && c.nature !== "CALCULE" ? `${NATURE_LABELS[c.nature]} · ` : ""}poids {c.poids}</span>
                  </TableHead>
                ))}
                <TableHead className="text-center">Score</TableHead>
                <TableHead>Revue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpi.lignes.map((l) => {
                const s = LIBELLE_STATUT_REVUE[l.revue.statut];
                return (
                  <TableRow key={l.userId} className="group cursor-pointer" onClick={() => setOuverte(l.userId)}>
                    <TableCell className="sticky left-0 z-10 w-[11rem] max-w-[11rem] bg-card group-hover:bg-secondary sm:w-[14rem] sm:max-w-[14rem]">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${Math.min(l.depth - 1, 4) * 12}px` }}>
                        <Avatar nom={l.nom} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{l.nom}</p>
                          <p className="truncate text-xs text-muted-foreground">{l.poste ?? "—"}</p>
                        </div>
                      </div>
                    </TableCell>
                    {kpi.colonnes.map((c) => {
                      const v = l.cellules[c.famille];
                      return (
                        <TableCell key={c.famille} className="text-center">
                          {v ? <PastilleKpi couleur={v.couleur} titre={v.raison ?? undefined}>{v.affichage}</PastilleKpi> : <span className="text-xs text-muted-foreground">·</span>}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-center">
                      <PastilleKpi couleur={couleurScore(l.score)} titre={l.sansDonnee > 0 ? `${l.sansDonnee} KPI sans donnée` : undefined}>{l.score ?? "—"}</PastilleKpi>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge tone={l.aValider > 0 && l.revue.statut !== "SIGNEE" ? "warning" : s.ton}>
                        {l.revue.statut === "SIGNEE" ? s.texte : l.aValider > 0 ? `${l.aValider} à valider` : s.texte}
                      </Badge>
                      {l.revue.signeeLe && <span className="ml-1 text-xs text-muted-foreground">{formatDate(l.revue.signeeLe, { day: "numeric", month: "short" })}</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {kpi.propositions.length > 0 && (
        <section className="surface min-w-0 rounded-xl">
          <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Mes propositions de KPI</h3>
          <ul className="divide-y divide-border text-sm">
            {kpi.propositions.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 truncate">{p.resume}</span>
                <span className="text-xs text-muted-foreground">{formatDate(p.le, { day: "numeric", month: "short" })}</span>
                <Badge tone={p.statut === "DONE" ? "success" : p.statut === "NEW" ? "neutral" : "info"}>{STATUT_FEEDBACK[p.statut] ?? p.statut}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {msg && <p className={cn("text-xs text-destructive")}>{msg}</p>}

      <Sheet open={ligne !== null} onClose={() => setOuverte(null)} title={ligne ? `Bilan — ${ligne.nom}` : ""} width="xl">
        {ligne && <BilanKpiVue key={`${ligne.userId}-${kpi.periode.cle}`} userId={ligne.userId} periodeInitiale={kpi.periode.cle} onChange={rafraichir} />}
      </Sheet>
      <Sheet open={panneau === "creer"} onClose={() => setPanneau(null)} title="Nouveau KPI" width="xl">
        {panneau === "creer" && <KpiCreateur personnes={personnes} onAjoute={() => { rafraichir(); }} />}
      </Sheet>
      <Sheet open={panneau === "gerer"} onClose={() => setPanneau(null)} title="Les KPI de mon équipe" width="lg">
        {panneau === "gerer" && <GestionKpi personnes={personnes} onChange={rafraichir} />}
      </Sheet>
    </div>
  );
}
