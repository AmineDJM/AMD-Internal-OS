import Link from "next/link";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { InfoBulle } from "@/components/ui/info-bulle";
import { chargerCockpitOperations, type CockpitOperations, type LigneBuCockpit } from "@/lib/queries/cockpit-operations";
import type { LigneEquipe } from "@/lib/queries/cockpit-operations-terrain";
import { moisCourt } from "@/lib/ventes-pch/calculs";
import { SEUIL_RUPTURE_MOIS, SEUIL_VIGILANCE_MOIS, ilYa, niveauCouverture } from "@/lib/stocks/pch-central";
import { CHEMIN_STOCKS_CHAINE } from "@/lib/chemins/stocks";
import type { ATraiter, CumulLivre } from "@/lib/cockpit-operations/calculs";
import type { EvenementSemaine, LigneReleve } from "@/lib/cockpit-operations/terrain";
import { CarteVoixTerrain } from "@/components/shared/voix-terrain";
import { cn, formatCompact, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cockpit Opérations — AMD Internal OS" };

/**
 * COCKPIT OPÉRATIONS (Direction, 08/10 — maquette v2 validée ; enrichi 10/2026, maquette « Cockpit Opérations » :
 * l'équipe et le terrain) : six tuiles, « L'équipe aujourd'hui », « À traiter », « Remontées du terrain », « Stocks
 * relevés par les délégués », « Cette semaine », puis la table « Par BU ». Les puces de BU filtrent tout. Lecture seule
 * — chaque ligne mène à l'écran où le geste se fait. Une donnée absente s'affiche « — » avec sa raison (ⓘ) et le lien
 * pour la fournir, jamais comme un zéro.
 */

const aujourdhui = () => {
  const t = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const TON = { ok: "text-success", w: "text-warning", ko: "text-destructive" } as const;

const montant = (c: CumulLivre) => (c.valorise ? `${formatCompact(c.valeur)} DZD` : `${formatNumber(c.boites)} bt`);
const signe = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("fr-FR")} %`;

export default async function CockpitOperationsPage(props: { searchParams?: Promise<{ bu?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("COCKPIT_OPERATIONS");
  const c = await chargerCockpitOperations(user, searchParams?.bu ?? null);
  const lienBu = (id: string | null) => (id ? `/operations?bu=${encodeURIComponent(id)}` : "/operations");

  return (
    <div className="space-y-4">
      <PageHeader title="Cockpit Opérations" description={`${aujourdhui()} · ${c.bus.find((b) => b.id === c.buId)?.nom ?? "toutes les BU"}`}>
        <InfoBulle label="À propos du cockpit">
          Un seul client : la PCH. Les ventes se lisent dans les fichiers de la PCH (Ventes PCH), les marchés dans Marchés PCH,
          les stocks dans la chaîne (Adventum + PCH central + hôpitaux), la couverture terrain dans la Force de vente.
        </InfoBulle>
      </PageHeader>

      {c.bus.length > 1 && (
        <nav className="-mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Business units">
          <Puce href={lienBu(null)} actif={!c.buId}>Toutes les BU</Puce>
          {c.bus.map((b) => <Puce key={b.id} href={lienBu(b.id)} actif={c.buId === b.id}>{b.nom}</Puce>)}
        </nav>
      )}

      <Tuiles c={c} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <EquipeDuJour c={c} />
        <ListeATraiter items={c.aTraiter} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {c.voix ? <CarteVoixTerrain titre="Remontées du terrain" voix={c.voix} max={4} /> : <CarteSimple titre="Remontées du terrain"><Vide>Les rapports de terrain ne vous sont pas ouverts.</Vide></CarteSimple>}
        <StocksReleves stocks={c.stocks} />
        <CetteSemaine c={c} />
      </div>

      <ParBu c={c} />
    </div>
  );
}

// ─────────────────────────── L'équipe aujourd'hui ───────────────────────────

const PILULE: Record<LigneEquipe["jour"]["genre"], string> = {
  TERRAIN: "border-success/40 bg-success/10 text-success",
  MISSION: "border-primary/40 bg-primary/10 text-primary",
  CONGE: "border-warning/40 bg-warning/10 text-warning",
  AUCUN: "border-border text-muted-foreground",
};

function EquipeDuJour({ c }: { c: CockpitOperations }) {
  const raison = !c.fdv.ouvert ? "La Force de vente ne vous est pas ouverte." : c.fdv.horsPerimetre ? "Cette BU n'est pas dans votre périmètre de Force de vente." : null;
  const equipe = c.terrain?.equipe ?? [];
  const voitKpi = c.terrain?.kpi.ouvert ?? false;
  return (
    <CarteSimple titre="L'équipe aujourd'hui" sous="plans, visites, rapports"
      info={<>Aujourd&apos;hui : congé approuvé, sinon mission (congrès, événement), sinon le terrain prévu par le plan (ville la plus fréquente). Visites : réalisées / prévues dans le plan du jour. Rapports en retard et couverture H·A·B à fréquence : Force de vente, mois en cours. KPI : score de la période (KPI &amp; bilans).</>}>
      {raison ? <Vide>{raison}</Vide> : equipe.length === 0 ? <Vide>Aucun délégué dans le périmètre.</Vide> : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[620px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Délégué</th>
                <th className="px-3 py-2 font-medium">Aujourd&apos;hui</th>
                <th className="px-3 py-2 text-right font-medium">Visites</th>
                <th className="px-3 py-2 text-right font-medium">Rapports en retard</th>
                <th className="px-3 py-2 font-medium">Couverture H·A·B</th>
                {voitKpi && <th className="px-3 py-2 text-right font-medium">KPI</th>}
              </tr>
            </thead>
            <tbody>
              {equipe.map((e) => (
                <tr key={e.repId} className="border-b border-border last:border-0">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">{e.nom}</td>
                  <td className="px-3 py-2"><span className={cn("inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", PILULE[e.jour.genre])}>{e.jour.libelle}</span></td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", e.visites.prevues === 0 && "text-muted-foreground")}>{e.visites.prevues ? `${e.visites.realisees} / ${e.visites.prevues}` : "—"}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", e.rapportsEnRetard > 0 && "font-medium text-warning")}>{e.rapportsEnRetard}</td>
                  <td className="px-3 py-2">
                    {e.couverture === null ? <span className="text-muted-foreground">—</span> : (
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary" aria-hidden>
                          <span className={cn("block h-full rounded-full", e.couverture < 50 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, e.couverture)}%` }} />
                        </span>
                        <span className="text-xs tabular-nums">{e.couverture} %</span>
                      </span>
                    )}
                  </td>
                  {voitKpi && <td className={cn("px-3 py-2 text-right tabular-nums", e.kpi === null ? "text-muted-foreground" : e.kpi < 50 ? "font-medium text-warning" : "")}>{e.kpi === null ? "—" : e.kpi}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CarteSimple>
  );
}

// ─────────────────────────── Stocks relevés par les délégués ───────────────────────────

function StocksReleves({ stocks }: { stocks: LigneReleve[] | null }) {
  return (
    <CarteSimple titre="Stocks relevés par les délégués"
      info={<>Le dernier relevé de chaque hôpital × produit (demandes de stocks). Mois : stock ÷ consommation de l&apos;hôpital (moyenne des 3 derniers mois servis par les DR). Relevé en orange au-delà de 30 jours. Les couvertures les plus courtes d&apos;abord.</>}>
      {stocks === null ? <Vide>Les stocks de la chaîne ne vous sont pas ouverts.</Vide> : stocks.length === 0 ? <Vide>Aucun relevé de stock d&apos;hôpital.</Vide> : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Hôpital</th>
                <th className="px-3 py-2 font-medium">Produit</th>
                <th className="px-3 py-2 text-right font-medium">Mois</th>
                <th className="px-3 py-2 font-medium">Relevé</th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((s) => {
                const niveau = niveauCouverture(s.mois);
                return (
                  <tr key={s.cle} className="border-b border-border last:border-0">
                    <td className="sticky left-0 z-10 max-w-[160px] bg-card px-3 py-2 [overflow-wrap:anywhere]">{s.hopital}</td>
                    <td className="px-3 py-2 [overflow-wrap:anywhere]">{s.produit}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", niveau === "rupture" ? "font-semibold text-destructive" : niveau === "vigilance" ? "font-medium text-warning" : niveau ? "" : "text-muted-foreground")}
                      title={s.conso === null ? "consommation de l'hôpital inconnue" : `${formatNumber(s.quantite)} en stock · ${formatNumber(s.conso)} / mois`}>
                      {s.mois === null ? "—" : s.mois.toLocaleString("fr-FR")}
                    </td>
                    <td className={cn("whitespace-nowrap px-3 py-2", s.perime ? "text-warning" : "text-muted-foreground")}>{ilYa(s.age)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CarteSimple>
  );
}

// ─────────────────────────── Cette semaine ───────────────────────────

const POINT_SEMAINE: Record<EvenementSemaine["ton"], string> = { v: "bg-violet-500", i: "bg-primary", ok: "bg-success" };

function CetteSemaine({ c }: { c: CockpitOperations }) {
  const e = [...(c.terrain?.semaine ?? []), ...c.livraisons].sort((a, b) => a.le.getTime() - b.le.getTime()).slice(0, 7);
  return (
    <CarteSimple titre="Cette semaine" info={<>Les 7 prochains jours : missions (congrès, événements) de l&apos;équipe, livraisons PCH attendues, coachings planifiés.</>}>
      {e.length === 0 ? <Vide>Rien de prévu sur les 7 prochains jours.</Vide> : (
        <ul>
          {e.map((x) => (
            <li key={x.cle} className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-0">
              <i className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", POINT_SEMAINE[x.ton])} aria-hidden />
              <div className="min-w-0 flex-1">
                <b className="block text-sm font-medium [overflow-wrap:anywhere]">{x.titre}</b>
                <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{x.detail}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </CarteSimple>
  );
}

function CarteSimple({ titre, sous, info, children }: { titre: string; sous?: string; info?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="surface min-w-0 overflow-hidden rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
          {titre}
          {info && <InfoBulle label={`À propos : ${titre}`}>{info}</InfoBulle>}
        </h2>
        {sous && <span className="text-[13px] text-muted-foreground">{sous}</span>}
      </header>
      {children}
    </section>
  );
}

function Vide({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-5 text-sm text-muted-foreground">{children}</p>;
}

// ─────────────────────────── Tuiles ───────────────────────────

function Tuiles({ c }: { c: CockpitOperations }) {
  const lienImport = c.acces.ventes ? { href: "/sales/importer", label: c.acces.importer ? "Importer" : "Voir les imports" } : undefined;
  const { livre, execution, ruptures, fdv, terrain } = c;
  const lienFdv = { href: "/planning", label: "Force de vente" };

  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
      {!fdv.ouvert ? (
        <Tuile titre="Visites aujourd'hui" raison="La Force de vente ne vous est pas ouverte." />
      ) : fdv.horsPerimetre || !terrain ? (
        <Tuile titre="Visites aujourd'hui" raison="Cette BU n'est pas dans votre périmètre de Force de vente." lien={lienFdv} />
      ) : terrain.visites.prevues === 0 ? (
        <Tuile titre="Visites aujourd'hui" raison="Aucune visite prévue aujourd'hui dans les plans de tournée." lien={{ href: "/medical/plan-de-tournee", label: "Plans de tournée" }} />
      ) : (
        <Tuile titre="Visites aujourd'hui"
          info="Visites du plan du jour rapportées, sur celles que les plans de tournée prévoient (hors reportées et annulées)."
          valeur={`${terrain.visites.realisees} / ${terrain.visites.prevues}`}
          pied="prévues dans les plans" />
      )}

      {!fdv.ouvert ? (
        <Tuile titre="Cibles H·A·B à fréquence" raison="La Force de vente ne vous est pas ouverte." />
      ) : fdv.horsPerimetre ? (
        <Tuile titre="Cibles H·A·B à fréquence" raison="Cette BU n'est pas dans votre périmètre de Force de vente." lien={lienFdv} />
      ) : fdv.pct === null ? (
        <Tuile titre="Cibles H·A·B à fréquence" raison="Aucune cible H, A ou B dans les panels du périmètre." lien={lienFdv} />
      ) : (
        <Tuile titre="Cibles H·A·B à fréquence"
          info="Part des praticiens classés H, A ou B dans les panels qui ont reçu leur nombre de visites requis ce cycle (Force de vente)."
          valeur={`${fdv.pct} %`}
          pied={fdv.delta === null ? `${fdv.vues} / ${fdv.cibles} cibles` : `${fdv.delta >= 0 ? "+" : ""}${fdv.delta} pts vs cycle précédent`}
          ton={fdv.delta === null ? undefined : fdv.delta >= 0 ? "ok" : "ko"} />
      )}

      {!livre.mois ? (
        <Tuile titre="Livré à la PCH (mois)" raison="Aucun fichier de réceptions de la PCH centrale n'a été importé." lien={lienImport} />
      ) : !livre.cumul.lisible ? (
        <Tuile titre="Livré à la PCH (mois)" raison="Aucun de nos produits n'a de fournisseur « à nous » réglé : nos réceptions ne se distinguent pas encore." lien={c.acces.ventes ? { href: "/sales/importer#fournisseurs", label: "Régler" } : undefined} />
      ) : (
        <Tuile titre={`Livré à la PCH · ${moisCourt(livre.mois)}`}
          info="Nos réceptions à la PCH centrale (FO de nos fournisseurs) sur le dernier mois reçu, valorisées au coût d'achat de la PCH ; comparées au même mois de l'année précédente."
          valeur={montant(livre.cumul)}
          pied={livre.evol !== null ? `${signe(livre.evol)} vs ${moisCourt(livre.moisN1!)}` : livre.n1Present ? `rien livré en ${moisCourt(livre.moisN1!)}` : `${moisCourt(livre.moisN1!)} non importé`}
          ton={livre.evol === null ? undefined : livre.evol >= 0 ? "ok" : "ko"} />
      )}

      {execution.pct === null ? (
        <Tuile titre="Exécution des marchés" raison={`Aucun marché ${execution.annee} avec une quantité attribuée.`} lien={c.acces.ventes ? { href: "/sales/contrats", label: "Voir les contrats" } : undefined} />
      ) : (
        <Tuile titre="Exécution des marchés"
          info={`Livré ÷ attribué (avenants compris) sur les marchés en cours en ${execution.annee}, en unités du marché.`}
          valeur={`${execution.pct} %`}
          pied={`${formatNumber(execution.livre)} / ${formatNumber(execution.attribue)} · ${execution.marches} marché${execution.marches > 1 ? "s" : ""}`}
          valeurTon={execution.pct < 50 ? "w" : undefined} />
      )}

      {ruptures.mesurables === 0 ? (
        <Tuile titre="Ruptures à 60 jours"
          raison={ruptures.produits === 0 ? "Aucun produit de BU avec son dossier." : "Aucune couverture ne se calcule : il manque les stocks de la chaîne ou la consommation (fichiers des DR)."}
          lien={c.acces.chaine ? { href: CHEMIN_STOCKS_CHAINE, label: "Stocks de la chaîne" } : undefined} />
      ) : (
        <Tuile titre="Ruptures à 60 jours"
          info={`Produits dont la couverture de la chaîne (Adventum + PCH central + hôpitaux ÷ consommation mensuelle) est sous ${SEUIL_RUPTURE_MOIS} mois.`}
          valeur={String(ruptures.enRupture)} valeurTon={ruptures.enRupture > 0 ? "ko" : undefined}
          pied={ruptures.mesurables < ruptures.produits ? `sur ${ruptures.mesurables} produits mesurés / ${ruptures.produits}` : "chaîne complète"} />
      )}

      {!terrain ? (
        <Tuile titre="Score KPI équipe" raison={!fdv.ouvert ? "La Force de vente ne vous est pas ouverte." : "Cette BU n'est pas dans votre périmètre de Force de vente."} />
      ) : !terrain.kpi.ouvert ? (
        <Tuile titre="Score KPI équipe" raison="Les KPI & bilans ne vous sont pas ouverts." />
      ) : terrain.kpi.score === null ? (
        <Tuile titre="Score KPI équipe" raison="Aucun délégué de votre équipe n'a de score sur la période (KPI & bilans)." lien={{ href: "/mon-equipe?vue=kpi", label: "KPI & bilans" }} />
      ) : (
        <Tuile titre="Score KPI équipe"
          info="Moyenne des scores KPI de la période des délégués du périmètre (chaque score est la moyenne pondérée de ses KPI)."
          valeur={String(terrain.kpi.score)} valeurTon={terrain.kpi.score < 50 ? "w" : undefined}
          pied={`moyenne pondérée · ${terrain.kpi.notes} délégué${terrain.kpi.notes > 1 ? "s" : ""}`} />
      )}
    </div>
  );
}

function Tuile({ titre, info, valeur, pied, ton, valeurTon, raison, lien }: {
  titre: string; info?: string; valeur?: string; pied?: string; ton?: keyof typeof TON; valeurTon?: keyof typeof TON;
  raison?: string; lien?: { href: string; label: string };
}) {
  return (
    <div className="surface flex min-w-0 flex-col gap-0.5 rounded-xl px-3.5 py-3">
      <span className="flex items-start justify-between gap-1 text-xs text-muted-foreground">
        {titre}
        {(raison ?? info) && <InfoBulle label={`À propos : ${titre}`}>{raison ?? info}</InfoBulle>}
      </span>
      <strong className={cn("text-[22px] font-semibold tabular-nums", raison ? "text-muted-foreground" : valeurTon && TON[valeurTon])}>{raison ? "—" : valeur}</strong>
      {raison ? (
        lien ? <Link href={lien.href} className="text-xs text-primary hover:underline">{lien.label}</Link> : <span className="text-xs text-muted-foreground">donnée absente</span>
      ) : (
        <span className={cn("text-xs", ton ? TON[ton] : "text-muted-foreground")}>{pied}</span>
      )}
    </div>
  );
}

// ─────────────────────────── Par BU ───────────────────────────

function ParBu({ c }: { c: CockpitOperations }) {
  return (
    <section className="surface min-w-0 rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
          Par BU
          <InfoBulle label="À propos : Par BU">
            Livré : nos réceptions à la PCH sur les 12 derniers mois reçus, face aux 12 mois d&apos;avant. Exécution : livré ÷
            attribué des marchés en cours. Non servi : 12 mois, en boîtes. Couverture : la plus courte d&apos;un produit de la
            BU — rouge sous {SEUIL_RUPTURE_MOIS} mois, orange sous {SEUIL_VIGILANCE_MOIS}.
          </InfoBulle>
        </h2>
      </header>
      {c.parBu.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">Aucune Business Unit active.</p>
      ) : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">BU</th>
                <th className="px-3 py-2 text-right font-medium">Livré (12 mois)</th>
                <th className="px-3 py-2 text-right font-medium">vs N-1</th>
                <th className="px-3 py-2 font-medium">Exécution marchés</th>
                <th className="px-3 py-2 text-right font-medium">Non servi</th>
                <th className="px-3 py-2 text-right font-medium">Couverture chaîne</th>
              </tr>
            </thead>
            <tbody>
              {c.parBu.map((b) => <LigneBu key={b.id} b={b} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LigneBu({ b }: { b: LigneBuCockpit }) {
  const niveau = niveauCouverture(b.couverture?.couverture ?? null);
  const pct = b.execution.pct;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">{b.nom}</td>
      <td className="px-3 py-2 text-right tabular-nums">{b.livre12.lisible ? montant(b.livre12) : <span className="text-muted-foreground">—</span>}</td>
      <td className={cn("px-3 py-2 text-right tabular-nums", b.evol12 === null ? "text-muted-foreground" : b.evol12 >= 0 ? "text-success" : "text-destructive")}>{b.evol12 === null ? "—" : signe(b.evol12)}</td>
      <td className="px-3 py-2">
        {pct === null ? <span className="text-muted-foreground">—</span> : (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary" aria-hidden>
              <span className={cn("block h-full rounded-full", pct < 50 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span className="text-xs tabular-nums">{pct} %</span>
          </span>
        )}
      </td>
      <td className={cn("px-3 py-2 text-right tabular-nums", b.nonServi12 ? "font-medium text-warning" : b.nonServi12 === null ? "text-muted-foreground" : "")}>{b.nonServi12 === null ? "—" : formatNumber(b.nonServi12)}</td>
      <td className={cn("px-3 py-2 text-right tabular-nums", niveau === "rupture" ? "font-semibold text-destructive" : niveau === "vigilance" ? "font-medium text-warning" : niveau ? "" : "text-muted-foreground")}
        title={b.couverture ? b.couverture.label : undefined}>
        {b.couverture?.couverture == null ? "—" : `${b.couverture.couverture.toLocaleString("fr-FR")} mois`}
      </td>
    </tr>
  );
}

// ─────────────────────────── À traiter ───────────────────────────

const POINT: Record<ATraiter["ton"], string> = { ko: "bg-destructive", w: "bg-warning", i: "bg-primary" };

function ListeATraiter({ items }: { items: ATraiter[] }) {
  return (
    <section className="surface min-w-0 rounded-xl">
      <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">À traiter</h2>
        <InfoBulle label="À propos : À traiter">
          Calculé sur les données : risque de rupture de la chaîne, BC PCH en retard sur la date prévue, hôpital qui signale
          une rupture dans un rapport (ou non servi) alors que la PCH centrale a du stock, plans de tournée à valider, avenant
          à prévoir, fichiers ou relevés manquants, risques d&apos;Adventum Brain de votre périmètre. Les plus graves d&apos;abord.
        </InfoBulle>
      </header>
      {items.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">Rien à traiter.</p>
      ) : (
        <ul>
          {items.map((x) => (
            <li key={x.cle} className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-0">
              <i className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", POINT[x.ton])} aria-hidden />
              <div className="min-w-0 flex-1">
                <b className="block text-sm font-medium [overflow-wrap:anywhere]">{x.titre}</b>
                {x.detail && <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{x.detail}</small>}
              </div>
              <Link href={x.href} className="inline-flex h-7 shrink-0 items-center rounded-[var(--radius)] border border-border px-2.5 text-xs font-medium hover:bg-secondary">
                {x.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Puce({ href, actif, children }: { href: string; actif: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={actif ? "page" : undefined}
      className={cn("shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium", actif ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
      {children}
    </Link>
  );
}
