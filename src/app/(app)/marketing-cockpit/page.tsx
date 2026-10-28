import Link from "next/link";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { peutGererSpecialites, userCan } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { visibleTabs } from "@/lib/nav-tabs";
import { MARKETING_COCKPIT_TABS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { peutEcrireMessagesCockpit, peutVoirArgentCockpit, peutVoirMarcheCockpit } from "@/lib/marketing-cockpit/acces";
import {
  chargerBase, chargerBusCockpit, chargerDepenses, chargerEnveloppe, chargerLeaders, chargerMessages, choisirPerimetre,
  STATUTS_LEADERS, type BaseCockpit, type BuCockpit, type LigneMessage, type ProduitCockpit,
} from "@/lib/marketing-cockpit/donnees";
import { libelleMois, marcheDuProduit, type MarcheProduit } from "@/lib/marketing-cockpit/marche";
import { CHEMIN_BUDGET_MARKETING } from "@/lib/budget-marketing/domaine";
import { estCible, messagePeuPorte, passesEnA, pourcent, repartitionDepenses } from "@/lib/marketing-cockpit/calculs";
import { VISITES_ENGAGEMENT, conversions, decideursEngages } from "@/lib/marketing-cockpit/terrain";
import { chargerTerrain } from "@/lib/marketing-cockpit/terrain-donnees";
import { previsionsDesServices, totalExprime } from "@/lib/besoins-services/regles";
import { proposeLaSaisie } from "@/lib/besoins-services/service";
import { CarteVoixTerrain } from "@/components/shared/voix-terrain";
import { SelecteurProduit } from "./selecteur-produit";
import { MessagesManager } from "./messages-manager";
import { PrevisionsServices, type LignePrevisionEcran } from "./previsions-services";
import {
  CarteASurveiller, CarteEnveloppe, CarteLots, CarteOuVaLArgent, CarteSignaux, Carte, Courbes, Tuiles, Vide, VueLeaders,
  type SignalCockpit, type TuileCockpit,
} from "./vues";

export const dynamic = "force-dynamic";
export const metadata = { title: "Marketing cockpit — AMD Internal OS" };

const VUES = ["ensemble", "leaders", "messages", "marche", "investissements"] as const;
type Vue = (typeof VUES)[number];

/**
 * MARKETING COCKPIT — le tableau de la Direction Marketing (maquette validée, 07/10 — « Le principe » : une seule
 * chaîne, du médecin au résultat). Par produit (ou toute la BU) : est-ce que l'effort et l'argent vont sur les bonnes
 * cibles, et le marché bouge-t-il ? Rien ne se saisit ici, sauf les messages : tout se lit dans l'annuaire, la
 * segmentation, les visites, Ad & Pro, les budgets et les données marché.
 *
 * La porte est le module MARKETING_COCKPIT ; le marché et l'argent ont chacun leur règle (`marketing-cockpit/acces.ts`).
 */
export default async function MarketingCockpitPage({ searchParams }: { searchParams?: { vue?: string; produit?: string; bu?: string } }) {
  const user = await requireModule("MARKETING_COCKPIT");
  const maintenant = new Date();
  const voitMarche = peutVoirMarcheCockpit(user);
  const voitArgent = peutVoirArgentCockpit(user);

  const bus = await chargerBusCockpit();
  const choix = choisirPerimetre(bus, searchParams ?? {});
  if (!choix) {
    return (
      <div className="space-y-4">
        <PageHeader title="Marketing cockpit" />
        <p className="surface rounded-xl p-5 text-sm text-muted-foreground">Aucune Business Unit active.</p>
      </div>
    );
  }
  const { bu } = choix;
  const produit = choix.explicite ? choix.produit : await produitParDefaut(bu);

  const demandee = (VUES as readonly string[]).includes(searchParams?.vue ?? "") ? (searchParams!.vue as Vue) : "ensemble";
  const vue: Vue = (demandee === "marche" && !voitMarche) || (demandee === "investissements" && !voitArgent) ? "ensemble" : demandee;

  // La base du périmètre et les onglets visibles ne dépendent pas l'une de l'autre : un seul aller-retour
  // (audit performance PERF-11).
  const [base, ongletsVisibles] = await Promise.all([chargerBase(user, bu, produit, maintenant), visibleTabs(user, MARKETING_COCKPIT_TABS)]);
  const perimetre = produit ? `produit=${produit.id}` : `bu=${bu.id}`;
  const lien = (v: Vue) => `/marketing-cockpit?${v === "ensemble" ? "" : `vue=${v}&`}${perimetre}`;
  const nomPerimetre = produit?.nom ?? "Tous les produits";

  const onglets = ongletsVisibles.filter((t) => t.show !== false).map((t) => {
    const cle = (new URLSearchParams(t.href.split("?")[1] ?? "").get("vue") ?? "ensemble") as Vue;
    return { cle, label: t.label, href: lien(cle) };
  });

  const groupes = bus.map((b) => ({ bu: { id: b.id, nom: b.nom }, produits: b.produits.map((p) => ({ id: p.id, nom: p.nom })) }));

  return (
    <div className="space-y-4">
      <PageHeader title="Marketing cockpit" description={`${nomPerimetre} · BU ${bu.nom} · ${base.cycle.libelle}`}>
        <SelecteurProduit groupes={groupes} valeur={produit ? `p:${produit.id}` : `bu:${bu.id}`} vue={vue === "ensemble" ? null : vue} />
        <MenuDossier>
          {base.strategie && userCan(user, "SEGMENTATION", "VIEW") && <MenuLien href={`/segmentation?s=${base.strategie.id}`}>Segmentation de la BU</MenuLien>}
          <MenuLien href={`/business-units/${bu.id}`}>Cockpit de la BU</MenuLien>
          {peutGererSpecialites(user, "VIEW") && <MenuLien href="/annuaires/specialites">Spécialités (Annuaires)</MenuLien>}
          {voitMarche && <MenuLien href="/business-development/marche">Intelligence marché</MenuLien>}
        </MenuDossier>
      </PageHeader>

      <nav className="-mx-3 flex gap-1 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0" aria-label="Vues du cockpit">
        {onglets.map((o) => (
          <Link key={o.cle} href={o.href} aria-current={vue === o.cle ? "page" : undefined}
            className={cn("shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors sm:py-2", vue === o.cle ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {o.label}
          </Link>
        ))}
      </nav>

      {!base.strategie && vue !== "messages" && (
        <p className="surface rounded-xl px-4 py-3 text-sm text-muted-foreground">
          La segmentation de la BU {bu.nom} n&apos;est pas activée : lettres, fréquences et leaders apparaîtront avec elle
          {userCan(user, "SEGMENTATION", "VIEW") ? <> (<Link href={`/segmentation?bu=${bu.id}`} className="text-primary underline">Segmentation</Link>)</> : null}.
        </p>
      )}
      {base.strategie && produit && !base.produitClasse && vue !== "messages" && (
        <p className="text-xs text-muted-foreground">{produit.nom} n&apos;est pas classé dans la segmentation de la BU : les lettres affichées sont celles de son produit n° 1.</p>
      )}

      {vue === "ensemble" && <VueEnsemble base={base} bu={bu} produit={produit} lien={lien} voitMarche={voitMarche} voitArgent={voitArgent} user={user} maintenant={maintenant} />}
      {vue === "leaders" && <VueLeadersSection base={base} maintenant={maintenant} />}
      {vue === "messages" && <VueMessages base={base} bus={bus} bu={bu} produit={produit} user={user} maintenant={maintenant} />}
      {vue === "marche" && <VueMarche produit={produit} />}
      {vue === "investissements" && <VueInvestissements base={base} bu={bu} produit={produit} user={user} maintenant={maintenant} />}
    </div>
  );
}

function MenuLien({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} role="menuitem" className="rounded-md px-2.5 py-2 text-sm hover:bg-secondary">{children}</Link>;
}

/** Sans choix explicite : le produit n° 1 de la segmentation de la BU, sinon son premier produit promu. */
async function produitParDefaut(bu: BuCockpit): Promise<ProduitCockpit | null> {
  if (bu.strategieId) {
    const p1 = await prisma.segmentationStrategieProduit.findFirst({ where: { strategieId: bu.strategieId, jusqua: null }, orderBy: { rang: "asc" }, select: { productId: true } });
    const trouve = bu.produits.find((p) => p.productId === p1?.productId);
    if (trouve) return trouve;
  }
  return bu.produits[0] ?? null;
}

async function marcheDe(produit: ProduitCockpit | null): Promise<MarcheProduit | null> {
  if (!produit?.productId || !produit.dci) return null;
  const alias = await prisma.productAlias.findMany({ where: { productId: produit.productId }, select: { label: true } });
  try {
    return marcheDuProduit({ nom: produit.nom, dci: produit.dci, alias: alias.map((a) => a.label) });
  } catch {
    // Les jeux de données marché absents ou illisibles : pas de marché, plutôt qu'une page cassée.
    return null;
  }
}

// ───────────────────────────── Vue d'ensemble ─────────────────────────────

async function VueEnsemble({ base, bu, produit, lien, voitMarche, voitArgent, user, maintenant }: {
  base: BaseCockpit; bu: BuCockpit; produit: ProduitCockpit | null; lien: (v: Vue) => string;
  voitMarche: boolean; voitArgent: boolean; user: Parameters<typeof chargerEnveloppe>[0]; maintenant: Date;
}) {
  const [messages, depenses, marche, terrain] = await Promise.all([
    chargerMessages(base, bu, produit, maintenant),
    voitArgent ? chargerDepenses(base, bu, produit, maintenant) : Promise.resolve(null),
    voitMarche ? marcheDe(produit) : Promise.resolve(null),
    chargerTerrain(base, bu, produit, user.id, maintenant),
  ]);
  const repartition = depenses ? repartitionDepenses(depenses, base.praticiens.filter((p) => estCible(p.lettre)).length) : null;
  const { annee } = terrain;
  const nb = (n: number) => n.toLocaleString("fr-FR").replace(/ /g, " ");

  // CE QUI DÉPEND VRAIMENT DU TERRAIN (maquette validée, 10/2026) — en marché d'AO, la part de réceptions PCH ne mesure
  // pas l'effort : on lit ce que les services DEMANDENT et ce que les médecins PRESCRIVENT.
  const besoins = terrain.besoins;
  const exprime = totalExprime(besoins, annee);
  const engages = decideursEngages(base.praticiens);
  const conv = base.precedent ? conversions(base.precedent.segments, base.segmentDe) : null;
  const aff = terrain.affinite;
  const affDerniere = aff ? [...aff.serie].reverse().find((s) => s.moyenne !== null) ?? null : null;
  const lots = terrain.lots;
  const objections = terrain.voix.groupes.find((g) => g.categorie === "OBJECTION")?.rapports ?? 0;

  const tuiles: TuileCockpit[] = [
    {
      label: "Besoins annuels exprimés",
      valeur: exprime ? nb(exprime.total) : "—",
      note: exprime ? `boîtes en ${annee} · ${exprime.services} service${exprime.services > 1 ? "s" : ""}` : `aucun besoin saisi pour ${annee}`,
      ton: "muet",
      info: <>Le besoin annuel que les décideurs annoncent pour leur service, en boîtes de {produit?.nom ?? "la BU"} — c&apos;est ce qui fixe le volume de l&apos;appel d&apos;offres. Saisi par le KAM à la visite du décideur.</>,
    },
    {
      label: "Décideurs engagés",
      valeur: base.strategie && engages.total ? `${engages.engages} / ${engages.total}` : "—",
      note: !base.strategie ? "segmentation à activer" : engages.total ? `vus ≥ ${VISITES_ENGAGEMENT} fois · ${base.cycle.libelle}` : "aucun décideur (H) dans le panel",
      ton: "muet",
      info: <>Praticiens classés H (décideurs) avec au moins {VISITES_ENGAGEMENT} visites terminées pendant {base.cycle.libelle}, sur tous les H du panel.</>,
    },
    {
      label: "Affinité moyenne (Q2/Q1)",
      valeur: affDerniere ? pourcent(affDerniere.moyenne, 1) : "—",
      note: !base.strategie ? "segmentation à activer" : !affDerniere ? "aucune réponse Q1 / Q2" : aff?.ecartPts == null ? `${affDerniere.mesures} praticien${affDerniere.mesures > 1 ? "s" : ""} mesuré${affDerniere.mesures > 1 ? "s" : ""}` : `${aff.ecartPts >= 0 ? "+" : "−"}${Math.abs(aff.ecartPts).toFixed(1).replace(".", ",")} pt en ${aff.serie.length} cycles`,
      ton: aff?.ecartPts == null || aff.ecartPts === 0 ? "muet" : aff.ecartPts > 0 ? "ok" : "ko",
      info: aff ? <>Moyenne des affinités déclarées du panel ({aff.methode === "RATIO_FICHIER" ? "Q2 ÷ Q1" : "Q2 ÷ 10"}, méthode de la règle), à la fin de chaque cycle : {aff.serie.map((s) => `${s.libelle} ${pourcent(s.moyenne, 1)}`).join(" · ")}.</> : undefined,
    },
    {
      label: "Conversions B → A",
      valeur: conv ? String(conv.bVersA) : "—",
      note: conv ? `ce cycle · ${conv.aVersB} retour${conv.aVersB > 1 ? "s" : ""} A → B` : "pas de cycle figé avant",
      ton: conv && conv.bVersA > conv.aVersB ? "ok" : conv && conv.aVersB > conv.bVersA ? "ko" : "muet",
      info: base.precedent ? <>Segment du produit depuis le cycle figé « {base.precedent.libelle} » : B devenus A, et A redevenus B (dérogations comprises).</> : undefined,
    },
    {
      label: "Hôpitaux qui reçoivent nos lots",
      valeur: lots?.nosLotsConnus && lots.consommateurs ? String(lots.avecNosLots.length) : "—",
      note: !lots || lots.consommateurs === 0 ? "aucune distribution DR (12 mois)" : !lots.nosLotsConnus ? "aucun n° de lot sur nos BL" : `sur ${lots.consommateurs} qui consomment la DCI`,
      ton: "muet",
      info: <>Nos n° de lot (BL de nos livraisons PCH) retrouvés dans la distribution des directions régionales aux hôpitaux, 12 mois.</>,
    },
    {
      label: "Objections relevées",
      valeur: terrain.voix.rapports ? String(objections) : "—",
      note: !terrain.voix.rapports ? "aucun rapport (30 j)" : terrain.voix.objectionsPrixAo ? `dont ${terrain.voix.objectionsPrixAo} « prix / AO » · 30 j` : "30 derniers jours",
      ton: "muet",
      info: <>Comptes rendus de visite de la BU des 30 derniers jours rangés en objections ({terrain.voix.parLuna ? "Luna" : "mots-clés"}).</>,
    },
  ];

  // LES PRÉVISIONS DES SERVICES — la table, et ce qu'il faut pour saisir.
  const cleDe = (b: { institutionId: string; serviceId: string | null }) => `${b.institutionId}|${b.serviceId ?? "-"}`;
  const previsions: LignePrevisionEcran[] = previsionsDesServices(besoins, annee).map((p) => {
    const duLieu = besoins.filter((b) => cleDe(b) === p.cle);
    const unique = produit?.productId ? duLieu.find((b) => b.annee === annee && b.productId === produit.productId) : undefined;
    return {
      cle: p.cle, lieu: [duLieu[0]?.service, duLieu[0]?.etablissement].filter(Boolean).join(" · ") || "Établissement",
      decideur: [...new Set(duLieu.map((b) => b.decideur).filter((x): x is string => !!x))].join(", ") || null,
      actuel: p.actuel, precedent: p.precedent, evolution: p.evolution,
      ligne: unique ? { id: unique.id, quantite: unique.quantite, note: unique.note } : null,
    };
  });
  const decideursPanel = base.panel
    .filter((l) => l.statut === "DECIDEUR" && l.institutionId)
    .map((l) => ({ id: l.doctorId, libelle: [l.nom, l.etablissement].filter(Boolean).join(" · ") }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
  const leaders = base.panel.filter((l) => l.statut && STATUTS_LEADERS.includes(l.statut));
  const oublies = leaders.filter((l) => !(base.visites.get(l.doctorId)?.six));

  // CE QUI BOUGE — des signaux calculés, chacun avec la page qui le montre.
  const signaux: SignalCockpit[] = [];
  if (base.precedent) {
    const n = passesEnA(base.precedent.segments, base.segmentDe);
    if (n > 0) signaux.push({ ton: "ok", titre: `${n} médecin${n > 1 ? "s" : ""} passé${n > 1 ? "s" : ""} en A`, detail: `depuis « ${base.precedent.libelle} »`, href: base.strategie ? `/segmentation?s=${base.strategie.id}&vue=praticiens` : lien("leaders") });
  }
  const amm = marche?.nouvellesAmm[0];
  if (voitMarche && amm) {
    signaux.push({ ton: "ko", titre: `Concurrent : AMM ${amm.marque}`, detail: `${amm.labo} · Nomenclature, ${amm.le.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`, href: lien("marche") });
  }
  if (repartition?.partCDCongresEvenements) {
    signaux.push({ ton: "w", titre: `${pourcent(repartition.partCDCongresEvenements)} du budget congrès et événements sur des C et D`, detail: "dépenses nominatives, 12 mois", href: lien("investissements") });
  }
  const faible = messagePeuPorte(messages.map((m) => ({ ...m, actif: m.isActive })), base.delegues);
  if (faible) {
    signaux.push({ ton: "i", titre: `Message « ${faible.title} » peu porté`, detail: `${faible.stats.portesCycle} fois ce cycle, ${faible.stats.delegues} délégué${faible.stats.delegues > 1 ? "s" : ""} sur ${base.delegues}`, href: lien("messages") });
  }
  if (oublies.length) {
    signaux.push({ ton: "w", titre: `${oublies.length} leader${oublies.length > 1 ? "s" : ""} d'opinion sans visite depuis 6 mois`, detail: "décideurs, influenceurs, référents", href: lien("leaders") });
  }

  return (
    <div className="space-y-4">
      <Tuiles tuiles={tuiles} className="md:grid-cols-3 xl:grid-cols-6" />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <PrevisionsServices
          lignes={previsions}
          annee={annee}
          produit={produit?.productId ? { productId: produit.productId, nom: produit.nom } : null}
          decideurs={decideursPanel}
          peutSaisir={proposeLaSaisie(user)}
        />
        <CarteLots lots={lots} molecule={lots?.molecule ?? null} />
        <CarteVoixTerrain titre="La voix du terrain" voix={terrain.voix} max={4} />
      </div>
      {signaux.length > 0 && <CarteSignaux signaux={signaux.slice(0, 5)} />}
    </div>
  );
}

// ───────────────────────────── Leaders ─────────────────────────────

async function VueLeadersSection({ base, maintenant }: { base: BaseCockpit; maintenant: Date }) {
  const leaders = await chargerLeaders(base, maintenant);
  return <VueLeaders leaders={leaders} maintenant={maintenant} lienFiche={(l) => (l.specialiteId ? `/annuaires/medecins?specialite=${l.specialiteId}` : "/annuaires/medecins")} />;
}

// ───────────────────────────── Messages ─────────────────────────────

async function VueMessages({ base, bus, bu, produit, user, maintenant }: {
  base: BaseCockpit; bus: BuCockpit[]; bu: BuCockpit; produit: ProduitCockpit | null; user: Parameters<typeof chargerEnveloppe>[0]; maintenant: Date;
}) {
  const [messages, settings] = await Promise.all([chargerMessages(base, bu, produit, maintenant), getAppSettings()]);
  const roles = settings.promoMessageAuthorRoles;
  const produits = new Map<string, string>();
  for (const b of bus) for (const p of b.produits) if (p.productId && !produits.has(p.productId)) produits.set(p.productId, p.nom);
  return (
    <MessagesManager
      titre={`Messages · ${produit?.nom ?? `BU ${bu.nom}`}`}
      messages={messages.map((m: LigneMessage) => ({
        id: m.id, title: m.title, body: m.body, businessUnitId: m.businessUnitId, productId: m.productId, portee: m.portee,
        isActive: m.isActive, sortOrder: m.sortOrder, usages: m.usages,
        portesCycle: m.stats.portesCycle, parLettre: m.stats.parLettre, delegues: m.stats.delegues, tendance: m.stats.tendance,
      }))}
      deleguesBu={base.delegues}
      droits={{
        creer: peutEcrireMessagesCockpit(user, roles, "CREATE"),
        modifier: peutEcrireMessagesCockpit(user, roles, "UPDATE"),
        retirer: peutEcrireMessagesCockpit(user, roles, "DELETE"),
      }}
      bus={bus.map((b) => ({ id: b.id, name: b.nom }))}
      produits={[...produits].map(([id, nom]) => ({ id, nom })).sort((a, b) => a.nom.localeCompare(b.nom, "fr"))}
      defauts={{ businessUnitId: bu.id, productId: produit?.productId ?? null }}
      cycle={base.cycle.libelle}
    />
  );
}

// ───────────────────────────── Marché ─────────────────────────────

async function VueMarche({ produit }: { produit: ProduitCockpit | null }) {
  if (!produit) return <Carte titre="Marché"><Vide>Choisissez un produit pour lire son marché.</Vide></Carte>;
  const m = await marcheDe(produit);
  if (!m) return <Carte titre="Marché"><Vide>{produit.nom} n&apos;est pas reconnu dans les données marché (IQVIA, PCH, Nomenclature).</Vide></Carte>;
  const part = m.part;
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Carte
        titre="Part de marché sur 12 mois"
        sousTitre={`${m.molecule.toLowerCase()} · réceptions hôpital (PCH)`}
        info={<>IQVIA ne donne qu&apos;un cumul annuel : la série mensuelle est celle des réceptions hospitalières PCH, part de chaque laboratoire dans la molécule. La part en ville est celle de nos marques dans leur classe IQVIA.</>}
      >
        {part && (
          <p className="border-b border-border px-4 py-2 text-sm">
            <span className="text-muted-foreground">Ville (IQVIA){m.classe ? ` · ${m.classe.toLowerCase()}` : ""} : </span>
            <b className="tabular-nums">{pourcent(part.actuelle, 1)}</b>
            {part.precedente !== null && <span className="text-muted-foreground"> · il y a un an {pourcent(part.precedente, 1)}</span>}
          </p>
        )}
        {m.serie ? (
          <div className="px-2 py-3"><Courbes mois={m.serie.mois} lignes={m.serie.lignes} libelleMois={libelleMois} /></div>
        ) : <Vide>Aucune réception hospitalière de {m.molecule.toLowerCase()} dans les données PCH.</Vide>}
        {m.serie && !m.serie.lignes.some((l) => l.nous) && (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Nos marques n&apos;apparaissent pas dans les réceptions PCH de la molécule.</p>
        )}
      </Carte>
      <CarteASurveiller signaux={m.aSurveiller} />
    </div>
  );
}

// ───────────────────────────── Investissements ─────────────────────────────

async function VueInvestissements({ base, bu, produit, user, maintenant }: {
  base: BaseCockpit; bu: BuCockpit; produit: ProduitCockpit | null; user: Parameters<typeof chargerEnveloppe>[0]; maintenant: Date;
}) {
  const [depenses, enveloppe] = await Promise.all([chargerDepenses(base, bu, produit, maintenant), chargerEnveloppe(user, maintenant)]);
  const cibles = base.praticiens.filter((p) => estCible(p.lettre)).length;
  const r = repartitionDepenses(depenses, cibles);
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <CarteOuVaLArgent lignes={r.lignes} total={r.total} />
      <CarteEnveloppe e={enveloppe} lien={userCan(user, "BUDGET_MARKETING", "VIEW") ? CHEMIN_BUDGET_MARKETING : null} />
    </div>
  );
}
