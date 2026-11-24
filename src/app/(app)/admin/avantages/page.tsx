import Link from "next/link";
import { redirect } from "next/navigation";
import { HandCoins } from "lucide-react";
import { requireUser } from "@/lib/session";
import { peutLireRegistreAvantages, registreAvantages, type FicheVue, type VueRegistreAvantages } from "@/lib/queries/avantages";
import {
  adresseRegistre, anneeDeLAvantage, CLE_NON_RATTACHES, LIBELLE_NATURE_AVANTAGE, lireFiltresAvantages, NATURES_AVANTAGE, resteAPayer, TOUTES_ANNEES,
  type FiltresAvantages,
} from "@/modules/ad-pro/partage";
import { LETTRES, type Lettre } from "@/lib/segmentation/regles";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn, formatDate, formatMontant } from "@/lib/utils";
import { TableauAvantages } from "./tableau";

export const metadata = { title: "Avantages aux professionnels de santé — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * LE REGISTRE DES AVANTAGES AUX PROFESSIONNELS DE SANTÉ (Super Admin, 24/11/2026 : « Super Admin uniquement, clair et
 * détaillé »). Rangé avec l'intelligence du Super Admin, dans la Console d'administration, à côté d'Intelligence terrain.
 * Deux vues : le registre (un professionnel par ligne, la concentration) et la fiche d'un professionnel (`?pro=`).
 */

type Params = Record<string, string | string[] | undefined>;
const un = (p: Params | undefined, k: string): string | null => {
  const v = p?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

const CHEMIN = "/admin/avantages";
const SELECT = "h-9 min-w-0 rounded-lg border border-border bg-card px-2 text-sm";
const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "px-3 py-2 align-top";
const dzd = (n: number) => `${formatMontant(n)} DZD`;
const pct = (p: number | null) => (p == null ? "—" : `${(p * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`);

function Lettre_({ l }: { l: string | null }) {
  if (!l || !(LETTRES as readonly string[]).includes(l)) return null;
  return <LettreBadge lettre={l as Lettre} />;
}

export default async function AvantagesPage(props: { searchParams?: Promise<Params> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  // RÉSERVÉ AU SUPER ADMINISTRATEUR — la règle tient au rôle : aucun droit de module ne l'ouvre à un autre.
  if (!peutLireRegistreAvantages(user)) redirect("/dashboard?denied=ADMIN");

  const filtres = lireFiltresAvantages((k) => un(searchParams, k), anneeDeLAvantage(new Date().toISOString()));
  const pro = un(searchParams, "pro");
  const v = await registreAvantages(user, filtres, pro);
  if (!v) redirect("/dashboard?denied=ADMIN");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><HandCoins className="h-6 w-6" /></span>
          <h1 className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
            Avantages aux professionnels de santé
            <InfoBulle label="Ce qui est compté">
              <strong>Payé</strong> : acheté (ligne de BC achetée) ou réglé (ordre de dépense payé) ; le matériel remis en visite, au
              coût de son lot. <strong>Engagé non payé</strong> : accordé (validé, dans un BC, devis accepté) sans être encore acheté
              ni réglé. Les parts et la concentration se lisent sur le payé. Un professionnel est compté par sa fiche d&apos;annuaire ;
              un nom saisi sans fiche va aux « non rattachés ». Un montant partagé sans part nommée compte dans le nombre, pas dans
              les sommes.
            </InfoBulle>
          </h1>
        </div>
        <Link href={v.fiche ? adresseRegistre(CHEMIN, filtres) : "/admin"} className="text-sm text-muted-foreground hover:underline">
          {v.fiche ? "← Registre" : "← Administration"}
        </Link>
      </div>
      {v.fiche ? <FicheProfessionnel f={v.fiche} v={v} /> : <VueRegistre v={v} />}
    </div>
  );
}

// ─────────────────────────── Le registre ───────────────────────────

function Filtres({ v }: { v: VueRegistreAvantages }) {
  const f = v.filtres;
  const annees = [...new Set([...(f.annee != null ? [f.annee] : []), ...v.annees])].sort((a, b) => b - a);
  return (
    <form method="get" action={CHEMIN} className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Année
        <select name="annee" defaultValue={f.annee == null ? TOUTES_ANNEES : String(f.annee)} className={SELECT}>
          {annees.map((a) => <option key={a} value={a}>{a}</option>)}
          <option value={TOUTES_ANNEES}>Toutes les années</option>
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Société
        <select name="societe" defaultValue={f.societeId ?? ""} className={SELECT}>
          <option value="">Toutes</option>
          {v.societes.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Nature
        <select name="nature" defaultValue={f.nature ?? ""} className={SELECT}>
          <option value="">Toutes</option>
          {NATURES_AVANTAGE.map((n) => <option key={n} value={n}>{LIBELLE_NATURE_AVANTAGE[n]}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Spécialité
        <select name="specialite" defaultValue={f.specialite ?? ""} className={SELECT}>
          <option value="">Toutes</option>
          {v.specialites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Wilaya
        <select name="wilaya" defaultValue={f.wilaya ?? ""} className={SELECT}>
          <option value="">Toutes</option>
          {v.wilayas.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      <button type="submit" className="h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-secondary">Filtrer</button>
    </form>
  );
}

function Tuile({ titre, valeur, detail, ton }: { titre: string; valeur: string; detail?: React.ReactNode; ton?: "warning" }) {
  return (
    <div className="surface min-w-0 rounded-xl px-4 py-3">
      <p className="text-xs text-muted-foreground">{titre}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", ton === "warning" && "text-warning")}>{valeur}</p>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

const periode = (f: FiltresAvantages) => (f.annee == null ? "toutes années" : String(f.annee));

function VueRegistre({ v }: { v: VueRegistreAvantages }) {
  const r = v.registre;
  const c = v.concentration;
  const nonRattaches = r.lignes.find((l) => l.cle === CLE_NON_RATTACHES);
  return (
    <div className="space-y-4">
      <Filtres v={v} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tuile titre={`Payé (${periode(v.filtres)})`} valeur={dzd(r.payeDzd)} detail={`${r.nombre} avantage(s)`} />
        <Tuile titre="Engagé non payé" valeur={dzd(r.resteDzd)} ton={r.resteDzd > 0 ? "warning" : undefined} />
        <Tuile
          titre="Bénéficiaires"
          valeur={String(c.beneficiaires)}
          detail={nonRattaches ? `+ ${nonRattaches.noms.length} nom(s) non rattaché(s)` : "tous rattachés à l'annuaire"}
        />
        <Tuile
          titre="Concentration du payé"
          valeur={`Top 10 : ${pct(c.top10.part)}`}
          detail={<>Top 20 % ({c.top20pct.professionnels} pro.) : <span className="font-medium text-foreground">{pct(c.top20pct.part)}</span></>}
        />
      </div>
      <TableauAvantages lignes={r.lignes} filtres={v.filtres} chemin={CHEMIN} fichier={`avantages-professionnels-${periode(v.filtres).replace(/\s+/g, "-")}`} />
    </div>
  );
}

// ─────────────────────────── La fiche d'un professionnel ───────────────────────────

function FicheProfessionnel({ f, v }: { f: FicheVue; v: VueRegistreAvantages }) {
  const societe = new Map(v.societes.map((s) => [s.id, s.nom]));
  const libres = f.cle === CLE_NON_RATTACHES;
  const t = f.fiche.total;
  return (
    <div className="space-y-4">
      <section className="surface rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={cn("text-lg font-semibold", libres && "italic")}>{f.nom}</h2>
          <Lettre_ l={f.lettre} />
          {v.filtres.societeId && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{societe.get(v.filtres.societeId) ?? "Société"}</span>}
        </div>
        {!libres && <p className="text-sm text-muted-foreground">{[f.specialite, f.etablissement, f.wilaya].filter(Boolean).join(" · ") || "—"}</p>}
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tuile titre="Payé (toutes années)" valeur={dzd(t.payeDzd)} />
        <Tuile titre="Engagé non payé" valeur={dzd(t.resteDzd)} ton={t.resteDzd > 0 ? "warning" : undefined} />
        <Tuile titre="Avantages" valeur={String(t.nombre)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Totaux titre="Par année" lignes={f.fiche.parAnnee.map((a) => ({ cle: String(a.annee), libelle: String(a.annee), ...a }))} />
        <Totaux titre="Par nature" lignes={f.fiche.parNature.map((a) => ({ cle: a.nature, libelle: a.libelle, ...a }))} />
      </div>

      <section className="surface min-w-0 overflow-hidden rounded-xl">
        <header className="border-b border-border px-4 py-3"><h2 className="text-[15px] font-semibold">Chronologie</h2></header>
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40"><tr className="border-b border-border">
              <th className={TH}>Date</th>
              {libres && <th className={TH}>Nom saisi</th>}
              <th className={TH}>Nature</th><th className={TH}>Objet / événement</th><th className={TH}>Société</th><th className={TH}>Demandeur</th>
              <th className={cn(TH, "text-right")}>Engagé</th><th className={cn(TH, "text-right")}>Payé</th><th className={TH}>Référence</th>
            </tr></thead>
            <tbody>
              {f.fiche.chronologie.length === 0 && (
                <tr><td colSpan={libres ? 9 : 8} className="px-3 py-4 text-muted-foreground">Aucun avantage enregistré pour ce professionnel. Retirez le filtre société pour tout voir.</td></tr>
              )}
              {f.fiche.chronologie.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-b-0">
                  <td className={cn(TD, "whitespace-nowrap tabular-nums")}>{formatDate(a.date)}</td>
                  {libres && <td className={cn(TD, "font-medium")}>{a.nomLibre ?? "—"}</td>}
                  <td className={cn(TD, "whitespace-nowrap")}>{LIBELLE_NATURE_AVANTAGE[a.nature]}</td>
                  <td className={TD}>
                    <p className="min-w-[14rem]">{a.objet}</p>
                    {a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>{a.societeId ? societe.get(a.societeId) ?? "—" : "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>{a.demandeur ?? "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right tabular-nums")}>{a.engageDzd == null ? "—" : formatMontant(a.engageDzd)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right tabular-nums")}>
                    {a.payeDzd == null ? "—" : <span className={resteAPayer(a) > 0 ? "text-warning" : "font-medium"}>{formatMontant(a.payeDzd)}</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    {a.href
                      ? <Link href={a.href} className="text-primary hover:underline">{a.reference ?? "Ouvrir la demande"}</Link>
                      : a.reference ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Totaux({ titre, lignes }: { titre: string; lignes: { cle: string; libelle: string; nombre: number; payeDzd: number; resteDzd: number }[] }) {
  return (
    <section className="surface min-w-0 overflow-hidden rounded-xl">
      <header className="border-b border-border px-4 py-3"><h2 className="text-[15px] font-semibold">{titre}</h2></header>
      <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <table className="w-full text-sm">
          <thead className="bg-muted/40"><tr className="border-b border-border">
            <th className={TH}>{titre === "Par année" ? "Année" : "Nature"}</th><th className={cn(TH, "text-right")}>Nombre</th>
            <th className={cn(TH, "text-right")}>Payé (DZD)</th><th className={cn(TH, "text-right")}>Engagé non payé (DZD)</th>
          </tr></thead>
          <tbody>
            {lignes.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-muted-foreground">—</td></tr>}
            {lignes.map((l) => (
              <tr key={l.cle} className="border-b border-border last:border-b-0">
                <td className={cn(TD, "whitespace-nowrap font-medium")}>{l.libelle}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{l.nombre}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{formatMontant(l.payeDzd)}</td>
                <td className={cn(TD, "text-right tabular-nums", l.resteDzd > 0 && "text-warning")}>{formatMontant(l.resteDzd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
